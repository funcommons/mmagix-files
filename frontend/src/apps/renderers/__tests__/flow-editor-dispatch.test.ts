/**
 * flow-editor mindmap 方言分派接线单测（MC1-T 测试先行——分派未接线，红=预期）
 * 契约正本：.claude/mind-loop-state.md「MC1 契约（分派接线，锁定）」节
 *
 * 锁定面：flow-editor 渲染入口（renderers/flow-editor.ts 导出的 flowEditorRenderer(el, file, ctx)）
 * 在任何 DOM 构建之前嗅探 detectDialect(text)==='mindmap' 且 parse 后 nodes>0 → 动态
 * import('./mindEditor') 委派 createMindEditorSurface({ el, text, ctx, file, t, onDirty, onReadonly })，
 * 返回其 AppInstance（dispose 透传）；flowchart/sequence/architecture 三方言 X6 面原样；
 * 空 mindmap（parse 后 nodes=0）不分派，仍走既有 mermaid 只读降级。
 *
 * 测试手法：
 *  - vi.mock('../mindEditor') 工厂 spy：createMindEditorSurface 记录调用与最近 opts 到 state、
 *    记录分派时点的 el 子节点数（入口分派条款的强编码）、返回 {dispose} 并记录 dispose 流水。
 *    mindEditor.ts 未落地也须可装配（vitest 4 对不可解析路径按 fallback 键注册 mock，不阻塞装载）；
 *    红形态=MC1-C 未接线的断言失败（spy 未调/X6 canvas 在场/opts 快照缺失）。
 *  - '@antv/x6' / '@dagrejs/dagre' / 'mermaid' trampoline mock（同既有 flow-editor.test.ts 装配手法，
 *    holder 蹦床 + beforeEach 注入 impl），保证非 mindmap 方言的 X6 面与只读降级面在 jsdom 可装配。
 *
 * 预期红账（MC1-T 时点，MC1-C 未接线）：用例 1/2/7/8 红（spy 未调、canvas 在场、opts 快照缺失、
 * 分派时点无记录）；用例 3/4/5/6 为守卫例（现状已绿——非 mindmap 与空 mindmap 不分派）。
 * MC1-C 落地后须 8/8 全绿。既有 flow-editor.test.ts 未触碰（其 mindmap X6 面用例在 MC1-C
 * 落地后语义翻转，归属 MC1-C/主代理处置）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { flowEditorRenderer } from '../flow-editor'
import type { AppCtx, AppInstance } from '../../../sdk/types'

// ───────────────────────── mindEditor mock（MC1 分派委派 spy——模块未落地也注册） ─────────────────────────
const meHolder = vi.hoisted(() => {
  const state = {
    /** 每次委派时 el.childElementCount 快照（入口分派=调用的瞬间 el 必须还是空容器） */
    childCounts: [] as number[],
    /** dispose 透传流水：surface.dispose() 被调一次记一条 */
    disposeLog: [] as string[],
  }
  const createMindEditorSurface = vi.fn(async (opts: Record<string, unknown>) => {
    state.childCounts.push((opts.el as HTMLElement | undefined)?.childElementCount ?? -1)
    const inst = { dispose: () => void state.disposeLog.push('dispose') }
    return inst
  })
  return { state, createMindEditorSurface }
})
vi.mock('../mindEditor', () => ({ createMindEditorSurface: meHolder.createMindEditorSurface }))

// ───────────────────────── X6 mock（蹦床桩：非 mindmap 方言 X6 面装配用） ─────────────────────────
const x6Holder = vi.hoisted(() => {
  const state = {
    impl: undefined as { Graph: new (o: unknown) => Record<string, unknown> } | undefined,
  }
  /** 精简 FakeGraph：只覆盖装配期调用面（addNode/addEdge/on/zoom 系/use/dispose/remove*） */
  class FakeGraph {
    handlers = new Map<string, Array<(a: unknown) => void>>()
    cells = new Map<string, unknown>()
    constructor(_o: unknown) {}
    addNode(o: { id: string }) {
      const cell = { ...o }
      this.cells.set(o.id, cell)
      return cell
    }
    addEdge(o: { id: string }) {
      const cell = { ...o }
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
    getCells() {
      return [...this.cells.keys()]
    }
    on(ev: string, h: (a: unknown) => void) {
      const arr = this.handlers.get(ev) ?? []
      arr.push(h)
      this.handlers.set(ev, arr)
    }
    zoom(f?: number) {
      return f === undefined ? 1 : f
    }
    zoomTo(f: number) {
      return f
    }
    zoomToFit(_o?: unknown) {
      return 1
    }
    use() {
      return this
    }
    centerContent() {}
    dispose() {
      this.cells.clear()
    }
  }
  return { state, FakeGraph }
})
vi.mock('@antv/x6', () => ({
  // 构造期委托：vi.mock 工厂只求值一次，经 holder 蹦床转发（同既有 flow-editor.test.ts）
  Graph: class {
    constructor(o: unknown) {
      if (!x6Holder.state.impl) throw new Error('x6 unavailable (simulated)')
      return new x6Holder.state.impl.Graph(o)
    }
  },
}))

// ───────────────────────── dagre mock（蹦床桩） ─────────────────────────
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
            positions[id] ??= { x: 100, y: 80 }
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

// ───────────────────────── mermaid mock（空 mindmap 只读降级用） ─────────────────────────
const mermaidHolder = vi.hoisted(() => ({
  state: {
    // rest-any 可调用形状（裸 ReturnType<typeof vi.fn> 在 vitest 4 推导出 Procedure|Constructable 联合，不可调用 TS2348；同既有测试口径）
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

// ───────────────────────── 夹具与驱动助手 ─────────────────────────

const FILE = { key: 'diagrams/tree.mmd', name: 'tree.mmd', size: 96 }

/** 有效 mindmap（根+子节点 → parse 后 nodes=2，分派条件成立） */
const MM_SRC = ['mindmap', '  根', '    子'].join('\n')
/** 空 mindmap（仅头行，nodes=0 → 不分派，走只读降级） */
const EMPTY_MM_SRC = 'mindmap'
const FLOW_SRC = 'graph TD\n  A[提交申请] --> B{审批}\n'
const SEQ_SRC = 'sequenceDiagram\n  participant U as 用户\n  participant F as 前端\n  U->>F: 输入账密\n'
const ARCH_SRC = [
  'architecture-beta',
  '  group cloud(logos:aws-lambda)[云侧]',
  '  service fe(logos:react)[前端工作台]',
  '  service s3(logos:aws-s3)[S3 存储] in cloud',
  '  fe:R --> L:s3',
].join('\n')

/** 渲染入口驱动：flowEditorRenderer(el, file, ctx)——同既有测试的直接调用面 */
async function mount(src: string): Promise<{ el: HTMLDivElement; ctx: AppCtx; inst: AppInstance }> {
  const el = document.createElement('div')
  const ctx = {
    getObject: vi.fn(async () => new Blob([src])),
    putObject: vi.fn(async () => undefined),
    t: (key: string) => `T:${key}`,
    notify: vi.fn(),
  } as unknown as AppCtx
  const inst = await flowEditorRenderer(el, FILE, ctx)
  return { el, ctx, inst }
}

beforeEach(() => {
  x6Holder.state.impl = { Graph: x6Holder.FakeGraph as unknown as new (o: unknown) => Record<string, unknown> }
  dagreHolder.state.impl = makeDagreImpl()
  mermaidHolder.state.impl = {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-ro="1"></svg>' })),
  }
  meHolder.createMindEditorSurface.mockClear()
  meHolder.state.childCounts.length = 0
  meHolder.state.disposeLog.length = 0
})
afterEach(() => {
  x6Holder.state.impl = undefined
  dagreHolder.state.impl = undefined
  mermaidHolder.state.impl = undefined
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// ───────────────────────── 分派接线（MC1 契约面） ─────────────────────────

describe('flow-editor mindmap 方言分派接线（MC1）', () => {
  it('mindmap 有效文本 → createMindEditorSurface 恰调一次；opts.text 透传原文；返回实例 dispose 透传', async () => {
    const { inst } = await mount(MM_SRC)
    expect(meHolder.createMindEditorSurface).toHaveBeenCalledTimes(1)
    const opts = meHolder.createMindEditorSurface.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.text).toBe(MM_SRC)
    expect(meHolder.state.disposeLog).toHaveLength(0)
    inst.dispose()
    expect(meHolder.state.disposeLog).toHaveLength(1)
  })

  it('mindmap 分派后 el 无 .mmagic-flow__canvas（入口分派=零 X6 DOM 残留）', async () => {
    const { el } = await mount(MM_SRC)
    expect(meHolder.createMindEditorSurface).toHaveBeenCalledTimes(1)
    expect(el.querySelector('.mmagic-flow__canvas')).toBeNull()
  })

  it('flowchart（graph TD）→ spy 不调；X6 面原样（.mmagic-flow__canvas 在场）', async () => {
    const { el, inst } = await mount(FLOW_SRC)
    expect(meHolder.createMindEditorSurface).not.toHaveBeenCalled()
    expect(el.querySelector('.mmagic-flow__canvas')).not.toBeNull()
    inst.dispose()
  })

  it('sequenceDiagram → spy 不调；X6 面原样（canvas 在场）', async () => {
    const { el, inst } = await mount(SEQ_SRC)
    expect(meHolder.createMindEditorSurface).not.toHaveBeenCalled()
    expect(el.querySelector('.mmagic-flow__canvas')).not.toBeNull()
    inst.dispose()
  })

  it('architecture-beta → spy 不调；X6 面原样（canvas 在场）', async () => {
    const { el, inst } = await mount(ARCH_SRC)
    expect(meHolder.createMindEditorSurface).not.toHaveBeenCalled()
    expect(el.querySelector('.mmagic-flow__canvas')).not.toBeNull()
    inst.dispose()
  })

  it('空 mindmap（仅头行无节点）→ spy 不调；走既有 mermaid 只读降级（.mmagic-mermaid 在场）', async () => {
    const { el, inst } = await mount(EMPTY_MM_SRC)
    expect(meHolder.createMindEditorSurface).not.toHaveBeenCalled()
    expect(el.querySelector('.mmagic-mermaid')).not.toBeNull()
    expect(el.querySelector('.mmagic-flow__canvas')).toBeNull() // 降级替换了 X6 壳
    inst.dispose()
  })

  it('委派 opts 快照：键集合钉死 7 契约键（超键=实现违规）+ file.key/ctx/el 透传 + t/onDirty/onReadonly 形状', async () => {
    const { el, ctx } = await mount(MM_SRC)
    expect(meHolder.createMindEditorSurface).toHaveBeenCalledTimes(1)
    const opts = meHolder.createMindEditorSurface.mock.calls[0]![0] as Record<string, unknown>
    // 键集合 toEqual 钉死（MC1 委派签名：{ el, text, ctx, file, t, onDirty, onReadonly }）
    expect(Object.keys(opts).sort()).toEqual(['ctx', 'el', 'file', 'onDirty', 'onReadonly', 't', 'text'])
    expect(opts.el).toBe(el)
    expect(opts.ctx).toBe(ctx)
    expect((opts.file as { key?: string }).key).toBe(FILE.key)
    expect(typeof opts.t).toBe('function')
    expect(opts.onDirty === undefined || typeof opts.onDirty === 'function').toBe(true)
    expect(opts.onReadonly === undefined || typeof opts.onReadonly === 'function').toBe(true)
  })

  it('分派时机：spy 调用的瞬间 el 尚无任何子节点（入口分派，先于任何 DOM 构建）', async () => {
    await mount(MM_SRC)
    expect(meHolder.createMindEditorSurface).toHaveBeenCalledTimes(1)
    expect(meHolder.state.childCounts).toEqual([0])
  })
})
