/**
 * 上传队列（Wave1-A5 管理面；Lane G1 暂停/恢复/重试 + 冲突确认）。契约：S3Client/types.ts；
 * onProgress/onDone/onFailed 由装配层映射 uploadProgress/uploadDone/uploadFailed 事件。
 * 要点：enqueue 同步校验分类（ext→size）不抛批错误；≤阈值直传，超出 multipart（分片并发≤2，
 *       complete 按 partNumber 升序）；abort 排队即弃、分片中立即 abortMultipart、统一取消码。
 *
 * Lane G1 诚实口径（暂停/恢复/重试语义，实现与注释一致，无夸大）：
 *  - multipart 项 pause(id)：不再调度后续分片；当前在途分片落定后进入 paused 终态前状态
 *    （保留 uploadId 与已完成分片 etag，服务端分片不清理）。resume(id) 续传：uploadPart 按
 *    partNumber 幂等，已落定分片直接跳过不重传，只补传缺失分片后 complete。
 *  - 直传（单 PUT）项：S3Client.put 无中断通道（无 AbortSignal 参数），"暂停"对在途直传项
 *    不产生暂停效果——put 落定即 done（文件已在服务端，不能谎报暂停）。pause 仅对排队中项
 *    即时生效；分片中项按上述分片口径生效。
 *  - retry(id)（仅 failed 项）：失败时不再 abort 清理服务端分片（Lane G1 语义修订），uploadId
 *    与已完成分片保留在任务上，retry 复用 uploadId 续传（只补缺失分片）；直传项失败=整重传
 *    （无 uploadId 可复用）。注意：失败任务的分片残留将保留至 retry 消化；若任务被 abort 则
 *    立即 abortMultipart 清理； neither 时残留交由 S3 存储桶生命周期规则兜底（诚实注记）。
 *  - pauseAll/resumeAll：队列级便捷方法，逐项调 pause/resume（幂等）。
 *  - enqueue 可选 opts.onConflict：提供时入队前 client.head 并发探测（≤8 路）重名，命中回调
 *    裁决（'overwrite'=照传覆盖 / 'skip'=该文件进 rejected{reason:'conflict'}；回调抛错=整批
 *    取消，调用方收到 reject——Home 以 4901 语义承载）。缺省不探测直传（现行为不变，JSSDK
 *    uploadFiles 命令路径不传 onConflict，行为零变化）。
 *
 * M2 断点续传扩展（全部可选参数，不传=现状行为逐字节不变）：
 *  - checkpointStore：multipart 任务在 createMultipart 返回后落断点行（行出现即字段齐全；
 *    fingerprint=sha256hex(key:size:lastModified)，mtime 取 File.lastModified——File 对象自带
 *    的最后修改时间，跨会话稳定可复算），每片成功回写 parts；complete / 用户取消 / 终态失败
 *    移除，pause 保留（跨会话续传的意义所在）；≤阈值单 PUT 全程不写断点。
 *    断点写按任务串行（落行 → 逐片更新，保序）。
 *  - 单片重试：uploadPart 失败每片独立重试 ≤partRetry 次，指数退避间隔制（第 n 次重试前
 *    等待 base×2^(n-1) + 0~250ms 抖动，间隔逐次拉开）；
 *    仅网络错（detail.status=0）/5xx/超时（TIMEOUT）重试——4xx 语义错与取消码 4901 立即抛。
 *  - 自适应分片：effectivePartSize(size, base, maxParts)=max(base, pow2ceil(size/maxParts))，
 *    保证片数 ≤ maxParts（默认 10000）。
 *  - 进度 onProgress：分片完成推进 bytes（累计真实字节口径——loaded 已按末片截断精确累计）；
 *    ≤阈值单 PUT 直传不受管（零回调）。
 *  - resumeCheckpoints()：断点行 × listMultipartUploads 探活，uploadId 存活→续传候选；
 *    不在清单→死行就地 remove（保守：探活接口失败时不动任何断点）。
 *  - UI 接线口（M2/Home resume 面包条）：partSizeFor(size) 供调用侧 partSize 硬性校验
 *    （UI 波次契约/评审 P2-3）；enqueueResume(file, candidate) 按候选 uploadId/分片续传入队；
 *    discardCheckpoint(candidate) 放弃候选（abortMultipart + 断点行移除双清）。
 */
import { ERROR_CODES, SdkError } from '@/sdk/errorCodes'
import { sha256HexSync } from '@/sdk/s3/sigv4'
import type { S3Client } from '@/sdk/types'
import type { CheckpointStore, UploadCheckpoint } from './checkpoint-store'

const MB = 1024 * 1024
/** 单文件内分片并行度（2 路足够打满带宽又不挤占多文件并发） */
const PART_CONCURRENCY = 2
/** 冲突探测并发上限（head 轻请求，8 路足够又不挤占） */
const PROBE_CONCURRENCY = 8
/** 自适应分片片数上限（默认）：effectivePartSize 保证片数不超过该值 */
const DEFAULT_MAX_PARTS = 10000
/** 单片重试次数上限（默认，不含首试） */
const DEFAULT_PART_RETRY = 3
/** 单片重试退避基数（默认 ms）：第 n 次重试等待 base×2^(n-1) + 0~250ms 抖动 */
const DEFAULT_PART_RETRY_BASE_MS = 500
/** 断点 fingerprint 分隔输入（key:size:lastModified 拼串后整体做 sha256） */
const FINGERPRINT_TE = new TextEncoder()

export interface UploadParams {
  uploadMaxBytes?: number // 单文件大小上限（字节），超出拒收
  uploadConcurrency?: number // 同时上传文件数，默认 3
  denyExts?: string[] // 扩展名黑名单（归一化：忽略大小写与前导点）
  partSize?: number // 分片大小（字节），默认 8MB（作自适应分片的基础分片）
  multipartThreshold?: number // 分片阈值（字节），≤ 该值直传，默认 16MB
  maxParts?: number // 自适应分片片数上限，默认 10000（effectivePartSize 保证不超）
  partRetry?: number // 单片失败重试次数上限（每片独立），默认 3
  partRetryBaseMs?: number // 单片重试退避基数（ms），默认 500
  checkpointStore?: CheckpointStore // 传入启用跨会话断点续传；不传=现状行为零变化
  /** 字节级进度（分片完成推进；≤阈值直传零回调）。rate 可省略，节流归调用侧 */
  onProgress?: (p: UploadProgress) => void
}

/** 字节级进度事件（M2）：bytes=已传字节（累计真实口径）、total=文件总字节 */
export interface UploadProgress {
  bytes: number
  total: number
  rate?: number
}

/** 断点续传候选（resumeCheckpoints 产出）：uploadId 经 listMultipartUploads 探活仍存活 */
export interface ResumeCandidate {
  fingerprint: string
  path: string
  size: number
  lastModified: number
  partSize: number
  uploadId: string
  /** 已上传成功的分片（partNumber 升序；续传只补缺失分片） */
  parts: { number: number; etag: string }[]
}

export interface UploadHooks {
  onProgress?(id: string, loaded: number, total: number): void // 分片累计、每片必调；节流归调用侧
  onDone?(id: string, key: string): void
  onFailed?(id: string, err: unknown): void
}

export interface UploadQueueOptions {
  client: S3Client
  params?: UploadParams
  hooks?: UploadHooks
}

/** 冲突裁决结果：'overwrite'=照常上传（S3 put 天然覆盖）；'skip'=跳过该批重名文件 */
export type ConflictVerdict = 'overwrite' | 'skip'

export interface EnqueueOptions {
  /** 重名裁决回调（可缺省）：命中重名时以重名文件名列表调用；抛错=整批取消（调用方 reject） */
  onConflict?: (names: string[]) => Promise<ConflictVerdict>
}

export type UploadStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'failed' | 'aborted'

/** 拒收原因：ext/size（契约 §五）+ conflict（Lane G1 新增，仅显式 onConflict 路径产生） */
export type UploadRejectReason = 'ext' | 'size' | 'conflict'

/** JSSDK 兼容回包（commands.ts finishEnqueue 消费）：reason 限契约两值（形状向后兼容，不得放宽） */
export interface EnqueueResult {
  accepted: { id: string }[]
  rejected: { name: string; reason: Exclude<UploadRejectReason, 'conflict'>; code?: number }[]
}

/**
 * 冲突路径回包（onConflict 异步重载）：rejected reason 扩展 'conflict'——该联合类型仅存在于
 * upload-queue 内部与 UI 直连路径；JSSDK uploadFiles 命令不传 onConflict，回包仍为
 * EnqueueResult（契约形状零变化，commands.ts 只读不受影响）。
 */
export interface ConflictEnqueueResult {
  accepted: { id: string }[]
  rejected: { name: string; reason: UploadRejectReason; code?: number }[]
}

/**
 * 用户取消专码。契约 §七未定义"取消"错误码，预留 4901；
 * 装配层映射 uploadFailed 时按 code>=4900 识别为用户主动取消。
 */
export const UPLOAD_ABORTED_CODE = 4901

/**
 * 冲突拒收码（占位）：契约 §七未定义"重名冲突"错误码，按任务书口径暂借 4005（BAD_PARAM）
 * 占位，仅供 UI 侧识别；JSSDK reply 的 rejected 仅由 commands.ts 从 ext/size 映射 4304/4302，
 * conflict 只出现在显式传入 onConflict 的 UI 直连路径，不进 JSSDK 回包（reason 联合类型为本
 * 模块内部扩展，commands.ts 只读不受影响）。
 */
export const UPLOAD_CONFLICT_CODE = ERROR_CODES.BAD_PARAM

interface Task {
  id: string
  file: File
  key: string
  status: UploadStatus
  aborted: boolean
  /** 暂停标记：pump 不调度；分片泵停止派发新分片，在途落定后 run 以 paused 落定 */
  paused: boolean
  uploadId?: string // multipart 进行中的 uploadId（undefined = 非分片或已收尾/已被 abort 清理）
  errMsg?: string // 最近一次失败原因（errorOf 供面板展示；重试成功不清除也无碍——status 已非 failed）
  /** 已落定分片 etag（partNumber 升序提交）；pause/失败后保留供 resume/retry 续传 */
  parts?: Map<number, string>
  /** 是否还在 pending 池（resume 时避免重复入池） */
  inPending: boolean
  /** 断点指纹（M2，仅启用 checkpointStore 的 multipart 任务有值） */
  fingerprint?: string
  /** 活跃断点行（M2）：非 undefined ⇒ 断点在库，分片成功即回写；终态移除后置 undefined */
  cpRow?: UploadCheckpoint
  /** 断点写串行链（M2）：落行 → 逐片更新，按任务保序避免乱序回写 */
  cpChain?: Promise<void>
}

export class UploadQueue {
  private readonly client: S3Client
  private readonly hooks: UploadHooks
  private readonly concurrency: number
  private readonly maxBytes: number | undefined
  private readonly partSize: number
  private readonly threshold: number
  private readonly denyExts: ReadonlySet<string>
  private readonly maxParts: number
  private readonly partRetry: number
  private readonly partRetryBaseMs: number
  private readonly checkpointStore: CheckpointStore | undefined
  private readonly onProgress: ((p: UploadProgress) => void) | undefined
  private readonly tasks = new Map<string, Task>()
  private readonly pending: Task[] = []
  private active = 0

  constructor(options: UploadQueueOptions) {
    this.client = options.client
    this.hooks = options.hooks ?? {}
    const p = options.params ?? {}
    this.concurrency = Math.max(1, p.uploadConcurrency ?? 3)
    this.maxBytes = p.uploadMaxBytes
    this.partSize = Math.max(1, p.partSize ?? 8 * MB)
    this.threshold = Math.max(0, p.multipartThreshold ?? 16 * MB)
    this.denyExts = new Set((p.denyExts ?? []).map(normalizeExt).filter(ext => ext !== ''))
    this.maxParts = Math.max(1, p.maxParts ?? DEFAULT_MAX_PARTS)
    this.partRetry = Math.max(0, p.partRetry ?? DEFAULT_PART_RETRY)
    this.partRetryBaseMs = Math.max(0, p.partRetryBaseMs ?? DEFAULT_PART_RETRY_BASE_MS)
    this.checkpointStore = p.checkpointStore
    this.onProgress = p.onProgress
  }

  /**
   * 冲突探测路径：opts.onConflict 提供时为异步（head 探测 + 回调裁决后落池），resolve 完整回包。
   * （重载在前：vi.mocked 等工具类型取末个重载推断，保证同步契约路径的既有 mock 用法不破。）
   */
  enqueue(files: File[], prefix: string | undefined, opts: EnqueueOptions): Promise<ConflictEnqueueResult>
  /** 校验分类并入池开跑：同步返回受理/拒绝结果（对齐 UploadFilesReply），不抛批错误 */
  enqueue(files: File[], prefix?: string): EnqueueResult
  enqueue(files: File[], prefix = '', opts?: EnqueueOptions): EnqueueResult | Promise<ConflictEnqueueResult> {
    if (opts?.onConflict) return this.enqueueWithConflict(files, prefix, opts.onConflict)
    const { accepted, rejected } = this.classify(files, normalizePrefix(prefix))
    this.admit(accepted)
    // 同步路径只产生 ext/size（conflict 仅 onConflict 异步路径产生），收窄断言安全
    return { accepted: accepted.map(a => ({ id: a.task.id })), rejected: rejected as EnqueueResult['rejected'] }
  }

  /** 同步分类：ext/size 拒收 + 受理候选（不入池；入池统一走 admit） */
  private classify(files: File[], base: string): {
    accepted: { task: Task }[]
    rejected: ConflictEnqueueResult['rejected']
  } {
    const accepted: { task: Task }[] = []
    const rejected: { name: string; reason: UploadRejectReason; code?: number }[] = []
    for (const f of files) {
      const ext = extOf(f.name)
      if (ext !== '' && this.denyExts.has(ext)) {
        rejected.push({ name: f.name, reason: 'ext' })
        continue
      }
      if (this.maxBytes !== undefined && f.size > this.maxBytes) {
        rejected.push({ name: f.name, reason: 'size' })
        continue
      }
      accepted.push({ task: this.newTask(f, base + f.name) })
    }
    return { accepted, rejected }
  }

  /** 异步入队：分类 → head 重名探测（并发≤8，探测失败按不存在处理） → 回调裁决 → 落池 */
  private async enqueueWithConflict(
    files: File[],
    prefix: string,
    onConflict: (names: string[]) => Promise<ConflictVerdict>,
  ): Promise<ConflictEnqueueResult> {
    const base = normalizePrefix(prefix)
    const { accepted, rejected } = this.classify(files, base)
    const hits = await this.probeExisting(accepted.map(a => a.task.key))
    if (hits.size > 0) {
      // 回调抛错（Home 的"取消整批"）→ 直接向上抛：调用方 reject（4901 语义），本批一个不入池
      const verdict = await onConflict([...hits].map(key => key.slice(base.length)))
      if (verdict === 'skip') {
        const kept: { task: Task }[] = []
        for (const a of accepted) {
          if (hits.has(a.task.key)) rejected.push({ name: a.task.file.name, reason: 'conflict', code: UPLOAD_CONFLICT_CODE })
          else kept.push(a)
        }
        accepted.length = 0
        accepted.push(...kept)
      }
      // 'overwrite'：全部照传（S3 put 同 key 天然覆盖）
    }
    this.admit(accepted)
    return { accepted: accepted.map(a => ({ id: a.task.id })), rejected }
  }

  /** 并发≤8 探测重名 key 集合；单 key 探测异常按"不存在"处理（不阻断上传主链路） */
  private async probeExisting(keys: string[]): Promise<Set<string>> {
    const hits = new Set<string>()
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < keys.length) {
        const key = keys[cursor++]!
        try {
          if ((await this.client.head(key)).exists) hits.add(key)
        } catch {
          // 探测失败不阻断：head 非 2xx（权限/网络抖动）时按不存在直传，行为回退到无探测
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, keys.length) }, worker))
    return hits
  }

  private newTask(file: File, key: string): Task {
    return { id: genId(), file, key, status: 'queued', aborted: false, paused: false, inPending: false }
  }

  /** 落池开跑（同步/异步路径共用） */
  private admit(accepted: { task: Task }[]): void {
    for (const { task } of accepted) {
      this.tasks.set(task.id, task)
      // 断点行不在入队时落库：等 createMultipart 返回（字段齐全）再落，见 checkpointBegin
      task.inPending = true
      this.pending.push(task)
    }
    this.pump()
  }

  /**
   * 取消任务：排队/暂停中直接取消并回调 onFailed（multipart 残留一并 abortMultipart 清理）；
   * 上传中 multipart 立即 abortMultipart（直传 put 无 signal，完成后于 run 内丢弃）。
   * 已终态/未知 id 返回 false（幂等）。
   */
  abort(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || isTerminal(task.status)) return false
    task.aborted = true
    if (task.status === 'queued' || task.status === 'paused') {
      task.status = 'aborted' // 留在队列里由 pump 跳过，避免 splice
      this.cleanupMultipart(task) // paused 的 multipart 项可能持有 uploadId，一并清理
      this.checkpointDiscard(task) // 用户取消=终态：断点一并移除（服务端会话已销毁，无续传可言）
      this.hooks.onFailed?.(id, this.abortedError(id))
      return true
    }
    this.cleanupMultipart(task)
    this.checkpointDiscard(task) // 上传中取消=终态：断点立即移除（run 落定路径的 discard 幂等）
    return true
  }

  /**
   * 暂停单项：queued 立即落 paused；uploading 的 multipart 停止调度新分片、在途落定后落
   * paused（保留 uploadId/分片）；直传在途项标记后照常落定（put 无中断通道，诚实口径见
   * 文件头注）。已暂停/终态/未知 id 返回 false（幂等）。
   */
  pause(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || isTerminal(task.status) || task.paused) return false
    task.paused = true
    if (task.status === 'queued') task.status = 'paused'
    // uploading：分片泵观察到 paused 后停止派发，在途清零由 run 落 paused；直传落定即 done
    return true
  }

  /** 恢复单项：paused → queued 重新入池（multipart 续传：已落定分片按 partNumber 跳过） */
  resume(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'paused') return false
    task.paused = false
    task.status = 'queued'
    if (!task.inPending) {
      task.inPending = true
      this.pending.push(task)
    }
    this.pump()
    return true
  }

  /**
   * 重试失败项：failed → queued 重新入池。multipart 项复用 uploadId + 已完成分片续传（只补
   * 缺失分片）；直传项无 uploadId 可复用=整重传。aborted（服务端 uploadId 已销毁）不支持
   * retry——如需重传请重新入队。非 failed/未知 id 返回 false（幂等）。
   */
  retry(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'failed') return false
    task.paused = false
    task.status = 'queued'
    task.inPending = true
    this.checkpointRestore(task) // 终态失败时断点已移除；retry 复用 uploadId 续传，断点就地重建
    this.pending.push(task)
    this.pump()
    return true
  }

  /** 队列级暂停：所有 queued/uploading（非终态、未暂停）项逐项 pause（幂等） */
  pauseAll(): void {
    for (const task of this.tasks.values()) this.pause(task.id)
  }

  /** 队列级恢复：所有 paused 项逐项 resume（幂等） */
  resumeAll(): void {
    for (const task of this.tasks.values()) this.resume(task.id)
  }

  status(id: string): UploadStatus | undefined {
    return this.tasks.get(id)?.status
  }

  /** 失败原因（failed 项；取消项也有——UPLOAD_ABORTED 语义）：面板失败行展示用 */
  errorOf(id: string): string | undefined {
    return this.tasks.get(id)?.errMsg
  }

  /** multipart 服务端残留清理（仅 abort 语义调用；业务失败保留供 retry 续传，见文件头注） */
  private cleanupMultipart(task: Task): void {
    const uploadId = task.uploadId
    if (!uploadId) return
    task.uploadId = undefined
    task.parts = undefined
    void this.client.abortMultipart(task.key, uploadId).catch(() => { /* 尽力清理 */ })
  }

  // ───────────────── M2 断点生命周期（仅 checkpointStore 启用且 multipart 任务生效） ─────────────────

  /** 断点写操作按任务串行入链：前序写失败不阻断后续写（断点是尽力而为的加速，不能反过来拖死上传） */
  private cpEnqueue(task: Task, op: () => Promise<void>): void {
    // 尾部 catch 吞掉本写失败并保持链 resolved：后续写照常执行，且链尾不产生 unhandled rejection
    task.cpChain = (task.cpChain ?? Promise.resolve()).then(op, op).catch(() => { /* 尽力而为 */ })
  }

  /**
   * 断点起点：createMultipart 返回后落行——行一旦出现字段即齐全（含真实 uploadId），
   * 不采用「入队占位行 + 事后回填」（crash 发生在 create 之前本就无可续传，占位行无损失可言）。
   * 本调用先于分片泵启动，cpChain 保序保证「落行 → 逐片更新」不乱序。
   * partSize 记自适应后的实际分片（续传时据此校验分片覆盖）。
   */
  private checkpointBegin(task: Task, uploadId: string): void {
    const store = this.checkpointStore
    if (!store || task.file.size <= this.threshold) return // ≤阈值单 PUT：全程不写断点
    const now = Date.now()
    const row: UploadCheckpoint = {
      fingerprint: taskFingerprint(task),
      path: task.key,
      size: task.file.size,
      lastModified: task.file.lastModified,
      partSize: effectivePartSize(task.file.size, this.partSize, this.maxParts),
      uploadId,
      parts: [],
      createdAt: now,
      updatedAt: now,
    }
    task.fingerprint = row.fingerprint
    task.cpRow = row
    // 执行时复核行仍存活：若真正落库前任务已终态（discard 已置空 cpRow），过期写直接跳过，
    // 避免为已取消/已失败任务在库里复活出一行孤儿断点（此类残留本就无续传价值）
    this.cpEnqueue(task, async () => {
      if (task.cpRow === row) await store.put(row)
    })
  }

  /** 每片成功回写 parts（partNumber 升序入库；并发落定乱序到达，写前就地排序） */
  private checkpointTouch(task: Task, partNumber: number, etag: string): void {
    const row = task.cpRow
    if (!row) return
    row.parts.push({ number: partNumber, etag })
    row.parts.sort((a, b) => a.number - b.number)
    row.updatedAt = Date.now()
    const store = this.checkpointStore!
    // 执行时复核行仍存活：断点已移除（终态落定）后，迟到的逐片回写不得把行重新插回——
    // 否则「终态失败/complete 后 load=null」的清理承诺会被并发分片的迟到回写打破
    this.cpEnqueue(task, async () => {
      if (task.cpRow === row) await store.put(row)
    })
  }

  /**
   * 断点移除——仅三种终态：complete / 用户取消(abort) / 终态失败。pause 不在此列（断点保留
   * 正是续传的意义；pause 落定为非终态 paused，cpRow 存活，resume 后分片成功继续回写）。
   */
  private checkpointDiscard(task: Task): void {
    const row = task.cpRow
    if (!row) return // 直传任务/未启用/已移除：幂等无操作
    task.cpRow = undefined // 置空即封口：在途/迟到的逐片回写（cpRow===row 复核）全部失效
    const store = this.checkpointStore!
    // 同步发起移除、不走 cpChain：终态落定处断点必须立即消失（不得晚于任何后续观察），
    // 且此后本任务不再有该行的写入（回写有 cpRow 复核），无「先 remove 后被回写插回」的乱序。
    void store.remove(row.fingerprint).catch(() => { /* 尽力而为 */ })
  }

  /** retry 前重建断点行：终态失败已 remove，但 uploadId/分片仍在任务现场（复用续传），恢复在库状态 */
  private checkpointRestore(task: Task): void {
    const store = this.checkpointStore
    const uploadId = task.uploadId
    if (!store || !uploadId || !task.parts) return // 直传项/已 abort 清理项无会话可恢复
    const now = Date.now()
    const row: UploadCheckpoint = {
      fingerprint: taskFingerprint(task),
      path: task.key,
      size: task.file.size,
      lastModified: task.file.lastModified,
      partSize: effectivePartSize(task.file.size, this.partSize, this.maxParts),
      uploadId,
      parts: [...task.parts.entries()].sort((a, b) => a[0] - b[0]).map(([number, etag]) => ({ number, etag })),
      createdAt: now,
      updatedAt: now,
    }
    task.cpRow = row
    // 执行时复核行仍存活：链排空窗口内若任务已被 discard（cpRow 置空），迟到的恢复写直接跳过，
    // 不在库里复活出一行死断点——兑现 checkpointDiscard「此后本任务不再有该行写入」的承诺
    this.cpEnqueue(task, async () => {
      if (task.cpRow === row) await store.put(row)
    })
  }

  /**
   * 断点候选探活：store.listAll × client.listMultipartUploads 交叉——uploadId 仍在服务端清单
   * → 续传候选；不在 → 死行就地 remove（complete/abort/过期残留）。listMultipartUploads 为
   * 可选能力：客户端未实现 → 返回 []（不误删）。列举失败同样保守返回 []（无法验证存活时不销毁断点）。
   */
  async resumeCheckpoints(): Promise<ResumeCandidate[]> {
    const store = this.checkpointStore
    const listMultipartUploads = this.client.listMultipartUploads
    if (!store || !listMultipartUploads) return []
    let uploads: { key: string; uploadId: string; initiated?: string }[]
    try {
      uploads = await listMultipartUploads.call(this.client)
    } catch {
      return [] // 探活失败：不动任何断点（避免把可续传行误判为死行）
    }
    // 按 (key, uploadId) 二元组建存活索引（uploadId 全局唯一，带 key 仅是防御性双保险）
    const alive = new Map<string, Set<string>>()
    for (const u of uploads) {
      const ids = alive.get(u.key) ?? new Set<string>()
      ids.add(u.uploadId)
      alive.set(u.key, ids)
    }
    const candidates: ResumeCandidate[] = []
    for (const row of await store.listAll()) {
      if (!alive.get(row.path)?.has(row.uploadId)) {
        await store.remove(row.fingerprint) // uploadId 已失效（完成/取消/过期）：死行清理
        continue
      }
      candidates.push({
        fingerprint: row.fingerprint,
        path: row.path,
        size: row.size,
        lastModified: row.lastModified,
        partSize: row.partSize,
        uploadId: row.uploadId,
        parts: [...row.parts], // 浅拷贝：防内存实现下消费者原地改动污染库内行
      })
    }
    return candidates
  }

  // ───────────────── M2 UI 接线口（Home resume 面包条消费；不调用=零影响） ─────────────────

  /**
   * 当前配置下该尺寸文件的自适应分片大小：供调用侧做 partSize 硬性校验（UI 波次契约/M2 评审
   * P2-3）——候选 partSize 是构造期冻结值，partSize/maxParts 配置变更后跨会话必漂移。
   */
  partSizeFor(size: number): number {
    return effectivePartSize(size, this.partSize, this.maxParts)
  }

  /**
   * 按 ResumeCandidate 续传入队（Home resume 面包条专用）：以候选 uploadId/已传分片直接建任务
   * 落池——runMultipart 见 uploadId 已存在即跳过 createMultipart，已落定分片按 partNumber 跳过，
   * 只补缺失分片；断点行就地重建（cpRow 指向候选行副本，后续分片成功照常回写，complete/终态
   * 照常移除，pause 保留语义不变）。
   * 入队前防御性复算指纹（与调用侧校验同构，双保险）：不匹配返回 null 不入队。
   * ext/size 拒收不在此复检：指纹一致即同名同 size，沿用首入队时的受理结论。
   */
  enqueueResume(file: File, candidate: ResumeCandidate): { id: string } | null {
    const fingerprint = sha256HexSync(FINGERPRINT_TE.encode(`${candidate.path}:${file.size}:${file.lastModified}`))
    if (fingerprint !== candidate.fingerprint) return null
    const task = this.newTask(file, candidate.path)
    task.uploadId = candidate.uploadId
    task.parts = new Map(candidate.parts.map(p => [p.number, p.etag]))
    task.fingerprint = candidate.fingerprint
    const now = Date.now()
    task.cpRow = {
      fingerprint: candidate.fingerprint,
      path: candidate.path,
      size: file.size,
      lastModified: file.lastModified,
      partSize: candidate.partSize,
      uploadId: candidate.uploadId,
      parts: [...candidate.parts], // 拷贝：候选行属调用侧（resumeCheckpoints 已浅拷贝防污染），cpRow 独立持有
      createdAt: now,
      updatedAt: now,
    }
    this.admit([{ task }])
    return { id: task.id }
  }

  /**
   * 放弃断点候选（Home 面包条「放弃」与 partSize 漂移整件重传两条路径共用）：
   * abortMultipart 销毁服务端分片会话 + remove 移除本地断点行（双清；abort 尽力而为，
   * 会话销毁失败仅剩服务端残留，交由 orphan-sweeper/桶生命周期兜底——与 abort 主链同口径）。
   */
  async discardCheckpoint(candidate: ResumeCandidate): Promise<void> {
    void this.client.abortMultipart(candidate.path, candidate.uploadId).catch(() => { /* 尽力清理 */ })
    await this.checkpointStore?.remove(candidate.fingerprint)
  }

  /** 并发池：开满 concurrency，任务终态/暂停落定后回填 */
  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()
      if (!task) continue
      task.inPending = false
      if (task.aborted || task.paused) continue // 排队中被取消/暂停的任务直接跳过
      this.active++
      task.status = 'uploading'
      void this.run(task).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async run(task: Task): Promise<void> {
    const { id, file, key } = task
    const contentType = file.type || 'application/octet-stream'
    try {
      if (task.aborted) throw this.abortedError(id)
      if (file.size <= this.threshold) {
        // 直传不受 M2 进度管理（params.onProgress 零回调）；装配层 hooks.onProgress 起止各报一次。
        // put 无中断通道——pause 只能标记，落定即 done（不谎报暂停）
        this.hooks.onProgress?.(id, 0, file.size)
        await this.client.put(key, file, contentType)
        if (task.aborted) throw this.abortedError(id) // put 不可中断，结束后丢弃
        this.hooks.onProgress?.(id, file.size, file.size)
      } else {
        await this.runMultipart(task, contentType)
        if (task.paused && !task.aborted) {
          task.status = 'paused' // 在途分片已清零的暂停落定：非终态，等 resume 重入（断点保留）
          return
        }
      }
      task.status = 'done'
      this.checkpointDiscard(task) // 完成=终态：断点使命结束，移除（直传项无断点，幂等）
      this.hooks.onDone?.(id, key)
    } catch (e) {
      if (task.paused && !task.aborted) {
        // 暂停期间在途分片失败也落 paused（非失败终态）：失败分片无 etag 记录，resume 自动补传
        task.status = 'paused'
        return // 断点保留：cpRow 存活，resume 后逐片回写续走
      }
      task.status = task.aborted ? 'aborted' : 'failed'
      // 取消语义优先：底层噪音（NoSuchUpload 等）不掩盖 UPLOAD_ABORTED
      const err = task.aborted ? this.abortedError(id) : asSdkError(e)
      task.errMsg = `(${err.code}) ${err.message}`
      if (task.aborted) this.cleanupMultipart(task) // 用户取消：服务端分片残留立即清理
      // 业务失败：uploadId/parts 保留（不 abort），retry(id) 复用续传——残留口径见文件头注
      this.checkpointDiscard(task) // 终态（取消/失败）移除断点；pause 落定已在上方 return，不至此
      this.hooks.onFailed?.(id, err)
    }
  }

  /**
   * multipart：create（续传时复用 task.uploadId）→ 分片并发≤2 → complete（partNumber 升序提交）。
   * 分片大小走自适应（effectivePartSize）：大文件抬高片长保证片数 ≤ maxParts；断点行记录同一值。
   */
  private async runMultipart(task: Task, contentType: string): Promise<void> {
    const { id, file, key } = task
    const total = file.size
    const partSize = effectivePartSize(total, this.partSize, this.maxParts)
    const partCount = Math.max(1, Math.ceil(total / partSize))
    if (!task.uploadId) {
      const { uploadId } = await this.client.createMultipart(key, contentType)
      task.uploadId = uploadId
      task.parts = new Map()
      // create 返回后再落断点行（此刻字段已齐全）：先于分片泵启动，cpChain 保序落行→逐片更新
      this.checkpointBegin(task, uploadId)
    }
    const uploadId = task.uploadId
    const etagByPart = (task.parts ??= new Map())
    if (task.aborted) throw this.abortedError(id)

    // 进度按已落定分片重算（续传/重试入口：进度从断点继续而非归零）
    let loaded = 0
    for (const n of etagByPart.keys()) loaded += partBytes(n, partSize, total)
    let nextPart = 1
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let inFlight = 0
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }
      const fail = (e: unknown): void => settle(() => reject(e))
      const finish = (): void =>
        settle(() => {
          if (task.aborted) reject(this.abortedError(id))
          else resolve()
        })
      const settleIfIdle = (): void => {
        if (settled || inFlight > 0) return
        finish()
      }
      const pump = (): void => {
        // paused/aborted 停止派发新分片（诚实口径：当前分片落定后停止调度后续分片）
        while (!settled && !task.paused && !task.aborted && inFlight < PART_CONCURRENCY && nextPart <= partCount) {
          const n = nextPart++
          if (etagByPart.has(n)) continue // 续传：已落定分片按 partNumber 跳过（uploadPart 幂等，无需重传）
          inFlight++
          this.uploadOne(task, uploadId, n, partSize).then(
            part => {
              inFlight--
              if (settled) return // 已失败/取消/暂停落定：迟到分片只丢弃
              etagByPart.set(part.partNumber, part.etag)
              loaded += part.bytes
              this.hooks.onProgress?.(id, loaded, total) // 每片必调，节流归调用侧
              this.onProgress?.({ bytes: loaded, total }) // 字节级进度：累计真实字节（末片截断精确）
              this.checkpointTouch(task, part.partNumber, part.etag) // 每片成功回写断点 parts
              settleIfIdle() // 暂停时不再续派：等在途清零即落定
              pump()
            },
            e => { inFlight--; fail(e) },
          )
        }
        settleIfIdle() // 终止路径：全部落定（完成/暂停清零）
      }
      pump()
    })

    if (task.paused && !task.aborted) return // run 落 paused，不 complete
    if (task.aborted) throw this.abortedError(id)
    const parts = [...etagByPart.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([partNumber, etag]) => ({ partNumber, etag }))
    await this.client.completeMultipart(key, uploadId, parts)
    task.uploadId = undefined
    task.parts = undefined
  }

  /**
   * 上传单个分片（含每片独立重试）：失败重试 ≤partRetry 次，指数退避间隔制——第 n 次重试
   * 前等待 base×2^(n-1) + 0~250ms 抖动（间隔 500/1000/2000…逐次拉开，attempt 逐次递增）。
   * 仅网络错/5xx/超时重试；4xx 语义错与取消码立即抛。暂停/取消立即让位
   * （含退避等待中），错误原样上抛由 run 按对应语义落定（paused 非失败 / aborted 取消码）。
   */
  private async uploadOne(task: Task, uploadId: string, partNumber: number, partSize: number) {
    const start = (partNumber - 1) * partSize
    const end = Math.min(start + partSize, task.file.size)
    for (let attempt = 0; ; attempt++) {
      try {
        const { etag } = await this.client.uploadPart(task.key, uploadId, partNumber, task.file.slice(start, end))
        return { partNumber, etag, bytes: end - start }
      } catch (e) {
        if (task.paused || task.aborted) throw e // 让位：不烧无谓退避（run 按 paused/aborted 落定）
        if (attempt >= this.partRetry || !isRetryablePartError(e)) throw e
        const backoff = this.partRetryBaseMs * 2 ** attempt + Math.random() * 250
        await sleep(backoff)
        if (task.paused || task.aborted) throw e // 退避期间被暂停/取消：立即让位
      }
    }
  }

  private abortedError(id: string): SdkError {
    return new SdkError(UPLOAD_ABORTED_CODE, '上传已取消', { id })
  }
}

const isTerminal = (s: UploadStatus): boolean => s === 'done' || s === 'failed' || s === 'aborted'

/** 第 n 片字节长度（末片截断） */
function partBytes(partNumber: number, partSize: number, total: number): number {
  const start = (partNumber - 1) * partSize
  return Math.min(start + partSize, total) - start
}

/** ≥ x 的最小 2 的幂（x ≤ 1 → 1；移位累乘避免 log2 浮点边界误差） */
function pow2ceil(x: number): number {
  let p = 1
  while (p < x) p *= 2
  return p
}

/**
 * 自适应分片大小（纯函数）：保证片数 ≤ maxParts 的最小 2 的幂分片，且不低于基础分片。
 * 例：effectivePartSize(25, 10, 10000)=10（小文件不缩片）；1TB/8MB 基片=131072 片 >10000
 * → 抬到 pow2ceil(1TB/10000)≈128MB。maxParts 缺省 10000。
 */
export function effectivePartSize(size: number, basePartSize: number, maxParts: number = DEFAULT_MAX_PARTS): number {
  return Math.max(basePartSize, pow2ceil(size / Math.max(1, maxParts)))
}

/** 断点指纹：sha256hex(`${key}:${size}:${lastModified}`)——mtime 取 File.lastModified（跨会话稳定可复算） */
function taskFingerprint(task: Task): string {
  return sha256HexSync(FINGERPRINT_TE.encode(`${task.key}:${task.file.size}:${task.file.lastModified}`))
}

/** SdkError.detail 中的 HTTP status（client 约定 detail={status}；形状不符 → undefined） */
function s3StatusOf(e: SdkError): number | undefined {
  const d = e.detail as { status?: unknown } | null | undefined
  return typeof d?.status === 'number' ? d.status : undefined
}

/**
 * 分片可重试判定（正向识别口径，识别不出=不可重试）：
 *  - TIMEOUT(4004)：调用侧超时 → 重试；
 *  - S3_ERROR(4101) 且 detail.status=0：client 标记的网络异常（fetch TypeError 包装）→ 重试；
 *  - S3_ERROR 且 status ≥ 500：服务端瞬时错误 → 重试；
 *  - 其余一律不重试：4xx 语义错（含 404 NoSuchUpload）、凭证错(4002/4003)、取消码 4901、
 *    以及无法从 detail 识别 status 的 S3_ERROR（保守不重试，避免把确定性失败拖成慢失败）。
 */
function isRetryablePartError(e: unknown): boolean {
  if (!(e instanceof SdkError)) return false
  if (e.code === ERROR_CODES.TIMEOUT) return true
  if (e.code !== ERROR_CODES.S3_ERROR) return false // 凭证/参数/取消（4901）等语义错：重试无意义
  const status = s3StatusOf(e)
  return status !== undefined && (status === 0 || status >= 500)
}

/** 退避等待（单片重试间）；到点后由调用方复核 paused/aborted 让位 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 扩展名归一化：去前导点 + 小写（'.EXE'/'exe'/'ExE' 等价） */
function normalizeExt(ext: string): string {
  return ext.trim().replace(/^\.+/, '').toLowerCase()
}

/** 取文件扩展名（小写）；无扩展名或 '.hidden' 形态返回 ''（不参与黑名单判定） */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** 前缀规范化：非空前补尾 '/'（'' 即 bucket 根） */
function normalizePrefix(p: string): string {
  if (p === '') return ''
  return p.endsWith('/') ? p : `${p}/`
}

/** SdkError 原样透传；其余包装为 S3_ERROR */
function asSdkError(e: unknown): SdkError {
  if (e instanceof SdkError) return e
  const msg = e instanceof Error ? e.message : String(e)
  return new SdkError(ERROR_CODES.S3_ERROR, msg === '' ? '上传失败' : msg, e)
}

/** 任务 id：jsdom 无 crypto.randomUUID，用单调计数 + 随机段兜底保证唯一 */
let idSeq = 0
function genId(): string {
  idSeq += 1
  return `up-${Date.now().toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
