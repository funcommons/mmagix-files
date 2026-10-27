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
