/**
 * 流程图源模型——mermaid graph TD 子集的解析 / 序列化（flow-editor 数据层）
 * 设计正本：《docs/design/flow-editor-design.md》V1.0 §三（子集契约/透传/meta 规范）
 *
 * 三条纪律（同设计文档 §1.2）：
 *  1. 子集契约：只解析本文件定义的语法；解析不了的行原样透传
 *  2. 无损透传：序列化按「raw 优先」——未被编辑的语句原样输出原行，往返 diff 为空
 *  3. 转义对称：label 的引号/特殊字符经 escapeLabel/parseNodeToken 同一对函数处理
 *
 * 语法子集：
 *   header        graph TD | flowchart TD（方向原样保留）
 *   meta 行       %% meta: <nodeId|schema=v1> <JSON>
 *   注释          %% ...（透传）
 *   subgraph/end  行原样透传（成员归属由行位置天然保留；MVP 不解析嵌套）
 *   边语句        A --> B / A -->|label| B（链式 A --> B --> C）
 *   节点定义      A[label] A(label) A((label)) A{label} / 裸 id
 */

/** 节点形状（与 X6 调色板一一映射） */
export type FlowShape = 'rect' | 'round' | 'circle' | 'diamond'

export interface FlowNode {
  id: string
  label: string
  shape: FlowShape
  /** 首次定义所在行（-1=隐式引入/新增节点） */
  defLine: number
  /** 源文件中以裸 id 形态书写（label===id 且无形状定界）——序列化保持裸形态防行噪声 */
  bare?: boolean
  /** mindmap 方言：源行装饰前的 id 前缀（`root((x))` 的 `root`；mermaid 忽略其显示，往返保真用） */
  mmId?: string
  /** 渲染无关元数据（%% meta 行注入；属性面板读写） */
  meta?: Record<string, unknown>
}

export interface FlowEdge {
  from: string
  to: string
  label: string
  /** 所在行号（-1=新增边） */
  line: number
}

export interface FlowModel {
  /** 原 header 行（graph TD 原文，方向原样保留） */
  header: string
  headerLine: number
  /** meta schema 行（如 schema=v1） */
  metaSchema: string | null
  /** meta 行缩进（重建 meta 块时保留；null=源文件无 meta 行） */
  metaIndent: string | null
  /** 按 id 的 meta（渲染无关数据；序列化重建 meta 块） */
  metaById: Map<string, Record<string, unknown>>
  /** 节点（插入序） */
  nodes: Map<string, FlowNode>
  /** 边（按行序） */
  edges: FlowEdge[]
  /** 原文行（序列化基底；透传行原样输出） */
  lines: string[]
}

/** 空模型 */
export function emptyModel(header = 'graph TD'): FlowModel {
  return {
    header,
    headerLine: 0,
    metaSchema: null,
    metaIndent: null,
    metaById: new Map(),
    nodes: new Map(),
    edges: [],
    lines: [],
  }
}

// ───────────────────────── label 转义（对称正本） ─────────────────────────

/** label 含形状定界符/引号/竖线/换行/反斜杠 → 序列化时必须双引号包裹（换行转义后源保持单行） */
function needsQuote(label: string): boolean {
  return /["{}[\]()|\\\n]/.test(label)
}

/** 序列化 label：需要时加引号并转义内部引号/反斜杠/换行（与 parseNodeToken 的去引号对称；
 *  换行落源文为 `\n` 两字转义序列——mermaid 侧显示字面 `\n`，X6 侧经 unescape 还原为真换行） */
export function escapeLabel(label: string): string {
  if (!needsQuote(label)) return label
  return `"${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** 转义序列还原：`\n`→换行、`\"`→引号、`\\`→反斜杠（escapeLabel 的逆，二者必须对称） */
function unescapeSeqs(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
}

// ───────────────────────── 节点 token 解析/序列化 ─────────────────────────

/** 形状定界符 → 形状（开闭对匹配；两符号圆括号在前防 `((` 被认作 `(`） */
const SHAPE_PAIRS: Array<[open: string, close: string, shape: FlowShape]> = [
  ['((', '))', 'circle'],
  ['{', '}', 'diamond'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
]

/** 语法源 label 文本：去引号 + 转义序列还原（与 escapeLabel 对称） */
function unquoteLabel(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return unescapeSeqs(t.slice(1, -1))
  }
  return t
}

/**
 * 解析节点 token：`A[label]` / `A["标签"]` / `A((x))` / `A{y}` / `A(z)` / `A`（裸）
 * 返回 null = 不是合法节点 token
 */
export function parseNodeToken(
  token: string,
): { id: string; label: string; shape: FlowShape; bare: boolean } | null {
  const m = /^\s*([A-Za-z0-9_]+)\s*(.*)\s*$/.exec(token)
  if (!m) return null
  const id = m[1] ?? '' // 两个捕获组必参与匹配，兜底不可达（noUncheckedIndexedAccess 类型窄化）
  const body = (m[2] ?? '').trim()
  if (body === '') return { id, label: id, shape: 'rect', bare: true }
  for (const [open, close, shape] of SHAPE_PAIRS) {
    if (body.startsWith(open) && body.endsWith(close) && body.length >= open.length + close.length) {
      return { id, label: unquoteLabel(body.slice(open.length, body.length - close.length)), shape, bare: false }
    }
  }
  return null
}

/** 序列化节点 token（与 parseNodeToken 对称；裸形态节点保持裸 id） */
export function nodeToken(node: Pick<FlowNode, 'id' | 'label' | 'shape' | 'bare'>): string {
  if (node.bare && node.shape === 'rect' && node.label === node.id) return node.id
  const label = escapeLabel(node.label)
  switch (node.shape) {
    case 'circle':
      return `${node.id}((${label}))`
    case 'diamond':
      return `${node.id}{${label}}`
    case 'round':
      return `${node.id}(${label})`
    default:
      return `${node.id}[${label}]`
  }
}

// ───────────────────────── 解析 ─────────────────────────

const META_RE = /^\s*%%\s*meta:\s*(\S+)(?:\s+(.*))?$/
const HEADER_RE = /^\s*(graph|flowchart)\s+(TD|TB|LR)\s*$/
const EDGE_ARROW = '-->'

/** 边语句按 `-->` 分段：label 形态 `A -->|x| B` 的 `|x|` 归下一段首 */
function splitEdgeStatement(statement: string): Array<{ kind: 'node'; token: string } | { kind: 'label'; label: string }> | null {
  const parts = statement.split(EDGE_ARROW)
  if (parts.length < 2) return null
  const seq: Array<{ kind: 'node'; token: string } | { kind: 'label'; label: string }> = []
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i] ?? '' // i < parts.length，兜底不可达
    if (i > 0) {
      const lm = /^\s*\|([^|]*)\|\s*/.exec(part)
      if (lm) {
        seq.push({ kind: 'label', label: lm[1] ?? '' }) // 捕获组必参与匹配，兜底不可达
        part = part.slice(lm[0].length)
      }
    }
    seq.push({ kind: 'node', token: part })
  }
  return seq
}

function registerNode(
  model: FlowModel,
  node: { id: string; label: string; shape: FlowShape; bare: boolean },
  line: number,
): void {
  if (!model.nodes.has(node.id)) {
    model.nodes.set(node.id, { ...node, defLine: line })
  }
}

/** 解析 mermaid 源文本为 FlowModel（永不失败：解析不了的行一律透传） */
export function parseFlowchart(text: string): FlowModel {
  const model = emptyModel()
  model.lines = text.split('\n')

  model.lines.forEach((line, i) => {
    const hm = HEADER_RE.exec(line)
    if (hm) {
      model.header = line
      model.headerLine = i
      return
    }
    const mm = META_RE.exec(line)
    if (mm) {
      if (model.metaIndent === null) model.metaIndent = /^[\t ]*/.exec(line)![0]
      const key = mm[1] ?? '' // 捕获组必参与匹配，兜底不可达
      const body = (mm[2] ?? '').trim()
      if (key.startsWith('schema=')) {
        model.metaSchema = key
      } else {
        try {
          model.metaById.set(key, JSON.parse(body || '{}') as Record<string, unknown>)
        } catch {
          // 非法 JSON：序列化时该行按 raw 透传（META_RE 行会被 meta 块重建跳过——
          // 但非法 JSON 行不计入 metaById，会随重建丢失；此处标注到透传面）：
          // MVP 口径=接受丢失并告警（属性面板是 meta 的唯一权威编辑面）
          console.warn(`[flow-model] meta 行 JSON 非法，已忽略（line ${i + 1}）`)
        }
      }
      return
    }
    // 注释 / subgraph / end / 空行 → 透传
    if (/^\s*%%/.test(line) || /^\s*subgraph\b/.test(line) || /^\s*end\s*$/.test(line) || line.trim() === '') {
      return
    }
    if (line.includes(EDGE_ARROW)) {
      const seq = splitEdgeStatement(line)
      if (!seq) return
      let from: string | null = null
      let pendingLabel = ''
      let ok = true
      for (const item of seq) {
        if (item.kind === 'label') {
          pendingLabel = unquoteLabel(item.label)
          continue
        }
        const node = parseNodeToken(item.token)
        if (!node) {
          ok = false
          break
        }
        registerNode(model, node, i)
        if (from !== null) {
          model.edges.push({ from, to: node.id, label: pendingLabel, line: i })
          pendingLabel = ''
        }
        from = node.id
      }
      if (!ok) return // 半途失败：整行透传（已注册节点无害）
      return
    }
    const node = parseNodeToken(line)
    if (node) {
      registerNode(model, node, i)
      return
    }
    // 其余：透传
  })

  // meta 注入节点
  for (const [id, meta] of model.metaById) {
    const n = model.nodes.get(id)
    if (n) n.meta = meta
  }
  return model
}

// ───────────────────────── 序列化（raw 优先 → 往返 diff 为空） ─────────────────────────

/**
 * 序列化：逐行重建。
 *  - header/透传行：原样
 *  - meta 块：header 后整体重建（schema 行 + 各节点 meta，按 metaById 序）；旧 meta 行跳过
 *  - 边/节点 def 行：重新生成 == 原行（trim 级）→ 原样输出（零 diff）；被编辑过 → 生成行
 *  - 新增（line=-1）边/节点：追加文档尾部
 */
export function serializeFlowchart(model: FlowModel): string {
  const out: string[] = []
  const consumedEdges = new Set<number>()
  const consumedDefLines = new Set<number>()
  let metaInserted = false

  const emitMetaBlock = (): void => {
    if (metaInserted) return
    metaInserted = true
    const ind = model.metaIndent ?? ''
    if (model.metaSchema) out.push(`${ind}%% meta: ${model.metaSchema}`)
    for (const [id, meta] of model.metaById) {
      out.push(`${ind}%% meta: ${id} ${JSON.stringify(meta)}`)
    }
  }

  const genEdgeLine = (e: FlowEdge): string => {
    // 端点 token：该边行恰好是节点首次定义行 → 带形状定义；否则裸 id 引用（mermaid 语义：边引用仅需 id）
    const tok = (id: string): string => {
      const n = model.nodes.get(id)!
      return n.defLine === e.line ? nodeToken(n) : id
    }
    const a = tok(e.from)
    const b = tok(e.to)
    return e.label ? `${a} -->|${escapeLabel(e.label)}| ${b}` : `${a} --> ${b}`
  }

  model.lines.forEach((raw, i) => {
    if (i === model.headerLine) {
      out.push(raw)
      emitMetaBlock()
      return
    }
    // 旧 meta 行：跳过（header 后已整体重建）
    if (META_RE.test(raw)) return

    const edge = model.edges.find((e) => e.line === i)
    if (edge) {
      // find（首个匹配）→ indexOf 同一对象引用 = 原 findIndex 下标，行为等价且免索引窄化
      const edgeIdx = model.edges.indexOf(edge)
      consumedEdges.add(edgeIdx)
      const gen = genEdgeLine(edge)
      out.push(raw === gen || raw.trim() === gen.trim() ? raw : gen)
      return
    }
    const defNode = [...model.nodes.values()].find((n) => n.defLine === i)
    if (defNode) {
      consumedDefLines.add(i)
      const gen = nodeToken(defNode)
      out.push(raw === gen || raw.trim() === gen.trim() ? raw : gen)
      return
    }
    out.push(raw)
  })

  // 新增边/节点：追加尾部
  model.edges.forEach((e, idx) => {
    if (e.line === -1 && !consumedEdges.has(idx)) out.push(genEdgeLine(e))
  })
  for (const n of model.nodes.values()) {
    if (n.defLine === -1) out.push(nodeToken(n))
  }
  return out.join('\n')
}

// ───────────────────────── 编辑操作（渲染器调用的受控变更面） ─────────────────────────

let newSeq = 0

/** 新增节点（id 自动分配）；返回 id */
export function addNode(model: FlowModel, label: string, shape: FlowShape = 'rect'): string {
  let id = `n${++newSeq}`
  while (model.nodes.has(id)) id = `n${++newSeq}`
  model.nodes.set(id, { id, label, shape, defLine: -1 })
  return id
}

/** 连边（两端必须存在；新增边 line=-1，序列化时追加尾部） */
export function connect(model: FlowModel, from: string, to: string, label = ''): void {
  if (!model.nodes.has(from) || !model.nodes.has(to)) return
  model.edges.push({ from, to, label, line: -1 })
}

/** 删除节点（级联删除关联边与 meta） */
export function removeNode(model: FlowModel, id: string): void {
  model.nodes.delete(id)
  model.metaById.delete(id)
  model.edges = model.edges.filter((e) => e.from !== id && e.to !== id)
}

/** 删除边（按引用序） */
export function removeEdge(model: FlowModel, index: number): void {
  model.edges.splice(index, 1)
}

/** 更新节点 label/shape */
export function updateNode(model: FlowModel, id: string, patch: Partial<Pick<FlowNode, 'label' | 'shape'>>): void {
  const n = model.nodes.get(id)
  if (!n) return
  Object.assign(n, patch)
}

/** 设置节点 meta（null=删除） */
export function setNodeMeta(model: FlowModel, id: string, meta: Record<string, unknown> | null): void {
  const n = model.nodes.get(id)
  if (!n) return
  if (meta === null) {
    delete n.meta
    model.metaById.delete(id)
  } else {
    n.meta = meta
    model.metaById.set(id, meta)
  }
}

/** 更新边 label（按 edges 下标） */
export function updateEdgeLabel(model: FlowModel, index: number, label: string): void {
  const e = model.edges[index]
  if (e) e.label = label
}

// ───────────────────────── mindmap 方言（缩进树 → FlowModel 适配） ─────────────────────────
// 设计：脑图语法（缩进层级树）复用 FlowModel/编辑操作面——节点=缩进行，父子=隐式边；
// 序列化=整树重建（缩进 2 空格/层），非 raw 优先（缩进语言无逐行边语句可言）。
// 契约：装饰（((x))/(x)/[x]/{x}）经 shape 往返；纯文本节点经 bare 往返；
//       tab 缩进归一为 2 空格（mermaid 拒 tab——broken-tab 夹具在本编辑器可编辑即此意）；
//       无法识别的行宽容按纯文本节点收编（永不失败）；注释行不保留（整树重建）。

const MINDMAP_HEADER_RE = /^\s*mindmap\s*$/

/** 是否 mindmap 语法源（首条有效行=mindmap 头；meta/注释行跳过） */
export function isMindmapSource(text: string): boolean {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('%%')) continue
    return MINDMAP_HEADER_RE.test(line)
  }
  return false
}

/** mindmap 行 token → 形状/纯文本。装饰=尾部包裹（mermaid mindmap 形态 `root((x))`/`id1[x]`——
 *  前缀 id 被 mermaid 忽略显示；前缀非干净标识符（含 CJK 等）则整行按纯文本，防 `分支(x)` 误吞文本） */
function mindmapToken(token: string): { label: string; shape: FlowShape; bare: boolean; mmId?: string } {
  const t = token.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return { label: unquoteLabel(t), shape: 'rect', bare: true }
  for (const [open, close, shape] of SHAPE_PAIRS) {
    if (t.endsWith(close) && t.includes(open)) {
      const openIdx = t.indexOf(open)
      const prefix = t.slice(0, openIdx).trim()
      const label = unquoteLabel(t.slice(openIdx + open.length, t.length - close.length))
      if (prefix === '') return { label, shape, bare: false }
      if (/^[A-Za-z0-9_]+$/.test(prefix)) return { label, shape, bare: false, mmId: prefix }
      break // 前缀非干净 id（如 CJK 文本自带括号）→ 整行纯文本
    }
  }
  return { label: t, shape: 'rect', bare: true }
}

/** mindmap 节点序列化 token：纯文本含形状定界字符时包 ["…"]（防 mermaid 歧义）；
 *  装饰节点=mmId 前缀 + 形状包裹（不带合成 id m<n>——mindmap 无 id 语义，原前缀原样保真） */
function mindmapNodeToken(node: Pick<FlowNode, 'label' | 'shape' | 'bare' | 'mmId'>): string {
  if (node.bare) {
    if (needsQuote(node.label)) return `[${escapeLabel(node.label)}]`
    return node.label
  }
  const label = escapeLabel(node.label)
  const prefix = node.mmId ?? ''
  switch (node.shape) {
    case 'circle':
      return `${prefix}((${label}))`
    case 'diamond':
      return `${prefix}{${label}}`
    case 'round':
      return `${prefix}(${label})`
    default:
      return `${prefix}[${label}]`
  }
}

/** 解析 mindmap 源文本为 FlowModel（宽容口径：无法识别的行按纯文本节点收编，永不失败） */
export function parseMindmap(text: string): FlowModel {
  const model = emptyModel('mindmap')
  model.lines = text.split('\n')
  const stack: Array<{ id: string; indent: number }> = []
  let seq = 0
  model.lines.forEach((line, i) => {
    if (MINDMAP_HEADER_RE.test(line)) {
      model.header = line
      model.headerLine = i
      return
    }
    const mm = META_RE.exec(line)
    if (mm) {
      if (model.metaIndent === null) model.metaIndent = /^[\t ]*/.exec(line)![0]
      const key = mm[1] ?? ''
      const body = (mm[2] ?? '').trim()
      if (key.startsWith('schema=')) {
        model.metaSchema = key
      } else {
        try {
          model.metaById.set(key, JSON.parse(body || '{}') as Record<string, unknown>)
        } catch {
          console.warn(`[flow-model] meta 行 JSON 非法，已忽略（line ${i + 1}）`)
        }
      }
      return
    }
    if (line.trim() === '' || /^\s*%%/.test(line)) return
    // tab 归一为 2 空格（mermaid mindmap 拒 tab 缩进；本编辑器宽容）
    const indent = (line.replace(/\t/g, '  ').match(/^\s*/) ?? [''])[0].length
    const tk = mindmapToken(line.trim())
    const id = `m${++seq}`
    while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop()
    model.nodes.set(id, { id, label: tk.label, shape: tk.shape, bare: tk.bare, mmId: tk.mmId, defLine: i })
    const parent = stack.at(-1)
    if (parent) model.edges.push({ from: parent.id, to: id, label: '', line: i })
    stack.push({ id, indent })
  })
  for (const [id, meta] of model.metaById) {
    const n = model.nodes.get(id)
    if (n) n.meta = meta
  }
  return model
}

/** 序列化 mindmap：整树重建（缩进 2 空格/层；meta 块跟 header；游离节点=额外根） */
export function serializeMindmap(model: FlowModel): string {
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const e of model.edges) {
    if (!model.nodes.has(e.from) || !model.nodes.has(e.to)) continue
    const list = children.get(e.from)
    if (list) list.push(e.to)
    else children.set(e.from, [e.to])
    hasParent.add(e.to)
  }
  const out: string[] = [model.header]
  const ind = model.metaIndent ?? '  '
  if (model.metaSchema) out.push(`${ind}%% meta: ${model.metaSchema}`)
  for (const [id, meta] of model.metaById) {
    out.push(`${ind}%% meta: ${id} ${JSON.stringify(meta)}`)
  }
  const seen = new Set<string>()
  const emit = (id: string, depth: number): void => {
    if (seen.has(id)) return // 环防御（畸形边输入）
    seen.add(id)
    const n = model.nodes.get(id)
    if (!n) return
    out.push(`${'  '.repeat(depth + 1)}${mindmapNodeToken(n)}`)
    for (const c of children.get(id) ?? []) emit(c, depth + 1)
  }
  // mermaid 硬约束「only one root」：首个无入边节点=主根，其余孤儿（面板新增未连）收拢为其子节点
  const rootIds = [...model.nodes.values()].filter((n) => !hasParent.has(n.id)).map((n) => n.id)
  if (rootIds.length > 0) emit(rootIds[0]!, 0)
  for (const extra of rootIds.slice(1)) emit(extra, 1)
  return out.join('\n')
}
