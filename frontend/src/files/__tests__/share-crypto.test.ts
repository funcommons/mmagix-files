/**
 * share-crypto 契约红测试（v1.2.0 M5：分享密码信封，契约先行）。
 *
 * 被测模块 src/files/share-crypto.ts 尚未实现——本文件钉住契约
 * （docs/design/capabilities-contract-v1.2.0.md §「M5 契约」；威胁模型见方案 §5.2）：
 *  - randomShareId：16B 随机 → base64url 22 字符不可枚举；
 *  - randomPassword：默认 6 位无歧义字符集（去 0O1lI）；
 *  - toB64Url/fromB64Url：URL 安全 base64url 编解码往返（非法输入钉死为抛错，见对应用例注释）；
 *  - sealShareSecret/openShareSecret：PBKDF2-SHA256（默认 100000 轮 + 16B salt）→ AES-GCM-256（12B iv）；
 *    「密码校验=解密成功」语义本体——错密码/密文篡改/iv 篡改必须 reject（GCM auth tag）；
 *  - buildShareMeta：meta 对象纯组装（seal-then-assemble 修订契约：恒同步、零内嵌密码学，
 *    密码学只发生在 sealShareSecret；blob 明文=对象预签名 GET URL）；isShareExpired：now≥expiresAt 即过期；
 *  - 评审守卫（R1）：弱 KDF（<1000 轮/小数）与空密码拒绝密封、openShareSecret 对不可信
 *    meta 的 sanity 校验（轮数上界防 DoS/salt 16B/iv 12B/blob 超长预检）、下限恰 1000 放行。
 *
 * 环境要点：vitest jsdom 下 `crypto.subtle` 不可用（jsdom 的 Crypto 无 subtle）——
 * 统一以 node:crypto 的 webcrypto 顶替全局 crypto（beforeEach/afterEach 管理），
 * 并以首个用例前置钉住「顶替源 subtle 可用 + stub 已生效」，避免用例层误报。
 *
 * 性能预算：PBKDF2 100k 轮单例 ≈100-300ms——默认轮次全程只碰 2 次（默认 seal 元数据与
 * 往返共享同一次 seal 结果）；buildShareMeta 四用例按修订契约共享一次 1000 轮 seal，
 * 其余用例一律 iterations=1000（低轮次仅测试提速，GCM 语义与轮次无关）。
 */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildShareMeta,
  fromB64Url,
  isShareExpired,
  openShareSecret,
  randomPassword,
  randomShareId,
  sealShareSecret,
  toB64Url,
} from '../share-crypto'
import type { ShareMetaV1 } from '../share-crypto'

// ───────────────────────── 环境桩：jsdom 无 subtle，统一顶替全局 crypto ─────────────────────────

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('前置钉住：顶替源 webcrypto.subtle 可用，且 stub 已进全局（jsdom 原生 Crypto 无 subtle）', () => {
  // 顶替源本身必须带可用 subtle——若此断言先红说明 node 环境异常，后续用例的失败不可信
  expect(typeof webcrypto.subtle.digest).toBe('function')
  // beforeEach 的 stub 必须真实生效（seal/open 走全局 crypto）
  expect(globalThis.crypto).toBe(webcrypto as unknown as Crypto)
})

// ───────────────────────── 测试常量与懒共享夹具（控制 100k 轮次数） ─────────────────────────

/** 演示密码（默认 6 位量级，无歧义字符集内） */
const PASSWORD = 'k7Rm2x'

/** 明文=对象预签名 GET URL（契约：blob 明文即此），覆盖长 query + 中文参数 + + / = 等保留字符 */
const PLAINTEXT_URL =
  'https://s3.test/bucket/docs/%E6%8A%A5%E5%91%8A.pdf' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=AKID%2F20261029%2Fus-east-1%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20261029T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host' +
  `&X-Amz-Signature=${'e'.repeat(64)}&文件名=报告+终稿%2Fv2==`

type Sealed = Awaited<ReturnType<typeof sealShareSecret>>

/** 默认轮次（100k）seal 结果：首次在用例内触发（此时全局 crypto 已被 stub），之后各用例共享 */
let defaultSealP: Promise<Sealed> | undefined
const sharedDefaultSeal = (): Promise<Sealed> =>
  (defaultSealP ??= sealShareSecret(PLAINTEXT_URL, PASSWORD))

/** 1000 轮 seal 结果（拒绝路径/篡改用例共享，开销可忽略） */
let fastSealP: Promise<Sealed> | undefined
const sharedFastSeal = (): Promise<Sealed> =>
  (fastSealP ??= sealShareSecret(PLAINTEXT_URL, PASSWORD, { iterations: 1000 }))

/** buildShareMeta 四用例共享的 seal 结果（1000 轮，开销可忽略；seal-then-assemble：组装本身零密码学） */
let metaSealedP: Promise<Sealed> | undefined
const sharedMetaSealed = (): Promise<Sealed> =>
  (metaSealedP ??= sealShareSecret(PLAINTEXT_URL, PASSWORD, { iterations: 1000 }))

/** 独立于被测模块的 base64url 编解码（node Buffer）——篡改用例不依赖被测编解码的正确性 */
const b64uFlipFirst = (b64: string): string => {
  const buf = Buffer.from(b64, 'base64url')
  buf[0] = buf[0]! ^ 0xff
  return buf.toString('base64url')
}

/** 字段齐全的合法 meta 形状（isShareExpired 纯函数用，不关心 kdf/blob 内容真伪） */
const mkMeta = (over: Partial<ShareMetaV1> = {}): ShareMetaV1 => ({
  v: 1,
  key: 'docs/report.pdf',
  name: 'report.pdf',
  size: 102400,
  createdAt: 1_730_000_000_000,
  expiresAt: 1_730_000_000_000 + 86_400_000,
  kdf: { alg: 'PBKDF2-SHA256', iterations: 100_000, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
  blob: 'AAAA',
  iv: 'AAAAAAAAAAAAAAAA',
  ...over,
})

// ───────────────────────── randomShareId ─────────────────────────

describe('randomShareId', () => {
  it('16B 随机 → 22 字符 base64url（无 + / = padding）', () => {
    const id = randomShareId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('连抽 8 枚互不相同（128bit 随机性，不可枚举）', () => {
    const ids = Array.from({ length: 8 }, () => randomShareId())
    expect(new Set(ids).size).toBe(8)
  })

  it('可 fromB64Url 解回 16 字节', () => {
    expect(fromB64Url(randomShareId()).length).toBe(16)
  })
})

// ───────────────────────── randomPassword ─────────────────────────

describe('randomPassword', () => {
  it('默认 6 位', () => {
    expect(randomPassword()).toHaveLength(6)
  })

  it('字符集无歧义：仅字母数字且不含 0O1lI（连抽 60 枚=360 字符全扫描）', () => {
    const all = Array.from({ length: 60 }, () => randomPassword()).join('')
    // 无歧义红线：0O1lI 一个都不许出现
    expect(/[0O1lI]/.test(all)).toBe(false)
    for (const ch of all) expect(ch).toMatch(/^[a-zA-Z0-9]$/)
    // 防退化为常量串：57 字符集抽 360 字符，集合大小 ≥40 概率天文级接近 1（不做精确断言）
    expect(new Set(all).size).toBeGreaterThanOrEqual(40)
  })

  it('自定义 len=12 生效', () => {
    expect(randomPassword(12)).toHaveLength(12)
  })
})

// ───────────────────────── toB64Url / fromB64Url ─────────────────────────

describe('toB64Url / fromB64Url', () => {
  it('空数组：toB64Url 为空串，fromB64Url 空串解回空', () => {
    expect(toB64Url(new Uint8Array(0))).toBe('')
    expect(fromB64Url('')).toEqual(new Uint8Array(0))
  })

  it('256B 全随机往返等值', () => {
    const bytes = new Uint8Array(256)
    webcrypto.getRandomValues(bytes)
    expect(fromB64Url(toB64Url(bytes))).toEqual(bytes)
  })

  it('含 0xFF 等极端字节往返等值', () => {
    const bytes = Uint8Array.from([0x00, 0xff, 0xfb, 0xff, 0xbf, 0x01])
    expect(fromB64Url(toB64Url(bytes))).toEqual(bytes)
  })

  it('URL 安全：强制产生 + / 的字节与 1B 需 padding 的场景均不含 + / =', () => {
    // 0xfb,0xff,0xbf 的标准 base64 首四码为 "+/+/"；单字节标准 base64 需 "==" padding
    for (const bytes of [Uint8Array.from([0xfb, 0xff, 0xbf]), Uint8Array.from([0xff])]) {
      const s = toB64Url(bytes)
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/)
      expect(s).not.toMatch(/[+/=]/)
      expect(fromB64Url(s)).toEqual(bytes)
    }
  })

  it("fromB64Url('!!') 非法输入：钉死为抛错（契约未定死，选对齐 window.atob 对非法字符抛 InvalidCharacterError 的常见实现；实现侧若改选容错须回头改此断言）", () => {
    expect(() => fromB64Url('!!')).toThrow()
  })
})

// ───────────────────────── sealShareSecret ─────────────────────────

describe('sealShareSecret', () => {
  it('默认参数元数据：kdf.alg=PBKDF2-SHA256 / iterations=100000 / salt 16B / iv 12B / blob 非空', async () => {
    const { blob, iv, kdf } = await sharedDefaultSeal()
    expect(kdf.alg).toBe('PBKDF2-SHA256')
    expect(kdf.iterations).toBe(100_000)
    expect(fromB64Url(kdf.salt).length).toBe(16)
    expect(fromB64Url(iv).length).toBe(12)
    expect(blob.length).toBeGreaterThan(0)
  })

  it('同密码两次 seal：salt、iv、blob 均不同（随机性）', async () => {
    const a = await sealShareSecret(PLAINTEXT_URL, PASSWORD, { iterations: 1000 })
    const b = await sealShareSecret(PLAINTEXT_URL, PASSWORD, { iterations: 1000 })
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.blob).not.toBe(b.blob)
  })
})

// ───────────────────────── openShareSecret 正确路径 ─────────────────────────

describe('openShareSecret 正确密码', () => {
  it('1000 轮 seal→open 往返等值（短 ASCII）', async () => {
    const sealed = await sealShareSecret('hello-share', PASSWORD, { iterations: 1000 })
    await expect(openShareSecret(sealed.blob, sealed.iv, sealed.kdf, PASSWORD)).resolves.toBe(
      'hello-share',
    )
  })

  it('明文=预签名 URL（长 query+中文+保留字符）往返等值', async () => {
    const sealed = await sharedFastSeal()
    await expect(openShareSecret(sealed.blob, sealed.iv, sealed.kdf, PASSWORD)).resolves.toBe(
      PLAINTEXT_URL,
    )
  })

  it('默认 100000 轮 seal→open 往返等值（共享 seal 结果）', async () => {
    const sealed = await sharedDefaultSeal()
    await expect(openShareSecret(sealed.blob, sealed.iv, sealed.kdf, PASSWORD)).resolves.toBe(
      PLAINTEXT_URL,
    )
  })
})

// ───────────────────────── openShareSecret 拒绝路径（密码校验=解密成功，红线本体） ─────────────────────────

describe('openShareSecret 拒绝路径', () => {
  it('错密码必须 reject（GCM auth tag 失败——「密码校验=解密成功」语义本体）', async () => {
    const sealed = await sharedFastSeal()
    await expect(openShareSecret(sealed.blob, sealed.iv, sealed.kdf, 'wr0ng-pw')).rejects.toThrow()
  })

  it('近似密码（仅末字符不同）同样 reject', async () => {
    const sealed = await sharedFastSeal()
    await expect(
      openShareSecret(sealed.blob, sealed.iv, sealed.kdf, PASSWORD.slice(0, -1) + 'Y'),
    ).rejects.toThrow()
  })

  it('密文翻转 1 字节 → reject（篡改检测；编解码用 node Buffer，不依赖被测 codec 正确性）', async () => {
    const sealed = await sharedFastSeal()
    await expect(
      openShareSecret(b64uFlipFirst(sealed.blob), sealed.iv, sealed.kdf, PASSWORD),
    ).rejects.toThrow()
  })

  it('iv 篡改 1 字节 → reject', async () => {
    const sealed = await sharedFastSeal()
    await expect(
      openShareSecret(sealed.blob, b64uFlipFirst(sealed.iv), sealed.kdf, PASSWORD),
    ).rejects.toThrow()
  })
})

// ───────────────────────── iterations 自定义 ─────────────────────────

describe('iterations 自定义', () => {
  it('opts.iterations=1000 生效（kdf.iterations=1000）且用该 kdf 可解开', async () => {
    const sealed = await sealShareSecret(PLAINTEXT_URL, PASSWORD, { iterations: 1000 })
    expect(sealed.kdf.iterations).toBe(1000)
    await expect(openShareSecret(sealed.blob, sealed.iv, sealed.kdf, PASSWORD)).resolves.toBe(
      PLAINTEXT_URL,
    )
  })
})

// ───────────────────────── buildShareMeta ─────────────────────────

describe('buildShareMeta（修订契约：seal-then-assemble 纯组装，恒同步、零内嵌密码学）', () => {
  it('字段组装：v=1，key/name/size 直传，createdAt=now，expiresAt=now+ttlMs，sealed 三元组原样透传', async () => {
    const sealed = await sharedMetaSealed()
    const meta = buildShareMeta({
      key: 'docs/report.pdf',
      name: 'report.pdf',
      size: 102400,
      sealed,
      ttlMs: 3_600_000,
      now: 1_730_000_000_000,
    })
    expect(meta.v).toBe(1)
    expect(meta.key).toBe('docs/report.pdf')
    expect(meta.name).toBe('report.pdf')
    expect(meta.size).toBe(102400)
    expect(meta.createdAt).toBe(1_730_000_000_000)
    expect(meta.expiresAt).toBe(1_730_000_000_000 + 3_600_000)
    // seal-then-assemble 本体：blob/iv/kdf 原样透传（零二次加工=零内嵌密码学）
    expect(meta.blob).toBe(sealed.blob)
    expect(meta.iv).toBe(sealed.iv)
    expect(meta.kdf).toEqual(sealed.kdf)
    expect(meta.kdf.alg).toBe('PBKDF2-SHA256')
    expect(fromB64Url(meta.kdf.salt).length).toBe(16)
    expect(fromB64Url(meta.iv).length).toBe(12)
    expect(meta.blob.length).toBeGreaterThan(0)
  })

  it('blob 可用密码经 openShareSecret 解开且等于 plaintext（WebCrypto seal→组装→WebCrypto open 全链互通）', async () => {
    const sealed = await sharedMetaSealed()
    const meta = buildShareMeta({
      key: 'docs/report.pdf',
      name: 'report.pdf',
      size: 102400,
      sealed,
    })
    await expect(openShareSecret(meta.blob, meta.iv, meta.kdf, PASSWORD)).resolves.toBe(
      PLAINTEXT_URL,
    )
  })

  it('ttlMs 缺省 → 24h（契约未给默认值，实现侧定 86400_000，此处钉死；方案 §5.3 有效期档 1h/24h/7d）', async () => {
    const sealed = await sharedMetaSealed()
    const meta = buildShareMeta({
      key: 'a.txt',
      name: 'a.txt',
      size: 1,
      sealed,
      now: 1_730_000_000_000,
    })
    expect(meta.expiresAt - meta.createdAt).toBe(86_400_000)
  })

  it('now 缺省 → 取 Date.now()（createdAt 落在调用前后沿之间）', async () => {
    const sealed = await sharedMetaSealed()
    const t0 = Date.now()
    const meta = buildShareMeta({ key: 'a.txt', name: 'a.txt', size: 1, sealed })
    const t1 = Date.now()
    expect(meta.createdAt).toBeGreaterThanOrEqual(t0)
    expect(meta.createdAt).toBeLessThanOrEqual(t1)
    expect(meta.expiresAt - meta.createdAt).toBe(86_400_000)
  })
})

// ───────────────────────── isShareExpired ─────────────────────────

describe('isShareExpired', () => {
  const CREATED = 1_730_000_000_000
  const EXPIRES = CREATED + 3_600_000

  it('now < expiresAt → 未过期（false）', () => {
    expect(isShareExpired(mkMeta({ createdAt: CREATED, expiresAt: EXPIRES }), EXPIRES - 1)).toBe(
      false,
    )
  })

  it('now ≥ expiresAt → 已过期（true），恰等于边界也算过期', () => {
    expect(isShareExpired(mkMeta({ createdAt: CREATED, expiresAt: EXPIRES }), EXPIRES)).toBe(true)
    expect(isShareExpired(mkMeta({ createdAt: CREATED, expiresAt: EXPIRES }), EXPIRES + 1)).toBe(
      true,
    )
  })

  it('now 缺省取 Date.now()：已到期的过去 meta 为 true，未来 meta 为 false', () => {
    expect(isShareExpired(mkMeta({ expiresAt: Date.now() - 1_000 }))).toBe(true)
    expect(isShareExpired(mkMeta({ expiresAt: Date.now() + 60_000 }))).toBe(false)
  })
})

// ───────────────────────── 评审守卫（R1：弱 KDF/空密码/不可信 meta 的 DoS 面） ─────────────────────────

describe('评审守卫（R1）', () => {
  it('① sealShareSecret 弱 KDF 拒绝：iterations=1 / 小数 1.9 → throw（信息含 iterations 与下界 1000）', async () => {
    // 过小整数：可低成本暴破的弱信封
    await expect(sealShareSecret('x', PASSWORD, { iterations: 1 })).rejects.toThrow(
      /iterations.*1000/s,
    )
    // 小数：WebCrypto 截断为整数轮而 meta 记载原值，账实不符
    await expect(sealShareSecret('x', PASSWORD, { iterations: 1.9 })).rejects.toThrow(
      /iterations.*1000/s,
    )
  })

  it('② openShareSecret 恶意 meta DoS 面四连拦（校验先行，不进 WebCrypto、不预分配大内存）', async () => {
    // 轮数超上界（10_000_000）：单次 derive 占死访客 tab 数秒至数十秒
    await expect(
      openShareSecret('AAAA', 'AAAAAAAAAAAAAAAA', mkMeta({ kdf: { alg: 'PBKDF2-SHA256', iterations: 10_000_001, salt: 'AAAAAAAAAAAAAAAAAAAAAA' } }).kdf, PASSWORD),
    ).rejects.toThrow(/iterations.*10000000/s)
    // salt 解码 17B（须恰 16B）
    await expect(
      openShareSecret('AAAA', 'AAAAAAAAAAAAAAAA', mkMeta({ kdf: { alg: 'PBKDF2-SHA256', iterations: 1000, salt: Buffer.alloc(17).toString('base64url') } }).kdf, PASSWORD),
    ).rejects.toThrow(/salt.*16.*17/s)
    // iv 解码 11B（须恰 12B）
    await expect(
      openShareSecret('AAAA', Buffer.alloc(11).toString('base64url'), mkMeta().kdf, PASSWORD),
    ).rejects.toThrow(/iv.*12.*11/s)
    // blob 超长（1400 万字符 > 10MB 解码上界的 b64 预检线）：字符数预检直接拦，不进 fromB64Url 分配数百 MB
    await expect(
      openShareSecret('A'.repeat(14_000_001), 'AAAAAAAAAAAAAAAA', mkMeta().kdf, PASSWORD),
    ).rejects.toThrow(/超长/)
  })

  it('③ 空密码双侧拒绝：seal/open 均抛「密码不能为空」（seal 侧守在加密前，open 侧守在 KDF 前）', async () => {
    await expect(sealShareSecret('x', '')).rejects.toThrow('密码不能为空')
    await expect(openShareSecret('AAAA', 'AAAAAAAAAAAAAAAA', mkMeta().kdf, '')).rejects.toThrow(
      '密码不能为空',
    )
  })

  it('④ floor 边界放行：iterations=1000 恰好等于下界 → seal/open 全链成功（守卫不误伤）', async () => {
    const sealed = await sealShareSecret(PLAINTEXT_URL, PASSWORD, { iterations: 1000 })
    expect(sealed.kdf.iterations).toBe(1000)
    await expect(openShareSecret(sealed.blob, sealed.iv, sealed.kdf, PASSWORD)).resolves.toBe(
      PLAINTEXT_URL,
    )
  })

  it('⑤ seal 上界对称：iterations=10000001 → rejects（区间语义）——封开对称，误配创建时即暴露', async () => {
    // open 侧同上界已由 ② 覆盖，此处钉 seal 侧不重复
    await expect(sealShareSecret('x', PASSWORD, { iterations: 10_000_001 })).rejects.toThrow(
      /iterations.*10000000/s,
    )
  })

  it('⑥ blob <16B 下界：合法结构 + 解码后 15B（< GCM tag 128bit 最小面）→ rejects', async () => {
    await expect(
      openShareSecret(toB64Url(new Uint8Array(15)), 'AAAAAAAAAAAAAAAA', mkMeta().kdf, PASSWORD),
    ).rejects.toThrow(/blob/)
  })
})
