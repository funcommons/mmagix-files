/**
 * utils 小模块合集单测：storage（localStorage JSON 序列化）/ trace（sessionStorage trace-id）/
 * download（锚点下载）/ logger（dev 门控）/ colorHash（djb2→HSL）。
 * 注：Node ≥23 存在实验性全局 localStorage（无 --localstorage-file 时 setItem 静默失效）——
 * 测试内无条件覆写为内存桩（jsdom 真库行为不可依赖，setup.ts 只兜「缺失」场景）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { colorActive, colorIdle } from '../colorHash'
import { triggerDownload } from '../download'
import { logger } from '../logger'
import { getOrCreateTraceId, TRACE_ID_STORAGE_KEY } from '../trace'
import { loadJSON, mergeJSON, saveJSON } from '../storage'

/** 内存 Storage 桩（window 与 globalThis 同源覆写——jsdom 二者本同体） */
function installMemStorage(name: 'localStorage' | 'sessionStorage'): void {
  const mem = new Map<string, string>()
  const fake = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() {
      return mem.size
    },
  }
  Object.defineProperty(window, name, { value: fake, configurable: true })
  Object.defineProperty(globalThis, name, { value: fake, configurable: true })
}

beforeEach(() => {
  installMemStorage('localStorage')
  installMemStorage('sessionStorage')
})

// ───────────────────────── storage ─────────────────────────

describe('storage：loadJSON/saveJSON/mergeJSON', () => {
  it('save→load 往返；缺 key 回 fallback', () => {
    saveJSON('k1', { a: 1 })
    expect(loadJSON('k1', { a: 0 })).toEqual({ a: 1 })
    expect(loadJSON('missing', 'fb')).toBe('fb')
  })

  it('prefix 命名空间隔离', () => {
    saveJSON('k', 'plain', { prefix: 'ns1:' })
    saveJSON('k', 'other', { prefix: 'ns2:' })
    expect(loadJSON('k', '', { prefix: 'ns1:' })).toBe('plain')
    expect(loadJSON('k', '', { prefix: 'ns2:' })).toBe('other')
  })

  it('mergeJSON：持久化值覆盖同名字段，其余保留 fallback', () => {
    window.localStorage.setItem('m1', JSON.stringify({ b: 9 }))
    expect(mergeJSON('m1', { a: 1, b: 0, c: 3 })).toEqual({ a: 1, b: 9, c: 3 })
    expect(mergeJSON('missing-merge', { a: 1 })).toEqual({ a: 1 })
  })

  it('坏 JSON 不抛错回 fallback', () => {
    window.localStorage.setItem('bad', '{oops')
    expect(loadJSON('bad', 'fb')).toBe('fb')
  })
})

// ───────────────────────── trace ─────────────────────────

describe('trace：getOrCreateTraceId（会话内复用）', () => {
  it('首次生成 uuid 并写入 sessionStorage；再取复用同一 id', () => {
    sessionStorage.removeItem(TRACE_ID_STORAGE_KEY)
    const id1 = getOrCreateTraceId()
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)
    expect(sessionStorage.getItem(TRACE_ID_STORAGE_KEY)).toBe(id1)
    expect(getOrCreateTraceId()).toBe(id1)
  })
})

// ───────────────────────── download ─────────────────────────

describe('download：triggerDownload（锚点挂载→click→移除）', () => {
  it('a 元素带 href/download 且用后即焚', () => {
    const before = document.body.children.length
    triggerDownload('blob:http://x/y', 'out.png')
    expect(document.body.children.length).toBe(before)
    expect(document.querySelector('a[href="blob:http://x/y"]')).toBeNull()
  })

  it('SSR（无 document）静默', () => {
    const doc = globalThis.document
    delete (globalThis as { document?: unknown }).document
    expect(() => triggerDownload('u', 'n')).not.toThrow()
    globalThis.document = doc
  })
})

// ───────────────────────── logger ─────────────────────────

describe('logger：dev 门控（vitest DEV=true）', () => {
  it('debug/log 透传 console；warn/error 恒透传', () => {
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.debug('d', 1)
    logger.log('l')
    logger.warn('w')
    logger.error('e')
    expect(dbg).toHaveBeenCalledWith('d', 1)
    expect(log).toHaveBeenCalledWith('l')
    expect(warn).toHaveBeenCalledWith('w')
    expect(err).toHaveBeenCalledWith('e')
    dbg.mockRestore()
    log.mockRestore()
    warn.mockRestore()
    err.mockRestore()
  })
})

// ───────────────────────── colorHash ─────────────────────────

describe('colorHash：djb2 → HSL 唯一色', () => {
  it('同输入同色（跨刷新一致）；active/idle 同色相系', () => {
    const a1 = colorActive('写作')
    const a2 = colorActive('写作')
    expect(a1).toBe(a2)
    expect(a1).toMatch(/^hsl\(\d+, 70%, 38%\)$/)
    const idle = colorIdle('写作')
    expect(idle.bg).toMatch(/^hsl\(\d+, 30%, 98%\)$/)
    const hueOf = (s: string): number => Number(s.match(/hsl\((\d+),/)![1]!)
    expect(hueOf(a1)).toBe(hueOf(idle.bg))
    expect(colorActive('图')).not.toBe(colorActive('文'))
  })
})
