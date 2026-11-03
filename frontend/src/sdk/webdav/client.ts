/**
 * WebDAV 客户端（M1 骨架）：PROPFIND / GET / PUT / HEAD / COPY / DELETE / MKCOL，implements S3Client 零破坏接入
 * 契约锚：《docs/design/webdav-support-design.md》§W1/W3（M1 骨架）/ §W2（M3 目录语义分流：MKCOL）
 * 错误映射（§W3 + 评审 A2 / M1-V1 裁决）：
 * - 401 → CREDENTIAL_INVALID(4002)（凭证无效；v1 遇 401 即判无效，不做 challenge 协商重试）
 * - 403 → S3_ERROR(4101)（资源级权限拒绝 ACL——WebDAV 世界 401/403 语义与 S3 正本相反，
 *   不得映射为凭证失效，否则「无权限删某文件」会被误报成需要重新连接）
 * - 409 → S3_ERROR(4101, detail={status, reason:'parent-missing'})（目标父 collection 缺失，
 *   主要命中 copy 场景；head 对 409 另有「不存在」特判，不走到此）
 * - 423 → S3_ERROR(4101, detail={status, reason:'locked'})（写锁冲突；v1 无 LOCK，仅只读冲突提示）
 * - 507 → S3_ERROR(4101, detail={status, reason:'quota'})（容量满）
 * - 其他非 2xx → S3_ERROR(4101, detail={status})；网络异常 → S3_ERROR(detail={status:0})
 * 分片上传（§W4 上传矩阵）：WebDAV 无标准 multipart——chunkedWrite=true 时以「旁路临时对象
 * 分块续写 + 完成时 MOVE 覆盖目标」实现四方法（multipartStrategy='content-range'；Nextcloud
 * chunked v2 同型，**非标 PUT Content-Range 追加口径**，无 RFC 标准可依）；缺省（'none'）四方法
 * 保持抛「未实现」防御，上传队列按整包 PUT 降级（§W4②）。
 * 六可选能力方法（presign×2/版本三方法/listMultipartUploads）不实现——门控面全部既有，自动隐藏。
 */
import { ERROR_CODES, SdkError } from '../errorCodes'
import type { FetchLike } from '../s3/client'
import type { S3Client, S3ListResult, S3ObjectSummary } from '../types'
import { parseMultistatus } from './parse'
import type { DavEntry } from './parse'

const TE = new TextEncoder()

/** 连接档案的 WebDAV 分支（§W6 向导字段）；凭证不进 URL/历史，仅走 Authorization 头 */
export interface WebDavBackendConfig {
  endpoint: string
  username?: string
  password?: string
  /** 会话根路径（挂载点下的子目录域，如 '/dav'）；缺省 ''=端点根 */
  rootPath?: string
  /**
   * 服务器家族开关（§W4①，types.ts WebDavBackend 同字段）：非标 PUT Content-Range 续写支持。
   * 缺省 false=安全降级整包（§W4②，无标准化写侧探测手段，known-good 清单随实机批次维护）。
   */
  chunkedWrite?: boolean
}

// ───────────────────────── 纯工具 ─────────────────────────

/** key 逐段 encodeURIComponent，'/' 作分隔符保留（§W3 编码口径） */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * rootPath 归一：缺省 ''、去尾斜杠、非空时强制 '/' 开头（拼接 endpoint 后才是合法 URL path），
 * 再逐段 encodeURIComponent（与 key 同一编码函数）。M1-V1 评审：rootPath 按未编码原文填写；
 * 逐段编码保证 objectPath 的 collectionPath 与请求 URL 恒为同一编码形态——parseMultistatus
 * 前缀剥离才能对齐，否则范围过滤会静默丢条目。
 */
function normalizeRootPath(rootPath: string): string {
  const trimmed = rootPath.replace(/\/+$/, '')
  if (trimmed === '') return ''
  return encodeKeyPath(trimmed.startsWith('/') ? trimmed : `/${trimmed}`)
}

/** HTTP 非 2xx → 统一 SdkError（§W3 错误映射；401/403 按协议差异分流评审 A2，409/423/507 语义 reason 见 M1-V1） */
function mapHttpError(status: number): SdkError {
  if (status === 401) {
    return new SdkError(ERROR_CODES.CREDENTIAL_INVALID, 'WebDAV 认证失败：用户名或密码无效', { status })
  }
  if (status === 403) {
    // 明确不是凭证失效（同构 types.ts:181 口径但 403 语义分流）：无权限 → 既有通用码 + detail
    return new SdkError(ERROR_CODES.S3_ERROR, 'WebDAV 拒绝访问：资源级权限不足（非凭证失效）', { status })
  }
  if (status === 409) {
    return new SdkError(ERROR_CODES.S3_ERROR, 'WebDAV 操作失败：目标父目录（collection）缺失', {
      status,
      reason: 'parent-missing',
    })
  }
  if (status === 423) {
    // detail 保持 {status} 形状约定（upload-queue s3StatusOf 取得到 status），reason 附语义
    return new SdkError(ERROR_CODES.S3_ERROR, 'WebDAV 资源被锁定（locked）', { status, reason: 'locked' })
  }
  if (status === 507) {
    return new SdkError(ERROR_CODES.S3_ERROR, 'WebDAV 存储容量已满（Insufficient Storage）', { status, reason: 'quota' })
  }
  return new SdkError(ERROR_CODES.S3_ERROR, `WebDAV 请求失败：HTTP ${status}`, { status })
}

/** §W4②：无分片能力（multipartStrategy='none'）时的统一拒绝（既有通用码，不新增协议错误码）。
 *  该路径为防御性：'none' 下上传队列已整包 PUT 降级，不会调用四方法。 */
function multipartUnsupported(): SdkError {
  return new SdkError(ERROR_CODES.S3_ERROR, 'WebDAV 分片上传未实现（chunkedWrite 未开启=整包 PUT 降级 §W4②；队列不会走到此路径）')
}

/** 末段名（目录先去尾斜杠；根名兜底为整段） */
function baseName(key: string): string {
  const trimmed = key.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** 目录段（末个 '/' 之前；根级文件无目录段=''）——temp 旁路键拼装用 */
function dirName(key: string): string {
  const i = key.lastIndexOf('/')
  return i === -1 ? '' : key.slice(0, i)
}

/**
 * §W4① content-range 分片的旁路临时键：`<dir>/.<basename>.<uploadId>.mmagix-part`
 * （根级文件无目录段时省略 '/' 前缀，避免键首出现 '/' 被 encodeKeyPath 编成 %2F）。
 * uploadId 编入 tempKey——服务端无 multipart 会话概念，跨会话/跨请求从 key+uploadId
 * 即可重构旁路对象地址（probe/abort 无需额外会话登记表）。
 */
function tempPartKey(key: string, uploadId: string): string {
  const dir = dirName(key)
  const name = `.${baseName(key)}.${uploadId}.mmagix-part`
  return dir === '' ? name : `${dir}/${name}`
}

/** uploadId 客户端合成：crypto.randomUUID 优先（jsdom/旧环境无此 API 时时间戳+随机数兜底） */
function genUploadId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now()}-${Math.random()}`
}

/** DavEntry → S3ObjectSummary；目录 key 追加 '/'——W2 裁决：collection 归一为既有「前缀」概念
 *  （可直接作下次 list 的 prefix），不落 0 字节标记对象 */
function toSummary(entry: DavEntry): S3ObjectSummary {
  return {
    key: entry.isDir ? `${entry.key}/` : entry.key,
    name: baseName(entry.key),
    size: entry.size,
    isDir: entry.isDir,
    lastModified: entry.lastModified,
  }
}

interface RequestOptions {
  headers?: Record<string, string>
  body?: Blob | ArrayBuffer
  /** 命中即原样返回不抛（get/head 的「不存在」是正常业务态，调用方据 res.status 判存在性） */
  tolerateStatus?: number[]
}

// ───────────────────────── 客户端 ─────────────────────────

export class WebDavClient implements S3Client {
  /** 目录语义声明（W2）：WebDAV 目录是 first-class collection——tree-store 的 mkdir/目录删除按此分流 */
  readonly directorySemantics = 'collection' as const

  /**
   * 分片策略声明（§W4 上传矩阵；types.ts S3Client 可选成员，上传队列判别消费）：
   * chunkedWrite 家族开关开启='content-range'（旁路临时对象分块续写）；缺省='none'
   * （无分片能力，队列整包 PUT 降级 §W4②）。
   */
  readonly multipartStrategy: 'content-range' | 'none'

  private readonly endpoint: string
  private readonly rootPath: string
  private readonly username?: string
  private readonly password?: string
  private readonly chunkedWrite: boolean
  private readonly fetcher: FetchLike

  /** fetcher 可注入（测试传桩；生产缺省包装全局 fetch 避免 this 丢失） */
  constructor(config: WebDavBackendConfig, fetcher: FetchLike = (...args) => fetch(...args)) {
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.rootPath = normalizeRootPath(config.rootPath ?? '')
    this.username = config.username
    this.password = config.password
    this.chunkedWrite = config.chunkedWrite === true
    this.multipartStrategy = config.chunkedWrite === true ? ('content-range' as const) : ('none' as const)
    this.fetcher = fetcher
  }

  // ── URL 组装 ──

  /** key → URL 路径：rootPath + 逐段编码 key（key 空 = rootPath 本身；'' 时为端点根） */
  private objectPath(key: string): string {
    const encoded = encodeKeyPath(key)
    return encoded === '' ? this.rootPath : `${this.rootPath}/${encoded}`
  }

  private objectUrl(key: string): string {
    return `${this.endpoint}${this.objectPath(key)}`
  }

  // ── 统一请求管道：认证 → fetch → 错误映射 ──

  /**
   * Basic 凭证：username 与 password 均非空才携带；非 Latin1 字符经 TextEncoder 转字节串再 btoa
   * （直 btoa 会抛 InvalidCharacterError）。
   * 半凭证口径（M1-V1）：只有 username 无 password 时不发 Authorization 且不支持——匿名请求对多数
   * 服务器 401 的语义会与「凭证无效」混淆；合法空密码账号由 M2 连接向导显式校验兜住。
   */
  private authHeader(): string | undefined {
    if (!this.username || !this.password) return undefined
    const bytes = TE.encode(`${this.username}:${this.password}`)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return `Basic ${btoa(binary)}`
  }

  private async request(method: string, url: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...opts.headers }
    const auth = this.authHeader()
    if (auth) headers.authorization = auth
    let res: Response
    try {
      res = await this.fetcher(url, { method, headers, body: opts.body })
    } catch (err) {
      throw new SdkError(ERROR_CODES.S3_ERROR, `WebDAV 网络请求失败：${(err as Error)?.message ?? String(err)}`, {
        status: 0,
      })
    }
    if (res.ok) return res
    if (opts.tolerateStatus?.includes(res.status)) return res
    throw mapHttpError(res.status)
  }

  // ── S3Client 接口实现（必选 11 方法 + W2 可选能力 directorySemantics/createDirectory）──

  /**
   * PROPFIND Depth:1（§W3：不依赖 Depth:infinity，树懒展开逐层）；continuationToken/delimiter
   * 忽略——WebDAV 无分页、目录天然分层。
   * 注释锚（M1-V1）：delimiter:'' 语义下 tree-store flatList 在 WebDAV 塌缩为 Depth:1——
   * M3 W2 分流时勿把 flatList 当递归列举复用（现靠 collection COPY/DELETE 递归语义兜底）。
   * 裁决（M1-V1）：PROPFIND 404（目录不存在）容忍 → 返回空列表，对齐 S3「列不存在 prefix =
   * 200 空结果」语义（M2 浏览接入不弹错误横幅）。
   */
  async list(prefix: string, _opts?: { continuationToken?: string; delimiter?: string }): Promise<S3ListResult> {
    const res = await this.request('PROPFIND', this.objectUrl(prefix), {
      headers: { depth: '1' },
      tolerateStatus: [404],
    })
    if (res.status === 404) return { prefix, dirs: [], files: [] }
    const entries = parseMultistatus(await res.text(), this.objectPath(prefix))
    // S3Client 全 key 契约（types.ts S3Client.list / s3/client.ts Contents.Key 原样含 prefix）：
    // parseMultistatus 产出的是剥了 collectionPath 的相对 key，此处把调用方 prefix 重拼回每个
    // entry key（prefix 缺尾 '/' 补上再拼；''=根列举天然不变），否则 preview.open 按相对 key
    // get 打根级 URL 404、applyChange 回流按相对 key upsertToBucket 把条目挂树根级。
    // 目录尾 '/' 仍由 toSummary 追加；name=baseName 对全 key 仍取末段，不受影响。
    // 相对 key 契约、startsWith 范围过滤、self 排除留在 parse 层，此处只改组装。
    const base = prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`
    const dirs: S3ObjectSummary[] = []
    const files: S3ObjectSummary[] = []
    for (const entry of entries) (entry.isDir ? dirs : files).push(toSummary({ ...entry, key: base + entry.key }))
    return { prefix, dirs, files }
  }

  /** 返回原始 Response（接口语义如此）；404 不抛（调用方据 res.status 判存在性，同 S3 实现口径） */
  async get(key: string, opts?: { rangeHeader?: string }): Promise<Response> {
    return this.request('GET', this.objectUrl(key), {
      headers: opts?.rangeHeader ? { range: opts.rangeHeader } : undefined,
      tolerateStatus: [404],
    })
  }

  async put(key: string, body: Blob | ArrayBuffer, contentType?: string): Promise<{ etag: string }> {
    const res = await this.request('PUT', this.objectUrl(key), {
      headers: contentType ? { 'content-type': contentType } : undefined,
      body,
    })
    return { etag: res.headers.get('etag') ?? '' }
  }

  /** HEAD：404=不存在；409=部分服务器对父 collection 缺失也回 409（§W3）→ 同判不存在 */
  async head(key: string): Promise<{ exists: boolean; size?: number; contentType?: string; etag?: string }> {
    const res = await this.request('HEAD', this.objectUrl(key), { tolerateStatus: [404, 409] })
    if (!res.ok) return { exists: false }
    const length = Number(res.headers.get('content-length') ?? '')
    return {
      exists: true,
      size: Number.isNaN(length) ? undefined : length,
      contentType: res.headers.get('content-type') ?? undefined,
      etag: res.headers.get('etag') ?? undefined,
    }
  }

  /** COPY：Destination 绝对 URI（评审裁决——部分服务器旧版只认绝对 URI，兼容面最大）+ Overwrite: T */
  async copy(from: string, to: string): Promise<void> {
    await this.request('COPY', this.objectUrl(from), {
      headers: { destination: `${this.endpoint}${this.objectPath(to)}`, overwrite: 'T' },
    })
  }

  /**
   * 逐 key DELETE（WebDAV 无批量删除）；collection 目标本体由 DELETE 递归删内部成员
   * （RFC 4918，W2 目录删除分流面）。
   * 容忍 404（M1-V1）：删除幂等，对齐 S3 批删语义——双标签页并发删除/队列重试时目标已消失不算错。
   */
  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.request('DELETE', this.objectUrl(key), { tolerateStatus: [404] })
    }
  }

  /**
   * MKCOL 逐级建目录（§W2 collection 语义；tree-store mkdir/renameDir 消费）：目录创建必须走
   * MKCOL（PUT 对 collection 路径非合法语义）。key 逐级拆段顺序 MKCOL（祖先链由顺序保证，
   * 父先于子）；405（RFC 4918：目标已存在）容忍继续=幂等（renameDir 补建链时已存在的中间
   * 目录不算错）；409（父缺失）顺序保证下不应发生，出现即照 mapHttpError 走 parent-missing
   * （异常态显式暴露，不静默吞）；末级成功即 resolve。key 尾 '/' 约定（目录 key 归一）在此
   * 无害剥除。
   * 语义局限注记（M3-V1）：同路径已有同名文件时，顶层 MKCOL 的 405 被容忍 → mkdir 静默成功
   * 但目录不出现（S3 侧同路径建出标记对象，两协议行为分叉，已知边界）；带子级时规范服务器
   * 对末级 MKCOL 回 409 → 显式抛错，无损坏面。
   */
  async createDirectory(key: string): Promise<void> {
    const segments = key.split('/').filter((seg) => seg !== '')
    let prefix = ''
    for (const seg of segments) {
      prefix = prefix === '' ? seg : `${prefix}/${seg}`
      await this.request('MKCOL', this.objectUrl(prefix), { tolerateStatus: [405] })
    }
  }

  // ── 分片上传（§W4 上传矩阵）：multipartStrategy 分流 ──
  // 'content-range'（chunkedWrite 开启）：旁路临时对象分块续写 + 完成时 MOVE 覆盖目标
  // （Nextcloud chunked v2 同型）——**不得直写目标路径**：中断残缺文件会直接对用户可见，
  // 且无服务器会话可 abort（§W4①）。'none'（缺省）：四方法抛「未实现」防御（上传队列已
  // 整包 PUT 降级，不会走到）。
  // 残留 temp 诚实注记（M4-V1 P2）：本客户端不实现 listMultipartUploads → orphan-sweeper
  // 对 WebDAV 空转，亦无 S3 桶生命周期规则——残留 temp（MOVE 失败/用户弃 retry）无自动
  // 清扫面；候补=以 PROPFIND 扫目标目录 `*.mmagix-part` 实现 listMultipartUploads（列 M4
  // 后候补工作项，届时孤儿清理门控自动启用）。


  /** 合成分片 uploadId（服务端无 multipart 会话概念，id 仅作旁路 temp 键的命名段） */
  async createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }> {
    if (!this.chunkedWrite) throw multipartUnsupported()
    void key
    // 旁路 temp 逐片 PUT 不携内容类型（MOVE 后目标沿用 temp 属性；v1 不做预置）
    void contentType
    return { uploadId: genUploadId() }
  }

  /**
   * 追加式分片 PUT（§W4① **非标口径**）：PUT 旁路 temp 键 + `Content-Range: bytes=-<size>`
   * =「追加末 N 字节」家族约定——HTTP Range 语义只为 GET 定义（RFC 9110 §14.2），写侧续写
   * 无 RFC 标准，known-good 清单随实机取证批次维护。
   * partNumber 形参不参与寻址（append 模型无片号概念，顺序由上传队列串行保证），签名保持
   * S3Client 接口一致；etag 取响应 ETag（部分服务器不回 → ''，completeMultipart 不消费）。
   */
  async uploadPart(key: string, uploadId: string, partNumber: number, body: Blob): Promise<{ etag: string }> {
    if (!this.chunkedWrite) throw multipartUnsupported()
    void partNumber
    const res = await this.request('PUT', this.objectUrl(tempPartKey(key, uploadId)), {
      headers: { 'content-range': `bytes=-${body.size}` },
      body,
    })
    return { etag: res.headers.get('etag') ?? '' }
  }

  /**
   * 完成=MOVE 旁路 temp → 目标键（Destination 绝对 URI + `Overwrite: T`，复用 copy 的头
   * 构造——部分服务器旧版只认绝对 URI，兼容面最大）。parts 空数组 → BAD_PARAM（0 字节文件
   * 走 ≤阈值整包路径，multipart 面不该有空 parts；显式拒防调用方误用）。
   * etags 忽略：append 模型无服务端装配概念，parts 仅作调用方完整性凭证。
   */
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    if (!this.chunkedWrite) throw multipartUnsupported()
    if (parts.length === 0) {
      throw new SdkError(ERROR_CODES.BAD_PARAM, 'completeMultipart：parts 为空（0 字节文件应走整包 PUT 路径）')
    }
    void parts
    await this.request('MOVE', this.objectUrl(tempPartKey(key, uploadId)), {
      headers: { destination: `${this.endpoint}${this.objectPath(key)}`, overwrite: 'T' },
    })
  }

  /** 取消=DELETE 旁路 temp（容忍 404：temp 已不存在即目标态达成，幂等） */
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    if (!this.chunkedWrite) throw multipartUnsupported()
    await this.request('DELETE', this.objectUrl(tempPartKey(key, uploadId)), { tolerateStatus: [404] })
  }

  /**
   * 续传探测（§W4①）：HEAD 旁路 temp → Content-Length=temp 当前字节面；404（temp 不存在）
   * → -1（409 同 head 口径容忍判不存在）。上传队列续传时以「返回值 === 已确认完整字节」
   * 裁决续传余片 vs 清残全量重传。'none' 策略下队列不会调用（无害保留：404 → -1）。
   */
  async probeUploadProgress(key: string, uploadId: string): Promise<number> {
    const res = await this.request('HEAD', this.objectUrl(tempPartKey(key, uploadId)), { tolerateStatus: [404, 409] })
    if (!res.ok) return -1
    // M4-V1 P2 硬化：缺 Content-Length 头不得折算 0（`Number('')===0`）——0 会与 confirmed=0
    // 的空候选误判「可续传」；无法实证字节面一律 -1（保守：走清残重传）
    const header = res.headers.get('content-length')
    if (header === null) return -1
    const length = Number(header)
    return Number.isNaN(length) ? -1 : length
  }

  // ── 可选能力方法（getPresignedUrl/presignPutUrl/getBucketVersioning/listObjectVersions/deleteVersion/listMultipartUploads）──
  // WebDavClient 全不实现（W1 缺省面）：回收站/历史版本/分享/直链/孤儿清理入口按既有能力门控自动隐藏
}
