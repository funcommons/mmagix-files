/**
 * 流程图编辑渲染器（flow-editor）——graph TD 子集的可视化编辑（MVP-③④ 完全体）
 * 设计正本：《docs/design/flow-editor-design.md》V1.0 §四/§四.3
 *
 * 能力面：
 *  - 工具栏：统一编辑钮簇（保存红点｜撤销 重做 重置，shared/editToolbar 唯一样式源——一百四十三番：
 *    dirty=保存钮红点，「未保存」文字徽标废弃；重置=恢复打开时内容，快照入撤销栈可反悔回取）
 *    + 图标钮 hover hint（缩放体系 −%＋适应/1:1/形状下拉/连线/删除/导出 SVG/只读徽标）；
 *    hint 走 root 级共享浮层（工具栏 overflow-x:auto 会裁剪 CSS 伪元素气泡）
 *  - 形状下拉：5 类语义模板（开始·过程·判定·输入输出·结束，预设色板）收敛为单钮下拉
 *  - 选中效果：X6 boundary 工具（主色虚线包围盒），节点/边一致；点空白清除
 *  - 多行文本：属性面板 label 为 textarea；节点内 textWrap 换行；序列化经 `\n` 转义序列保持源单行
 *  - 自适应尺寸：measureBox 按 label 逐行估宽（CJK 全宽/半宽），节点盒随文本自动伸缩
 *  - 自定义填充色经 meta.style 持久化（%% meta 通道）；快照式撤销/重做（上限 50）；
 *    Delete 删除选中；Ctrl+S / Ctrl+Z / Ctrl+Y；snapline 对齐线；拖拽移动、两击连线
 *  - 回写：行级 patch（raw 优先/透传）→ Ctrl+S 或保存钮 → putObject；
 *    关闭确认（3s 竞速）+ 4305 运行期只读闩锁，与 code-editor 同口径
 *  - 非 graph TD 语法（mindmap/时序/架构）内部降级只读 mermaid 渲染
 *  - 位置持久化：拖拽即编辑（快照→标脏→保存）；坐标写 meta 块伪节点 `%% meta: _layout {"positions":{…}}`
 *    （mermaid 注释透传，AI 可读性不破；重开还原，无 pos 节点落 dagre 自动布局）
 * X6/dagre/snapline 全动态 import；jsdom 测试经模块 mock 注入桩。
 * X6 v2 适配口径（回归 2026-10-13-01 DEF 修复）：zoom 读-算-写绝对值（zoom(factor) 是增量陷阱）/
 * ctrl+滚轮手工监听（v2 mousewheel 配置不生效）/导出走画布 SVG 序列化（v2 无 toSVG）/
 * applyNodeCell 重建节点后按模型补回相邻边（v2 removeCell 级联移除边视图）。
 */
import {
  addNode,
  connect,
  isMindmapSource,
  parseFlowchart,
  parseMindmap,
  removeNode,
  serializeFlowchart,
  serializeMindmap,
  setNodeMeta,
  updateEdgeLabel,
  updateNode,
  type FlowModel,
  type FlowShape,
} from '../flow-model'
import { MERMAID_MAX_BYTES } from '../builtins'
import { formatBytes } from '../../files/format'
import { createEditToolbar } from '../../shared/editToolbar'
import type { AppCtx, AppDefinition, AppInstance, DisposeReason } from '../../sdk/types'

const TOO_LARGE_KEY = 'app.mermaid-too-large'
const LOAD_FAIL_KEY = 'app.mermaid-load-fail'
const UNSAVED_KEY = 'app.code-unsaved'
const READONLY_KEY = 'app.code-readonly'

/** 位置持久化通道：meta 块伪节点 `%% meta: _layout {"positions":{…}}`（mermaid 注释透传，渲染无关数据） */
const LAYOUT_KEY = '_layout'

// ───────────────────────── 节点类型模板（语义配色，形状落 mermaid 子集） ─────────────────────────

interface KindPreset {
  id: string
  labelKey: string
  shape: FlowShape
  fill: string
  stroke: string
}

const KIND_PRESETS: KindPreset[] = [
  { id: 'start', labelKey: 'app.flow-kind-start', shape: 'circle', fill: '#ecfdf5', stroke: '#10b981' },
  { id: 'process', labelKey: 'app.flow-kind-process', shape: 'rect', fill: '#eff6ff', stroke: '#3b82f6' },
  { id: 'decision', labelKey: 'app.flow-kind-decision', shape: 'diamond', fill: '#fffbeb', stroke: '#f59e0b' },
  { id: 'io', labelKey: 'app.flow-kind-io', shape: 'round', fill: '#fdf4ff', stroke: '#a855f7' },
  { id: 'end', labelKey: 'app.flow-kind-end', shape: 'circle', fill: '#fef2f2', stroke: '#ef4444' },
]

function presetOf(kind: string): KindPreset | undefined {
  return KIND_PRESETS.find((k) => k.id === kind)
}

// ───────────────────────── 工具栏图标（16×描边风格，stroke=currentColor） ─────────────────────────

const icon = (paths: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

const ICONS = {
  zoomOut: icon('<circle cx="7.5" cy="7.5" r="4"/><path d="M10.8 10.8 13.5 13.5"/><path d="M5.8 7.5h3.4"/>'),
  zoomIn: icon('<circle cx="7.5" cy="7.5" r="4"/><path d="M10.8 10.8 13.5 13.5"/><path d="M5.8 7.5h3.4"/><path d="M7.5 5.8v3.4"/>'),
  fit: icon('<path d="M2.5 5.5v-3h3"/><path d="M10.5 2.5h3v3"/><path d="M13.5 10.5v3h-3"/><path d="M5.5 13.5h-3v-3"/>'),
  shapes: icon('<rect x="2.5" y="2.5" width="7" height="7" rx="1"/><circle cx="10.8" cy="10.8" r="3"/>'),
  connect: icon('<circle cx="4" cy="12" r="1.8"/><circle cx="12" cy="4" r="1.8"/><path d="M5.3 10.7 10.7 5.3"/>'),
  trash: icon('<path d="M3 4.5h10"/><path d="M5.5 4.5V3h5v1.5"/><path d="M4.5 4.5 5 13h6l.5-8.5"/>'),
  export: icon('<path d="M8 2.5v7"/><path d="M5.5 7 8 9.5 10.5 7"/><path d="M3 11v2.5h10V11"/>'),
  caret: icon('<path d="M4.5 6.5 8 10l3.5-3.5"/>'),
} as const

function showTooLargeTip(el: HTMLElement, ctx: AppCtx): AppInstance {
  const tip = document.createElement('div')
  tip.className = 'flow-too-large-tip'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = ctx.t(TOO_LARGE_KEY, { limit: formatBytes(MERMAID_MAX_BYTES) })
  el.replaceChildren(tip)
  return { dispose: () => void (el.innerHTML = '') }
}

function buildFailTip(el: HTMLElement, ctx: AppCtx): AppInstance {
  const tip = document.createElement('div')
  tip.className = 'mmagic-flow-fail'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = ctx.t(LOAD_FAIL_KEY)
  el.replaceChildren(tip)
  return { dispose: () => void (el.innerHTML = '') }
}

/** confirm 包装：原生同步应答转 Promise，与 3s 超时竞速（code.ts 同口径） */
function confirmWithTimeout(message: string, timeoutMs = 3000): Promise<boolean> {
  const answer = window.confirm(message) as boolean | Promise<boolean>
  return Promise.race([Promise.resolve(answer), new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs))])
}

/** mermaid.render 唯一 id 序号（降级只读渲染用） */
let renderSeq = 0

// ───────────────────────── 渲染器 ─────────────────────────

export const flowEditorRenderer: AppDefinition['renderer'] = async (el, file, ctx) => {
  const blob = await ctx.getObject(file.key)
  if (blob.size > MERMAID_MAX_BYTES) return showTooLargeTip(el, ctx)

  const text = await blob.text()

  // absolute inset 填充宿主（防塌陷，code-editor 同口径），dispose 还原 el 内联样式
  const prevElPos = el.style.position
  el.style.position = 'relative'

  const style = document.createElement('style')
  style.textContent = `
.mmagic-flow{position:absolute;inset:0;display:flex;flex-direction:column;
  box-sizing:border-box;background:var(--app-bg-card,#fff)}
.mmagic-flow__bar{display:flex;align-items:center;gap:3px;flex:none;padding:4px 8px;
  border-bottom:1px solid var(--app-separator,#e5e7eb);overflow-x:auto}
.mmagic-flow__bar button{display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:26px;height:24px;padding:0;font-size:12px;
  color:var(--app-text-secondary,#666);background:transparent;border:1px solid transparent;
  border-radius:var(--app-radius-button,6px);cursor:pointer;transition:background .15s,color .15s;white-space:nowrap}
.mmagic-flow__bar button:hover:not(:disabled){background:var(--app-bg-muted,#f5f5f5);color:var(--app-text-primary,#111)}
.mmagic-flow__bar button.is-active{background:var(--brand-primary-soft,var(--el-color-primary-light-9,#ecf5ff));
  color:var(--el-color-primary,#409eff)}
.mmagic-flow__bar button:disabled{opacity:.4;cursor:not-allowed}
.mmagic-flow__bar button svg{width:15px;height:15px;display:block}
.mmagic-flow__bar button.is-text{width:auto;padding:0 7px}
.mmagic-flow__bar .sep{flex:none;width:1px;height:18px;background:var(--app-separator,#e5e7eb);margin:0 5px}
.mmagic-flow__zoom{flex:none;font-size:12px;color:var(--app-text-secondary,#666);min-width:40px;text-align:center}
.mmagic-flow__dot{display:inline-block;width:8px;height:8px;border-radius:50%;border:1px solid rgba(0,0,0,.2);flex:none}
.mmagic-flow__badge{margin-left:auto;font-size:12px;padding:1px 8px;border-radius:999px}
.mmagic-flow__badge.is-readonly{background:var(--app-bg-muted,#f5f5f5);color:var(--app-text-secondary,#666)}
.mmagic-flow__badge:empty{display:none}
.mmagic-flow__tip{position:absolute;z-index:30;pointer-events:none;opacity:0;transition:opacity .12s;
  background:var(--app-text-primary,#1f2937);color:var(--app-bg-card,#fff);font-size:11px;line-height:1;
  padding:5px 8px;border-radius:4px;white-space:nowrap;transform:translateX(-50%)}
.mmagic-flow__tip.is-on{opacity:1}
.mmagic-flow__menu{position:absolute;z-index:31;min-width:128px;padding:4px;display:none;flex-direction:column;gap:2px;
  background:var(--app-bg-card,#fff);border:1px solid var(--app-separator,#e5e7eb);
  border-radius:var(--app-radius-md,8px);box-shadow:0 8px 24px rgba(0,0,0,.12)}
.mmagic-flow__menu.is-open{display:flex}
.mmagic-flow__menu button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;font-size:12px;
  color:var(--app-text-primary,#111);background:transparent;border:none;border-radius:6px;cursor:pointer;text-align:left}
.mmagic-flow__menu button:hover:not(:disabled){background:var(--app-bg-muted,#f5f5f5)}
.mmagic-flow__menu button:disabled{opacity:.4;cursor:not-allowed}
.mmagic-flow__body{flex:1;display:flex;min-height:0}
.mmagic-flow__canvas{flex:1;min-width:0;position:relative}
.mmagic-flow__panel{flex:none;width:216px;overflow:auto;box-sizing:border-box;
  border-left:1px solid var(--app-separator,#e5e7eb);padding:10px;display:none;
  flex-direction:column;gap:8px;font-size:12px}
.mmagic-flow__panel.is-open{display:flex}
.mmagic-flow__panel .row{display:flex;align-items:center;gap:6px}
.mmagic-flow__panel label{color:var(--app-text-secondary,#666);flex:none;width:56px}
.mmagic-flow__panel input,.mmagic-flow__panel select,.mmagic-flow__panel textarea{
  font:inherit;padding:2px 6px;border:1px solid var(--app-separator,#e5e7eb);border-radius:4px;
  background:var(--app-bg-card,#fff);color:var(--app-text-primary,#111);width:100%;box-sizing:border-box}
.mmagic-flow__panel textarea{min-height:52px;font-family:monospace;resize:vertical}
.mmagic-flow__panel textarea.is-label{min-height:48px;font-family:inherit;line-height:1.5}
.mmagic-flow__panel input[type='color']{padding:0;height:26px}
.mmagic-flow.is-readonly .mmagic-flow__bar button[data-edit-only],
.mmagic-flow.is-readonly .mmagic-flow__panel{display:none}
`
  const root = document.createElement('div')
  root.className = 'mmagic-flow'
  const bar = document.createElement('div')
  bar.className = 'mmagic-flow__bar'
  const body = document.createElement('div')
  body.className = 'mmagic-flow__body'
  const canvas = document.createElement('div')
  canvas.className = 'mmagic-flow__canvas'
  body.appendChild(canvas)
  root.append(bar, body)
  el.replaceChildren(style, root)

  // ── 解析 + 语法守卫 ──
  let model: FlowModel
  /** 源方言：mindmap 走 parseMindmap/serializeMindmap（缩进树），flowchart 走原链（一百四十七番） */
  let mindmapDialect = false
  try {
    mindmapDialect = isMindmapSource(text)
    model = mindmapDialect ? parseMindmap(text) : parseFlowchart(text)
    // 语法守卫：flowchart 首条非空行必须 graph/flowchart 头；mindmap 必须有节点——
    // 其余同扩展名语法（sequence/architecture 等）降级只读 mermaid 渲染，保证「双击就能看」
    const firstLine = model.lines.find((l) => l.trim() !== '') ?? ''
    const dialectOk = mindmapDialect
      ? model.nodes.size > 0
      : /^\s*(graph|flowchart)\s/.test(firstLine)
    if (dialectOk === false || (model.nodes.size === 0 && model.edges.length === 0)) {
      const mermaid = (await import('mermaid')).default
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
      const { svg } = await mermaid.render(`mmf-flow-ro-${++renderSeq}`, text)
      const view = document.createElement('div')
      view.className = 'mmagic-mermaid'
      view.innerHTML = svg
      el.replaceChildren(view)
      return { dispose: () => view.remove() }
    }
  } catch {
    el.style.position = prevElPos
    return buildFailTip(el, ctx)
  }

  // ── 状态面 ──
  let dirty = false
  let saving = false
  let readonly = false
  let selectedNode: string | null = null
  let selectedEdge = -1
  let connectFrom: string | null = null
  let connectMode = false
  let disposed = false
  /** 画布尺寸跟随（DEF-5） */
  let resizeObserver: ResizeObserver | null = null
  let zoomLabel: HTMLSpanElement | null = null
  /** 位置缓存（拖拽/重建保位；不入源——mermaid 源只有拓扑） */
  const positions = new Map<string, { x: number; y: number }>()
  /** 撤销/重做快照栈（serialize 文本） */
  let undoStack: string[] = []
  let redoStack: string[] = []
  /** 历史闸：loadSnapshot 重建期间不再入栈 */
  let restoring = false
  /** 选中效果当前挂载的 cell id（boundary 工具） */
  let visualSelId: string | null = null
  /** 用户是否手动调过视图（缩放/适应）；true 后 resize 不再自动重适配，尊重用户视角 */
  let userAdjustedView = false

  // ── DOM 骨架 ──
  const badge = document.createElement('span')
  badge.className = 'mmagic-flow__badge'
  const panel = document.createElement('div')
  panel.className = 'mmagic-flow__panel'
  const lblLabel = document.createElement('label')
  // 多行文本：label 用 textarea（Enter 换行；序列化经 \n 转义保持源单行）
  const lblInput = document.createElement('textarea')
  lblInput.className = 'is-label'
  lblInput.rows = 2
  const kindLabel = document.createElement('label')
  const kindSel = document.createElement('select')
  for (const k of KIND_PRESETS) {
    const o = document.createElement('option')
    o.value = k.id
    o.textContent = ctx.t(k.labelKey)
    kindSel.appendChild(o)
  }
  const fillLabel = document.createElement('label')
  fillLabel.textContent = ctx.t('app.flow-fill')
  const fillInput = document.createElement('input')
  fillInput.type = 'color'
  const metaLabel = document.createElement('label')
  metaLabel.textContent = ctx.t('app.flow-meta')
  const metaInput = document.createElement('textarea')
  metaInput.placeholder = '{"key":"value"}'
  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.textContent = ctx.t('app.flow-apply')
  applyBtn.dataset.testid = 'flow-apply'
  panel.append(lblLabel, lblInput, kindLabel, kindSel, fillLabel, fillInput, metaLabel, metaInput, applyBtn)
  body.appendChild(panel)

  let graphApi: {
    addEdge: (o: Record<string, unknown>) => unknown
    removeCell: (id: string) => void
    removeAll: () => void
    upsertNode: (o: Record<string, unknown>) => void
    setEdgeLabels: (index: number, labels: unknown[]) => void
    /** 选中效果：boundary 工具挂到目标 cell（null=清除） */
    selectVisual: (id: string | null) => void
    on: (ev: string, h: (arg: { node?: { id: string }; edge?: { id: string }; cell?: { id: string } }) => void) => void
    zoomTo: (f: number) => unknown
    zoomToFit: (o: unknown) => unknown
    getZoom: () => number
    centerContent: () => void
    dispose: () => void
  } | null = null

  const editBtns: HTMLButtonElement[] = []
  const sep = (): HTMLDivElement => {
    const s = document.createElement('div')
    s.className = 'sep'
    bar.appendChild(s)
    return s
  }

  // ── hover hint（root 级共享浮层：bar 的 overflow-x:auto 会裁剪伪元素气泡） ──
  const tipEl = document.createElement('div')
  tipEl.className = 'mmagic-flow__tip'
  root.appendChild(tipEl)
  const hideTip = (): void => tipEl.classList.remove('is-on')
  const showTip = (btn: HTMLElement): void => {
    const msg = btn.dataset.tip ?? ''
    if (msg === '') return
    tipEl.textContent = msg
    const b = btn.getBoundingClientRect()
    const r = root.getBoundingClientRect()
    tipEl.style.left = `${b.left - r.left + b.width / 2}px`
    tipEl.style.top = `${b.bottom - r.top + 6}px`
    tipEl.classList.add('is-on')
  }
  const bindTip = (btn: HTMLElement): void => {
    btn.addEventListener('mouseenter', () => showTip(btn))
    btn.addEventListener('mouseleave', hideTip)
    btn.addEventListener('focus', () => showTip(btn))
    btn.addEventListener('blur', hideTip)
    btn.addEventListener('click', hideTip)
  }

  /** 图标钮：icon + hint 文字（data-tip/title/aria-label 三通道） */
  const iconBtn = (svg: string, tipKey: string, testid: string, onClick: () => void, opts?: { editOnly?: boolean; text?: string }): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.innerHTML = svg
    if (opts?.text) {
      const t = document.createElement('span')
      t.textContent = opts.text
      b.appendChild(t)
      b.classList.add('is-text')
    }
    b.dataset.testid = testid
    b.dataset.tip = ctx.t(tipKey)
    b.title = ctx.t(tipKey)
    b.setAttribute('aria-label', ctx.t(tipKey))
    if (opts?.editOnly) {
      b.dataset.editOnly = '1'
      editBtns.push(b)
    }
    b.addEventListener('click', onClick)
    bindTip(b)
    bar.appendChild(b)
    return b
  }

  // ── 徽标/闸 ──
  // dirty 只走统一钮簇保存钮红点（一百四十三番）；徽标仅剩只读文案
  function renderBadge(): void {
    badge.className = `mmagic-flow__badge${readonly ? ' is-readonly' : ''}`
    badge.textContent = readonly ? ctx.t(READONLY_KEY) : ''
    toolbar.setDirty(dirty)
    toolbar.setBusy(saving || readonly)
    toolbar.setReadonly(readonly)
    toolbar.setHistory(undoStack.length > 0, redoStack.length > 0)
  }
  function applyEdits(): void {
    for (const b of editBtns) b.disabled = readonly
    applyBtn.disabled = readonly
    // 形状下拉菜单项与下拉钮随闸禁用
    if (shapeMenu) for (const b of shapeMenu.querySelectorAll<HTMLButtonElement>('button')) b.disabled = readonly
    shapeBtn.disabled = readonly
  }
  function setReadonly(): void {
    readonly = true
    root.classList.add('is-readonly')
    closeShapeMenu()
    applyEdits()
    renderBadge()
  }
  function markDirty(): void {
    if (readonly) return
    dirty = true
    renderBadge()
  }
  /** 变更前置快照（撤销栈） */
  function snapshot(): void {
    if (restoring || readonly) return
    try {
      undoStack.push(mindmapDialect ? serializeMindmap(model) : serializeFlowchart(model))
    } catch (e) {
      console.warn('FLOW_SNAP_THROW', String(e)?.slice(0, 200))
    }
    if (undoStack.length > 50) undoStack.shift()
    redoStack = []
    syncHistBtns()
  }
  function syncHistBtns(): void {
    toolbar.setHistory(undoStack.length > 0, redoStack.length > 0)
  }
  /** 从模型 meta 通道恢复位置缓存（init / 撤销重做回放共用；无 pos 的节点落 dagre 兜底） */
  function hydrateLayout(): void {
    positions.clear()
    const lm = model.metaById.get(LAYOUT_KEY) as { positions?: Record<string, { x: number; y: number }> } | undefined
    for (const [id, p] of Object.entries(lm?.positions ?? {})) {
      if (model.nodes.has(id) && typeof p?.x === 'number' && typeof p?.y === 'number') positions.set(id, p)
    }
  }
  /** 位置缓存 → 模型 meta 通道（拖拽/新增后调用；save 前幂等兜底） */
  function syncLayout(): void {
    const pos: Record<string, { x: number; y: number }> = {}
    for (const [id, p] of positions) if (model.nodes.has(id)) pos[id] = p
    if (Object.keys(pos).length > 0) model.metaById.set(LAYOUT_KEY, { positions: pos })
    else model.metaById.delete(LAYOUT_KEY)
  }
  function loadSnapshot(s: string): void {
    restoring = true
    model = mindmapDialect ? parseMindmap(s) : parseFlowchart(s)
    hydrateLayout()
    rebuildAll()
    restoring = false
    markDirty()
    syncHistBtns()
  }
  function undo(): void {
    if (readonly || undoStack.length === 0) return
    redoStack.push(mindmapDialect ? serializeMindmap(model) : serializeFlowchart(model))
    loadSnapshot(undoStack.pop()!)
  }
  function redo(): void {
    if (readonly || redoStack.length === 0) return
    undoStack.push(mindmapDialect ? serializeMindmap(model) : serializeFlowchart(model))
    loadSnapshot(redoStack.pop()!)
  }

  // ── 选中效果（boundary 工具） ──
  function selectVisual(id: string | null): void {
    if (visualSelId === id) return
    graphApi?.selectVisual(id)
    visualSelId = id
  }

  // ── 属性面板 ──
  function openPanel(kind: 'node' | 'edge'): void {
    panel.classList.add('is-open')
    lblLabel.textContent = ctx.t(kind === 'node' ? 'app.flow-label' : 'app.flow-edge-label')
    lblInput.value = kind === 'node' ? (model.nodes.get(selectedNode!)?.label ?? '') : (model.edges[selectedEdge]?.label ?? '')
    const isNode = kind === 'node'
    kindLabel.style.display = isNode ? '' : 'none'
    kindSel.style.display = isNode ? '' : 'none'
    fillLabel.style.display = isNode ? '' : 'none'
    fillInput.style.display = isNode ? '' : 'none'
    metaLabel.style.display = isNode ? '' : 'none'
    metaInput.style.display = isNode ? '' : 'none'
    if (isNode) {
      const n = model.nodes.get(selectedNode!)!
      const preset = KIND_PRESETS.find((k) => k.shape === n.shape && n.meta?.kind === k.id) ?? KIND_PRESETS.find((k) => k.shape === n.shape)
      kindSel.value = preset?.id ?? 'process'
      const fill = (n.meta?.style as { fill?: string } | undefined)?.fill ?? preset?.fill ?? '#eff6ff'
      fillInput.value = fill
      metaInput.value = JSON.stringify(n.meta ?? {})
    }
  }
  function closePanel(): void {
    panel.classList.remove('is-open')
    selectedNode = null
    selectedEdge = -1
    selectVisual(null)
  }
  applyBtn.addEventListener('click', () => {
    snapshot()
    if (selectedNode) {
      const n = model.nodes.get(selectedNode)
      if (!n) return
      if (n.label !== lblInput.value) updateNode(model, selectedNode, { label: lblInput.value })
      const preset = presetOf(kindSel.value)
      if (preset && n.shape !== preset.shape) updateNode(model, selectedNode, { shape: preset.shape })
      // 类型/填充 → meta（kind + style 持久化）
      const base = { kind: preset?.id ?? n.meta?.kind, style: { ...(n.meta?.style as object | undefined), fill: fillInput.value, stroke: preset?.stroke ?? (n.meta?.style as { stroke?: string } | undefined)?.stroke } }
      setNodeMeta(model, selectedNode, metaInput.value.trim() === '' ? null : mergeMeta(metaInput.value, base))
      applyNodeCell(selectedNode)
    } else if (selectedEdge >= 0) {
      updateEdgeLabel(model, selectedEdge, lblInput.value)
      refreshEdgeCell(selectedEdge)
    }
    markDirty()
  })
  /** 合并面板手填 meta 与派生字段（手填 JSON 优先，缺的字段用派生补） */
  function mergeMeta(raw: string, base: Record<string, unknown>): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return { ...base, ...parsed, style: { ...(base.style as object), ...(parsed.style as object | undefined) } }
    } catch {
      return base // 非法 JSON：用派生值（label/形状仍生效）
    }
  }

  // ── 画布操作 ──
  function refreshZoom(): void {
    if (zoomLabel && graphApi) zoomLabel.textContent = `${Math.round(graphApi.getZoom() * 100)}%`
  }
  /** 缩放档位边界（倍率语义：以当前 zoom 为基准乘 k） */
  const ZOOM_MIN = 0.2
  const ZOOM_MAX = 4
  /** DEF-1 修复：X6 v2 zoom(factor) 是增量语义（transform.js sx += scale.sx），
   *  必须读-算-写绝对值 zoomTo(zoom×k)，杜绝「缩小反而变大」 */
  function zoomBy(k: number): void {
    if (!graphApi) return
    userAdjustedView = true
    const z = graphApi.getZoom()
    graphApi.zoomTo(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * k)))
    refreshZoom()
  }
  /** 最佳适配：大图缩小、小图放大（≤100%），内容居中充满可用空间 */
  function fitToView(): void {
    if (!graphApi) return
    graphApi.zoomToFit({ padding: 24, maxScale: 1 })
    refreshZoom()
  }
  function rebuildAll(): void {
    if (!graphApi) return
    // 全量重挂（保留已拖拽过的节点位置；新节点走 dagre 兜底位）
    const fallback = computeDagrePositions()
    graphApi.removeAll()
    visualSelId = null
    for (const n of model.nodes.values()) {
      const p = positions.get(n.id) ?? fallback.get(n.id) ?? { x: 60, y: 60 }
      graphApi.upsertNode({ id: n.id, shape: nodeX6Shape(n.shape), x: p.x, y: p.y, ...nodeBox(n), attrs: nodeAttrs(n) })
    }
    model.edges.forEach((e, i) => {
      graphApi!.addEdge({
        id: `edge-${i}`,
        shape: 'edge',
        source: e.from,
        target: e.to,
        attrs: { line: { stroke: '#94a3b8', strokeWidth: 1.5 } },
        labels: e.label ? [{ attrs: { label: { text: e.label } } }] : [],
      })
    })
    closePanel()
    // 重建（撤销/重做/删除级联）后内容变了：用户没手动调过视图 → 重新最佳适配
    if (!userAdjustedView) fitToView()
  }
  function computeDagrePositions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>()
    // 同步惰性加载在装配期已完成——此处直接用保存的布局器
    if (!layoutFn) return out
    const res = layoutFn(model)
    for (const [id, p] of res) out.set(id, p)
    return out
  }

  // ── 形状下拉（root 级浮层，绕开工具栏 overflow 裁剪） ──
  let shapeMenu: HTMLDivElement | null = null
  let shapeBtn: HTMLButtonElement
  const closeShapeMenu = (): void => {
    shapeMenu?.classList.remove('is-open')
  }
  const addFromPreset = (preset: KindPreset): void => {
    closeShapeMenu()
    if (readonly) return
    snapshot()
    const n0 = [...model.nodes.values()].at(-1)
    const base = positions.get(n0?.id ?? '') ?? { x: 80, y: 80 }
    const id = addNode(model, ctx.t(preset.labelKey), preset.shape)
    setNodeMeta(model, id, { kind: preset.id, style: { fill: preset.fill, stroke: preset.stroke } })
    positions.set(id, { x: base.x + 60 + Math.round(Math.random() * 60), y: base.y + 40 + Math.round(Math.random() * 60) })
    syncLayout()
    // mindmap 方言：新节点自动挂为选中节点的子节点（树语义——流程图仍走两击连线）
    if (mindmapDialect && selectedNode) {
      connect(model, selectedNode, id)
      graphApi?.addEdge({ id: `edge-${model.edges.length - 1}`, shape: 'edge', source: selectedNode, target: id, attrs: { line: { stroke: '#94a3b8', strokeWidth: 1.5 } }, labels: [] })
    }
    graphApi?.upsertNode({ id, shape: nodeX6Shape(preset.shape), ...positions.get(id)!, ...nodeBox(model.nodes.get(id)!), attrs: nodeAttrs(model.nodes.get(id)!) })
    selectVisual(id)
    markDirty()
  }
  const buildShapeMenu = (): HTMLDivElement => {
    const menu = document.createElement('div')
    menu.className = 'mmagic-flow__menu'
    menu.dataset.testid = 'flow-shape-menu'
    for (const k of KIND_PRESETS) {
      const item = document.createElement('button')
      item.type = 'button'
      item.dataset.testid = `flow-kind-${k.id}`
      item.disabled = readonly
      const dot = document.createElement('span')
      dot.className = 'mmagic-flow__dot'
      dot.style.background = k.fill
      dot.style.borderColor = k.stroke
      const name = document.createElement('span')
      name.textContent = ctx.t(k.labelKey)
      item.append(dot, name)
      item.addEventListener('click', () => addFromPreset(k))
      menu.appendChild(item)
    }
    root.appendChild(menu)
    return menu
  }

  // ── 工具栏装配：统一编辑钮簇（保存红点｜撤销 重做 重置——一百四十三番，样式唯源 shared/editToolbar）
  //    testid 透传保留 flow-* 口径（E2E 历史脚本稳定）；重置=恢复打开时内容，快照入撤销栈可反悔回取
  const toolbar = createEditToolbar(
    { save: ctx.t('app.edt-save'), undo: ctx.t('app.edt-undo'), redo: ctx.t('app.edt-redo'), reset: ctx.t('app.edt-reset') },
    { onSave: () => void save(), onUndo: () => undo(), onRedo: () => redo(), onReset: resetToSaved },
  )
  for (const [act, tid] of [
    ['save', 'flow-save'],
    ['undo', 'flow-undo'],
    ['redo', 'flow-redo'],
    ['reset', 'flow-reset'],
  ] as const) {
    toolbar.el.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!.dataset.testid = tid
  }
  bar.appendChild(toolbar.el)
  sep()
  iconBtn(ICONS.zoomOut, 'app.flow-zoom-out', 'flow-zoom-out', () => zoomBy(0.8))
  zoomLabel = document.createElement('span')
  zoomLabel.className = 'mmagic-flow__zoom'
  zoomLabel.textContent = '100%'
  bar.appendChild(zoomLabel)
  iconBtn(ICONS.zoomIn, 'app.flow-zoom-in', 'flow-zoom-in', () => zoomBy(1.25))
  iconBtn(ICONS.fit, 'app.flow-fit', 'flow-fit', () => {
    userAdjustedView = true
    fitToView()
  })
  iconBtn('', 'app.flow-zoom-reset', 'flow-zoom-reset', () => {
    userAdjustedView = true
    graphApi?.zoomTo(1)
    graphApi?.centerContent()
    refreshZoom()
  }, { text: '1:1' })
  sep()
  // 形状下拉钮 + 浮层菜单
  shapeBtn = iconBtn(ICONS.shapes, 'app.flow-shape', 'flow-shape-btn', () => {
    if (shapeMenu?.classList.contains('is-open')) {
      closeShapeMenu()
      return
    }
    if (!shapeMenu) shapeMenu = buildShapeMenu()
    const b = shapeBtn.getBoundingClientRect()
    const r = root.getBoundingClientRect()
    shapeMenu.style.left = `${b.left - r.left}px`
    shapeMenu.style.top = `${b.bottom - r.top + 4}px`
    shapeMenu.classList.add('is-open')
  }, { editOnly: true })
  const caret = document.createElement('span')
  caret.innerHTML = ICONS.caret
  caret.style.display = 'inline-flex'
  shapeBtn.appendChild(caret)
  const connectBtn = iconBtn(ICONS.connect, 'app.flow-connect', 'flow-connect', () => {
    connectMode = !connectMode
    connectFrom = null
    connectBtn.classList.toggle('is-active', connectMode)
  }, { editOnly: true })
  iconBtn(ICONS.trash, 'app.flow-delete', 'flow-delete', () => deleteSelection(), { editOnly: true })
  sep()
  iconBtn(ICONS.export, 'app.flow-export-svg', 'flow-export-svg', () => void exportSvg())
  bar.appendChild(badge)

  // 点击空白处收起形状下拉
  const onDocPointerDown = (ev: PointerEvent): void => {
    const t = ev.target as Node
    if (shapeMenu?.classList.contains('is-open') && !shapeMenu.contains(t) && !shapeBtn.contains(t)) closeShapeMenu()
  }
  document.addEventListener('pointerdown', onDocPointerDown, true)

  function deleteSelection(): void {
    if (selectedNode) {
      snapshot()
      removeNode(model, selectedNode)
      graphApi?.removeCell(selectedNode)
      selectVisual(null)
      rebuildAll()
      closePanel()
      markDirty()
    } else if (selectedEdge >= 0) {
      snapshot()
      const idx = selectedEdge
      graphApi?.removeCell(`edge-${idx}`)
      model.edges.splice(idx, 1)
      selectVisual(null)
      closePanel()
      markDirty()
    }
  }
  /** DEF-3 修复：X6 v2 无 toSVG（v1 API，全包零命中）→ 直接序列化画布 SVG 节点。
   *  补 xmlns / 实际尺寸 / 白底（透明底贴白会看不见），克隆不含工具层不影响内容 */
  function exportSvg(): void {
    const svgEl = canvas.querySelector('.x6-graph-svg') as SVGSVGElement | null
    if (!svgEl) {
      console.warn('FLOW_EXPORT_ERR', 'x6 svg not found')
      return
    }
    try {
      const clone = svgEl.cloneNode(true) as SVGSVGElement
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const r = svgEl.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        clone.setAttribute('width', String(Math.round(r.width)))
        clone.setAttribute('height', String(Math.round(r.height)))
      }
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      bg.setAttribute('width', '100%')
      bg.setAttribute('height', '100%')
      bg.setAttribute('fill', '#ffffff')
      clone.insertBefore(bg, clone.firstChild)
      const svg = new XMLSerializer().serializeToString(clone)
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${file.name.replace(/\.[^.]+$/, '')}.svg`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.warn('FLOW_EXPORT_ERR', String(err)?.slice(0, 200))
    }
  }

  // ── 保存链（code.ts 同口径；saving 闸防重入→保存钮禁用可视） ──
  async function save(): Promise<void> {
    if (readonly || !dirty || saving) return
    saving = true
    renderBadge()
    syncLayout() // 位置缓存兜底同步（拖拽/新增路径已实时写入）
    const value = mindmapDialect ? serializeMindmap(model) : serializeFlowchart(model)
    try {
      await ctx.putObject(file.key, new Blob([value], { type: 'text/plain;charset=utf-8' }))
      ctx.notify('saved', { key: file.key })
      dirty = false
    } catch (err) {
      console.warn('FLOW_SAVE_ERR', String(err)?.slice(0, 200), (err as { code?: number })?.code)
      if ((err as { code?: number }).code === 4305) setReadonly()
      // 瞬时失败：保持 dirty（未保存的内容仍可重试）
    } finally {
      saving = false
      renderBadge()
    }
  }

  /** 重置：放弃未保存修改恢复打开时内容。先快照入撤销栈（可反悔回取），再重解析+全量重建。 */
  function resetToSaved(): void {
    if (readonly || !dirty || restoring) return
    snapshot()
    model = mindmapDialect ? parseMindmap(text) : parseFlowchart(text)
    hydrateLayout()
    rebuildAll()
    dirty = false
    renderBadge()
  }
  const onKeydown = (ev: KeyboardEvent): void => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void save()
      return
    }
    // 撤销/重做：输入框聚焦时让位给原生文本撤销（否则文本撤销 + 画布撤销双触发，用户感知为「撤销乱跳」）
    if (isTypingTarget(ev.target)) return
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
      ev.preventDefault()
      undo()
      return
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) {
      ev.preventDefault()
      redo()
      return
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !isTypingTarget(ev.target)) {
      ev.preventDefault()
      deleteSelection()
    }
  }
  function isTypingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  }
  window.addEventListener('keydown', onKeydown)

  // ── 动态加载 X6 + dagre + snapline，装配画布 ──
  try {
    const [{ Graph }, dagreMod, snapMod] = await Promise.all([
      import('@antv/x6'),
      import('@dagrejs/dagre'),
      import('@antv/x6-plugin-snapline').catch(() => null), // 插件缺失不阻塞主装配
    ])
    const dagre = (dagreMod as unknown as { default: typeof import('@dagrejs/dagre') }).default ?? (dagreMod as unknown as typeof import('@dagrejs/dagre'))

    layoutFn = (m: FlowModel): Map<string, { x: number; y: number }> => {
      const g = new dagre.graphlib.Graph()
      g.setGraph({ rankdir: 'TD', nodesep: 48, ranksep: 64 })
      g.setDefaultEdgeLabel(() => ({}))
      for (const n of m.nodes.values()) g.setNode(n.id, nodeBox(n))
      for (const e of m.edges) g.setEdge(e.from, e.to)
      dagre.layout(g)
      const out = new Map<string, { x: number; y: number }>()
      for (const n of m.nodes.values()) {
        const p = (g.node(n.id) as { x: number; y: number }) ?? { x: 80, y: 80 }
        const { width: w, height: h } = nodeBox(n)
        out.set(n.id, { x: p.x - w / 2, y: p.y - h / 2 })
      }
      return out
    }

    const graph = new Graph({
      container: canvas,
      grid: { size: 10, visible: true },
      background: { color: 'transparent' },
      // DEF-2：X6 v2.18.1 的 mousewheel 配置实测不生效（probe 三通道取证）→ 改手工 ctrl+wheel 监听
      // DEF-5：内容溢出画布时可拖空白平移（mouseWheel 平移与 ctrl 缩放抢事件，不启用）
      panning: { enabled: true, eventTypes: ['leftMouseDown'] },
    })
    const SnaplineCtor = (snapMod as { Snapline?: new () => unknown } | null)?.Snapline
    if (SnaplineCtor) (graph as { use: (p: unknown) => unknown }).use(new SnaplineCtor())

    // 选中效果：boundary 工具（主色虚线包围盒）
    type ToolCell = { addTools?: (t: unknown) => void; removeTools?: () => void }
    const getCell = (id: string): ToolCell | null =>
      (graph.getCellById(id) as ToolCell | null) ?? null

    graphApi = {
      addEdge: (o) => graph.addEdge(o),
      removeCell: (id) => graph.removeCell(id),
      removeAll: () => void graph.removeCells(graph.getCells()),
      upsertNode: (o) => void graph.addNode(o),
      setEdgeLabels: (index, labels) => {
        const cell = graph.getCellById(`edge-${index}`) as { setLabels?: (l: unknown[]) => void } | null
        cell?.setLabels?.(labels)
      },
      selectVisual: (id) => {
        getCell(visualSelId ?? '')?.removeTools?.()
        if (id) getCell(id)?.addTools?.({
          name: 'boundary',
          args: { padding: 5 },
          attrs: { stroke: 'var(--el-color-primary,#409eff)', strokeWidth: 1.5, strokeDasharray: '5 3', fill: 'none' },
        })
      },
      on: (ev, h) =>
        graph.on(ev, (arg: { node?: { id: string }; edge?: { id: string }; cell?: { id: string } }) => h(arg)),
      zoomTo: (f) => graph.zoomTo(f),
      zoomToFit: (o) => graph.zoomToFit(o as never),
      getZoom: () => (graph.zoom() as number) ?? 1,
      centerContent: () => graph.centerContent(),
      dispose: () => graph.dispose(),
    }

    // DEF-2 修复：ctrl/cmd + 滚轮缩放（X6 mousewheel 配置不生效，手工挂非 passive 监听）
    const onCanvasWheel = (ev: WheelEvent): void => {
      if (!ev.ctrlKey && !ev.metaKey) return
      ev.preventDefault()
      zoomBy(ev.deltaY < 0 ? 1.1 : 0.9)
    }
    canvas.addEventListener('wheel', onCanvasWheel, { passive: false })

    // 初始渲染：位置缓存（%% meta: _layout）优先，无 pos 节点落 dagre 自动布局
    hydrateLayout()
    const initial = layoutFn(model)
    for (const n of model.nodes.values()) {
      const p = positions.get(n.id) ?? initial.get(n.id) ?? { x: 80, y: 80 }
      positions.set(n.id, p)
      graph.addNode({ id: n.id, shape: nodeX6Shape(n.shape), x: p.x, y: p.y, ...nodeBox(n), attrs: nodeAttrs(n) })
    }
    model.edges.forEach((e, i) => {
      graph.addEdge({
        id: `edge-${i}`,
        shape: 'edge',
        source: e.from,
        target: e.to,
        attrs: { line: { stroke: '#94a3b8', strokeWidth: 1.5 } },
        labels: e.label ? [{ attrs: { label: { text: e.label } } }] : [],
      })
    })
    graph.on('node:moved', ({ node }) => {
      const id = node.id as string
      if (readonly) return
      const cell = graph.getCellById(id) as { getPosition?: () => { x: number; y: number } } | null
      const p = cell?.getPosition?.()
      if (!p) return
      const prev = positions.get(id)
      if (prev && prev.x === p.x && prev.y === p.y) return
      // 位置持久化：拖动 = 编辑（旧状态快照入撤销栈 → 新位置写 meta 通道 → 标脏）
      snapshot()
      positions.set(id, p)
      syncLayout()
      markDirty()
    })
    graph.on('node:click', ({ node }) => {
      const id = node.id as string
      if (connectMode) {
        if (connectFrom === null) {
          connectFrom = id
          connectBtn.classList.add('is-active')
        } else if (connectFrom !== id) {
          snapshot()
          connect(model, connectFrom, id)
          const i = model.edges.length - 1
          const e = model.edges[i]
          if (!e) return
          graph.addEdge({
            id: `edge-${i}`,
            shape: 'edge',
            source: e.from,
            target: e.to,
            attrs: { line: { stroke: '#94a3b8', strokeWidth: 1.5 } },
            labels: [],
          })
          connectFrom = null
          connectBtn.classList.remove('is-active')
          markDirty()
        }
        return
      }
      selectedNode = id
      selectedEdge = -1
      selectVisual(id)
      openPanel('node')
    })
    graph.on('edge:click', ({ edge }) => {
      if (connectMode) return
      const idx = Number(String(edge.id).replace('edge-', ''))
      if (Number.isNaN(idx) || !model.edges[idx]) return
      selectedEdge = idx
      selectedNode = null
      selectVisual(edge.id as string)
      openPanel('edge')
    })
    graph.on('blank:click', () => {
      if (connectMode) {
        connectFrom = null
        connectBtn.classList.remove('is-active')
      }
      closePanel()
      closeShapeMenu()
    })

    graph.centerContent()
    // DEF-5 修复：打开即最佳适配（小图放大到 ≤100%、大图缩小），内容充满可用空间不截断；
    // 且跟随画布尺寸变化自动重适配（宿主面板收起/窗口缩放），用户手动调过视图后则不再打扰
    fitToView()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (!userAdjustedView) fitToView()
      })
      ro.observe(canvas)
      resizeObserver = ro
    }
    applyEdits()
    renderBadge()
    refreshZoom()
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        window.removeEventListener('keydown', onKeydown)
        document.removeEventListener('pointerdown', onDocPointerDown, true)
        canvas.removeEventListener('wheel', onCanvasWheel)
        resizeObserver?.disconnect()
        resizeObserver = null
        graphApi?.dispose()
        style.remove()
        root.remove()
        el.style.position = prevElPos
      },
      // beforeDispose 契约（code.ts 同口径）：非 dirty 放行；dirty confirm + 3s 超时竞速；
      // expired/destroy=通知式跳过询问（v1.1 reason 显式化，同 code.ts）
      beforeDispose: (reason?: DisposeReason) => {
        if ((reason && reason !== 'close') || !dirty || readonly) return true
        return confirmWithTimeout(ctx.t(UNSAVED_KEY))
      },
    }
  } catch {
    // X6/dagre 加载失败（弱网/环境）：降级错误提示——只读查看走 mermaid-viewer
    style.remove()
    root.remove()
    el.style.position = prevElPos
    return buildFailTip(el, ctx)
  }

  // ── 局部工具（依赖闭包状态，放函数体内保持私有） ──
  function applyNodeCell(id: string): void {
    const n = model.nodes.get(id)
    if (!n || !graphApi) return
    // DEF-6：X6 v2 removeCell 会级联移除相邻边视图，重建节点后必须按模型补回，
    // 否则「应用属性」一次就丢一遍连线（用户实测截图佐证）
    const incident: Array<{ i: number; e: { from: string; to: string; label: string } }> = []
    model.edges.forEach((e, i) => {
      if (e.from === id || e.to === id) incident.push({ i, e })
    })
    graphApi.removeCell(id)
    selectVisual(null)
    graphApi.upsertNode({ id: n.id, shape: nodeX6Shape(n.shape), ...(positions.get(id) ?? { x: 60, y: 60 }), ...nodeBox(n), attrs: nodeAttrs(n) })
    for (const { i, e } of incident) {
      graphApi.addEdge({
        id: `edge-${i}`,
        shape: 'edge',
        source: e.from,
        target: e.to,
        attrs: { line: { stroke: '#94a3b8', strokeWidth: 1.5 } },
        labels: e.label ? [{ attrs: { label: { text: e.label } } }] : [],
      })
    }
    // 重建后重挂选中效果与面板值（自适应尺寸随 label 伸缩）
    selectVisual(id)
    lblInput.value = n.label
    fillInput.value = (n.meta?.style as { fill?: string } | undefined)?.fill ?? fillInput.value
    kindSel.value = (typeof n.meta?.kind === 'string' ? n.meta.kind : kindSel.value)
  }
  function refreshEdgeCell(index: number): void {
    const e = model.edges[index]
    if (!e || !graphApi) return
    graphApi.setEdgeLabels(index, e.label ? [{ attrs: { label: { text: e.label } } }] : [])
  }
}

// ───────────────────────── 模块级工具 ─────────────────────────

/** 布局器（装配期注入；rebuild/新增节点兜底位使用） */
let layoutFn: ((m: FlowModel) => Map<string, { x: number; y: number }>) | null = null

/** label 估宽：CJK/全宽字符按字号计，其余按 0.62 倍（确定性估宽，jsdom 同口径可测） */
function textWidth(s: string, fontSize: number): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? fontSize : fontSize * 0.62
  return w
}

/** 元素自适应尺寸：按 label 逐行估宽 + 行数计高，形状保底盒（diamond/circle 放大留白） */
export function measureBox(label: string, shape: FlowShape): { width: number; height: number } {
  const FONT = 13
  const LINE_H = 19
  const lines = (label === '' ? ' ' : label).split('\n')
  const tw = Math.max(...lines.map((l) => textWidth(l, FONT)))
  const n = lines.length
  if (shape === 'diamond') {
    // 菱形文本占中带：外接盒放大 1.5 留白
    return { width: Math.max(112, Math.round((tw + 36) * 1.5)), height: Math.max(60, Math.round((n * LINE_H + 28) * 1.45)) }
  }
  if (shape === 'circle') {
    const side = Math.ceil(Math.max(64, tw + 44, n * LINE_H + 30))
    return { width: side, height: side }
  }
  return { width: Math.max(76, Math.ceil(tw + 30)), height: Math.max(38, n * LINE_H + 18) }
}

/** 节点盒 = measureBox(label, shape)（自适应尺寸统一入口） */
function nodeBox(n: { shape: FlowShape; label: string }): { width: number; height: number } {
  return measureBox(n.label, n.shape)
}

/** mermaid 形状 → X6 内置 shape 名 */
function nodeX6Shape(shape: FlowShape): string {
  switch (shape) {
    case 'circle':
      return 'ellipse'
    case 'diamond':
      return 'polygon'
    default:
      return 'rect'
  }
}

/** 节点 attrs：meta.style 优先，缺省按形状默认配色；label textWrap 支持多行 */
function nodeAttrs(n: { shape: FlowShape; label: string; meta?: Record<string, unknown> }): Record<string, Record<string, string | number | boolean>> {
  const st = (n.meta?.style ?? {}) as { fill?: string; stroke?: string }
  const fallback = KIND_PRESETS.find((k) => k.shape === n.shape)
  const body = {
    fill: st.fill ?? fallback?.fill ?? '#eff6ff',
    stroke: st.stroke ?? fallback?.stroke ?? '#94a3b8',
    strokeWidth: 1.5,
  }
  const shapeBody =
    n.shape === 'diamond'
      ? { ...body, refPoints: '0.5,0 1,0.5 0.5,1 0,0.5' }
      : n.shape === 'circle'
        ? { ...body, rx: 'calc(w/2)', ry: 'calc(h/2)' }
        : n.shape === 'round'
          ? { ...body, rx: 12, ry: 12 }
          : body
  return { body: shapeBody, label: { text: n.label, fontSize: 13, fill: '#1f2937', textWrap: true } }
}
