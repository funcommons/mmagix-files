/**
 * imageTransform 单测（Image/canvas 桩——jsdom 不解码图片）：
 * convertImage（png→jpeg 白底+质量规则）/ downscaleToMaxEdge（短边直返/长边等比）/
 * uploadViaApi（FormData 上传 + dot path 取 URL + 各失败面）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertImage, downscaleToMaxEdge, uploadViaApi } from '../imageTransform'

/** Image.src 桩：赋值即同步回调 onload/onerror（jsdom 不解码） */
function stubImageDecode(opts: { width?: number; height?: number; fail?: boolean } = {}): void {
  let last: HTMLImageElement | null = null
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    set(this: HTMLImageElement & { _onload?: () => void }, url: string) {
      last = this
      queueMicrotask(() => {
        if (opts.fail) this.onerror?.call(this, new Event('error'))
        else this.onload?.call(this)
      })
    },
    get(this: HTMLImageElement) {
      return ''
    },
    configurable: true,
  })
  Object.defineProperty(HTMLImageElement.prototype, 'width', { value: opts.width ?? 800, configurable: true })
  Object.defineProperty(HTMLImageElement.prototype, 'height', { value: opts.height ?? 600, configurable: true })
  void last
}

const ctxLog: Array<{ fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> }> = []
function stubCanvas(): void {
  ctxLog.length = 0
  HTMLCanvasElement.prototype.getContext = vi.fn(() => {
    const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), imageSmoothingQuality: '' }
    ctxLog.push(ctx)
    return ctx
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.toBlob = vi.fn(function (
    this: HTMLCanvasElement,
    cb: (b: Blob | null) => void,
    mime?: string,
  ) {
    cb(new Blob(['out'], { type: mime ?? 'image/png' }))
  }) as typeof HTMLCanvasElement.prototype.toBlob
}

const pngBlob = (): Blob => new Blob([new Uint8Array(8)], { type: 'image/png' })

beforeEach(() => {
  stubImageDecode()
  stubCanvas()
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('convertImage：格式转换', () => {
  it('png→jpeg：白底+95% 质量链路产出目标 mime', async () => {
    const out = await convertImage(pngBlob(), 'image/jpeg')
    expect(out.type).toBe('image/jpeg')
    expect(ctxLog[0]!.fillRect).toHaveBeenCalledWith(0, 0, 800, 600) // png→jpeg 自动白底
  })

  it('加载失败 → reject', async () => {
    stubImageDecode({ fail: true })
    await expect(convertImage(pngBlob(), 'image/webp')).rejects.toThrow(/Failed to load image/)
  })
})

describe('downscaleToMaxEdge：等比缩放', () => {
  it('长边 ≤ maxEdge：原 blob 直返（不再编码）', async () => {
    stubImageDecode({ width: 600, height: 400 })
    const blob = pngBlob()
    await expect(downscaleToMaxEdge(blob, 800)).resolves.toBe(blob)
  })

  it('长边超限：canvas 按 scale 重绘出图', async () => {
    stubImageDecode({ width: 1600, height: 800 })
    const out = await downscaleToMaxEdge(pngBlob(), 800)
    expect(out.type).toBe('image/png')
    expect(ctxLog[0]!.drawImage).toHaveBeenCalledTimes(1)
  })
})

describe('uploadViaApi：自定义接口上传', () => {
  it('FormData POST + dot path 取响应 URL', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { url: 'https://cdn/x.png' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const url = await uploadViaApi(pngBlob(), { url: '/up', responseUrlField: 'data.url' }, 'a.png')
    expect(url).toBe('https://cdn/x.png')
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe('/up')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
  })

  it('失败面：非 200 / 非 JSON / 取不到字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    await expect(uploadViaApi(pngBlob(), { url: '/up' }, 'a')).rejects.toThrow(/500/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })))
    await expect(uploadViaApi(pngBlob(), { url: '/up' }, 'a')).rejects.toThrow(/JSON/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })))
    await expect(uploadViaApi(pngBlob(), { url: '/up' }, 'a')).rejects.toThrow(/取不到 url/)
  })
})
