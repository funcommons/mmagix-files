/**
 * mindPanel.ts 属性面板 DOM 工厂单测（MC3b-T 测试先行——模块未实现，全文件红=预期）
 * 契约正本：.claude/mind-loop-state.md「MC3b 契约（锁定）」节
 *
 * 【测试先行】frontend/src/apps/renderers/mindPanel.ts 由 MC3b-C 子代理实现——本文件
 * import '../mindPanel' 解析失败 → 全文件红=预期（模块缺失红，非断言红）。
 * mindPanel 为纯 DOM 工厂（零引擎 import），jsdom 直测，无需任何 vi.mock。
 *
 * 工厂契约（本文件=可执行规格，MC3b-C 按此实现）：
 *  - createMindPanel(opts:{ el, t, onEdit(patch), onClose? })
 *      → { el, setNode(decos), clear(), dispose() }
 *  - 面板根 div.mmagic-mind-panel（absolute 浮层钉类名），create 时挂入宿主 el
 *    （absolute 定位语义经钉类名承载；scoped 全 token 化样式归 MC3b-C 红线，jsdom 不验算样式）
 *  - 可见性：is-open 在场=显示（节点激活）、缺席=隐藏（无激活/清除）——初始隐藏；
 *    对齐 flow-editor 属性面板 is-open 惯例（flow-editor.ts:491）
 *  - 字段控件定位（钉）：textarea[data-field="note"]、
 *    input[data-field="image"|"hyperlink"|"tags"|"generalization"]
 *  - i18n 键集（钉死恰六键）：app.mind-panel.{note,image,hyperlink,tags,generalization,close}
 *    ——契约「六键+title」歧义取「六键=五字段标签+关闭钮」解释：面板无标题栏文本键，
 *    关闭钮 button[data-act='close'] 文案/aria-label 共用 close 键；如需独立 title 键须回本文件改钉
 *
 * 行为契约：
 *  - setNode(decos)：先全清后回填——未提及字段不残留上一节点值（clear-then-edit 语义钉）；
 *    tags（string[]）→逗号串；generalization（{text} 信封，与 nodeMeta/引擎 data 同形）→拆 .text 显示
 *  - 编辑交互：控件 'change'（冒泡）→ onEdit(单字段 patch)：note/hyperlink→string；
 *    tags→split(',')+trim+滤空 string[]；image→string 过 isSafeImageUrl 闸；generalization→{text}
 *  - 清除语义：字段清空（空串/全空段）→ patch 键在场、值 undefined（契约「值为 undefined=
 *    清除该装饰」）——image 空串属清除非非法（守卫只拦非空非法值）
 *  - image 非空非法（javascript:/data: 等）→ onEdit 不调 + input 挂 .is-invalid；改回合法即摘除
 *  - clear()：五字段全空 + is-open 移除；dispose()：面板根摘出宿主 + 幂等
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMindPanel } from '../mindPanel'
import { isSafeImageUrl } from '../../mind/meta'

/** mindPanel 工厂返回形状（模块落地前的本地最小声明——落地后可换 import type） */
interface MindPanelApi {
  el: HTMLElement
  setNode(decos: Record<string, unknown>): void
  clear(): void
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

/** 面板创建助手：t=identity spy、onEdit/onClose=spy（opts.onClose 显式 null 才真缺席） */
function create(opts: { onClose?: (() => void) | null } = {}) {
  const host = makeHost()
  const t = makeT()
  const onEdit = vi.fn()
  const onClose = opts.onClose === null ? undefined : vi.fn()
  const api = createMindPanel({ el: host, t, onEdit, onClose }) as unknown as MindPanelApi
  return {
    host,
    t,
    onEdit: onEdit as ReturnType<typeof vi.fn>,
    onClose: onClose as ReturnType<typeof vi.fn>,
    api,
  }
}

function noteOf(api: MindPanelApi): HTMLTextAreaElement {
  const ta = api.el.querySelector<HTMLTextAreaElement>('textarea[data-field="note"]')
  expect(ta, 'note 字段（textarea[data-field=note]）应在面板根内').not.toBeNull()
  return ta!
}

function fieldOf(api: MindPanelApi, name: string): HTMLInputElement {
  const input = api.el.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)
  expect(input, `${name} 字段（input[data-field=${name}]）应在面板根内`).not.toBeNull()
  return input!
}

/** 控件改值 + change（冒泡——实现侧委托监听或直挂均可达） */
function change(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// ───────────────────────── 工厂与装配 ─────────────────────────

describe('工厂与装配', () => {
  it('返回 API 恰四成员 {el,setNode,clear,dispose}；面板根挂入宿主+mmagic-mind-panel 钉类；初始隐藏（is-open 缺席=无激活缺省）', () => {
    const { host, api } = create()
    expect(Object.keys(api).sort()).toEqual(['clear', 'dispose', 'el', 'setNode'])
    expect(api.el).toBeInstanceOf(HTMLElement)
    expect(api.el.parentElement).toBe(host)
    expect(api.el.classList.contains('mmagic-mind-panel')).toBe(true)
    expect(api.el.classList.contains('is-open')).toBe(false)
  })

  it('i18n 键集合钉死：t 被调唯一键集恰为 app.mind-panel 六键（五字段标签+close 关闭钮；「六键+title」歧义解释见文件头）', () => {
    const { t } = create()
    const keys = [...new Set(t.mock.calls.map((c) => c[0] as string))].sort()
    expect(keys).toEqual([
      'app.mind-panel.close',
      'app.mind-panel.generalization',
      'app.mind-panel.hyperlink',
      'app.mind-panel.image',
      'app.mind-panel.note',
      'app.mind-panel.tags',
    ])
  })
})

// ───────────────────────── setNode 字段回填 ─────────────────────────

describe('setNode 字段回填', () => {
  it('setNode 全字段回填：note→textarea 值/image·hyperlink→input 值/tags 数组→逗号串/generalization{text}→文本；并激活显示（is-open 在场）', () => {
    const { api } = create()
    api.setNode({
      note: '备注',
      image: 'https://example.com/a.png',
      hyperlink: 'https://example.com/h',
      tags: ['甲', '乙'],
      generalization: { text: '概要' },
    })
    expect(noteOf(api).value).toBe('备注')
    expect(fieldOf(api, 'image').value).toBe('https://example.com/a.png')
    expect(fieldOf(api, 'hyperlink').value).toBe('https://example.com/h')
    expect(fieldOf(api, 'tags').value).toBe('甲,乙')
    expect(fieldOf(api, 'generalization').value).toBe('概要')
    expect(api.el.classList.contains('is-open')).toBe(true)
  })

  it('setNode 节点切换不残留：先全字段 A 再 setNode({note}) 单字段 B——未提及字段清空（clear-then-edit 语义钉）', () => {
    const { api } = create()
    api.setNode({
      note: 'A注',
      image: 'https://example.com/a.png',
      hyperlink: 'https://example.com/h',
      tags: ['甲'],
      generalization: { text: 'A概要' },
    })
    api.setNode({ note: 'B注' })
    expect(noteOf(api).value).toBe('B注')
    expect(fieldOf(api, 'image').value).toBe('')
    expect(fieldOf(api, 'hyperlink').value).toBe('')
    expect(fieldOf(api, 'tags').value).toBe('')
    expect(fieldOf(api, 'generalization').value).toBe('')
  })

  it('setNode({}) 全清（清除语义回填面）：有值节点后切无装饰节点——五字段全空且面板仍显示（激活态语义）', () => {
    const { api } = create()
    api.setNode({ note: 'x' })
    api.setNode({})
    expect(noteOf(api).value).toBe('')
    expect(fieldOf(api, 'image').value).toBe('')
    expect(fieldOf(api, 'hyperlink').value).toBe('')
    expect(fieldOf(api, 'tags').value).toBe('')
    expect(fieldOf(api, 'generalization').value).toBe('')
    expect(api.el.classList.contains('is-open')).toBe(true)
  })
})

// ───────────────────────── 编辑交互（onEdit patch） ─────────────────────────

describe('编辑交互（onEdit patch）', () => {
  it("note 编辑：textarea 改值 change → onEdit 恰一次收 {note:'新值'}（单字段 patch）", () => {
    const { api, onEdit } = create()
    api.setNode({ note: '旧' })
    onEdit.mockClear()
    change(noteOf(api), '新值')
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith({ note: '新值' })
  })

  it('note 清空=清除语义：textarea 空串 → patch 键在场、值 undefined（契约「值为 undefined=清除该装饰」）', () => {
    const { api, onEdit } = create()
    api.setNode({ note: '旧' })
    onEdit.mockClear()
    change(noteOf(api), '')
    expect(onEdit).toHaveBeenCalledTimes(1)
    const patch = onEdit.mock.calls[0]![0] as Record<string, unknown>
    expect('note' in patch, '清除语义=键在场值 undefined（非缺键静默）').toBe(true)
    expect(patch.note).toBeUndefined()
  })

  it('tags 编辑：逗号串 → onEdit 收 {tags:["a","b","c"]}（数组还原）', () => {
    const { api, onEdit } = create()
    change(fieldOf(api, 'tags'), 'a,b,c')
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith({ tags: ['a', 'b', 'c'] })
  })

  it('tags 编辑（trim+滤空）：空段与首尾空白丢弃 → {tags:["a","b"]}', () => {
    const { api, onEdit } = create()
    change(fieldOf(api, 'tags'), ' a ,  , b ')
    expect(onEdit).toHaveBeenCalledWith({ tags: ['a', 'b'] })
  })

  it('tags 清空=清除语义：值全空 → patch 键在场、值 undefined（非空数组空串）', () => {
    const { api, onEdit } = create()
    api.setNode({ tags: ['a'] })
    onEdit.mockClear()
    change(fieldOf(api, 'tags'), '')
    expect(onEdit).toHaveBeenCalledTimes(1)
    const patch = onEdit.mock.calls[0]![0] as Record<string, unknown>
    expect('tags' in patch).toBe(true)
    expect(patch.tags).toBeUndefined()
  })

  it('image URL 守卫（钉）：javascript: 非法 → onEdit 零调+input.is-invalid 错误态；改合法 https → onEdit({image})+错误态摘除（守卫动态）', () => {
    // 前置（非空洞护栏）：真闸函数对 fixture 值的判定
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeImageUrl('https://example.com/a.png')).toBe(true)
    const { api, onEdit } = create()
    const img = fieldOf(api, 'image')
    change(img, 'javascript:alert(1)')
    expect(onEdit).not.toHaveBeenCalled()
    expect(img.classList.contains('is-invalid')).toBe(true)
    change(img, 'https://example.com/a.png')
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith({ image: 'https://example.com/a.png' })
    expect(img.classList.contains('is-invalid')).toBe(false)
  })

  it('image 清空=清除非非法：空串 → onEdit 收 {image:undefined}（键在场）且无 is-invalid（守卫只拦非空非法值）', () => {
    const { api, onEdit } = create()
    api.setNode({ image: 'https://example.com/a.png' })
    onEdit.mockClear()
    change(fieldOf(api, 'image'), '')
    expect(onEdit).toHaveBeenCalledTimes(1)
    const patch = onEdit.mock.calls[0]![0] as Record<string, unknown>
    expect('image' in patch).toBe(true)
    expect(patch.image).toBeUndefined()
    expect(fieldOf(api, 'image').classList.contains('is-invalid')).toBe(false)
  })

  it('generalization 编辑：{text} 信封双端同形——setNode 拆 .text 显示、change 收 {generalization:{text:"新概要"}}', () => {
    const { api, onEdit } = create()
    api.setNode({ generalization: { text: '旧概要' } })
    expect(fieldOf(api, 'generalization').value).toBe('旧概要')
    change(fieldOf(api, 'generalization'), '新概要')
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith({ generalization: { text: '新概要' } })
  })

  it("hyperlink 编辑：change → onEdit 恰一次收 {hyperlink:'…'}（单字段 patch）", () => {
    const { api, onEdit } = create()
    change(fieldOf(api, 'hyperlink'), 'https://example.com/p')
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith({ hyperlink: 'https://example.com/p' })
  })
})

// ───────────────────────── clear / 关闭钮 / dispose ─────────────────────────

describe('clear 与关闭钮与 dispose', () => {
  it('clear()：五字段全空 + is-open 移除（无激活隐藏）；clear 非编辑——onEdit 零调', () => {
    const { api, onEdit } = create()
    api.setNode({
      note: '备注',
      image: 'https://example.com/a.png',
      hyperlink: 'https://example.com/h',
      tags: ['甲'],
      generalization: { text: '概要' },
    })
    api.clear()
    expect(noteOf(api).value).toBe('')
    expect(fieldOf(api, 'image').value).toBe('')
    expect(fieldOf(api, 'hyperlink').value).toBe('')
    expect(fieldOf(api, 'tags').value).toBe('')
    expect(fieldOf(api, 'generalization').value).toBe('')
    expect(api.el.classList.contains('is-open')).toBe(false)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it("关闭钮：button[data-act='close'] click → onClose 恰一次；onClose 缺省（可选契约）click 不抛", () => {
    const { api, onClose } = create()
    const btn = api.el.querySelector<HTMLButtonElement>("button[data-act='close']")
    expect(btn, '关闭钮（data-act=close）应在面板根内').not.toBeNull()
    btn!.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    // onClose 可选：不传时点击关闭钮不抛（关闭后隐藏语义归实现自由度，不在此钉）
    const host = makeHost()
    const api2 = createMindPanel({ el: host, t: makeT(), onEdit: vi.fn() }) as unknown as MindPanelApi
    const btn2 = api2.el.querySelector<HTMLButtonElement>("button[data-act='close']")
    expect(() => btn2!.click()).not.toThrow()
  })

  it('dispose：面板根摘出宿主（host 不再包含 el）；重复 dispose 幂等不抛', () => {
    const { host, api } = create()
    expect(host.contains(api.el)).toBe(true)
    api.dispose()
    expect(host.contains(api.el)).toBe(false)
    expect(() => api.dispose()).not.toThrow()
  })
})
