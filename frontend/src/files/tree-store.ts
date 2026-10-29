/**
 * 文件树 store（Wave1-A5 管理面）。契约：S3Client 见 src/sdk/types.ts（A3 实现）。
 * 分层：createFileTree(options) 可独立测试的控制器（不依赖 pinia）；
 *       useFileTreeStore() pinia setup store 薄壳，init(options) 注入依赖后透出控制器。
 * 要点：nodes 懒加载缓存；list 聚合翻页到尽；目录标记对象过滤；目录 rename/remove 平铺
 *       逐对象处理、失败抛 SdkError 携带已完成进度（可续跑）；成功后触发 onFileChanged；
 *       Lane F3 增 applyChange——外部 fileChanged（renderer 保存等）同步缓存的最小维护口；
 *       M3 增回收站四方法（listTrash/restoreTrash/purgeTrash/emptyTrash）——
 *       恢复 = 删 latest DeleteMarker（首错停取新任务、在途落定后聚合抛错，重试不与在途竞态）；
 *       彻底删除 = 复验 latest 仍为 DeleteMarker 后清该 key 全版本（防陈旧条目误删活数据）。
 */
import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { ERROR_CODES, SdkError } from '@/sdk/errorCodes'
import type { S3Client, S3ObjectSummary } from '@/sdk/types'

/** DeleteObjects 单批上限（S3/OSS/MinIO 通用），remove/renameDir 按此分批 */
const DELETE_BATCH = 1000

/** 回收站批量操作并发上限（M3 契约：并发 3——同时在途 ≤3，完成即补位） */
const TRASH_CONCURRENCY = 3

/** 目录桶缓存：一个 prefix 下的直接子目录与文件 */
export interface DirBucket {
  dirs: S3ObjectSummary[]
  files: S3ObjectSummary[]
  loaded: boolean
}

/** fileChanged 事件载荷（映射契约 FileChangedPayload） */
export interface FileChangedEvent {
  key: string
  action: 'put' | 'delete' | 'rename'
  from?: string
}

export interface FileTreeOptions {
  client: S3Client
  rootPrefix?: string // 树根目录域（如 'sessions/abc/'），默认 ''（bucket 根）
  /** 初始目录（ui.initialPath，复审 #7）：相对 rootPrefix 的规范化 prefix；缺省=rootPrefix */
  initialPath?: string
  onFileChanged?: (payload: FileChangedEvent) => void // 动作成功后的变更回调（宿主同步视图用）
}

export interface FileTreeController {
  currentPath: string // 当前所在目录（规范化后的 prefix）
  loading: boolean // 任一 S3 动作在途时为 true（计数器归并，避免并发闪烁）
  error: SdkError | null // 最近一次失败的错误（动作成功后清空）
  readonly nodes: Map<string, DirBucket> // 懒加载缓存（UI 直接 nodes.get(normalizePrefix(p)) 读）
  /** 加载目录并写缓存；已 loaded 默认走缓存，opts.force 强制刷新 */
  loadDir(prefix: string, opts?: { force?: boolean }): Promise<void>
  /** 建目录：put 目录标记 → 刷新父目录 → fileChanged(put)；返回新目录 key */
  mkdir(prefix: string, name: string): Promise<string>
  /** 重命名（文件或目录；目录逐对象 copy 支持续跑）→ 刷新缓存 → fileChanged(rename) */
  rename(from: string, to: string): Promise<void>
  /** 删除（文件 key 或目录 prefix，目录平铺展开）→ 清缓存 → 逐 key fileChanged(delete) */
  remove(keys: string[]): Promise<void>
  /** 应用外部 fileChanged（Lane F3：renderer 保存/宿主侧变更 → 树缓存最小维护，不发网络请求） */
  applyChange(payload: FileChangedEvent): void
}

/** 回收站条目（M3 契约）：该 key 的 latest 行为 DeleteMarker（删除后未恢复、未清） */
export interface TrashEntry {
  key: string // 原路径
  deleteMarkerVersionId: string // latest DeleteMarker 的 versionId（恢复 = 删它）
  /** 删除时间 = marker LastModified（epoch ms）；行缺失/不可解析 → null（UI 侧 null 显示「—」） */
  deletedAt: number | null
  versions: number // 该 key 实体 Version 数（不含 DeleteMarker）
}

/**
 * 文件树控制器 + 回收站四方法（M3）。
 * 独立成面、不并入 FileTreeController：既有按 FileTreeController 字面量构造的
 * 消费方/测试桩无需补齐桩实现即可继续编译。回收站依赖 client 的可选版本域能力
 * （listObjectVersions/deleteVersion），能力缺失时抛 SdkError(UNSUPPORTED_MODE)。
 */
export interface FileTreeWithTrash extends FileTreeController {
  /** 列回收站：listObjectVersions 分页聚合 → 按 key 分组 → 仅收 latest 为 DeleteMarker 的组 */
  listTrash(opts?: { prefix?: string }): Promise<TrashEntry[]>
  /**
   * 恢复：逐条 deleteVersion(key, latest marker id)（删标记即恢复可见），并发 3；空数组零调用。
   * 失败语义：首错即停取新任务、等在途删除落定后聚合抛 TrashBatchError（message 含失败 key 清单，
   * failedDetails 附逐条原因）——调用方收到错误时不存在仍在后台跑的删除请求，重试不与在途竞态（删除幂等）。
   */
  restoreTrash(entries: TrashEntry[]): Promise<void>
  /**
   * 彻底删除：每 key 先 listObjectVersions({prefix}) 复验 latest 仍为 DeleteMarker 再清全版本
   * （Version+DeleteMarker）；latest 已是实体版本（listTrash 后被恢复/重传）的 key 跳过不删不报错
   * （防陈旧条目误删活数据，console.info 一行）；key 无任何版本（已被并发清空）单独留痕一行、不计入 skipped。
   * 并发 3；单条失败（含 list 失败）不中断其余，结尾聚合抛 TrashBatchError
   * （message 含全部失败 key，failedDetails 附逐条原因）。返回 skipped=复验跳过的 key 数（零跳过 → 0）。
   */
  purgeTrash(entries: TrashEntry[]): Promise<{ skipped: number }>
  /** 清空：listTrash(opts) → purgeTrash 全部；purged=实清 key 数（条目数 − 复验跳过数；非版本号数） */
  emptyTrash(opts?: { prefix?: string }): Promise<{ purged: number }>
}

/** 前缀规范化：非空前补尾 '/'（'' 即 bucket 根） */
export function normalizePrefix(p: string): string {
  if (p === '') return ''
  return p.endsWith('/') ? p : `${p}/`
}

/** key 所属父目录前缀：'a/b.txt'→'a/'，'a/b/'→'a/'，'root.txt'→'' */
function parentPrefix(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key
  const i = trimmed.lastIndexOf('/')
  return i < 0 ? '' : trimmed.slice(0, i + 1)
}

/** SdkError 原样透传；其余包装为 S3_ERROR（契约：S3 面错误统一走 SdkError，不吞） */
function asSdkError(e: unknown): SdkError {
  if (e instanceof SdkError) return e
  const msg = e instanceof Error ? e.message : String(e)
  return new SdkError(ERROR_CODES.S3_ERROR, msg, e)
}

/** listTrash 按 key 聚合的中间形态（仅 isLatest=true 的行决定 latest 是 Version 还是 DeleteMarker） */
interface TrashGroup {
  latestIsMarker: boolean
  deleteMarkerVersionId: string
  deletedAt: number | null
  versions: number
}

/** 取或建 key 的聚合组（缺省 latest 非 marker：仅当见到 isLatest 的 DeleteMarker 才入站） */
function ensureTrashGroup(groups: Map<string, TrashGroup>, key: string): TrashGroup {
  let g = groups.get(key)
  if (!g) {
    g = { latestIsMarker: false, deleteMarkerVersionId: '', deletedAt: null, versions: 0 }
    groups.set(key, g)
  }
  return g
}

/**
 * 回收站批量操作聚合错误（restoreTrash/purgeTrash 抛出，P2-4）。
 * 继承 SdkError(S3_ERROR)：guarded 对 SdkError 原样透传，逐条原因不因包装丢失；
 * message 保持「前缀 + N 个 key：key 清单」不变式；failedDetails 逐条 `${key}: ${cause.message}`
 * （非 Error 原因 String 化；同步镜像于 detail）——聚合不丢单条原因，供调用方/UI 展示。
 */
export class TrashBatchError extends SdkError {
  /** 逐条 `${key}: ${cause.message}` 列表（failed 保序：首个错误最先） */
  readonly failedDetails: string[]

  constructor(head: string, failed: Map<string, unknown>) {
    const keys = [...failed.keys()]
    const details = keys.map((key) => {
      const cause = failed.get(key)
      return `${key}: ${cause instanceof Error ? cause.message : String(cause)}`
    })
    super(ERROR_CODES.S3_ERROR, `${head} ${keys.length} 个 key：${keys.join('、')}`, details)
    this.name = 'TrashBatchError'
    this.failedDetails = details
  }
}

/**
 * 受控并发执行：起 min(limit, items.length) 个 worker 共享游标消费 items，
 * 同时在途 ≤limit、完成即补位；跑完返回失败清单（全部成功则 []，即调用方拿到 void 语义）。
 * 失败语义（P1-1 修复，不与在途竞态）：某次 fn 抛错后全部 worker 停止取新任务（队列剩余项放弃），
 * 等所有在途调用落定才把失败收集为 {item, error}[] 返回（首个抛错者最先入列）——
 * 调用方拿到结果时不存在仍在后台消费 items 的遗留请求，重试不会与在途请求竞态。
 * fn 内部自行吞错的调用方（如 purgeTrash 的逐条聚合模式）不受此语义影响；
 * items 为空 → 零 worker、零调用、立即完成。
 */
async function runLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<Array<{ item: T; error: unknown }>> {
  let next = 0
  let stop = false // 首错即置位：只拦「取新任务」，不打断已在途的调用
  const failures: Array<{ item: T; error: unknown }> = []
  const worker = async (): Promise<void> => {
    while (!stop && next < items.length) {
      const item = items[next] as T // while 已守卫界内必有值（noUncheckedIndexedAccess 断言）
      next += 1
      try {
        await fn(item)
      } catch (error) {
        failures.push({ item, error })
        stop = true
      }
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker())
  await Promise.all(workers) // worker 自身不再抛（fn 错误已收进 failures），此处只会正常落定
  return failures
}

/** 创建文件树控制器（独立可测；不依赖 pinia）。含 M3 回收站四方法（FileTreeWithTrash 面） */
export function createFileTree(options: FileTreeOptions): FileTreeWithTrash {
  const { client } = options
  const nodes = ref(new Map<string, DirBucket>())
  const currentPath = ref(normalizePrefix(options.initialPath ?? options.rootPrefix ?? ''))
  const error = ref<SdkError | null>(null)
  const activeCount = ref(0)
  const loading = computed(() => activeCount.value > 0)
  /** 同 prefix 在途加载去重 */
  const inflight = new Map<string, Promise<void>>()

  const emitChanged = (payload: FileChangedEvent): void => options.onFileChanged?.(payload)

  /** 动作统一包装：loading 计数 + 成功清错误 + 失败记错误态并透传 SdkError */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    activeCount.value++
    try {
      const r = await fn()
      error.value = null
      return r
    } catch (e) {
      const err = e instanceof SdkError ? e : asSdkError(e)
      error.value = err
      throw err
    } finally {
      activeCount.value--
    }
  }

  /** 聚合翻页拉取一个目录并写缓存；force 绕过缓存，在途请求复用 */
  async function fetchDir(prefix: string, force: boolean): Promise<void> {
    const cached = nodes.value.get(prefix)
    if (cached?.loaded && !force) return
    const pending = inflight.get(prefix)
    if (pending) return pending
    const task = guarded(async () => {
      const dirs: S3ObjectSummary[] = []
      const files: S3ObjectSummary[] = []
      let token: string | undefined
      do {
        const page = await client.list(prefix, token ? { continuationToken: token } : undefined)
        dirs.push(...page.dirs)
        for (const f of page.files) {
          if (f.key !== prefix) files.push(f) // 目录标记对象不是文件
        }
        token = page.continuationToken
      } while (token)
      nodes.value.set(prefix, { dirs, files, loaded: true }) // 成功才写缓存；失败保留旧值（若有）
    })
    inflight.set(prefix, task)
    try { await task } finally { inflight.delete(prefix) }
  }

  async function loadDir(prefix: string, opts?: { force?: boolean }): Promise<void> {
    const p = normalizePrefix(prefix)
    await fetchDir(p, opts?.force === true)
    currentPath.value = p // 失败抛出时不改 currentPath
  }

  /** 刷新一组 key/prefix 所属的父目录（去重后强制重拉） */
  async function refreshParents(keys: string[]): Promise<void> {
    for (const p of new Set(keys.map(parentPrefix))) await fetchDir(p, true)
  }

  async function mkdir(prefix: string, name: string): Promise<string> {
    if (name === '' || name.includes('/') || name === '.' || name === '..') {
      throw new SdkError(ERROR_CODES.BAD_PARAM, `非法目录名：'${name}'`)
    }
    const parent = normalizePrefix(prefix)
    const key = `${parent}${name}/`
    await guarded(async () => {
      await client.put(key, new Blob([])) // 目录标记：0 字节对象
      await fetchDir(parent, true)
    })
    emitChanged({ key, action: 'put' })
    return key
  }

  async function rename(from: string, to: string): Promise<void> {
    if (from === '' || to === '') throw new SdkError(ERROR_CODES.BAD_PARAM, 'rename 源/目标不能为空')
    if (from === to) throw new SdkError(ERROR_CODES.BAD_PARAM, 'rename 源/目标相同')
    if (from.endsWith('/')) {
      if (!to.endsWith('/')) throw new SdkError(ERROR_CODES.BAD_PARAM, '目录 rename 目标必须以 / 结尾')
      if (to.startsWith(from)) throw new SdkError(ERROR_CODES.BAD_PARAM, '不能把目录移动到自身内部')
      await guarded(() => renameDir(from, to))
    } else {
      await guarded(async () => {
        await client.copy(from, to)
        await client.remove([from])
        await refreshParents([from, to])
      })
    }
    emitChanged({ key: to, action: 'rename', from })
  }

  /** 目录 rename：平铺列举 → 逐对象 copy（记进度，失败可续跑）→ 批量 remove → 缓存失效 */
  async function renameDir(from: string, to: string): Promise<void> {
    const all = await flatList(from)
    const done: string[] = []
    try {
      for (const obj of all) {
        await client.copy(obj.key, to + obj.key.slice(from.length))
        done.push(obj.key)
      }
      for (let i = 0; i < done.length; i += DELETE_BATCH) {
        await client.remove(done.slice(i, i + DELETE_BATCH))
      }
    } catch (e) {
      const err = e instanceof SdkError ? e : asSdkError(e)
      // 续跑信息：已完成对象清单 + 总数；S3 copy 覆盖幂等，重试可从断点继续
      throw new SdkError(err.code, `目录重命名中断：已完成 ${done.length}/${all.length}`, {
        from, to, done, total: all.length, cause: err.detail,
      })
    }
    for (const k of [...nodes.value.keys()]) {
      if (k.startsWith(from) || k.startsWith(to)) nodes.value.delete(k) // 子树缓存失效
    }
    await refreshParents([from, to])
  }

  async function remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await guarded(async () => {
      const victims = new Set<string>()
      const dirPrefixes: string[] = []
      for (const key of keys) {
        if (key === '') throw new SdkError(ERROR_CODES.BAD_PARAM, 'remove 的 key 不能为空')
        if (key.endsWith('/')) {
          dirPrefixes.push(key)
          for (const obj of await flatList(key)) victims.add(obj.key) // 平铺展开（含标记）
        } else {
          victims.add(key)
        }
      }
      const all = [...victims]
      for (let i = 0; i < all.length; i += DELETE_BATCH) {
        await client.remove(all.slice(i, i + DELETE_BATCH))
      }
      for (const k of [...nodes.value.keys()]) {
        if (dirPrefixes.some(d => k.startsWith(d))) nodes.value.delete(k)
      }
      await refreshParents(keys)
    })
    for (const key of keys) emitChanged({ key, action: 'delete' }) // 逐调用 key 上报，子对象不重复刷屏
  }

  /** 平铺列举目录下全部对象（delimiter:''，含目录标记），目录 rename/remove 用 */
  async function flatList(dirPrefix: string): Promise<S3ObjectSummary[]> {
    const out: S3ObjectSummary[] = []
    let token: string | undefined
    do {
      const page = await client.list(
        dirPrefix,
        token ? { delimiter: '', continuationToken: token } : { delimiter: '' },
      )
      out.push(...page.files)
      for (const d of page.dirs) out.push(d) // 防御：平铺模式不应有 CommonPrefixes
      token = page.continuationToken
    } while (token)
    return out
  }

  // ── Lane F3：applyChange（外部 fileChanged → 缓存最小维护） ──

  /** key 末段名称：'a/b.txt'→'b.txt'，'a/c/'→'c' */
  function nameOf(key: string): string {
    const trimmed = key.endsWith('/') ? key.slice(0, -1) : key
    return trimmed.slice(trimmed.lastIndexOf('/') + 1)
  }

  /** 失效某目录前缀下的全部子树缓存（与 renameDir/remove 的失效口径一致） */
  function invalidateUnder(prefix: string): void {
    for (const k of [...nodes.value.keys()]) {
      if (k.startsWith(prefix)) nodes.value.delete(k)
    }
  }

  /** 从已缓存的父目录 bucket 移除条目；父目录未缓存为空操作 */
  function removeFromBucket(key: string): void {
    const bucket = nodes.value.get(parentPrefix(key))
    if (!bucket) return
    const arr = key.endsWith('/') ? bucket.dirs : bucket.files
    const i = arr.findIndex((e) => e.key === key)
    if (i >= 0) arr.splice(i, 1)
  }

  /**
   * 往已缓存的父目录 bucket 插入最小条目（size 未知置 0）；父目录未缓存为空操作。
   * 该 key 已存在时保留原条目：payload 不携 size/lastModified，list 结果才是权威，
   * 覆盖反而引入假数据（size=0 的旧条目也比伪造新值诚实）。
   */
  function upsertToBucket(key: string): void {
    const bucket = nodes.value.get(parentPrefix(key))
    if (!bucket) return
    if (bucket.dirs.some((d) => d.key === key) || bucket.files.some((f) => f.key === key)) return
    const isDir = key.endsWith('/')
    ;(isDir ? bucket.dirs : bucket.files).push({ key, name: nameOf(key), size: 0, isDir })
  }

  /**
   * 应用外部 fileChanged（P0 接线：renderer 保存/宿主侧变更 → 树缓存同步）。
   * 最小化口径（同步、零网络请求；需要权威数据请 loadDir(force)）：
   * - put：目标父目录已缓存 → 无则插入最小条目、有则保留（见 upsertToBucket）；
   * - delete：来源条目移除；来源为目录时子树缓存失效；
   * - rename：来源条目移除（目录含子树失效）→ 目标父目录已缓存则插入目标条目，
   *   目录 rename 额外失效目标子树（防陈旧拷贝）；
   * - 父目录未缓存 → 跳过（懒加载目录打开时自然拉到最新），绝不创建半截 bucket。
   */
  function applyChange(payload: FileChangedEvent): void {
    const { key, action } = payload
    if (action === 'put') {
      upsertToBucket(key)
      return
    }
    if (action === 'delete') {
      removeFromBucket(key)
      if (key.endsWith('/')) invalidateUnder(key)
      return
    }
    // rename（缺 from / from===to 整体忽略）
    const from = payload.from
    if (!from || from === key) return
    removeFromBucket(from)
    if (from.endsWith('/')) invalidateUnder(from)
    upsertToBucket(key)
    if (key.endsWith('/')) invalidateUnder(key)
  }

  // ── M3 回收站：listTrash / restoreTrash / purgeTrash / emptyTrash ──
  // 语义：恢复 = 删 latest DeleteMarker（marker 一删，该 key 实体版本重新可见）；
  //       彻底删除 = 清该 key 全部版本（Version+DeleteMarker 逐 versionId 删，清完 key 即消失）。

  /** 版本域可选能力守卫：client 未实现时明确报错（而非 "undefined is not a function"）；bind 防脱 this（方法内走 this.request） */
  function requireListObjectVersions(): NonNullable<S3Client['listObjectVersions']> {
    if (!client.listObjectVersions) {
      throw new SdkError(ERROR_CODES.UNSUPPORTED_MODE, '当前 client 不支持 listObjectVersions（回收站需要桶版本控制）')
    }
    return client.listObjectVersions.bind(client)
  }

  function requireDeleteVersion(): NonNullable<S3Client['deleteVersion']> {
    if (!client.deleteVersion) {
      throw new SdkError(ERROR_CODES.UNSUPPORTED_MODE, '当前 client 不支持 deleteVersion（回收站需要桶版本控制）')
    }
    return client.deleteVersion.bind(client)
  }

  /**
   * 聚合一个 key 的全部版本号 + latest 形态（Version+DeleteMarker；
   * isTruncated 用 (keyMarker, versionIdMarker) 回传续拉到尽）。
   * latestIsMarker=是否有 isLatest 的 DeleteMarker（无任何行 → false：无可删版本，也不触发防误删跳过）。
   */
  async function listKeyVersions(
    listVersions: NonNullable<S3Client['listObjectVersions']>,
    key: string,
  ): Promise<{ ids: string[]; latestIsMarker: boolean }> {
    const ids: string[] = []
    let latestIsMarker = false
    let marker: { keyMarker?: string; versionIdMarker?: string } | undefined
    do {
      const page = await listVersions({ prefix: key, ...marker })
      for (const v of page.versions) {
        ids.push(v.versionId)
        if (v.isLatest) latestIsMarker = false // latest 是实体版本（删后被恢复/覆盖写）
      }
      for (const m of page.deleteMarkers) {
        ids.push(m.versionId)
        if (m.isLatest) latestIsMarker = true
      }
      marker = page.isTruncated && page.nextKeyMarker !== undefined
        ? { keyMarker: page.nextKeyMarker, versionIdMarker: page.nextVersionIdMarker }
        : undefined
    } while (marker)
    return { ids, latestIsMarker }
  }

  /**
   * 列回收站：listObjectVersions 分页聚合到尽 → 按 key 分组 → 仅收 latest 为 DeleteMarker 的组。
   * versions=该 key 实体 Version 数（跨页归组）；deletedAt=latest marker 的 LastModified（缺失 → null）。
   */
  async function listTrash(opts?: { prefix?: string }): Promise<TrashEntry[]> {
    return guarded(async () => {
      const listVersions = requireListObjectVersions()
      const base: { prefix?: string } = opts?.prefix !== undefined ? { prefix: opts.prefix } : {}
      const groups = new Map<string, TrashGroup>()
      let marker: { keyMarker?: string; versionIdMarker?: string } | undefined
      do {
        const page = await listVersions({ ...base, ...marker })
        for (const v of page.versions) {
          const g = ensureTrashGroup(groups, v.key)
          g.versions += 1
          if (v.isLatest) g.latestIsMarker = false // latest 是实体版本（删后覆盖写）→ 不入站
        }
        for (const m of page.deleteMarkers) {
          const g = ensureTrashGroup(groups, m.key)
          if (m.isLatest) {
            g.latestIsMarker = true
            g.deleteMarkerVersionId = m.versionId
            g.deletedAt = m.lastModified ?? null // 行缺失/不可解析 → null（UI 侧显示「—」）
          }
        }
        marker = page.isTruncated && page.nextKeyMarker !== undefined
          ? { keyMarker: page.nextKeyMarker, versionIdMarker: page.nextVersionIdMarker }
          : undefined
      } while (marker)
      const entries: TrashEntry[] = []
      for (const [key, g] of groups) {
        if (g.latestIsMarker) {
          entries.push({ key, deleteMarkerVersionId: g.deleteMarkerVersionId, deletedAt: g.deletedAt, versions: g.versions })
        }
      }
      return entries
    })
  }

  /**
   * 恢复：逐条 deleteVersion(key, latest marker id)；并发 3；空数组零调用。
   * 失败语义（P1-1）：runLimited 首错即停取新任务、等在途删除落定后才聚合抛 TrashBatchError——
   * 调用方收到错误时在途请求已全部落定，重试不与在途竞态（deleteVersion 幂等，可安全重试）。
   */
  async function restoreTrash(entries: TrashEntry[]): Promise<void> {
    await guarded(async () => {
      if (entries.length === 0) return
      const deleteVersion = requireDeleteVersion()
      const failures = await runLimited(entries, TRASH_CONCURRENCY, (e) => deleteVersion(e.key, e.deleteMarkerVersionId))
      if (failures.length > 0) {
        const failed = new Map<string, unknown>() // key → 首个错误（保序；聚合抛错用）
        for (const f of failures) if (!failed.has(f.item.key)) failed.set(f.item.key, f.error)
        throw new TrashBatchError('回收站恢复失败', failed)
      }
    })
  }

  /**
   * 彻底删除（不可逆）：每 key「列→验→删」——listObjectVersions({prefix}) 聚合全部 versionId 时
   * 同步复验 latest 形态（P1-2：复验 list 与聚合 list 合并进阶段 1，purge 前 fresh 读一次即验，语义等价且省一程）：
   * latest 仍为 DeleteMarker → 清该 key 全部版本（Version+DeleteMarker）；
   * latest 已是实体版本（listTrash 后被恢复/重传）→ 跳过该 key（不删、不报错），console.info 一行留痕
   * （防陈旧条目把活版本全部删光）；key 无任何版本（已被并发清空）→ 无可删也无所谓误删，单独
   * console.info 一行留痕，不进 skipped。并发 3；单条失败（含 list 失败）不中断其余，
   * 结尾聚合抛 TrashBatchError（message 含全部失败 key，failedDetails 附逐条原因）。
   * 返回 { skipped }：复验跳过（latest 已非 DeleteMarker）的 key 数，供调用方折算实清数。
   */
  async function purgeTrash(entries: TrashEntry[]): Promise<{ skipped: number }> {
    return guarded(async () => {
      if (entries.length === 0) return { skipped: 0 }
      const listVersions = requireListObjectVersions()
      const deleteVersion = requireDeleteVersion()
      const failed = new Map<string, unknown>() // key → 首个错误（保序；聚合抛错用）
      const skipped: string[] = [] // 复验不通过的 key：latest 已非 DeleteMarker，防陈旧条目误删活数据
      // 阶段 1（列→验）：逐 key 聚合全部 versionId + 复验 latest 形态（list 失败同属该 key 单条失败，不拦其余 key）
      const victims: { key: string; versionId: string }[] = []
      await runLimited(entries, TRASH_CONCURRENCY, async (entry) => {
        let state: { ids: string[]; latestIsMarker: boolean }
        try {
          state = await listKeyVersions(listVersions, entry.key)
        } catch (e) {
          if (!failed.has(entry.key)) failed.set(entry.key, e)
          return
        }
        if (state.ids.length === 0) {
          // 零行（P2-N1）：key 已被并发清空，不存在任何版本——与「防误删跳过」是两回事，单独留痕不进 skipped
          console.info(`[tree-store] purgeTrash 跳过 ${entry.key}：key 无任何版本（已并发清空），跳过`)
          return
        }
        if (!state.latestIsMarker) {
          skipped.push(entry.key)
          return
        }
        for (const versionId of state.ids) victims.push({ key: entry.key, versionId })
      })
      if (skipped.length > 0) {
        // 一行留痕（非错误）：这些 key 未清——purge 只认「此刻 latest 仍是 DeleteMarker」的条目
        console.info(
          `[tree-store] purgeTrash 跳过 ${skipped.length} 个 key（latest 已非 DeleteMarker，防陈旧条目误删活数据）：${skipped.join('、')}`,
        )
      }
      // 阶段 2（删）：逐 versionId 删；失败记入清单后继续（失败条目也是逐 versionId 尝试，不整条跳过）
      await runLimited(victims, TRASH_CONCURRENCY, async (v) => {
        try {
          await deleteVersion(v.key, v.versionId)
        } catch (e) {
          if (!failed.has(v.key)) failed.set(v.key, e)
        }
      })
      if (failed.size > 0) {
        throw new TrashBatchError(`回收站彻底删除失败 ${failed.size} 个 key（其余已清）`, failed)
      }
      return { skipped: skipped.length }
    })
  }

  /** 清空回收站：listTrash(opts) 全量 → purgeTrash；purged=实清 key 数（条目数 − 复验跳过数；非版本号数） */
  async function emptyTrash(opts?: { prefix?: string }): Promise<{ purged: number }> {
    const entries = await listTrash(opts) // listTrash/purgeTrash 各自 guarded（loading/error 已归口）
    const { skipped } = await purgeTrash(entries)
    return { purged: entries.length - skipped }
  }

  // reactive 包装：外部以 ctrl.currentPath / ctrl.nodes 直接读写（ref 自动解包）
  return reactive({
    currentPath, loading, error, nodes,
    loadDir, mkdir, rename, remove, applyChange,
    listTrash, restoreTrash, purgeTrash, emptyTrash,
  }) as FileTreeWithTrash
}

/**
 * pinia setup store 薄壳：依赖（client/回调）由装配层经 init() 注入
 * （凭证异步就绪后才有 client，不能在 defineStore 闭包里静态注入）
 */
export const useFileTreeStore = defineStore('filesTree', () => {
  /** P2-3 返回值放宽：createFileTree 恒返回 FileTreeWithTrash 全量面（含 trash 四方法），如实标注 */
  const controller = shallowRef<FileTreeWithTrash | null>(null)

  /** 注入依赖并创建控制器；可重复调用重建（换 client / 重置会话） */
  function init(options: FileTreeOptions): FileTreeWithTrash {
    const ctrl = createFileTree(options)
    controller.value = ctrl
    return ctrl
  }

  return { controller, init }
})
