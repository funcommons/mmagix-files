/**
 * M1 命令接线——把 tree-store / upload-queue / S3Client 接成 handlers 的 overrides
 * 契约：《docs/design/jsdk-api.md》V1.0 §五/§六/§七（命令语义、事件、错误码）
 *
 * Lane F4 命令语义补齐：uploadProgress 200ms 节流（§六）、全批拒收补发 uploadFailed
 * （§五「error.code=4302/4304」）、rejected 逐项补 code、缺省拉起文件选择器（§五）。
 *
 * 事件流分工：fileChanged 由 tree 的 onFileChanged 回调统一发出（构造处接 bus），
 * 本文件不重复发；本文件只负责 upload/download 的进度与终态事件。
 * 未接管命令（openFile/closeTab/select/getTabs 实做）留 M2（tab 系统属 UI 层）。
 */
import { ERROR_CODES, SdkError } from '@/sdk/errorCodes'
import { requireFeature } from '@/sdk/features'
import { triggerDownload } from '@/utils/download'
import { memPut, notifyMemFileAdded } from './mem-store'
import type { CommandHandler } from '@/sdk/handlers'
import type { CommandName, EventName, S3Client, UploadFilesReply, UploadRejected } from '@/sdk/types'
import type { FileTreeController, FileTreeWithTrash } from './tree-store'
import { normalizePrefix } from './tree-store'
import type { EnqueueResult, UploadQueue, UploadHooks } from './upload-queue'

/** JSSDK 相对路径 → bucket 全键（rootPrefix 规范化带尾 '/'） */
export function joinKey(rootPrefix: string, rel: string): string {
  const root = normalizePrefix(rootPrefix)
  return root + rel.replace(/^\/+/, '')
}

/** 全键拆分：'a/b/c' → { parent: 'a/b/', name: 'c' } */
function splitPath(full: string): { parent: string; name: string } {
  const i = full.replace(/\/$/, '').lastIndexOf('/')
  if (i < 0) return { parent: '', name: full.replace(/\/$/, '') }
  return { parent: full.slice(0, i + 1), name: full.slice(i + 1) }
}

/**
 * FileTreeWithTrash 面收窄（M3 评审 P2-3 DI 放宽的运行时半边）：trash 四方法挂在 FileTreeWithTrash，
 * 而 FileTreeController 消费面（既有测试桩、Toolbar/TreePanel 的 controller prop）保持窄面不破坏——
 * 依赖位收两面并集，restore/purge 入口经此收窄。生产链 createFileTree 恒返回全量面；缺面=装配降级，
 * 4305 明确报错（同 tree-store 的可选能力守卫手法，而非 "undefined is not a function"）。
 */
export function trashFace(tree: FileTreeController | FileTreeWithTrash): FileTreeWithTrash {
  if (!('listTrash' in tree) || !('restoreTrash' in tree) || !('purgeTrash' in tree)) {
    throw new SdkError(ERROR_CODES.UNSUPPORTED_MODE, '当前 tree 不支持回收站操作（restore/purge 需 FileTreeWithTrash 面）')
  }
  return tree
}

let downloadSeq = 0
function nextId(): string {
  downloadSeq += 1
  return `dl-${Date.now().toString(36)}-${downloadSeq}`
}

export interface M1OverridesDeps {
  /** P2-3 放宽：两面并集——既有 FileTreeController 窄面装配（测试桩/外部传入）不受影响，
   *  trash 命令（restore/purge）入口经 trashFace 收窄为 FileTreeWithTrash */
  tree: FileTreeController | FileTreeWithTrash
  queue: UploadQueue
  client: S3Client
  /** JSSDK 相对路径的树根（=config.backend.prefix） */
  rootPrefix: string
  features: Record<string, boolean>
  /** 事件出口（bus.emit） */
  emit(evt: EventName, payload: unknown): void
}

/**
 * M3 回收站命令名：restore/purge 尚未收录进 CommandName（sdk/types.ts 主线持有、子 agent 只读）——
 * 本地扩名注册；主线收录后 TrashCommandName 整体退化为 CommandName 即可（仅类型面改动）。
 */
type TrashCommandName = CommandName | 'restore' | 'purge'

/** M1 实做命令：navigate/createFolder/rename/remove/uploadFiles/download + M3 restore/purge */
export function createM1Overrides(deps: M1OverridesDeps): Partial<Record<TrashCommandName, CommandHandler>> {
  const { tree, queue, client, rootPrefix, features, emit } = deps

  /**
   * enqueue 回包 → reply（直传 files 与选择器两条路径共用）：
   * ① rejected 逐项补 code（契约 §五：ext=4304 EXT_DENIED / size=4302 LIMIT_EXCEEDED）；
   * ② 全批拒收（accepted 空且 rejected 非空）除 reply 外补发 uploadFailed 事件——契约 §五
   *   「全批异常仍走 uploadFailed，error.code=4302/4304」。payload 字段按接口文档原文对齐：
   *   §六 uploadFailed 形状={ id, key?, error? }，故 code 放 error.code（文档无顶层 code 字段）；
   *   批级失败文件未入队、无队列任务 id，省略 id（塞 id:'' 反而诱导宿主按 id 关联不存在的任务）；
   *   files 为 additive 字段（§六 未定义批级字段名，任务书原文即 files）——列全部被拒文件名，
   *   便于宿主提示；混批全拒时 error.code 取首项原因，逐项原因仍看 reply.rejected[i].code。
   */
  const finishEnqueue = (result: EnqueueResult): UploadFilesReply => {
    const rejected: UploadRejected[] = result.rejected.map((r) => ({
      ...r,
      code: r.reason === 'ext' ? ERROR_CODES.EXT_DENIED : ERROR_CODES.LIMIT_EXCEEDED,
    }))
    if (result.accepted.length === 0 && rejected.length > 0) {
      const first = rejected[0]
      if (first) {
        const code = first.reason === 'ext' ? ERROR_CODES.EXT_DENIED : ERROR_CODES.LIMIT_EXCEEDED
        emit('uploadFailed', {
          error: {
            code,
            message:
              first.reason === 'ext'
                ? `全部 ${rejected.length} 个文件命中扩展名黑名单（EXT_DENIED）`
                : `全部 ${rejected.length} 个文件超过 uploadMaxBytes 上限（LIMIT_EXCEEDED）`,
          },
          files: rejected.map((r) => r.name),
        })
      }
    }
    return { accepted: result.accepted, rejected }
  }

  /**
   * M3 restore/purge 共用骨架：feature 门控（缺省放行、显式 false=4301，与 mkdir/rename/delete 同构）→
   * paths 校验（同 remove：字符串数组；空批零调用直回 {}）→ tree.listTrash({}) 全量取 entries 按 key
   * 过滤（JSSDK 相对路径经 joinKey 对齐 TrashEntry.key=bucket 全键；不在回收站的路径静默落空——
   * 过滤后为空时批方法对空数组零调用）→ 批方法。TrashBatchError（SdkError 子类）原样冒泡不吞——
   * 错误回报沿用 wrapCommand 现有管道（按 err.code 回 reply）。
   */
  const trashBatch = (feature: 'restore' | 'purge', method: 'restoreTrash' | 'purgeTrash'): CommandHandler =>
    (payload) => {
      requireFeature(features, feature)
      const paths = (payload as { paths?: unknown })?.paths
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
        throw new SdkError(ERROR_CODES.BAD_PARAM, `${feature}.paths 必须是字符串数组`)
      }
      if (paths.length === 0) return {}
      const want = new Set(paths.map((p) => joinKey(rootPrefix, p as string)))
      const face = trashFace(tree)
      // 门控/校验同步抛（与 remove 同构）；批调用走 async 链——face[method] 联合返回经 await 收敛，
      // 绕开 .then 对 Promise 联合返回的推断坍缩
      const run = async (): Promise<Record<string, never>> => {
        const entries = await face.listTrash({})
        await face[method](entries.filter((e) => want.has(e.key)))
        return {}
      }
      return run()
    }

  return {
    navigate: (payload) => {
      const rel = (payload as { path?: string })?.path
      if (typeof rel !== 'string') throw new SdkError(ERROR_CODES.BAD_PARAM, 'navigate.path 必须是字符串')
      const full = normalizePrefix(joinKey(rootPrefix, rel))
      return tree.loadDir(full, { force: true }).then(() => {
        emit('pathChanged', { path: full })
        return { path: full }
      })
    },

    createFolder: (payload) => {
      requireFeature(features, 'mkdir')
      const rel = (payload as { path?: string })?.path
      if (typeof rel !== 'string' || !rel.trim()) throw new SdkError(ERROR_CODES.BAD_PARAM, 'createFolder.path 必须是非空字符串')
      const full = joinKey(rootPrefix, rel)
      const { parent, name } = splitPath(full)
      return tree.mkdir(parent, name).then((key) => ({ key }))
    },

    rename: (payload) => {
      requireFeature(features, 'rename')
      const { from, to } = (payload ?? {}) as { from?: string; to?: string }
      if (typeof from !== 'string' || typeof to !== 'string') {
        throw new SdkError(ERROR_CODES.BAD_PARAM, 'rename.from/to 必须是字符串')
      }
      return tree.rename(joinKey(rootPrefix, from), joinKey(rootPrefix, to)).then(() => ({}))
    },

    remove: (payload) => {
      requireFeature(features, 'delete')
      const paths = (payload as { paths?: unknown })?.paths
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
        throw new SdkError(ERROR_CODES.BAD_PARAM, 'remove.paths 必须是字符串数组')
      }
      if (paths.length === 0) return {}
      return tree.remove(paths.map((p) => joinKey(rootPrefix, p as string))).then(() => ({}))
    },

    restore: trashBatch('restore', 'restoreTrash'),

    purge: trashBatch('purge', 'purgeTrash'),

    uploadFiles: (payload) => {
      requireFeature(features, 'upload')
      const p = (payload ?? {}) as { files?: unknown; target?: unknown; appId?: unknown; appOptions?: unknown }
      // target='memory'（内存中处理）：文件入 MemFileStore（不落 S3，凭证零改动）→ 回 accepted
      // entries（mem:// 键）→ 经 opener hook 触发 UI 打开预览（mem:// 由 DataSource 分支供数，
      // 渲染器/插件零改动）。files 缺省同样拉起选择器（picked 全量入内存）。
      if (p.target === 'memory') {
        // appId/appOptions 透传 opener（内存文件独立区：指定应用+打开参数）；非法类型=4005
        const openHint = {
          appId: typeof p.appId === 'string' && p.appId !== '' ? p.appId : undefined,
          appOptions: p.appOptions && typeof p.appOptions === 'object' && !Array.isArray(p.appOptions)
            ? (p.appOptions as Record<string, unknown>)
            : undefined,
        }
        const runMemory = (list: File[]) => {
          const accepted = list.map((f) => {
            const entry = memPut(f)
            notifyMemFileAdded(entry, openHint)
            return { key: entry.key, name: entry.name, size: entry.size }
          })
          return { accepted, rejected: [], memory: true }
        }
        if (p.files === undefined || p.files === null) {
          openFilePicker((picked) => {
            if (!picked || picked.length === 0) return
            runMemory(Array.from(picked))
          })
          return { accepted: [], rejected: [], memory: true }
        }
        if (!Array.isArray(p.files)) throw new SdkError(ERROR_CODES.BAD_PARAM, 'uploadFiles.files 必须是 File 数组')
        return runMemory(p.files as File[])
      }
      const files = p.files
      // 契约 §五「缺省=拉起文件选择器」：无 files 字段（undefined/null）→ 动态建 <input type=file>
      // 并 click()。注意：postMessage 命令上下文没有用户手势（user activation），部分浏览器可能
      // 静默拒绝弹窗——平台限制，此处尽力兑现（best-effort）。
      if (files === undefined || files === null) {
        openFilePicker((picked) => {
          if (!picked || picked.length === 0) return // 用户取消/空选：契约未定义事件，静默收场
          // 选择结果入队到当前目录，走既有 hooks 事件（uploadProgress/Done/Failed），
          // 全批拒收同样经 finishEnqueue 补发 uploadFailed。
          finishEnqueue(queue.enqueue(Array.from(picked), tree.currentPath))
        })
        return { accepted: [], rejected: [] } // reply 先回空批；选择是异步的，结果全走事件
      }
      if (!Array.isArray(files)) throw new SdkError(ERROR_CODES.BAD_PARAM, 'uploadFiles.files 必须是 File 数组')
      return finishEnqueue(queue.enqueue(files as File[]))
    },

    download: (payload) => {
      requireFeature(features, 'download')
      const paths = (payload as { paths?: unknown })?.paths
      if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string')) {
        throw new SdkError(ERROR_CODES.BAD_PARAM, 'download.paths 必须是非空字符串数组')
      }
      const id = nextId()
      const rels = paths as string[]
      // 顺序取流→浏览器下载；单文件失败不中断其余（复审新发现①：原实现首败 break 与本注释矛盾），
      // 继续尝试剩余文件，终态以首个失败汇总发 downloadFailed，全成才发 downloadDone
      void (async () => {
        let failed: { code: number; message: string } | undefined
        for (const rel of rels) {
          const full = joinKey(rootPrefix, rel)
          try {
            const res = await client.get(full)
            const blob = await res.blob()
            triggerDownload(URL.createObjectURL(blob), splitPath(full).name || full)
          } catch (err) {
            failed ??= {
              code: err instanceof SdkError ? err.code : ERROR_CODES.S3_ERROR,
              message: err instanceof Error ? err.message : String(err),
            }
          }
        }
        if (failed) emit('downloadFailed', { id, error: failed })
        else emit('downloadDone', { id })
      })()
      return { id }
    },
  }
}

/** 进度节流窗口：契约 §六「uploadProgress（节流 ~200ms）」 */
export const UPLOAD_PROGRESS_THROTTLE_MS = 200

/**
 * 单上传项进度节流器（纯数据结构，fake timers 可测）。
 * 语义（契约 §六）：每项首个进度立即发；同窗口（默认 200ms）内后续进度只合并记最新值；
 * 距上次发射 ≥windowMs 的进度视为新窗口立即发；终态经 flush 强制冲刷未发最新值——
 * 宿主最终总能看到每项的最新进度。无定时器，纯墙钟判定（Date.now）。
 */
export interface UploadProgressThrottle {
  push(id: string, loaded: number, total: number): void
  /** 终态冲刷：该项有未发最新值则发出（并清理状态）；无则不动（终值已实时发出，不重复） */
  flush(id: string): void
}

export function createUploadProgressThrottle(
  emit: (evt: EventName, payload: unknown) => void,
  windowMs: number = UPLOAD_PROGRESS_THROTTLE_MS,
): UploadProgressThrottle {
  const lastSentAt = new Map<string, number>()
  const pending = new Map<string, { loaded: number; total: number }>()
  return {
    push(id, loaded, total) {
      const sentAt = lastSentAt.get(id)
      if (sentAt === undefined || Date.now() - sentAt >= windowMs) {
        lastSentAt.set(id, Date.now())
        pending.delete(id) // 新窗口直接发本次值，窗口内积压的更旧值作废（最新值优先）
        emit('uploadProgress', { id, loaded, total })
        return
      }
      pending.set(id, { loaded, total }) // 窗口内：只记最新，等终态冲刷
    },
    flush(id) {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      lastSentAt.delete(id) // 该项已终态，清理避免 map 无界增长
      emit('uploadProgress', { id, loaded: p.loaded, total: p.total })
    },
  }
}

/**
 * 缺省拉起系统文件选择器（契约 §五「缺省=拉起文件选择器」）：
 * 动态建 <input type=file multiple> → click()，change/cancel 后自清理。
 * 平台限制注记：postMessage 命令上下文无用户手势（user activation），部分浏览器可能静默
 * 拒绝弹窗（无报错、无文件）——best-effort 兑现；取消契约未定义事件，静默收场。
 */
function openFilePicker(onPicked: (files: FileList | null) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.style.display = 'none'
  input.addEventListener('change', () => {
    input.remove()
    onPicked(input.files)
  })
  input.addEventListener('cancel', () => input.remove()) // 现代浏览器取消会派发 cancel
  document.body.appendChild(input) // 部分浏览器要求 input 在文档内 click() 才弹窗
  input.click()
}

/**
 * UploadQueue hooks 工厂 → JSSDK 上传事件。
 * 用法：new UploadQueue({ client, params, hooks: createUploadHooks(emit) })（hooks 为构造期只读）。
 * 进度经 200ms 节流出口（契约 §六「节流 ~200ms」）；done/failed 前强制冲刷未发最新进度，
 * 宿主先见最新进度再见终态。
 * 取消语义：契约未定义用户取消终态事件——取消产生的失败经 onFailed 透传，code≥4900 供宿主识别为取消。
 */
export function createUploadHooks(
  emit: (evt: EventName, payload: unknown) => void,
): UploadHooks {
  const progress = createUploadProgressThrottle(emit)
  return {
    onProgress: (id, loaded, total) => progress.push(id, loaded, total),
    onDone: (id, key) => {
      progress.flush(id)
      emit('uploadDone', { id, key })
    },
    onFailed: (id, err) => {
      progress.flush(id)
      emit('uploadFailed', {
        id,
        error: {
          code: err && typeof err === 'object' && 'code' in err ? (err as { code: number }).code : ERROR_CODES.S3_ERROR,
          message: err instanceof Error ? err.message : 'upload failed',
        },
      })
    },
  }
}
