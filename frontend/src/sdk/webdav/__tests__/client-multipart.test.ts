/**
 * M4 WebDAV 分片上传（Content-Range 旁路临时对象 + MOVE）单测（测试先行——实现并行开发中，红属预期）
 * 契约锚：《docs/design/webdav-support-design.md》§W4（M4）
 *
 * 与既有 client.test.ts 并列、不改动它——其「multipart 四方法降级抛未实现」用例继续守
 * chunkedWrite 缺省面（本文件「none 防御」describe 与之同口径互为印证）。
 *
 * 覆盖矩阵（§W4 ①路径 = chunkedWrite:true）：
 *  - multipartStrategy 声明：chunkedWrite:true → 'content-range'；缺省/false → 'none'（家族开关缺省关=安全降级）
 *  - createMultipart：uploadId 客户端随机合成（零网络请求=无服务器会话可 initiate）、
 *    uploadId 编入 tempKey → 跨会话可重构（断点续传寻址前提）
 *  - uploadPart：PUT tempKey + `Content-Range: bytes=-N`（追加末 N 字节非标口径——known-good 清单
 *    机制由实机取证批次维护，见 §W4；分片号不进 URL，所有分片追加同一临时对象）
 *  - completeMultipart：parts 非空校验（etags 忽略——Content-Range 追加语义下服务器自持字节序，
 *    etag 仅作队列簿记）→ MOVE tempKey→key（Destination 绝对 URI + Overwrite:T，同 copy 口径）
 *  - abortMultipart：DELETE tempKey（容忍 404=幂等清残）
 *  - probeUploadProgress：HEAD tempKey Content-Length；404 → -1（temp 不存在=无续传基础）
 *  - 'none' 防御：四方法照旧抛「未实现」（契约只锁四方法；probe 无害保留 404→-1，一并钉住）
 *
 * M4 已全部落地（WebDavBackendConfig.chunkedWrite / S3Client.multipartStrategy /
 * probeUploadProgress 均为正型成员），测试直接访问，不再保留「未实现红态」脚手架。
 */
import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, SdkError } from '../../errorCodes'
import { WebDavClient } from '../client'
import type { WebDavBackendConfig } from '../client'

const CONFIG: WebDavBackendConfig = {
  endpoint: 'https://dav.test',
  username: 'alice',
  password: 's3cret',
  // rootPath 取 '/dav'（勿照搬 client.test.ts 的 '/dav/docs/'）：tempKey 内含 key 自身的目录段
  // （'docs/big.bin' 的 temp 在 'docs/.big.bin.<id>.mmagix-part'），根路径再带 'docs' 会拼出
  // 误导性的 '/dav/docs/docs/...' 期望串——本文件统一 endpoint='/dav' 让 URL 与 tempKey 同形可读。
  rootPath: '/dav',
}

/** 与既有 client.test.ts 同构：注入 fetch 桩，按序/按实现回放响应 */
function makeClient(
  responses: Response[] | ((url: string, init?: RequestInit) => Response),
  config: WebDavBackendConfig = CONFIG,
) {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
  if (Array.isArray(responses)) {
    for (const r of responses) fetcher.mockResolvedValueOnce(r)
  } else {
    fetcher.mockImplementation(async (url, init) => responses(url, init))
  }
  // 契约构造签名第二参为 typeof fetch；测试桩窄签名 cast 接入
  return { fetcher, client: new WebDavClient(config, fetcher as unknown as typeof fetch) }
}

/** 头名大小写不敏感取值（兼容实现用 Record 或 Headers 两种形态，同既有 client.test.ts） */
function headerOf(init: RequestInit | undefined, name: string): string {
  const h = init?.headers
  if (!h) return ''
  if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name) ?? ''
  const lower = name.toLowerCase()
  for (const k of Object.keys(h as Record<string, string>)) {
    if (k.toLowerCase() === lower) return (h as Record<string, string>)[k] ?? ''
  }
  return ''
}

const res = (status: number, headers: Record<string, string> = {}, body: string | null = null) =>
  new Response(body, { status, headers })

// ───────────────────────── multipartStrategy 声明 ─────────────────────────

describe('multipartStrategy 声明（§W4 家族开关分流）', () => {
  it('chunkedWrite:true → "content-range"（旁路临时对象分块续写可用，§W4 ①）', () => {
    const { client } = makeClient([], { ...CONFIG, chunkedWrite: true })
    expect(client.multipartStrategy).toBe('content-range')
  })

  it('chunkedWrite 缺省 → "none"（家族开关缺省关=安全降级，§W4 探测裁决）', () => {
    const { client } = makeClient([])
    expect(client.multipartStrategy).toBe('none')
  })

  it('chunkedWrite:false → "none"（显式关与缺省同态）', () => {
    const { client } = makeClient([], { ...CONFIG, chunkedWrite: false })
    expect(client.multipartStrategy).toBe('none')
  })
})

// ───────────────────────── content-range：createMultipart ─────────────────────────

describe('content-range：createMultipart（uploadId 客户端合成 + tempKey 重构）', () => {
  it('uploadId 随机生成且零网络请求（无服务器会话——旁路临时对象方案，§W4「uploadId=客户端合成 ID」）', async () => {
    const { fetcher, client } = makeClient([], { ...CONFIG, chunkedWrite: true })
    const a = await client.createMultipart('docs/big.bin', 'application/octet-stream')
    const b = await client.createMultipart('docs/big.bin', 'application/octet-stream')
    expect(fetcher).not.toHaveBeenCalled() // 无 initiatE 类会话请求：ID 纯客户端合成
    expect(typeof a.uploadId).toBe('string')
    expect(a.uploadId.length).toBeGreaterThan(0)
    expect(b.uploadId).not.toBe(a.uploadId) // 随机生成：两次 create 不撞 ID
  })

  it('uploadId 编入 tempKey：跨实例（跨会话）仅凭 key+uploadId 重构同一 tempKey URL', async () => {
    const created = makeClient([], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await created.client.createMultipart('docs/big.bin')
    // 新实例（模拟跨会话/新进程）：断点续传只带 key+uploadId，tempKey 必须可重构——寻址前提
    const prober = makeClient([res(200, { 'content-length': '10' })], { ...CONFIG, chunkedWrite: true })
    const bytes = await prober.client.probeUploadProgress('docs/big.bin', uploadId)
    expect(bytes).toBe(10)
    expect(prober.fetcher.mock.calls[0]?.[0]).toBe(
      `https://dav.test/dav/docs/.big.bin.${uploadId}.mmagix-part`,
    )
  })
})

// ───────────────────────── content-range：uploadPart ─────────────────────────

describe('content-range：uploadPart（PUT tempKey + Content-Range 追加口径）', () => {
  it('PUT tempKey + Content-Range: bytes=-N；分片号不进 URL——所有分片追加同一临时对象', async () => {
    const { fetcher, client } = makeClient([res(201), res(201)], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await client.createMultipart('docs/big.bin')
    await client.uploadPart('docs/big.bin', uploadId, 1, new Blob(['12345']))
    await client.uploadPart('docs/big.bin', uploadId, 2, new Blob(['678']))
    const calls = fetcher.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c[1]?.method)).toEqual(['PUT', 'PUT'])
    // Nextcloud chunked v2 同型（§W4）：tempKey 不含分片号，逐片追加（末 N 字节非标口径）
    expect(calls.map((c) => c[0])).toEqual([
      `https://dav.test/dav/docs/.big.bin.${uploadId}.mmagix-part`,
      `https://dav.test/dav/docs/.big.bin.${uploadId}.mmagix-part`,
    ])
    // Content-Range 值 = 本片字节数（追加末 N 字节语义，非标准 RFC 9110 Range 写法）
    expect(headerOf(calls[0]?.[1], 'content-range')).toBe('bytes=-5')
    expect(headerOf(calls[1]?.[1], 'content-range')).toBe('bytes=-3')
  })

  it('key 含空格/中文 → tempKey URL 逐段编码（与主链 encodeKeyPath 同口径）', async () => {
    const { fetcher, client } = makeClient([res(201)], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await client.createMultipart('docs/大 文件.bin')
    await client.uploadPart('docs/大 文件.bin', uploadId, 1, new Blob(['x']))
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://dav.test/dav/docs/${encodeURIComponent('.大 文件.bin')}.${uploadId}.mmagix-part`,
    )
  })

  it('根级 key（无目录段）→ tempKey 无目录前缀、URL 无多余分隔符（不出现 //）', async () => {
    const { fetcher, client } = makeClient([res(201)], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await client.createMultipart('big.bin')
    await client.uploadPart('big.bin', uploadId, 1, new Blob(['x']))
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://dav.test/dav/.big.bin.${uploadId}.mmagix-part`)
  })
})

// ───────────────────────── content-range：completeMultipart ─────────────────────────

describe('content-range：completeMultipart（MOVE 覆盖目标）', () => {
  it('parts 空 → 拒绝且零网络请求（完成前校验，不发出 MOVE）', async () => {
    const { fetcher, client } = makeClient([], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await client.createMultipart('docs/big.bin')
    const err = await client.completeMultipart('docs/big.bin', uploadId, []).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect(fetcher).not.toHaveBeenCalled() // 校验先行：空 parts 不得触发 MOVE
  })

  it('MOVE tempKey→key：Destination 绝对 URI + Overwrite:T；etags 忽略（追加语义下服务器自持字节序）', async () => {
    const { fetcher, client } = makeClient([res(201)], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await client.createMultipart('docs/big.bin')
    await client.completeMultipart('docs/big.bin', uploadId, [
      { partNumber: 1, etag: '' },
      { partNumber: 2, etag: 'client-checksum-not-server-etag' },
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(init?.method).toBe('MOVE')
    expect(url).toBe(`https://dav.test/dav/docs/.big.bin.${uploadId}.mmagix-part`) // 源=temp 对象
    // Destination 绝对 URI（同 copy 评审裁决——部分服务器旧版只认绝对 URI，兼容面最大）
    expect(headerOf(init, 'destination')).toBe('https://dav.test/dav/docs/big.bin')
    expect(headerOf(init, 'overwrite')).toBe('T')
  })

  it('MOVE 非 2xx → 照主链错误映射（403 → S3_ERROR 资源级 ACL 语义，不得误报凭证失效）', async () => {
    const { client } = makeClient([res(403)], { ...CONFIG, chunkedWrite: true })
    const err = await client
      .completeMultipart('docs/big.bin', 'u1', [{ partNumber: 1, etag: '' }])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).code).not.toBe(ERROR_CODES.CREDENTIAL_INVALID) // §W3 401/403 分流表不因新方法破例
    expect((err as SdkError).detail).toMatchObject({ status: 403 })
  })
})

// ───────────────────────── content-range：abortMultipart ─────────────────────────

describe('content-range：abortMultipart（DELETE tempKey；§W4 红线：不得直写目标路径）', () => {
  it('DELETE tempKey（非目标 key）→ resolve void', async () => {
    const { fetcher, client } = makeClient([res(204)], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await client.createMultipart('docs/big.bin')
    await expect(client.abortMultipart('docs/big.bin', uploadId)).resolves.toBeUndefined()
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(init?.method).toBe('DELETE')
    expect(url).toBe(`https://dav.test/dav/docs/.big.bin.${uploadId}.mmagix-part`) // 只删临时对象
  })

  it('容忍 404（temp 已消失：abort 幂等，对齐 remove 404 容忍口径）', async () => {
    const { client } = makeClient([res(404)], { ...CONFIG, chunkedWrite: true })
    await expect(client.abortMultipart('docs/big.bin', 'u-any')).resolves.toBeUndefined()
  })
})

// ───────────────────────── content-range：probeUploadProgress ─────────────────────────

describe('content-range：probeUploadProgress（HEAD tempKey Content-Length，续传校验）', () => {
  it('200 + Content-Length → 返回 temp 对象当前字节数（半片残留可观测）', async () => {
    const { fetcher, client } = makeClient([res(200, { 'content-length': '15' })], { ...CONFIG, chunkedWrite: true })
    const { uploadId } = await client.createMultipart('docs/big.bin')
    const bytes = await client.probeUploadProgress('docs/big.bin', uploadId)
    expect(bytes).toBe(15)
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(init?.method).toBe('HEAD')
    expect(url).toBe(`https://dav.test/dav/docs/.big.bin.${uploadId}.mmagix-part`)
  })

  it('404 → -1（temp 不存在=无续传基础，队列据此重置重传；不抛错）', async () => {
    const { client } = makeClient([res(404)], { ...CONFIG, chunkedWrite: true })
    await expect(client.probeUploadProgress('docs/big.bin', 'u-any')).resolves.toBe(-1)
  })
})

// ───────────────────────── none：防御面（§W4 ②降级） ─────────────────────────

describe('none（chunkedWrite 缺省）：四方法照旧抛「未实现」（防御，§W4 ②降级面）', () => {
  it('probeUploadProgress 不随四方法防御抛错（无害保留：404→-1；契约只锁四方法，队列 none 下不调用）', async () => {
    const { fetcher, client } = makeClient([res(404)])
    // 契约原文「strategy none 时四方法照旧抛未实现」不含 probe——实现保留 HEAD 探测（temp 本就不
    // 存在 → 404 → -1），属无害面；此处钉住该行为防将来误改成抛错破坏（防御面收窄）。
    await expect(client.probeUploadProgress('big.bin', 'u-any')).resolves.toBe(-1)
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('HEAD')
  })

  it('createMultipart/uploadPart/completeMultipart/abortMultipart → SdkError「未实现」，零网络请求', async () => {
    const { fetcher, client } = makeClient([])
    await expect(client.createMultipart('big.bin', 'application/octet-stream')).rejects.toThrow('未实现')
    await expect(client.uploadPart('big.bin', 'u', 1, new Blob(['x']))).rejects.toThrow('未实现')
    await expect(client.completeMultipart('big.bin', 'u', [{ partNumber: 1, etag: 'e' }])).rejects.toThrow('未实现')
    await expect(client.abortMultipart('big.bin', 'u')).rejects.toThrow('未实现')
    expect(fetcher).not.toHaveBeenCalled() // 防御抛错先于任何请求
  })
})
