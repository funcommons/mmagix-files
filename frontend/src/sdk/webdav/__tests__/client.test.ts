/**
 * M1 协议层：WebDavClient 单测（TDD 红先行——实现尚在同步落地，模块不存在=预期红）
 * 契约锚：《docs/design/webdav-support-design.md》§W1/W3/W5（方案正本）
 *
 * 断言口径与 s3/__tests__/client-versioning.test.ts 同构：mock fetcher 捕获 (url, init)
 * 断言 method/URL/头；响应用真实 WebDAV 形状（207 multistatus）。
 * 覆盖：Basic 认证（含非 Latin1 TextEncoder 兜底）、key→URL 与 rootPath 逐段编码、
 * list/get/put/head/copy/remove 六必选方法（PROPFIND 404/DELETE 404 容忍）、
 * 错误映射（401/403/409/423/507 带 reason 语义）、multipart 四方法带全参降级抛「未实现」、
 * 六可选方法缺席门控 + directorySemantics 声明。M1-V1 评审轮对齐。
 */
import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, SdkError } from '../../errorCodes'
import { WebDavClient } from '../client'
import type { WebDavBackendConfig } from '../client'

const CONFIG: WebDavBackendConfig = {
  endpoint: 'https://dav.test',
  username: 'alice',
  password: 's3cret',
  rootPath: '/dav/docs/',
}

/** 与 s3 版本测试同构：注入 fetch 桩，按序/按实现回放响应 */
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

/** 头名大小写不敏感取值（兼容实现用 Record 或 Headers 两种形态） */
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

/** 207 multistatus（真实 PROPFIND 响应形状，d: 前缀） */
const multistatus = (inner: string) =>
  res(207, { 'content-type': 'application/xml; charset=utf-8' }, `<d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`)

const davResponse = (href: string, prop = '<d:resourcetype/>'): string =>
  `<d:response><d:href>${href}</d:href>` +
  `<d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`

const COLLECTION_PROP = '<d:resourcetype><d:collection/></d:resourcetype>'
const fileProp = (size: number, lastModified?: string, etag?: string): string =>
  '<d:resourcetype/>' +
  `<d:getcontentlength>${size}</d:getcontentlength>` +
  (lastModified ? `<d:getlastmodified>${lastModified}</d:getlastmodified>` : '') +
  (etag ? `<d:getetag>${etag}</d:getetag>` : '')

/** 非 Latin1 凭证期望值：UTF-8 字节 → base64（契约=TextEncoder 兜底，非 btoa 直掷） */
function basicUtf8(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

describe('能力门控（W1/W5：六可选方法缺席 + 目录语义声明）', () => {
  it('directorySemantics === "collection"（W2：mkdir 走 MKCOL 分流、不落 0 字节标记对象的依据）', () => {
    const { client } = makeClient([])
    expect(client.directorySemantics).toBe('collection')
  })

  it('六可选方法全部不实现（undefined → 分享/回收站/版本/孤儿清理入口既有门控自动隐藏）', () => {
    const { client } = makeClient([])
    const gated = client as unknown as Record<string, unknown>
    expect(gated['getPresignedUrl']).toBeUndefined()
    expect(gated['presignPutUrl']).toBeUndefined()
    expect(gated['getBucketVersioning']).toBeUndefined()
    expect(gated['listObjectVersions']).toBeUndefined()
    expect(gated['deleteVersion']).toBeUndefined()
    expect(gated['listMultipartUploads']).toBeUndefined()
  })
})

describe('认证（§W6：v1 仅 Basic）', () => {
  it('username/password 都存在 → Authorization: Basic（btoa(user:pass)）', async () => {
    const { fetcher, client } = makeClient([res(200)])
    await client.get('a.txt')
    const [, init] = fetcher.mock.calls[0] ?? []
    expect(headerOf(init, 'authorization')).toBe(`Basic ${btoa('alice:s3cret')}`)
  })

  it('非 Latin1 凭证（中文用户名）→ UTF-8 字节 base64（TextEncoder 兜底，不炸 btoa）', async () => {
    const { fetcher, client } = makeClient([res(200)], {
      ...CONFIG,
      username: '李雷',
      password: '密码123',
    })
    await client.get('a.txt')
    const [, init] = fetcher.mock.calls[0] ?? []
    expect(headerOf(init, 'authorization')).toBe(`Basic ${basicUtf8('李雷', '密码123')}`)
  })

  it('缺凭证 → 无 Authorization 头', async () => {
    const { fetcher, client } = makeClient([res(200)], { endpoint: 'https://dav.test', rootPath: '/dav/docs/' })
    await client.get('a.txt')
    const [, init] = fetcher.mock.calls[0] ?? []
    expect(headerOf(init, 'authorization')).toBe('')
  })

  it('半凭证（只有 username 缺 password）→ 同样不发 Authorization（防 Basic "user:" 半凭证误用）', async () => {
    const { fetcher, client } = makeClient([res(200)], { endpoint: 'https://dav.test', username: 'alice' })
    await client.get('a.txt')
    const [, init] = fetcher.mock.calls[0] ?? []
    expect(headerOf(init, 'authorization')).toBe('')
  })
})

describe('key→URL：endpoint + rootPath + key 逐段 encodeURIComponent', () => {
  it('空格/中文/# 逐段编码，不破坏路径分隔符', async () => {
    const { fetcher, client } = makeClient([res(200)])
    await client.get('a b/中#文.txt')
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://dav.test/dav/docs/a%20b/%E4%B8%AD%23%E6%96%87.txt')
  })

  it('未配置 rootPath → endpoint 直接接编码 key', async () => {
    const { fetcher, client } = makeClient([res(200)], { endpoint: 'https://dav.test' })
    await client.get('x.txt')
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://dav.test/x.txt')
  })

  it('rootPath 含空格/中文（按未编码原文填写）→ 请求 URL 逐段编码；list 前缀剥离正确（collectionPath 与 URL 同形态）', async () => {
    const { fetcher, client } = makeClient(
      [
        multistatus(
          davResponse('/my%20docs/%E4%B8%AD%E6%96%87%E5%A4%B9/', COLLECTION_PROP) +
            davResponse('/my%20docs/%E4%B8%AD%E6%96%87%E5%A4%B9/a.txt', fileProp(6)),
        ),
      ],
      { endpoint: 'https://dav.test', rootPath: '/my docs/中文夹' },
    )
    const result = await client.list('')

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://dav.test/my%20docs/%E4%B8%AD%E6%96%87%E5%A4%B9')
    // collectionPath 与请求 URL 同为编码形态：self（collection 本体）排除、子条目剥编码前缀后解出真实 key
    expect(result.dirs).toHaveLength(0)
    expect(result.files.map((f) => f.key)).toEqual(['a.txt'])
  })
})

describe('list（PROPFIND Depth:1，§W1）', () => {
  it('PROPFIND 方法 + Depth: 1 头 + collectionPath 编码；multistatus 透传解析', async () => {
    const { fetcher, client } = makeClient([
      multistatus(
        davResponse('/dav/docs/notes/', COLLECTION_PROP) +
          davResponse('/dav/docs/notes/nested/', COLLECTION_PROP) +
          davResponse('/dav/docs/notes/a.txt', fileProp(3, 'Tue, 01 Jul 2025 08:12:34 GMT', '"e1"')),
      ),
    ])
    const result = await client.list('notes/')

    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://dav.test/dav/docs/notes/')
    expect(init?.method).toBe('PROPFIND')
    expect(headerOf(init, 'depth')).toBe('1')

    // S3Client 全 key 契约：parseMultistatus 相对 key 重拼调用方 prefix（同 s3/client.ts Contents.Key 原样含 prefix）
    expect(result.prefix).toBe('notes/')
    expect(result.continuationToken).toBeUndefined()
    expect(result.dirs).toHaveLength(1)
    // 目录 key 追加 '/'（W2：collection 归一为既有「前缀」概念，可直接作下次 list 的 prefix，与 S3 toDir 口径一致）
    expect(result.dirs[0]).toMatchObject({ key: 'notes/nested/', name: 'nested', isDir: true, size: 0 })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({
      key: 'notes/a.txt',
      name: 'a.txt',
      isDir: false,
      size: 3,
      lastModified: Date.parse('Tue, 01 Jul 2025 08:12:34 GMT'),
    })
  })

  it('根列举（prefix 空串）→ PROPFIND rootPath collection 本体；self 条目被排除', async () => {
    const { fetcher, client } = makeClient([
      multistatus(
        davResponse('/dav/docs/', COLLECTION_PROP) + davResponse('/dav/docs/root.txt', fileProp(1)),
      ),
    ])
    const result = await client.list('')
    // rootPath 归一去尾斜杠（self 判定在 parse 层尾斜杠不敏感，两种形态等价）
    expect(fetcher.mock.calls[0]?.[0]).toMatch(/^https:\/\/dav\.test\/dav\/docs\/?$/)
    expect(result.dirs).toHaveLength(0)
    expect(result.files.map((f) => f.key)).toEqual(['root.txt'])
  })

  it('PROPFIND 404（目录不存在）→ 不抛，返回空 S3ListResult（对齐 S3「列不存在 prefix=空结果」，M1-V1 翻转）', async () => {
    const { client } = makeClient([res(404)])
    expect(await client.list('ghost/')).toEqual({ prefix: 'ghost/', dirs: [], files: [] })
  })
})

describe('get（Range 透传，媒体渲染器/打包下载零改动）', () => {
  it('GET + Range 头透传；返回原始 Response', async () => {
    const { fetcher, client } = makeClient([res(206, { 'content-type': 'text/plain' }, 'partial')])
    const response = await client.get('big.bin', { rangeHeader: 'bytes=0-99' })
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://dav.test/dav/docs/big.bin')
    expect(init?.method).toBe('GET')
    expect(headerOf(init, 'range')).toBe('bytes=0-99')
    // 原始 Response 透出（不吞 body/status，调用方 zip-reader/渲染器自取）
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('partial')
  })

  it('不带 rangeHeader → 无 Range 头', async () => {
    const { fetcher, client } = makeClient([res(200, {}, 'whole')])
    await client.get('a.txt')
    const [, init] = fetcher.mock.calls[0] ?? []
    expect(headerOf(init, 'range')).toBe('')
  })
})

describe('put（Content-Type 透传 + etag 提取）', () => {
  it('PUT + content-type 透传；etag=响应 ETag 头', async () => {
    const { fetcher, client } = makeClient([res(201, { etag: '"abc123"' })])
    const body = new Blob(['hello'])
    const result = await client.put('a b.txt', body, 'text/plain')
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://dav.test/dav/docs/a%20b.txt')
    expect(init?.method).toBe('PUT')
    expect(headerOf(init, 'content-type')).toBe('text/plain')
    expect(result).toEqual({ etag: '"abc123"' })
  })

  it('响应无 ETag 头 → etag 空串', async () => {
    const { client } = makeClient([res(201)])
    expect(await client.put('a.txt', new Blob(['x']))).toEqual({ etag: '' })
  })
})

describe('head（存在性/元信息，404=正常业务态）', () => {
  it('404 → { exists:false }', async () => {
    const { fetcher, client } = makeClient([res(404)])
    expect(await client.head('gone.txt')).toEqual({ exists: false })
    const [, init] = fetcher.mock.calls[0] ?? []
    expect(init?.method).toBe('HEAD')
  })

  it('409 → { exists:false }（部分服务器对父 collection 缺失也回 409，同判不存在，§W3）', async () => {
    const { client } = makeClient([res(409)])
    expect(await client.head('a.txt')).toEqual({ exists: false })
  })

  it('2xx 带 Content-Length/Content-Type/ETag → 全量元信息', async () => {
    const { client } = makeClient([
      res(200, { 'content-length': '42', 'content-type': 'text/plain', etag: '"e1"' }),
    ])
    expect(await client.head('a.txt')).toEqual({ exists: true, size: 42, contentType: 'text/plain', etag: '"e1"' })
  })

  it('2xx 仅 Content-Length（无类型/etag）→ size 显式读取该头，contentType/etag 缺位（undefined）', async () => {
    // size 口径钉死=Content-Length 头（显式构造，不依赖 undici 对 null body 自动补头的环境噪声）
    const { client } = makeClient([res(200, { 'content-length': '0' })])
    const info = await client.head('a.txt')
    expect(info).toEqual({ exists: true, size: 0, contentType: undefined, etag: undefined })
  })
})

describe('copy（COPY + 绝对 URI Destination + Overwrite:T，§W1/§九-4）', () => {
  it('源 URL 逐段编码；Destination=绝对 URI（endpoint+目标路径）；Overwrite T', async () => {
    const { fetcher, client } = makeClient([res(201)])
    await client.copy('src dir/a.txt', 'dst dir/b.txt')
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://dav.test/dav/docs/src%20dir/a.txt')
    expect(init?.method).toBe('COPY')
    // 绝对 URI（部分服务器旧版只认绝对 URI——兼容面最大）
    expect(headerOf(init, 'destination')).toBe('https://dav.test/dav/docs/dst%20dir/b.txt')
    expect(headerOf(init, 'overwrite')).toBe('T')
  })

  it('2xx → resolve void（不抛）', async () => {
    const { client } = makeClient([res(204, {}, null)])
    await expect(client.copy('a.txt', 'b.txt')).resolves.toBeUndefined()
  })

  it('409（目标父 collection 缺失）→ S3_ERROR，detail={status:409, reason:"parent-missing"}（M2 renameDir 逐级 MKCOL 补建的判据）', async () => {
    const { client } = makeClient([res(409)])
    const err = await client.copy('a.txt', 'missing-dir/b.txt').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 409, reason: 'parent-missing' })
  })
})

describe('remove（逐 key DELETE，批删语义沿 tree-store）', () => {
  it('N 个 key → N 次 DELETE，URL 逐 key 编码', async () => {
    const { fetcher, client } = makeClient([res(204, {}, null), res(204, {}, null), res(204, {}, null)])
    await client.remove(['a.txt', 'b c.txt', '中文.txt'])
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.map((c) => c[1]?.method)).toEqual(['DELETE', 'DELETE', 'DELETE'])
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      'https://dav.test/dav/docs/a.txt',
      'https://dav.test/dav/docs/b%20c.txt',
      'https://dav.test/dav/docs/%E4%B8%AD%E6%96%87.txt',
    ])
  })

  it('容忍 404（M1-V1：删除幂等）——某 key 已消失不抛错，其余 key 照常逐个删', async () => {
    const { fetcher, client } = makeClient([res(204, {}, null), res(404), res(204, {}, null)])
    await expect(client.remove(['a.txt', 'gone.txt', 'b.txt'])).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://dav.test/dav/docs/gone.txt')
  })
})

describe('错误映射（§W3：401/403/423/500 分流，非 2xx → S3_ERROR）', () => {
  it('401 → CREDENTIAL_INVALID（遇 401 即判凭证无效，不做协商重试）', async () => {
    const { client } = makeClient([res(401)])
    const err = await client.list('').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.CREDENTIAL_INVALID)
  })

  it('403 → S3_ERROR（资源级 ACL 拒绝，不得误报凭证失效——WebDAV 世界 401/403 语义相反）', async () => {
    const { client } = makeClient([res(403)])
    const err = await client.list('').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    const code = (err as SdkError).code
    // 反向断言先行：权限语义不得映射为凭证类码
    expect(code).not.toBe(ERROR_CODES.CREDENTIAL_INVALID)
    expect(code).not.toBe(ERROR_CODES.CREDENTIAL_EXPIRED)
    expect(code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 403 })
  })

  it('423 Locked → S3_ERROR，detail={status:423, reason:"locked"}（v1 无写锁，只读冲突提示）', async () => {
    const { client } = makeClient([res(423)])
    const err = await client.put('a.txt', new Blob(['x'])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 423, reason: 'locked' })
  })

  it('507 容量满 → S3_ERROR，detail={status:507, reason:"quota"}', async () => {
    const { client } = makeClient([res(507)])
    const err = await client.put('a.txt', new Blob(['x'])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 507, reason: 'quota' })
  })

  it('500 → S3_ERROR 且 detail 含 status', async () => {
    const { client } = makeClient([res(500)])
    const err = await client.remove(['a.txt']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 500 })
  })
})

describe('multipart 四方法（§W4：无标准协议，诚实降级抛「未实现」）', () => {
  it('createMultipart（按接口签名带全参调用）→ SdkError，message 含「未实现」', async () => {
    const { client } = makeClient([])
    const err = await client.createMultipart('big.bin', 'application/octet-stream').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).message).toContain('未实现')
  })

  it('uploadPart → SdkError，message 含「未实现」', async () => {
    const { client } = makeClient([])
    const err = await client.uploadPart('big.bin', 'upload-1', 1, new Blob(['p'])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).message).toContain('未实现')
  })

  it('completeMultipart → SdkError，message 含「未实现」', async () => {
    const { client } = makeClient([])
    const err = await client.completeMultipart('big.bin', 'upload-1', [{ partNumber: 1, etag: 'e' }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).message).toContain('未实现')
  })

  it('abortMultipart → SdkError，message 含「未实现」', async () => {
    const { client } = makeClient([])
    const err = await client.abortMultipart('big.bin', 'upload-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).message).toContain('未实现')
  })
})

// ───────────────────────── createDirectory（M3/W2：逐级 MKCOL 确保完整祖先链） ─────────────────────────

/**
 * M3 契约（《docs/design/webdav-support-design.md》§W2）：createDirectory(key) 确保 key 的完整
 * 祖先 collection 链——内部逐级 MKCOL（'a/b/c/' → a/ → a/b/ → a/b/c/）；405=已存在容忍（幂等
 * 补建）；其余非 2xx 照 mapHttpError 分流（§W3 同表）。
 * 注：404 的容忍与否契约文本两歧（W2 正文只钉 405），本批不钉 404 行为，避免过度约束。
 */
describe('createDirectory（M3/W2：逐级 MKCOL 链）', () => {
  it("'a/b/c/' → 逐级 MKCOL 三连（祖先链完整）：a/ → a/b/ → a/b/c/，URL=rootPath+逐段编码", async () => {
    const { fetcher, client } = makeClient([res(201), res(201), res(201)])
    await client.createDirectory('a/b/c/')
    // MKCOL URL 无尾斜杠（RFC 4918 collection 建立两形态等价；实现按段拼接不补尾 '/'）
    expect(fetcher.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([
      ['MKCOL', 'https://dav.test/dav/docs/a'],
      ['MKCOL', 'https://dav.test/dav/docs/a/b'],
      ['MKCOL', 'https://dav.test/dav/docs/a/b/c'],
    ])
  })

  it("单段 key（'notes/'）→ 单发 MKCOL", async () => {
    const { fetcher, client } = makeClient([res(201)])
    await client.createDirectory('notes/')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://dav.test/dav/docs/notes')
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('MKCOL')
  })

  it('中间级 405（已存在）容忍 → 链继续到末级，整体 resolve（幂等补建，W2）', async () => {
    const { fetcher, client } = makeClient([res(405), res(201)])
    await expect(client.createDirectory('a/b/')).resolves.toBeUndefined()
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      'https://dav.test/dav/docs/a',
      'https://dav.test/dav/docs/a/b',
    ])
  })

  it('末级 405 容忍 → resolve void（目录已存在不算错）', async () => {
    const { fetcher, client } = makeClient([res(201), res(405)])
    await expect(client.createDirectory('a/b/')).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('非容忍错误照 mapHttpError：403 → S3_ERROR（ACL 语义，非凭证失效）且链中止（后续级不再发）', async () => {
    const { fetcher, client } = makeClient([res(201), res(403)])
    const err = await client.createDirectory('a/b/').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).not.toBe(ERROR_CODES.CREDENTIAL_INVALID)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 403 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('非容忍错误照 mapHttpError：500 → S3_ERROR 且 detail={status:500}', async () => {
    const { client } = makeClient([res(500)])
    const err = await client.createDirectory('only/').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 500 })
  })

  it('key 含空格/中文 → 逐段编码的 MKCOL URL', async () => {
    const { fetcher, client } = makeClient([res(201)])
    await client.createDirectory('中文 目录/')
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://dav.test/dav/docs/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95')
  })
})
