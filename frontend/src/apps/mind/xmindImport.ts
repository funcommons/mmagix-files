/**
 * mind/xmindImport.ts——.xmind 导入纯函数面（MP2-X1）：XMind content.json → mermaid
 * mindmap 文本
 * 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2「.xmind 导入（zip+content.json，
 * 逃生舱）」+ §四 mermaid mindmap 文本形态（D1 主存不动：导入产物=mermaid mindmap 文本）
 * （测试=可执行规格：src/apps/mind/__tests__/xmindImport.test.ts 6 例）
 *
 * xmindToMindmap(contentJson)：
 *  - 入参=content.json 的 JSON.parse 产物（sheet 数组域）；出参=mermaid mindmap 文本，与
 *    serializeMindmap 同构字节形态（header 'mindmap' + 根 2 空格缩进 + 每层 +2——「导入→
 *    保存链」经 parseMindmap/serializeMindmap 往返字节零漂移）
 *  - sheet：取首（引擎 parse 侧 content[0] 同语义——引擎导出面恒单 sheet 数组，真 XMind
 *    可多 sheet）；多 sheet console.warn（mind/* 域既有告警通道，meta.ts/decorations.ts 同族）
 *  - topic 树：rootTopic / children.attached 递归展开；attached 数组序=兄弟序（引擎权威
 *    schema，parse/xmind.js+ExportXMind.js 实证）→ 出参先序行序
 *  - 防御口径（throw 收敛单点，编辑器胶水 catch 统一「告警恰一次+零 setData+零 dirty」）：
 *    非数组入参（null/bare 单 sheet 对象）/空数组 → throw（引擎 content[0] 只认数组域，bare
 *    对象同样落 undefined 崩）；sheet 缺 rootTopic / rootTopic=null → throw（引擎对空
 *    content 同 reject(Error('解析失败')) 形态——「文件不是脑图」与「空脑图」不得混一，导入=
 *    显式用户动作，失败须可见）
 *  - title：非 string（含缺省）→ ''（引擎 parse 侧 isUndef→'' 同口径）再 trim；trim 后空 →
 *    零宽空格占位（见下方「空标题占位裁决」）；needsQuote 命中（" { } [ ] ( ) | \ 换行）→
 *    `["<escapeLabel 转义>"]` 包裹（flow-model mindmapNodeToken bare 分支同口径——
 *    parseMindmap 回读 label 全等原文），否则原文直出（中文/emoji 直通不加包裹）
 *  - 纯函数不可变：入参 contentJson 毫发无伤（opml/decorations 同域红线）；零引擎 import
 *    （simple-mind-map 零触；escapeLabel 来自同域纯模块 flow-model，非引擎面）
 *
 * 【空标题占位裁决（本实现裁量，测试未钉此面）】mermaid mindmap 文本形态无法表达空标题
 *  节点：parseMindmap 对 trim 后空白行整行吞吃且子级重挂栈顶祖先（flow-model parseMindmap
 *  对 trim 后空行 early-return——任务 prompt 建议的空串直出与占位 ' ' 均被 trim 吞吃，等价
 *  于丢节点+子级上提；根为空时更退化成多根折叠、层级错乱），导出链同理：空标签节点
 *  serialize 后再 parse 即消失。故 trim 后空标题以零宽空格 U+200B 占位——JS trim 白名单
 *  不含 U+200B（不吞）、needsQuote 不命中（裸 token 直出）、parse/serialize 往返字节稳定、
 *  画布渲染呈空节点=与 XMind 源观感一致，结构/层级完整保留零丢节点。代价=落盘文本含
 *  不可见字符（每空标题节点一枚；导入=显式逃生舱动作，保结构优先于文本洁净，注记在案，
 *  后续批如需可见占位可翻面改钉）。
 */
import { escapeLabel } from '../flow-model'

/** needsQuote 本地镜像（flow-model.ts 同名私有函数未导出）：「" { } [ ] ( ) | \ 换行」
 *  命中须 `["…"]` 包裹（防 mermaid 形状定界歧义）。⚠ 镜像漂移注记：flow-model needsQuote
 *  变更须同步此处（mindmapNodeToken bare 分支同口径锚，测试第 4 例往返钉字节对称） */
function needsQuote(label: string): boolean {
  return /["{}[\]()|\\\n]/.test(label)
}

/** 空标题占位（零宽空格 U+200B——裁决依据见块头「空标题占位裁决」注；\u 转义字面在案，
 *  禁改可见空格字面量——trim 语义翻转即丢节点面） */
const EMPTY_TITLE_PLACEHOLDER = '\u200B'

/** topic/sheet 最小本地契约（引擎权威 schema 的转换面投影）：sheet=rootTopic 键、
 *  topic=title/children.attached 二键；notes/href/labels/summaries 等超集字段本批不搬运
 *  （容忍不炸，注记供后续批） */
interface XmindTopic {
  title?: unknown
  children?: { attached?: unknown }
  rootTopic?: unknown
}

/** topic title 读取：非 string（含缺省）→ ''（引擎 isUndef→'' 同口径）；trim 后空 → 零宽
 *  占位；其余 trim 后直出（trim 前置=出参行 token 与 parseMindmap trim 语义对齐，首尾空白
 *  节点名不制造「wrap 后 serialize 裸奔」字节漂移面） */
function titleTokenOf(topic: XmindTopic): string {
  const s = typeof topic.title === 'string' ? topic.title.trim() : ''
  if (s === '') return EMPTY_TITLE_PLACEHOLDER
  return needsQuote(s) ? `[${escapeLabel(s)}]` : s
}

/** content.json（sheet 数组域）→ mermaid mindmap 文本；不可变纯函数（非数组/空数组/缺
 *  rootTopic throw——防御口径见块头注） */
export function xmindToMindmap(contentJson: unknown): string {
  if (!Array.isArray(contentJson)) throw new Error('[mind/xmind] content.json 须为 sheet 数组，导入中止')
  if (contentJson.length === 0) throw new Error('[mind/xmind] content.json 零 sheet（空稿），导入中止')
  if (contentJson.length > 1) console.warn(`[mind/xmind] 多 sheet（${contentJson.length} 幅画布）取首，其余弃置`)
  const first = contentJson[0] as XmindTopic | null
  const root = first !== null && typeof first === 'object' ? first.rootTopic : null
  if (root === null || typeof root !== 'object') {
    throw new Error('[mind/xmind] sheet 缺 rootTopic（非脑图 content.json），导入中止')
  }
  const lines: string[] = ['mindmap']
  const emit = (topic: XmindTopic, depth: number): void => {
    // 缩进 canonical=serializeMindmap 同构：根 depth 0 → 2 空格，每层 +2（'  '.repeat(depth+1)）
    lines.push(`${'  '.repeat(depth + 1)}${titleTokenOf(topic)}`)
    const attached = topic.children?.attached
    if (!Array.isArray(attached)) return
    for (const child of attached) {
      // 非对象 child（坏 content.json 脏条目）防御跳过——不抛（树结构面坏点弃置，与引擎
      // parse 侧宽容口径同族；rootTopic 级坏形仍 throw=块头防御注）
      if (child === null || typeof child !== 'object') continue
      emit(child as XmindTopic, depth + 1)
    }
  }
  emit(root as XmindTopic, 0)
  return lines.join('\n')
}
