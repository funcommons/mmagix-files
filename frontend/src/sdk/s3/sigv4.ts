/**
 * 浏览器内 AWS SigV4 签名（纯 WebCrypto，零三方依赖）
 * 依据《docs/design/solution-design.md》§4.3/§4.4：凭证不下发后端代理，前端对 S3 请求就地签名。
 * 关键性质：
 * - 签名确定性：同输入（含 nowMs）必得同输出
 * - clockOffsetMs：按 S3 响应 Date 头校准本机时钟偏差（observeServerDate）
 */
import type { S3Credentials } from '../types'

const TE = new TextEncoder()

/** 签名可接受请求体形态 */
export type SigV4Body = string | ArrayBuffer | Uint8Array | Blob

export interface SigV4Input {
  method: string
  /** 完整 URL；path 段与 query 值须已按 RFC3986 编码（用 encodeRfc3986 构造） */
  url: string
  /** 业务头（range / content-type / x-amz-copy-source…），全部参与签名 */
  headers?: Record<string, string>
  body?: SigV4Body
  /** true → 不算 payload 哈希，x-amz-content-sha256 用 UNSIGNED-PAYLOAD（大对象上传省 CPU） */
  unsignedPayload?: boolean
  credentials: S3Credentials
  region: string
  /** 默认 's3' */
  service?: string
  /** 本机时钟偏差（observeServerDate 校准值），叠加后生成 x-amz-date */
  clockOffsetMs?: number
  /** 注入当前时间 ms，缺省 Date.now()；测试确定性/重放断言用 */
  nowMs?: number
}

/**
 * 签名结果 = 可直接并入 fetch headers 的集合（键全小写）：
 * authorization / x-amz-date / x-amz-content-sha256 / x-amz-security-token(可选) + 调用方业务头。
 * host 只参与签名计算、不回传——浏览器 fetch 按 URL 自动携带，显式设置会被拒。
 */
export type SignedRequestHeaders = Record<string, string>

/** UTC basic 格式：yyyyMMdd'T'HHmmss'Z' */
export function formatAmzDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/** RFC3986 编码：保留 A-Z a-z 0-9 - _ . ~，'/' 一并编码（query 值用） */
export function encodeRfc3986(value: string): string {
  // encodeURIComponent 多放行 !'()*，按 AWS 要求补齐
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

function decodeRfc3986(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * §4.3 时钟偏移补偿：解析 S3 响应的 Date 头，返回 serverTime - localNow（ms）。
 * 结果存为 clockOffsetMs 传回 signRequest；Date 头非法返回 0（不校准）。
 */
export function observeServerDate(dateHeader: string, localNowMs: number = Date.now()): number {
  const serverMs = Date.parse(dateHeader.trim())
  return Number.isNaN(serverMs) ? 0 : serverMs - localNowMs
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return bufToHex(await crypto.subtle.digest('SHA-256', data as BufferSource))
}

function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let hex = ''
  for (const b of view) hex += b.toString(16).padStart(2, '0')
  return hex
}

async function hmacSha256(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const message = typeof data === 'string' ? (TE.encode(data) as BufferSource) : (data as BufferSource)
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message))
}

async function bodyBytes(body: SigV4Body | undefined): Promise<Uint8Array> {
  if (body === undefined) return new Uint8Array(0)
  if (typeof body === 'string') return TE.encode(body)
  // Blob 探测用鸭子类型（jsdom/跨 realm 下 instanceof 不可靠；Blob 读取后可复用）
  if (typeof (body as Blob).arrayBuffer === 'function') return new Uint8Array(await (body as Blob).arrayBuffer())
  return new Uint8Array(body as ArrayBuffer | Uint8Array) // ArrayBuffer/TypedArray → 字节视图
}

/** CanonicalQueryString：逐对解码后重编码再排序（参数名升序，同名按值升序；空值补 '='） */
function canonicalQuery(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  if (!raw) return ''
  const pairs = raw
    .split('&')
    .filter((p) => p.length > 0)
    .map((p) => {
      const eq = p.indexOf('=')
      const name = eq === -1 ? p : p.slice(0, eq)
      const value = eq === -1 ? '' : p.slice(eq + 1)
      return { name: encodeRfc3986(decodeRfc3986(name)), value: encodeRfc3986(decodeRfc3986(value)) }
    })
  pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  return pairs.map((p) => `${p.name}=${p.value}`).join('&')
}

export async function signRequest(input: SigV4Input): Promise<SignedRequestHeaders> {
  const service = input.service ?? 's3'
  const url = new URL(input.url)
  const amzDate = formatAmzDate((input.nowMs ?? Date.now()) + (input.clockOffsetMs ?? 0))

  // 1. 参与签名的头集合：host 取自 URL，业务头小写归一；host/authorization 不透传
  const headers: Record<string, string> = { host: url.host }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase()
    if (lower === 'host' || lower === 'authorization') continue
    headers[lower] = value
  }

  // 2. payload 哈希；x-amz-content-sha256 是 S3 专属头（其他 AWS 服务不签，官方 test-suite 亦无）
  const isS3 = service === 's3'
  const payloadHash = input.unsignedPayload
    ? 'UNSIGNED-PAYLOAD'
    : await sha256Hex(await bodyBytes(input.body))
  if (isS3) headers['x-amz-content-sha256'] = payloadHash
  headers['x-amz-date'] = amzDate
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken

  // 3. CanonicalHeaders / SignedHeaders（值 trim + 连续空白折叠，名升序）
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names
    .map((n) => `${n}:${(headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('')

  // 4. CanonicalRequest → StringToSign（S3 不做 path 规范化，直接用已编码 pathname）
  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname,
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${amzDate.slice(0, 8)}/${input.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(TE.encode(canonicalRequest)),
  ].join('\n')

  // 5. 派生密钥链：HMAC(AWS4+secret, date → region → service → 'aws4_request')
  let key = await hmacSha256(TE.encode(`AWS4${input.credentials.accessKeySecret}`), amzDate.slice(0, 8))
  key = await hmacSha256(key, input.region)
  key = await hmacSha256(key, service)
  key = await hmacSha256(key, 'aws4_request')
  const signature = bufToHex(await hmacSha256(key, stringToSign))

  // 6. 组装返回集：AWS 头 + Authorization + 调用方业务头（host 不回传）
  const out: SignedRequestHeaders = {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
  }
  if (isS3) out['x-amz-content-sha256'] = payloadHash
  if (input.credentials.sessionToken) out['x-amz-security-token'] = input.credentials.sessionToken
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'host' || name in out) continue
    out[name] = value
  }
  return out
}

// ───────────────────────── 同步 SHA-256 / HMAC-SHA256（presign 专用） ─────────────────────────

/**
 * 预签名 URL 契约为同步（S3Client.getPresignedUrl?(…): string），WebCrypto 全异步拿不到同步签名——
 * 内置最小纯 JS SHA-256/HMAC（零三方依赖，表驱动）；仅服务 presign 的小输入（规范化请求串），
 * 性能无关紧要；请求头签名路径（signRequest）仍走 WebCrypto 不动。
 * 正确性锚：RFC 6234 / RFC 4231 标准向量 + WebCrypto 跨实现互证（sigv4.test.ts）。
 */

/** SHA-256 轮常量（FIPS 180-4 §4.2.3） */
const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/** 纯 JS SHA-256（FIPS 180-4）；输入字节，输出 32 字节大端摘要 */
function sha256Bytes(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  // 填充：原数据 + 0x80 + 0×n + 8 字节大端位长，总长 ≡ 0 (mod 64)
  const totalLen = data.length + 9
  const bufLen = Math.ceil(totalLen / 64) * 64
  const buf = new Uint8Array(bufLen)
  buf.set(data)
  buf[data.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(bufLen - 8, Math.floor(data.length / 0x20000000)) // 位长高 32 位（length×8 ≫ 32）
  dv.setUint32(bufLen - 4, (data.length << 3) >>> 0)

  const w = new Uint32Array(64)
  for (let off = 0; off < bufLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!
      const y = w[i - 2]!
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + SHA_K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e
      e = (d + t1) >>> 0
      d = c; c = b; b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0
  }
  // 摘要按 FIPS 180-4 为大端字序：手动序列化（Uint8Array 视图在小端机会按字内反序，不能直接借用 buffer）
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]!)
  return out
}

/** 同步 SHA-256 → 小写 hex（presign 的规范化请求哈希用；测试对照 WebCrypto） */
export function sha256HexSync(data: Uint8Array): string {
  return bufToHex(sha256Bytes(data))
}

/**
 * 同步 HMAC-SHA256（RFC 2104）：key>64B 先哈希再补零；message 可为字符串（UTF-8）或字节。
 */
export function hmacSha256Sync(key: Uint8Array, message: string | Uint8Array): Uint8Array {
  let k = key
  if (k.length > 64) k = sha256Bytes(k)
  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  ipad.set(k)
  opad.set(k)
  for (let i = 0; i < 64; i++) {
    ipad[i] = ipad[i]! ^ 0x36
    opad[i] = opad[i]! ^ 0x5c
  }
  const msg = typeof message === 'string' ? TE.encode(message) : message
  const inner = new Uint8Array(64 + msg.length)
  inner.set(ipad)
  inner.set(msg, 64)
  const outer = new Uint8Array(64 + 32)
  outer.set(opad)
  outer.set(sha256Bytes(inner), 64)
  return sha256Bytes(outer)
}

// ───────────────────────── 查询串预签名（AWS Presigned URL） ─────────────────────────

export interface PresignInput {
  /** 默认 'GET' */
  method?: string
  /** 完整对象 URL；path 段须已按 RFC3986 编码（同 signRequest 口径），且不含查询串 */
  url: string
  /** 预签名有效期（秒）；AWS 硬上限 604800（7 天），钳制职责在调用方（client 对齐 TTL） */
  expiresSec: number
  credentials: S3Credentials
  region: string
  /** 默认 's3' */
  service?: string
  /** 本机时钟偏差（observeServerDate 校准值），叠加后生成 X-Amz-Date */
  clockOffsetMs?: number
  /** 注入当前时间 ms，缺省 Date.now()；测试确定性用（同 signRequest） */
  nowMs?: number
}

/**
 * 查询串 SigV4 预签名（AWS Presigned URL 口径，同步）：
 * 凭证全部进查询串（X-Amz-Algorithm/Credential/Date/Expires/Security-Token/SignedHeaders），
 * 请求头只签 host（SignedHeaders=host，host 仅参与 CanonicalHeaders、不出现在查询串），
 * payload 哈希按 AWS 预签名口径恒为 UNSIGNED-PAYLOAD，X-Amz-Signature 追加在查询串末尾。
 * 与 signRequest 的分工：后者签 fetch 头（Authorization），本函数产出可直接作
 * `<video>/<audio>/<img> src` 的 URL——浏览器原生请求（含 Range 拖动）无需 JS 参与。
 */
export function presignGet(input: PresignInput): string {
  const service = input.service ?? 's3'
  const url = new URL(input.url)
  const method = (input.method ?? 'GET').toUpperCase()
  const amzDate = formatAmzDate((input.nowMs ?? Date.now()) + (input.clockOffsetMs ?? 0))
  const scope = `${amzDate.slice(0, 8)}/${input.region}/${service}/aws4_request`

  // 1. 预签名参数（Signature 除外）：名值 RFC3986 编码后按名升序（CanonicalQueryString 口径）
  const pairs: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.max(1, Math.floor(input.expiresSec)))],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  if (input.credentials.sessionToken) pairs.push(['X-Amz-Security-Token', input.credentials.sessionToken])
  const canonicalQuery = pairs
    .map(([n, v]) => [encodeRfc3986(n), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([n, v]) => `${n}=${v}`)
    .join('&')

  // 2. CanonicalRequest → StringToSign（path 沿用已编码 pathname，S3 不规范化；SignedHeaders 仅 host）
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256HexSync(TE.encode(canonicalRequest)),
  ].join('\n')

  // 3. 派生密钥链（同 signRequest：HMAC(AWS4+secret, date → region → service → 'aws4_request')）
  let key = hmacSha256Sync(TE.encode(`AWS4${input.credentials.accessKeySecret}`), amzDate.slice(0, 8))
  key = hmacSha256Sync(key, input.region)
  key = hmacSha256Sync(key, service)
  key = hmacSha256Sync(key, 'aws4_request')
  const signature = bufToHex(hmacSha256Sync(key, stringToSign))

  // 4. 组装：Signature 不参与规范化，按 AWS 习惯追加在末尾
  const base = input.url.split('?')[0] ?? input.url
  return `${base}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/**
 * 预签名 PUT（Lane H-2 分享「上传链接」）：与 presignGet 完全同构，仅 method=PUT——
 * 持链者无需凭证即可向该 key 直传；同为 UNSIGNED-PAYLOAD 口径、无 content 头参与签名
 * （接收方自定 content-type）。PresignInput.method 本就开放参数，此处给具名出口，
 * 让调用方语义显式、与 presignGet 类型面对称（对称性由同构构造保证，见 presignPutUrl）。
 */
export function presignPut(input: PresignInput): string {
  return presignGet({ ...input, method: 'PUT' })
}
