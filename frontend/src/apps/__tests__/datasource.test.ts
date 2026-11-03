/**
 * datasource.ts 单测（Wave2-A13）：应用数据面桥
 * 被测：src/apps/datasource.ts——s3DataSource / urlDataSource
 * 契约：《docs/design/solution-design.md》V1.2 §4.1b「数据源抽象：内置应用与插件零感知」
 *       + S3Client（工作台，key 透传）/ UrlSourceProvider（单文件，key 忽略）参数桥接
 *       + getMediaUrl 可选媒体直链（Lane F6：s3 经 getPresignedUrl；url 仅「可直接 GET」源）
 */
import { describe, expect, it, vi } from 'vitest'
import type { FileSource, S3Client } from '../../sdk/types'
import { UrlSourceProvider } from '../../sdk/url-source'
import { s3DataSource, urlDataSource } from '../datasource'

/**
 * 构造全 vi.fn 的最小 S3Client（仅桥接用到的 get/put 有实现）。
 * get 返回预构 Response、blob 直接 fake 为预造 Blob 的 Promise：
 * 断言「同一 Blob 引用」需固定返回值，而真 Response 的 body 只能读一次。
 */
function makeS3Client(content = 'x') {
  const blob = new Blob([content])
  const blobPromise = Promise.resolve(blob)
  const res = { blob: vi.fn(() => blobPromise) } as unknown as Response
  const client = {
    get: vi.fn((_key: string) => Promise.resolve(res)),
    put: vi.fn((_key: string, _body: Blob | ArrayBuffer, _contentType?: string) =>
      Promise.resolve({ etag: 'etag-1' }),
    ),
  } satisfies Pick<S3Client, 'get' | 'put'>
  return { client: client as unknown as S3Client, blob, blobPromise, res }
}

/** 构造全 vi.fn 的最小 UrlSourceProvider（仅桥接用到的 getBlob/put） */
function makeUrlProvider(blob: Blob) {
  const provider = {
    getBlob: vi.fn(() => Promise.resolve(blob)),
    put: vi.fn((_data: Blob | ArrayBuffer | string, _contentType?: string) => Promise.resolve()),
  } satisfies Pick<UrlSourceProvider, 'getBlob' | 'put'>
  return { provider: provider as unknown as UrlSourceProvider }
}

// ───────────────────────── s3DataSource ─────────────────────────

describe('s3DataSource（工作台模式：key 透传 S3Client）', () => {
  it('getObject：client.get(key) 且返回其 res.blob() 的同一 Blob 引用', async () => {
    const { client, blob, blobPromise, res } = makeS3Client('x')
    const ds = s3DataSource(client)

    const out = await ds.getObject('docs/a.txt')

    expect(client.get).toHaveBeenCalledTimes(1)
    expect(client.get).toHaveBeenCalledWith('docs/a.txt')
    expect(res.blob).toHaveBeenCalledTimes(1)
    expect(out).toBe(await blobPromise)
    expect(out).toBe(blob)
  })

  it('putObject：client.put(key, data, contentType) 参数透传', async () => {
    const { client } = makeS3Client('')
    const ds = s3DataSource(client)
    const data = new Blob(['body'])

    await ds.putObject('docs/a.txt', data, 'text/plain')

    expect(client.put).toHaveBeenCalledTimes(1)
    expect(client.put).toHaveBeenCalledWith('docs/a.txt', data, 'text/plain')
  })

  it('putObject：contentType 缺省 → 透传 undefined（非 null/省略变形）', async () => {
    const { client } = makeS3Client('')
    const ds = s3DataSource(client)
    const data = new Blob(['body'])

    await ds.putObject('docs/a.txt', data)

    expect(client.put).toHaveBeenCalledWith('docs/a.txt', data, undefined)
    expect(vi.mocked(client.put).mock.calls[0]).toHaveLength(3)
  })
})

// ───────────────────────── urlDataSource ─────────────────────────

describe('urlDataSource（单文件模式：key 语义弱化）', () => {
  it('getObject：provider.getBlob()（key 被忽略，不透传）', async () => {
    const blob = new Blob(['source'])
    const { provider } = makeUrlProvider(blob)
    const ds = urlDataSource(provider)

    const out = await ds.getObject('whatever-key')

    expect(provider.getBlob).toHaveBeenCalledTimes(1)
    expect(provider.getBlob).toHaveBeenCalledWith()
    expect(out).toBe(blob)
  })

  it('putObject：provider.put(data, contentType)——key 不透传给 provider', async () => {
    const { provider } = makeUrlProvider(new Blob(['source']))
    const ds = urlDataSource(provider)
    const data = new Blob(['body'])

    await ds.putObject('ignored-key', data, 'application/json')

    expect(provider.put).toHaveBeenCalledTimes(1)
    expect(provider.put).toHaveBeenCalledWith(data, 'application/json')
  })

  it('putObject：contentType 缺省 → provider.put(data, undefined)', async () => {
    const { provider } = makeUrlProvider(new Blob(['source']))
    const ds = urlDataSource(provider)
    const data = new Blob(['body'])

    await ds.putObject('ignored-key', data)

    expect(provider.put).toHaveBeenCalledWith(data, undefined)
    expect(vi.mocked(provider.put).mock.calls[0]).toHaveLength(2)
  })
})

// ───────────────────────── getMediaUrl（Lane F6：媒体直链 → 浏览器原生 Range 拖动） ─────────────────────────

describe('getMediaUrl（可选媒体直链能力）', () => {
  describe('s3DataSource：经 client.getPresignedUrl 透传', () => {
    it('client 实现 getPresignedUrl → ds.getMediaUrl(key) 透传并返回预签名 URL', () => {
      const { client } = makeS3Client('')
      const presign = vi.fn((key: string) => `https://presigned/${key}`)
      ;(client as { getPresignedUrl?: unknown }).getPresignedUrl = presign

      const ds = s3DataSource(client)
      expect(ds.getMediaUrl).toBeTypeOf('function')
      expect(ds.getMediaUrl!('media/a.mp4')).toBe('https://presigned/media/a.mp4')
      expect(presign).toHaveBeenCalledWith('media/a.mp4')
    })

    it('client 未实现 getPresignedUrl（可选能力缺位）→ ds 不提供 getMediaUrl', () => {
      const { client } = makeS3Client('')
      const ds = s3DataSource(client)
      expect(ds.getMediaUrl).toBeUndefined()
    })
  })

  describe('urlDataSource：仅「可直接 GET」源提供 source.url', () => {
    /** 真 UrlSourceProvider（getMediaUrl 判定读其 source 配置；网络方法不触达） */
    function realProvider(source: FileSource): UrlSourceProvider {
      return new UrlSourceProvider({ source, fetcher: vi.fn() })
    }

    it('method 未配置且无自定义 headers → getMediaUrl 返回 source.url', () => {
      const ds = urlDataSource(realProvider({ url: 'https://cdn.test/a.mp4' }))
      expect(ds.getMediaUrl).toBeTypeOf('function')
      expect(ds.getMediaUrl!('ignored')).toBe('https://cdn.test/a.mp4')
    })

    it('method=GET 同上；headers 为空对象视为无自定义 headers', () => {
      const ds = urlDataSource(realProvider({ url: 'https://cdn.test/a.mp4', method: 'GET', headers: {} }))
      expect(ds.getMediaUrl!('ignored')).toBe('https://cdn.test/a.mp4')
    })

    it('method=POST → 不提供（直链复现不了 POST 请求形态）', () => {
      const ds = urlDataSource(realProvider({ url: 'https://api.test/a.mp4', method: 'POST', body: 'x' }))
      expect(ds.getMediaUrl).toBeUndefined()
    })

    it('GET + 自定义 headers（鉴权直链）→ 不提供（<video src> 带不了自定义头）', () => {
      const ds = urlDataSource(realProvider({ url: 'https://api.test/a.mp4', headers: { authorization: 'Bearer x' } }))
      expect(ds.getMediaUrl).toBeUndefined()
    })
  })
})

// ───────────────────────── getObjectRange（M3/W5：Range 读通道 → zip objectRangeReader） ─────────────────────────

/**
 * M3 契约（《docs/design/webdav-support-design.md》§W5）：AppCtx 包装新增可选
 * getObjectRange(key, start, end)——经 client.get(key, {rangeHeader})，[start,end) 半开区间
 * 换算 bytes=start-(end-1) 在实现层；206=精确区间字节、200=整包字节（上层整包缓存后本地切片）。
 * mem:// 键域不提供该成员（withMemSource 包裹层拦截——上层 zip 渲染器 isMemKey 先判走 Blob 兜底）。
 */
describe('getObjectRange（M3 契约：client.get+RangeHeader，可选能力）', () => {
  /** 构造带 Range 应答的 client.get 桩：206 + 精确切片（真实 S3/WebDAV GET+Range 语义）。
   *  注：body 直接给 Uint8Array——vitest jsdom 环境的全局 Blob 是 jsdom 构造器，进 undici
   *  Response 的 body 提取会被字符串化（探针实测回 '[object Blob]'），不保真 */
  function makeRangeClient(bytes: Uint8Array) {
    const get = vi.fn(async (_key: string, opts?: { rangeHeader?: string }): Promise<Response> => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(opts?.rangeHeader ?? '')
      if (!m) return new Response(bytes as BodyInit, { status: 200 })
      const start = Number(m[1])
      const end = Number(m[2]) + 1 // 闭区间 → 半开
      return new Response(bytes.slice(start, end) as BodyInit, { status: 206 })
    })
    const client = { get, put: vi.fn(async (): Promise<{ etag: string }> => ({ etag: 'e' })) } satisfies Pick<
      S3Client,
      'get' | 'put'
    >
    return { client: client as unknown as S3Client, get }
  }

  it('s3DataSource 提供 getObjectRange：rangeHeader=bytes=start-(end-1) 且返回 [start,end) 精确字节', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    const { client, get } = makeRangeClient(bytes)
    const ds = s3DataSource(client)

    expect(ds.getObjectRange).toBeTypeOf('function')
    const out = await ds.getObjectRange!('docs/a.bin', 2, 5)

    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('docs/a.bin', { rangeHeader: 'bytes=2-4' }) // 半开→闭区间换算
    expect(out).toBeInstanceOf(Uint8Array)
    // 字节断言走 Buffer.equals（vitest jsdom realm 分裂坑——不走 toEqual）
    expect(Buffer.from(out).equals(Buffer.from(bytes.slice(2, 5)))).toBe(true)
  })

  it('206 精确区间跨窗口稳定：多次读各自恰好 [start,end)（206 语义，上层不缓存错位）', async () => {
    const bytes = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i))
    const { client, get } = makeRangeClient(bytes)
    const ds = s3DataSource(client)

    const first = await ds.getObjectRange!('a.bin', 0, 4)
    const second = await ds.getObjectRange!('a.bin', 10, 16)
    expect(get).toHaveBeenCalledTimes(2)
    expect(Buffer.from(first).equals(Buffer.from(bytes.slice(0, 4)))).toBe(true)
    expect(Buffer.from(second).equals(Buffer.from(bytes.slice(10, 16)))).toBe(true)
  })

  it('200 整包字节透出（源不支持 Range）：上层按「长度≠请求区间」判整读形态', async () => {
    const bytes = Uint8Array.from([9, 8, 7, 6, 5])
    const get = vi.fn(async (): Promise<Response> => new Response(bytes as BodyInit, { status: 200 }))
    const client = { get, put: vi.fn() } as unknown as S3Client
    const ds = s3DataSource(client)

    const out = await ds.getObjectRange!('a.bin', 1, 3)
    expect(get).toHaveBeenCalledWith('a.bin', { rangeHeader: 'bytes=1-2' })
    expect(out.length).not.toBe(2) // 整包字节（长度≠请求区间）——整读信号交上层缓存切片
    expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true)
  })

  it('mem:// 键经 withMemSource 包裹层拦截：不透传底层 client.get（错域请求防线）', async () => {
    const { client, get } = makeRangeClient(Uint8Array.from([1, 2, 3]))
    const ds = s3DataSource(client)

    // 实现以同步 throw 拒绝（契约类型是 Promise，故 async 包裹成 rejection 统一断言）；
    // 「mem 键不提供该成员→上层 Blob 兜底」的可观察面在 zip 渲染器 isMemKey 先判（见 zip-renderer.test.ts）
    const attempt = (async () => ds.getObjectRange!('mem://1/a.bin', 0, 2))()
    await expect(attempt).rejects.toThrow('mem key')
    expect(get).not.toHaveBeenCalled() // mem 键绝不入 client.get
  })

  it('urlDataSource（单文件模式）不提供 getObjectRange（无 client.get 通道 → Blob 兜底）', () => {
    const blob = new Blob(['source'])
    const { provider } = makeUrlProvider(blob)
    const ds = urlDataSource(provider)
    expect(ds.getObjectRange).toBeUndefined()
  })
})
