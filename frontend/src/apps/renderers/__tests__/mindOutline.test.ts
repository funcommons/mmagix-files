/**
 * mind 大纲面单测（MC3c-T 测试先行——outlineFromTree 纯函数 + createMindOutline DOM 工厂，
 * 两模块均未实现：本文件全红=预期「模块缺失红」，MC3c-C 落地后转绿）
 * 契约正本：.claude/mind-loop-state.md「MC3c 契约（锁定）」节
 *
 * 【本文件=可执行规格（测试侧裁量钉死处，实现侧对齐或回本文件改钉）】
 *  - outlineFromTree 模型定型：契约草案 `Array<{...}[]>` 嵌套形态按「树→扁平缩进行模型」
 *    钉为单层数组 `OutlineRow[]`；OutlineRow={key,depth,text} 恰三字段（全等断言钉死无附加
 *    字段）；depth 0 基（根=0）；key=buildNodeKey(祖先文本链含自身，meta.ts 已落地)；
 *    行序=先序遍历（文档序，非 BFS）；纯函数（入参树不可变）；位置 src/apps/mind/outline.ts
 *    （纯函数零引擎 import，decorations.ts 同域同红线）
 *  - createMindOutline 工厂：opts{el,t,onLocate(key)} → 恰五成员 {el,render,show,hide,dispose}；
 *    根 div.mmagic-mind-outline 创建即挂入宿主 el（mindPanel 同形态）；可见性 is-open
 *    （对齐面板/flow-editor 显隐惯例）——初始隐藏、show 加、hide 摘
 *  - 行 DOM 定位（钉）：[data-key] 行元素 + data-depth 属性 + 行内缩进 style
 *    （padding-left/margin-left/text-indent 任一，depth0=0 且随 depth 严格递增——jsdom 不验算
 *    scoped class 样式，缩进机器面=行内 style）
 *  - render(rows) 幂等重渲染（替换不叠加）；行 click → onLocate(row.key) 恰调一次
 *  - i18n 键集恰一键：app.mind-outline.label（aria-label 承载；需加键须回本文件改钉）
 *
 * 纯 DOM 工厂（零引擎 import）jsdom 直测，无需任何 vi.mock（mindPanel.test.ts 同手法）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMindmap } from '../../flow-model'
import { toEngineTree } from '../../mind/convert'
import type { EngineNode } from '../../mind/convert'
import { buildNodeKey } from '../../mind/meta'
import { outlineFromTree } from '../../mind/outline'
import { createMindOutline } from '../mindOutline'

/** OutlineRow 行模型（模块落地前的本地最小声明——落地后可换 import type） */
interface OutlineRow {
  key: string
  depth: number
  text: string
}

/** createMindOutline 工厂返回形状（同上） */
interface MindOutlineApi {
  el: HTMLElement
  render(rows: OutlineRow[]): void
  show(): void
  hide(): void
  dispose(): void
}

// ───────────────────────── 夹具与助手 ─────────────────────────

/** 三节点链：根/预览/图片（decorations.test.ts 手法：parseMindmap+toEngineTree 建树防手写漂移） */
const CHAIN = ['mindmap', '  根主题', '    预览', '      图片'].join('\n')

/** 双分支树：根/甲(甲一)/乙(乙一)——先序序与 buildNodeKey 对照用 */
const BRANCHED = ['mindmap', '  根主题', '    甲', '      甲一', '    乙', '      乙一'].join('\n')

/** 四层深链：L0→L1→L2→L3 */
const DEEP = ['mindmap', '  L0', '    L1', '      L2', '        L3'].join('\n')

/** 单根 */
const SOLO = ['mindmap', '  独根'].join('\n')

/** 特殊文本：段含 / 与空格（键转义形钉死用） */
const SPECIAL = ['mindmap', '  根', '    a/b c'].join('\n')

function buildTree(text: string): EngineNode {
  return toEngineTree(parseMindmap(text))
}

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

/** 工厂创建助手：t=identity spy、onLocate=spy */
function create() {
  const host = makeHost()
  const t = vi.fn((k: string) => k)
  const onLocate = vi.fn()
  const api = createMindOutline({ el: host, t, onLocate }) as unknown as MindOutlineApi
  return { host, t, onLocate: onLocate as ReturnType<typeof vi.fn>, api }
}

/** DOM 工厂测试行模型（键字面=buildNodeKey 对这些纯文本路径的产物，无转义段） */
const ROWS: OutlineRow[] = [
  { key: '根主题', depth: 0, text: '根主题' },
  { key: '根主题/预览', depth: 1, text: '预览' },
  { key: '根主题/预览/图片', depth: 2, text: '图片' },
]

/** 行元素定位 */
function rowElsOf(api: MindOutlineApi): HTMLElement[] {
  return [...api.el.querySelectorAll<HTMLElement>('[data-key]')]
}

/** 行内缩进机器面：padding-left / margin-left / text-indent 任一（px 数值） */
function indentOf(row: HTMLElement): number {
  const s = row.style
  for (const v of [s.paddingLeft, s.marginLeft, s.textIndent]) {
    const n = Number.parseFloat(v)
    if (!Number.isNaN(n)) return n
  }
  return Number.NaN
}

// ───────────────────────── outlineFromTree（树→扁平行模型） ─────────────────────────

describe('outlineFromTree（树→扁平行模型）', () => {
  it('三节点链全模型：扁平三行、先序、depth 0/1/2 递增、key=text 路径、行恰 {key,depth,text} 三字段', () => {
    const rows = outlineFromTree(buildTree(CHAIN))
    expect(rows).toEqual([
      { key: '根主题', depth: 0, text: '根主题' },
      { key: '根主题/预览', depth: 1, text: '预览' },
      { key: '根主题/预览/图片', depth: 2, text: '图片' },
    ])
  })

  it('深层嵌套 depth 序：四层链 → depth [0,1,2,3] 严格递增（行数 4）', () => {
    const rows = outlineFromTree(buildTree(DEEP))
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3])
  })

  it('多分支先序序：两分支各带叶 → 行序=文档序（根→甲→甲一→乙→乙一，非按层 BFS）', () => {
    const rows = outlineFromTree(buildTree(BRANCHED))
    expect(rows.map((r) => r.key)).toEqual([
      '根主题',
      '根主题/甲',
      '根主题/甲/甲一',
      '根主题/乙',
      '根主题/乙/乙一',
    ])
  })

  it('key=buildNodeKey 硬编码转义形：文本含 / 与空格 → 键转义（\\/、\\s）而 text 原样', () => {
    // 非空洞护栏：真 buildNodeKey 对 fixture 段的产物（防 fixture 与断言双侧同错）
    expect(buildNodeKey(['根', 'a/b c'])).toBe('根/a\\/b\\sc')
    const rows = outlineFromTree(buildTree(SPECIAL))
    expect(rows[1]!.key).toBe('根/a\\/b\\sc')
    expect(rows[1]!.text).toBe('a/b c')
  })

  it('单根边界：仅根无子 → 恰一行 depth 0（key=根文本）', () => {
    const rows = outlineFromTree(buildTree(SOLO))
    expect(rows).toEqual([{ key: '独根', depth: 0, text: '独根' }])
  })

  it('空树边界：空文本无子根 → 单行 {key:"",depth:0,text:""}（大纲域对空树不炸不空返回）', () => {
    const rows = outlineFromTree({ data: { text: '' }, children: [] })
    expect(rows).toEqual([{ key: '', depth: 0, text: '' }])
  })

  it('key 链路对照：每行 key === buildNodeKey(根→该节点文本路径)（真函数逐行全等，与行序/depth 联合钉）', () => {
    const tree = buildTree(BRANCHED)
    const rows = outlineFromTree(tree)
    const paths: string[][] = []
    const walk = (n: EngineNode, acc: string[]): void => {
      const next = [...acc, n.data.text]
      paths.push(next)
      n.children.forEach((c) => walk(c, next))
    }
    walk(tree, [])
    expect(rows.map((r) => r.key)).toEqual(paths.map((p) => buildNodeKey(p)))
  })

  it('纯函数不可变：入参树毫发无伤（JSON 快照全等），产出确已发生（非空洞）', () => {
    const tree = buildTree(CHAIN)
    const before = JSON.parse(JSON.stringify(tree)) as EngineNode
    const rows = outlineFromTree(tree)
    expect(rows).toHaveLength(3)
    expect(tree).toEqual(before)
  })

  it('行模型只取 text/key/depth：data 附加字段（uid/style）不入行；text 原样透传不 trim（键仍转义）', () => {
    const tree: EngineNode = {
      data: { text: '  带空格  ', uid: 'u1', style: { borderRadius: '50%' } },
      children: [{ data: { text: '子', uid: 'u2' }, children: [] }],
    }
    expect(buildNodeKey(['  带空格  '])).toBe('\\s\\s带空格\\s\\s') // 护栏：真函数产物
    const rows = outlineFromTree(tree)
    expect(rows).toEqual([
      { key: '\\s\\s带空格\\s\\s', depth: 0, text: '  带空格  ' },
      { key: '\\s\\s带空格\\s\\s/子', depth: 1, text: '子' },
    ])
  })
})

// ───────────────────────── createMindOutline（DOM 工厂） ─────────────────────────

describe('createMindOutline（DOM 工厂）', () => {
  it('装配：恰五成员 {el,render,show,hide,dispose}；根挂入宿主+mmagic-mind-outline 钉类；初始隐藏（is-open 缺席）', () => {
    const { host, api } = create()
    expect(Object.keys(api).sort()).toEqual(['dispose', 'el', 'hide', 'render', 'show'])
    expect(api.el).toBeInstanceOf(HTMLElement)
    expect(api.el.parentElement).toBe(host)
    expect(api.el.classList.contains('mmagic-mind-outline')).toBe(true)
    expect(api.el.classList.contains('is-open')).toBe(false)
  })

  it('i18n 键集恰一键：t 唯一键=app.mind-outline.label，经 aria-label 承载（零硬编码中文面）', () => {
    const { t, api } = create()
    expect([...new Set(t.mock.calls.map((c) => c[0] as string))]).toEqual(['app.mind-outline.label'])
    expect(api.el.getAttribute('aria-label')).toBe('app.mind-outline.label')
  })

  it('render(rows) 行 DOM：恰三行 [data-key]，data-key/data-depth 逐行正确，行文本在场', () => {
    const { api } = create()
    api.render(ROWS)
    const rowEls = rowElsOf(api)
    expect(rowEls).toHaveLength(3)
    expect(rowEls.map((r) => r.getAttribute('data-key'))).toEqual(ROWS.map((r) => r.key))
    expect(rowEls.map((r) => r.getAttribute('data-depth'))).toEqual(['0', '1', '2'])
    for (const [i, row] of ROWS.entries()) {
      expect(rowEls[i]!.textContent).toContain(row.text)
    }
  })

  it('depth→缩进：行内缩进 style（padding/margin/text-indent 任一）depth0=0 且随 depth 严格递增', () => {
    const { api } = create()
    api.render(ROWS)
    const indents = rowElsOf(api).map(indentOf)
    expect(indents[0]).toBe(0)
    expect(indents[1]).toBeGreaterThan(indents[0]!)
    expect(indents[2]).toBeGreaterThan(indents[1]!)
  })

  it('render 幂等重渲染：连续两次 render → 行数仍 3（替换不叠加，无幽灵行）', () => {
    const { api } = create()
    api.render(ROWS)
    api.render(ROWS)
    expect(api.el.querySelectorAll('[data-key]')).toHaveLength(3)
  })

  it('行点击→onLocate(key) 恰调一次：点「预览」行收其 key；再点「图片」行收新 key（共两调）', () => {
    const { api, onLocate } = create()
    api.render(ROWS)
    const rowEls = rowElsOf(api)
    rowEls[1]!.click()
    expect(onLocate).toHaveBeenCalledTimes(1)
    expect(onLocate).toHaveBeenCalledWith('根主题/预览')
    rowEls[2]!.click()
    expect(onLocate).toHaveBeenCalledTimes(2)
    expect(onLocate).toHaveBeenLastCalledWith('根主题/预览/图片')
  })

  it('show/hide 显隐（is-open）：show 加类、hide 摘类（对齐面板/flow-editor 显隐惯例）', () => {
    const { api } = create()
    api.show()
    expect(api.el.classList.contains('is-open')).toBe(true)
    api.hide()
    expect(api.el.classList.contains('is-open')).toBe(false)
  })

  it('dispose：根摘出宿主；重复 dispose 幂等不抛', () => {
    const { host, api } = create()
    expect(host.contains(api.el)).toBe(true)
    api.dispose()
    expect(host.contains(api.el)).toBe(false)
    expect(() => api.dispose()).not.toThrow()
  })
})
