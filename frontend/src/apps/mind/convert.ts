/**
 * FlowModel 树 ↔ 引擎树双向转换 + 身份键 best-effort 合并（apps/mind 转换面）
 * 契约正本：docs/design/mind-editor-redesign/plan.md §四/D4 + .claude/mind-loop-state.md MC0 契约节
 *
 * 前置条件（MC0-V P2-2 裁决）：模型须为树——treeShape 以 serializeMindmap seen 同口径做环防御，
 * 环边/重复边静默截断为树（环输入不炸栈、成树截断面）；正常树输入行为不变。
 *
 * 口径（MC0-T 裁决 2/3/5 + MC0-V P1-2）：
 *  - toEngineTree：形状→style 仅视觉近似——circle→borderRadius:'50%'、显式 [x]（square）→'0px'、
 *    rounded 与 bare 纯文本（「无框叶子」）不写 borderRadius；**数据保真靠 base 模型 shape 字段**
 *    （回序列化用 base 形状 token，视觉近似不回写）。树形与 serializeMindmap 同构：
 *    边序孩子 + 多根折叠为主根孩子。
 *  - fromEngineTree：身份键（文本+路径，buildNodeKey）best-effort **消费式对位**（P1-2）——
 *    base 同键节点按基座孩子序入池，重建端按引擎序取首个未消费项（同名兄弟按引擎孩子序
 *    对位）；键可配对→复用 base 节点装饰（shape/bare/mmId，零漂移——契约细化为「键可配对
 *    含同名兄弟按序消费」零漂移）；键耗尽/漂移→缺省重建降级（文本取引擎、形状缺省、装饰丢、
 *    树结构不丢）；树结构（增删/重排）以引擎树为准；返回新 FlowModel（不可变，不改 base）。
 *    meta 通道不搬运（node.meta/metaById 归 MC3 装配面——保存链以 writeMetaBlock 独立重建 meta 块）。
 *    MC3 陷阱（评审实证）：输出模型 metaById/metaSchema 恒空，serializeMindmap 对其零 meta 行
 *    发射——保存链 meta 块**只能拼接 writeMetaBlock 行 OR 回填模型 metaById 二选一，禁叠加**
 *    （叠加=同键双行）。
 *
 * 零引擎依赖：不 import simple-mind-map——引擎形状用本地最小契约 EngineNode 声明。
 */
import { emptyModel } from '../flow-model'
import type { FlowEdge, FlowModel, FlowNode } from '../flow-model'
import { buildNodeKey } from './meta'

/** simple-mind-map 节点树最小本地契约（仅声明转换面依赖字段；引擎超集键容忍不炸） */
export interface EngineNode {
  data: { text: string; uid?: string; style?: Record<string, unknown>; [k: string]: unknown }
  children: EngineNode[]
}

// ───────────────────────── 序列化同构树形（to/from 两侧共用，防口径漂移） ─────────────────────────

/** 边序孩子表 + 根序（无入边节点按插入序）；多根时次根（孤儿）折叠为主根孩子——
 *  对齐 serializeMindmap「only one root」口径（孤儿=主根子节点）。
 *  环防御（MC0-V P2-2 裁决）：seen 集与 serializeMindmap 同口径——自主根按孩子序遍历，
 *  重复到达的环边/重复边静默截断（前置条件「模型须为树」的兜底：环输入不炸栈、成树截断面） */
function treeShape(model: FlowModel): { rootIds: string[]; children: Map<string, string[]> } {
  const rawChildren = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const e of model.edges) {
    if (!model.nodes.has(e.from) || !model.nodes.has(e.to)) continue
    const list = rawChildren.get(e.from)
    if (list) list.push(e.to)
    else rawChildren.set(e.from, [e.to])
    hasParent.add(e.to)
  }
  const rootIds = [...model.nodes.values()].filter((n) => !hasParent.has(n.id)).map((n) => n.id)
  const primary = rootIds[0]
  if (primary !== undefined && rootIds.length > 1) {
    rawChildren.set(primary, [...(rawChildren.get(primary) ?? []), ...rootIds.slice(1)])
  }
  const children = new Map<string, string[]>()
  const seen = new Set<string>()
  const walk = (id: string): void => {
    if (seen.has(id)) return // 环防御（serializeMindmap 同口径：重复到达不二次展开）
    seen.add(id)
    const kids: string[] = []
    for (const c of rawChildren.get(id) ?? []) {
      if (seen.has(c)) continue // 环边静默截断
      kids.push(c)
      walk(c) // 先展开再收 kids 终稿——重复边目标已在递归中标记 seen，自然被跳过
    }
    children.set(id, kids)
  }
  if (primary !== undefined) walk(primary)
  return { rootIds, children }
}

// ───────────────────────── toEngineTree（模型树 → 引擎树） ─────────────────────────

/** 形状→引擎 style 视觉近似（仅渲染近似，不回写数据）：circle→'50%'、显式 [x]→'0px'；
 *  rounded/bare/diamond 缺省不写（MC0-T 裁决 2：bare=无框叶子口径） */
function shapeApproxStyle(n: FlowNode): Record<string, unknown> | null {
  if (n.shape === 'circle') return { borderRadius: '50%' }
  if (n.shape === 'rect' && n.bare !== true) return { borderRadius: '0px' }
  return null
}

/** 模型树 → 引擎数据树（空模型=children 空的占位根，不抛） */
export function toEngineTree(model: FlowModel): EngineNode {
  const { rootIds, children } = treeShape(model)
  const primary = rootIds[0]
  if (primary === undefined) return { data: { text: '' }, children: [] } // 空树占位根
  const conv = (id: string): EngineNode => {
    const n = model.nodes.get(id)
    if (!n) return { data: { text: '' }, children: [] }
    const data: EngineNode['data'] = { text: n.label }
    const style = shapeApproxStyle(n)
    if (style) data.style = style
    return { data, children: (children.get(id) ?? []).map(conv) } // 孤儿已由 treeShape 折叠
  }
  return conv(primary)
}

// ───────────────────────── fromEngineTree（编辑树合并回 base 模型） ─────────────────────────

/** 编辑树合并回 base：返回新 FlowModel（不可变，不改 base）。
 *  身份键**消费式对位**（MC0-V P1-2 裁决）：同键 base 节点按基座孩子序入池，重建端按引擎序
 *  取首个未消费项（同名兄弟按引擎孩子序对位）；可配对→复用 base 节点装饰（零漂移）；
 *  键耗尽/漂移（改名/新增）→缺省形态重建（纯文本，装饰降级不丢树）；树结构以引擎树为准。
 *  MC3 陷阱：输出模型 metaById/metaSchema 恒空，serializeMindmap 零 meta 行发射——保存链
 *  meta 块只能拼接 writeMetaBlock 行 OR 回填 metaById 二选一，禁叠加（同键双行） */
export function fromEngineTree(root: EngineNode, base: FlowModel): FlowModel {
  // 基座身份键索引：祖先文本链 → base 节点池（同键多节点按基座孩子序追加；
  // 孤儿折叠口径与 toEngineTree 一致）
  const { rootIds, children } = treeShape(base)
  const byKey = new Map<string, FlowNode[]>()
  const indexBase = (id: string, path: string[]): void => {
    const n = base.nodes.get(id)
    if (!n) return
    const p = [...path, n.label]
    const key = buildNodeKey(p)
    const pool = byKey.get(key)
    if (pool) pool.push(n)
    else byKey.set(key, [n])
    for (const c of children.get(id) ?? []) indexBase(c, p)
  }
  const primary = rootIds[0]
  if (primary !== undefined) indexBase(primary, [])

  const out = emptyModel(base.header)
  let seq = 0
  // 引擎树自顶向下重建：边=父子隐式边（顺序=引擎孩子序）；新模型独立命名域
  // `r<n>`——id 不入 mindmap 序列化 token（mindmapNodeToken 不用 id），无碰撞面
  const rebuild = (en: EngineNode, path: string[], parent: string | null): void => {
    const text = typeof en.data?.text === 'string' ? en.data.text : ''
    const p = [...path, text]
    // 消费式对位（P1-2）：按引擎序取该键首个未消费项；池耗尽/无键→缺省重建降级
    const matched = byKey.get(buildNodeKey(p))?.shift()
    const id = `r${++seq}`
    out.nodes.set(
      id,
      matched
        ? // 键可配对：装饰保留（shape/bare/mmId/defLine）；meta 不搬运（MC0-T 裁决 5）
          { id, label: text, shape: matched.shape, bare: matched.bare, mmId: matched.mmId, defLine: matched.defLine }
        : // 键漂移/池耗尽：装饰降级不丢树——缺省形态=纯文本（无框叶子），文本取引擎
          { id, label: text, shape: 'rect', bare: true, defLine: -1 },
    )
    if (parent !== null) {
      const edge: FlowEdge = { from: parent, to: id, label: '', line: -1 }
      out.edges.push(edge)
    }
    for (const c of en.children ?? []) rebuild(c, p, id)
  }
  rebuild(root, [], null)
  return out
}
