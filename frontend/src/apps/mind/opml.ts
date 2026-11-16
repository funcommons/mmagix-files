/**
 * mind/opml.ts——脑图大纲 OPML 2.0 导出纯函数（MP2-E1）
 * 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2「导出 png/svg/OPML」
 * （测试=可执行规格：src/apps/mind/__tests__/opml.test.ts 5 例）
 *
 * opmlFromOutline(rows)：outlineFromTree 产物（OutlineRow[] {key,depth,text}：先序遍历+depth
 * 0 基，见 outline.ts 头注）→ OPML 2.0 文档串：
 *  - 骨架：<?xml version="1.0" encoding="UTF-8"?> 声明头起始 + <opml version="2.0"> 根 +
 *    唯一 <body>（head 形态不钉=实现自由度，本实现置空 <head/>）
 *  - depth 语义=栈嵌套：depth 0 行→body 顶层 outline（多根→多顶层）；depth +1→上一行
 *    outline 的子节点；depth 回落→闭栈回落层续挂（[d0,d1,d2,d1]→单根 2 子、首子 1 孙）；
 *    越深跳级按当前栈顶续挂（宽松处理——outlineFromTree 产物恒逐级 ±1，不触此面）
 *  - XML 属性转义：& < > " ' 五字符 → &amp;/&lt;/&gt;/&quot;/&apos;（text 走双引号属性域，
 *    quot 必转义；apos 为 XML 预定义实体，DOMParser roundtrip 无损）
 *  - 序列化自由度：缩进/自闭合不钉（断言面=DOMParser application/xml 结构解析），本实现
 *    逐行平铺（开标签压栈、闭栈补对）
 *  - 纯函数不可变：入参 rows 毫发无伤（outline.ts 同域红线）；零引擎 import
 */
import type { OutlineRow } from './outline'

/** XML 属性转义（五字符预定义实体；& 先行防二次转义） */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 大纲行（先序+depth 0 基）→ OPML 2.0 文档串；不可变纯函数 */
export function opmlFromOutline(rows: readonly OutlineRow[]): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '<head/>', '<body>']
  // depth 栈：存各行层级（闭标签恒 </outline>，栈仅需计数——depth 回落逐层弹出补闭合）
  const stack: number[] = []
  for (const row of rows) {
    const depth =
      typeof row.depth === 'number' && Number.isFinite(row.depth) && row.depth > 0 ? Math.floor(row.depth) : 0
    while (stack.length > depth) {
      stack.pop()
      lines.push('</outline>')
    }
    lines.push(`<outline text="${escapeXmlAttr(row.text)}">`)
    stack.push(depth)
  }
  while (stack.length > 0) {
    stack.pop()
    lines.push('</outline>')
  }
  lines.push('</body>', '</opml>')
  return lines.join('\n')
}
