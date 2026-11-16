/**
 * mind/opml.ts opmlFromOutline 单测（MP2-E1-T 测试先行，预期红：模块未落地——import 解析失败
 * 整文件红，归因=纯函数面未落地）
 * 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2「导出 png/svg/OPML」
 *
 * 输入域=outlineFromTree 产物（mind/outline.ts OutlineRow[] {key,depth,text}：先序遍历+depth
 * 0 基；见 outline.ts 头注）。
 *
 * 【契约（测试侧裁量，实现侧对齐或回本文件改钉）】opmlFromOutline(rows: OutlineRow[]): string
 *  - OPML 2.0 文档串：<?xml version="1.0" encoding="UTF-8"?> 头 + <opml version="2.0"> 根 +
 *    <body> 内嵌套 <outline text="…">（head 形态不钉=实现自由度）。
 *  - depth 语义=栈嵌套：depth 0 行→body 顶层 outline（多根→多顶层）；depth +1→上一行 outline
 *    的子节点；depth 回落→闭栈回落层续挂。
 *  - XML 属性转义：& < > " ' 五字符；&amp;/&lt;/&quot; 三硬锚（双引号属性域必转义）+DOMParser
 *    roundtrip（getAttribute('text') === 原文）兜底——apos 形态（&apos;/&#39;）不钉。
 *  - 断言形态=DOMParser('application/xml') 结构解析（禁 parsererror），不钉缩进/自闭合等序列化
 *    自由度；jsdom 实证 parsererror/body>outline 选择器/.children 全可用。
 *  - 纯函数不可变：入参 rows 毫发无伤（decorations/outline 同域红线）；零引擎 import。
 */
import { describe, expect, it } from 'vitest'
import { opmlFromOutline } from '../opml'
import { outlineFromTree } from '../outline'
import { toEngineTree } from '../convert'
import { parseMindmap } from '../../flow-model'

/** 解析并校验合法 XML（parsererror 缺席=合法红线）；返回 Document 供结构断言 */
function parseOpml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.querySelector('parsererror'), `须为合法 XML（禁 parsererror）：${xml.slice(0, 120)}`).toBeNull()
  return doc
}

describe('mind/opml opmlFromOutline', () => {
  it('合法 XML 头+OPML 2.0 骨架：<?xml version="1.0" encoding="UTF-8"?> 起始+根 opml version=2.0+唯一 body（head 形态不钉）', () => {
    const xml = opmlFromOutline([{ key: 'k', depth: 0, text: '根' }])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'XML 声明头起始').toBe(true)
    const doc = parseOpml(xml)
    expect(doc.documentElement.nodeName, '根元素=opml').toBe('opml')
    expect(doc.documentElement.getAttribute('version'), 'OPML 2.0').toBe('2.0')
    expect(doc.querySelectorAll('body').length, '唯一 body（head 不钉=实现自由度）').toBe(1)
  })

  it('嵌套结构（outlineFromTree 真实产物同构）：四行树 → body>outline[根主题] 子 [分支A, 分支B[子节点]]，text 属性 roundtrip 全等', () => {
    const tree = toEngineTree(parseMindmap(['mindmap', '  根主题', '    分支A', '    分支B', '      子节点'].join('\n')))
    const doc = parseOpml(opmlFromOutline(outlineFromTree(tree)))
    const root = doc.querySelector('body > outline')
    expect(root, '根行（depth 0）→body 顶层 outline').not.toBeNull()
    expect(root!.getAttribute('text'), '根 text roundtrip').toBe('根主题')
    expect(root!.children.length, '根下两子（depth 1）').toBe(2)
    expect(root!.children[0]!.getAttribute('text')).toBe('分支A')
    const b = root!.children[1]!
    expect(b.getAttribute('text')).toBe('分支B')
    expect(b.children.length, 'depth 2 孙节点嵌套于分支B').toBe(1)
    expect(b.children[0]!.getAttribute('text')).toBe('子节点')
  })

  it('XML 属性转义：text 含 &<>"\' 五字符 → 串面 &amp;/&lt;/&quot; 三硬锚（双引号属性域必转义）+roundtrip getAttribute 全等原文（apos 形态 &apos;/&#39; 不钉）', () => {
    const raw = `A&B <x> "y" 'z'`
    const xml = opmlFromOutline([{ key: 'k', depth: 0, text: raw }])
    expect(xml, '& 转义').toContain('&amp;')
    expect(xml, '< 转义').toContain('&lt;')
    expect(xml, '" 转义').toContain('&quot;')
    const doc = parseOpml(xml)
    expect(doc.querySelector('body > outline')!.getAttribute('text'), 'roundtrip=原文（转义无损证明）').toBe(raw)
  })

  it('depth 栈行为：d 回落闭栈（[d0,d1,d2,d1]→单根 2 子、首子 1 孙）+多根（两 d0→body 两顶层 outline）', () => {
    const doc = parseOpml(
      opmlFromOutline([
        { key: 'r', depth: 0, text: '根' },
        { key: 'a', depth: 1, text: 'A' },
        { key: 'b', depth: 2, text: 'B' },
        { key: 'c', depth: 1, text: 'C' },
      ]),
    )
    const tops = doc.querySelectorAll('body > outline')
    expect(tops.length, '单根→body 单顶层').toBe(1)
    expect(tops[0]!.children.length, 'd2→d1 回落闭栈：根下 2 子（A、C）').toBe(2)
    expect(tops[0]!.children[0]!.children.length, 'A 下 1 孙（B）').toBe(1)
    expect(tops[0]!.children[0]!.children[0]!.getAttribute('text')).toBe('B')
    expect(tops[0]!.children[1]!.getAttribute('text')).toBe('C')
    const multi = parseOpml(
      opmlFromOutline([
        { key: 'r1', depth: 0, text: '根1' },
        { key: 'r2', depth: 0, text: '根2' },
      ]),
    )
    expect(multi.querySelectorAll('body > outline').length, '多根→多顶层（栈语义自然外推）').toBe(2)
  })

  it('边界与不可变：text 空串行不炸（outlineFromTree 空树单行同构 text=""）+空数组→body 零 outline+入参 rows 毫发无伤（纯函数不可变红线）', () => {
    const blank = parseOpml(opmlFromOutline([{ key: '', depth: 0, text: '' }]))
    const o = blank.querySelector('body > outline')
    expect(o, '空文本行仍产 outline（大纲域「不炸不空返回」同口径）').not.toBeNull()
    expect(o!.getAttribute('text')).toBe('')
    expect(parseOpml(opmlFromOutline([])).querySelectorAll('body > outline').length, '空数组→body 空').toBe(0)
    const rows = [{ key: 'k', depth: 0, text: 't' }]
    opmlFromOutline(rows)
    expect(rows, '入参毫发无伤').toEqual([{ key: 'k', depth: 0, text: 't' }])
  })
})
