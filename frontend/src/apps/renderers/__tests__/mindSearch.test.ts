/**
 * mindSearch.ts 搜索浮条 DOM 工厂单测（MC3c-T2；模块已由 MC3c-C 落盘——本文件=行为规格守门）
 * 契约正本：.claude/mind-loop-state.md「MC3c 契约（锁定）」节；
 * 浮条桩契约（surface 侧）：mindEditor.test.ts「MC3c 大纲与搜索接线」块。
 *
 * 纯 DOM 工厂（零引擎 import）jsdom 直测，无需任何 vi.mock（mindPanel/mindOutline 同手法）。
 *
 * 工厂契约（本文件=可执行规格）：
 *  - createMindSearch(opts:{ el, t, onSearch(text), onNext?, onPrev?, onClose? })
 *      → { el, open(), close(), setCount(current, total), dispose() }（API 恰五成员）
 *  - 浮条根 div.mmagic-mind-search，create 即挂入宿主 el（absolute 浮层，面板/大纲同形态）；
 *    可见性 is-open 在场=显示、缺席=隐藏——初始隐藏（对齐 mindPanel/flow-editor 显隐惯例）
 *  - 控件定位（钉）：input（浮条唯一输入框，placeholder/aria-label=placeholder 键）、
 *    button[data-act="next"]、button[data-act="prev"]、计数区 .mmagic-mind-search__count
 *
 * 【断言面裁决（测试侧裁量钉死处；MC3c-T2 与 MC3c-C 落盘实现已对齐，改动须回本文件改钉）】
 *  - 键盘面（keydown，测试自 input 冒泡派发——实现挂 input/根监听两可）：
 *      Enter → onSearch(input.value) 恰调；同值再 Enter → onSearch 再调（同文=引擎原生 next，
 *      直通口径，Search.js:76-78 实测）；Shift+Enter → onPrev()；Esc → close（is-open 摘除）
 *      + onClose?.()（可选缺省不抛，Esc 恰上抛一次）
 *  - next 钮 → onNext?.()（surface 桩契约传 opts.onNext；Enter 路径已覆盖同文直通，
 *    钮面走 onNext 通道=与 mindEditor.test.ts MC3c 块的 opts 形态一致）；
 *    prev 钮 → onPrev?.()
 *  - 计数形态：setCount(current, total) 原样渲染 `${current}/${total}`（identity t 下 count 键
 *    无 {cur}/{total} 占位 → 直拼；locales 模板替换同值等价——surface 侧 0 基透传不换算，
 *    显示换算归本工厂域）；total=0 → 计数区留白（''，无 0/x 残留=空态；如需独立空态文案键，
 *    须回本文件+mindSearch.ts 双边改钉）
 *  - i18n 恰四键 app.mind-search.{placeholder,next,prev,count}：placeholder/next/prev 于
 *    create 期消费，count 经 setCount(total>0) 的 formatCount 消费（键集合按并集钉死）；
 *    locales zh-CN/en-US 现缺 mind-search.* 四键——双写归实现侧（本文件 identity t 不依赖
 *    locales 落盘）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMindSearch } from '../mindSearch'

/** mindSearch 工厂返回形状（落地后与 MindSearchApi 同形——保留本地声明隔离测试面） */
interface MindSearchApi {
  el: HTMLElement
  open(): void
  close(): void
  setCount(current: number, total: number): void
  dispose(): void
}

// ───────────────────────── 夹具与助手 ─────────────────────────

const hosts: HTMLDivElement[] = []
function makeHost(): HTMLDivElement {
  const h = document.createElement('div')
  document.body.appendChild(h)
  hosts.push(h)
  return h
}
afterEach(() => {
  for (const h of hosts) h.remove()
  hosts.length = 0
})

function makeT(): ReturnType<typeof vi.fn> {
  return vi.fn((k: string) => k)
}

/** 浮条创建助手：t=identity spy、onSearch/onNext/onPrev/onClose=spy（opts.onClose 显式 null 才真缺席） */
function create(opts: { onClose?: (() => void) | null } = {}) {
  const host = makeHost()
  const t = makeT()
  const onSearch = vi.fn()
  const onNext = vi.fn()
  const onPrev = vi.fn()
  const onClose = opts.onClose === null ? undefined : vi.fn()
  const api = createMindSearch({ el: host, t, onSearch, onNext, onPrev, onClose }) as unknown as MindSearchApi
  return {
    host,
    t,
    onSearch: onSearch as ReturnType<typeof vi.fn>,
    onNext: onNext as ReturnType<typeof vi.fn>,
    onPrev: onPrev as ReturnType<typeof vi.fn>,
    onClose: onClose as ReturnType<typeof vi.fn>,
    api,
  }
}

function inputOf(api: MindSearchApi): HTMLInputElement {
  const inputs = api.el.querySelectorAll<HTMLInputElement>('input')
  expect(inputs, '浮条应有恰一个输入框').toHaveLength(1)
  return inputs[0]!
}

function actBtnOf(api: MindSearchApi, act: 'next' | 'prev'): HTMLButtonElement {
  const btn = api.el.querySelector<HTMLButtonElement>(`button[data-act='${act}']`)
  expect(btn, `${act} 钮（data-act=${act}）应在浮条根内`).not.toBeNull()
  return btn!
}

function countElOf(api: MindSearchApi): HTMLElement {
  const el = api.el.querySelector<HTMLElement>('.mmagic-mind-search__count')
  expect(el, '计数区（.mmagic-mind-search__count）应在浮条根内').not.toBeNull()
  return el!
}

/** 键盘派发：自 input 冒泡（实现挂 input/根监听两可） */
function pressKey(input: HTMLInputElement, key: string, mods: KeyboardEventInit = {}): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }))
}

// ───────────────────────── 工厂与装配 ─────────────────────────

describe('工厂与装配', () => {
  it('返回 API 恰五成员 {el,open,close,setCount,dispose}；根挂入宿主+mmagic-mind-search 钉类；初始隐藏（is-open 缺席）', () => {
    const { host, api } = create()
    expect(Object.keys(api).sort()).toEqual(['close', 'dispose', 'el', 'open', 'setCount'])
    expect(api.el).toBeInstanceOf(HTMLElement)
    expect(api.el.parentElement).toBe(host)
    expect(api.el.classList.contains('mmagic-mind-search')).toBe(true)
    expect(api.el.classList.contains('is-open')).toBe(false)
  })

  it('i18n 四键集合钉死（并集）：placeholder/next/prev 于 create 期消费，count 经 setCount(total>0) 消费——承载面 placeholder 进 input、next/prev 进钮面', () => {
    const { t, api } = create()
    // create 期：placeholder/prev/next 三键（count 键留待计数回传消费）
    const created = [...new Set(t.mock.calls.map((c) => c[0] as string))].sort()
    expect(created).toEqual(['app.mind-search.next', 'app.mind-search.placeholder', 'app.mind-search.prev'])
    // 承载面：placeholder 经 input.placeholder 与 aria-label（identity t → 键原文）
    const input = inputOf(api)
    expect(input.placeholder).toBe('app.mind-search.placeholder')
    expect(input.getAttribute('aria-label')).toBe('app.mind-search.placeholder')
    // next/prev 钮面：title/aria-label/textContent 至少一处走 t()（identity t → 含键原文）
    for (const [act, key] of [
      ['next', 'app.mind-search.next'],
      ['prev', 'app.mind-search.prev'],
    ] as const) {
      const btn = actBtnOf(api, act)
      const face = [btn.getAttribute('title'), btn.getAttribute('aria-label'), btn.textContent].filter(Boolean)
      expect(face, `${act} 钮 i18n 面（${key}）`).toContain(key)
    }
    // 计数回传后：count 键入册——四键并集恰为钉死集合（无第五键）
    api.setCount(2, 5)
    const all = [...new Set(t.mock.calls.map((c) => c[0] as string))].sort()
    expect(all).toEqual([
      'app.mind-search.count',
      'app.mind-search.next',
      'app.mind-search.placeholder',
      'app.mind-search.prev',
    ])
  })
})

// ───────────────────────── 显隐 ─────────────────────────

describe('显隐', () => {
  it('open/close 显隐（is-open）：open 加类显示、close 摘类隐藏（对齐面板/大纲显隐惯例）', () => {
    const { api } = create()
    api.open()
    expect(api.el.classList.contains('is-open')).toBe(true)
    api.close()
    expect(api.el.classList.contains('is-open')).toBe(false)
    api.open()
    expect(api.el.classList.contains('is-open')).toBe(true)
  })
})

// ───────────────────────── 搜索与翻页交互 ─────────────────────────

describe('搜索与翻页交互', () => {
  it('Enter → onSearch(input.value) 恰调一次（payload=输入框当前值）', () => {
    const { api, onSearch } = create()
    const input = inputOf(api)
    input.value = '分支'
    pressKey(input, 'Enter')
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('分支')
  })

  it('同值再 Enter → onSearch 再调（两次同值——同文=引擎原生 next，直通口径，不做本地去重/换文本）', () => {
    const { api, onSearch } = create()
    const input = inputOf(api)
    input.value = '分支'
    pressKey(input, 'Enter')
    pressKey(input, 'Enter')
    expect(onSearch).toHaveBeenCalledTimes(2)
    expect(onSearch).toHaveBeenNthCalledWith(1, '分支')
    expect(onSearch).toHaveBeenNthCalledWith(2, '分支')
  })

  it('next 钮 → onNext 恰调一次（surface 通道；onSearch/onPrev 不动——Enter 路径已覆盖同文直通）', () => {
    const { api, onSearch, onNext, onPrev } = create()
    const input = inputOf(api)
    input.value = '子节点'
    actBtnOf(api, 'next').click()
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onSearch).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('prev 钮 → onPrev 恰调一次（onSearch/onNext 不动）', () => {
    const { api, onSearch, onNext, onPrev } = create()
    const input = inputOf(api)
    input.value = '分支'
    actBtnOf(api, 'prev').click()
    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onSearch).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
  })

  it('Shift+Enter → onPrev 调（onSearch 零调——Shift+Enter=前一个，不触发搜索）', () => {
    const { api, onSearch, onPrev } = create()
    const input = inputOf(api)
    input.value = '分支'
    pressKey(input, 'Enter', { shiftKey: true })
    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onSearch).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 计数回传 ─────────────────────────

describe('计数回传', () => {
  it("setCount(2,5) → 计数区渲染 '2/5'（原样数字形，不做 0 基换算——显示形态钉，见文件头裁决）", () => {
    const { api } = create()
    api.setCount(2, 5)
    expect(countElOf(api).textContent).toBe('2/5')
  })

  it('setCount(0,0) → 空态：计数区留白（空文案，无 0/x 残留——空态语义钉，见文件头裁决）', () => {
    const { api } = create()
    api.setCount(0, 0)
    expect(countElOf(api).textContent).toBe('')
  })

  it('setCount 再更新：2/5 → 3/5 覆盖渲染（不残留旧计数）', () => {
    const { api } = create()
    api.setCount(2, 5)
    api.setCount(3, 5)
    expect(countElOf(api).textContent).toBe('3/5')
  })
})

// ───────────────────────── 关闭与销毁 ─────────────────────────

describe('关闭与销毁', () => {
  it('Esc → close（is-open 摘除隐藏）+ onClose 恰上抛一次；onClose 缺省（可选契约）Esc 不抛', () => {
    const { api, onClose } = create()
    api.open()
    pressKey(inputOf(api), 'Escape')
    expect(api.el.classList.contains('is-open')).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
    // onClose 可选：不传时 Esc 仍隐藏且不抛
    const api2 = createMindSearch({
      el: makeHost(),
      t: makeT(),
      onSearch: vi.fn(),
      onNext: vi.fn(),
      onPrev: vi.fn(),
    }) as unknown as MindSearchApi
    api2.open()
    expect(() => pressKey(inputOf(api2), 'Escape')).not.toThrow()
    expect(api2.el.classList.contains('is-open')).toBe(false)
  })

  it('dispose：根摘出宿主（host 不再包含 el）；重复 dispose 幂等不抛', () => {
    const { host, api } = create()
    expect(host.contains(api.el)).toBe(true)
    api.dispose()
    expect(host.contains(api.el)).toBe(false)
    expect(() => api.dispose()).not.toThrow()
  })
})
