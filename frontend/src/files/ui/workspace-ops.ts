/**
 * workspace-ops — 工作台操作链共享层（Lane F5）。
 * Toolbar 按钮与 TreePanel 右键菜单共用的 mkdir/rename/remove/upload 拒收链在此收口（勿两处复制）；
 * M3 增回收站两入口：restoreEntries（无确认）/ purgeEntries（确认框，文案 files.trash.purge-*）。
 * 交互契约沿用原 Toolbar 实现：ElMessageBox.prompt/confirm + FcToast；cancel/close 字符串 reject 静默；
 * 删除多选（>1）确认用 files.msg.delete-multi-confirm({n})，单选沿用 files.msg.delete-confirm({name})。
 */
import { ElMessageBox } from 'element-plus'
import { toast } from '@/components/sdk'
import { trashFace } from '../commands'
import type { S3ObjectSummary } from '@/sdk/types'
import type { EnqueueResult } from '../upload-queue'
import type { FileTreeController, FileTreeWithTrash, TrashEntry } from '../tree-store'

type Translate = (key: string, params?: Record<string, unknown>) => string

export interface WorkspaceOpsDeps {
  /** P2-3 放宽：两面并集——Toolbar/TreePanel 的 FileTreeController 窄面 prop 照常装配；
   *  回收站入口（restoreEntries/purgeEntries）经 trashFace 收窄（缺面=4305 明确报错，
   *  生产链 createFileTree 恒返回 FileTreeWithTrash 全量面） */
  tree: FileTreeController | FileTreeWithTrash
  t: Translate
}

export interface RenameResult {
  from: string
  to: string
}

export interface WorkspaceOps {
  /** 新建目录（当前目录下）；取消/失败返回 null，成功返回新目录 key */
  createDir(): Promise<string | null>
  /** 重命名；取消/失败返回 null，成功返回 {from,to} */
  renameEntry(entry: S3ObjectSummary): Promise<RenameResult | null>
  /** 删除（支持多选）；取消/失败返回 null，成功返回调用方 keys */
  removeEntries(entries: S3ObjectSummary[]): Promise<string[] | null>
  /** 回收站恢复（可逆操作，无确认直接执行）；成功返回调用方 keys，失败/空批返回 null */
  restoreEntries(entries: TrashEntry[]): Promise<string[] | null>
  /** 回收站彻底删除（不可逆：确认框钉「不可恢复」语义）；取消零调用，成功返回 keys，失败返回 null */
  purgeEntries(entries: TrashEntry[]): Promise<string[] | null>
  /** 文件入队 + 拒收汇总 toast（enqueue 可为 Home 的带任务登记包装） */
  ingestFiles(enqueue: (files: File[], prefix?: string) => EnqueueResult, files: File[], prefix: string): void
}

export function createWorkspaceOps(deps: WorkspaceOpsDeps): WorkspaceOps {
  const { tree, t } = deps
  const fail = (e: unknown): void => {
    if (isCancel(e)) return
    toast.error(e instanceof Error && e.message ? e.message : t('files.msg.op-failed'))
  }
  const PROMPT_OPTS = {
    confirmButtonText: t('common.confirm'),
    cancelButtonText: t('common.cancel'),
  }

  async function createDir(): Promise<string | null> {
    try {
      const { value } = await ElMessageBox.prompt(t('files.prompt.mkdir-hint'), t('files.prompt.mkdir-title'), {
        ...PROMPT_OPTS,
        inputPattern: /\S/,
        inputErrorMessage: t('files.prompt.name-required'),
      })
      return await tree.mkdir(tree.currentPath, value.trim())
    } catch (e) {
      fail(e)
      return null
    }
  }

  /** 选中项同目录下的目标 key；目录保尾 '/'（tree.rename 契约：目录目标必须以 / 结尾） */
  function renameTarget(entry: S3ObjectSummary, name: string): string {
    const trimmed = entry.key.replace(/\/$/, '')
    const i = trimmed.lastIndexOf('/')
    const parent = i < 0 ? '' : trimmed.slice(0, i + 1)
    return entry.isDir ? `${parent}${name}/` : `${parent}${name}`
  }

  async function renameEntry(entry: S3ObjectSummary): Promise<RenameResult | null> {
    try {
      const { value } = await ElMessageBox.prompt(t('files.prompt.rename-hint'), t('files.prompt.rename-title'), {
        ...PROMPT_OPTS,
        inputValue: entry.name,
        inputPattern: /^[^/]+$/,
        inputErrorMessage: t('files.prompt.name-invalid'),
      })
      const name = value.trim()
      if (name === '') {
        toast.warning(t('files.prompt.name-required'))
        return null
      }
      const to = renameTarget(entry, name)
      await tree.rename(entry.key, to)
      return { from: entry.key, to }
    } catch (e) {
      fail(e)
      return null
    }
  }

  async function removeEntries(entries: S3ObjectSummary[]): Promise<string[] | null> {
    const keys = entries.map((e) => e.key)
    if (keys.length === 0) return null
    try {
      await toast.confirm({
        title: t('files.msg.delete-title'),
        message:
          keys.length === 1
            ? t('files.msg.delete-confirm', { name: entries[0]!.name })
            : t('files.msg.delete-multi-confirm', { n: keys.length }),
        type: 'warning',
      })
    } catch {
      return null // 取消
    }
    try {
      await tree.remove(keys)
      return keys
    } catch (e) {
      fail(e)
      return null
    }
  }

  function ingestFiles(
    enqueue: (files: File[], prefix?: string) => EnqueueResult,
    files: File[],
    prefix: string,
  ): void {
    if (files.length === 0) return
    const result = enqueue(files, prefix)
    if (result.rejected.length > 0) {
      toast.warning(t('files.msg.upload-rejected', { n: result.rejected.length }))
    }
  }

  // ── M3 回收站（TrashPanel/Home 消费；确认手法沿用 removeEntries：toast.confirm + cancel 静默） ──

  /** TrashEntry 显示名（TrashEntry 无 name 字段）：'a/b.txt'→'b.txt'，'a/c/'→'c' */
  function entryName(e: TrashEntry): string {
    const trimmed = e.key.replace(/\/$/, '')
    return trimmed.slice(trimmed.lastIndexOf('/') + 1)
  }

  /** 恢复（删 latest DeleteMarker 即恢复可见，可逆）：无确认直接执行；空批零调用 */
  async function restoreEntries(entries: TrashEntry[]): Promise<string[] | null> {
    if (entries.length === 0) return null
    try {
      await trashFace(tree).restoreTrash(entries)
      return entries.map((e) => e.key)
    } catch (e) {
      fail(e) // TrashBatchError 等业务失败走 toast 管道；恢复失败可重试（删除幂等）
      return null
    }
  }

  /** 彻底删除（不可逆）：确认框文案钉「不可恢复」语义（files.trash.purge-*，zh/en 成对）；
   *  取消（toast.confirm reject）零调用直接收场；确认后 purgeTrash，单/多选文案与 removeEntries 同构 */
  async function purgeEntries(entries: TrashEntry[]): Promise<string[] | null> {
    const keys = entries.map((e) => e.key)
    if (keys.length === 0) return null
    try {
      await toast.confirm({
        title: t('files.trash.purge-title'),
        message:
          keys.length === 1
            ? t('files.trash.purge-confirm', { name: entryName(entries[0]!) })
            : t('files.trash.purge-multi-confirm', { n: keys.length }),
        type: 'warning',
      })
    } catch {
      return null // 取消——purgeTrash 零调用
    }
    try {
      await trashFace(tree).purgeTrash(entries)
      return keys
    } catch (e) {
      fail(e)
      return null
    }
  }

  return { createDir, renameEntry, removeEntries, restoreEntries, purgeEntries, ingestFiles }
}

/** ElMessageBox 的 cancel/close 以字符串 reject：与业务失败区分，静默处理 */
function isCancel(e: unknown): boolean {
  return e === 'cancel' || e === 'close'
}
