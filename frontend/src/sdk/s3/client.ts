/**
 * S3 API 子集客户端（A3）：ListObjectsV2 / Get / Put / Head / Copy / DeleteObjects / Multipart
 * 依据《docs/design/solution-design.md》§4.4——前端用 BackendConfig 凭证 + sigv4.ts 就地签名直连 S3。
 * 错误映射（契约 §七）：
 * - 403 且 body 含 ExpiredToken/TokenExpired → CREDENTIAL_EXPIRED(4003)
 * - 其他 403/401 → CREDENTIAL_INVALID(4002)
 * - 其他非 2xx → S3_ERROR(4101, detail={status})；网络异常 → S3_ERROR(detail={status:0})
 */
import { ERROR_CODES, SdkError } from '../errorCodes'
import type {
  BackendConfig,
  DeleteMarkerRow,
  S3Client,
  S3ListResult,
  S3ObjectSummary,
  VersionListResult,
  VersionRow,
} from '../types'
import { encodeRfc3986, observeServerDate, presignGet, presignPut, signRequest } from './sigv4'
import type { SigV4Body } from './sigv4'

const TE = new TextEncoder()

/** 预签名默认有效期（秒）——单次浏览会话内够用，短于 STS TTL */
const DEFAULT_PRESIGN_EXPIRES_SEC = 3600
/** AWS 预签名硬上限（7 天）；TTL 未配置时对齐它 */
const AWS_MAX_PRESIGN_EXPIRES_SEC = 604800

/** 可注入的 fetch（测试传 vi.fn；生产用全局 fetch 包装避免 this 丢失） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

interface RequestOptions {
  headers?: Record<string, string>
  body?: SigV4Body
  /** true → 404 不视为错误（"对象不存在"是 get/head 的正常业务态） */
  tolerate404?: boolean
}

// ───────────────────────── 纯工具 ─────────────────────────

/** key 逐段 RFC3986 编码，'/' 作分隔符保留 */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/')
}

/** XML 文本内容转义（DeleteObjects/CompleteMultipart 请求体用） */
function xmlEscape(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)
}

function parseXml(text: string, status: number): Document {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new SdkError(ERROR_CODES.S3_ERROR, 'S3 响应 XML 解析失败', { status })
  }
  return doc
}

function textOf(scope: Document | Element, tag: string): string {
  return scope.getElementsByTagName(tag)[0]?.textContent?.trim() ?? ''
}

/** 首个匹配 tag 的子元素文本 → epoch ms；缺失/非法返回 undefined */
function dateMsOf(scope: Element, tag: string): number | undefined {
  const text = textOf(scope, tag)
  if (!text) return undefined
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? undefined : ms
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** HTTP 非 2xx → 统一 SdkError（§七错误映射） */
function mapHttpError(status: number, bodyText: string): SdkError {
  if (status === 403 || status === 401) {
    // STS 临时凭证过期：S3 以 403 + ExpiredToken/TokenExpired 表达（§4.3）
    const expired = /ExpiredToken|TokenExpired/i.test(bodyText)
    return new SdkError(
      expired ? ERROR_CODES.CREDENTIAL_EXPIRED : ERROR_CODES.CREDENTIAL_INVALID,
      expired ? 'S3 凭证已过期' : 'S3 拒绝访问（凭证无效或权限不足）',
      { status },
    )
  }
  const s3Code = /<Code>([^<]+)<\/Code>/.exec(bodyText)?.[1]
  return new SdkError(ERROR_CODES.S3_ERROR, `S3 请求失败：HTTP ${status}${s3Code ? `（${s3Code}）` : ''}`, { status })
}

const CRC_TABLE = /* 逐位反射 CRC-32 表 */ (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/**
 * CRC-32 → base64。DeleteObjects 在真实 S3 上强制要求完整性校验头，
 * 浏览器无法算 MD5（WebCrypto 不提供），按 AWS 现行口径改用 x-amz-checksum-crc32。
 */
export function crc32Base64(data: Uint8Array): string {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  c = (c ^ 0xffffffff) >>> 0
  let binary = ''
  for (const shift of [24, 16, 8, 0]) binary += String.fromCharCode((c >>> shift) & 0xff)
  return btoa(binary)
}

// ───────────────────────── 客户端 ─────────────────────────

/** 目录条目：key 保留结尾 '/'（直接可作为下次 list 的 prefix），name 为末段 */
function toDir(prefix: string): S3ObjectSummary {
  const trimmed = prefix.replace(/\/+$/, '')
  return { key: prefix, name: trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed, size: 0, isDir: true }
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1) || key
}

export class S3SigV4Client implements S3Client {
  private readonly endpoint: string
  private readonly bucket: string
  private readonly region: string
  /** v1.1 起可热替换（setCredentials 命令）；签名按请求时点读取现值 */
  private credentials: BackendConfig['credentials']
  /** 会话 TTL（秒）；预签名有效期上限对齐它（URL 不比凭证活得久） */
  private readonly ttlSeconds?: number
  /** §4.3 时钟偏移（observeServerDate 校准值），签名时叠加到本机时间 */
  private clockOffsetMs = 0
  private readonly fetcher: FetchLike

  /** config 取 BackendConfig 形状对象（结构类型：endpoint/region/bucket/credentials） */
  constructor(config: BackendConfig, fetcher: FetchLike = (...args) => fetch(...args)) {
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.bucket = config.bucket
    this.region = config.region
    this.credentials = config.credentials
    this.ttlSeconds = config.ttlSeconds
    this.fetcher = fetcher
  }

  /**
   * v1.1（setCredentials 命令）：热替换会话凭证——下一请求即用新值，在途请求不受影响（各自签名时点已定）。
   * 只换凭证不碰 endpoint/bucket/prefix 域语义。
   */
  setCredentials(credentials: BackendConfig['credentials']): void {
    this.credentials = credentials
  }

  /** §4.3：拿到 S3 响应后按 Date 头校准时钟，后续签名自动携带偏移 */
  calibrateClock(res: Response): void {
    const date = res.headers.get('date')
    if (date) this.clockOffsetMs = observeServerDate(date)
  }

  // ── URL 组装 ──

  private objectUrl(key: string): string {
    return `${this.endpoint}/${this.bucket}/${encodeKeyPath(key)}`
  }

  private bucketUrl(query?: string): string {
    return query ? `${this.endpoint}/${this.bucket}?${query}` : `${this.endpoint}/${this.bucket}`
  }

  // ── 统一请求管道：签名 → fetch → 错误映射 ──

  private async request(method: string, url: string, opts: RequestOptions = {}): Promise<Response> {
    const signed = await signRequest({
      method,
      url,
      headers: opts.headers,
      body: opts.body,
      credentials: this.credentials,
      region: this.region,
      clockOffsetMs: this.clockOffsetMs,
    })
    let res: Response
    try {
      // SigV4Body 均为合法 BodyInit；显式收窄（TS DOM lib 的 BufferSource 泛型口径不一致）
      res = await this.fetcher(url, { method, headers: signed, body: opts.body as BodyInit })
    } catch (err) {
      throw new SdkError(ERROR_CODES.S3_ERROR, `S3 网络请求失败：${(err as Error)?.message ?? String(err)}`, { status: 0 })
    }
    if (res.ok) return res
    if (opts.tolerate404 && res.status === 404) return res
    throw mapHttpError(res.status, await safeText(res))
  }

  // ── S3Client 接口实现 ──

  async list(prefix: string, opts: { continuationToken?: string; delimiter?: string } = {}): Promise<S3ListResult> {
    const query = [
      'list-type=2',
      `prefix=${encodeRfc3986(prefix)}`,
      `delimiter=${encodeRfc3986(opts.delimiter ?? '/')}`,
      ...(opts.continuationToken ? [`continuation-token=${encodeRfc3986(opts.continuationToken)}`] : []),
    ].join('&')
    const res = await this.request('GET', this.bucketUrl(query))
    const doc = parseXml(await res.text(), res.status)

    const dirs: S3ObjectSummary[] = []
    for (const el of Array.from(doc.getElementsByTagName('CommonPrefixes'))) {
      const p = textOf(el, 'Prefix')
      if (p) dirs.push(toDir(p))
    }

    const files: S3ObjectSummary[] = []
    for (const el of Array.from(doc.getElementsByTagName('Contents'))) {
      const key = textOf(el, 'Key')
      if (!key) continue
      const size = Number(textOf(el, 'Size') || '0')
      // 目录标记对象（'xx/' 零字节）→ 归入 dirs（与 CommonPrefixes 去重），不进 files
      if (key.endsWith('/') && size === 0) {
        const marker = toDir(key)
        if (!dirs.some((d) => d.key === marker.key)) dirs.push(marker)
        continue
      }
      files.push({
        key,
        name: baseName(key),
        size,
        isDir: false,
        lastModified: dateMsOf(el, 'LastModified'),
      })
    }

    const truncated = textOf(doc, 'IsTruncated').toLowerCase() === 'true'
    const nextToken = textOf(doc, 'NextContinuationToken')
    return {
      prefix,
      dirs,
      files,
      continuationToken: truncated && nextToken ? nextToken : undefined,
    }
  }

  /** 返回原始 Response；404 不抛（调用方据 res.status 判存在性） */
  async get(key: string, opts: { rangeHeader?: string } = {}): Promise<Response> {
    return this.request('GET', this.objectUrl(key), {
      headers: opts.rangeHeader ? { range: opts.rangeHeader } : undefined,
      tolerate404: true,
    })
  }

  async put(key: string, body: Blob | ArrayBuffer, contentType?: string): Promise<{ etag: string }> {
    const res = await this.request('PUT', this.objectUrl(key), {
      headers: contentType ? { 'content-type': contentType } : undefined,
      body,
    })
    return { etag: res.headers.get('etag') ?? '' }
  }

  async head(key: string): Promise<{ exists: boolean; size?: number; contentType?: string; etag?: string }> {
    const res = await this.request('HEAD', this.objectUrl(key), { tolerate404: true })
    if (res.status === 404) return { exists: false }
    const length = Number(res.headers.get('content-length') ?? '')
    return {
      exists: true,
      size: Number.isNaN(length) ? undefined : length,
      contentType: res.headers.get('content-type') ?? undefined,
      etag: res.headers.get('etag') ?? undefined,
    }
  }

  /** 服务端复制（x-amz-copy-source：/bucket/源key，源路径逐段编码）；fromVersionId=恢复历史版本（copy-source 带 ?versionId=） */
  async copy(from: string, to: string, opts?: { fromVersionId?: string }): Promise<void> {
    const srcVersion = opts?.fromVersionId ? `?versionId=${encodeRfc3986(opts.fromVersionId)}` : ''
    await this.request('PUT', this.objectUrl(to), {
      headers: { 'x-amz-copy-source': `/${this.bucket}/${encodeKeyPath(from)}${srcVersion}` },
    })
  }

  /**
   * DeleteObjects 批量删除：POST /bucket?delete。
   * Key 在 XML 内保留原文（仅 XML 转义，与 aws-sdk-js 行为一致）；附 CRC32 完整性头。
   * 部分失败（200 + DeleteResult/Error 项）→ 抛 S3_ERROR，detail 携失败清单。
   */
  async remove(keys: string[]): Promise<void> {
    const body = `<Delete>${keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')}<Quiet>true</Quiet></Delete>`
    const res = await this.request('POST', this.bucketUrl('delete'), {
      body,
      headers: { 'content-type': 'application/xml', 'x-amz-checksum-crc32': crc32Base64(TE.encode(body)) },
    })
    const doc = parseXml(await res.text(), res.status)
    const errors = Array.from(doc.getElementsByTagName('Error')).map((el) => ({
      key: textOf(el, 'Key'),
      code: textOf(el, 'Code'),
      message: textOf(el, 'Message'),
    }))
    if (errors.length > 0) {
      throw new SdkError(
        ERROR_CODES.S3_ERROR,
        `S3 批量删除存在失败项：${errors.map((e) => `${e.key}(${e.code})`).join(', ')}`,
        { status: res.status, errors },
      )
    }
  }

  async createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const res = await this.request('POST', `${this.objectUrl(key)}?uploads`, {
      headers: contentType ? { 'content-type': contentType } : undefined,
    })
    const doc = parseXml(await res.text(), res.status)
    const uploadId = textOf(doc, 'UploadId')
    if (!uploadId) throw new SdkError(ERROR_CODES.S3_ERROR, 'CreateMultipartUpload 响应缺少 UploadId', { status: res.status })
    return { uploadId }
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Blob): Promise<{ etag: string }> {
    const res = await this.request('PUT', `${this.objectUrl(key)}?partNumber=${partNumber}&uploadId=${encodeRfc3986(uploadId)}`, { body })
    return { etag: res.headers.get('etag') ?? '' }
  }

  /**
   * POST /key?uploadId=…，请求体 <CompleteMultipartUpload> 按 partNumber 升序组装。
   * S3 该接口可能以 200 返回错误体，需检查 body。
   */
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
    const body = `<CompleteMultipartUpload>${sorted
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`
    const res = await this.request('POST', `${this.objectUrl(key)}?uploadId=${encodeRfc3986(uploadId)}`, {
      body,
      headers: { 'content-type': 'application/xml' },
    })
    const text = await safeText(res)
    if (text.includes('<Error>')) {
      throw new SdkError(ERROR_CODES.S3_ERROR, `S3 分片上传完成失败：${text}`, { status: res.status })
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.request('DELETE', `${this.objectUrl(key)}?uploadId=${encodeRfc3986(uploadId)}`)
  }

  // ── v1.2 版本管理（回收站/版本历史/孤儿 uploadId 清理）──

  /** GET ?versioning：桶版本控制状态；无 <Status>（未配置版本控制）= 'Disabled' */
  async getBucketVersioning(): Promise<'Enabled' | 'Suspended' | 'Disabled'> {
    const res = await this.request('GET', this.bucketUrl('versioning'))
    const status = textOf(parseXml(await res.text(), res.status), 'Status')
    return status === 'Enabled' ? 'Enabled' : status === 'Suspended' ? 'Suspended' : 'Disabled'
  }

  /**
   * GET ?versions：版本 + 删除标记混排，按 Version/DeleteMarker 子项分拣。
   * IsLatest 文本→布尔、LastModified→epoch ms、Size→数值；分页标记仅 isTruncated 时透出。
   */
  async listObjectVersions(
    opts: { prefix?: string; keyMarker?: string; versionIdMarker?: string; maxKeys?: number } = {},
  ): Promise<VersionListResult> {
    const query = [
      'versions',
      ...(opts.prefix ? [`prefix=${encodeRfc3986(opts.prefix)}`] : []),
      ...(opts.keyMarker ? [`key-marker=${encodeRfc3986(opts.keyMarker)}`] : []),
      ...(opts.versionIdMarker ? [`version-id-marker=${encodeRfc3986(opts.versionIdMarker)}`] : []),
      ...(opts.maxKeys !== undefined ? [`max-keys=${opts.maxKeys}`] : []),
    ].join('&')
    const res = await this.request('GET', this.bucketUrl(query))
    const doc = parseXml(await res.text(), res.status)

    const versions: VersionRow[] = []
    for (const el of Array.from(doc.getElementsByTagName('Version'))) {
      const key = textOf(el, 'Key')
      if (!key) continue
      versions.push({
        key,
        versionId: textOf(el, 'VersionId'),
        isLatest: textOf(el, 'IsLatest').toLowerCase() === 'true',
        lastModified: dateMsOf(el, 'LastModified'),
        size: Number(textOf(el, 'Size') || '0'),
      })
    }

    const deleteMarkers: DeleteMarkerRow[] = []
    for (const el of Array.from(doc.getElementsByTagName('DeleteMarker'))) {
      const key = textOf(el, 'Key')
      if (!key) continue
      deleteMarkers.push({
        key,
        versionId: textOf(el, 'VersionId'),
        isLatest: textOf(el, 'IsLatest').toLowerCase() === 'true',
        lastModified: dateMsOf(el, 'LastModified'),
      })
    }

    const truncated = textOf(doc, 'IsTruncated').toLowerCase() === 'true'
    const nextKeyMarker = textOf(doc, 'NextKeyMarker')
    const nextVersionIdMarker = textOf(doc, 'NextVersionIdMarker')
    return {
      versions,
      deleteMarkers,
      isTruncated: truncated,
      nextKeyMarker: truncated && nextKeyMarker ? nextKeyMarker : undefined,
      nextVersionIdMarker: truncated && nextVersionIdMarker ? nextVersionIdMarker : undefined,
    }
  }

  /** DELETE /{key}?versionId=…：删 DeleteMarker 即「恢复」、带版本号即彻底删除；2xx 即成功（无响应体） */
  async deleteVersion(key: string, versionId: string): Promise<void> {
    await this.request('DELETE', `${this.objectUrl(key)}?versionId=${encodeRfc3986(versionId)}`)
  }

  /**
   * GET ?uploads：进行中的分片上传（Initiated 按 ISO 字符串透传，不转数值）。
   * 内部循环翻页聚合至 IsTruncated=false——单页默认 1000 条，静默截断会让上游
   * （orphan-sweeper / resumeCheckpoints）把仍在清单外的活断点误判为孤儿而误删，不可逆。
   * 翻页标记：NextKeyMarker/NextUploadIdMarker → key-marker/upload-id-marker（从上一页尾项之后续列）。
   */
  async listMultipartUploads(): Promise<{ key: string; uploadId: string; initiated?: string }[]> {
    const uploads: { key: string; uploadId: string; initiated?: string }[] = []
    let truncated = true
    let keyMarker: string | undefined
    let uploadIdMarker: string | undefined
    do {
      const query = [
        'uploads',
        ...(keyMarker !== undefined ? [`key-marker=${encodeRfc3986(keyMarker)}`] : []),
        ...(uploadIdMarker !== undefined ? [`upload-id-marker=${encodeRfc3986(uploadIdMarker)}`] : []),
      ].join('&')
      const res = await this.request('GET', this.bucketUrl(query))
      const doc = parseXml(await res.text(), res.status)
      for (const el of Array.from(doc.getElementsByTagName('Upload'))) {
        const key = textOf(el, 'Key')
        if (!key) continue
        uploads.push({ key, uploadId: textOf(el, 'UploadId'), initiated: textOf(el, 'Initiated') || undefined })
      }
      truncated = textOf(doc, 'IsTruncated').toLowerCase() === 'true'
      keyMarker = textOf(doc, 'NextKeyMarker') || undefined
      uploadIdMarker = textOf(doc, 'NextUploadIdMarker') || undefined
      // IsTruncated=true 但响应缺翻页标记（非标实现）→ 防御性终止（宁少列，不可死循环）
      if (truncated && keyMarker === undefined && uploadIdMarker === undefined) break
    } while (truncated)
    return uploads
  }

  /**
   * 预签名 GET URL（S3Client 可选能力，查询串 SigV4）。
   * 同步契约 → sigv4.presignGet（纯 JS SHA-256，WebCrypto 无同步面）；零网络请求。
   * 有效期：默认 3600s；上限对齐会话 TTL 语义（config.ttlSeconds，未配置对齐 AWS 7 天硬上限）——
   * 预签名 URL 不应比凭证活得久，越界必然 403。
   * nowMs 仅测试注入（与 signRequest 同口径）；clockOffsetMs 走 §4.3 校准值。
   * extraQuery 追加进签名查询串的业务参数（versionId/partNumber/response-content-disposition 等场景），不传=行为逐字节不变。
   */
  getPresignedUrl(key: string, expiresSec?: number, nowMs?: number, extraQuery?: Record<string, string>): string {
    return this.presignedUrl('GET', key, expiresSec, nowMs, extraQuery)
  }

  /**
   * 预签名 PUT URL（S3Client 可选能力；Lane H-2 分享对话框「上传链接」——
   * 对方无需凭证即可向该 key 直传）。与 getPresignedUrl 完全同构：
   * 同默认 3600s / 同 TTL 钳制 / 同 clockOffset 校准 / 同 key 逐段编码，仅 method=PUT。
   * extraQuery 追加进签名查询串的业务参数（uploadId/partNumber 等分片直传场景），不传=行为逐字节不变。
   */
  presignPutUrl(key: string, expiresSec?: number, nowMs?: number, extraQuery?: Record<string, string>): string {
    return this.presignedUrl('PUT', key, expiresSec, nowMs, extraQuery)
  }

  /** 预签名统一口（GET/PUT 同构收口）：有效期钳制与参数组装仅此一份，两出口零复制 */
  private presignedUrl(
    method: 'GET' | 'PUT',
    key: string,
    expiresSec?: number,
    nowMs?: number,
    extraQuery?: Record<string, string>,
  ): string {
    const cap = Math.min(this.ttlSeconds ?? AWS_MAX_PRESIGN_EXPIRES_SEC, AWS_MAX_PRESIGN_EXPIRES_SEC)
    const requested = Math.max(1, Math.floor(expiresSec ?? DEFAULT_PRESIGN_EXPIRES_SEC))
    const presign = method === 'GET' ? presignGet : presignPut
    return presign({
      url: this.objectUrl(key),
      expiresSec: Math.min(requested, Math.max(1, Math.floor(cap))),
      credentials: this.credentials,
      region: this.region,
      clockOffsetMs: this.clockOffsetMs,
      ...(nowMs !== undefined ? { nowMs } : {}),
      ...(extraQuery ? { extraQuery } : {}),
    })
  }
}
