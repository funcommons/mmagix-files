/**
 * presignGet / presignPut 的 extraQuery 追加查询参数契约（v1.2.0：断点上传 / 分享增强前置）
 * 契约（先写红，实现后转绿）：
 * - PresignInput 追加可选字段 extraQuery?: Record<string, string>
 * - extraQuery 与既有 X-Amz-* 查询项合并进 canonical query：全部项按 RFC3986 编码后键名字典序
 *   排序（与既有项同一排序通道），值经 encodeRfc3986
 * - 合并后的 query 同时参与签名计算与最终签名 URL（X-Amz-Signature 仍追加在末尾、不参与排序）
 * - 回归红线：不传 extraQuery（含传空对象）时输出与现行为逐字节一致（锚定 sigv4.test.ts 金样本）
 * 签名对拍双通道：① 导出的 sha256HexSync/hmacSha256Sync 手工重算 canonical request；
 * ② node:crypto 从输出 URL 自身参数独立复算（与实现零耦合）。
 */
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { S3Credentials } from '../../types'
import { encodeRfc3986, formatAmzDate, hmacSha256Sync, presignGet, presignPut, sha256HexSync } from '../sigv4'
import type { PresignInput } from '../sigv4'

const AK_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
const CREDS_NO_TOKEN: S3Credentials = { accessKeyId: 'AKIDEXAMPLE', accessKeySecret: AK_SECRET, sessionToken: '' }
const CREDS_TOKEN: S3Credentials = { accessKeyId: 'AKID-TEST', accessKeySecret: 'SECRET-TEST-KEY', sessionToken: 'STStoken123' }
/** 20260101T000000Z */
const T_B = Date.UTC(2026, 0, 1, 0, 0, 0)

const BASE_URL = 'https://s3.test/bkt/docs/a%20b.txt'
const BASE: PresignInput = { url: BASE_URL, expiresSec: 3600, credentials: CREDS_TOKEN, region: 'us-east-1', nowMs: T_B }

/**
 * extraQuery 落地前 PresignInput 尚无该字段：显式收窄断言让测试先行（vitest 运行时不做类型检查，
 * extraQuery 被现实现忽略 → 断言为红）；契约实现后该 helper 无需改动。
 */
const withExtra = (extra: Record<string, string>): PresignInput => ({ ...BASE, extraQuery: extra }) as PresignInput

/** 回归红线金样本：与 sigv4.test.ts「presignGet 金样本」完全一致（现行为固定锚，BASE 同参） */
const GOLDEN_NO_EXTRA =
  'https://s3.test/bkt/docs/a%20b.txt' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=AKID-TEST%2F20260101%2Fus-east-1%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20260101T000000Z' +
  '&X-Amz-Expires=3600' +
  '&X-Amz-Security-Token=STStoken123' +
  '&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=9d3bc9a14e0a41fd8037ac6535da9828bc8f6b3f1bb2d55b80643b62bc1a7d4f'

/** RFC3986 编码（测试侧独立实现，与 encodeRfc3986 同口径） */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const hmac = (key: string | Uint8Array | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/**
 * node:crypto 独立复算：从输出 URL 自身参数（含 extra 对）重建 canonical request 并重算签名，
 * 与实现零耦合（X-Amz-Signature 除外、不参与规范化）。
 */
function recomputeSignature(urlStr: string, method: string, creds: S3Credentials): string {
  const u = new URL(urlStr)
  const q = u.searchParams
  const pairs = Array.from(q.entries())
    .filter(([n]) => n !== 'X-Amz-Signature')
    .map(([n, v]) => [enc(n), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const canonicalRequest = [
    method,
    u.pathname,
    pairs.map(([n, v]) => `${n}=${v}`).join('&'),
    `host:${u.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const scope = q.get('X-Amz-Credential')!.split('/').slice(1).join('/')
  const stringToSign = ['AWS4-HMAC-SHA256', q.get('X-Amz-Date')!, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  const [, region, service] = scope.split('/')
  let key = hmac(`AWS4${creds.accessKeySecret}`, q.get('X-Amz-Date')!.slice(0, 8))
  key = hmac(key, region!)
  key = hmac(key, service!)
  key = hmac(key, 'aws4_request')
  return hmac(key, stringToSign).toString('hex')
}

function bufToHex(buf: Uint8Array): string {
  let hex = ''
  for (const b of buf) hex += b.toString(16).padStart(2, '0')
  return hex
}

describe('presignGet × extraQuery（合并进 canonical query）', () => {
  it('extraQuery 出现在最终 URL：编码正确，位于排序块末尾、X-Amz-Signature 之前', () => {
    const url = presignGet(withExtra({ versionId: 'v2001-01-01' }))
    // 'v' > 'X'：versionId 排在全部 X-Amz-* 之后，Signature 恒在末尾
    expect(url).toContain('&versionId=v2001-01-01&X-Amz-Signature=')
  })

  it('参与签名：用导出 sha256HexSync/hmacSha256Sync 手工重算 canonical request，整条 URL（含合并排序与签名）逐字对拍', () => {
    const extra = {
      partNumber: '2',
      'response-content-disposition': 'attachment; filename="报表 2026.xlsx"',
      uploadId: 'abc/123+def=',
      versionId: 'v2001',
    }
    const url = presignGet(withExtra(extra))
    const amzDate = formatAmzDate(T_B)
    const scope = '20260101/us-east-1/s3/aws4_request'
    const u = new URL(BASE_URL)
    // 期望 canonical query：既有六项 + extra 四项，按 RFC3986 编码后键名字典序混排
    const pairs: Array<[string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${CREDS_TOKEN.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', '3600'],
      ['X-Amz-Security-Token', 'STStoken123'],
      ['X-Amz-SignedHeaders', 'host'],
      ['partNumber', '2'],
      ['response-content-disposition', 'attachment; filename="报表 2026.xlsx"'],
      ['uploadId', 'abc/123+def='],
      ['versionId', 'v2001'],
    ]
    const canonicalQuery = pairs
      .map(([n, v]) => [encodeRfc3986(n), encodeRfc3986(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([n, v]) => `${n}=${v}`)
      .join('&')
    const canonicalRequest = ['GET', u.pathname, canonicalQuery, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexSync(new TextEncoder().encode(canonicalRequest))].join('\n')
    let key = hmacSha256Sync(new TextEncoder().encode(`AWS4${CREDS_TOKEN.accessKeySecret}`), '20260101')
    key = hmacSha256Sync(key, 'us-east-1')
    key = hmacSha256Sync(key, 's3')
    key = hmacSha256Sync(key, 'aws4_request')
    const signature = bufToHex(hmacSha256Sync(key, stringToSign))
    expect(url).toBe(`${BASE_URL}?${canonicalQuery}&X-Amz-Signature=${signature}`)
  })

  it('独立复算：node:crypto 从输出 URL 参数（含 extra 对）重建签名一致（零耦合对拍）', () => {
    const url = presignGet(
      withExtra({ 'response-content-disposition': 'attachment; filename="a b.txt"', versionId: '3sL4kqt+rmS/x=d' }),
    )
    const expected = new URL(url).searchParams.get('X-Amz-Signature')
    expect(recomputeSignature(url, 'GET', CREDS_TOKEN)).toBe(expected)
  })

  it('混序排序：extra 键与 X-Amz-* 按编码后键名字典序混排（大写键排 X-Amz 块前、X-Amzz-Middle 贴块后、小写键排最后）', () => {
    // 保留前缀键（/^X-Amz-/i）已被入口守卫拒绝，夹逼键取 X-Amzz-Middle（'z'(0x7A) > '-'(0x2D)，
    // 紧贴 X-Amz 块之后）：Foo < X-Amz-* 块 < X-Amzz-Middle < aa-last，同通道排序证明力不变
    const url = presignGet(withExtra({ Foo: '1', 'X-Amzz-Middle': '2', 'aa-last': '3' }))
    expect(url.startsWith(
      BASE_URL +
        '?Foo=1' +
        '&X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKID-TEST%2F20260101%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20260101T000000Z' +
        '&X-Amz-Expires=3600' +
        '&X-Amz-Security-Token=STStoken123' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amzz-Middle=2' +
        '&aa-last=3' +
        '&X-Amz-Signature=',
    )).toBe(true)
    expect(url).toMatch(/&X-Amz-Signature=[0-9a-f]{64}$/)
  })

  it('守卫：extraQuery 含保留前缀键（X-Amz-Expires）→ 入口显式抛错（防预签名参数双写），错误信息含「保留」与 X-Amz 字样；presignPut 同口收口', () => {
    const reserved = { 'X-Amz-Expires': '60' }
    expect(() => presignGet(withExtra(reserved))).toThrowError(/保留/)
    expect(() => presignGet(withExtra(reserved))).toThrowError(/X-Amz/)
    // presignPut 委托 presignGet，同一守卫先于任何签名计算生效
    expect(() => presignPut({ ...BASE, extraQuery: reserved } as PresignInput)).toThrowError(/保留/)
  })

  it('回归红线：不传 extraQuery / 传空对象 → 输出与现行为金样本逐字节一致', () => {
    const base = { url: BASE_URL, expiresSec: 3600, credentials: CREDS_TOKEN, region: 'us-east-1', nowMs: T_B } as PresignInput
    expect(presignGet(base)).toBe(GOLDEN_NO_EXTRA)
    expect(presignGet({ ...base, extraQuery: {} } as PresignInput)).toBe(GOLDEN_NO_EXTRA)
  })

  it('签名确实变化：同输入带 extraQuery 与不带 → X-Amz-Signature 不同（extra 参与签名而非仅拼 URL）', () => {
    const base = { url: BASE_URL, expiresSec: 3600, credentials: CREDS_TOKEN, region: 'us-east-1', nowMs: T_B } as PresignInput
    const withQ = presignGet({ ...base, extraQuery: { versionId: 'v1' } } as PresignInput)
    expect(new URL(withQ).searchParams.get('X-Amz-Signature')).not.toBe(new URL(GOLDEN_NO_EXTRA).searchParams.get('X-Amz-Signature'))
  })

  it('多键多值 + 特殊字符（空格/加号/斜杠/等号/分号/引号/中文）编码正确且按字典序合并', () => {
    const url = presignGet(
      withExtra({
        partNumber: '2',
        'response-content-disposition': 'attachment; filename="报表 2026.xlsx"',
        uploadId: 'abc/123+def=',
        versionId: '3sL4kqt+rmS/x=d',
      }),
    )
    // p < r < u < v：extra 块内部亦按编码后键名升序；X-Amz-Signature 恒末尾
    expect(url.startsWith(
      BASE_URL +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKID-TEST%2F20260101%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20260101T000000Z' +
        '&X-Amz-Expires=3600' +
        '&X-Amz-Security-Token=STStoken123' +
        '&X-Amz-SignedHeaders=host' +
        '&partNumber=2' +
        '&response-content-disposition=attachment%3B%20filename%3D%22%E6%8A%A5%E8%A1%A8%202026.xlsx%22' +
        '&uploadId=abc%2F123%2Bdef%3D' +
        '&versionId=3sL4kqt%2BrmS%2Fx%3Dd' +
        '&X-Amz-Signature=',
    )).toBe(true)
  })
})

describe('presignPut × extraQuery（与 presignGet 同构，method 通道差异）', () => {
  it('契约锚：presignPut(input) ≡ presignGet({...input, method:"PUT"})，extraQuery 同样透传', () => {
    const withQ = { ...BASE, extraQuery: { partNumber: '2', uploadId: 'u/1' } } as PresignInput
    expect(presignPut(withQ)).toBe(presignGet({ ...withQ, method: 'PUT' }))
  })

  it('PUT 通道独立复算：node:crypto 按 PUT 规范重建签名一致，且与 GET 同参签名不同（method 参与规范化请求）', () => {
    const url = presignPut(withExtra({ partNumber: '2', uploadId: 'u/1' }))
    const expected = new URL(url).searchParams.get('X-Amz-Signature')
    expect(recomputeSignature(url, 'PUT', CREDS_TOKEN)).toBe(expected)
    const getUrl = presignGet(withExtra({ partNumber: '2', uploadId: 'u/1' }))
    expect(expected).not.toBe(new URL(getUrl).searchParams.get('X-Amz-Signature'))
  })

  it('无 sessionToken：extraQuery 与 X-Amz-* 合并口径不变、无 X-Amz-Security-Token', () => {
    const base = { url: BASE_URL, expiresSec: 60, credentials: CREDS_NO_TOKEN, region: 'us-east-1', nowMs: T_B } as PresignInput
    const url = presignGet({ ...base, extraQuery: { versionId: 'v1' } } as PresignInput)
    expect(url).toContain('&versionId=v1&X-Amz-Signature=')
    expect(new URL(url).searchParams.get('X-Amz-Security-Token')).toBeNull()
    expect(recomputeSignature(url, 'GET', CREDS_NO_TOKEN)).toBe(new URL(url).searchParams.get('X-Amz-Signature'))
  })
})
