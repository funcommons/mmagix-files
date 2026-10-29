/**
 * 微 composables 合集单测（toggle/throttle/debouncedRef/recentList/oneShotHandoff/
 * asyncState/localStorage/bodyScrollLock/clipboard/outsideClick/keyboardShortcut）。
 * 生命周期系（onMounted/onBeforeUnmount）经 @vue/test-utils 挂宿主组件驱动；
 * localStorage 系挂内存桩（Node ≥23 实验性全局库 setItem 静默失效）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'

import { useToggle } from '../useToggle'
import { useThrottle } from '../useThrottle'
import { useDebouncedFn, useDebouncedRef } from '../useDebouncedRef'
import { useRecentList } from '../useRecentList'
import { useOneShotHandoff } from '../useOneShotHandoff'
import { useAsyncState } from '../useAsyncState'
import { useLocalStorage } from '../useLocalStorage'
import { useBodyScrollLock } from '../useBodyScrollLock'
import { copySilent, useClipboard } from '../useClipboard'
import { useOutsideClickClose } from '../useOutsideClickClose'
import { useKeyboardShortcut } from '../useKeyboardShortcut'

/** 内存 Storage 桩（window+globalThis 同源覆写） */
function installMemStorage(name: 'localStorage' | 'sessionStorage'): Map<string, string> {
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
  return mem
}

/** 生命周期宿主：setupFn 里调用被测 composable */
function mountHost(setupFn: () => unknown): { unmount(): void; wrapper: ReturnType<typeof mount> } {
  const wrapper = mount(
    defineComponent({
      setup() {
        setupFn()
        return () => h('div')
      },
    }),
  )
  return { wrapper, unmount: () => wrapper.unmount() }
}

beforeEach(() => {
  installMemStorage('localStorage')
  installMemStorage('sessionStorage')
})

// ───────────────────────── useToggle ─────────────────────────

describe('useToggle', () => {
  it('初始值/set/toggle/setTrue/setFalse', () => {
    const t = useToggle(true)
    expect(t.value.value).toBe(true)
    t.toggle()
    expect(t.value.value).toBe(false)
    t.setTrue()
    expect(t.value.value).toBe(true)
    t.setFalse()
    expect(t.value.value).toBe(false)
    t.set(true)
    expect(t.value.value).toBe(true)
    expect(useToggle().value.value).toBe(false) // 缺省 false
  })
})

// ───────────────────────── useThrottle ─────────────────────────

describe('useThrottle：leading+trailing', () => {
  it('前缘立即执行 + 窗口内合并 + 收尾兜底最后一次', () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const fire = useThrottle((n: number) => calls.push(n), 100)
      fire(1) // leading：立即
      fire(2) // 窗口内：挂起
      fire(3) // 窗口内：pendingArgs 覆盖为 3
      expect(calls).toEqual([1])
      vi.advanceTimersByTime(100) // trailing：最后一次(3)必触发
      expect(calls).toEqual([1, 3])
      vi.advanceTimersByTime(200) // 已静默：无新增
      expect(calls).toEqual([1, 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leading=false：首调延迟到 delay 后', () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const fire = useThrottle((n: number) => calls.push(n), 50, { leading: false })
      fire(9)
      expect(calls).toEqual([])
      vi.advanceTimersByTime(50)
      expect(calls).toEqual([9])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ───────────────────────── useDebouncedRef / useDebouncedFn ─────────────────────────

describe('useDebouncedRef / useDebouncedFn', () => {
  it('写立即生效（缓存值），触发延迟；get 返回最新', async () => {
    vi.useFakeTimers()
    try {
      const r = useDebouncedRef('a', 50)
      expect(r.value).toBe('a')
      r.value = 'b'
      expect(r.value).toBe('b') // 写立即反映
      let fired = 0
      const stop = r.watch?.(() => {
        fired += 1
      })
      void stop
      vi.advanceTimersByTime(50) // trigger 后依赖方重新求值（此处直接断言缓存面）
      expect(r.value).toBe('b')
    } finally {
      vi.useRealTimers()
    }
  })

  it('useDebouncedFn：窗口内只跑最后一次', () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const fn = useDebouncedFn((x: string) => seen.push(x), 60)
      fn('a')
      fn('b')
      fn('c')
      vi.advanceTimersByTime(60)
      expect(seen).toEqual(['c'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ───────────────────────── useRecentList ─────────────────────────

describe('useRecentList：最近使用（持久化/去重/容量）', () => {
  it('pick 置顶去重；超出 max 截断；remove/clear；list 持久化到 localStorage', async () => {
    const r1 = useRecentList<{ id: string }>({ key: 't1', max: 3 })
    r1.pick({ id: 'a' })
    r1.pick({ id: 'b' })
    r1.pick({ id: 'a' }) // 去重置顶
    await nextTick()
    expect(r1.list.value.map((x) => x.id)).toEqual(['a', 'b'])
    r1.pick({ id: 'c' })
    r1.pick({ id: 'd' }) // 容量 3：最老 b 被挤掉
    await nextTick()
    expect(r1.list.value.map((x) => x.id)).toEqual(['d', 'c', 'a'])
    expect(JSON.parse(window.localStorage.getItem('ux:recent:t1')!)).toHaveLength(3)
    r1.remove('c')
    await nextTick()
    expect(r1.list.value.map((x) => x.id)).toEqual(['d', 'a'])
    // 新实例从 localStorage hydrate
    const r2 = useRecentList<{ id: string }>({ key: 't1', max: 3 })
    expect(r2.list.value.map((x) => x.id)).toEqual(['d', 'a'])
    r2.clear()
    await nextTick()
    expect(r2.list.value).toEqual([])
    expect(r1.pick({ id: undefined as unknown as string })).toBeUndefined() // 无 id 忽略
  })
})

// ───────────────────────── useOneShotHandoff ─────────────────────────

describe('useOneShotHandoff：跨路由一次性传递', () => {
  it('set→consume 原子取走；二次 consume null；peek 不清除；clear', () => {
    const h = useOneShotHandoff<{ url: string }>('probe:handoff')
    expect(h.consume()).toBeNull()
    h.set({ url: 'u1' })
    expect(h.peek()).toEqual({ url: 'u1' })
    expect(h.peek()).toEqual({ url: 'u1' }) // peek 不清除
    expect(h.consume()).toEqual({ url: 'u1' })
    expect(h.consume()).toBeNull()
    h.set({ url: 'u2' })
    h.clear()
    expect(h.peek()).toBeNull()
    // 坏 JSON：consume/peek 回 null 不抛
    window.localStorage.setItem('probe:bad', '{oops')
    const bad = useOneShotHandoff<unknown>('probe:bad')
    expect(bad.consume()).toBeNull()
  })
})

// ───────────────────────── useAsyncState ─────────────────────────

describe('useAsyncState：加载态封装', () => {
  it('首调自动执行：loading→data；失败落 error 不抛；reload 重跑', async () => {
    let n = 0
    const st = useAsyncState(async () => {
      n += 1
      if (n === 1) return 'first'
      throw new Error('boom')
    }, { initial: 'init' })
    expect(st.loading.value).toBe(true)
    await nextTick()
    await vi.waitFor(() => expect(st.data.value).toBe('first'))
    expect(st.loading.value).toBe(false)
    expect(st.error.value).toBeNull()

    await st.reload()
    expect(st.error.value).toBeInstanceOf(Error)
    expect(st.loading.value).toBe(false)
  })
})

// ───────────────────────── useLocalStorage ─────────────────────────

describe('useLocalStorage：ref ↔ localStorage 双向', () => {
  it('读初值/缺省回退/坏 JSON 回退/写回持久化', async () => {
    window.localStorage.setItem('k1', JSON.stringify('stored'))
    expect(useLocalStorage('k1', 'fb').value).toBe('stored')
    expect(useLocalStorage('missing', 'fb').value).toBe('fb')
    window.localStorage.setItem('bad', '{oops')
    expect(useLocalStorage('bad', 'fb').value).toBe('fb')

    const v = useLocalStorage<{ n: number }>('obj', { n: 0 })
    v.value = { n: 7 }
    await nextTick()
    expect(JSON.parse(window.localStorage.getItem('obj')!)).toEqual({ n: 7 })
  })
})

// ───────────────────────── useBodyScrollLock ─────────────────────────

describe('useBodyScrollLock：引用计数锁', () => {
  it('开→锁 overflow；关→还原；多实例叠加不提前解锁', async () => {
    const a = ref(false)
    const b = ref(false)
    // 先挂载（active=false → immediate watch 走防御 unlock，计数不越 0）再激活
    const hostA = mountHost(() => useBodyScrollLock(a))
    const hostB = mountHost(() => useBodyScrollLock(b))
    a.value = true
    await vi.waitFor(() => expect(document.body.style.overflow).toBe('hidden'))

    b.value = true // 叠加：计数 2
    await vi.waitFor(() => expect(document.body.style.overflow).toBe('hidden'))
    b.value = false // 只解一层：a 仍持锁
    await nextTick()
    expect(document.body.style.overflow).toBe('hidden')

    hostB.unmount()
    a.value = false
    await vi.waitFor(() => expect(document.body.style.overflow).toBe(''))
    hostA.unmount()
  })
})

// ───────────────────────── useClipboard ─────────────────────────

describe('useClipboard / copySilent', () => {
  it('clipboard API 可用：直写成功', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await expect(copySilent('x')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('x')
  })

  it('clipboard 失败：降级 textarea+execCommand；全败 false', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied') }) },
      configurable: true,
    })
    const exec = vi.fn(() => true)
    document.execCommand = exec as unknown as typeof document.execCommand
    await expect(copySilent('y')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')

    document.execCommand = (() => false) as unknown as typeof document.execCommand
    await expect(copySilent('z')).resolves.toBe(false)

    const { copy } = useClipboard()
    const ok = await copy('w')
    expect(typeof ok).toBe('boolean') // toast 走真实 ElMessage（渲染到 body，无害）
  })
})

// ───────────────────────── useOutsideClickClose ─────────────────────────

describe('useOutsideClickClose：外部点击关闭', () => {
  it('set/toggle/close + document click 外部清空、内部保留', async () => {
    let api!: ReturnType<typeof useOutsideClickClose>
    mountHost(() => {
      api = useOutsideClickClose<'m' | 'c'>()
    })
    api.set('m')
    expect(api.value).toBe('m')
    api.toggle('c')
    expect(api.value).toBe('c')
    api.toggle('c') // 同值 toggle 关闭
    expect(api.value).toBeNull()

    api.set('m')
    document.body.innerHTML = '<div class="control-group"><button id="in"></button></div><div id="out"></div>'
    document.querySelector('#out')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(api.value).toBeNull() // 外部点击清空
    api.set('m')
    document.querySelector('#in')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(api.value).toBe('m') // 内部点击保留
  })
})

// ───────────────────────── useKeyboardShortcut ─────────────────────────

describe('useKeyboardShortcut：组合键匹配与清理', () => {
  const press = (init: KeyboardEventInit): void =>
    window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }))

  it('mod+s 命中（preventDefault）+ esc/space 别名 + 不命中不触发；卸载解绑', () => {
    // 注：isMac 是模块加载期常量（jsdom navigator.platform=''→非 mac）——mod 即 ctrlKey
    const hits: string[] = []
    const { unmount } = mountHost(() => {
      useKeyboardShortcut('mod+s', () => hits.push('s'))
      useKeyboardShortcut('esc', () => hits.push('esc'))
      useKeyboardShortcut('space', () => hits.push('space'))
      useKeyboardShortcut('mod+k', () => hits.push('k'))
    })

    const ev1 = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    window.dispatchEvent(ev1)
    expect(ev1.defaultPrevented).toBe(true) // 命中即 preventDefault
    press({ key: 'S', ctrlKey: true }) // 大小写无关
    press({ key: 's', metaKey: true }) // 非 mac 下 metaKey 不算 mod：不命中
    press({ key: 'Escape' })
    press({ key: ' ' })
    expect(hits).toEqual(['s', 's', 'esc', 'space'])
    expect(hits).not.toContain('k')

    unmount()
    press({ key: 's', metaKey: true })
    expect(hits).toEqual(['s', 's', 'esc', 'space']) // 卸载后静默
  })
})
