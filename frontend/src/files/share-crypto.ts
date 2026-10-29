/**
 * 分享密码信封（v1.2.0 M5，契约：documents/v1.2.0执行进度.md §「M5 契约」；威胁模型：
 * documents/v1.2.0升级方案-断点上传-分享增强-在线解压-回收站.md §5.2）。
 *
 * meta 对象（shares/<shareId>.json）不含明文预签名 URL，只存 AES-GCM-256 密文 + KDF 参数；
 * 「密码校验=解密成功」——GCM auth tag 保证错密码必然解密失败，无需单独存 hash，
 * 无哈希可比对攻击面。
 *
 * 职责切分（修订契约 seal-then-assemble）：密码学面只有 sealShareSecret / openShareSecret
 * 一条 WebCrypto 链（async）；buildShareMeta 是纯组装——恒同步、零内嵌密码学，由调用方
 * 先 seal 再把 sealed 三元组（blob/iv/kdf）原样透传进 meta，零二次加工。
 *
 * 环境要点：crypto.subtle 一律经 globalCrypto() 现取——禁止模块顶层解构/捕获
 * （jsdom 下顶层捕获到的是空 subtle，测试以 vi.stubGlobal 注入 node:crypto.webcrypto，
 * 顶层捕获会永远拿到空值）。
 */

// ───────────────────────── 契约 ─────────────────────────

/** 分享 meta 对象（shares/<shareId>.json 的内容，v1 冻结形状） */
export interface ShareMetaV1 {
  /** 形状版本 */
  v: 1
  /** 分享目标对象 key */
  key: string
  /** 展示文件名 */
  name: string
  /** 文件大小（字节，仅展示用） */
  size: number
  /** 创建时间（ms 时间戳） */
  createdAt: number
  /** 过期时间（ms 时间戳，now ≥ expiresAt 即过期） */
  expiresAt: number
  /** KDF 参数（salt=b64）：开封时按此重建密钥 */
  kdf: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string }
  /** AES-GCM-256 密文 b64（尾部含 128bit auth tag；明文=对象预签名 GET URL） */
  blob: string
  /** 12B iv b64 */
  iv: string
}

/** buildShareMeta 入参（sealed=sealShareSecret 的产物，原样透传） */
export interface BuildShareMetaInput {
  /** 分享目标对象 key */
  key: string
  /** 展示文件名 */
  name: string
  /** 文件大小（字节） */
  size: number
  /** 已密封三元组（sealShareSecret 返回值，原样透传，零二次加工） */
  sealed: { blob: string; iv: string; kdf: ShareMetaV1['kdf'] }
  /** 有效期毫秒，缺省 24h（方案 §5.3 档位 1h/24h/7d 的中间档） */
  ttlMs?: number
  /** 当前时间戳，缺省 Date.now() */
  now?: number
}

// ───────────────────────── base64url 编解码（URL 安全：无 + / =） ─────────────────────────

const B64U_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 字符码 → 6bit 值查表（表外一律 -1：含标准 base64 的 '+' '/'、'=' 与一切非法字符） */
const B64U_LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1)
  for (let i = 0; i < B64U_ALPHABET.length; i++) t[B64U_ALPHABET.charCodeAt(i)] = i
  return t
})()

/** URL 安全 base64 编码（无 padding；空输入 → 空串） */
export function toB64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    const b1 = has1 ? bytes[i + 1]! : 0
    const b2 = has2 ? bytes[i + 2]! : 0
    out += B64U_ALPHABET[b0 >>> 2]
    out += B64U_ALPHABET[((b0 & 0x03) << 4) | (b1 >>> 4)]
    if (has1) out += B64U_ALPHABET[((b1 & 0x0f) << 2) | (b2 >>> 6)]
    if (has2) out += B64U_ALPHABET[b2 & 0x3f]
  }
  return out
}

/**
 * URL 安全 base64 解码。非法字符与结构非法长度一律抛错（对齐 window.atob 对非法
 * 输入抛 InvalidCharacterError 的常见实现）。对标准 base64 的互操作容忍仅限其
 * 「padding 部分」：尾部至多 2 个 '='；'+' '/' 字母表不支持（本模块恒 URL-safe
 * 产出，二者在查表中即 -1 抛错）。
 */
export function fromB64Url(s: string): Uint8Array {
  // 剥离尾部 padding（仅末尾 1-2 个 '='；中间/开头的 '=' 走查表 -1 抛错）
  let end = s.length
  let pad = 0
  while (end > 0 && pad < 2 && s.charCodeAt(end - 1) === 61 /* '=' */) {
    end--
    pad++
  }
  const body = end === s.length ? s : s.slice(0, end)
  if (body.length === 0 && s.length > 0) throw new Error('base64url 输入为纯 padding')
  // 去 padding 后剩 1 字符属结构非法（6bit 不足 1 字节）
  if (body.length % 4 === 1) throw new Error(`base64url 长度非法（去 padding 后 ${body.length} 字符）`)
  const out = new Uint8Array((body.length * 3) >> 2)
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    const v = code < 128 ? B64U_LOOKUP[code]! : -1
    if (v < 0) throw new Error(`base64url 含非法字符：${JSON.stringify(body[i])}`)
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
    }
  }
  return out
}

// ───────────────────────── 随机源（全局 crypto 现取，见文件头「禁止顶层捕获」） ─────────────────────────

/** 全局 crypto 现取（每个调用点重新读 globalThis——stub/环境切换即时生效） */
function globalCrypto(): Crypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('全局 crypto（WebCrypto）不可用：需浏览器环境或以 node:crypto.webcrypto 顶替')
  return c
}

/** n 字节密码学随机（本模块单次用量 ≤ 16B，远低于 getRandomValues 的 65536B 上限） */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalCrypto().getRandomValues(out)
  return out
}

// ───────────────────────── 随机标识 ─────────────────────────

/** 分享 id：16B 随机 → 22 字符 base64url，不可枚举（直接用作 shares/<id>.json 对象名） */
export function randomShareId(): string {
  return toB64Url(randomBytes(16))
}

/** 无歧义密码字符集：字母数字去除 0O1lI（57 字符） */
const PASSWORD_CHARS = 'abcdefghijkmnopqrstuvwxyz' + 'ABCDEFGHJKLMNPQRSTUVWXYZ' + '23456789'

/**
 * 随机密码（默认 6 位）。57 不整除 256 → 拒绝采样（值 ≥ 57*4=228 重抽）后取模，防偏。
 */
export function randomPassword(len: number = 6): string {
  let out = ''
  while (out.length < len) {
    const buf = randomBytes(len)
    for (const b of buf) {
      if (b >= PASSWORD_CHARS.length * 4) continue
      out += PASSWORD_CHARS[b % PASSWORD_CHARS.length]
      if (out.length === len) break
    }
  }
  return out
}

// ───────────────────────── WebCrypto 链（sealShareSecret / openShareSecret） ─────────────────────────

/** PBKDF2 默认轮数（契约钉死 100000） */
const DEFAULT_ITERATIONS = 100_000
const SALT_LEN = 16
const IV_LEN = 12
const KEY_BITS = 256

/**
 * PBKDF2 轮数下限：低于此值的信封可低成本暴破（弱信封）；且 WebCrypto 会把小数
 * 轮数截断为整数轮（如 1.9 → 1 轮）而 meta 记载原值，账实不符——故下限同时拦
 * 「过小整数」与「小数」，非法一律抛错不静默放行。
 */
export const KDF_MIN_ITERATIONS = 1000

/**
 * openShareSecret（面对不可信 meta）的轮数上界：KDF 轮数超大时单次 derive 即可
 * 占死访客 tab 数秒至数十秒（DoS 面），解密前先拦。
 */
const KDF_MAX_ITERATIONS = 10_000_000

/** openShareSecret（面对不可信 meta）的密文字节上界：fromB64Url 对超大串会直接分配数百 MB 内存 */
const BLOB_MAX_BYTES = 10 * 1024 * 1024

/** blob 的 base64 字符数预检上限（字节数上限 × 4/3 上取整）——超限直接抛错，不进 fromB64Url 白白分配内存 */
const BLOB_MAX_B64_LEN = Math.ceil((BLOB_MAX_BYTES * 4) / 3)

/** password → AES-GCM-256 CryptoKey：PBKDF2-SHA256 deriveBits(256) → importKey */
async function deriveAesGcmKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = globalCrypto().subtle
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, KEY_BITS)
  return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * 密封：PBKDF2-SHA256（iterations 轮 + 随机 16B salt）→ AES-GCM-256（随机 12B iv）。
 * iterations 设下限（KDF_MIN_ITERATIONS）：低于下限=可暴破的弱信封；小数会被
 * WebCrypto 截断为整数轮、meta 记载与实际轮数账实不符——非法一律抛错。
 */
export async function sealShareSecret(
  plaintext: string,
  password: string,
  opts?: { iterations?: number },
): Promise<{ blob: string; iv: string; kdf: ShareMetaV1['kdf'] }> {
  if (typeof password !== 'string' || !password) throw new Error('密码不能为空')
  const iterations = opts?.iterations ?? DEFAULT_ITERATIONS
  // 封开对称：seal 侧同守 open 侧轮数上界，iterations 误配在创建时即暴露（而非访客页 open 才拒）
  if (!Number.isSafeInteger(iterations) || iterations < KDF_MIN_ITERATIONS || iterations > KDF_MAX_ITERATIONS) {
    throw new Error(
      `iterations 非法：须为 ${KDF_MIN_ITERATIONS} ~ ${KDF_MAX_ITERATIONS} 的安全整数，实际为 ${iterations}`,
    )
  }
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = await deriveAesGcmKey(password, salt, iterations)
  const cipher = await globalCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  )
  return {
    blob: toB64Url(new Uint8Array(cipher)),
    iv: toB64Url(iv),
    kdf: { alg: 'PBKDF2-SHA256', iterations, salt: toB64Url(salt) },
  }
}

/**
 * 开封：错密码/密文篡改/iv 篡改 → WebCrypto GCM decrypt 原生 reject（auth tag 校验
 * 失败）。「密码校验=解密成功」语义本体——不 catch、不转换，rejection 原样上抛。
 *
 * 解密前对不可信 meta（访客页可直接取到 shares/<id>.json）做 sanity 校验：
 * iterations ∈ [KDF_MIN_ITERATIONS, KDF_MAX_ITERATIONS]（超上界=占死访客 tab）、
 * salt 恰 16B、iv 恰 12B、blob 解码后 16B（GCM tag 最小面）~ BLOB_MAX_BYTES
 * （防超大串解码直接分配数百 MB）——任一不满足抛错，不进 WebCrypto。
 */
export async function openShareSecret(
  blob: string,
  iv: string,
  kdf: ShareMetaV1['kdf'],
  password: string,
): Promise<string> {
  if (typeof password !== 'string' || !password) throw new Error('密码不能为空')
  if (kdf.alg !== 'PBKDF2-SHA256') throw new Error(`不支持的 KDF 算法：${kdf.alg}`)
  const { iterations } = kdf
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < KDF_MIN_ITERATIONS ||
    iterations > KDF_MAX_ITERATIONS
  ) {
    throw new Error(
      `kdf.iterations 非法：须为 ${KDF_MIN_ITERATIONS} ~ ${KDF_MAX_ITERATIONS} 的安全整数，实际为 ${iterations}`,
    )
  }
  const salt = fromB64Url(kdf.salt)
  if (salt.length !== SALT_LEN) {
    throw new Error(`kdf.salt 非法：解码后须恰 ${SALT_LEN} 字节，实际为 ${salt.length} 字节`)
  }
  const ivBytes = fromB64Url(iv)
  if (ivBytes.length !== IV_LEN) {
    throw new Error(`iv 非法：解码后须恰 ${IV_LEN} 字节，实际为 ${ivBytes.length} 字节`)
  }
  // 先按字符数预检再解码：超限串不进 fromB64Url，避免先分配数百 MB 再发现超界
  if (blob.length > BLOB_MAX_B64_LEN) {
    throw new Error(`blob 超长：解码后须 ≤ ${BLOB_MAX_BYTES} 字节（base64 串 ${blob.length} 字符）`)
  }
  const blobBytes = fromB64Url(blob)
  if (blobBytes.length < 16 /* GCM auth tag 128bit = 密文最小面 */ || blobBytes.length > BLOB_MAX_BYTES) {
    throw new Error(
      `blob 长度非法：解码后须为 16 ~ ${BLOB_MAX_BYTES} 字节，实际为 ${blobBytes.length} 字节`,
    )
  }
  const key = await deriveAesGcmKey(password, salt, iterations)
  const plain = await globalCrypto().subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    blobBytes as BufferSource,
  )
  return new TextDecoder().decode(plain)
}

// ───────────────────────── meta 组装与过期判断 ─────────────────────────

/** 默认有效期：24h（契约钉死 86400_000） */
const DEFAULT_TTL_MS = 86_400_000

/**
 * 组装 meta 对象（纯组装，恒同步、零内嵌密码学）：v=1、key/name/size 直传，
 * sealed 三元组（blob/iv/kdf）原样透传，expiresAt=now+ttlMs。调用方先 sealShareSecret
 * 再入参（seal-then-assemble）。
 */
export function buildShareMeta(input: BuildShareMetaInput): ShareMetaV1 {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
  return {
    v: 1,
    key: input.key,
    name: input.name,
    size: input.size,
    createdAt: now,
    expiresAt: now + ttlMs,
    kdf: input.sealed.kdf,
    blob: input.sealed.blob,
    iv: input.sealed.iv,
  }
}

/** 是否过期：now ≥ expiresAt 即过期（恰等于边界算过期——到期时刻不再放行）；now 缺省取 Date.now() */
export function isShareExpired(meta: ShareMetaV1, now?: number): boolean {
  return (now ?? Date.now()) >= meta.expiresAt
}
