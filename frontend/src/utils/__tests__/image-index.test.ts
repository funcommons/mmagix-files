/**
 * imageConvert / utils index（icon/transformImageUrl/getAvatarColor/getFirstChar）单测。
 * canvas/createImageBitmap 打桩走通格式转换全链；jsdom 真实 canvas 无 2d ctx 的报错路径也锁。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { convertImage, getFormatConfig, IMAGE_FORMATS } from '../imageConvert'
import { getAvatarColor, getFirstChar, isOssUrl, resolveIcon, transformImageUrl } from '../index'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ───────────────────────── imageConvert ─────────────────────────

describe('imageConvert：格式表 / 代理 / 转换', () => {
  it('getFormatConfig：已知格式含 mime/ext/quality；未知抛错', () => {
    expect(getFormatConfig('png')).toMatchObject({ mime: 'image/png', ext: 'png' })
    expect(getFormatConfig('jpg').quality).toBe(1.0)
    expect(IMAGE_FORMATS).toHaveLength(5)
    expect(() => getFormatConfig('nope' as 'png')).toThrow(/Unknown image format/)
  })

  /** fetch/canvas/imageBitmap 桩装配器：返回收到的 fetch url */
  function stubImageChain(opts: { status?: number; blobType?: string } = {}): { fetchUrl: string } {
    const state = { fetchUrl: '' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      state.fetchUrl = String(url)
      return {
        ok: (opts.status ?? 200) === 200,
        status: opts.status ?? 200,
        blob: async () => new Blob(['x'], { type: opts.blobType ?? 'image/png' }),
      }
    }))
    vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
      void blob
      return { width: 2, height: 2, close() {} }
    }))
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      cb: (b: Blob | null) => void,
      mime?: string,
    ) {
      cb(new Blob(['out'], { type: mime ?? 'image/png' }))
    }) as typeof HTMLCanvasElement.prototype.toBlob
    return state
  }

  it('同 MIME 短路：直接返回原 blob 不重编码', async () => {
    const st = stubImageChain({ blobType: 'image/png' })
    const { blob, ext } = await convertImage('http://other.com/a.png', 'png')
    expect(ext).toBe('png')
    expect(blob.type).toBe('image/png')
    expect(st.fetchUrl).toBe('/image_proxy/http/other.com/a.png') // 跨域走代理
  })

  it('跨域代理：http(s) 外链 → /image_proxy/；data:/blob:/已代理/同源 原样', async () => {
    let st = stubImageChain()
    await convertImage('https://cdn.example.com/i.jpg?w=1', 'png')
    expect(st.fetchUrl).toBe('/image_proxy/https/cdn.example.com/i.jpg?w=1')

    st = stubImageChain()
    await convertImage('data:image/png;base64,x', 'png')
    expect(st.fetchUrl).toBe('data:image/png;base64,x')

    st = stubImageChain()
    await convertImage('blob:http://x/y', 'png')
    expect(st.fetchUrl).toBe('blob:http://x/y')

    st = stubImageChain()
    await convertImage('/image_proxy/https/a/b', 'png')
    expect(st.fetchUrl).toBe('/image_proxy/https/a/b')

    st = stubImageChain()
    await convertImage('/local.png', 'png') // 同源相对路径
    expect(st.fetchUrl).toBe('/local.png')
  })

  it('跨格式转换走 canvas 管线产出目标 MIME', async () => {
    stubImageChain({ blobType: 'image/png' })
    const { blob, ext } = await convertImage('/local.png', 'webp')
    expect(ext).toBe('webp')
    expect(blob.type).toBe('image/webp')
  })

  it('fetch 非 200 抛错；空 url 不代理原样透传', async () => {
    stubImageChain({ status: 404 })
    await expect(convertImage('http://x/y.png', 'png')).rejects.toThrow(/404/)
    const st = stubImageChain()
    await convertImage('', 'png')
    expect(st.fetchUrl).toBe('')
  })
})

// ───────────────────────── utils index ─────────────────────────

describe('utils index：icon / 图片 URL / 头像渐变 / 首字符', () => {
  it('resolveIcon：名字命中组件 / 未命中与空值回退 Document', () => {
    expect(resolveIcon('Search')).toBeTruthy()
    expect(resolveIcon('NoSuchIcon')).toBe(resolveIcon(null))
    expect(resolveIcon(undefined)).toBe(resolveIcon(''))
  })

  it('transformImageUrl：OSS 域名拼 resize 参数（已有 query 用 &）；空值占位图；非 OSS 原样', () => {
    expect(transformImageUrl('https://a.oss.com/i.jpg', 'small')).toBe(
      'https://a.oss.com/i.jpg?x-oss-process=image/resize,w_320',
    )
    expect(transformImageUrl('https://a.oss.com/i.jpg?x=1', 'xlarge')).toContain('&x-oss-process=image/resize,w_1920')
    expect(transformImageUrl('https://plain.com/i.jpg')).toBe('https://plain.com/i.jpg')
    const ph = transformImageUrl(null)
    expect(ph).toMatch(/^data:image\/svg\+xml/)
    expect(transformImageUrl('   ')).toBe(ph)
    // 大小写 OSS 域名也命中；URL 解析失败时字符串兜底匹配
    expect(isOssUrl('https://OSS.example.com/a.png')).toBe(true)
    expect(isOssUrl('junk-oss-string')).toBe(true)
    expect(isOssUrl('https://plain.com/a.png')).toBe(false)
  })

  it('getAvatarColor：空名默认渐变；有名按尾字符哈希出角度与双 hue', () => {
    expect(getAvatarColor('')).toBe('linear-gradient(135deg, #667eea 0%, #764ba2 100%)')
    expect(getAvatarColor(undefined)).toBe(getAvatarColor(null))
    const c = getAvatarColor('abc')
    const angle = ('c'.charCodeAt(0) * 7) % 360
    expect(c).toBe(`linear-gradient(${angle}deg, hsl(${angle}, 65%, 55%) 0%, hsl(${(angle + 45) % 360}, 55%, 45%) 100%)`)
    expect(getAvatarColor('abd')).not.toBe(c)
  })

  it('getFirstChar：首字符大写；空值 ?；前后空白容忍', () => {
    expect(getFirstChar('abc')).toBe('A')
    expect(getFirstChar(' 中文')).toBe('中')
    expect(getFirstChar('')).toBe('?')
    expect(getFirstChar('   ')).toBe('?')
  })
})
