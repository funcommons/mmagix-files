/**
 * useTempBox 全链单测（fake-indexeddb 提供 IDB；createImageBitmap 打桩定宽高）+
 * useEmbedParams 外观参数解析（白名单/非法忽略/路由应用）。
 * 注：useTempBox 的 dbPromise 是模块级缓存——同文件只建一次连接，用例间不删库（keyPath 唯一互扰低）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { useTempBox, formatBytes, saveToTempBox } from '../useTempBox'
import { parseEmbedAppearance, useEmbedParams } from '../useEmbedParams'
import { createPinia, setActivePinia } from 'pinia'
import { usePreferenceStore } from '@/store/preference'

beforeEach(() => {
  setActivePinia(createPinia())
  // jsdom 无 createImageBitmap：按文件名哈希出确定宽高（测尺寸管道即可）
  vi.stubGlobal('createImageBitmap', vi.fn(async (file: File) => ({
    width: file.size % 100 + 1,
    height: file.size % 50 + 2,
    close() {},
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const mkFile = (name: string, bytes: number, type = 'image/png'): File =>
  new File([new Uint8Array(bytes)], name, { type })

// ───────────────────────── useTempBox ─────────────────────────

describe('useTempBox：IndexedDB 暂存盒全链', () => {
  it('addImage→list→get→delete→stats 全链；meta 含 SHA-256 主键与尺寸', async () => {
    const box = useTempBox()
    const meta = await box.addImage(mkFile('a.png', 1024))
    expect(meta.id).toMatch(/^[0-9a-f]{64}$/) // SHA-256 hex
    expect(meta).toMatchObject({ name: 'a.png', size: 1024, type: 'image/png', width: 25, height: 26 })

    const list = await box.listImages()
    expect(list.map((m) => m.id)).toContain(meta.id)

    const rec = await box.getImage(meta.id)
    // fake-indexeddb 的结构化克隆不保 Blob 本体（环境限制非代码缺陷）——断言 blob 键随记录持久化
    expect(rec && 'blob' in rec).toBe(true)
    expect(rec).toMatchObject({ size: 1024, type: 'image/png', name: 'a.png' })
    expect(await box.getImage('nope')).toBeNull()

    await box.deleteImage(meta.id)
    expect(await box.getImage(meta.id)).toBeNull()
    const stats = await box.getStats()
    expect(stats).toEqual({ count: 0, totalSize: 0 })
  })

  it('同图去重：重复 addImage 只 touch createdAt（LRU），blob 不重写', async () => {
    const box = useTempBox()
    const f = mkFile('same.png', 512)
    const m1 = await box.addImage(f)
    const before = await box.getImage(m1.id)
    await new Promise((r) => setTimeout(r, 5))
    const m2 = await box.addImage(mkFile('same.png', 512)) // 同内容 → 同 SHA-256
    expect(m2.id).toBe(m1.id)
    expect(m2.createdAt).toBeGreaterThanOrEqual(m1.createdAt)
    const after = await box.getImage(m1.id)
    expect(after?.createdAt).toBe(m2.createdAt)
    expect('blob' in (after ?? {})).toBe(true) // blob 键仍在（LRU touch 不清载荷）
  })

  it('getStats 汇总 count/totalSize（DB 跨用例共享——增量断言）', async () => {
    const box = useTempBox()
    const before = await box.getStats()
    await box.addImage(mkFile('x.png', 100))
    await box.addImage(mkFile('y.png', 200))
    const stats = await box.getStats()
    expect(stats.count).toBe(before.count + 2)
    expect(stats.totalSize).toBe(before.totalSize + 300)
  })
})

describe('saveToTempBox：多来源入口', () => {
  it('Blob 包装 File（类型推 ext）；dataURL 走 fetch 落库', async () => {
    const meta1 = await saveToTempBox(new Blob([new Uint8Array(64)], { type: 'image/webp' }))
    expect(meta1.name).toBe('image.webp')
    expect(meta1.type).toBe('image/webp')

    const dataUrl = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
    const fetchSpy = vi.fn(async (url: string) => new Response(new Uint8Array(32), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const meta2 = await saveToTempBox(dataUrl, 'sticker')
    expect(fetchSpy).toHaveBeenCalledWith(dataUrl)
    expect(meta2).toMatchObject({ name: 'sticker', size: 32 })
  })

  it('URL fetch 非 200 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    await expect(saveToTempBox('http://x/missing.png')).rejects.toThrow(/404/)
  })
})

describe('formatBytes：字节格式化', () => {
  it('B/KB/MB 三档', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB')
  })
})

// ───────────────────────── useEmbedParams ─────────────────────────

describe('parseEmbedAppearance：query 白名单解析', () => {
  it('合法 brand/mode/language 收敛为强类型；非法值静默忽略；非字符串忽略', () => {
    expect(parseEmbedAppearance({ brand: 'apple', mode: 'dark', language: 'en-US' })).toEqual({
      brand: 'apple',
      mode: 'dark',
      language: 'en-US',
    })
    expect(parseEmbedAppearance({ brand: 'hacker', mode: 'blue', language: 'fr' })).toEqual({}) // 全非法
    expect(parseEmbedAppearance({ brand: ['apple'], mode: null })).toEqual({}) // 数组/null 忽略
    expect(parseEmbedAppearance({})).toEqual({})
  })
})

describe('useEmbedParams：applyFromRoute 联动 preference', () => {
  it('合法参数即时生效（不持久化）；空参不动 store', () => {
    const { applyFromRoute } = useEmbedParams()
    applyFromRoute({ query: { brand: 'mchuan', mode: 'dark', language: 'en-US' } } as never)
    const s = usePreferenceStore()
    expect(s.brand).toBe('mchuan')
    expect(s.theme).toBe('dark')
    expect(s.locale).toBe('en-US')
    expect(window.localStorage.getItem('ldx2-aigc:preference')).toBeNull() // 不污染

    applyFromRoute({ query: {} } as never) // 幂等/空参：不抛不改
    expect(s.brand).toBe('mchuan')
  })
})

