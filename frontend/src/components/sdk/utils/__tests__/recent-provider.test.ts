/**
 * recentProvider 单测（2026-10-29 修复回归锁）：createLocalStorageRecentProvider 全契约
 * （load/add 去重前置/limit 截断/validate 门控/remove/clear/坏 JSON 容错）+
 * useRecentProvider 乐观更新集成。
 * 注：原实现调 useRecentList 上不存在的 list.add/list.getAll → 一调即抛被上层 catch 吞
 * （「最近使用」静默失效）——本文件即修复回归锁。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalStorageRecentProvider, useRecentProvider } from '../recentProvider'

/** 内存 Storage 桩（window+globalThis 同源覆写） */
function installMemStorage(): void {
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
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true })
}

beforeEach(() => {
  installMemStorage()
})

describe('createLocalStorageRecentProvider：全契约', () => {
  it('load 空起步；add 去重前置；超出 limit 截断；持久化到 localStorage', async () => {
    const p = createLocalStorageRecentProvider<string>('t1', { limit: 3 })
    await expect(p.load()).resolves.toEqual([])

    await p.add('a')
    await p.add('b')
    await p.add('a') // 去重前置（a 已在首，位置不变）
    await expect(p.load()).resolves.toEqual(['a', 'b'])
    await p.add('c')
    await p.add('d') // limit 3：最老 b 出局
    await expect(p.load()).resolves.toEqual(['d', 'c', 'a'])
    expect(JSON.parse(window.localStorage.getItem('ux:recent:t1')!)).toEqual(['d', 'c', 'a'])
  })

  it('validate 门控：false 跳过不入列', async () => {
    const p = createLocalStorageRecentProvider<string>('t2', { validate: (u) => u.startsWith('https://') })
    await p.add('http://insecure')
    await p.add('https://ok')
    await expect(p.load()).resolves.toEqual(['https://ok'])
  })

  it('remove 删单条；clear 清空', async () => {
    const p = createLocalStorageRecentProvider<string>('t3')
    await p.add('a')
    await p.add('b')
    await p.remove('a')
    await expect(p.load()).resolves.toEqual(['b'])
    await p.clear()
    await expect(p.load()).resolves.toEqual([])
    expect(window.localStorage.getItem('ux:recent:t3')).toBeNull()
  })

  it('坏 JSON 容错：load 回空数组不抛', async () => {
    window.localStorage.setItem('ux:recent:bad', '{oops')
    const p = createLocalStorageRecentProvider<string>('bad')
    await expect(p.load()).resolves.toEqual([])
    await p.add('x') // 坏底上继续可用
    await expect(p.load()).resolves.toEqual(['x'])
  })

  it('对象条目同样工作（引用全等去重）', async () => {
    const p = createLocalStorageRecentProvider<{ id: string }>('t4')
    const o1 = { id: '1' }
    await p.add(o1)
    await p.add({ id: '2' })
    await p.add(o1) // 去重前置（o1 已在首，位置不变）
    await expect(p.load()).resolves.toEqual([{ id: '1' }, { id: '2' }])
  })
})

describe('useRecentProvider：乐观更新集成（配默认 provider）', () => {
  it('ready 流转 + add/remove/clear 乐观生效且落库', async () => {
    const provider = createLocalStorageRecentProvider<string>('t5')
    const r = useRecentProvider(provider, 12)
    expect(r.ready.value).toBe(false)
    await vi.waitFor(() => expect(r.ready.value).toBe(true))
    expect(r.items.value).toEqual([])

    await r.add('u1')
    await r.add('u2')
    expect(r.items.value).toEqual(['u2', 'u1'])
    expect(await provider.load()).toEqual(['u2', 'u1']) // 双写一致

    await r.remove('u1')
    expect(r.items.value).toEqual(['u2'])
    expect(await provider.load()).toEqual(['u2'])

    await r.clear()
    expect(r.items.value).toEqual([])
    expect(await provider.load()).toEqual([])
    expect(r.getAll()).toEqual([])
  })
})
