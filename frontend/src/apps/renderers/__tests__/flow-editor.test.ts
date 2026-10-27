/**
 * 流程图编辑渲染器单测（flow-editor，MVP-③④ + 图标工具栏/形状下拉/选中效果/多行文本/自适应尺寸）
 * 契约正本：renderers/flow-editor.ts 头注释 + 《流程图应用设计（Mermaid+X6）》§四
 * 环境：@antv/x6 与 @dagrejs/dagre 整体 mock（holder 蹦床）；
 * 覆盖点：
 *  1. 装配：parse→dagre 布局→addNode/addEdge 数量与形状映射；自适应尺寸（diamond 高度>60）；dispose 清理
 *  2. 编辑链：形状下拉→添加节点+连线 → Ctrl+S → putObject（序列化回写）
 *  3. 选中效果：node:click → boundary 工具挂载（toolLog '+A'）；blank:click → 清除（'-A'）
 *  4. 多行文本：textarea label → 节点盒增高 + 序列化 `\n` 转义单行
 *  5. 4305 只读闩锁：putObject 拒 4305 → root.is-readonly + 编辑钮/下拉项禁用
 *  6. 非 graph TD 语法（mindmap 等）→ 内部降级只读 mermaid 渲染
 *  7. dispose 清理：keydown 监听移除、容器移除
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flowEditorRenderer } from '../flow-editor'
import type { AppCtx, AppInstance } from '../../../sdk/types'
import type { Mock } from 'vitest'

// ───────────────────────── X6 mock（记录式桩） ─────────────────────────
const x6Holder = vi.hoisted(() => {
  const state = {
    impl: undefined as
      | { Graph: new (o: unknown) => Record<string, unknown> }
      | undefined,
  }
  const created: Array<Record<string, unknown>> = []
  class FakeGraph {
    handlers = new Map<string, Array<(a: unknown) => void>>()
    cells = new Map<string, unknown>()
    /** 选中效果（boundary 工具）挂载/卸载流水：'+A' / '-A' */
    toolLog: string[] = []
    options: unknown
    constructor(o: unknown) {
      this.options = o
      created.push(this as unknown as Record<string, unknown>)
    }
    zoomLevels = [1]
    /** 拖拽位置桩（node:moved 时 getPosition 读取） */
    posOf: Record<string, { x: number; y: number }> = {}
    addNode(o: { id: string }) {
      const cell = {
        ...o,
        addTools: () => this.toolLog.push(`+${o.id}`),
        removeTools: () => this.toolLog.push(`-${o.id}`),
        getPosition: () => this.posOf[o.id] ?? { x: 0, y: 0 },
      }
      this.cells.set(o.id, cell)
      return cell
    }
    addEdge(o: { id: string }) {
      const cell = {
        ...o,
        addTools: () => this.toolLog.push(`+${o.id}`),
        removeTools: () => this.toolLog.push(`-${o.id}`),
      }
      this.cells.set(o.id, cell)
      return cell
    }
    removeCell(id: string) {
      this.cells.delete(id)
    }
    removeCells(ids: string[]) {
      for (const id of ids) this.cells.delete(id as string)
    }
    getCellById(id: string) {
      return this.cells.get(id) ?? null
    }
    on(ev: string, h: (a: unknown) => void) {
      const arr = this.handlers.get(ev) ?? []
      arr.push(h)
      this.handlers.set(ev, arr)
    }
    removeAll() {
      this.cells.clear()
    }
    getCells() {
      return [...this.cells.keys()]
    }
    zoom(f?: number) {
      if (f === undefined) return this.zoomLevels.at(-1)
      this.zoomLevels.push(this.zoomLevels.at(-1)! * f)
      return this.zoomLevels.at(-1)
    }
    zoomTo(f: number) {
      this.zoomLevels.push(f)
      return f
    }
    zoomToFit() {
      this.zoomLevels.push(1)
      return 1
    }
    getZoom() {
      return this.zoomLevels.at(-1)!
    }
    use() {
      return this
    }
    centerContent() {}
    dispose() {
      this.cells.clear()
    }
    emit(ev: string, a: unknown) {
      for (const h of this.handlers.get(ev) ?? []) h(a)
    }
  }
  return { state, created, FakeGraph }
})
vi.mock('@antv/x6', () => ({
  // 构造期委托：vi.mock 工厂只求值一次，直接返回 impl 会让后续「加载失败」用例失效
  Graph: class {
    constructor(o: unknown) {
      if (!x6Holder.state.impl) throw new Error('x6 unavailable (simulated)')
      return new x6Holder.state.impl.Graph(o)
    }
  },
}))

// ───────────────────────── mermaid mock（非 graph TD 降级渲染用） ─────────────────────────
const mermaidHolder = vi.hoisted(() => ({
  state: {
    // rest-any 可调用形状（裸 ReturnType<typeof vi.fn> 在 vitest 4 推导出 Procedure|Constructable 联合，不可调用 TS2348；mermaid.test.ts 同款）
    impl: undefined as
      | { initialize: Mock<(...args: any[]) => any>; render: Mock<(...args: any[]) => any> }
      | undefined,
  },
}))
vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => {
      if (!mermaidHolder.state.impl) throw new Error('mermaid unavailable (simulated)')
      return mermaidHolder.state.impl.initialize(...args)
    },
    render: (...args: unknown[]) => {
      if (!mermaidHolder.state.impl) throw new Error('mermaid unavailable (simulated)')
      return mermaidHolder.state.impl.render(...args)
    },
  },
}))

// ───────────────────────── dagre mock（记录式桩） ─────────────────────────
const dagreHolder = vi.hoisted(() => ({ state: { impl: undefined as unknown } }))
vi.mock('@dagrejs/dagre', () => {
  if (!dagreHolder.state.impl) throw new Error('dagre unavailable (simulated)')
  return dagreHolder.state.impl
})

function makeDagreImpl() {
  const positions: Record<string, { x: number; y: number }> = {}
  return {
    default: {
      graphlib: {
        Graph: class {
          nodes: Array<{ id: string; size: unknown }> = []
          edges: Array<{ v: string; w: string }> = []
          setGraph() {
            return this
          }
          setDefaultEdgeLabel() {
            return this
          }
          setNode(id: string, size: unknown) {
            this.nodes.push({ id, size })
          }
          setEdge(v: string, w: string) {
            this.edges.push({ v, w })
          }
          node(id: string) {
            positions[id] ??= { x: 100 + this.nodes.findIndex((n) => n.id === id) * 10, y: 80 }
            return positions[id]
          }
          layout() {
            for (const n of this.nodes) positions[n.id] ??= { x: 100, y: 80 }
          }
        },
      },
      layout() {},
    },
  }
}

const FILE = { key: 'diagrams/approval.mmd', name: 'approval.mmd', size: 128 }
const SRC = 'graph TD\n  A[提交申请] --> B{审批}\n  B -->|通过| C[归档]\n'

function makeCtx(putObjectImpl?: () => Promise<void>): AppCtx & { putObject: ReturnType<typeof vi.fn> } {
  return {
    getObject: vi.fn(async () => new Blob([SRC])),
    putObject: vi.fn(putObjectImpl ?? (async () => undefined)),
    t: (key: string) => `T:${key}`,
    notify: vi.fn(),
  } as unknown as AppCtx & { putObject: ReturnType<typeof vi.fn> }
}

/** 形状下拉：开菜单再点模板项（工具栏收敛为单钮下拉后的固定操作序） */
function addShape(el: HTMLElement, kind = 'process'): void {
  el.querySelector<HTMLButtonElement>('[data-testid="flow-shape-btn"]')!.click()
  el.querySelector<HTMLButtonElement>(`[data-testid="flow-kind-${kind}"]`)!.click()
}

beforeEach(() => {
  x6Holder.state.impl = { Graph: x6Holder.FakeGraph as unknown as new (o: unknown) => Record<string, unknown> }
  dagreHolder.state.impl = makeDagreImpl()
  mermaidHolder.state.impl = {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-ro="1"></svg>' })),
  }
  vi.spyOn(window, 'confirm').mockImplementation(() => true)
})
afterEach(() => {
  x6Holder.state.impl = undefined
  dagreHolder.state.impl = undefined
  mermaidHolder.state.impl = undefined
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('flow-editor 渲染器', () => {
  it('装配：dagre 布局后 addNode=3 / addEdge=2（形状映射 rect/ellipse/polygon + 自适应尺寸）；图标钮带 hint；dispose 清理', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance

    const graph = x6Holder.created.at(-1)! as unknown as { cells: Map<string, unknown> }
    expect(graph.cells.get('A')).toMatchObject({ shape: 'rect' })
    expect(graph.cells.get('B')).toMatchObject({ shape: 'polygon' })
    // 自适应尺寸：菱形「审批」外接盒放大留白（高度 > 60）
    expect((graph.cells.get('B') as { height: number }).height).toBeGreaterThan(60)
    expect(graph.cells.has('edge-0')).toBe(true)
    expect(graph.cells.has('edge-1')).toBe(true)
    expect(el.querySelector('.mmagic-flow__canvas')).not.toBeNull()

    // 统一编辑钮簇：保存/撤销/重做/重置 四钮就位（testid 透传保留 flow-* 口径），保存钮内嵌 svg
    const cluster = el.querySelector('.mmx-edt')!
    expect(cluster.querySelectorAll('[data-act]').length).toBe(4)
    for (const act of ['save', 'undo', 'redo', 'reset'] as const) {
      const b = el.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!
      expect(b.dataset.testid).toBe(`flow-${act}`)
      expect(b.title).toBe(`T:app.edt-${act}`)
    }
    const saveBtn = el.querySelector<HTMLButtonElement>('[data-testid="flow-save"]')!
    expect(saveBtn.querySelector('svg')).not.toBeNull()
    expect(saveBtn.title).toBe('T:app.edt-save')
    // 形状下拉钮存在（5 色点模板收敛为单钮）
    expect(el.querySelector('[data-testid="flow-shape-btn"]')).not.toBeNull()

    inst.dispose()
    expect(el.querySelector('.mmagic-flow')).toBeNull()
  })

  it('编辑链：形状下拉添加节点+连线 → Ctrl+S → putObject 内容含新增语句', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance

    addShape(el, 'process')
    el.querySelector<HTMLButtonElement>('[data-testid="flow-connect"]')!.click()
    const graph = x6Holder.created.at(-1)! as unknown as {
      cells: Map<string, unknown>
      emit: (ev: string, a: unknown) => void
    }
    graph.emit('node:click', { node: { id: 'A' } })
    graph.emit('node:click', { node: { id: 'n1' } })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 0))

    expect(ctx.putObject).toHaveBeenCalledTimes(1)
    const blob = ctx.putObject.mock.calls[0]![1] as Blob
    const text = await blob.text()
    expect(text).toContain('n1[')
    expect(text).toContain('A --> n1')

    inst.dispose()
  })

  it('选中效果：node:click 挂 boundary 工具（+A），blank:click 清除（-A）', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance

    const graph = x6Holder.created.at(-1)! as unknown as {
      toolLog: string[]
      emit: (ev: string, a: unknown) => void
    }
    graph.emit('node:click', { node: { id: 'A' } })
    expect(graph.toolLog).toContain('+A')
    // 属性面板同步打开
    expect(el.querySelector('.mmagic-flow__panel')!.classList.contains('is-open')).toBe(true)

    graph.emit('blank:click', {})
    expect(graph.toolLog).toContain('-A')
    expect(el.querySelector('.mmagic-flow__panel')!.classList.contains('is-open')).toBe(false)

    inst.dispose()
  })

  it('多行文本：textarea label → 节点盒增高 + 序列化 \\n 转义保持源单行', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance

    const graph = x6Holder.created.at(-1)! as unknown as {
      cells: Map<string, unknown>
      emit: (ev: string, a: unknown) => void
    }
    graph.emit('node:click', { node: { id: 'A' } })
    const ta = el.querySelector<HTMLTextAreaElement>('.mmagic-flow__panel textarea.is-label')!
    ta.value = '第一行\n第二行'
    el.querySelector<HTMLButtonElement>('[data-testid="flow-apply"]')!.click()

    // 自适应：两行文本 → 高度 = 2*19+18 = 56（>38 单行保底）
    expect((graph.cells.get('A') as { height: number }).height).toBeGreaterThan(50)
    // label attrs 携带真换行 + textWrap
    const attrs = (graph.cells.get('A') as { attrs: { label: { text: string; textWrap: boolean } } }).attrs
    expect(attrs.label.text).toBe('第一行\n第二行')
    expect(attrs.label.textWrap).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 0))
    const text = await (ctx.putObject.mock.calls.at(-1)![1] as Blob).text()
    // 源单行：换行落为 \n 两字转义序列（引号包裹）
    expect(text).toContain('A["第一行\\n第二行"]')
    expect(text).not.toMatch(/A\["第一行\n第二行"\]/)

    inst.dispose()
  })

  it('4305 只读闩锁：putObject 拒 4305 → is-readonly + 下拉钮/下拉项禁用', async () => {
    const ctx = makeCtx(async () => {
      throw Object.assign(new Error('unsupported'), { code: 4305 })
    })
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance

    addShape(el, 'process') // 触发 dirty
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 0))

    expect(el.querySelector('.mmagic-flow')!.classList.contains('is-readonly')).toBe(true)
    // 再次打开下拉：菜单项全部禁用
    el.querySelector<HTMLButtonElement>('[data-testid="flow-shape-btn"]')!.click()
    const kbtn = el.querySelector<HTMLButtonElement>('[data-testid="flow-kind-process"]')!
    expect(kbtn.disabled).toBe(true)
    expect(el.querySelector<HTMLButtonElement>('[data-testid="flow-shape-btn"]')!.disabled).toBe(true)
    inst.dispose()
  })

  it('非本方言语法（sequenceDiagram）→ 内部降级只读 mermaid 渲染（.mmagic-mermaid 容器）；mindmap 已升格可编辑不再降级', async () => {
    const mindSrc = 'sequenceDiagram\n  U->>F: hi\n'
    const ctx = {
      getObject: vi.fn(async () => new Blob([mindSrc])),
      putObject: vi.fn(async () => undefined),
      t: (key: string) => `T:${key}`,
    } as unknown as AppCtx

    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    expect(el.querySelector('.mmagic-mermaid svg[data-ro]')).not.toBeNull()
    expect(el.querySelector('.mmagic-flow')).toBeNull()
    inst.dispose()
  })

  it('撤销栈：两次添加 → undo 内容回退一次 → redo 恢复', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    addShape(el, 'process')
    addShape(el, 'process')

    el.querySelector<HTMLButtonElement>('[data-testid="flow-undo"]')!.click()
    await new Promise((r) => setTimeout(r, 0))
    el.querySelector<HTMLButtonElement>('[data-testid="flow-save"]')!.click()
    await new Promise((r) => setTimeout(r, 0))
    let text = await (ctx.putObject.mock.calls.at(-1)![1] as Blob).text()
    expect(text.match(/n\d\[/g)?.length).toBe(1)

    el.querySelector<HTMLButtonElement>('[data-testid="flow-redo"]')!.click()
    el.querySelector<HTMLButtonElement>('[data-testid="flow-save"]')!.click()
    await new Promise((r) => setTimeout(r, 0))
    text = await (ctx.putObject.mock.calls.at(-1)![1] as Blob).text()
    expect(text.match(/n\d\[/g)?.length).toBe(2)
    inst.dispose()
  })

  it('重置：dirty 下点击恢复打开时内容（快照入撤销栈可反悔）+ 红点清零；干净态禁用', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    const resetBtn = el.querySelector<HTMLButtonElement>('[data-act="reset"]')!
    expect(resetBtn.disabled).toBe(true) // 初始干净态无可重置

    addShape(el, 'process') // 弄脏（新增节点 n0）
    expect(resetBtn.disabled).toBe(false)
    expect(el.querySelector('[data-act="save"]')?.classList.contains('is-dirty')).toBe(true)
    resetBtn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(el.querySelector('[data-act="save"]')?.classList.contains('is-dirty')).toBe(false)
    expect(resetBtn.disabled).toBe(true)
    // 内容回原文（不再含新增节点）；beforeDispose 干净放行
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.putObject).not.toHaveBeenCalled() // 干净态 Ctrl+S 不写链
    expect(inst.beforeDispose?.()).toBe(true)
    inst.dispose()
  })

  it('保存钮：点击 → putObject；导出 SVG：toSVG 产物触发下载', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    addShape(el, 'process') // 触发 dirty

    el.querySelector<HTMLButtonElement>('[data-testid="flow-save"]')!.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.putObject).toHaveBeenCalledTimes(1)
    const text = await (ctx.putObject.mock.calls[0]![1] as Blob).text()
    expect(text).toContain('graph TD')

    // 显式 Blob 形参：真实调用点 createObjectURL(new Blob(...))，且使 mock.calls 元组可索引（消除 TS2493）
    const urlSpy = vi.fn((_blob: Blob) => 'blob:mock-export')
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = urlSpy
    const revokeSpy = vi.fn()
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeSpy
    let clicked = false
    const anchorProto = HTMLAnchorElement.prototype as unknown as { click: () => void }
    const origClick = anchorProto.click
    anchorProto.click = function () {
      clicked = true
    }
    // 真实实现直接序列化画布 SVG（X6 v2 无 toSVG）→ jsdom 注入画布 svg 后导出
    el.querySelector<HTMLElement>('.mmagic-flow__canvas')!.innerHTML =
      '<svg class="x6-graph-svg" width="800" height="400"><g><text>审批</text></g></svg>'
    el.querySelector<HTMLButtonElement>('[data-testid="flow-export-svg"]')!.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(urlSpy).toHaveBeenCalled()
    const blobArg = urlSpy.mock.calls[0]![0]
    const svgText = await blobArg.text()
    expect(svgText).toContain('<svg')
    expect(svgText).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svgText).toContain('fill="#ffffff"')
    expect(clicked).toBe(true)
    anchorProto.click = origClick
    inst.dispose()
  })

  it('缩放钮：乘法语义（放大 125%、缩小回 100%）；fit/1:1 绝对语义', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    el.querySelector<HTMLButtonElement>('[data-testid="flow-zoom-in"]')!.click()
    expect(el.querySelector('.mmagic-flow__zoom')!.textContent).toBe('125%')
    el.querySelector<HTMLButtonElement>('[data-testid="flow-zoom-out"]')!.click()
    expect(el.querySelector('.mmagic-flow__zoom')!.textContent).toBe('100%')
    el.querySelector<HTMLButtonElement>('[data-testid="flow-fit"]')!.click()
    el.querySelector<HTMLButtonElement>('[data-testid="flow-zoom-reset"]')!.click()
    expect(el.querySelector('.mmagic-flow__zoom')!.textContent).toBe('100%')
    inst.dispose()
  })

  it('Ctrl+滚轮缩放：canvas wheel 监听（ctrlKey 命中 zoomTo，非 passive）', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    const cvs = el.querySelector<HTMLElement>('.mmagic-flow__canvas')!
    cvs.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true }))
    expect(el.querySelector('.mmagic-flow__zoom')!.textContent).toBe('110%')
    // 无修饰键滚轮不缩放
    cvs.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
    expect(el.querySelector('.mmagic-flow__zoom')!.textContent).toBe('110%')
    inst.dispose()
  })

  it('应用属性后相邻边不丢（X6 v2 removeCell 级联 → 按模型补回）', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    const graph = x6Holder.created.at(-1)! as unknown as { cells: Map<string, unknown>; emit: (ev: string, a: unknown) => void }
    expect(graph.cells.has('edge-0')).toBe(true)
    expect(graph.cells.has('edge-1')).toBe(true)
    // 选中 B（审批，恰为两条边端点）改 label 并应用
    graph.emit('node:click', { node: { id: 'B' } })
    const ta = el.querySelector<HTMLTextAreaElement>('.mmagic-flow__panel textarea.is-label')!
    ta.value = '审批（改）'
    el.querySelector<HTMLButtonElement>('[data-testid="flow-apply"]')!.click()
    // 节点重建 + 两条相邻边必须原位补回
    expect(graph.cells.has('B')).toBe(true)
    expect(graph.cells.has('edge-0')).toBe(true)
    expect(graph.cells.has('edge-1')).toBe(true)
    inst.dispose()
  })

  it('输入框聚焦时 Ctrl+Z 只走原生文本撤销，不触发画布 undo（双触发守卫）', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    addShape(el, 'process')
    const nc = () => x6Holder.created.at(-1)!['cells' as never] as unknown as Map<string, unknown>
    const count = () => [...(nc() as Map<string, unknown>).keys()].filter((k) => String(k).startsWith('n')).length
    expect(count()).toBe(1)
    // 面板 textarea 聚焦（用户刚点过节点在改文本）→ Ctrl+Z 必须不触发画布撤销
    const ta = el.querySelector<HTMLTextAreaElement>('.mmagic-flow__panel textarea.is-label')!
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    expect(count()).toBe(1)
    // 焦点在画布（target 非输入框）→ 正常画布撤销
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(count()).toBe(0)
    inst.dispose()
  })

  it('X6 加载失败 → 降级错误提示节点不抛出', async () => {
    x6Holder.state.impl = undefined
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    expect(el.textContent).toContain('T:app.mermaid-load-fail')
    inst.dispose()
  })

  it('位置持久化：%% meta: _layout 坐标在重开时还原（优先于 dagre 兜底）', async () => {
    const ctx = makeCtx()
    ;(ctx.getObject as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      new Blob(['graph TD\n  %% meta: _layout {"positions":{"A":{"x":200,"y":150}}}\n  A[提交申请] --> B\n']),
    )
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    const graph = x6Holder.created.at(-1)! as unknown as { cells: Map<string, { x?: number; y?: number }> }
    expect(graph.cells.get('A')).toMatchObject({ x: 200, y: 150 })
    // 无 pos 的 B 落 dagre 兜底（mock 布局：中心 110,80 − 半宽半高 = 左上 72,61）
    expect(graph.cells.get('B')).toMatchObject({ x: 72, y: 61 })
    inst.dispose()
  })

  it('位置持久化：拖拽 → 标脏 + 保存含 _layout；撤销回退到旧位', async () => {
    const ctx = makeCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    const graph = x6Holder.created.at(-1)! as unknown as {
      cells: Map<string, { x?: number; y?: number }>
      posOf: Record<string, { x: number; y: number }>
      emit: (ev: string, a: unknown) => void
    }
    graph.posOf['A'] = { x: 300, y: 210 }
    graph.emit('node:moved', { node: { id: 'A' } })
    // dirty 只走保存钮红点（「未保存」文字徽标废弃）；重置钮解锁
    expect(el.querySelector('[data-act="save"]')?.classList.contains('is-dirty')).toBe(true)
    expect(el.querySelector<HTMLButtonElement>('[data-act="reset"]')!.disabled).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 0))
    const text = await (ctx.putObject.mock.calls.at(-1)![1] as Blob).text()
    expect(text).toContain('%% meta: _layout')
    expect(text).toContain('"x":300,"y":210')
    // 撤销 → A 回 dagre 初始位（mock：中心 100,80 − 半宽 41/半高 19 = 59,61），_layout 行随之消失
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(graph.cells.get('A')).toMatchObject({ x: 59, y: 61 })
    inst.dispose()
  })
})

// ───────────────────────── mindmap 方言（一百四十七番：脑图可编辑，与 flow-editor 同链） ─────────────────────────

describe('mindmap 方言：解析/编辑/保存（与 flow-editor 同链）', () => {
  const MM_SRC = 'mindmap\n  root((MMagic-Files))\n    预览\n      图片\n    编辑\n      代码'
  function makeMindCtx() {
    return {
      getObject: vi.fn(async () => new Blob([MM_SRC])),
      putObject: vi.fn(async () => undefined),
      t: (key: string) => `T:${key}`,
      notify: vi.fn(),
    } as unknown as AppCtx & { putObject: ReturnType<typeof vi.fn> }
  }

  it('打开 mindmap：走 X6 编辑器（树渲染），不降级 mermaid 只读；保存=缩进树原样往返', async () => {
    const ctx = makeMindCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    const graph = x6Holder.created.at(-1)! as unknown as {
      cells: Map<string, unknown>
      emit: (ev: string, a: unknown) => void
    }
    expect(graph.cells.has('m1')).toBe(true) // 根
    expect(graph.cells.has('m2')).toBe(true) // 预览
    expect(graph.cells.has('edge-0')).toBe(true) // 隐式父子边
    expect(mermaidHolder.state.impl?.render).not.toHaveBeenCalled() // 不降级只读

    // 弄脏（拖动=编辑，与 flowchart 同口径）→ 保存链才会写
    graph.emit('node:moved', { node: { id: 'm2' } })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.putObject).toHaveBeenCalledTimes(1)
    const text = await (ctx.putObject.mock.calls[0]![1] as Blob).text()
    // 缩进树序列化：结构保持（根/分支/叶）+ 位置 meta 通道（拖拽持久化对脑图同样生效）
    expect(text.startsWith('mindmap\n  %% meta:')).toBe(true)
    expect(text).toContain('root((MMagic-Files))')
    expect(text).toContain('预览')
    expect(text).toContain('代码')
    expect(text).toContain('%% meta: _layout')
    inst.dispose()
  })

  it('脑图添加形状：自动挂为选中节点子节点（树语义）+ 保存含新增分支', async () => {
    const ctx = makeMindCtx()
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    // 选中根（点击画布节点）→ 形状下拉添加 → 自动连线
    const graph = x6Holder.created.at(-1)! as unknown as {
      cells: Map<string, unknown>
      emit: (ev: string, a: unknown) => void
    }
    ;(graph.emit)('node:click', { node: { id: 'm1' } })
    addShape(el, 'process')
    await new Promise((r) => setTimeout(r, 0))
    // 新节点经 mindmap 单根收拢/显式连边入树
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.putObject).toHaveBeenCalledTimes(1)
    const text = await (ctx.putObject.mock.calls[0]![1] as Blob).text()
    expect(text).toContain('T:app.flow-kind-process') // 模板 label（t mock 口径）
    expect(text).toContain('%% meta: _layout') // meta 通道（位置持久化）存在
    expect(text).toContain('[T:app.flow-kind-process]') // 新分支入树（选中节点子节点）
    inst.dispose()
  })

  it('sequenceDiagram 仍降级只读 mermaid（方言边界不回归）', async () => {
    const ctx = {
      getObject: vi.fn(async () => new Blob(['sequenceDiagram\n  U->>F: hi'])),
      putObject: vi.fn(async () => undefined),
      t: (key: string) => `T:${key}`,
      notify: vi.fn(),
    } as unknown as AppCtx & { putObject: ReturnType<typeof vi.fn> }
    const el = document.createElement('div')
    const inst = (await flowEditorRenderer(el, FILE, ctx)) as AppInstance
    expect(el.querySelector('.mmagic-mermaid')).not.toBeNull()
    const renderMock = mermaidHolder.state.impl?.render as ReturnType<typeof vi.fn> | undefined
    expect(renderMock).toHaveBeenCalled()
    inst.dispose()
  })
})
