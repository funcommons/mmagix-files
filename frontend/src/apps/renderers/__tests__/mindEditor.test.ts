/**
 * MindEditor 渲染面单测（MC2-T 落地 16 例；MC2-R2-surface 按 MC2-R 主代理裁决补强断言：
 * usePlugin 注册 / undo-redo 命令面与历史可用性 / beforeDispose 关闭确认全程 / meta 拼接唯一性位点）
 * 契约正本：.claude/mind-loop-state.md「MC2 表面契约」+「MC2 契约锚点」节
 *
 * 入口契约：createMindEditorSurface({ el, text, ctx, file:{key,name}, t, onDirty?, onReadonly? })
 *   → Promise<{ dispose(): void }>
 *
 * 引擎 simple-mind-map 整体 mock（测的是胶水不是引擎）。mock API 面（MC2-C 按此实现）：
 *   - default 导出 class：constructor(opt{el,data,layout,theme,…})（opt 原样存 this.opt）
 *   - 静态 MindMap.defineTheme(name, cfg)（实例化前对 MIND_THEMES 四套逐个注册）
 *   - 静态 MindMap.usePlugin(plugin)（MC2-R2 补：胶水为防护式注册（typeof 守卫），mock 补该
 *     静态后注册分支即走进；记录 usePluginCalls + log 'usePlugin'）
 *   - 静态 MindMap.removeTheme(name)（MP2-R5 N1 补：回收通道记录面——业务侧 cast-optional
 *     `(MindMap as …).removeTheme?.()` 消费面，mock 有此静态即被调、无则静默跳过=零扰动；
 *     记录 removeThemeCalls + log 'removeTheme:<name>'）
 *   - mm.on(ev, fn)（handler map 存档，测试用 mm.emit(ev, ...args) 触发——args 原样透传，
 *     back_forward(idx,len) 双参语义由此可全链断言）
 *   - mm.execCommand(cmd)（MC2-R2 补：undo='BACK'/redo='FORWARD' 命令面记录；胶水 optional 调用）
 *   - mm.view.fit()；mm.setData(tree)；mm.getData()（返回 harness.dataTree 的 JSON 深克隆——
 *     MC3-F3-T 域同构：真引擎 getCopyData 每节点 simpleDeepClone 剥 undefined 值键名
 *     （utils/index.js:153-163+Command.js:177-181），mock 过同一克隆返回；测试注入编辑树）
 *   - mm.render() / mm.setTheme(t) / mm.updateData(tree)（可控桩）；mm.destroy()
 *   - mm.command?（MC4-R2 补：真引擎 Command.js 实例位——胶水挂载即 dirty 闸 2 内容闸判据读
 *     此字段；mock 缺省 undefined = 闸 2 直通（既有各例语义不变），内容闸用例显式挂 {} 启用）
 *   - 断言出口：harness.state.lastOpt（最近一次构造 opt）、harness.state.instances（实例列表）、
 *     harness.state.log（'defineTheme:<name>' / 'usePlugin' / 'construct' 全局事件序——注册
 *     先于实例化的断言依据）
 *
 * 依赖真函数（不 mock）：flow-model（parseMindmap/serializeMindmap）、apps/mind/meta
 * （parseMindMeta/writeMetaBlock）、apps/mind/convert（toEngineTree/fromEngineTree）、
 * apps/mind/decorations（applyDecorations/applyAssociativeLines——MC3b-C2 apply-on-load + MC3d
 * _assoc 组合链：mount 期望值同链构造）、
 * apps/mind/themes（MIND_THEMES）、七插件类真模块（Drag/Select/KeyboardNavigation/Search——
 * MC3c-T2 起 Search 入册；AssociativeLine/OuterFrame——MC3d-T 起 MC3d 批入册；Export——
 * MP2-E1 批入册；与 mindEditor.ts 同 specifier 同 module graph，toBe 同一实例断言的依据）——meta/convert 已由
 * MC0 落地（若日后缺失，save 两例红即预期，属「待 MC0 落地后解除」口径，其余用例照常）。
 * shared/editToolbar 用真实实现包 spy（部分 mock）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Drag from 'simple-mind-map/src/plugins/Drag'
import Select from 'simple-mind-map/src/plugins/Select'
import KeyboardNavigation from 'simple-mind-map/src/plugins/KeyboardNavigation'
import AssociativeLine from 'simple-mind-map/src/plugins/AssociativeLine'
import OuterFrame from 'simple-mind-map/src/plugins/OuterFrame'
import { createMindEditorSurface } from '../mindEditor'
import { parseMindmap, serializeMindmap } from '../../flow-model'
import { parseMindMeta, writeMetaBlock, type MindMeta } from '../../mind/meta'
import { toEngineTree, fromEngineTree, type EngineNode } from '../../mind/convert'
import { applyDecorations, applyAssociativeLines, extractDecorations } from '../../mind/decorations'
import { MIND_THEMES } from '../../mind/themes'
import type { AppCtx } from '../../../sdk/types'

// ───────────────────────── 引擎 mock（simple-mind-map 记录式桩） ─────────────────────────
const engine = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    instances: [] as Array<Record<string, unknown>>,
    lastOpt: null as Record<string, unknown> | null,
    defineThemeCalls: [] as Array<{ name: string; cfg: unknown }>,
    removeThemeCalls: [] as string[], // 静态 removeTheme(name) 记录（MP2-R5 N1：dispose 回收面——回收本 surface 定义名）
    usePluginCalls: [] as unknown[], // 静态 usePlugin(plugin) 记录（MC2-R2：防护分支走进的断言出口）
    execCommandCalls: [] as string[], // 实例 execCommand(cmd) 记录（MC2-R2：undo='BACK'/redo='FORWARD'）
    dataTree: null as unknown, // getData() 返回值（测试注入编辑树）
    setDataCalls: [] as unknown[],
    updateDataCalls: [] as unknown[],
    setThemeCalls: [] as string[],
    destroyCalls: [] as unknown[],
  }
  class FakeView {
    fitCalls = 0
    fit(): void {
      this.fitCalls++
    }
  }
  class FakeMindMap {
    opt: Record<string, unknown>
    handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    view = new FakeView()
    /** MC4 门控闸 2 信号面：真引擎 Command.js 实例挂 mm.command——mock 缺省 undefined
     *  （胶水 `command !== undefined` 判据不中 → 闸 2 直通，既有各例语义不变）；内容闸用例
     *  显式挂 {} 启用闸（与真引擎面同形） */
    command?: Record<string, unknown>
    constructor(opt: Record<string, unknown>) {
      this.opt = opt
      state.lastOpt = opt
      state.instances.push(this)
      state.log.push('construct')
    }
    static defineTheme(name: string, cfg: unknown): void {
      state.defineThemeCalls.push({ name, cfg })
      state.log.push(`defineTheme:${name}`)
    }
    /** MP2-R5 N1 补：静态 removeTheme(name)（真引擎 index.js:843-846 置 null 非 delete 面——
     *  mock 记录式桩同 defineTheme 形态）。业务侧 cast-optional `(MindMap as …).removeTheme?.()`
     *  消费面：mock 有此静态即被调、无则静默跳过=零扰动（R5 裁决——mock defineTheme 纯 log 无
     *  注册表语义，跨会话回收洞 mock 域不可达的根因；补静态记录面使 dispose 回收通道可达可断言） */
    static removeTheme(name: string): void {
      state.removeThemeCalls.push(name)
      state.log.push(`removeTheme:${name}`)
    }
    /** MC2-R2：胶水按 `typeof MindMap.usePlugin==='function'` 防护注册——mock 补此静态后分支走进 */
    static usePlugin(plugin: unknown): unknown {
      state.usePluginCalls.push(plugin)
      state.log.push('usePlugin')
      return undefined
    }
    on(ev: string, fn: (...args: unknown[]) => void): this {
      const arr = this.handlers.get(ev) ?? []
      arr.push(fn)
      this.handlers.set(ev, arr)
      return this
    }
    /** 测试侧触发引擎事件（data_change / node_tree_render_end / back_forward(idx,len) 等）——args 原样透传 */
    emit(ev: string, ...args: unknown[]): void {
      for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...args)
    }
    /** MC2-R2：引擎命令面（Command.js）——胶水 `mm.execCommand?.(cmd)` optional 调用的落点 */
    execCommand(...args: unknown[]): void {
      state.execCommandCalls.push(String(args[0]))
    }
    setData(d: unknown): void {
      state.setDataCalls.push(d)
    }
    /** MC3-F3-T 克隆同构：真引擎 mm.getData() → Command.getCopyData() → copyRenderTree 每节点
     *  data=simpleDeepClone(root.data)=JSON.parse(JSON.stringify(data))（simple-mind-map
     *  src/utils/index.js:153-163 + src/core/command/Command.js:177-181 实证）——undefined 值
     *  键名被剥除；data_change 载荷同源（engineStateIsSaved/save 同读此口，mock 内无第二通道）。
     *  旧桩直返种子树原对象=undefined 键名存活，mergedMeta 装饰证据判别（ENGINE_DECOR_FIELDS
     *  `in` 判）据此假绿（realm 遮蔽）；改过 JSON 深克隆返回同构真引擎域：N1 清除通道
     *  （SET_NODE_DATA 置 data[key]=undefined）在克隆域键名不存活，守卫例现形红 */
    getData(_withConfig?: boolean): unknown {
      if (state.dataTree === null) return null
      return JSON.parse(JSON.stringify(state.dataTree))
    }
    render(): void {}
    setTheme(t: string): void {
      state.setThemeCalls.push(t)
    }
    updateData(d: unknown): void {
      state.updateDataCalls.push(d)
    }
    destroy(): void {
      state.destroyCalls.push(this)
    }
  }
  return { state, FakeMindMap }
})
vi.mock('simple-mind-map', () => ({ default: engine.FakeMindMap }))

// 工具栏：真实 createEditToolbar 包一层调用记录（DOM 面走真实现——按 shared/editToolbar 真实 API 断言）
const toolbarSpy = vi.hoisted(() => ({ calls: [] as Array<{ labels: unknown; cb: unknown }> }))
vi.mock('../../../shared/editToolbar', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../shared/editToolbar')>()
  return {
    ...mod,
    createEditToolbar(labels: unknown, cb: unknown) {
      toolbarSpy.calls.push({ labels, cb })
      return mod.createEditToolbar(labels as Parameters<typeof mod.createEditToolbar>[0], cb as Parameters<typeof mod.createEditToolbar>[1])
    },
  }
})

// ───────────────────────── 夹具与助手 ─────────────────────────

const MIND_TEXT = ['mindmap', '  根主题', '    分支A', '    分支B', '      子节点'].join('\n')

/** 含 meta 源（canonical 行序：schema → _mindview，与 writeMetaBlock 产出序一致） */
const MIND_TEXT_META = [
  'mindmap',
  '  根主题',
  '    分支A',
  '%% meta: schema=v1',
  '%% meta: _mindview {"layout":"fishbone","theme":"xm-blue"}',
].join('\n')

const FILE = { key: 'docs/demo.mmd', name: 'demo.mmd' }

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** jsdom Blob 兜底读文本（text() 缺席时走 arrayBuffer） */
async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return Buffer.from(await blob.arrayBuffer()).toString('utf8')
}

const createdEls: HTMLElement[] = []
function makeEl(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  createdEls.push(el)
  return el
}

function saveBtnOf(el: HTMLElement): HTMLButtonElement {
  const b = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='save']")
  expect(b, '统一工具栏保存钮（data-act=save）应在容器子树内').not.toBeNull()
  return b!
}

interface MountOpts {
  text?: string
  putObject?: ReturnType<typeof vi.fn>
  onDirty?: ReturnType<typeof vi.fn>
  onReadonly?: ReturnType<typeof vi.fn>
}

async function mount(opts: MountOpts = {}) {
  const el = makeEl()
  const putObject = opts.putObject ?? vi.fn().mockResolvedValue(undefined)
  const onDirty = opts.onDirty ?? vi.fn()
  const onReadonly = opts.onReadonly ?? vi.fn()
  const ctx = {
    getObject: vi.fn(),
    putObject,
    t: (k: string) => k,
    notify: vi.fn(),
    theme: {},
  } as unknown as AppCtx
  const surface = await createMindEditorSurface({
    el,
    text: opts.text ?? MIND_TEXT,
    ctx,
    file: FILE,
    t: (k: string) => k,
    onDirty,
    onReadonly,
  })
  const mm = engine.state.instances.at(-1) as InstanceType<typeof engine.FakeMindMap>
  return { el, ctx, putObject, onDirty, onReadonly, surface, mm }
}

beforeEach(() => {
  const s = engine.state
  s.log.length = 0
  s.instances.length = 0
  s.lastOpt = null
  s.defineThemeCalls.length = 0
  s.removeThemeCalls.length = 0
  s.usePluginCalls.length = 0
  s.execCommandCalls.length = 0
  s.dataTree = null
  s.setDataCalls.length = 0
  s.updateDataCalls.length = 0
  s.setThemeCalls.length = 0
  s.destroyCalls.length = 0
  toolbarSpy.calls.length = 0
})
afterEach(() => {
  for (const el of createdEls) el.remove()
  createdEls.length = 0
  vi.restoreAllMocks()
})

// ───────────────────────── 装配与引擎 ─────────────────────────

describe('装配与引擎', () => {
  it('mindmap 文本 → MindMap constructor 被调一次，el/data/layout/theme 四项正确（data=applyAssociativeLines(applyDecorations(toEngineTree, meta), meta)——MC3b-C2 apply-on-load + MC3d _assoc 组合链）', async () => {
    const { el } = await mount()
    expect(engine.state.instances).toHaveLength(1)
    const opt = engine.state.lastOpt!
    expect(opt.el).toBe(el)
    // MC3b-C2 + MC3d：mount 数据源=applyAssociativeLines(applyDecorations(toEngineTree(base), parseMindMeta(text)), meta)
    // ——期望与实现同一组合链构造（MC3-V2 N3 清账：例名/断言按 MC3d 组合链口径对齐，断言本体如实
    // 补挂 applyAssociativeLines 外层——本例文件无 node meta/._assoc 行，两函数皆空转，断言值不变）
    const meta = parseMindMeta(MIND_TEXT)
    expect(opt.data).toEqual(applyAssociativeLines(applyDecorations(toEngineTree(parseMindmap(MIND_TEXT)), meta), meta))
    expect((opt.data as { data: { text: string } }).data.text).toBe('根主题')
    expect(opt.layout).toBe('logicalStructure')
    expect(opt.theme).toBe('xm-green')
  })

  it('实例化前 MindMap.defineTheme 被调四套（xm-green/xm-blue/xm-slate/xm-amber，cfg=MIND_THEMES）', async () => {
    await mount()
    const calls = engine.state.defineThemeCalls
    expect(calls.map((c) => c.name).sort()).toEqual(['xm-amber', 'xm-blue', 'xm-green', 'xm-slate'])
    for (const { name, cfg } of calls) {
      expect(cfg).toEqual(MIND_THEMES[name as keyof typeof MIND_THEMES])
    }
    // 注册先于实例化（全局事件序：四条 defineTheme 均在首条 construct 之前）
    const firstConstruct = engine.state.log.indexOf('construct')
    expect(firstConstruct).toBeGreaterThan(-1)
    for (const { name } of calls) {
      expect(engine.state.log.indexOf(`defineTheme:${name}`)).toBeGreaterThanOrEqual(0)
      expect(engine.state.log.indexOf(`defineTheme:${name}`)).toBeLessThan(firstConstruct)
    }
  })

  it('usePlugin 防护分支（MC2-R2；MC3d-T 翻转 4→6；MP2-E1-T 翻转 6→7）：Drag/Select/KeyboardNavigation/Search/AssociativeLine/OuterFrame/Export 七插件类被注册（与实现 import 同一模块实例 toBe），序位四主题注册之后 constructor 之前', async () => {
    await mount()
    const calls = engine.state.usePluginCalls
    expect(calls, '防护式注册恰七件（MP2-E1 批 +Export；mock 补静态 usePlugin 后分支走进）').toHaveLength(7)
    // 断言形态=插件类本身 toBe：实现与测试用同一 specifier import → 同一 module graph 同一实例
    expect(calls[0]).toBe(Drag)
    expect(calls[1]).toBe(Select)
    expect(calls[2]).toBe(KeyboardNavigation)
    expect(calls[3]).toBe(Search)
    expect(calls[4]).toBe(AssociativeLine) // MC3d 批：关联线（P1-3 收口①）
    expect(calls[5]).toBe(OuterFrame) // MC3d 批：外框（P1-3 收口①；位次追加于 Search 之后=测试侧钉定，实现侧对齐）
    expect(calls[6]).toBe(Export) // MP2-E1 批：导出 png/svg/json/OPML（instanceName 'doExport'，Export.js:458 实测；位次追加于 OuterFrame 之后=测试侧钉定，实现侧对齐）
    // 装配序（文件头声明）：defineTheme 四套 → usePlugin 七件 → constructor
    const log = engine.state.log
    const firstUse = log.indexOf('usePlugin')
    const lastTheme = Math.max(...log.map((e, i) => (e.startsWith('defineTheme:') ? i : -1)))
    const firstConstruct = log.indexOf('construct')
    expect(firstUse).toBeGreaterThan(lastTheme)
    expect(firstConstruct).toBeGreaterThan(firstUse)
  })

  it('text 含 _mindview meta → constructor opt.layout=fishbone、opt.theme=xm-blue（meta 透传）', async () => {
    await mount({ text: MIND_TEXT_META })
    expect(engine.state.lastOpt!.layout).toBe('fishbone')
    expect(engine.state.lastOpt!.theme).toBe('xm-blue')
    // 树不含 meta 行（_mindview/schema 不入 nodeMeta→applyDecorations 空转，deep-equal 裸树；
    // MC3b-C2 起期望值统一走 applyDecorations(toEngineTree, meta) 同链构造——口径与实现一致）
    expect(engine.state.lastOpt!.data).toEqual(applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_META)), parseMindMeta(MIND_TEXT_META)))
  })

  it('文件 meta 装饰 mount 注入（MC3b-C2 apply-on-load）：node meta 行（分支A 旧注+链接）→ opt.data 对应节点 data 注入装饰、无键节点零污染', async () => {
    await mount({ text: MIND_TEXT_NODEMETA }) // 夹具=MC3b 块的 node-meta 源（下方声明，it 回调运行期取值）
    const opt = engine.state.lastOpt!
    // 全树形态钉同链构造期望（与实现同一构造链：applyDecorations(toEngineTree, parseMindMeta)）
    expect(opt.data).toEqual(applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_NODEMETA)), parseMindMeta(MIND_TEXT_NODEMETA)))
    // 可读面：分支A（根主题首子）装饰字段值=文件 meta 行记录（note/hyperlink 双字段注入）
    const branchA = (opt.data as EngineNode).children[0]!
    expect(branchA.data.note).toBe('旧注')
    expect(branchA.data.hyperlink).toBe('https://example.com/a')
    // meta 无键节点零装饰污染（根主题/分支B data 无 note 键）
    expect((opt.data as EngineNode).data.note).toBeUndefined()
    expect((opt.data as EngineNode).children[1]!.data.note).toBeUndefined()
  })

  it('text 无 meta → 缺省口径 layout=logicalStructure + theme=xm-green（生产皮肤）', async () => {
    await mount()
    expect(engine.state.lastOpt!.layout).toBe('logicalStructure')
    expect(engine.state.lastOpt!.theme).toBe('xm-green')
  })

  it('node_tree_render_end handler 触发 → engine.view.fit() 被调', async () => {
    const { mm } = await mount()
    const before = mm.view.fitCalls
    mm.emit('node_tree_render_end')
    expect(mm.view.fitCalls).toBe(before + 1)
  })
})

// ───────────────────────── dirty 与保存链 ─────────────────────────

describe('dirty 与保存链', () => {
  it("data_change → onDirty(true)+保存钮红点；save 成功 → onDirty(false)+红点清除", async () => {
    const { mm, onDirty, el } = await mount()
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线，其后 data_change 才进标脏
    mm.emit('data_change')
    expect(onDirty).toHaveBeenCalledWith(true)
    const saveBtn = saveBtnOf(el)
    expect(saveBtn.classList.contains('is-dirty')).toBe(true)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 未编辑树
    saveBtn.click()
    await vi.waitFor(() => expect(onDirty).toHaveBeenCalledWith(false))
    expect(saveBtn.classList.contains('is-dirty')).toBe(false)
  })

  it("挂载即 dirty 门控（MC4-T2）：初始化期 data_change 不标脏——首个 node_tree_render_end 前 emit 被忽略（真引擎初始化触发的误信号不进红点/onDirty）", async () => {
    const { mm, onDirty, el } = await mount()
    expect(onDirty).not.toHaveBeenCalled() // 基线：mount 全程（含 mm.render()）零标脏
    mm.emit('data_change') // 未发过任何 node_tree_render_end——初始化期，门控生效
    expect(onDirty).not.toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(false)
  })

  it("挂载即 dirty 门控（MC4-T2）：首个 node_tree_render_end 后 data_change 恢复标脏——onDirty(true)+保存钮 is-dirty 在场", async () => {
    const { mm, onDirty, el } = await mount()
    mm.emit('node_tree_render_end') // 首渲染：解除门控（此后 data_change 恢复真编辑语义）
    mm.emit('data_change')
    expect(onDirty).toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
  })

  it("内容闸（MC4-R2）：command 在场（真引擎面）+ 引擎现态=打开时树 → data_change 不标脏——序列化==savedValue 早退（onDirty 零调/无 is-dirty）", async () => {
    const { mm, onDirty, el } = await mount()
    mm.command = {} // 真引擎 Command.js 在场位——胶水闸 2 判据（command!==undefined）启用
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // getData 注入未编辑树（等价打开时文本）
    mm.emit('node_tree_render_end') // 两闸串联：闸 1 基线闩先立，闸 2 内容闸次之
    mm.emit('data_change') // 初始化式误信号形态：现态序列化 == savedValue → 闸 2 早退不标脏
    expect(onDirty).not.toHaveBeenCalled()
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(false)
  })

  it("内容闸对照（MC4-R2）：command 在场 + 引擎现态=已编辑树 → data_change 照常标脏（闸只拦内容相等误信号，不拦真编辑）", async () => {
    const { mm, onDirty, el } = await mount()
    mm.command = {}
    const edited = toEngineTree(parseMindmap(MIND_TEXT))
    edited.children[0]!.data.text = '分支A改' // 模拟引擎内改名（save 链例同手法）
    engine.state.dataTree = edited
    mm.emit('node_tree_render_end')
    mm.emit('data_change') // 现态序列化 != savedValue → 真编辑语义，闸 2 放行标脏
    expect(onDirty).toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
  })

  it('save 链：getData 编辑树 → putObject(key, Blob text/plain) + notify(saved,{key}) + 文本=serializeMindmap(fromEngineTree(...))', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, ctx, el } = await mount({ putObject })
    const base = parseMindmap(MIND_TEXT)
    const edited = toEngineTree(base)
    edited.children[0]!.data.text = '分支A改' // 模拟引擎内改名
    engine.state.dataTree = edited
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(ctx.notify).toHaveBeenCalledWith('saved', expect.anything()))
    expect(putObject).toHaveBeenCalledTimes(1)
    expect(putObject.mock.calls[0]![0]).toBe(FILE.key)
    const blob = putObject.mock.calls[0]![1] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('text/plain;charset=utf-8')
    // 期望值用真函数构造：getData 树 → fromEngineTree(base) → serializeMindmap
    expect(await blobText(blob)).toBe(serializeMindmap(fromEngineTree(edited, base)))
    expect(ctx.notify).toHaveBeenCalledWith('saved', { key: FILE.key })
  })

  it('save 含 meta 源：writeMetaBlock 行保留 + 拼接唯一性/位点（各恰一次、header 后紧邻整块、正文零重复零双发）+ 正文树行在场（meta 不丢）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ text: MIND_TEXT_META, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META)) // 未编辑
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    for (const line of writeMetaBlock(parseMindMeta(MIND_TEXT_META))) {
      expect(out).toContain(line)
    }
    expect(out).toContain('%% meta: schema=v1')
    expect(out).toContain('%% meta: _mindview {"layout":"fishbone","theme":"xm-blue"}')
    expect(out).toContain('  根主题')
    expect(out).toContain('    分支A')
    // ── P2-3 唯一性/位点（从最终保存文本钉胶水拼接，不 mock 真函数）：
    //     serializeMindmap 自身 meta 通道零发射（fromEngineTree 产物 metaById 恒空），
    //     meta 块只能来自 spliceMetaBlock 一次拼接——若位点多拼/漏拼/双发即在此红
    const metaLines = writeMetaBlock(parseMindMeta(MIND_TEXT_META))
    expect(metaLines).toEqual(['%% meta: schema=v1', '%% meta: _mindview {"layout":"fishbone","theme":"xm-blue"}'])
    // 全文 meta 行总数恰=拼接块条数（正文树行零重复、序列化零自发射）
    expect((out.match(/%% meta:/g) ?? []).length).toBe(metaLines.length)
    // 每条 meta 行恰出现一次（如 `%% meta: _mindview …` 计数===1）
    for (const line of metaLines) {
      expect(out.split(line).length - 1, `meta 行应恰出现一次：${line}`).toBe(1)
    }
    // 位点：header（首行 mindmap）后紧邻整块按 writeMetaBlock 行序插入，其后才是正文树行
    expect(out.split('\n')).toEqual(['mindmap', ...metaLines, '  根主题', '    分支A'])
  })

  it('未编辑直接保存 → 文本零 diff（不合成缺省 meta 行）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(await blobText(putObject.mock.calls[0]![1] as Blob)).toBe(MIND_TEXT)
  })

  it('Ctrl+S（el 派发冒泡）→ save 链触发 + preventDefault 拦截', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, ctx, el } = await mount({ putObject })
    // data_change 仅标脏走红点/onDirty 通道——save 只守 saving/readonly、无 dirty 守卫
    // （MC2-C 裁决 1：dirty 只管红点/reset/onDirty，保存恒序列化引擎现态），此处 emit 非保存前置
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线（门控与保存链正交，emit 保持真编辑语义）
    mm.emit('data_change')
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    const pd = vi.spyOn(Event.prototype, 'preventDefault')
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(ctx.notify).toHaveBeenCalledWith('saved', { key: FILE.key }))
    expect(putObject).toHaveBeenCalledTimes(1)
    expect(pd).toHaveBeenCalled()
    pd.mockRestore()
  })
})

// ───────────────────────── 只读闩锁与失败重试 ─────────────────────────

describe('只读闩锁与失败重试', () => {
  it('putObject 抛 {code:4305} → onReadonly 被调；再次 data_change+保存不再触发 putObject（只读闩锁）', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { mm, ctx, onReadonly, el } = await mount({ putObject })
    mm.emit('data_change')
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1))
    expect(ctx.notify).not.toHaveBeenCalledWith('saved', expect.anything())
    // 闩锁：后续编辑+保存不再触达 putObject
    mm.emit('data_change')
    await flush()
    saveBtnOf(el).click()
    await flush()
    expect(putObject).toHaveBeenCalledTimes(1)
  })

  it('putObject 抛普通错 → 保持 dirty（onDirty 未收 false）、无 notify(saved)；可重试成功', async () => {
    const putObject = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(undefined)
    const { mm, ctx, onDirty, el } = await mount({ putObject })
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线（「保持 dirty」前提须真 dirty）
    mm.emit('data_change')
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    saveBtnOf(el).click()
    await flush()
    expect(putObject).toHaveBeenCalledTimes(1)
    expect(onDirty).not.toHaveBeenCalledWith(false)
    expect(ctx.notify).not.toHaveBeenCalledWith('saved', expect.anything())
    saveBtnOf(el).click() // 瞬时失败可重试
    await vi.waitFor(() => expect(ctx.notify).toHaveBeenCalledWith('saved', { key: FILE.key }))
    expect(putObject).toHaveBeenCalledTimes(2)
    expect(onDirty).toHaveBeenCalledWith(false)
  })
})

// ───────────────────────── undo/redo 与历史可用性（MC2-R2） ─────────────────────────

describe('undo/redo 与历史可用性', () => {
  it('工具栏 undo/redo 键 → 引擎命令面：undo=execCommand("BACK")、redo=execCommand("FORWARD")（顺序记录）', async () => {
    const { el } = await mount()
    const undoBtn = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='undo']")
    const redoBtn = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='redo']")
    expect(undoBtn, 'undo 钮应在容器子树内').not.toBeNull()
    expect(redoBtn, 'redo 钮应在容器子树内').not.toBeNull()
    expect(engine.state.execCommandCalls).toEqual([])
    undoBtn!.click() // 胶水 mm.execCommand?.('BACK')——mock 补 execCommand 后落点可断
    expect(engine.state.execCommandCalls).toEqual(['BACK'])
    redoBtn!.click()
    expect(engine.state.execCommandCalls).toEqual(['BACK', 'FORWARD'])
  })

  it('back_forward(idx,len) → toolbar.setHistory 历史可用性（真实 editToolbar disabled 位：栈底禁 undo / 中部全启 / 栈顶禁 redo）', async () => {
    // 引擎历史链在本 mock 下走全链：胶水 mm.on('back_forward') 注册于 mock handler map，
    // emit 双参透传 → 真实 editToolbar setHistory → undo/redo 钮 disabled 位（引擎内部 Command.js 不钉）
    const { mm, el } = await mount()
    const undoBtn = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='undo']")!
    const redoBtn = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='redo']")!
    mm.emit('back_forward', 0, 3) // 栈底：不可 undo、可 redo
    expect(undoBtn.disabled).toBe(true)
    expect(redoBtn.disabled).toBe(false)
    mm.emit('back_forward', 1, 3) // 中部：双向可用
    expect(undoBtn.disabled).toBe(false)
    expect(redoBtn.disabled).toBe(false)
    mm.emit('back_forward', 2, 3) // 栈顶：可 undo、不可 redo
    expect(undoBtn.disabled).toBe(false)
    expect(redoBtn.disabled).toBe(true)
  })

  it('readonly 闩锁封 undo/redo 命令面：4305 后点击不触 execCommand（胶水 if(readonly) return 分支）', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { el, onReadonly } = await mount({ putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 闩锁须走完保存链至 putObject 抛 4305
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1))
    el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='undo']")!.click()
    el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='redo']")!.click()
    expect(engine.state.execCommandCalls).toEqual([])
  })
})

// ───────────────────────── 生命周期与容器 ─────────────────────────

describe('生命周期与容器', () => {
  it('dispose → engine.destroy() 被调一次；重复 dispose 幂等不抛', async () => {
    const { surface } = await mount()
    surface.dispose()
    expect(engine.state.destroyCalls).toHaveLength(1)
    expect(() => surface.dispose()).not.toThrow()
    expect(engine.state.destroyCalls).toHaveLength(1) // 重复 dispose 不重复拆引擎
  })

  it('重置（resetToSaved 语义）：dirty 后点 reset → 引擎重喂原树 + dirty 收 false', async () => {
    const { mm, onDirty, el } = await mount()
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线，其后 data_change 才进标脏
    mm.emit('data_change')
    expect(onDirty).toHaveBeenCalledWith(true)
    const resetBtn = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='reset']")
    expect(resetBtn, '统一工具栏重置钮应在容器子树内').not.toBeNull()
    resetBtn!.click()
    await vi.waitFor(() => expect(onDirty).toHaveBeenCalledWith(false))
    // 引擎被重新喂数据（setData / updateData 任一路径均属契约内实现）
    const fed = [...engine.state.setDataCalls, ...engine.state.updateDataCalls].at(-1)
    expect(fed).toEqual(toEngineTree(parseMindmap(MIND_TEXT)))
  })

  it('工具栏：createEditToolbar 被调一次，DOM 四键 save/undo/redo/reset（shared/editToolbar 真实 API）', async () => {
    const { el } = await mount()
    expect(toolbarSpy.calls).toHaveLength(1)
    expect(el.querySelector('.mmx-edt')).not.toBeNull()
    const acts = [...el.querySelectorAll('.mmx-edt__btn[data-act]')].map((b) => b.getAttribute('data-act'))
    expect(acts).toEqual(['save', 'undo', 'redo', 'reset'])
    const labels = toolbarSpy.calls[0]!.labels as Record<string, unknown>
    for (const k of ['save', 'undo', 'redo', 'reset']) {
      expect(labels[k], `labels.${k} 应经 t() 解析在场`).toBeTruthy()
    }
  })

  it('容器注入隔离 reset 样式（p{margin:0} 规则在场）', async () => {
    const { el } = await mount()
    // 可断言形态（实现自由度）：el 子树内存在 <style>，其文本含「p 选择器 + margin:0」规则——
    // 只钉 p{margin:0} 语义在场（plan.md §十 UA 缺省 margin 把 foreignObject 文本推出节点框的坑），
    // 整段 reset CSS 写法不限。
    const styles = [...el.querySelectorAll('style')].map((s) => s.textContent ?? '')
    expect(styles.some((t) => /(^|[},{\s])p\s*\{[^}]*margin\s*:\s*0/.test(t))).toBe(true)
  })
})

// ───────────────────────── beforeDispose 关闭确认全程（MC2-R2，flow-editor/code.ts 同口径） ─────────────────────────

describe('beforeDispose 关闭确认', () => {
  it('契约在场：非 dirty 同步放行 true；dirty+非 close（expired/destroy）放行 true——confirm 全程零触', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const { surface, mm } = await mount()
    expect(typeof surface.beforeDispose).toBe('function')
    expect(surface.beforeDispose?.()).toBe(true) // 非 dirty：放行（不询问）
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线（「dirty=true」注释须成真）
    mm.emit('data_change') // dirty=true
    expect(surface.beforeDispose?.('destroy')).toBe(true) // 仅 close 才走确认竞速
    expect(surface.beforeDispose?.('expired')).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('dirty+close → 确认竞速路径：confirm("app.code-unsaved") 应答 true → resolves true（宿主据此 dispose→mm.destroy）', async () => {
    const { surface, mm } = await mount()
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线，其后 data_change 才进标脏
    mm.emit('data_change')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(surface.beforeDispose?.('close')).resolves.toBe(true)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith('app.code-unsaved') // mount 的 t 恒等：文案键原样进 confirm
    surface.dispose() // 建模宿主侧：确认通过才 dispose
    expect(engine.state.destroyCalls).toHaveLength(1)
  })

  it('dirty+close 且应答 false → resolves false（宿主暂缓关闭；3s 超时未到以应答为准，引擎不拆）', async () => {
    const { surface, mm } = await mount()
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线，其后 data_change 才进标脏
    mm.emit('data_change')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await expect(surface.beforeDispose?.('close')).resolves.toBe(false)
    expect(engine.state.destroyCalls).toHaveLength(0)
  })

  it('3s 超时竞速胜出：应答永不落地 → fake 时钟推进 3000ms 后 resolves true（过期缺省放行；dispose 决定权在宿主）', async () => {
    const { surface, mm } = await mount()
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线，其后 data_change 才进标脏
    mm.emit('data_change')
    vi.spyOn(window, 'confirm').mockImplementation(() => new Promise<boolean>(() => {})) // 永不应答
    vi.useFakeTimers()
    try {
      const settled = vi.fn()
      void (surface.beforeDispose?.('close') as Promise<boolean>).then(settled)
      expect(settled).not.toHaveBeenCalled() // 超时未到：悬置
      await vi.advanceTimersByTimeAsync(3000)
      expect(settled).toHaveBeenCalledWith(true)
    } finally {
      vi.useRealTimers()
    }
    expect(engine.state.destroyCalls).toHaveLength(0) // 超时只裁决应答，不自动拆引擎
    surface.dispose()
    expect(engine.state.destroyCalls).toHaveLength(1)
  })

  it('readonly 闩锁放行：4305 后 dirty 仍在，close 询问被跳过（同步 true、confirm 零触）', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { surface, mm, el, onReadonly } = await mount({ putObject })
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线（「dirty=true」前提须成真）
    mm.emit('data_change') // dirty=true（先于闩锁，钉 readonly 优先于 dirty 的放行序）
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 闩锁须走完保存链至 putObject 抛 4305
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1))
    const confirmSpy = vi.spyOn(window, 'confirm')
    expect(surface.beforeDispose?.('close')).toBe(true) // readonly 分支：放行不询问
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})

// ═══════════════ MC3b-T 追加块：属性面板接线与保存链装饰整合（新增用例——上方既有用例零改动） ═══════════════
// 契约正本：.claude/mind-loop-state.md「MC3b 契约（锁定）」节；面板 DOM 面归 mindPanel.test.ts 直测，
// 本块只测 surface 侧：createMindPanel 调用/opts、node_active→setNode/clear、onEdit(patch)→保存链叠加。
//
// mock：'../mindPanel' 整体 mock（记录式桩）。mindPanel.ts 未落地也须可装配（vitest 4 对不可解析
// 路径按 fallback 键注册 mock——MC1 分派测试同手法实证）。追加块自带 describe 级 beforeEach
// （面板桩每例清账），外层既有 beforeEach/afterEach 不动。
//
// 【预期红账（MC3b-T 时点，MC3b-C 未落地）】
//  - 接线例 3 例（装配/无激活 clear/有激活 setNode）：红=surface 未调 createMindPanel
//    （state.created 空→created[0] 读取抛错）——MC3b-C 面板接线未落地的断言期红，非解析红。
//  - 保存链整合例 2 例（编辑保存/叠加保留）：红=onEdit 通道不存在（created 空）+保存链叠加未
//    落地——待 MC3b-C 解除（其实现 import mind/decorations，故 MC3a-C 在盘为其前提；本块期望值
//    仅用已落地的 buildNodeKey 构造，不直接 import decorations，红归因=纯接线面）。
//  - 「未编辑零 diff 保持」例现状已绿（既有红线例的 MC3b 强化工：文件 node meta 行在场时字节级
//    保持）；叠加链落地后转守门例。
//
// 【契约实证勘误（测试侧发现，主代理请回写 state 文件）】契约行「引擎 active_node_change 事件」
// 实证不存在：simple-mind-map@0.14.0-fix.3 Render.js:465 实际事件为 node_active(node, activeNodeList)
// （且 setTimeout(0) 异步派发）——本块按实证事件名/实参形态钉（无激活=(null,[])、有激活=(node,[node])）。
// ═════════════════════════════════════════════════════════════════════════════════════════
import { buildNodeKey } from '../../mind/meta'

// mindPanel 面板桩（记录式）：api=setNode/clear/dispose spy + el 占位 div（不挂 DOM——接线断言不需要）
const panelHolder = vi.hoisted(() => {
  const state = {
    created: [] as Array<{
      opts: Record<string, unknown>
      api: { el: HTMLElement; setNode: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
    }>,
  }
  const createMindPanel = vi.fn((opts: Record<string, unknown>) => {
    const api = {
      el: document.createElement('div'),
      setNode: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    }
    state.created.push({ opts, api })
    return api
  })
  return { state, createMindPanel }
})
vi.mock('../mindPanel', () => ({ createMindPanel: panelHolder.createMindPanel }))

/** MC3b 追加夹具：文件 meta 含节点行（分支A 旧注+链接双字段记录）——叠加链/零 diff 例用。
 *  meta 行置于 header 后=保存链拼接产物的同一形态（零 diff 例字节等价的前提：meta 行在
 *  任何其它位置都会被 spliceMetaBlock 规范化挪位——非缺陷，是「输出恒规范形」语义） */
const MIND_TEXT_NODEMETA = [
  'mindmap',
  '%% meta: schema=v1',
  '%% meta: 根主题/分支A {"note":"旧注","hyperlink":"https://example.com/a"}',
  '  根主题',
  '    分支A',
  '    分支B',
].join('\n')

describe('MC3b 面板接线与保存链装饰整合', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
  })

  it('MC3b 接线：装配即 createMindPanel 恰一次——opts.el=宿主 el、t/onEdit 函数形态（onClose 传否不钉=实现自由度）', async () => {
    const { el } = await mount()
    const created = panelHolder.state.created
    expect(created, 'surface 装配期应创建属性面板（mindPanel mock 桩记录）').toHaveLength(1)
    expect(created[0]!.opts.el).toBe(el)
    expect(created[0]!.opts.t).toBeInstanceOf(Function)
    expect(created[0]!.opts.onEdit).toBeInstanceOf(Function)
  })

  it('MC3b 接线：node_active 无激活（node=null, list=[]）→ panel.clear 被调、setNode 不调（无激活=隐藏语义归面板工厂自测）', async () => {
    const { mm } = await mount()
    const api = panelHolder.state.created[0]!.api
    api.clear.mockClear() // 隔离装配期可能的预 clear——只认本例 emit 的信号
    mm.emit('node_active', null, [])
    expect(api.clear).toHaveBeenCalled()
    expect(api.setNode).not.toHaveBeenCalled()
  })

  it('MC3b 接线：node_active 有激活（node,[node]）→ panel.setNode 被调且载荷含激活节点装饰字段值（extract 字段记录；payload 信封实现自由度只钉字段值）', async () => {
    const { mm } = await mount()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const nodeA = tree.children[0]!
    nodeA.data.note = '旧值' // 激活节点携带装饰——面板回填源=引擎现态反提
    const api = panelHolder.state.created[0]!.api
    api.setNode.mockClear()
    mm.emit('node_active', nodeA, [nodeA])
    expect(api.setNode).toHaveBeenCalled()
    expect(api.setNode).toHaveBeenCalledWith(expect.objectContaining({ note: '旧值' }))
  })

  it('MC3b 保存链整合：面板 onEdit(patch)→引擎节点 data→data_change（render_end 已过）→保存——Blob 文本 toContain 新 note 的 meta 行（键=buildNodeKey 路径）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, el } = await mount({ text: MIND_TEXT_NODEMETA, putObject })
    const base = parseMindmap(MIND_TEXT_NODEMETA)
    const tree = toEngineTree(base)
    engine.state.dataTree = tree
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线，其后 data_change 才进标脏
    const nodeB = tree.children[1]! // 分支B（被编辑节点）
    mm.emit('node_active', nodeB, [nodeB]) // 激活→面板回填（本例不钉 payload——接线例已钉）
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ note: '新注' }) // 面板编辑→surface 补丁进引擎（execCommand/setData 路径不钉=实现自由度）
    nodeB.data.note = '新注' // 模拟引擎应用补丁后的现态（真引擎=SET_NODE_DATA 落 data；mock 注入同既有手法——非空洞：保存序列化即含此行）
    mm.emit('data_change')
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(out).toContain(`%% meta: ${buildNodeKey(['根主题', '分支B'])} {"note":"新注"}`)
  })

  it('MC3b 叠加规则：文件既有 meta 键未被面板编辑→保留原值（旧行字节级在场且恰一次=禁双发射）+ 被编辑节点新行叠加', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, el } = await mount({ text: MIND_TEXT_NODEMETA, putObject })
    const base = parseMindmap(MIND_TEXT_NODEMETA)
    // MC3-F3-T：引擎现态=mount 同链装饰树（apply-on-load 后真引擎 getData 即装饰树形态）。
    // 旧喂未装饰手工树、依赖 mergedMeta「零装饰证据→base 全保留」通道——克隆域+L 通道语义
    // （键∈L 一律 strip 合并、extract 缺席=清除）下属伪影：未装饰树的分支A 记录行会被当
    // 「已清除」抹掉。本例 fixture 无 _assoc 行，applyAssociativeLines 空转，装饰单链即同构。
    const tree = applyDecorations(toEngineTree(base), parseMindMeta(MIND_TEXT_NODEMETA))
    engine.state.dataTree = tree
    mm.emit('node_tree_render_end')
    const nodeB = tree.children[1]!
    mm.emit('node_active', nodeB, [nodeB])
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ note: '新注' })
    nodeB.data.note = '新注'
    mm.emit('data_change')
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    const oldLine = `%% meta: ${buildNodeKey(['根主题', '分支A'])} {"note":"旧注","hyperlink":"https://example.com/a"}`
    expect(out, '未编辑键以文件 meta 为底字节级保留（双字段记录不丢字段不重排）').toContain(oldLine)
    expect(out.split(oldLine).length - 1, '旧行恰一次（禁文件 meta⊕extract 双发射）').toBe(1)
    expect(out).toContain(`%% meta: ${buildNodeKey(['根主题', '分支B'])} {"note":"新注"}`)
  })

  it('MC3b 未编辑零 diff 保持（既有红线例的强化工）：面板在场但从未动过（零 node_active/零 onEdit）→保存输出与打开时字节等价（文件 node meta 行在场：不合成/不漂移/不重排）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ text: MIND_TEXT_NODEMETA, putObject })
    // MC3-F3-T：引擎现态=mount 同链装饰树（同上方叠加规则例口径——未装饰手工树在克隆域+L 通道
    // 下记录行会被 strip 清除、零 diff 即破）。断言不变：装饰注入面与文件记录有损等值
    // （extract 产物字节级同形），未编辑保存仍零 diff。
    engine.state.dataTree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_NODEMETA)), parseMindMeta(MIND_TEXT_NODEMETA))
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(await blobText(putObject.mock.calls[0]![1] as Blob)).toBe(MIND_TEXT_NODEMETA)
  })
})

// ═══════════════ MC3-F1-T 追加块：终评 P1-1/P1-2 缺陷回归守卫（新增用例——上方既有用例零改动） ═══════════════
// 缺陷事实（MC3-V 终评实证；业务侧 MC3-F1 修复已落盘——本块 3 例为守卫例，对修复前实现全红）：
//  - P1-1：applyPanelPatch 面板补丁原样透传 SET_NODE_DATA——面板键 tags 与引擎字段 tag 错位
//    （引擎读 data.tag：nodeCreateContents.js:361；extract 读 d.tag：decorations.ts:169）→标签
//    编辑静默失效。修复=面板键→引擎字段逐键改名下发（仅 tags→tag，其余键直通）。
//    断言形态主/辅双保险：主=execCommand 全参（mock 的 execCommandCalls 只录命令名 String(args[0])
//    无载荷面——实例级 vi.spyOn 补全参视角，透传原实现零干扰）；辅=保存链 meta 行。注：meta 记录
//    键=tags（extract 反提 rec.tags，decorations.ts:169）非引擎字段名 tag——辅断言落
//    {"tags":["a","b"]} 记录行（任务口径「"tag":["a","b"] 相应 meta 行」按可断言形态修正）。
//  - P1-2：mergedMeta nodeMeta.set(key, rec) 整记录替换——extract 产物仅八装饰字段，文件记录含
//    style（meta.ts:42 文档字段「节点超集数据」）或自定义字段时未编辑保存丢字段+字节 diff；且
//    engineStateIsSaved 同链→此类文件挂载即 dirty（MC4 两闸回归）。修复=字段级合并（base 记录
//    全字段保留 ⊕ extract 仅覆盖其声明的装饰键）。
//
// 【红账清账（MC3-V2 N3 注释对齐现状；P1-4 已落盘）】三例全绿：例 1（映射面守卫）/例 2（保存链
// 字节级保留 + dirty 守卫面）/例 3（合并面守卫）。原「例 2 dirty 守卫面红=savedValue 基线对含
// meta 文件恒双块 → 闸 2 恒假 → 挂载即 dirty」为 P1-4 落盘前旧账——基线已改走保存链同构单块
// （归因与修复形态见例内注「清账」+ mindEditor.ts savedValue 注），闸 2 对含 meta 文件恢复真判据。
describe('MC3-F1 终评缺陷回归守卫（P1-1 tags 映射 / P1-2 记录字段级合并）', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
  })

  /** P1-2 守卫夹具：根节点记录含超集字段 style（meta.ts:42 文档字段，非八装饰字段）——整记录
   *  替换即丢，字段级合并须字节级保真。键=根主题（单段无转义） */
  const MIND_TEXT_STYLEMETA = [
    'mindmap',
    '%% meta: schema=v1',
    '%% meta: 根主题 {"note":"旧","style":{"fillColor":"#f00"}}',
    '  根主题',
    '    分支A',
    '    分支B',
  ].join('\n')

  /** P1-2 守卫夹具（对照面）：分支A 记录=装饰键 note + 自定义键 custom 混合——修复须两存 */
  const MIND_TEXT_CUSTOMMETA = [
    'mindmap',
    '%% meta: schema=v1',
    '%% meta: 根主题/分支A {"note":"n","custom":"keep"}',
    '  根主题',
    '    分支A',
    '    分支B',
  ].join('\n')

  it('MC3-F1（P1-1）tags 补丁映射：onEdit({tags}) → SET_NODE_DATA 载荷含引擎字段 tag、不含面板键 tags（主断言=execCommand 全参）+ 保存链 meta 行落 tags 记录（辅断言）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, el } = await mount({ text: MIND_TEXT_NODEMETA, putObject })
    const tree = toEngineTree(parseMindmap(MIND_TEXT_NODEMETA))
    engine.state.dataTree = tree
    mm.emit('node_tree_render_end') // MC4 门控：首渲染立初始基线，其后 data_change 才进标脏
    const nodeB = tree.children[1]! // 分支B（被编辑节点）
    mm.emit('node_active', nodeB, [nodeB]) // 激活→面板回填（payload 归上方接线例已钉）
    // 主断言面：实例级 spy 补 execCommand 全参记录（mock 只录命令名；透传原实现零干扰）
    const execSpy = vi.spyOn(mm, 'execCommand')
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ tags: ['a', 'b'] }) // 面板键=tags（面板域命名）；引擎字段=tag（nodeCreateContents.js:361 读 data.tag）
    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(execSpy.mock.calls[0]![0]).toBe('SET_NODE_DATA')
    expect(execSpy.mock.calls[0]![1]).toBe(nodeB) // 补丁落激活节点
    const patch = execSpy.mock.calls[0]![2] as Record<string, unknown>
    // P1-1 断言本体：面板键 tags 须映射为引擎字段 tag 再下发（错位透传=标签编辑静默失效）
    expect(patch.tag, '面板键 tags 须映射为引擎字段 tag 下发').toEqual(['a', 'b'])
    expect(patch.tags, '引擎载荷不得携带面板键 tags').toBeUndefined()
    // 辅断言面（保存链双保险）：模拟真引擎应用映射后补丁（SET_NODE_DATA 逐键合并 data）→
    // data_change 标脏 → 保存 → extract 读 d.tag 反提 rec.tags（decorations.ts:169）→ meta 行
    nodeB.data.tag = ['a', 'b']
    mm.emit('data_change')
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(await blobText(putObject.mock.calls[0]![1] as Blob)).toContain(
      `%% meta: ${buildNodeKey(['根主题', '分支B'])} {"tags":["a","b"]}`,
    )
  })

  it('MC3-F1（P1-2）含 style 记录未编辑零 diff：未编辑保存输出字节级保留整记录（note+style 同在）+ 挂载期 data_change 不翻 dirty（engineStateIsSaved 同链回归守卫）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ text: MIND_TEXT_STYLEMETA, putObject })
    // 真引擎面：mount 已把装饰 apply-on-load 进 opt.data，getData 回未编辑装饰树（同链构造）
    engine.state.dataTree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_STYLEMETA)), parseMindMeta(MIND_TEXT_STYLEMETA))
    mm.command = {} // 真引擎 Command.js 在场位——闸 2 内容闸启用（engineStateIsSaved 与保存链同一 mergedMeta 链）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    // 整记录字节级在场：note+style 同在（extract 仅八装饰字段，整记录替换即丢 style）
    expect(out, '文件记录超集字段 style 不得被 extract 产物整记录替换丢弃').toContain(
      '%% meta: 根主题 {"note":"旧","style":{"fillColor":"#f00"}}',
    )
    expect(out).toContain('"style"') // 字样面双保险
    expect(out, '未编辑保存=打开时字节等价（零 diff 红线）').toBe(MIND_TEXT_STYLEMETA)
    // 挂载即 dirty 回归守卫：engineStateIsSaved 走同一 mergedMeta 链——现态==savedValue 须早退。
    // 【清账（MC3-V2 N3：下注原为 P1-4 落盘前旧账「预期红」，现守卫即绿）】P1-4 已修：savedValue
    // 基线走保存链同一规范化形态——parseMindmap 本就把 meta 行收进模型、serializeMindmap 对 base
    // 自身重发 meta 块，若基线 serializeMindmap(base) 直拼 writeMetaBlock(meta) 即「双块」≠保存链
    // 单块（fromEngineTree 输出模型 metaById 恒空）、闸 2 对含 meta 文件恒假=挂载即 dirty；现基线
    // serializeMindmap 前克隆剥 meta 重发（metaSchema:null+metaById 空表，浅拷贝不触 base 本体）
    // 再拼 writeMetaBlock(meta)=保存链同构单块，「dirty ⇔ 保存会改字节」不变量恢复
    // （mindEditor.ts savedValue/engineStateIsSaved 注）
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    mm.emit('data_change') // 初始化式 data_change：记录字段级等 → 闸 2 早退不标脏
    expect(onDirty).not.toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(false)
  })

  it('MC3-F1（P1-2 对照面）混合记录不丢自定义字段：未编辑保存输出行 custom 仍在（字段级合并：base 全字段保留⊕extract 仅覆盖装饰键）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ text: MIND_TEXT_CUSTOMMETA, putObject })
    engine.state.dataTree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_CUSTOMMETA)), parseMindMeta(MIND_TEXT_CUSTOMMETA))
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(await blobText(putObject.mock.calls[0]![1] as Blob)).toContain(
      '%% meta: 根主题/分支A {"note":"n","custom":"keep"}',
    )
  })
})

// ═══════════════ MC3-V2-T 追加块：复评 N1/N2 守卫（新增用例——上方既有用例除 N3 注释清账外零改动） ═══════════════
// 缺陷事实（MC3-V2 复评实证）：
//  - N1【P1】清除装饰不复活（双重失效——测试先行，现实现预期红，业务侧修复落地后本守卫转绿）：
//    面板清除一律发 {field: undefined}（mindPanel.ts:99/101/108/113/123，且 undefined=清除是
//    mindPanel.test.ts:184/208/234 钉死契约）→胶水映射通道 undefined 键名存活下发
//    SET_NODE_DATA →真引擎 setNodeData 逐键置 data[key]=undefined（Render.js setNodeData 实测
//    node.nodeData.data[key]=data[key]）→extractDecorations 对 undefined 不产键
//    （decorations.ts:260-273，记录空则整键不产=:273）→mergedMeta 字段级合并
//    {...baseRec, ...rec}（mindEditor.ts:446-448）baseRec 旧装饰值复活；且闸 2
//    engineStateIsSaved 走同一 mergedMeta 链、序列化相等早退（mindEditor.ts:477）→清除编辑
//    连 dirty 都不翻。守卫双断言：①is-dirty 翻真（清除编辑必须可见）②输出记录无 note 键+
//    style/custom 仍在（stripDecorFields 合并语义：extract 产键集以引擎现态为准、非装饰字段保留）。
//  - N2-a/N2-b：终评已落地行为（P2-1 命令落定后补渲 / P2-3 空串搜索早退）的守卫钉，即绿。
// 【MC3-F3-T 域同构记账】getData 桩已改过 JSON 深克隆（真引擎 getCopyData 剥 undefined 值键名
//   同构，见引擎 mock 注）——本守卫例声明的预期红由此方在测试域现形：旧桩直返种子树原对象=
//   undefined 键名存活，mergedMeta 装饰证据判别（ENGINE_DECOR_FIELDS `in` 判）恒有证据=realm
//   遮蔽假绿。克隆域实证双红形态（临时探针副本逐断言消音各红一次实证后已删）：①闸 2 相等
//   早退不翻脏（例内 :980 onDirty 零调）②rec.note='旧' 复活（例内 :989 期望 undefined 得 '旧'）。
//   修复语义归 MC3-F3（mount 期合法装饰键集 L 通道：键∈L 一律 strip 合并、extract 缺席=清除；
//   键∉L 保留）——落地后本守卫转绿。
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('MC3-V2 复评守卫（N1 清除装饰不复活 / N2 补渲与空串搜索钉）', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
  })

  /** N1 守卫夹具：分支A 记录=装饰键 note + 非装饰键 style/custom 三字段混合——清除 note 后
   *  修复语义须「note 消失、style/custom 保留」（整记录替换两头错、现字段级合并复活 note）。
   *  键=根主题/分支A（文本路径键无转义） */
  const MIND_TEXT_N1 = [
    'mindmap',
    '%% meta: schema=v1',
    '%% meta: 根主题/分支A {"note":"旧","style":{"fillColor":"#f00"},"custom":"keep"}',
    '  根主题',
    '    分支A',
    '    分支B',
  ].join('\n')

  it('MC3-V2（N1）清除装饰不复活：onEdit({note: undefined}) → is-dirty 翻真（清除编辑必须可见）+ 保存输出记录无 note 键且 style/custom 仍在（extract 产键集以引擎现态为准、非装饰字段保留）——现实现预期双红（旧值复活+不翻脏），修复落地转绿', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ text: MIND_TEXT_N1, putObject })
    const tree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_N1)), parseMindMeta(MIND_TEXT_N1))
    engine.state.dataTree = tree // 引擎现态=mount 同链装饰树（getData 注入，既有手法）
    mm.command = {} // 真引擎 Command.js 在场位——闸 2 内容闸启用（N1 dirty 失效面=闸 2 同链相等早退）
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    const nodeA = tree.children[0]! // 分支A（被清除装饰的节点）
    mm.emit('node_active', nodeA, [nodeA]) // 激活→面板回填（既有接线）
    const execSpy = vi.spyOn(mm, 'execCommand')
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ note: undefined }) // 面板清除语义（mindPanel.test.ts:184/208/234 钉死契约：undefined=清除）
    // 前置面：清除键 undefined 经映射通道键名存活下发（剥键即通道回归，红归因上游非本缺陷）
    expect(execSpy.mock.calls[0]![0]).toBe('SET_NODE_DATA')
    const patch = execSpy.mock.calls[0]![2] as Record<string, unknown>
    expect('note' in patch, 'undefined 清除键须键名存活下发').toBe(true)
    expect(patch.note).toBeUndefined()
    // 模拟真引擎 setNodeData 逐键置 data[key]=undefined（Render.js setNodeData：node.nodeData.data[key]=data[key]）
    nodeA.data.note = undefined
    mm.emit('data_change') // 现态走 engineStateIsSaved 同链比对
    // 断言①：清除编辑必须可见——is-dirty 翻真（红形态一：闸 2 同链相等早退→清除零反馈）
    expect(onDirty).toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
    // 保存 → 断言②：清除须持久化——记录在场但无 note 键（红形态二：{...baseRec,...rec} 旧值复活）、非装饰字段保留
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const rec = parseMindMeta(await blobText(putObject.mock.calls[0]![1] as Blob)).nodeMeta.get(
      buildNodeKey(['根主题', '分支A']),
    )
    expect(rec, '清除后记录仍在场（style/custom 须保留，不得整记录替换丢弃）').toBeDefined()
    expect(rec?.note, '清除装饰不得复活（baseRec 旧值复活即红）').toBeUndefined()
    expect(rec?.style, '非装饰字段 style 保留').toEqual({ fillColor: '#f00' })
    expect(rec?.custom, '非装饰字段 custom 保留').toBe('keep')
  })

  it('MC3-V2（N2-a）onEdit 补渲守卫：每次 onEdit(patch) 后 mm.render 恰一次（终评 P2-1 已落地行为钉——命令落定后画布重渲，零渲/多渲回归即红）', async () => {
    const { mm } = await mount()
    const renderSpy = vi.spyOn(mm, 'render') // mount 期 mm.render() 已过——spy 只认本例 onEdit 计数
    const nodeA = toEngineTree(parseMindmap(MIND_TEXT)).children[0]!
    mm.emit('node_active', nodeA, [nodeA])
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ note: '新注' })
    expect(renderSpy, '补丁落定后画布重渲恰一次').toHaveBeenCalledTimes(1)
    onEdit({ note: '新注二' })
    expect(renderSpy, '逐补丁恰一次（非会话级一次）').toHaveBeenCalledTimes(2)
  })

  it("MC3-V2（N2-b）空串搜索零调守卫：onSearch('') → mm.search 引擎面零调（终评 P2-3 已落地行为钉——空文搜索语义未定义面，不直通引擎）", async () => {
    const { el, mm } = await mount()
    const face = seedSearchFace(mm)
    pressCtrlF(el)
    const onSearch = searchHolder.state.created[0]!.opts.onSearch as (text: string) => void
    onSearch('')
    expect(face.search, '空串不得直通引擎 search').not.toHaveBeenCalled()
    expect(face.endSearch, '引擎面全零调（endSearch 亦不得误触）').not.toHaveBeenCalled()
  })
})

// ═══════════════ MC3-V4-T 追加块：P1-1 门控越权回归守卫（新增两例——上方既有用例零改动） ═══════════════
// 缺陷事实（MC3-V4 adversarial 实证；测试先行，现实现预期红，业务侧修复落地后本守卫转绿）：
// mergedMeta 门控（mindEditor.ts:515-528）对「base 记录在但 ∉L」键零合并通道：
//  - 第一循环 `if (!legalKeys.has(key)) continue`（mindEditor.ts:516）——键∉L（legalDecorKeys
//    mindEditor.ts:167-181 判定面：note/hyperlink/hyperlinkTitle=string、tags=Array<string>、
//    generalization/outerFrame=isPlainObj、image=string+isSafeImageUrl；零可注入字段=style-only/
//    custom-only/仅非法 image/错型字段）时 extract 产物被整体弃置；
//  - 第二循环 `if (!nodeMeta.has(key))`（mindEditor.ts:527）因 base 记录在而不中 → 会话新增装饰
//    （面板加 note）既不并入 base 记录（不落盘），又使 mergedMeta==meta → 闸 2 engineStateIsSaved
//    序列化相等早退（mindEditor.ts:564）不翻脏=用户输入无反馈丢失。
// 【∪ 口径裁决（主代理已裁，例 2 注记引）】键∉L 记录的修复语义=字段级并集：extract 产字段并入、
//  base 字段（含未过 isSafeImageUrl 闸的非法 image）原样保留——非法 image 保留≠规范化丢失，与
//  「零 diff 优先，不因规范化制造挂载即 dirty」同一口径的会话侧镜像（extract 对非法 image 本就
//  零产，保留源=baseRec）。
// 【红账（克隆域实证形态）】两例同形双红：①断言 1 处先红=闸 2 相等早退不翻脏（onDirty 零调/
//  is-dirty 不在场）；②探针口径（消音①后）=保存输出记录无 note 键（extract 产物被 :516 弃置、
//  :527 因 base 记录在不中——N1 块「临时探针副本逐断言消音」同法实证）。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('MC3-V4 门控越权回归守卫（P1-1 ∉L 记录节点会话新增装饰丢失）', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
  })

  /** P1-1a 夹具：分支A 记录=style-only（零可注入字段→键∉L；style 非八装饰字段，applyRecord
   *  忽略不注入=挂载期引擎树对分支A 零装饰污染） */
  const MIND_TEXT_STYLE_ONLY = [
    'mindmap',
    '%% meta: schema=v1',
    '%% meta: 根主题/分支A {"style":{"fillColor":"#f00"}}',
    '  根主题',
    '    分支A',
    '    分支B',
  ].join('\n')

  /** P1-1b 夹具（case-B）：分支A 记录=仅非法 image（data: 超 isSafeImageUrl 闸→applyRecord
   *  warnDrop 零注入→键∉L；base 记录在=第二循环不中的前提面） */
  const MIND_TEXT_ILLEGAL_IMAGE = [
    'mindmap',
    '%% meta: schema=v1',
    '%% meta: 根主题/分支A {"image":"data:image/png;base64,AAAA"}',
    '  根主题',
    '    分支A',
    '    分支B',
  ].join('\n')

  it('MC3-V4（P1-1a）style-only 记录节点会话新增装饰不丢失：onEdit({note}) → is-dirty 翻真（闸 2 不得因 mergedMeta==meta 相等早退）+ 保存输出记录=字段级并集（note 落盘+style 保留）——现实现预期双红（不翻脏+note 不落盘），修复落地转绿', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ text: MIND_TEXT_STYLE_ONLY, putObject })
    // 引擎现态=mount 同链装饰树（style-only 记录 applyRecord 零注入——分支A data 与裸树同形，键∉L 前提面）
    const tree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_STYLE_ONLY)), parseMindMeta(MIND_TEXT_STYLE_ONLY))
    engine.state.dataTree = tree
    mm.command = {} // 真引擎 Command.js 在场位——闸 2 内容闸启用（P1-1 dirty 失效面=闸 2 同链相等早退）
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    const nodeA = tree.children[0]! // 分支A（会话新增装饰的节点）
    mm.emit('node_active', nodeA, [nodeA]) // 激活→面板回填（既有接线）
    // 链路前置面：SET_NODE_DATA 携 note 下发（通道若断，红归因上游非本缺陷）
    const execSpy = vi.spyOn(mm, 'execCommand')
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ note: '新备注' }) // 面板新增装饰→surface 补丁进引擎
    expect(execSpy.mock.calls[0]![0]).toBe('SET_NODE_DATA')
    expect(execSpy.mock.calls[0]![1]).toBe(nodeA)
    expect((execSpy.mock.calls[0]![2] as Record<string, unknown>).note).toBe('新备注')
    nodeA.data.note = '新备注' // 模拟真引擎 SET_NODE_DATA 落 data（既有手法）
    mm.emit('data_change') // 现态走 engineStateIsSaved 同链比对——extract 产 {note} 须并入 ∉L 键记录
    // 断言①：会话新增装饰必须可见——is-dirty 翻真（红形态一：mergedMeta==meta→闸 2 相等早退→零反馈）
    expect(onDirty).toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
    // 保存 → 断言②：装饰须持久化——记录=字段级并集（note 落盘+style 保留）
    // （红形态二：mindEditor.ts:516 continue 弃置 extract 产物、:527 因 base 记录在不中→note 不落盘）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const rec = parseMindMeta(await blobText(putObject.mock.calls[0]![1] as Blob)).nodeMeta.get(
      buildNodeKey(['根主题', '分支A']),
    )
    expect(rec, '记录仍在场（style 保留面）').toBeDefined()
    expect(rec?.note, '会话新增装饰 note 须落盘（extract 产物不得因键∉L 被整体弃置）').toBe('新备注')
    expect(rec?.style, 'base 字段 style 保留（字段级并集，非 extract 整记录替换）').toEqual({ fillColor: '#f00' })
  })

  it('MC3-V4（P1-1b）case-B 仅非法 image 记录节点会话新增装饰：加 note → is-dirty 翻真 + 保存输出记录并集且非法 image 原样保留（∪ 口径主代理已裁：键∉L 记录 base 字段不因规范化丢失）——现实现预期双红（不翻脏+note 不落盘）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ text: MIND_TEXT_ILLEGAL_IMAGE, putObject })
    // 引擎现态=mount 同链装饰树（仅非法 image 记录 applyRecord warnDrop 零注入——键∉L 前提面）
    const tree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_ILLEGAL_IMAGE)), parseMindMeta(MIND_TEXT_ILLEGAL_IMAGE))
    engine.state.dataTree = tree
    mm.command = {} // 闸 2 内容闸启用（同 P1-1a）
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    const nodeA = tree.children[0]!
    mm.emit('node_active', nodeA, [nodeA])
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ note: '新备注' }) // 链路通道归 P1-1a 例已钉，此处直达缺陷面
    nodeA.data.note = '新备注'
    mm.emit('data_change')
    // 断言①：is-dirty 翻真（红形态一同 P1-1a：闸 2 相等早退零反馈）
    expect(onDirty).toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
    // 保存 → 断言②：记录=字段级并集 {note:'新备注', image:原非法值}——非法 image 保留=∪ 口径
    // 主代理已裁（键∉L 记录 base 字段原样保留；extract 对非法 image 本就零产，保留源=baseRec）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const rec = parseMindMeta(await blobText(putObject.mock.calls[0]![1] as Blob)).nodeMeta.get(
      buildNodeKey(['根主题', '分支A']),
    )
    expect(rec, '记录仍在场').toBeDefined()
    expect(rec?.note, '会话新增装饰 note 须落盘（extract 产物不得因键∉L 被整体弃置）').toBe('新备注')
    expect(rec?.image, '非法 image 原样保留（∪ 口径主代理已裁）').toBe('data:image/png;base64,AAAA')
  })
})

// ═══════════════ MC3c-T 追加块：大纲+搜索接线（新增用例——上方既有用例零字节改动） ═══════════════
// 契约正本：.claude/mind-loop-state.md「MC3c 契约（锁定）」节。大纲纯函数/DOM 工厂与浮条 DOM 行为
// 归 mindOutline.test.ts 直测（浮条工厂自测未在本步范围——覆盖率缺口已汇报主代理）；本块只测
// surface 侧接线。
//
// 【Search 插件 API 实测（node_modules/simple-mind-map@0.14.0-fix.3 src/plugins/Search.js）】
//  - search(text, callback=()=>{})：主入口。text undefined → endSearch()；与上次同文本 →
//    searchNext()（:76-78）＝「下一个」语义；异文本 → 重搜+跳首个匹配
//  - searchNext(callback, index) / jump(index, callback)：定位面（jump=带索引 next）
//  - endSearch()（:95）：结束搜索清态
//  - 事件：search_info_change({currentIndex, total})（:305-309，currentIndex 0 基）；
//    search_match_node_list_change(list)（:91）
//  - Search.instanceName='search'（:323）→ 真引擎 usePlugin(Search) 后实例挂 mm.search
//
// 【断言面裁决（测试侧裁量，实现侧对齐或回本文件改钉）】
//  - mm.search 实例面播种：引擎 mock 不实例化插件（引擎构造器职责）——测试在 mock 实例上播种
//    search spy（seedSearchFace），胶水面=mm.search?.search(...) 防护调用（与 mm.execCommand?.()/
//    mm.command 同口径）；真引擎面=usePlugin 后 mm.search 天然在场
//  - 「下一个」钉 search(同文本) 面（引擎原生 next 语义）；onPrev 面（jump/searchNext 二选一）
//    不钉=实现自由度；行定位钉 GO_TARGET_NODE 命令名（Search.js:190 同款；mock 只录
//    String(args[0])，uid 参数/回调形态不钉）
//  - 搜索浮条钉独立模块 mindSearch.ts（vi.mock('../mindSearch')，工厂名 createMindSearch）：
//    「并入 mindPanel.ts」分支与 MC3b 既有面板桩 mock 面冲突（面板 mock 未导出 createMindSearch
//    → Ctrl+F 落 undefined 崩），故测试侧钉独立文件；浮条 opts={el,t,onSearch,onNext,onPrev,onClose}、
//    api={el,open,close,setCount(current,total),dispose}（记录式桩，DOM 行为归浮条自测）
//  - 大纲切换钮钉容器自有钮（button[data-act='outline']，i18n app.mind-outline.toggle）——
//    **不得进 shared 工具栏**：既有例钉死 .mmx-edt__btn[data-act] 恒等四键，本块附守护断言双保险
//
// 【预期红账（MC3c-T 时点，MC3c-C 未落地）】
//  - Search 注册例：红=usePluginCalls 恰 3 件（Search 未注册）
//  - 大纲例（切换钮/工厂接线/往返/行定位）：红=接线未落地（querySelector null / created 空）
//  - 搜索例（Ctrl+F/交互/关闭/计数/闩锁）：红=接线未落地（created 空 / pd 零调）
//  - ⚠ 既有「usePlugin 恰三件」例（上方 MC2-R2 块）在 MC3c-C 落地 Search 后翻转红=预期——该例钉
//    MC2 批次语义，Search 加入即升级 4 件；清账须由主代理派测试侧修例（MC1-T-fix 先例），
//    本块不越权改既有例（此为 MC3c 契约与 MC2 锁定例的固有点碰，需主代理记账）
import Search from 'simple-mind-map/src/plugins/Search'

// 大纲工厂桩（记录式——面板桩同手法）
const outlineHolder = vi.hoisted(() => {
  const state = {
    created: [] as Array<{
      opts: Record<string, unknown>
      api: { el: HTMLElement; render: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
    }>,
  }
  const createMindOutline = vi.fn((opts: Record<string, unknown>) => {
    const api = { el: document.createElement('div'), render: vi.fn(), show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }
    state.created.push({ opts, api })
    return api
  })
  return { state, createMindOutline }
})
vi.mock('../mindOutline', () => ({ createMindOutline: outlineHolder.createMindOutline }))

// 搜索浮条工厂桩（记录式——同手法）
const searchHolder = vi.hoisted(() => {
  const state = {
    created: [] as Array<{
      opts: Record<string, unknown>
      api: { el: HTMLElement; open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; setCount: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
    }>,
  }
  const createMindSearch = vi.fn((opts: Record<string, unknown>) => {
    const api = { el: document.createElement('div'), open: vi.fn(), close: vi.fn(), setCount: vi.fn(), dispose: vi.fn() }
    state.created.push({ opts, api })
    return api
  })
  return { state, createMindSearch }
})
vi.mock('../mindSearch', () => ({ createMindSearch: searchHolder.createMindSearch }))

/** 大纲切换钮定位（容器自有钮——非 .mmx-edt__btn 集） */
function outlineBtnOf(el: HTMLElement): HTMLButtonElement {
  const b = el.querySelector<HTMLButtonElement>("button[data-act='outline']")
  expect(b, '大纲切换钮（data-act=outline）应在容器子树内').not.toBeNull()
  return b!
}

/** Ctrl+F 派发（el 冒泡——Ctrl+S 例同手法） */
function pressCtrlF(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))
}

/** 在 mock 引擎实例上播种 Search 插件实例面（真引擎=usePlugin 后 mm.search；见块头裁决） */
function seedSearchFace(mm: unknown): { search: ReturnType<typeof vi.fn>; endSearch: ReturnType<typeof vi.fn> } {
  const face = { search: vi.fn(), endSearch: vi.fn() }
  ;(mm as { search?: unknown }).search = face
  return face
}

describe('MC3c 大纲与搜索接线', () => {
  beforeEach(() => {
    outlineHolder.state.created.length = 0
    searchHolder.state.created.length = 0
  })

  it('MC3c Search 注册：usePlugin 恰 7 件（MC3d-T 翻转 4→6；MP2-E1-T 翻转 6→7）、第 4 件 toBe Search（同 specifier 同实例，批内位次不变）、注册先于 constructor', async () => {
    await mount()
    const calls = engine.state.usePluginCalls
    expect(calls, 'MP2-E1 批起恰七件（六件+Export——Drag/Select/KeyboardNavigation/Search/AssociativeLine/OuterFrame/Export）').toHaveLength(7)
    expect(calls[3]).toBe(Search)
    const useIdxs = engine.state.log.map((e, i) => (e === 'usePlugin' ? i : -1)).filter((i) => i >= 0)
    expect(useIdxs).toHaveLength(7)
    expect(useIdxs[3]).toBeLessThan(engine.state.log.indexOf('construct'))
  })

  it('MC3c 大纲切换钮：容器自有钮在场（data-act=outline + i18n app.mind-outline.toggle）；shared 工具栏仍恰四键（守护既有锁定例）', async () => {
    const { el } = await mount()
    const btn = outlineBtnOf(el)
    const face = [btn.getAttribute('title'), btn.getAttribute('aria-label'), btn.textContent].filter(Boolean)
    expect(face, '大纲钮 i18n 面：title/aria-label/textContent 至少一处走 t(app.mind-outline.toggle)').toContain('app.mind-outline.toggle')
    const acts = [...el.querySelectorAll('.mmx-edt__btn[data-act]')].map((b) => b.getAttribute('data-act'))
    expect(acts, 'shared 工具栏四键集不得被大纲钮侵入（既有锁定例红线）').toEqual(['save', 'undo', 'redo', 'reset'])
  })

  it('MC3c 大纲接线：点切换钮 → createMindOutline 恰一次（opts.el=宿主/t/onLocate 函数形态）+ render(rows)=getData 树的扁平模型 + show 被调', async () => {
    const { el } = await mount()
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 数据源=mm.getData() 实时取
    outlineBtnOf(el).click()
    const created = outlineHolder.state.created
    expect(created, '大纲工厂应被 surface 调用').toHaveLength(1)
    expect(created[0]!.opts.el).toBe(el)
    expect(created[0]!.opts.t).toBeInstanceOf(Function)
    expect(created[0]!.opts.onLocate).toBeInstanceOf(Function)
    // 期望值仅用已落地 buildNodeKey 构造（不 import 未落地 outline.ts——红归因=接线面）
    const rows = [
      { key: buildNodeKey(['根主题']), depth: 0, text: '根主题' },
      { key: buildNodeKey(['根主题', '分支A']), depth: 1, text: '分支A' },
      { key: buildNodeKey(['根主题', '分支B']), depth: 1, text: '分支B' },
      { key: buildNodeKey(['根主题', '分支B', '子节点']), depth: 2, text: '子节点' },
    ]
    expect(created[0]!.api.render).toHaveBeenCalledWith(rows)
    expect(created[0]!.api.show).toHaveBeenCalled()
  })

  it('MC3c 大纲往返+实时取：再点=hide；改树后再点=render 收最新树行（每次切换 mm.getData() 实时取）', async () => {
    const { el } = await mount()
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    const btn = outlineBtnOf(el)
    btn.click() // 开
    const { api } = outlineHolder.state.created[0]!
    api.render.mockClear()
    api.hide.mockClear()
    btn.click() // 关
    expect(api.hide).toHaveBeenCalled()
    const edited = toEngineTree(parseMindmap(MIND_TEXT))
    edited.children[0]!.data.text = '分支A改' // 引擎内改名后的现态
    engine.state.dataTree = edited
    btn.click() // 再开
    expect(api.render.mock.calls.length, '再开须重取 getData 渲染').toBeGreaterThanOrEqual(1)
    const last = api.render.mock.calls.at(-1)![0] as Array<{ key: string; text: string }>
    expect(last.some((r) => r.key === buildNodeKey(['根主题', '分支A改']) && r.text === '分支A改')).toBe(true)
    expect(last.some((r) => r.key === buildNodeKey(['根主题', '分支A']))).toBe(false)
  })

  it('MC3c 行定位接线（终评 P2-2 翻转）：无 uid 节点零调——GO_TARGET_NODE 不发、大纲不关（键漂移 best-effort 同口径，不兜底传节点引用）；uid 在场对照面=GO_TARGET_NODE 收 uid 串、定位后关大纲', async () => {
    const { el, mm } = await mount()
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // toEngineTree 产物无 uid
    outlineBtnOf(el).click()
    expect(engine.state.execCommandCalls).toEqual([])
    const created = outlineHolder.state.created[0]!
    const onLocate = created.opts.onLocate as (key: string) => void
    // 零调口径（终评 P2-2）：无 uid → 不发命令、大纲不关（旧「uid ?? found 节点引用兜底」已明令撤销）
    onLocate(buildNodeKey(['根主题', '分支A']))
    expect(engine.state.execCommandCalls, '无 uid 须零调（不得兜底传节点引用）').toEqual([])
    expect(created.api.hide, '零调口径下大纲同样不关（hide 零调）').not.toHaveBeenCalled()
    // 对照面（uid 在场）：命令收 uid 串（非节点实例——引用兜底若复活即在此红）→ 定位后关大纲回画布
    ;(engine.state.dataTree as EngineNode).children[0]!.data.uid = 'uid-branch-a'
    const execSpy = vi.spyOn(mm, 'execCommand')
    onLocate(buildNodeKey(['根主题', '分支A']))
    expect(engine.state.execCommandCalls).toEqual(['GO_TARGET_NODE'])
    expect(execSpy.mock.calls[0]![1], 'P2-2：命令参数=uid 串（节点引用兜底即红）').toBe('uid-branch-a')
    expect(created.api.hide).toHaveBeenCalled()
  })

  it('MC3c Ctrl+F：搜索浮条工厂被调恰一次（opts.el=宿主/t/onSearch/onNext/onPrev/onClose 函数形态）+ open 被调 + preventDefault 拦浏览器查找', async () => {
    const { el } = await mount()
    const pd = vi.spyOn(Event.prototype, 'preventDefault')
    pressCtrlF(el)
    expect(pd, 'Ctrl+F 应拦截浏览器原生查找').toHaveBeenCalled()
    pd.mockRestore()
    const created = searchHolder.state.created
    expect(created, 'Ctrl+F 应创建搜索浮条').toHaveLength(1)
    expect(created[0]!.opts.el).toBe(el)
    for (const k of ['t', 'onSearch', 'onNext', 'onPrev', 'onClose']) {
      expect(created[0]!.opts[k], `opts.${k} 应为函数`).toBeInstanceOf(Function)
    }
    expect(created[0]!.api.open).toHaveBeenCalled()
  })

  it('MC3c 搜索交互接线：onSearch(text) → mm.search.search(text)（实例面播种）；onNext → 同文本再 search（引擎同文本=下一个，Search.js:76-78 实测）', async () => {
    const { el, mm } = await mount()
    const face = seedSearchFace(mm)
    pressCtrlF(el)
    const opts = searchHolder.state.created[0]!.opts
    ;(opts.onSearch as (text: string) => void)('分支')
    expect(face.search).toHaveBeenCalledTimes(1)
    expect(face.search).toHaveBeenCalledWith('分支')
    ;(opts.onNext as () => void)()
    expect(face.search).toHaveBeenCalledTimes(2)
    expect(face.search).toHaveBeenLastCalledWith('分支')
  })

  it('MC3c 浮条关闭接线：opts.onClose() → mm.search.endSearch()（Search.js:95 实测结束面）', async () => {
    const { el, mm } = await mount()
    const face = seedSearchFace(mm)
    pressCtrlF(el)
    ;(searchHolder.state.created[0]!.opts.onClose as () => void)()
    expect(face.endSearch).toHaveBeenCalledTimes(1)
  })

  it('MC3c 计数回传接线：引擎 search_info_change({currentIndex,total}) → 浮条 setCount 原样透传（0 基不换算——显示格式归浮条工厂域）', async () => {
    const { el, mm } = await mount()
    pressCtrlF(el)
    const api = searchHolder.state.created[0]!.api
    api.setCount.mockClear()
    mm.emit('search_info_change', { currentIndex: 1, total: 3 })
    expect(api.setCount).toHaveBeenCalledWith(1, 3)
  })

  it('MC3c readonly 闩锁禁入搜索：4305 后 Ctrl+F 不再开浮条（锁前已开的对照前置=非空洞）', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { el, onReadonly } = await mount({ putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    pressCtrlF(el) // 锁前：开（对照面）
    expect(searchHolder.state.created).toHaveLength(1)
    const api = searchHolder.state.created[0]!.api
    const opens = api.open.mock.calls.length
    saveBtnOf(el).click() // 保存 → putObject 抛 4305 → 闩锁
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1))
    pressCtrlF(el) // 锁后：禁入
    expect(searchHolder.state.created, '闩锁后不得再建浮条').toHaveLength(1)
    expect(api.open.mock.calls.length, '闩锁后不得再开浮条').toBe(opens)
  })
})

// ═══════════════ MC3d-T 追加块：关联线/外框装配收口（新增用例——上方既有用例除两处 usePlugin 计数翻转外零改动） ═══════════════
// 契约正本：.claude/mind-loop-state.md MC3 契约草案关联线条目 + P1-3 裁决（MC3d 独立步 T→C→R）。
// 三处收口：①AssociativeLine+OuterFrame 插件注册（usePlugin 4→6——上方「装配与引擎」「MC3c」
// 两例已同步翻转）②_assoc load 接线（mount 例：applyAssociativeLines 进装配链）③保存链 assoc
// 扩展（extractDecorations().assoc 进 meta 拼接链）。
//
// 【applyAssociativeLines 新纯函数契约（锁定）】frontend/src/apps/mind/decorations.ts 增
//   applyAssociativeLines(tree: EngineNode, meta: MindMeta): EngineNode——不可变新树；
//   meta.assoc.lines 逐条：from/to 键各寻节点（buildNodeKey 同口径），寻到→to 节点 data.uid
//   缺则生成（uid 字面命名域=实现自由度，如 'assoc-uid-'+序号；本块一律自 to 节点读 uid 回填
//   断言，只钉「非空 string」形态不钉字面）→from 节点 data.associativeLineTargets=[…既有,新
//   uid]+data.associativeLineText（text 非空时 {[uid]:text}，缺省不建该字段）；键解析不到→
//   丢线+console.warn（逐线粒度，可解析线不受牵连）；_mindview/_assoc 之外 meta 不二次注入
//   （装饰已由 applyDecorations 处理——data.note 等不在本函数职责面）。
//
// 【预期红账（MC3d-T 时点，MC3d-C 未落地）】
//  - 纯函数 9 例 + mount 2 例：红=decorations.ts 尚无该导出（动态取用 undefined → 调用点
//    TypeError「applyAssoc is not a function」——断言面未触达即抛，归因纯接线面）。
//  - 保存链 3 例：「往返」例 setup 即抛（同上）；「会话新画」「合并」两例 setup 手挂不依赖新
//    函数、红=保存输出 _assoc 行缺线（extract.assoc 无消费者）。
//  - 两处 usePlugin 翻转例红=实现仍注册 4 件（4≠6）。
//
// 【动态取用裁决】applyAssociativeLines 以 await import 动态取用而非静态具名 import——
// decorations.ts 在盘且被既有例静态 import（applyDecorations），不可 vi.mock 整模块；vitest 4
// 对静态具名 import 的缺失导出于模块期抛 SyntaxError 连坐全文件既有例（「既有例零回归」红线），
// 动态 import 命名空间属性访问缺导出=undefined 不抛，红面精确收敛到本区段。
type ApplyAssocFn = (tree: EngineNode, meta: MindMeta) => EngineNode
async function loadApplyAssoc(): Promise<ApplyAssocFn> {
  const mod = (await import('../../mind/decorations')) as unknown as { applyAssociativeLines?: ApplyAssocFn }
  return mod.applyAssociativeLines as ApplyAssocFn
}

/** MC3d 追加夹具：文件 meta 含 _assoc 双线（A→B 带 text、B→根主题 无 text）——正文无子节点叶
 *  以简化孩子索引；meta 行序=canonical 写序（schema → _assoc → 节点行） */
const MIND_TEXT_ASSOC = [
  'mindmap',
  '%% meta: schema=v1',
  '%% meta: _assoc {"lines":[{"from":"根主题/分支A","to":"根主题/分支B","text":"相关"},{"from":"根主题/分支B","to":"根主题"}]}',
  '  根主题',
  '    分支A',
  '    分支B',
].join('\n')

/** MC3d 追加夹具：_assoc 单线（带 text）+ 节点 meta 行（分支A note）并存——mount 装饰/关联线
 *  双通道共存例用 */
const MIND_TEXT_ASSOC_MIX = [
  'mindmap',
  '%% meta: schema=v1',
  '%% meta: _assoc {"lines":[{"from":"根主题/分支A","to":"根主题/分支B","text":"相关"}]}',
  '%% meta: 根主题/分支A {"note":"旧注"}',
  '  根主题',
  '    分支A',
  '    分支B',
].join('\n')

/** 手工 MindMeta（仅 assoc 通道；decorations.test.ts metaOf 同手法——schema/mindview 置空） */
function metaWithAssoc(lines: Array<{ from: string; to: string; text?: string }>): MindMeta {
  return { schema: null, mindview: null, assoc: { lines }, nodeMeta: new Map() }
}

/** lines 键规范化（from/to/text 拼串排序）——键集合比较面（行序契约不钉） */
function normLines(lines: Array<{ from: string; to: string; text?: string }>): string[] {
  return lines.map((l) => `${l.from}\u0000${l.to}\u0000${l.text ?? ''}`).sort()
}

describe('MC3d 关联线/外框装配收口', () => {
  // ───────────────────── applyAssociativeLines 纯函数装配 ─────────────────────

  it('MC3d 单线装配：meta.assoc 一条线 → 新树 from 节点 data.associativeLineTargets=[to 新 uid] 且 to 节点 data.uid 为非空 string（uid 缺则生成）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const result = applyAssoc(tree, metaWithAssoc([{ from: '根主题/分支A', to: '根主题/分支B' }]))
    const a = result.children[0]!
    const b = result.children[1]!
    expect(typeof b.data.uid, 'to 节点 uid 缺则须生成（非空 string）').toBe('string')
    expect(b.data.uid as string).not.toBe('')
    expect(a.data.associativeLineTargets, 'from 节点 targets=[to 节点 uid]').toEqual([b.data.uid])
  })

  it('MC3d 线文本注入：text 非空 → from 节点 data.associativeLineText={[toUid]:text}（引擎实测存储形态 AssociativeLine.js hideEditTextBox）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const result = applyAssoc(tree, metaWithAssoc([{ from: '根主题/分支A', to: '根主题/分支B', text: '相关' }]))
    const uid = result.children[1]!.data.uid
    expect(typeof uid).toBe('string')
    expect(result.children[0]!.data.associativeLineText).toEqual({ [uid as string]: '相关' })
  })

  it('MC3d 线文本缺省：text 缺省 → 不建 associativeLineText 字段（键不在 from 节点 data——引擎空文本存空串不落 meta 同口径）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const result = applyAssoc(tree, metaWithAssoc([{ from: '根主题/分支A', to: '根主题/分支B' }]))
    expect('associativeLineText' in result.children[0]!.data).toBe(false)
  })

  it('MC3d 双线同 from：两条线同源 → targets 恰两 uid 且按 lines 行序追加（[…既有,新 uid]）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const result = applyAssoc(
      tree,
      metaWithAssoc([
        { from: '根主题/分支A', to: '根主题/分支B' },
        { from: '根主题/分支A', to: '根主题' },
      ]),
    )
    expect(result.children[0]!.data.associativeLineTargets).toEqual([
      result.children[1]!.data.uid, // 第一线→分支B
      result.data.uid, // 第二线→根主题（根节点 uid 同法生成）
    ])
  })

  it('MC3d 键漂移丢线：from 键解析不到 → 丢线+console.warn+树零污染（result 深等入参树=结构不变、零 targets 注入）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = applyAssoc(tree, metaWithAssoc([{ from: '根主题/不存在', to: '根主题/分支B' }]))
    expect(warn, '丢线须 warn（MC3a-T 裁决⑥口径）').toHaveBeenCalled()
    expect(result).toEqual(tree)
  })

  it('MC3d 丢线逐线粒度：不可解析线不牵连带内可解析线（P2-4 字段级口径）——同批两线一丢一装配', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = applyAssoc(
      tree,
      metaWithAssoc([
        { from: '根主题/不存在', to: '根主题/分支B' },
        { from: '根主题/分支A', to: '根主题/分支B' },
      ]),
    )
    expect(warn.mock.calls.length, '丢线侧至少一线 warn（每次一线=实现自由度不钉）').toBeGreaterThanOrEqual(1)
    expect(result.children[0]!.data.associativeLineTargets, '可解析线照常装配').toEqual([result.children[1]!.data.uid])
  })

  it('MC3d 不可变：入参树毫发无伤（深等调用前快照）+ 产出新树（根与 from/to 节点 data 对象均非原引用——uid/targets 注入不原地）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const before = JSON.parse(JSON.stringify(tree)) as EngineNode
    const result = applyAssoc(tree, metaWithAssoc([{ from: '根主题/分支A', to: '根主题/分支B' }]))
    expect(result).not.toBe(tree)
    expect(tree).toEqual(before)
    expect(result.children[0]!.data).not.toBe(tree.children[0]!.data)
    expect(result.children[1]!.data).not.toBe(tree.children[1]!.data)
  })

  it('MC3d 通道不二次注入：meta.nodeMeta 装饰记录不在本函数职责面（data.note 不注入——装饰已由 applyDecorations 处理），assoc 通道照常装配', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const meta = metaWithAssoc([{ from: '根主题/分支A', to: '根主题/分支B' }])
    meta.nodeMeta.set('根主题/分支A', { note: '旧注' })
    const result = applyAssoc(tree, meta)
    expect(result.children[0]!.data.note, '装饰通道不二次注入').toBeUndefined()
    expect(result.children[0]!.data.associativeLineTargets).toEqual([result.children[1]!.data.uid])
  })

  it('MC3d 往返：applyAssociativeLines → extractDecorations 的 assoc.lines 与输入 lines 键集合一致（from/to/text 三元组；text 非空行存活、无文本行缺省形态）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const lines = [
      { from: '根主题/分支A', to: '根主题/分支B', text: '相关' },
      { from: '根主题/分支B', to: '根主题' },
    ]
    const ex = extractDecorations(applyAssoc(tree, metaWithAssoc(lines)))
    expect(normLines(ex.assoc.lines)).toEqual(normLines(lines))
  })

  // ───────────────────── 保存链 assoc 整合 ─────────────────────

  it('MC3d 保存链 assoc 往返：文件 _assoc 行+引擎树经 applyAssociativeLines 注入 → 保存输出 _assoc 行恰一次且 lines 键集合与文件一致（load→save 键往返零漂移；load 回注线经 extract 同键，禁拼接双发射）', async () => {
    const applyAssoc = await loadApplyAssoc()
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ text: MIND_TEXT_ASSOC, putObject })
    const meta = parseMindMeta(MIND_TEXT_ASSOC)
    expect(meta.assoc?.lines, '前置：文件 _assoc 双线在案').toHaveLength(2)
    engine.state.dataTree = applyAssoc(toEngineTree(parseMindmap(MIND_TEXT_ASSOC)), meta) // load 接线后的引擎现态形态
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    const parsed = parseMindMeta(out)
    expect(parsed.assoc, '文件 _assoc 行经保存链存活').not.toBeNull()
    expect(normLines(parsed.assoc!.lines), 'lines 键集合与文件一致（键往返零漂移，text 存活）').toEqual(normLines(meta.assoc!.lines))
    expect((out.match(/%% meta: _assoc/g) ?? []).length, '_assoc 恰一次（禁文件⊕extract 双发射）').toBe(1)
  })

  it('MC3d 保存链 assoc 扩展：会话新画关联线（mock 树手挂 targets+uid+线文本）→ 保存输出 _assoc 行含新线 from/to 键+text（extract.assoc 进拼接链消费者）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ text: MIND_TEXT, putObject })
    const tree = toEngineTree(parseMindmap(MIND_TEXT))
    const a = tree.children[0]!
    const b = tree.children[1]!
    b.data.uid = 'uid-b' // 会话内引擎已分配 uid 的形态（手挂；uid 字面不入 meta——键才是持久面）
    a.data.associativeLineTargets = ['uid-b']
    a.data.associativeLineText = { 'uid-b': '新线文本' }
    engine.state.dataTree = tree
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const parsed = parseMindMeta(await blobText(putObject.mock.calls[0]![1] as Blob))
    expect(parsed.assoc?.lines, '会话新线须持久化（含线文本）').toEqual([
      { from: buildNodeKey(['根主题', '分支A']), to: buildNodeKey(['根主题', '分支B']), text: '新线文本' },
    ])
  })

  it('MC3d 保存链 assoc 合并：文件线（load 回挂形态）⊕ 会话新线 → 输出 lines 键集合=三线并集、_assoc 恰一次（同键禁双发射）、线文本存活', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ text: MIND_TEXT_ASSOC, putObject })
    const tree = toEngineTree(parseMindmap(MIND_TEXT_ASSOC))
    const a = tree.children[0]!
    const b = tree.children[1]!
    b.data.uid = 'uid-b'
    tree.data.uid = 'uid-root'
    a.data.associativeLineTargets = ['uid-b', 'uid-root'] // [文件线回挂, 会话新画 A→根主题]
    a.data.associativeLineText = { 'uid-b': '相关' }
    b.data.associativeLineTargets = ['uid-root'] // 文件线回挂（B→根主题）
    engine.state.dataTree = tree
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    const parsed = parseMindMeta(out)
    expect(parsed.assoc, '合并后 _assoc 行在场').not.toBeNull()
    expect(normLines(parsed.assoc!.lines), '文件两线+会话新线=并集（键往返一致）').toEqual(
      normLines([
        { from: '根主题/分支A', to: '根主题/分支B', text: '相关' },
        { from: '根主题/分支B', to: '根主题' },
        { from: '根主题/分支A', to: '根主题' },
      ]),
    )
    expect((out.match(/%% meta: _assoc/g) ?? []).length, '恰一次（load 回挂线与文件线同键，禁双发射）').toBe(1)
  })

  // ───────────────────── mount 装配接线（_assoc load） ─────────────────────

  it('MC3d mount 装配接线：文件 _assoc 行 → opt.data 分支A data.associativeLineTargets=[分支B uid]（applyAssociativeLines 进 mount 链——与 applyDecorations 同位或其后，两序组合深等价故序不钉）', async () => {
    const applyAssoc = await loadApplyAssoc()
    await mount({ text: MIND_TEXT_ASSOC })
    const opt = engine.state.lastOpt!
    const meta = parseMindMeta(MIND_TEXT_ASSOC)
    // 期望值=同链构造（组合序自由度：decorations→assoc 或 assoc→decorations 产物深等价——两通道键域不相交）
    expect(opt.data).toEqual(applyAssoc(applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_ASSOC)), meta), meta))
    const a = (opt.data as EngineNode).children[0]!
    const b = (opt.data as EngineNode).children[1]!
    expect(typeof b.data.uid, 'to 节点 uid 生成').toBe('string')
    expect(a.data.associativeLineTargets, 'from 节点 targets 在场').toEqual([b.data.uid])
  })

  it('MC3d mount 双通道共存：_assoc 线（带 text）+节点 meta 行（分支A note）→ opt.data 分支A 装饰与关联线字段并存（associativeLineText 在场）', async () => {
    const applyAssoc = await loadApplyAssoc()
    await mount({ text: MIND_TEXT_ASSOC_MIX })
    const opt = engine.state.lastOpt!
    const meta = parseMindMeta(MIND_TEXT_ASSOC_MIX)
    expect(opt.data).toEqual(applyAssoc(applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_ASSOC_MIX)), meta), meta))
    const a = (opt.data as EngineNode).children[0]!
    const b = (opt.data as EngineNode).children[1]!
    expect(a.data.note, '装饰通道照常注入').toBe('旧注')
    expect(a.data.associativeLineTargets).toEqual([b.data.uid])
    expect(a.data.associativeLineText, '线文本随装配注入').toEqual({ [b.data.uid as string]: '相关' })
  })
})

// ═══════════════ MP1-T 追加块：多布局/主题切换 UI（视图态会话切换+持久化）——测试先行，预期红 ═══════════════
// 契约正本：docs/design/mind-editor-redesign/plan.md §四（_mindview {layout,theme} 视图态伪节点，
// :61 字节形态示例 layout-first）+ §五（布局 7 枚举 logicalStructure/mindMap/organizationStructure/
// fishbone/timeline/verticalTimeline/catalogOrganization；主题 xm-green/xm-blue/xm-slate/xm-amber
// ——themes.ts MIND_THEMES 已注册，mount 期 defineTheme 全量上册）。主代理裁决：布局切换 7 项+
// 主题切换 4 项同批（同 _mindview 通道同 UI 面；P2「主题样式面板」=自定义色线型，与本批选择器不重叠）。
//
// 【MP1-T 引擎运行时切换 API 勘察（node_modules/simple-mind-map 实证，0.14.0-fix.3）】
//  - setLayout(layout, notRender=false)：index.js:436-445——opt.layout 赋值（非法值经
//    layoutValueList 校验回退 LOGICAL_STRUCTURE，src/constants/constant.js:157-172——本批 7 枚举
//    全部在册）→ view.reset() → renderer.setLayout() → render(null, CHANGE_LAYOUT) →
//    emit('layout_change', layout)。
//  - setTheme(theme, notRender=false)：index.js:379-388——opt.theme 赋值 → render(null,
//    CHANGE_THEME) → emit('view_theme_change', theme)（未注册主题回退 theme.default，initTheme
//    index.js:371——本批 4 主题 mount 期已注册，切换值恒命中）。
//  - 副作用事件：两 API 均不 emit data_change——引擎 data_change 发射点仅 src/core/render/
//    Render.js:752（backForward=undo/redo 路径）与 src/core/command/Command.js:127（addHistory=
//    execCommand 命令链），setLayout/setTheme 路径均不经过。getter 面：getLayout() index.js:431 /
//    getTheme() index.js:389。
//  - 【dirty 口径裁决=业务侧显式标脏】「切换即 dirty」不依赖引擎事件（引擎无 data_change 侧信道
//    可蹭），钉 glue 切换处理器显式 onDirty(true)（例3/例4 直接断言 onDirty 收 true；种子面照真
//    引擎 emit layout_change/view_theme_change——若实现反走 data_change 通道即红=钉生效）。
//
// 【mock 种子面 seedViewFace】FakeMindMap 类缺省无 setLayout/getLayout/getTheme（setTheme 有类方法
// 但不回写 opt）——按真引擎语义在实例上播种（MC3c seedSearchFace 同手法，类体零改动=既有例零回归）：
// setLayout/setTheme=记录首参+回写 this.opt.layout/theme+emit 真引擎同名事件；getLayout/getTheme=
// 读 opt（真引擎 :431/:389 同义）。播种后实现侧「会话变量跟踪」与「引擎 getter 读回」两种形态皆可达，
// 持久化例不因 mock 缺面假红。
//
// 【DOM 形态钉（测试侧裁量，实现侧对齐或回本文件改钉）】切换器=<select data-act='layout'|'theme'>，
// 容器自有条 .mmagic-mind__bar 内（与大纲钮 data-act='outline' 同族，不进 shared 工具栏——
// .mmx-edt__btn[data-act] 恒四键锁定例双保险断言）；选项=<option value=枚举值>，文本=t(选项键)；
// 键系：控件 aria-label=app.mind-view.layout / app.mind-view.theme，选项键=app.mind-view.layout.<枚举>/
// app.mind-view.theme.<枚举>（7+4，locales 待 MP1-C 落地）；现态回显=select.value 镜像 mount 现效值
// （无 _mindview=缺省 logicalStructure/xm-green，有=按 meta 值）。
//
// 【持久化字节形态钉】会话切换后保存 → _mindview 记录={layout,theme} 双字段完整形态（plan.md §四
// :73 表格；无 meta 文件 theme 落缺省 xm-green、有 meta 文件未切换字段沿会话现效值保留）；
// JSON 串 layout-first 键序=plan.md :61 示例+MIND_TEXT_META 夹具同形。
//
// 【预期红账（MP1-T 时点，MP1-C 未落地）】
//  - 例1/2（DOM）/例3/4（切换行为）/例5/6（持久化）/例8（A→B→A）：红=切换器缺位（querySelector
//    null → 定位器 expect 抛，断言面未触达即红，归因纯 UI 面）；深层归因：实现侧 mergedMeta
//    mindview 通道仍沿文件原值（mindEditor.ts:558 `mindview: meta.mindview`），会话切换无消费者。
//  - 例7（零 diff）：绿=守卫例（纯既有链零 UI 面）——MP1-C 重写 mergedMeta 视图态通道时的
//    回归哨兵（防「挂载即合成缺省行/切换态泄漏」破未编辑零 diff 红线，mindEditor.ts:29 头注同源）。
//  - 既有 68 例零改动（本块全量追加：helpers+describe 挂文件尾）。

/** 视图态切换器定位（容器自有控件——select[data-act]，非 .mmx-edt__btn 集；outlineBtnOf 同手法） */
function mindViewSelectOf(el: HTMLElement, act: 'layout' | 'theme'): HTMLSelectElement {
  const s = el.querySelector<HTMLSelectElement>(`select[data-act='${act}']`)
  expect(s, `视图态切换器 select[data-act=${act}] 应在容器子树内（MP1 DOM 契约）`).not.toBeNull()
  return s!
}

/** 切换派发：置值 + change 事件（jsdom 标准面——实现侧 addEventListener('change') 落点） */
function dispatchViewChange(sel: HTMLSelectElement, value: string): void {
  sel.value = value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 真引擎切换 API 实例面播种（真引擎语义：首参记录+opt 回写+同名事件 emit；见块头勘察注） */
function seedViewFace(mm: unknown): { setLayout: ReturnType<typeof vi.fn>; setTheme: ReturnType<typeof vi.fn> } {
  const face = mm as { opt: Record<string, unknown>; emit: (ev: string, ...args: unknown[]) => void }
  const setLayout = vi.fn((layout: string) => {
    face.opt.layout = layout
    face.emit('layout_change', layout)
  })
  const setTheme = vi.fn((theme: string) => {
    face.opt.theme = theme
    face.emit('view_theme_change', theme)
  })
  face.setLayout = setLayout
  face.setTheme = setTheme
  ;(mm as unknown as Record<string, unknown>).getLayout = () => face.opt.layout
  ;(mm as unknown as Record<string, unknown>).getTheme = () => face.opt.theme
  return { setLayout, setTheme }
}

describe('MP1 多布局/主题切换 UI（视图态会话切换+持久化）', () => {
  it('MP1 布局切换器 DOM：select[data-act=layout] 在容器自有条内（大纲钮同族）+7 选项枚举齐序（plan §五）+i18n 面（aria-label=app.mind-view.layout+选项文本 t(布局键)）+现态回显（无 meta=logicalStructure、_mindview fishbone 文件=fishbone）+shared 工具栏四键集不被侵入', async () => {
    const { el } = await mount()
    const sel = mindViewSelectOf(el, 'layout')
    expect(sel.closest('.mmagic-mind__bar'), '容器自有条内（与大纲钮同族，非 shared 工具栏）').not.toBeNull()
    expect([...sel.options].map((o) => o.value), '7 布局枚举齐序（plan §五）').toEqual([
      'logicalStructure',
      'mindMap',
      'organizationStructure',
      'fishbone',
      'timeline',
      'verticalTimeline',
      'catalogOrganization',
    ])
    expect([sel.getAttribute('aria-label'), sel.getAttribute('title')].filter(Boolean), '控件 i18n 面：aria-label/title 至少一处走 t(app.mind-view.layout)').toContain('app.mind-view.layout')
    for (const o of [...sel.options]) {
      expect(o.textContent, `选项 ${o.value} i18n 标签经 t() 注入`).toBe(`app.mind-view.layout.${o.value}`)
    }
    expect(sel.value, '现态回显：无 _mindview 文件=缺省 logicalStructure').toBe('logicalStructure')
    const acts = [...el.querySelectorAll('.mmx-edt__btn[data-act]')].map((b) => b.getAttribute('data-act'))
    expect(acts, 'shared 工具栏四键集不得被切换器侵入（既有锁定例红线双保险）').toEqual(['save', 'undo', 'redo', 'reset'])
    // meta 文件回显（_mindview fishbone → select 现态镜像）
    const metaMount = await mount({ text: MIND_TEXT_META })
    expect(mindViewSelectOf(metaMount.el, 'layout').value, '现态回显：_mindview.layout=fishbone 文件=fishbone').toBe('fishbone')
  })

  it('MP1 主题切换器 DOM：select[data-act=theme] +4 选项枚举齐序（xm-green/xm-blue/xm-slate/xm-amber）+i18n 面（app.mind-view.theme+主题键）+现态回显（无 meta=xm-green、meta 文件=xm-blue）', async () => {
    const { el } = await mount()
    const sel = mindViewSelectOf(el, 'theme')
    expect(sel.closest('.mmagic-mind__bar'), '容器自有条内').not.toBeNull()
    expect([...sel.options].map((o) => o.value), '4 主题枚举齐序（plan §五/themes.ts 注册序）').toEqual(['xm-green', 'xm-blue', 'xm-slate', 'xm-amber'])
    expect([sel.getAttribute('aria-label'), sel.getAttribute('title')].filter(Boolean), '控件 i18n 面').toContain('app.mind-view.theme')
    for (const o of [...sel.options]) {
      expect(o.textContent, `选项 ${o.value} i18n 标签经 t() 注入`).toBe(`app.mind-view.theme.${o.value}`)
    }
    expect(sel.value, '现态回显：无 _mindview 文件=缺省 xm-green').toBe('xm-green')
    const metaMount = await mount({ text: MIND_TEXT_META })
    expect(mindViewSelectOf(metaMount.el, 'theme').value, '现态回显：_mindview.theme=xm-blue 文件=xm-blue').toBe('xm-blue')
  })

  it('MP1 布局切换行为：选 fishbone → 引擎 setLayout 首参收 fishbone（index.js:436 面）+ onDirty(true)（业务侧显式标脏——引擎切换路径无 data_change，见块头 dirty 口径裁决）', async () => {
    const { el, mm, onDirty } = await mount()
    const { setLayout } = seedViewFace(mm)
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'fishbone')
    expect(setLayout.mock.calls.length, '引擎切换 API 须被调').toBeGreaterThanOrEqual(1)
    expect(setLayout.mock.calls[0]![0], '首参=fishbone（notRender 等附加参不钉=实现自由度）').toBe('fishbone')
    expect(onDirty).toHaveBeenCalledWith(true)
  })

  it('MP1 主题切换行为：选 xm-slate → 引擎 setTheme 首参收 xm-slate（index.js:379 面）+ onDirty(true)（同上业务侧显式标脏口径）', async () => {
    const { el, mm, onDirty } = await mount()
    const { setTheme } = seedViewFace(mm)
    dispatchViewChange(mindViewSelectOf(el, 'theme'), 'xm-slate')
    expect(setTheme.mock.calls.length, '引擎切换 API 须被调').toBeGreaterThanOrEqual(1)
    expect(setTheme.mock.calls[0]![0], '首参=xm-slate').toBe('xm-slate')
    expect(onDirty).toHaveBeenCalledWith(true)
  })

  it('MP1 持久化（新增行）：无 _mindview 文件切 layout=fishbone → 保存输出含 _mindview 行 {layout:fishbone,theme:xm-green} 双字段完整形态（theme=缺省值；字节形态 layout-first 键序）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm } = await mount({ text: MIND_TEXT, putObject })
    seedViewFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 正文未编辑
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'fishbone')
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(parseMindMeta(out).mindview, '双字段完整形态（plan §四 :73；theme 落 mount 缺省值）').toEqual({ layout: 'fishbone', theme: 'xm-green' })
    expect(out, '字节形态 layout-first（plan :61 示例同形）').toContain('%% meta: _mindview {"layout":"fishbone","theme":"xm-green"}')
    expect((out.match(/%% meta: _mindview/g) ?? []).length, '恰一次（拼接唯一性同既有例口径）').toBe(1)
  })

  it('MP1 持久化（保字段）：_mindview{fishbone,xm-blue} 文件切 layout=timeline → 保存行 layout=timeline 且 theme=xm-blue 保留（未切换字段沿会话现效值不丢）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm } = await mount({ text: MIND_TEXT_META, putObject })
    seedViewFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META)) // 正文未编辑
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'timeline')
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(parseMindMeta(out).mindview, 'layout 更新+theme 保留').toEqual({ layout: 'timeline', theme: 'xm-blue' })
    expect(out).toContain('%% meta: _mindview {"layout":"timeline","theme":"xm-blue"}')
    expect(out).toContain('%% meta: schema=v1')
  })

  it('MP1 零 diff 不变式（守卫例，当前绿）：含 _mindview 文件未编辑（不切换）保存 → 字节级零 diff（_mindview 行沿文件原值原位重发——mergedMeta 视图态通道 MP1-C 重写时的回归哨兵）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm } = await mount({ text: MIND_TEXT_META, putObject })
    seedViewFace(mm) // 真引擎 getter 面常驻（getLayout/getTheme 读回文件原值，不制造 diff）
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META))
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    // 未编辑保存=canonical 重发（meta 行按 writeMetaBlock 产物插 header 后——既有例「save 含 meta 源」同钉），
    // 逐字节相等=零 diff 红线（禁合成缺省行/禁切换态泄漏）
    const metaLines = writeMetaBlock(parseMindMeta(MIND_TEXT_META))
    expect(out.split('\n')).toEqual(['mindmap', ...metaLines, '  根主题', '    分支A'])
  })

  it('MP1 切换回来（幂等）：A(fishbone)→B(timeline)→A 保存输出与未切换保存字节一致（dirty 标志可能残留 true 属可接受——断言只钉字节）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm } = await mount({ text: MIND_TEXT_META, putObject })
    seedViewFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META))
    const sel = mindViewSelectOf(el, 'layout')
    dispatchViewChange(sel, 'timeline') // A→B
    dispatchViewChange(sel, 'fishbone') // B→A
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    const metaLines = writeMetaBlock(parseMindMeta(MIND_TEXT_META))
    expect(out.split('\n')).toEqual(['mindmap', ...metaLines, '  根主题', '    分支A'])
  })
})

// ═══════════════ MP2-X1-T 追加块：.xmind 导入（zip+content.json 逃生舱）——测试先行，预期红 ═══════════════
// 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2 生态「.xmind 导入（zip+content.json，
// 逃生舱；仓内 zip 经验可复用）」+ §四 D1 主存不动（导入产物=mermaid mindmap 文本）。
// 纯函数面（xmindToMindmap/content.json schema/zip 依赖盘点）归 mind/__tests__/xmindImport.test.ts
// 块头注记（权威勘察正本），本块只钉编辑器装配面与行为链。
//
// 【MP2-X1-T 勘察三：导入入口形态（实证）】容器自有条 .mmagic-mind__bar 内追加导入钮
// button[data-act='xmind-import']（与大纲钮/MP1 两 select/MP2-E1 导出 select 同族——不进
// shared 工具栏 .mmx-edt__btn 四键集，锁定例双保险断言随 DOM 例）+隐藏 file input
// <input type='file' accept='.xmind'>（隐藏机制不钉=display:none/hidden 属性皆可；钮点击
// →input.click() 打开选择器=jsdom 面 click spy 断言锚）。i18n 键系=钮 text/aria-label 走
// t('app.mind-import.do')（mind-export.do 命名族同构；locales 落地归 MP2-X1-C）。
//
// 【导入语义（主代理裁决：编辑器面导入=替换现内容走 dirty 保存链，不做上传链改造）】
// 显式用户动作链：input change → file.arrayBuffer → unzip（选型建议 fflate unzipSync，
// frontend dependencies 既有 0.8.3——零新依赖，安装归 C）→ content.json JSON.parse →
// xmindToMindmap（mind/xmindImport.ts，契约=xmindImport.test.ts）→ parseMindmap →
// toEngineTree → mm.setData(tree)+显式 markDirty（引擎 setData 无 data_change 侧信道——
// MP1 视图态切换「业务侧显式承担脏标」同族口径）→ 保存链落盘替换现文件（putObject 覆写
// 同 key）。⚠ setData 收引擎树非文本串：mindEditor.ts resetToSaved 同面实证
// `mm.setData(applyAssociativeLines(applyDecorations(toEngineTree(base), meta), meta))`（:889）
// ——真引擎 setData API=nodeTree 形态；断言以 toEngineTree(parseMindmap(期望文本)) 等价树钉
// 语义（偏离任务 prompt「setData 收 mermaid 文本」字面，如实注记）。
//
// 【mock/桩面】zip 真跑：jsdom 下 fflate 纯 JS 同步可用——测试用 zipSync 造真 .xmind zip
// 字节（content.json+metadata.json 双 entry），File 桩携带真 zip；实现侧任何标准 unzip 库
// 皆可读=桩不锁选型。file input 注入=Object.defineProperty(input,'files',{value:[file]})
// +dispatchEvent(change)（fc-drop-zone.test.ts 同手法，jsdom 无 DataTransfer 构造器）。
// 引擎 mock 零改动（FakeMindMap setData/getData 既有面够用）；飞行等待=vi.waitFor setData
// 到位（change 处理链 arrayBuffer/unzip 异步跳数不定）。
//
// 【预期红账（MP2-X1-T 时点，MP2-X1-C 未落地）】三例全红=定位器 expect 抛（导入钮
// button[data-act=xmind-import]/file input 缺位——断言面未触达，归因纯 UI 面；zip 造包/
// seed 面就绪不构成假红）；纯函数面红=xmindImport.test.ts import 解析失败整文件红（归因
// 纯函数未落地）。readonly 闩锁×导入交互（只读态导入钮禁用与否）本批不钉=实现裁量注记
// （导入=数据写路径，与 MP1「纯视图态零写路径不闩」不可类比）；xmind8 content.xml 旧版
// 解析面本批不钉；notes/href/labels 等超集字段搬运面本批不钉。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { zipSync } from 'fflate'

/** 引擎自产形态造 topic（schema 权威摘要=xmindImport.test.ts 块头注记） */
function mkXmindTopic(title: string, attached: unknown[] = []): Record<string, unknown> {
  return { id: `topic-${title}`, structureClass: 'org.xmind.ui.logic.right', title, children: { attached } }
}

/** 引擎自产形态造 sheet（根 topic 带 class:'topic'——ExportXMind isRoot 分支实证） */
function mkXmindSheet(root: Record<string, unknown>): Record<string, unknown> {
  return { id: 'sheet-1', class: 'sheet', title: '导入稿', extensions: [], rootTopic: { ...root, class: 'topic' } }
}

/** 真 .xmind zip 字节（fflate zipSync——标准 zip 任何 unzip 库皆可读，桩不锁实现选型） */
function mkXmindZip(contentJson: unknown): Uint8Array {
  return zipSync({
    'content.json': new TextEncoder().encode(JSON.stringify(contentJson)),
    'metadata.json': new TextEncoder().encode('{}'),
  })
}

/** 导入钮定位（容器自有 button[data-act=xmind-import]——mindViewSelectOf 同手法） */
function xmindImportBtnOf(el: HTMLElement): HTMLButtonElement {
  const b = el.querySelector<HTMLButtonElement>("button[data-act='xmind-import']")
  expect(b, "导入钮 button[data-act=xmind-import] 应在容器子树内（MP2-X1 DOM 契约）").not.toBeNull()
  return b!
}

/** 隐藏 file input 定位（accept=.xmind——MP2-X1 DOM 契约） */
function xmindInputOf(el: HTMLElement): HTMLInputElement {
  const i = el.querySelector<HTMLInputElement>("input[type='file'][accept='.xmind']")
  expect(i, "隐藏 file input[type=file][accept=.xmind] 应在容器子树内（MP2-X1 DOM 契约）").not.toBeNull()
  return i!
}

/** 导入派发：files 注入 + change 事件（fc-drop-zone.test.ts 同手法——jsdom 无 DataTransfer） */
function dispatchXmindImport(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('MP2-X1 .xmind 导入（zip+content.json 逃生舱）', () => {
  it('MP2-X1 导入钮 DOM：button[data-act=xmind-import] 在容器自有条内（导出 select 同族）+隐藏 file input[type=file][accept=.xmind]+钮点击→input.click()（选文件入口）+i18n 面（text/aria-label 走 t(app.mind-import.do)）+shared 工具栏四键集不被侵入', async () => {
    const { el } = await mount()
    const btn = xmindImportBtnOf(el)
    expect(btn.closest('.mmagic-mind__bar'), '容器自有条内（与大纲钮/导出 select 同族，非 shared 工具栏）').not.toBeNull()
    const input = xmindInputOf(el)
    const clickSpy = vi.fn()
    Object.defineProperty(input, 'click', { value: clickSpy, configurable: true })
    btn.click()
    expect(clickSpy, '钮=选文件入口：点击须触发 file input click（打开选择器）').toHaveBeenCalledTimes(1)
    expect([btn.getAttribute('aria-label'), btn.textContent].filter(Boolean), '控件 i18n 面：text/aria-label 至少一处走 t(app.mind-import.do)').toContain('app.mind-import.do')
    const acts = [...el.querySelectorAll('.mmx-edt__btn[data-act]')].map((b) => b.getAttribute('data-act'))
    expect(acts, 'shared 工具栏四键集不得被导入钮侵入（既有锁定例红线双保险）').toEqual(['save', 'undo', 'redo', 'reset'])
  })

  it('MP2-UI 工具栏美化：三容器钮 icon 化（svg 在场，文案不占版面——「字体太大」收敛）+title/aria 双通道走原 i18n 键（悬浮提示补齐）+sep 分隔两枚（统一钮簇｜视图态｜内容）+导出 select DOM 序位于内容组之后（margin-left:auto 推条右端——「下载要最右」口径钉）', async () => {
    const { el } = await mount()
    const bar = el.querySelector('.mmagic-mind__bar')
    expect(bar, '工具栏条在场').not.toBeNull()
    // 三钮 icon 化：svg 在场 + title/aria 双通道（悬浮提示+读屏同文案——「没有标题」收敛）
    for (const [act, key] of [
      ['outline', 'app.mind-outline.toggle'],
      ['theme-style', 'app.mind-theme-panel.do'],
      ['xmind-import', 'app.mind-import.do'],
    ] as const) {
      const btn = bar!.querySelector<HTMLButtonElement>(`button[data-act='${act}']`)
      expect(btn, `button[data-act=${act}] 在场`).not.toBeNull()
      expect(btn!.querySelector('svg'), `${act} 钮 icon 化（svg 在场）`).not.toBeNull()
      expect([btn!.getAttribute('title'), btn!.getAttribute('aria-label')], `${act} i18n 面（title/aria 双通道）`).toEqual([key, key])
    }
    // 分组：sep 两枚（统一钮簇｜视图态｜内容三段）
    expect(bar!.querySelectorAll('.sep'), '组间分隔两枚').toHaveLength(2)
    // 「下载要最右」：导出 select DOM 序在内容组（templates/xmind-import）之后——
    // bar 子元素序中以 data-act 取址（badge/xmindInput 无 data-act，不计可见控件序）
    const order = [...bar!.children].map((c) => (c as HTMLElement).getAttribute('data-act') ?? '')
    const idxExport = order.indexOf('export')
    expect(idxExport, '导出 select 在场').toBeGreaterThanOrEqual(0)
    expect(idxExport, '导出在模板之后').toBeGreaterThan(order.indexOf('templates'))
    expect(idxExport, '导出在导入钮之后（bar 最右可见控件）').toBeGreaterThan(order.indexOf('xmind-import'))
  })

  it('MP2-X1 导入行为：真 zip 字节 File 桩 change → setData 收等价树（toEngineTree(parseMindmap(导入文本))，引擎 setData=树形态 :889 面实证）+显式 markDirty（onDirty(true)）→ 保存链落盘替换现文件（putObject 字节=导入文本 canonical）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, onDirty } = await mount({ putObject })
    const expected = ['mindmap', '  导入根', '    分支一', '      孙节点', '    分支二'].join('\n')
    const zip = mkXmindZip([mkXmindSheet(mkXmindTopic('导入根', [mkXmindTopic('分支一', [mkXmindTopic('孙节点')]), mkXmindTopic('分支二')]))])
    dispatchXmindImport(xmindInputOf(el), new File([zip], 'import.xmind', { type: 'application/xmind' }))
    await vi.waitFor(() => expect(engine.state.setDataCalls, '导入链完成（异步：arrayBuffer/unzip/parse 跳数不定）').toHaveLength(1))
    expect(engine.state.setDataCalls[0], '引擎收等价树（文本经 parseMindmap+toEngineTree——setData API=树形态）').toEqual(toEngineTree(parseMindmap(expected)))
    expect(onDirty, '显式 markDirty（引擎 setData 无 data_change 侧信道——脏标业务侧显式承担）').toHaveBeenCalledWith(true)
    // 保存链落盘替换现文件：引擎已消费 setData（真引擎语义）→ save 输出=导入文本 canonical（键全漂移降级重建不丢树；无 meta 源零拼接）
    engine.state.dataTree = engine.state.setDataCalls[0]
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(out.split('\n'), '保存字节=导入文本（canonical 同构——导入→落盘零漂移红线）').toEqual(expected.split('\n'))
    expect(engine.state.updateDataCalls, '写入路径唯一（setData 面，禁 updateData 双通道）').toEqual([])
  })

  it('MP2-X1 parse 失败防御：坏 zip（非 zip 字节）change → console.warn（失败可见）+引擎数据零写入（setData/updateData 恒空）+零 dirty（onDirty 零调——导入失败不落不标脏）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { el, onDirty } = await mount()
    const garbage = new TextEncoder().encode('this is definitely not a zip archive')
    dispatchXmindImport(xmindInputOf(el), new File([garbage], 'broken.xmind', { type: 'application/xmind' }))
    await new Promise((r) => setTimeout(r, 20)) // 失败链（catch→warn）飞行窗
    expect(warnSpy, '失败告警（mind/* 域既有 console.warn 通道——导入=显式动作，失败须可见）').toHaveBeenCalledTimes(1)
    expect(engine.state.setDataCalls, '零引擎写（parse 失败禁 setData）').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（parse 失败禁 updateData）').toEqual([])
    expect(onDirty, '零 dirty（失败不标脏——保存链不得落半截导入态）').not.toHaveBeenCalled()
  })
})

// ═══════════════ MP2-TP-T 追加块：P2 模板库——测试先行，预期红 ═══════════════
// 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2「模板库」+ 主代理契约裁决（本批 brief）。
// 插位注记：本块插于 MP2-X1 describe 与 MP2-E1-T 块之间（任务裁决位），不占文件尾（MP2-Q3-T
// 并行区在尾）；与既有各追加块零重叠，既有 99 例零字节改动。
//
// 【模块契约（新建 mind/templates.ts，落地归 MP2-TP-C，缺位=本块预期红）】导出 MIND_TEMPLATES
// 数组，每项 { id: string; nameKey: string; content: string }——content=mermaid mindmap 文本
// （canonical 缩进根 2 空格+每层+2，与 serializeMindmap 同构=往返零漂移红线）。首批恰 3 套且
// id 集合钉死 ['project','brainstorm','release']（项目管理/头脑风暴/产品发布——brief 列举序）。
// 内容 zh 固定（节点文本不 pin 具体字面=实现侧撰文自由，只 pin 结构契约）；名称走 i18n
// （nameKey=app.mind-templates.items.<id>）；en 内容本地化=MVP 记账限制注记（不在断言面）。
//
// 【DOM 形态钉（测试侧裁量，实现侧对齐或回本文件改钉）】模板控件=<select data-act='templates'>，
// 容器自有条 .mmagic-mind__bar 内（MP1 两 select/MP2-E1 导出 select 同族——不进 shared 工具栏
// 四键集，锁定例双保险断言随 DOM 例）。首项=占位（value=''，文本=t(app.mind-templates.placeholder)
// ——动作入口非状态回显，mount 初值=占位）；其余选项=每模板一枚（value=模板 id=测试侧裁量钉、
// 文本=t(nameKey)、齐序随 MIND_TEMPLATES）。控件 i18n 面=aria-label/title 至少一处走
// t(app.mind-templates.do)（专用 do 键=本侧裁量钉——mind-export.do/mind-import.do 命名族同构；
// 键集提案归 MP2-TP-C locales 落地）。
//
// 【行为链（主代理裁决）】change→非空值→parseMindmap(content)→toEngineTree→mm.setData(树)+
// 显式 markDirty（引擎 setData 无 data_change 侧信道——MP1「脏标业务侧显式承担」/MP2-X1 导入
// 同族口径；setData=引擎树形态，resetToSaved :889 同面）→select 复位占位（value=''——动作非
// 状态，导出 select 复位回首项同款）。模板替换=数据写路径（替换现内容走 dirty 保存链），
// readonly 受闩——导入族双闸同款（setReadonly 禁用控件+change 处理器 readonly 早退兜底）；
// 与导出/大纲「视图态零写路径不闩」族不可类比（MP2-X1 块头同口径注记）。
//
// 【mock/桩面】引擎 mock 零改动（setDataCalls/onDirty 既有面够用）；模板模块经 loadTemplates()
// 运行时动态 import（变量说明符+@vite-ignore+根绝对路径——仓内 samples.test.ts 同款先例：
// ⚠ 字面 specifier 即便动态 import 也会被 vite import-analysis 构建期解析、模块缺位整文件
// 红=越界，红名单纪律要求把红锁进本块五例；变量说明符顺带绕开 TS 模块解析，模板模块落地前
// tsc 不得触其类型）。locales 键面动态 import 探测（字面量两分支静态可解析——两文件既存），
// zh+en 双面断言=名称走 i18n 两语言键均在场。id 'project' 在 readonly 例按契约钉死字面直用
// （模块缺位不依赖——该例红面=控件缺位/闸面，非模块面）。
//
// 【预期红账（MP2-TP-T 时点，MP2-TP-C 未落地）】五例全红：
//  - 例 1/2/3/5：红=templates 模块缺位（动态 import Failed to load url 抛，断言面未触达；
//    模块落地后例 1 尚余 locales 键面红——键集归 C，键落再转绿）。
//  - 例 4：红=控件缺位（定位器 expect 抛——闩锁前置面走既有 4305 链全绿，不构成假红）。
//  ═════════════════════════════════════════════════════════════════════════════════════════════

/** 模板项契约（mind/templates.ts 导出面——模块落地归 MP2-TP-C，缺位=本块动态 import 红） */
interface MindTemplateItem {
  id: string
  nameKey: string
  content: string
}

/** 模板模块装载（运行时动态 import——变量说明符+@vite-ignore 防构建期 import-analysis：
 *  模块缺位=加载错误锁进本块五例，不整文件红越界（红名单纪律）。根绝对路径=仓内
 *  samples.test.ts 同款先例（vitest/vite 动态 import 对变量说明符按项目根解析）；无扩展名=
 *  resolve.extensions 落 .ts。类型面走本文件 MindTemplateItem 局部契约——模板模块落地前
 *  TS 模块解析不得触其类型（变量说明符顺带绕开，samples.test.ts 注记同口径） */
/** 模板模块 specifier（根绝对路径；变量化=@vite-ignore 生效前提——字面量动态 import 仍被
 *  vite import-analysis 构建期解析、缺位整文件红越界） */
const TEMPLATES_SPEC = '/src/apps/mind/templates'

async function loadTemplates(): Promise<{ MIND_TEMPLATES: MindTemplateItem[] }> {
  const mod = (await import(/* @vite-ignore */ TEMPLATES_SPEC)) as { MIND_TEMPLATES: MindTemplateItem[] }
  return mod
}

/** 模板控件定位（容器自有 select[data-act=templates]——exportSelectOf 同手法） */
function templatesSelectOf(el: HTMLElement): HTMLSelectElement {
  const s = el.querySelector<HTMLSelectElement>("select[data-act='templates']")
  expect(s, "模板控件 select[data-act=templates] 应在容器子树内（MP2-TP DOM 契约）").not.toBeNull()
  return s!
}

/** 模板派发：置值 + change 事件（dispatchExport 同手法——jsdom 标准面） */
function dispatchTemplate(sel: HTMLSelectElement, value: string): void {
  sel.value = value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

/** locales 键面探测（app 命名域平铺键：运行时键 app.mind-templates.do ⇔ zh-CN.ts app 域
 *  'mind-templates.do' 键——mind-export.do 同构；动态 import 字面量两分支=静态可解析） */
async function localeHasKey(locale: 'zh-CN' | 'en-US', key: string): Promise<boolean> {
  const dict =
    locale === 'zh-CN'
      ? (await import('../../../locales/zh-CN')).default
      : (await import('../../../locales/en-US')).default
  // mind 键族为根级全路径扁平键（intlify 解析口径：根级字面命中或按点嵌套行走，
  // app 块内带点扁平键两头够不着——见 locales/__tests__/locales.test.ts 四层守卫），
  // 故先查根级字面，再兜底 app 块剥前缀（非 mind 旧键形态）。
  if (Object.prototype.hasOwnProperty.call(dict, key)) return true
  const app = (dict as { app?: Record<string, unknown> }).app
  if (typeof app !== 'object' || app === null) return false
  return Object.prototype.hasOwnProperty.call(app, key.startsWith('app.') ? key.slice('app.'.length) : key)
}

describe('MP2-TP 模板库（首批 3 套——模块契约/控件 DOM/替换行为/readonly 双闸/幂等）', () => {
  it('MP2-TP templates.ts 契约：MIND_TEMPLATES 恰 3 项+id 集合钉死（project/brainstorm/release——brief 列举序）+每项 content 经 parseMindmap 解析成功且根唯一（mermaid only one root）+canonical 往返零漂移（serializeMindmap 同构红线）+nameKey=items 命名族且指向 zh/en locales 既存键面（含 do/placeholder 控件键——locales 落地归 MP2-TP-C，键落转绿；en 内容本地化缺位不在断言面=MVP 记账注记）', async () => {
    const { MIND_TEMPLATES } = await loadTemplates()
    expect(Array.isArray(MIND_TEMPLATES), 'MIND_TEMPLATES=数组导出').toBe(true)
    expect(MIND_TEMPLATES, '首批恰 3 套（项目管理/头脑风暴/产品发布）').toHaveLength(3)
    const ids = MIND_TEMPLATES.map((tpl) => tpl.id)
    expect(new Set(ids).size, 'id 唯一').toBe(ids.length)
    expect(ids, '首批 id 集合（键系 app.mind-templates.items.<id> 的 <id> 域，序随列举）').toEqual(['project', 'brainstorm', 'release'])
    for (const tpl of MIND_TEMPLATES) {
      expect(typeof tpl.nameKey, `模板 ${tpl.id} nameKey=string`).toBe('string')
      expect(tpl.nameKey, `模板 ${tpl.id} nameKey=items 命名族（app.mind-templates.items.<id>）`).toBe(`app.mind-templates.items.${tpl.id}`)
      const model = parseMindmap(tpl.content)
      expect(model.header, `模板 ${tpl.id} header=mindmap 方言`).toBe('mindmap')
      const rootIds = [...model.nodes.values()].filter((n) => !model.edges.some((e) => e.to === n.id)).map((n) => n.id)
      expect(rootIds, `模板 ${tpl.id} content 解析成功且根唯一（mermaid only one root 硬约束）`).toHaveLength(1)
      expect(serializeMindmap(parseMindmap(tpl.content)), `模板 ${tpl.id} content canonical 往返零漂移（根 2 空格+每层+2，serializeMindmap 同构）`).toBe(tpl.content)
    }
    const keys = ['app.mind-templates.do', 'app.mind-templates.placeholder', ...MIND_TEMPLATES.map((tpl) => tpl.nameKey)]
    for (const key of keys) {
      expect(await localeHasKey('zh-CN', key), `zh-CN 键面含 ${key}（locales 归 MP2-TP-C）`).toBe(true)
      expect(await localeHasKey('en-US', key), `en-US 键面含 ${key}（locales 归 MP2-TP-C）`).toBe(true)
    }
  })

  it('MP2-TP 控件 DOM：select[data-act=templates] 在容器自有条内（MP1/导出 select 同族）+首项占位（value=\'\' 文本=t(app.mind-templates.placeholder)，mount 初值=占位）+其余选项=每模板一枚（value=id 文本=t(nameKey) 齐序随 MIND_TEMPLATES）+aria-label/title 走 t(app.mind-templates.do)+shared 工具栏四键集不被侵入', async () => {
    const { MIND_TEMPLATES } = await loadTemplates()
    const { el } = await mount()
    const sel = templatesSelectOf(el)
    expect(sel.closest('.mmagic-mind__bar'), '容器自有条内（与大纲钮/导出 select 同族，非 shared 工具栏）').not.toBeNull()
    expect(sel.options[0]!.value, '首项=占位（value=\'\'——动作入口非状态回显）').toBe('')
    expect(sel.options[0]!.textContent, '占位标签走 t(app.mind-templates.placeholder)').toBe('app.mind-templates.placeholder')
    expect(sel.value, 'mount 初值=占位').toBe('')
    expect([...sel.options].slice(1).map((o) => o.value), '模板选项值=id 齐序随 MIND_TEMPLATES（value=id=测试侧裁量钉）').toEqual(MIND_TEMPLATES.map((tpl) => tpl.id))
    for (const o of [...sel.options].slice(1)) {
      const tpl = MIND_TEMPLATES.find((t) => t.id === o.value)!
      expect(o.textContent, `选项 ${o.value} 文本=t(${tpl.nameKey})`).toBe(tpl.nameKey)
    }
    expect([sel.getAttribute('aria-label'), sel.getAttribute('title')].filter(Boolean), '控件 i18n 面：aria-label/title 至少一处走 t(app.mind-templates.do)（专用 do 键=本侧裁量钉）').toContain('app.mind-templates.do')
    const acts = [...el.querySelectorAll('.mmx-edt__btn[data-act]')].map((b) => b.getAttribute('data-act'))
    expect(acts, 'shared 工具栏四键集不得被模板控件侵入（锁定例红线双保险）').toEqual(['save', 'undo', 'redo', 'reset'])
  })

  it('MP2-TP 行为：change 选项目管理（project）→ mm.setData 收等价树（toEngineTree(parseMindmap(对应 content))——setData=树形态，模板内容无 meta 零装饰组合链）+显式 markDirty（onDirty(true)）+select 复位占位（value=\'\'——动作非状态，导出 select 同款）', async () => {
    const { MIND_TEMPLATES } = await loadTemplates()
    const { el, onDirty } = await mount()
    const tpl = MIND_TEMPLATES.find((t) => t.id === 'project')
    expect(tpl, '前置面：project 模板在场（契约例同钉首批 id 集）').toBeDefined()
    dispatchTemplate(templatesSelectOf(el), tpl!.id)
    expect(engine.state.setDataCalls, '模板替换恰一次引擎写').toHaveLength(1)
    expect(engine.state.setDataCalls[0], '引擎收等价树（parseMindmap+toEngineTree——无 meta 源零装饰链，resetToSaved :889 setData 树形态同面）').toEqual(toEngineTree(parseMindmap(tpl!.content)))
    expect(onDirty, '显式 markDirty（引擎 setData 无 data_change 侧信道——MP1「脏标业务侧显式承担」/MP2-X1 导入同族口径）').toHaveBeenCalledWith(true)
    expect(templatesSelectOf(el).value, '派发后 select 复位占位（动作非状态）').toBe('')
    expect(engine.state.updateDataCalls, '写入路径唯一（setData 面，禁 updateData 双通道）').toEqual([])
  })

  it('MP2-TP readonly 双闸：4305 闩锁后 select disabled（闸 1 setReadonly 禁用——导入钮同款）+编程派发 change（闸 2 处理器 readonly 早退兜底）→零 setData 零 dirty（模板替换=数据写路径，导入族口径——非导出/大纲「视图态零写路径不闩」族；id project=契约钉死字面，模块缺位不依赖）', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { el, onDirty, onReadonly } = await mount({ putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 闩锁须走完保存链至 putObject 抛 4305（MP2-Q2 readonly stance 例同手法）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1)) // 闩锁在场（readonly=true）
    const sel = templatesSelectOf(el)
    expect(sel.disabled, '闸 1：setReadonly 禁用模板控件（导入钮同款）').toBe(true)
    dispatchTemplate(sel, 'project') // 编程派发绕不过 disabled 属性本身——闸 2 readonly 早退兜底（导入双闸同款）
    await flush()
    expect(engine.state.setDataCalls, '零引擎写（readonly 早退——模板替换=写路径受闩）').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（禁 updateData 双通道）').toEqual([])
    expect(onDirty, '零 dirty（闩锁后写路径全封——markDirty 自早退）').not.toHaveBeenCalled()
  })

  it('MP2-TP 幂等（动作可重复）：连选两不同模板 → 两次派发间均复位占位（复位不吞后续选择）+两次 setData 各落对应树（第二次落第二模板树）+onDirty(true) 各恰一次（替换动作恒翻脏）', async () => {
    const { MIND_TEMPLATES } = await loadTemplates()
    const { el, onDirty } = await mount()
    const sel = templatesSelectOf(el)
    const first = MIND_TEMPLATES[0]!
    const second = MIND_TEMPLATES[1]!
    dispatchTemplate(sel, first.id)
    expect(sel.value, '首次派发后复位占位（动作非状态）').toBe('')
    dispatchTemplate(sel, second.id) // select 已复位仍可再次派发——复位链不得吞后续选择
    expect(engine.state.setDataCalls, '连选两模板=两次引擎写').toHaveLength(2)
    expect(engine.state.setDataCalls[1], '第二次 setData 落第二模板树（动作可重复）').toEqual(toEngineTree(parseMindmap(second.content)))
    expect(onDirty, '两次显式 markDirty 各恰一次').toHaveBeenCalledTimes(2)
    expect(onDirty.mock.calls.every((c) => c[0] === true), '两次均标脏（替换=写路径恒翻脏，无 false 流量）').toBe(true)
    expect(sel.value, '二次派发后仍复位占位').toBe('')
  })
})

// ═══════════════ MP2-Q4-T 追加块：R3 两项修复测试钉（TP 模板 saving 闩 P1-1 + 导入镜像窗复检 Q3 P2-1/disposed） ═══════════════
// 契约正本：.claude/mind-loop-state.md「MP2-R3」行（TP P1-1 阻断项 + Q3 P2-1 入池项）+ Q3-T 块头
// 手法（手动 pending putObject 飞行窗）。插位=MP2-TP describe 之后（任务裁决位），既有 111 例零字节改动。
//
// 【盘面锚点（mindEditor.ts 修复后实测 1070 行，2026-11-10，MP2-Q4-C 落地注记）】
//  - 模板控件 change 处理器 :589-601——首行 `if (readonly || saving) return`（:593，Q4-C 落地：
//    R3 P1-1 正典镜像，与 runXmindImport :545 同族口径）——保存飞行窗内（putObject 未决）选模板
//    被闩拒静默（窄窗保存完成后重选即可）：窗内 setData+markDirty 若落会被收尾置假三连吞 →
//    dispose 静默丢模板内容（=MP2-R3 P1-1 阻断机理；同批 Q3-C 已给孪生 .xmind 路径装闩）。
//  - runXmindImport :543-567——入口三闸 :544-546（readonly→saving→importBusy，saving 闩只拦
//    「保存先起飞」）后 `await file.arrayBuffer()`（:549）挂起窗（镜像窗）；恢复后两复检
//    :553-554（Q4-C 落地：`if (saving) return` 拒「导入先挂起、保存后起飞」迟导入+`if (disposed) return`
//    拒 dispose 后零写——R3 记账①；try 内前置 return 走 finally，importBusy 照常收闩）→
//    setData(:560)+markDirty(:561)。
//  - save 收尾 :999-1002——残轴守卫（:999）只查 viewOverride 两轴不查内容脏 → 置假三连
//    （:1000-1002）无条件吞（修复前例 1/例 2 两红共因；修复后闩拒使窗内写零发生=吞面不可达）。
//
// 【四例账（Q4-C 落地后终态：115/115 全绿）】
//  - 例 1 绿（P1-1 闩拒钉）：窗内选模板三零断言（setData/updateData/onDirty 全空=闩拒）+
//    resolvePut 后补腿「保存完成后选模板照常成功」（setData 恰 1 落等价树+onDirty(true)+is-dirty
//    在场）——修复后零改动转绿（Q4-T 时原红：首行仅 readonly 闸，窗内 setData 已发生）。
//  - 例 2 绿（Q4-C 翻转钉，授权同 Q3-C 先例+R3 复检裁决）：镜像窗内保存后起飞→resolveBuf 导入链
//    恢复被 saving 复检拒→三零闩拒+保存收尾照常+闩窗外导入照常补腿（形态=Q3 例 1 终态）。
//    Q4-T 时原钉=「镜像窗内 setData 已发生+onDirty(true)→收尾置假三连吞→is-dirty 须真」吞脏机理
//    红——修复落地后前置面全不可达，已翻转为正典闩拒钉（例名/注记同步）；「已落盘=旧树」「收尾
//    onDirty(false)」两文档钉修复前后皆真保留（注记语义随翻转更新）。
//  - 例 3 绿钉（R3 记账②）：坏 zip（reject 面）→warn 恰一次+零写+零 dirty+input.value 复位在场
//    →同法再造好 zip File 再导入→setData 恰 1+onDirty(true)+零新告警=失败链复位与重试可达（失败
//    /闩拒不粘死导入链）。全程绿（catch/finally 收敛面既有——守卫钉）。
//  - 例 4 绿（disposed 复检钉）：导入挂起镜像窗→surface.dispose()（destroyCalls=1 前置面）→
//    resolveBuf→三零（销毁后零写）——修复后零改动转绿（disposed 标志位既有闭包位 :287+
//    dispose :1051-1052 置位，Q4-C 仅补 runXmindImport :554 复检行）。手法冲突核对：与例 2 同用
//    「arrayBuffer 手动 pending 镜像窗」无冲突——两例独立 mount 各持独立 pending promise。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('MP2-Q4 R3 修复测试钉（模板写路径 saving 闩 P1-1 + 导入镜像窗 saving 复检/disposed 复检 Q3 P2-1 + 失败→复位→重试绿钉）', () => {
  /** File 桩：arrayBuffer 手动 pending（镜像窗制造面——jsdom File 实例级 defineProperty 覆写
   *  prototype 方法；携带真 zip 字节的受控 promise，恢复后链=真 unzip/parse 面；resolveBuf
   *  预绑 zip 字节——裸 resolve() 会以 undefined 兑现→new Uint8Array(undefined)=空→unzip 抛=链
   *  落 catch 通道，镜像窗现行为钉不出） */
  function mkPendingArrayBufferFile(zip: Uint8Array): { file: File; resolveBuf: () => void } {
    let resolveInner!: (buf: ArrayBuffer) => void
    const bufPromise = new Promise<ArrayBuffer>((resolve) => { resolveInner = resolve })
    const file = new File([zip], 'import.xmind', { type: 'application/xmind' })
    Object.defineProperty(file, 'arrayBuffer', { value: () => bufPromise, configurable: true })
    return { file, resolveBuf: () => resolveInner(zip.slice().buffer as ArrayBuffer) }
  }

  it('MP2-Q4（MP2-R3 P1-1·模板写路径 saving 闩）保存飞行窗内选模板被 saving 闩拒：putObject pending→保存进飞行窗→change 选模板→三零（setData/updateData/onDirty 全空=闩拒静默——窗内落引擎会被收尾置假三连吞→dispose 静默丢模板内容）+resolvePut 保存收尾后（saving=false）选模板照常成功（闩只在 saving 期生效）——现实现预期红：change 处理器仅 readonly 闸（mindEditor.ts :585），窗内 setData 已发生；修复面=首行 if (readonly || saving) return（归 MP2-Q4-C），修复后零改动转绿', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面，Q3 例 1 同手法）
    const { MIND_TEMPLATES } = await loadTemplates()
    const { el, onDirty, surface } = await mount({ text: MIND_TEXT, putObject })
    const tpl = MIND_TEMPLATES.find((item) => item.id === 'project')
    expect(tpl, '前置面：project 模板在场（MP2-TP 契约例同钉）').toBeDefined()
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 保存序列化源=打开时树
    saveBtnOf(el).click() // 保存起飞：挂起于 await putObject（飞行窗开）
    await flush()
    expect(putObject, '前置面：保存已入飞行窗（putObject 已调且 pending 未决）').toHaveBeenCalledTimes(1)
    // 飞行窗内选模板（MP2-TP describe 行为例同手法：查表 content→等价树）——saving 闩拒面
    // （模板 change=同步 handler，落引擎即时可见，无异步窗宽需求）
    dispatchTemplate(templatesSelectOf(el), tpl!.id)
    // 断言①②③（闩拒三零）：零引擎写/零 markDirty（现实现无 saving 闩→setData 已发生=红）
    expect(engine.state.setDataCalls, 'P1-1：saving 闩拒——窗内选模板零引擎写').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（updateData 通道同禁）').toEqual([])
    expect(onDirty, '闩拒链零 markDirty（窗内模板脏若落即被收尾置假三连吞→dispose 静默丢模板内容）').not.toHaveBeenCalled()
    // 放行：保存收尾链随微任务排空跑完（saving=false，飞行窗闭）
    resolvePut()
    await flush()
    expect(saveBtnOf(el).classList.contains('is-dirty'), '前置面：保存收尾置假三连照常（非脏基线）').toBe(false)
    // 补一腿（闩只在 saving 期间生效）：保存完成后（resolve 后）选模板照常成功——闩不误伤窗外模板替换
    // （同步 handler：setData/markDirty 派发即落，无 waitFor 需求）
    dispatchTemplate(templatesSelectOf(el), tpl!.id)
    expect(engine.state.setDataCalls, '窗外选模板照常落引擎（恰 1=窗内闩拒 0+补腿 1）').toHaveLength(1)
    expect(engine.state.setDataCalls[0], '引擎收等价树（MP2-TP 行为例同钉：parseMindmap+toEngineTree）').toEqual(toEngineTree(parseMindmap(tpl!.content)))
    expect(onDirty, '模板显式 markDirty 已翻真').toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'is-dirty 在场（模板脏标）').toBe(true)
    surface.dispose() // 清理（飞行窗已 resolve）
  })

  it('MP2-Q4（MP2-R3 Q3 P2-1·镜像窗 saving 复检·Q4-C 翻转钉）导入挂起窗（await arrayBuffer 镜像窗）内保存后起飞→resolveBuf 导入链恢复被 saving 复检拒（镜像窗内保存已读旧树，迟导入若落引擎会被收尾置假三连吞→dispose 静默丢导入内容）：三零（setData/updateData/onDirty 全空=闩拒静默——下次可重试）+resolvePut 保存收尾照常（onDirty(false)+已落盘=旧树字节）+闩窗外导入照常成功补腿（setData 恰 1 落等价树+onDirty(true)+is-dirty 在场——闩只在 saving 期生效，Q3 例 1 终态同款形态）。【翻转注记（授权同 Q3-C 先例，R3 复检裁决）】修复前原钉=「镜像窗内 setData 已发生+onDirty(true)→收尾置假三连吞→is-dirty 须真」吞脏机理红（入口 saving 闩 :545 拦不住「导入先挂起、保存后起飞」序）；修复=runXmindImport await 恢复后 if (saving) return（+disposed 复检，mindEditor.ts :553-554）落地后原钉「setData=1/onDirty(true)/is-dirty 真」前置面全不可达→翻转为本正典闩拒钉；「已落盘=旧树」「收尾 onDirty(false)」两钉修复前后皆真保留（注记语义随翻转更新）', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面，Q3 例 1 同手法）
    const { el, onDirty, surface } = await mount({ text: MIND_TEXT, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 保存同步段读旧树（导入被拒未落——序列化源=打开时树）
    const expected = ['mindmap', '  导入根', '    分支一'].join('\n')
    const zip = mkXmindZip([mkXmindSheet(mkXmindTopic('导入根', [mkXmindTopic('分支一')]))])
    const { file: importFile, resolveBuf } = mkPendingArrayBufferFile(zip)
    dispatchXmindImport(xmindInputOf(el), importFile) // 导入链挂起于 await arrayBuffer（镜像窗开）
    await flush()
    expect(putObject, '前置面：镜像窗开（导入挂起、保存未起飞）').not.toHaveBeenCalled()
    saveBtnOf(el).click() // 窗内保存起飞：saving=true，挂起于 await putObject（双窗叠开）
    await flush()
    expect(putObject, '前置面：保存已入飞行窗（putObject 已调且 pending 未决）').toHaveBeenCalledTimes(1)
    resolveBuf() // 导入链恢复：saving 复检命中→镜像窗内导入被拒（finally 照常收 importBusy——重试面不粘死）
    await flush()
    // 闩拒三零（P2-1 镜像窗正典闩拒钉）：零引擎写/零 markDirty（窗内落引擎会被收尾置假三连吞→dispose 静默丢导入内容）
    expect(engine.state.setDataCalls, 'P2-1 镜像窗 saving 复检：窗内保存已读旧树，迟导入拒——零引擎写').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（updateData 通道同禁）').toEqual([])
    expect(onDirty, '闩拒链零 markDirty（静默拒不加 warn——R2 最小修复集口径）').not.toHaveBeenCalled()
    resolvePut() // 保存收尾链随微任务排空跑完（saving=false，飞行窗闭）
    await flush()
    expect(onDirty, '保存收尾置假三连照常（非脏基线——导入被拒无内容脏可吞；修复前后皆真）').toHaveBeenCalledWith(false)
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(out.split('\n'), '已落盘=旧树字节（保存同步段读旧树；导入被拒零落引擎=零内容丢失面，修复前后皆真）').toEqual(MIND_TEXT.split('\n'))
    // 补一腿（闩只在 saving 期间生效）：保存完成后（resolve 后）同字节再造 File 导入照常成功
    // ——闩不误伤窗外导入（真 arrayBuffer 链=例 3 补腿同手法）
    dispatchXmindImport(xmindInputOf(el), new File([zip], 'retry.xmind', { type: 'application/xmind' }))
    await vi.waitFor(() => expect(engine.state.setDataCalls, '闩窗外导入照常落引擎（恰 1=窗内闩拒 0+补腿 1）').toHaveLength(1))
    expect(engine.state.setDataCalls[0], '引擎收导入等价树').toEqual(toEngineTree(parseMindmap(expected)))
    expect(onDirty, '导入显式 markDirty 已翻真').toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'is-dirty 在场（导入脏标）').toBe(true)
    surface.dispose() // 清理（双窗已 resolve+补腿已收敛）
  })

  it('MP2-Q4（R3 记账②）导入失败→复位→重试成功绿钉：坏 zip（reject 面）→warn 恰一次+零引擎写+零 dirty+input.value 复位在场（失败链不粘死导入口）→同法再造好 zip File 再导入→setData 恰 1 落等价树+onDirty(true)+零新告警=重试可达（红=失败链粘死：复位缺位/闩不收敛/重试链不落）——当前实现即绿（catch/finally 收敛面既有，守卫钉）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { el, onDirty } = await mount()
    const expected = ['mindmap', '  导入根', '    分支一'].join('\n')
    const input = xmindInputOf(el)
    // 第一腿：坏 zip（非 zip 字节——unzipSync reject 面，X1 失败例同桩同窗宽）
    const garbage = new TextEncoder().encode('this is definitely not a zip archive')
    dispatchXmindImport(input, new File([garbage], 'broken.xmind', { type: 'application/xmind' }))
    await new Promise((r) => setTimeout(r, 20)) // 失败链（catch→warn）飞行窗
    expect(warnSpy, '失败告警恰一次（MIND_IMPORT_ERR 通道）').toHaveBeenCalledTimes(1)
    expect(engine.state.setDataCalls, '失败零引擎写').toEqual([])
    expect(engine.state.updateDataCalls, '失败零引擎写（updateData 通道同禁）').toEqual([])
    expect(onDirty, '失败零 dirty（导入失败不落不标脏）').not.toHaveBeenCalled()
    expect(input.value, '失败链后 input 已复位（:529 复位不因失败缺位——同文件重选仍触发 change 的前提面）').toBe('')
    // 第二腿：同法再造好 zip File 再导入（重试可达）
    const zip = mkXmindZip([mkXmindSheet(mkXmindTopic('导入根', [mkXmindTopic('分支一')]))])
    dispatchXmindImport(input, new File([zip], 'retry.xmind', { type: 'application/xmind' }))
    await vi.waitFor(() => expect(engine.state.setDataCalls, '重试链落引擎').toHaveLength(1))
    expect(engine.state.setDataCalls[0], '引擎收导入等价树').toEqual(toEngineTree(parseMindmap(expected)))
    expect(onDirty, '重试显式 markDirty 已翻真').toHaveBeenCalledWith(true)
    expect(warnSpy, '重试成功链零新告警').toHaveBeenCalledTimes(1)
  })

  it('MP2-Q4（MP2-R3 Q3 P2-1·disposed 复检）导入挂起镜像窗内 surface.dispose()→resolveBuf→零 setData/updateData/零 markDirty（销毁后零写——写已销毁引擎+脏标上抛宿主=静默幽灵态）——现实现预期红：runXmindImport 无 disposed 检查（盘面 :543-562 仅入口三闸），恢复链照常落引擎；修复面与例 2 同点（await 恢复后补 if (disposed) return，归 MP2-Q4-C 一并），修复后零改动转绿', async () => {
    const { el, onDirty, surface } = await mount()
    const zip = mkXmindZip([mkXmindSheet(mkXmindTopic('导入根', [mkXmindTopic('分支一')]))])
    const { file: importFile, resolveBuf } = mkPendingArrayBufferFile(zip)
    dispatchXmindImport(xmindInputOf(el), importFile) // 导入链挂起于 await arrayBuffer（镜像窗开）
    await flush()
    surface.dispose() // 销毁面（引擎 destroy+容器清空——挂起链闭包持有的 mm 引用仍存活）
    expect(engine.state.destroyCalls, '前置面：dispose 已拆引擎').toHaveLength(1)
    resolveBuf() // 挂起链在已销毁面恢复
    await new Promise((r) => setTimeout(r, 20)) // 恢复链飞行窗（unzip/parse 同步+微任务排空富余——X1 失败例同域窗宽）
    expect(engine.state.setDataCalls, 'disposed 复检：销毁后零引擎写（现实现 setData 已发生=红）').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（updateData 通道同禁）').toEqual([])
    expect(onDirty, '销毁后零 markDirty（脏标上抛宿主=幽灵 dirty）').not.toHaveBeenCalled()
  })
})

// ═══════════════ MP2-E1-T 追加块：P2 导出批（png/svg/json/OPML）——测试先行，预期红 ═══════════════
// 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2「导出 png/svg/OPML」+ §三 D-LICENSE
// 勘误（Export 插件 npm 包 license=MIT、源码在包内可用）；usePlugin 装配序追加 OuterFrame 之后
// （6→7——上方「装配与引擎」「MC3c」两历史计数例已同步翻转）。
//
// 【MP2-E1-T 引擎 Export API 勘察（frontend/node_modules/simple-mind-map/src/plugins/Export.js
// 实证，0.14.0-fix.3）】
//  - 签名：async export(type, isDownload = true, name = '思维导图', ...args)（Export.js:24）；
//    插件实例名 doExport（Export.js:458 instanceName）→ 真引擎 usePlugin(Export) 后 mm.doExport
//    在场，胶水面=mm.doExport?.export(type, isDownload, name) 防护调用（mm.search?/mm.execCommand?
//    同口径）。
//  - 返回/下载面：命中 this[type] → result=await this[type](name, ...args)；isDownload 真值才走
//    downloadFile(result, name + '.' + type)（utils/index.js:273——<a download> click 真下载）；
//    两态恒 return result；未知 type → null（Export.js:32）。
//  - 三格式返回形态（jsdom FileReader 可断言，本块经 spy 桩不真下载）：png=canvas.toDataURL
//    dataURL 串（Export.js:254）；svg=fixSvgStrAndToBlob→readBlob(FileReader.readAsDataURL)
//    dataURL（Export.js:411-422 + utils/index.js:441-449）；json=Blob(JSON.stringify(
//    getData(withConfig)))→readBlob 同 dataURL（Export.js:425-431）。测试钉 isDownload=true
//    （真引擎=浏览器下载语义），mock 实例播种 doExport spy——真下载面在 jsdom 永不触达。
//  - ⚠ opml 非 Export 插件类型（Export.js 无此方法，export('opml') 落 :32 null）——OPML 导出=
//    纯业务侧（mind/opml.ts opmlFromOutline(outlineFromTree(mm.getData()))→anchor 下载），
//    禁路由 doExport（行为例反断引擎面零调）。
//
// 【DOM 形态钉（测试侧裁量，实现侧对齐或回本文件改钉）】导出控件=<select data-act='export'>，
// 容器自有条 .mmagic-mind__bar 内（与 MP1 两 select 同族）；选项 png/svg/json/opml 四枚齐序，
// change→导出该格式；i18n 键系：控件 aria-label/title=app.mind-export.do、选项文本=
// t(app.mind-export.<fmt>)（locales 待 MP2-E1-C 落地）；不进 shared 工具栏（.mmx-edt__btn 恒
// 四键锁定例双保险断言）。导出名钉=打开文件名去扩展（FILE demo.mmd→demo——真引擎 name 参数拼
// '.<type>' 后缀下载，Export.js:28；四格式同名族）。
//
// 【mock 种子面 seedExportFace】FakeMindMap 类缺省无 doExport（引擎构造器职责）——测试在 mock
// 实例上播种 {export: spy}（seedSearchFace/seedViewFace 同手法，类体零改动=既有例零回归）。
// OPML 下载面断言锚=HTMLElement.prototype.click spy（jsdom 实证 click 定义于 HTMLElement
// prototype 非 HTMLAnchorElement.prototype），记录 anchor download/href（href 形态 blob:/data:
// 不钉=实现自由度）；OPML 文本本体归 mind/opml.ts 单测（DOMParser application/xml 结构断言，
// 本文件零重复）。
//
// 【预期红账（MP2-E1-T 时点，MP2-E1-C 未落地）】
//  - Export 注册例+两历史计数例（6→7 翻转）：红=usePluginCalls 仍 6 件/calls[6] undefined。
//  - 导出控件 DOM 例：红=select[data-act=export] 缺位（querySelector null → 定位器 expect 抛，
//    断言面未触达，归因纯 UI 面）。
//  - png/svg/json 行为例：红=控件缺位（doExport 播种面已就绪，不因 mock 缺面假红）。
//  - OPML 行为例+opml.ts 单测（mind/__tests__/opml.test.ts 新文件）：红=控件缺位/模块不存在
//    （import 解析失败整文件红，归因=纯函数面未落地）。
//  - dirty 守卫例：红=控件缺位（语义本体「导出不标脏」随 C 落地转绿）。
//  - 既有 80 例除两处 usePlugin 计数翻转外零改动；文件尾 MP2-Q-T 区段归并行代理，本块插于
//    MP1 describe 与 MP2-P-T 之间，互不重叠。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import Export from 'simple-mind-map/src/plugins/Export'

/** 导出控件定位（容器自有 select[data-act=export]——mindViewSelectOf 同手法） */
function exportSelectOf(el: HTMLElement): HTMLSelectElement {
  const s = el.querySelector<HTMLSelectElement>("select[data-act='export']")
  expect(s, "导出控件 select[data-act=export] 应在容器子树内（MP2-E1 DOM 契约）").not.toBeNull()
  return s!
}

/** 导出派发：置值 + change 事件（MP1 dispatchViewChange 同手法——jsdom 标准面） */
function dispatchExport(sel: HTMLSelectElement, value: string): void {
  sel.value = value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 在 mock 引擎实例上播种 Export 插件实例面（真引擎=usePlugin(Export) 后 mm.doExport，
 *  instanceName 'doExport' Export.js:458 实测；seedSearchFace/seedViewFace 同手法） */
function seedExportFace(mm: unknown): { export: ReturnType<typeof vi.fn> } {
  const face = { export: vi.fn().mockResolvedValue('data:image/png;base64,ZmFrZQ==') }
  ;(mm as { doExport?: unknown }).doExport = face
  return face
}

describe('MP2-E1 导出（png/svg/json/OPML）', () => {
  it('MP2-E1 Export 注册：usePlugin 恰 7 件（MP2-E1-T 翻转 6→7）、第 7 件 toBe Export（装配序追加 OuterFrame 之后=测试侧钉定，实现侧对齐）、注册先于 constructor', async () => {
    await mount()
    const calls = engine.state.usePluginCalls
    expect(calls, 'MP2-E1 批起恰七件（六件+Export，实例挂 mm.doExport）').toHaveLength(7)
    expect(calls[6]).toBe(Export)
    const useIdxs = engine.state.log.map((e, i) => (e === 'usePlugin' ? i : -1)).filter((i) => i >= 0)
    expect(useIdxs).toHaveLength(7)
    expect(useIdxs[6]).toBeLessThan(engine.state.log.indexOf('construct'))
  })

  it('MP2-E1 导出控件 DOM：select[data-act=export] 在容器自有条内（MP1 两 select 同族）+png/svg/json/opml 四选项齐序（plan §七 P2）+i18n 面（aria-label/title=app.mind-export.do+选项文本 t(app.mind-export.<fmt>)）+shared 工具栏四键集不被侵入', async () => {
    const { el } = await mount()
    const sel = exportSelectOf(el)
    expect(sel.closest('.mmagic-mind__bar'), '容器自有条内（与 MP1 切换器同族，非 shared 工具栏）').not.toBeNull()
    expect([...sel.options].map((o) => o.value), '四格式齐序（png/svg 引擎面+json 引擎面+opml 业务面）').toEqual(['png', 'svg', 'json', 'opml'])
    expect([sel.getAttribute('aria-label'), sel.getAttribute('title')].filter(Boolean), '控件 i18n 面：aria-label/title 至少一处走 t(app.mind-export.do)').toContain('app.mind-export.do')
    for (const o of [...sel.options]) {
      expect(o.textContent, `选项 ${o.value} i18n 标签经 t() 注入`).toBe(`app.mind-export.${o.value}`)
    }
    const acts = [...el.querySelectorAll('.mmx-edt__btn[data-act]')].map((b) => b.getAttribute('data-act'))
    expect(acts, 'shared 工具栏四键集不得被导出控件侵入（既有锁定例红线双保险）').toEqual(['save', 'undo', 'redo', 'reset'])
  })

  it('MP2-E1 png 导出行为：change→png → mm.doExport.export 首参收 png（Export.js:24 面）+isDownload=true（真引擎 downloadFile 下载面 Export.js:27-28——spy 桩下 jsdom 真下载不触达）+导出名=文件名去扩展（demo.mmd→demo，引擎拼 .png 后缀）', async () => {
    const { el, mm } = await mount()
    const face = seedExportFace(mm)
    dispatchExport(exportSelectOf(el), 'png')
    expect(face.export, '导出恰一次').toHaveBeenCalledTimes(1)
    expect(face.export.mock.calls[0]![0], '首参=png（Export type 面）').toBe('png')
    expect(face.export.mock.calls[0]![1], 'isDownload=true（真下载语义）').toBe(true)
    expect(face.export.mock.calls[0]![2], '导出名=打开文件去扩展（Export.js:28 拼 .<type>）').toBe('demo')
  })

  it('MP2-E1 svg/json 导出同构（引擎面透传）：change→svg / change→json → mm.doExport.export 首参收同名格式各恰一次（json 序列化在引擎侧 getData(withConfig) Export.js:425-431，胶水零经手）+isDownload/导出名同 png 口径', async () => {
    const { el, mm } = await mount()
    const face = seedExportFace(mm)
    for (const fmt of ['svg', 'json'] as const) {
      dispatchExport(exportSelectOf(el), fmt)
    }
    expect(face.export.mock.calls.map((c) => c[0]), '两格式各恰一次、首参透传').toEqual(['svg', 'json'])
    for (const c of face.export.mock.calls) {
      expect(c[1], 'isDownload=true').toBe(true)
      expect(c[2], '导出名=文件名去扩展').toBe('demo')
    }
  })

  it('MP2-E1 OPML 导出（业务侧纯函数链）：change→opml → 引擎面零调（opml 非 Export 插件类型，export("opml") 落 Export.js:32 null——禁路由 doExport）+blob 下载面（<a download=demo.opml> click 派发恰一次、href 非空；href 形态 blob:/data: 不钉）——OPML 文本本体归 mind/opml.ts 单测', async () => {
    const { el, mm } = await mount()
    const face = seedExportFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // OPML 数据源=mm.getData() 实时取（outlineFromTree 同源）
    const downloads: Array<{ name: string; href: string }> = []
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      if (this instanceof HTMLAnchorElement) {
        downloads.push({ name: this.getAttribute('download') ?? '', href: this.getAttribute('href') ?? '' })
      }
    })
    dispatchExport(exportSelectOf(el), 'opml')
    clickSpy.mockRestore()
    expect(face.export, 'opml 禁路由引擎面（引擎无此类型）').not.toHaveBeenCalled()
    expect(downloads, 'blob 下载面恰一次（anchor click 派发）').toHaveLength(1)
    expect(downloads[0]!.name, '下载名=文件名去扩展+.opml（四格式同名族口径）').toBe('demo.opml')
    expect(downloads[0]!.href, '下载 href 非空').not.toBe('')
  })

  it('MP2-E1 导出 dirty 语义守卫（只读操作不标脏）：四格式逐一切换导出 → onDirty 零调+保存钮不翻红点+引擎数据零写入（setData/updateData 恒空——导出=只读面，与「切换即 dirty」MP1 口径反向对照）', async () => {
    const { el, mm, onDirty } = await mount()
    seedExportFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    for (const fmt of ['png', 'svg', 'json', 'opml'] as const) {
      dispatchExport(exportSelectOf(el), fmt)
    }
    expect(onDirty, '导出不标脏（只读操作——onDirty 全程零调）').not.toHaveBeenCalled()
    expect(saveBtnOf(el).classList.contains('is-dirty'), '保存钮无红点').toBe(false)
    expect(engine.state.setDataCalls, '引擎数据零写入（导出路径禁 setData/updateData）').toEqual([])
    expect(engine.state.updateDataCalls, '引擎数据零写入').toEqual([])
  })
})

// ═══════════════ MP2-P-T 追加块：P2 修整批测试钉（测试先行——例 1 预期红，例 2-4 守卫/行为钉） ═══════════════
// 记账正本：.claude/mind-loop-state.md（MP1-UI-R P2-1 保存后视图回退 + MC3-V2 N4/N5 记账 +
// MC3-V4 记账「∈L 会话加字段零专钉」+ MC3-V5「case A 暗面泛化」P2 批次提案项）。
// 四例全追加于文件尾（既有 76 例零改动）：
//  - 例 1「保存后视图态转正」（MP1-UI-R P2-1，兼 MC3-V2 N5 面注入）：**预期红**——现实现
//    save() 成功路径不转正 viewOverride（mindEditor.ts save 仅清 dirty），resetToSaved 清覆写+
//    两 select 回显还原 mount 现效值（fishbone）→「切布局→保存→再编辑→reset」回到打开时视图，
//    且 reset 后再保存输出回退 fishbone（视图态-only 重开可自愈=已知暗面）。业务修复面=save()
//    成功路径转正覆写为基线+清 viewOverride（归 MP2-P-C），落地后本例转绿。
//  - 例 2「∈L 记录节点会话加字段」（MC3-V4 记账：mergedMeta strip 合并 rec 在场覆盖路径
//    （mindEditor.ts :577-587 一带）代码正确但零专钉）：守卫钉，**当前绿**；若红=真缺陷，如实
//    上报归因不硬改。
//  - 例 3「sameAssocLines 删线持久化·部分删中间态」（MC3-V2 N4 后半）：文件 _assoc 双线会话删
//    一线→保存输出仅剩 1 线（MC3d 契约裁决②整表替换：非空写行恰一次、空缺位已删）。「全部删光」
//    空表删行路径另账，本例钉「部分删」中间态。预期即绿或红如实归因。
//  - 例 4「case A+错型字段挂载即脏」（MC3-V4/V5 泛化口径）：⚠ **P2 记账项行为钉（pin 现状）
//    非缺陷**——∈L 记录内错型字段（applyRecord 丢弃→extract 永不复产→strip 删→merged≠
//    savedValue）导致此类文件挂载即脏（闸 2 内容闸也救不了）。已知暗面，P2 批裁决是否特判保留；
//    实现若改判「特判保留不标脏」须回本文件翻转本例（连同例名注记）。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('MP2-P-T 修整批测试钉（视图态转正红例 + ∈L 会话加字段/删线/错型字段守卫钉）', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
  })

  /** 例 4 夹具（case A 泛化形态）：∈L 记录内错型字段——note 为 string（键∈L 前提面）+
   *  tags 错型（非 string 数组，applyRecord decorations.ts:109-113 warnDrop 丢弃、零 tag 注入） */
  const MIND_TEXT_BADTYPE = [
    'mindmap',
    '%% meta: schema=v1',
    '%% meta: 根主题/分支A {"note":"n","tags":"not-array"}',
    '  根主题',
    '    分支A',
    '    分支B',
  ].join('\n')

  it('MP2-P（MP1-UI-R P2-1）保存后视图态转正：切 layout=fishbone→timeline→保存成功→再编辑一处文本→reset 后 select 回显=已存盘视图 timeline（非打开时 fishbone）+再保存输出 layout=timeline 不回退——现实现预期双红（save 不转正 viewOverride→reset 回显回退 fishbone+输出回退 fishbone），MP2-P-C 落地转绿（兼 MC3-V2 N5 面注入）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm, onDirty } = await mount({ text: MIND_TEXT_META, putObject })
    seedViewFace(mm) // 真引擎切换 API 面（setLayout 记录+opt 回写——MP1 既有手法）
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META)) // 正文未编辑
    // 会话切换：fishbone→timeline（viewOverride 覆写+显式 markDirty——MP1 切换行为例已钉）
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'timeline')
    // 保存成功：_mindview 行落 timeline（MP1 持久化「保字段」例已钉的既有行为——本例前置面）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out1 = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(parseMindMeta(out1).mindview, '前置面：保存已把 timeline 落盘（既有 MP1 行为）').toEqual({
      layout: 'timeline',
      theme: 'xm-blue',
    })
    // 再编辑一处文本（data_change→dirty 重新翻真）——建模「保存后用户继续编辑再反悔 reset」
    const edited = toEngineTree(parseMindmap(MIND_TEXT_META))
    edited.children[0]!.data.text = '分支A改'
    engine.state.dataTree = edited
    mm.emit('node_tree_render_end') // 闸 1 基线闩（本例不挂 command——data_change 直通标脏，既有口径）
    mm.emit('data_change')
    expect(onDirty).toHaveBeenCalledWith(true)
    // resetToSaved（放弃未保存修改）
    const resetBtn = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='reset']")
    expect(resetBtn, '统一工具栏重置钮应在容器子树内').not.toBeNull()
    resetBtn!.click()
    await vi.waitFor(() => expect(onDirty).toHaveBeenCalledWith(false))
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META)) // 真引擎 setData 后现态=重喂 mount 树（mock 需手工回灌）
    // 断言①（红形态一）：reset 后布局回显=已存盘视图 timeline，非打开时视图 fishbone
    // （现实现 resetToSaved 回显还原 mount 现效值 layout='fishbone'→在此红）
    expect(mindViewSelectOf(el, 'layout').value, 'reset 后布局回显须=已存盘 timeline（保存转正基线）').toBe('timeline')
    // 断言②（红形态二）：再保存输出 layout=timeline 不回退 fishbone
    // （现实现 viewOverride 已被 reset 清空→mindview 沿文件 meta.mindview=fishbone→在此红）
    putObject.mockClear()
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out2 = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(parseMindMeta(out2).mindview, 'reset 后再保存不回退已存盘视图态').toEqual({ layout: 'timeline', theme: 'xm-blue' })
  })

  it('MP2-P（MC3-V4 记账）∈L 记录节点会话加字段守卫钉（当前绿）：文件记录 {note,hyperlink}（键∈L）+会话 onEdit({tags}) → 保存输出记录={note/hyperlink 旧值保留, tags 新增}（strip 合并 rec 在场覆盖路径——:519-522 一带代码正确但零专钉，本例补钉；红=真缺陷须归因上报）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ text: MIND_TEXT_NODEMETA, putObject })
    // 引擎现态=mount 同链装饰树（克隆域口径同既有守卫例——分支A data 已含 note/hyperlink 注入）
    const tree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_NODEMETA)), parseMindMeta(MIND_TEXT_NODEMETA))
    engine.state.dataTree = tree
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    const nodeA = tree.children[0]! // 分支A（记录键∈L：note 为 string）
    mm.emit('node_active', nodeA, [nodeA]) // 激活→面板回填（既有接线）
    const onEdit = panelHolder.state.created[0]!.opts.onEdit as (patch: Record<string, unknown>) => void
    onEdit({ tags: ['x'] }) // 会话再加字段（面板键 tags；tags→tag 映射=MC3-F1 P1-1 已钉面不重复断言）
    nodeA.data.tag = ['x'] // 模拟真引擎 SET_NODE_DATA 落 data（既有手法）
    mm.emit('data_change')
    expect(onDirty, '链路前置面：会话编辑翻脏（无 command 闸 2 直通）').toHaveBeenCalledWith(true)
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const rec = parseMindMeta(await blobText(putObject.mock.calls[0]![1] as Blob)).nodeMeta.get(
      buildNodeKey(['根主题', '分支A']),
    )
    expect(rec, '记录仍在场').toBeDefined()
    expect(rec?.note, '旧值 note 保留（rec 在场覆盖路径不得丢 base 装饰字段）').toBe('旧注')
    expect(rec?.hyperlink, '旧值 hyperlink 保留').toBe('https://example.com/a')
    expect(rec?.tags, '会话新增 tags 落盘').toEqual(['x'])
  })

  it('MP2-P（MC3-V2 N4 后半）sameAssocLines 删线持久化钉·部分删中间态：文件 _assoc 双线→会话删其中一线（from 节点 targets 清空）→保存输出 _assoc 仅剩 1 线（整表替换：非空写行恰一次+空缺位已删）——「全部删光」空表删行路径另账，本例钉「部分删」中间态', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el } = await mount({ text: MIND_TEXT_ASSOC, putObject })
    const meta = parseMindMeta(MIND_TEXT_ASSOC)
    // 引擎现态=mount 同链装配树（MC3d 保存链例同口径），随后模拟引擎内删除 B→根主题 线：
    // 引擎删线=自 from 节点 targets 摘除该线 uid（AssociativeLine removeLine 面）——分支B targets
    // 清空（空数组/键删除两形态在 extract 同收敛：Array.isArray 闸+空循环零产线）
    const tree = applyAssociativeLines(applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_ASSOC)), meta), meta)
    tree.children[1]!.data.associativeLineTargets = [] // 分支B（B→根主题 线的 from 节点）
    engine.state.dataTree = tree
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    const parsed = parseMindMeta(out)
    expect(parsed.assoc, '部分删后 _assoc 行仍在场（仅剩 1 线≠整行移除）').not.toBeNull()
    expect(parsed.assoc!.lines, '输出仅剩 A→B 一线（B→根主题 空缺位已删，extract 整表接管）').toEqual([
      { from: '根主题/分支A', to: '根主题/分支B', text: '相关' },
    ])
    expect((out.match(/%% meta: _assoc/g) ?? []).length, '恰一次（整表替换禁 concat 双发射）').toBe(1)
  })

  it('MP2-P（V4/V5 泛化口径）case A+错型字段挂载即脏·行为钉（P2 记账项行为钉：错型字段文件挂载即脏=已知暗面，P2 批裁决是否特判保留——非缺陷报告，实现翻面须回此翻转）：∈L 记录 {note,tags:"not-array"}→mount 后 data_change→is-dirty 翻真（错型字段 applyRecord 丢弃→extract 永不复产→strip 删→merged≠savedValue，闸 2 内容闸也救不了）+保存输出记录丢错型字段', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ text: MIND_TEXT_BADTYPE, putObject })
    // 引擎现态=mount 同链装饰树——错型 tags 被 applyRecord 丢弃（分支A data 仅 note 注入、零 tag）
    engine.state.dataTree = applyDecorations(toEngineTree(parseMindmap(MIND_TEXT_BADTYPE)), parseMindMeta(MIND_TEXT_BADTYPE))
    mm.command = {} // 闸 2 内容闸启用——暗面完整形态：连内容闸也判「保存会改字节」（merged≠savedValue）
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    mm.emit('data_change') // 初始化式 data_change——挂载即脏（真引擎初始化噪声/任意触碰即翻红）
    expect(onDirty, '行为钉：此类文件挂载即脏（错型字段不可往返→闸 2 判「保存会改字节」）').toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(true)
    // 字节面（strip 删链证据）：保存输出记录={note:'n'}——错型 tags 被 strip 删除（即闸 2 判脏的 diff 本体）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const rec = parseMindMeta(await blobText(putObject.mock.calls[0]![1] as Blob)).nodeMeta.get(
      buildNodeKey(['根主题', '分支A']),
    )
    expect(rec, '保存输出记录丢错型字段（strip 删：extract 永不复产错型 tags）').toEqual({ note: 'n' })
  })
})

// ═══════════════ MP2-Q-T 追加块：快赢小批补测试钉（测试先行——例 1 预期红 / 例 2 飞行窗钉出 / 例 3-4 守卫绿钉） ═══════════════
// 记账正本：.claude/mind-loop-state.md MP2-P-R 行（P2×4 记账+钉缺口×2——本批收其中四项：P2-1
// savedValue 不随保存刷新、洞 A save 飞行窗切换竞态、钉缺口①无 _mindview 转正组合、钉缺口②转正后
// 部分覆写轴回退）。四例全追加于文件尾（既有 80 例零字节改动）：
//  - 例 1「保存后 savedValue 刷新」（MP2-P-R P2-1）：**预期红**——现 savedValue 为 mount 期 const
//    （mindEditor.ts savedValue 行），save 成功路径只转正视图基线、不刷新 savedValue → 保存后再遇
//    「引擎内容==已存」的 data_change 被判脏。业务修复面（归 MP2-Q-C）=savedValue 改 let+保存成功
//    后刷新为本次落盘 value，落地后本例转绿。
//  - 例 2「save 飞行窗切换不被吞」（MP2-P-R 洞 A）：putObject 返回手动 resolve 的 pending promise
//    制造飞行窗（save 同步前缀跑到 await putObject 才挂起=窗内时序在克隆域确定性可控，无需降级）。
//    现实现预期红：save 收尾 `viewOverride.layout = undefined` 无条件清空吞掉飞行窗覆写（丢偏好）。
//    修复面（归 MP2-Q-C）=await 前快照 CAS 清除（只清飞行前已捕获的轴）。
//  - 例 3「无 _mindview 文件转正组合」（钉缺口①）：守卫绿钉——无 _mindview fixture 切 fishbone→
//    保存（转正落盘+基线转正）→编辑→reset→回显=已存盘视图+再保存不回退「无 _mindview 行」态。
//    红=MP2-P-C 转正链回归。
//  - 例 4「转正后部分覆写轴回退」（钉缺口②）：守卫绿钉——部分覆写（只切一轴）保存时未覆写轴沿
//    已转正基线回退、不回退文件 meta 值。brief 原案（{fishbone,xm-blue} 只切 theme）文件值与基线
//    同轴、值相等无区分度（回退链走基线或走文件值产物相同），按 brief 授权先切 timeline 保存转正
//    错开一轴=最小区分钉面（注记见例内）。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('MP2-Q-T 快赢小批补测试钉（savedValue 保存后刷新红例 + save 飞行窗覆写/无 _mindview 转正组合/部分覆写轴回退守卫钉）', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
  })

  it('MP2-Q（MP2-P-R P2-1）保存后 savedValue 刷新：编辑→保存成功→「引擎内容==落盘 value」的 data_change（undo 回落盘基线形态）→ 闸 2 判「内容==已存」不脏（is-dirty 保持假）——现实现预期红：savedValue 为 mount 期 const 不随保存刷新→同内容被判脏（onDirty 复翻+is-dirty 翻真），MP2-Q-C（savedValue 改 let+保存成功刷新为落盘 value）落地转绿', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ putObject })
    mm.command = {} // 闸 2 内容闸启用——P2-1 面=闸 2 的 savedValue 比对（无 command 时 data_change 无条件标脏，闸面缺席）
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    // 编辑分支A：现态序列化 ≠ savedValue（此时仍=打开时文本）→ 闸 2 放行标脏（修复前后同真：保存尚未发生）
    const edited = toEngineTree(parseMindmap(MIND_TEXT))
    edited.children[0]!.data.text = '分支A改'
    engine.state.dataTree = edited
    mm.emit('data_change')
    expect(onDirty, '前置面：编辑翻脏（修复前后同真）').toHaveBeenCalledWith(true)
    // 保存成功：落盘 value=编辑后序列化；修复面=此后 savedValue 随之刷新为本次落盘 value
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(onDirty).toHaveBeenCalledWith(false) // 保存成功清脏（既有链）
    // 「undo 回基线」mock 可钉形态（brief 两形态择后者，注记）：FakeMindMap.execCommand 只录命令名
    // 不演化历史，引擎 BACK 钉不出内容回退——按 brief 备选形态直接还原 dataTree 到落盘内容+
    // data_change（真引擎触发面=BACK→backForward 路径 Render.js:752 重发 data_change，内容判据
    // 与此同构）。还原目标=落盘 value（保存时基线）而非打开时文本：MC4-F 既定口径「undo 回基线
    // （内容==已存）同样忽略」的基线在保存后=已存内容；打开时文本在修复后≠已存=真脏，非本例面
    // （brief 括注「gate 2 对比刷新后 savedValue==引擎序列化→相等→不脏」的唯一自洽落点）
    const dirtyCallsBefore = onDirty.mock.calls.length
    engine.state.dataTree = edited // 引擎回到落盘内容（内容==已存）
    mm.emit('data_change') // 闸 2 对比「刷新后 savedValue==引擎序列化」→相等→早退不脏
    // 断言①（红形态一）：不产生新的标脏流量（现实现 savedValue 恒=打开时文本→edited≠savedValue→markDirty 复调）
    expect(onDirty.mock.calls.length, '「内容==已存」的 data_change 不得复翻脏（savedValue 须随保存刷新）').toBe(dirtyCallsBefore)
    // 断言②（红形态二）：is-dirty 保持假（保存已清脏，闸 2 早退不得回翻）
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'is-dirty 须保持假（内容==已存判不脏）').toBe(false)
  })

  it('MP2-Q（MP2-P-R 洞 A）save 飞行窗切换不被吞：putObject pending 飞行窗内切 layout=fishbone → resolve 保存完成 → 飞行窗覆写存活（等价可断言形态：再次保存输出含飞行窗 layout；viewOverride 闭包不可直观测，经落盘产物钉）——现实现预期红：save 收尾无条件清 viewOverride 吞掉飞行窗切换（输出无 _mindview 行），MP2-Q-C（await 前快照 CAS 清除）落地转绿', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面）
      .mockResolvedValueOnce(undefined) // 二次保存（断言面）即时成功
    const { el, mm, surface } = await mount({ text: MIND_TEXT, putObject })
    seedViewFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 正文未编辑
    saveBtnOf(el).click() // 保存起飞：mergedMeta 已在 await 前算完（覆写空），挂起于 await putObject
    await flush()
    expect(putObject, '前置面：保存已入飞行窗（putObject 已调且 pending 未决）').toHaveBeenCalledTimes(1)
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'fishbone') // 飞行窗内切换（viewOverride.layout 记录+setLayout+显式 markDirty——MP1 切换口径）
    resolvePut() // 放行：保存完成（收尾链随微任务排空跑完）
    await flush()
    // 断言面：飞行窗内切换的 layout 须进第二次保存输出（现实现：收尾 `viewOverride.layout = undefined`
    // 无条件清空→覆写被吞→输出无 _mindview 行=红；修复=只清飞行前快照捕获的轴→覆写存活）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(2))
    const out = await blobText(putObject.mock.calls[1]![1] as Blob)
    expect(parseMindMeta(out).mindview, '飞行窗内切换的 layout 须存活进落盘记录（不得被 save 收尾清空吞掉）').toEqual({ layout: 'fishbone', theme: 'xm-green' })
    expect(out).toContain('%% meta: _mindview {"layout":"fishbone","theme":"xm-green"}')
    surface.dispose() // 清理（飞行窗已 resolve、收尾已跑完，dispose 安全）
  })

  it('MP2-Q（MP2-P-R 钉缺口①）无 _mindview 文件转正组合守卫（绿钉）：无 _mindview fixture 切 fishbone→保存（转正落盘）→编辑→reset→回显=fishbone/xm-green（=已存盘视图）+再保存仍输出已转正记录（不回退「无 _mindview 行」态）——红=MP2-P-C 转正链回归', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm, onDirty } = await mount({ text: MIND_TEXT, putObject })
    seedViewFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 正文未编辑
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'fishbone')
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out1 = await blobText(putObject.mock.calls[0]![1] as Blob)
    // 前置面（转正落盘）：无 _mindview 文件首次保存合成 {fishbone, xm-green} 恰一次（MP1「持久化（新增行）」例同钉）
    expect(parseMindMeta(out1).mindview, '前置面：首次保存已把 fishbone 落盘（MP1 既有行为）').toEqual({ layout: 'fishbone', theme: 'xm-green' })
    expect((out1.match(/%% meta: _mindview/g) ?? []).length, '恰一次').toBe(1)
    // 再编辑（reset 前置：resetToSaved 对非 dirty 早退）
    const edited = toEngineTree(parseMindmap(MIND_TEXT))
    edited.children[0]!.data.text = '分支A改'
    engine.state.dataTree = edited
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    mm.emit('data_change')
    expect(onDirty).toHaveBeenCalledWith(true)
    const resetBtn = el.querySelector<HTMLButtonElement>( ".mmx-edt__btn[data-act='reset']")
    expect(resetBtn, '统一工具栏重置钮应在容器子树内').not.toBeNull()
    resetBtn!.click()
    await vi.waitFor(() => expect(onDirty).toHaveBeenCalledWith(false))
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 真引擎 setData 后现态=重喂 mount 树（mock 需手工回灌，MP2-P-T 例 1 同手法）
    // 断言①（回显面）：reset 后布局/主题回显=已转正基线（fishbone/xm-green=已存盘视图），非打开时缺省（logicalStructure）
    expect(mindViewSelectOf(el, 'layout').value, 'reset 后布局回显=已存盘 fishbone（基线随保存转正）').toBe('fishbone')
    expect(mindViewSelectOf(el, 'theme').value, 'reset 后主题回显=基线缺省轴 xm-green').toBe('xm-green')
    // 断言②（基线面）：reset 后再保存仍输出已转正记录——不回退「无 _mindview 行」态（打开时视图）
    putObject.mockClear()
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out2 = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(parseMindMeta(out2).mindview, 'reset 后再保存沿已转正基线（不回退打开时无 _mindview 状态）').toEqual({ layout: 'fishbone', theme: 'xm-green' })
    expect((out2.match(/%% meta: _mindview/g) ?? []).length, '恰一次').toBe(1)
  })

  it('MP2-Q（MP2-P-R 钉缺口②）转正后部分覆写轴回退守卫（绿钉）：{fishbone,xm-blue} 先切 timeline 保存转正（基线.layout=timeline≠文件 fishbone）→只切 theme=xm-slate→保存→未覆写 layout 轴沿已转正基线（timeline）回退、不回退文件值 fishbone→再编辑→保存仍沿基线——【注记】brief 原案文件值与基线同轴（都 fishbone）钉不出「回退链走基线 vs 走文件值」（值相等无区分度），按 brief 授权先转正错开一轴=最小区分钉面', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm } = await mount({ text: MIND_TEXT_META, putObject })
    seedViewFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META)) // 正文未编辑
    // 第一步（转正错开轴）：切 layout=timeline→保存——落盘 {timeline, xm-blue}+基线转正（MP1「保字段」例同钉前置面）
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'timeline')
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out1 = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(parseMindMeta(out1).mindview, '前置面：timeline 已落盘+基线转正（基线.layout≠文件 fishbone）').toEqual({ layout: 'timeline', theme: 'xm-blue' })
    // 第二步（部分覆写本体）：只切 theme=xm-slate（layout 轴本步未覆写——viewOverride={theme:'xm-slate'}）→保存
    dispatchViewChange(mindViewSelectOf(el, 'theme'), 'xm-slate')
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(2))
    const out2 = await blobText(putObject.mock.calls[1]![1] as Blob)
    // 断言本体（钉缺口②）：完整记录 layout-first 重写，未覆写 layout 轴沿基线 timeline 回退——
    // 回退链若误读文件值（meta.mindview.layout=fishbone）即在此红
    expect(parseMindMeta(out2).mindview, '未覆写 layout 轴沿已转正基线 timeline（不回退文件值 fishbone）').toEqual({ layout: 'timeline', theme: 'xm-slate' })
    expect(out2).toContain('%% meta: _mindview {"layout":"timeline","theme":"xm-slate"}')
    expect((out2.match(/%% meta: _mindview/g) ?? []).length, '恰一次').toBe(1)
    expect(out2).toContain('%% meta: schema=v1')
    // 第三步（沿 brief「再编辑→保存」形态）：无覆写+已转正再保存仍沿基线（不回退文件值；与 MP2-P-T
    // 例 1 断言②同族——彼例经 reset、本例不 reset 直链补全）
    const edited = toEngineTree(parseMindmap(MIND_TEXT_META))
    edited.children[0]!.data.text = '分支A改'
    engine.state.dataTree = edited
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    mm.emit('data_change')
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(3))
    const out3 = await blobText(putObject.mock.calls[2]![1] as Blob)
    expect(parseMindMeta(out3).mindview, '无覆写+已转正：再保存沿基线 {timeline, xm-slate}（不回退文件值 fishbone/xm-blue）').toEqual({ layout: 'timeline', theme: 'xm-slate' })
  })
})

// ═══════════════ MP2-Q2-T 追加块：快赢池二批测试钉（MP2-R1 P2-1 红例 + 钉缺口五绿钉） ═══════════════
// 记账正本：.claude/mind-loop-state.md MP2-R1 行（MP2-E1+MP2-Q 联合评审=双通过；P2-1「save 收尾
// dirty=false 无条件 vs CAS 存活覆写=窗内切视图后活覆写脏标假」入快赢池；钉缺口×5 记账——readonly
// stance/select 复位/多轮刷新序列/失败重试不刷新/doExport 缺席 no-op——本批全收）。六例全追加于
// 文件尾 MP2-Q-T describe 之后（既有 90 例零字节改动；并行 MP2-X1-T 追加区段零重叠）：
//  - 例 1「飞行窗覆写存活后 dirty 保持真」（MP2-R1 P2-1）：**预期红**——MP2-Q-T 例 2 飞行窗链的
//    延长：putObject pending→窗内切 layout→resolve→保存完成→断言 is-dirty 保持真（CAS 存活的
//    viewOverride=活覆写，下次保存必改字节）。现实现 save 收尾 dirty=false 无条件（mindEditor.ts
//    :868-872 CAS 后置假三连）→双红。业务修复面（归 MP2-Q2-C）=置假前查 viewOverride 残轴
//    （layout/theme 任一在场则保持脏），落地后本例转绿。
//  - 例 2-6（钉缺口绿钉）：readonly 导出/大纲可用 stance（家族口径=视图态零写路径不闩，MP2-R1
//    评审「大纲钮同族口径」在案）/导出 select 复位回首项（mindEditor.ts :481 动作非状态）/
//    多轮保存刷新序列（savedValue 随最后一次保存）/保存失败→重试成功刷新（失败不刷新+重试产物
//    刷新）/doExport 缺席静默 no-op（cast optional 防护面）。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('MP2-Q2-T 快赢池二批测试钉（飞行窗活覆写 dirty 红例 + readonly stance/select 复位/多轮刷新/失败重试/doExport 缺席绿钉）', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
    outlineHolder.state.created.length = 0
    searchHolder.state.created.length = 0
  })

  it('MP2-Q2（MP2-R1 P2-1）飞行窗覆写存活后 dirty 保持真：putObject pending→窗内切 layout=fishbone→resolve 保存完成→is-dirty 保持真（CAS 存活覆写=活覆写，下次保存必改字节）——现实现预期红：save 收尾 dirty=false 无条件（mindEditor.ts :868-872），MP2-Q2-C（置假前查覆写残轴）落地转绿', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面，MP2-Q-T 例 2 同手法）
      .mockResolvedValueOnce(undefined)
    const { el, onDirty, surface } = await mount({ text: MIND_TEXT, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 正文未编辑
    saveBtnOf(el).click() // 保存起飞：mergedMeta 已在 await 前算完（覆写空），挂起于 await putObject
    await flush()
    expect(putObject, '前置面：保存已入飞行窗（putObject 已调且 pending 未决）').toHaveBeenCalledTimes(1)
    dispatchViewChange(mindViewSelectOf(el, 'layout'), 'fishbone') // 窗内切换：viewOverride.layout 记录+显式 markDirty（MP1 切换口径——引擎切换无 data_change 侧信道）
    expect(saveBtnOf(el).classList.contains('is-dirty'), '前置面：窗内切换已翻脏').toBe(true)
    resolvePut() // 放行：保存完成（收尾链随微任务排空——CAS 判 layout 轴 'fishbone'≠飞行前快照 undefined→覆写存活）
    await flush()
    // 断言①（红形态一）：is-dirty 保持真——活覆写在场=下次保存必改字节，收尾不得无条件置假
    // （现实现 :868-872 CAS 后 dirty=false/setDirty(false)/onDirty(false) 无条件三连→在此红）
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'CAS 存活覆写在场：dirty 须保持真（置假前须查 viewOverride 残轴）').toBe(true)
    // 断言②（红形态二）：同语义的通道面——收尾不得随本次发出 onDirty(false)（活覆写=视图态仍有未落盘变更）
    expect(onDirty, '收尾 onDirty(false) 不得发出（活覆写=下次保存仍会改字节）').not.toHaveBeenCalledWith(false)
    surface.dispose() // 清理（飞行窗已 resolve、收尾已跑完，dispose 安全）
  })

  it('MP2-Q2（MP2-R1 钉缺口·readonly stance）readonly 导出四格式+开大纲可用且 onDirty 零调（绿钉·钉现状 stance）：4305 闩锁后 png/svg/json 引擎面照常透传+opml 业务面照常下载+大纲照常开启，全程零脏信号——家族口径=导出/大纲均为视图态零写路径（readonly 不闩，MP2-R1 评审「大纲钮同族口径」在案）；红=闩锁误伤视图态控件或导出/大纲误标脏', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { el, mm, onDirty, onReadonly } = await mount({ putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 闩锁须走完保存链至 putObject 抛 4305；后续导出/大纲数据源同此
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1)) // 闩锁在场（readonly=true）
    const face = seedExportFace(mm)
    // 导出 png/svg/json：闩锁后引擎面照常透传（readonly 不闩导出）
    for (const fmt of ['png', 'svg', 'json'] as const) dispatchExport(exportSelectOf(el), fmt)
    expect(face.export.mock.calls.map((c) => c[0]), '闩锁后引擎面导出三格式照常可用').toEqual(['png', 'svg', 'json'])
    for (const c of face.export.mock.calls) {
      expect(c[1], 'isDownload=true 语义不因 readonly 变化').toBe(true)
      expect(c[2], '导出名=文件名去扩展（四格式同名族）').toBe('demo')
    }
    // 导出 opml：闩锁后业务面下载照常可用
    const downloads: string[] = []
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      if (this instanceof HTMLAnchorElement) downloads.push(this.getAttribute('download') ?? '')
    })
    dispatchExport(exportSelectOf(el), 'opml')
    clickSpy.mockRestore()
    expect(downloads, '闩锁后 opml 业务面下载照常可用（demo.opml）').toEqual(['demo.opml'])
    // 开大纲：闩锁后照常可开（视图态零写路径——readonly 闩只禁搜索 Ctrl+F 与保存，大纲不受闩）
    outlineBtnOf(el).click()
    expect(outlineHolder.state.created, '闩锁后大纲工厂照常创建（视图态零写路径不闩）').toHaveLength(1)
    expect(outlineHolder.state.created[0]!.api.show, '大纲照常开启').toHaveBeenCalled()
    // stance 本体：全程 onDirty 零调（readonly 下 markDirty 自早退+导出/大纲零写路径——不产生脏信号）
    expect(onDirty, 'stance 守卫：导出/大纲全程零脏信号').not.toHaveBeenCalled()
  })

  it('MP2-Q2（MP2-R1 钉缺口·select 复位）导出 select 复位回首项（绿钉·动作非状态）：change→svg 派发导出后 select 复位回首项 png（selectedIndex=0/value 首项）+复位后控件可再次派发（png 引擎面照常触发）——红=复位链回归（select 停留在已选格式=动作状态化）', async () => {
    const { el, mm } = await mount()
    const face = seedExportFace(mm)
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    const sel = exportSelectOf(el)
    expect(sel.value, '前置面：mount 初值=首项 png').toBe('png')
    dispatchExport(sel, 'svg')
    expect(face.export, '前置面：导出确已派发（复位非因派发失败）').toHaveBeenCalledTimes(1)
    expect(face.export.mock.calls[0]![0]).toBe('svg')
    expect(sel.selectedIndex, '派发后复位回首项（selectedIndex=0——动作非状态）').toBe(0)
    expect(sel.value, '复位后 value=首项 png').toBe('png')
    dispatchExport(sel, 'png')
    expect(face.export, '复位后控件仍可用：再次派发照常触发引擎面（可重复动作语义）').toHaveBeenCalledTimes(2)
    expect(face.export.mock.calls[1]![0]).toBe('png')
  })

  it('MP2-Q2（MP2-R1 钉缺口·多轮刷新）多轮保存刷新序列（绿钉）：编辑→保存→再编辑→保存→undo 回第二次基线（内容==第二次落盘 value）→不脏（is-dirty 保持假）；对照腿：回第一次基线=新增标脏（savedValue 须随最后一次保存走）——红=savedValue 刷新链回归（停在首存或重置回打开时文本）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { mm, onDirty, el } = await mount({ putObject })
    mm.command = {} // 闸 2 内容闸启用（本例脏判全走内容比对）
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    // 第一轮：编辑分支A→保存（savedValue 刷新为第一落盘 value）
    const editedA = toEngineTree(parseMindmap(MIND_TEXT))
    editedA.children[0]!.data.text = '分支A改'
    engine.state.dataTree = editedA
    mm.emit('data_change')
    expect(onDirty, '前置面：第一轮编辑翻脏').toHaveBeenCalledWith(true)
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(onDirty).toHaveBeenCalledWith(false)
    // 第二轮：再编辑→保存（savedValue 须刷新为第二落盘 value）
    const editedB = toEngineTree(parseMindmap(MIND_TEXT))
    editedB.children[0]!.data.text = '分支A再改'
    engine.state.dataTree = editedB
    mm.emit('data_change')
    expect(onDirty, '前置面：第二轮编辑翻脏').toHaveBeenCalledWith(true)
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(2))
    expect(onDirty).toHaveBeenCalledWith(false)
    // 主断言：undo 回第二次基线（引擎内容==第二落盘 value）→ 闸 2 相等早退——零新标脏+is-dirty 保持假
    const callsBeforeUndo2 = onDirty.mock.calls.length
    engine.state.dataTree = editedB
    mm.emit('data_change')
    expect(onDirty.mock.calls.length, '回第二次基线不得复翻脏（savedValue==第二落盘 value，闸 2 相等早退）').toBe(callsBeforeUndo2)
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'is-dirty 保持假').toBe(false)
    // 对照腿（钉「随最后一次保存走」）：回第一次基线（内容==第一落盘 value≠第二落盘）→ 闸 2 判真
    // 编辑新增一次标脏——若 savedValue 误停在首存 value1，此腿相等早退零调=红
    const callsBeforeContrast = onDirty.mock.calls.length
    engine.state.dataTree = editedA
    mm.emit('data_change')
    expect(onDirty.mock.calls.length, '对照腿：回第一次基线须新增标脏（savedValue 已随第二次保存刷新）').toBe(callsBeforeContrast + 1)
    expect(onDirty.mock.calls.at(-1)).toEqual([true])
    expect(saveBtnOf(el).classList.contains('is-dirty'), '对照腿 is-dirty 翻真').toBe(true)
  })

  it('MP2-Q2（MP2-R1 钉缺口·失败重试）保存失败→重试成功刷新（绿钉）：putObject 首调 reject→dirty 保持（失败探针=同内容 data_change 照常翻脏，savedValue 未随失败刷新）→二次保存成功→内容中性 data_change 不翻脏（=savedValue 已按重试产物刷新，闸 2 相等早退）——红=失败误刷新 savedValue 或重试成功后不刷新', async () => {
    const putObject = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(undefined)
    const { mm, onDirty, el } = await mount({ putObject })
    mm.command = {} // 闸 2 内容闸启用
    mm.emit('node_tree_render_end') // 闸 1 基线闩
    const edited = toEngineTree(parseMindmap(MIND_TEXT))
    edited.children[0]!.data.text = '分支A改'
    engine.state.dataTree = edited
    mm.emit('data_change')
    expect(onDirty, '前置面：编辑翻脏').toHaveBeenCalledWith(true)
    // 首存失败：savedValue 不刷新（catch 不达刷新行）——dirty 保持可重试
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    await flush() // catch 收尾排空
    expect(onDirty, '失败后 dirty 保持：onDirty 零 false').not.toHaveBeenCalledWith(false)
    expect(saveBtnOf(el).classList.contains('is-dirty'), '失败后 is-dirty 在场（未保存内容可重试）').toBe(true)
    // 失败探针（钉「失败不刷新」）：同内容 data_change 须照常判脏（savedValue 仍=打开时文本，闸 2
    // 判不等）——若失败误刷新 savedValue，此处相等早退零调=红
    const callsBeforeProbe = onDirty.mock.calls.length
    mm.emit('data_change')
    expect(onDirty.mock.calls.length, '失败探针：同内容 data_change 照常翻脏（savedValue 未随失败刷新）').toBe(callsBeforeProbe + 1)
    // 二次保存成功：savedValue 随重试产物刷新+清脏
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(onDirty).toHaveBeenCalledWith(false))
    expect(saveBtnOf(el).classList.contains('is-dirty')).toBe(false)
    // 内容中性 data_change（引擎现态=重试落盘内容）：闸 2 相等早退不翻脏——savedValue 已按重试产物刷新
    const callsBeforeNeutral = onDirty.mock.calls.length
    mm.emit('data_change')
    expect(onDirty.mock.calls.length, '内容中性 data_change 不得复翻脏（savedValue 已按重试产物刷新）').toBe(callsBeforeNeutral)
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'is-dirty 保持假').toBe(false)
  })

  it('MP2-Q2（MP2-R1 钉缺口·doExport 缺席）doExport 缺席静默 no-op（绿钉）：mock 无 doExport 面（不播种）→触发 png 导出→零异常零 markDirty（cast optional 防护调用面——真引擎 usePlugin(Export) 后才挂载 mm.doExport）', async () => {
    const { el, onDirty } = await mount() // 缺省 mock 实例无 doExport 成员（引擎构造器职责——MP2-E1 块头同口径）
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    const sel = exportSelectOf(el)
    expect(() => dispatchExport(sel, 'png'), 'doExport 缺席：runExport 防护链不得抛').not.toThrow()
    expect(sel.value, 'change 监听器跑完未中断（复位回首项=runExport 无异常旁证）').toBe('png')
    await flush() // runExport 的 void promise 面若有异步异常在此现形
    expect(onDirty, '零 markDirty（导出全链只读——缺席面同样零脏信号）').not.toHaveBeenCalled()
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'is-dirty 保持假').toBe(false)
  })
})

// ═══════════════ MP2-Q3-T 追加块：快赢池三批测试钉（MP2-R2 P2-1/P2-2 红例 + P2-3 钉缺口绿钉） ═══════════════
// 记账正本：.claude/mind-loop-state.md MP2-R2 行（MP2-Q2+MP2-X1 联合评审=双通过；P2-1「导入落
// 飞行窗内 markDirty 被置假吞→dispose 静默丢导入内容」+P2-2「导入无重入闩」入池；P2-3 钉缺口×4
// ——U+200B 两钉/readonly×导入双闸/theme 单轴残轴/残轴→reset 链——本批全收）。
// 七例全追加于文件尾 MP2-Q2 describe 之后（既有 99 例零字节改动）：
//  - 例 1「保存飞行窗内导入被 saving 闩拒」（P2-1）：**已随闩型修复翻转（MP2-Q3-C 落地，
//    授权面内记账）**——原钉（预期红）为「闩不存在时的前置行为」：putObject 手动 pending
//    （MP2-Q-T 例 2 手法）→保存进飞行窗→导入（X1 describe 真 zipSync File 桩手法）落引擎
//    （setData+显式 markDirty）→resolvePut→保存收尾只查 viewOverride 残轴（mindEditor.ts
//    MP2-Q2-C 条件化收尾分支）不查内容脏→置假三连吞导入脏标=dispose 静默丢导入内容。
//    闩型落地（MP2-R2 P2-1 裁决正典：runXmindImport `if (saving) return`，静默拒不加 warn
//    =R2 最小修复集口径）后前置面「窗内导入已落引擎」不可达（闩拒）→本例翻转为闩拒正典钉：
//    窗内触发导入→断言零 setData/零 markDirty/零树变化（闩拒静默）+补一腿「resolvePut 保存
//    收尾后（saving=false）导入照常成功」（闩只在 saving 期间生效，不误伤窗外导入）。
//  - 例 2「导入重入闩」（P2-2）：**预期红**——首链挂起窗（await arrayBuffer）内同 tick 连派两
//    文件→第二链不执行（importBusy 闩拒：setData 恰一次+onDirty(true) 恰一次+存活树=首文件）。
//    现实现无闩两链并发落引擎=setData×2/标脏×2。修复面（归 MP2-Q3-C）=importBusy 闩；若实现
//    走串行化（第二链排队后执行）则计数断言须随实现面翻转（注记）。
//  - 例 3/4「U+200B 空标题占位」绿钉两小例（P2-3 钉缺口）：经 xmindToMindmap 直引（编辑器导入
//    链同源纯函数面，MP2-X1-C 空标题占位裁决的测试钉）——①空 title（空串+纯空白两形态）→占位
//    行在场（U+200B 裸 token、needsQuote 不命中不加包裹）+parseMindmap 不吞（占位节点存活+子级
//    正挂其下，不重挂栈顶祖先）②往返字节稳定（转换→parse→serialize 与直转换字节全等——不吞
//    行/不加包裹/不重排/缩进 canonical 同构）。红=占位策略回归（空标题行被 trim 吞+子级重挂/
//    字节漂移）。
//  - 例 5「readonly×导入双闸」绿钉（P2-3 钉缺口）：4305 闩锁后导入钮 disabled（闸 1=setReadonly
//    禁钮，导入=数据写路径随闩）+编程派发 change 绕钮（闸 2=runXmindImport 处理器 readonly
//    早退兜底）→零 setData/updateData 零 dirty。红=双闸任一失守。
//  - 例 6「theme 单轴残轴守卫」绿钉（P2-3 钉缺口）：MP2-Q2 例 1 的 theme 轴变体——putObject
//    pending→窗内切 theme→resolvePut→is-dirty 保持真+收尾零 onDirty(false)。红=MP2-Q2-C 残轴
//    守卫退化成仅查 layout 轴（theme 轴漏查）。
//  - 例 7「残轴→resetToSaved 链」绿钉（P2-3 钉缺口）：例 6 链延长——残轴 dirty 真存活使 reset
//    闸（`!dirty` 早退）放行→reset 覆写弃置（theme 回显归基线+再保存输出不含窗内覆写）+dirty
//    假。红=reset 闸对残轴 dirty 失效或覆写未弃置。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { xmindToMindmap } from '../../mind/xmindImport'

describe('MP2-Q3-T 快赢池三批测试钉（导入×saving 飞行窗 saving 闩拒+闩窗后导入照常[例 1 已随 MP2-Q3-C 闩型修复翻转成闩拒正典钉] + 导入重入闩[例 2 随闩落地转绿] + U+200B 占位/readonly×导入/theme 残轴/残轴→reset 绿钉）', () => {
  beforeEach(() => {
    panelHolder.state.created.length = 0
    outlineHolder.state.created.length = 0
    searchHolder.state.created.length = 0
  })

  it('MP2-Q3（MP2-R2 P2-1·闩型翻转钉）保存飞行窗内导入被 saving 闩拒：putObject pending→保存进飞行窗→导入（真 zip File 桩）→零 setData/零 markDirty/零树变化（闩拒静默——窗内落引擎会被收尾置假三连吞→dispose 静默丢导入内容）+resolvePut 保存收尾后（saving=false）导入照常成功（闩只在 saving 期间生效）——MP2-Q3-C 落地面：runXmindImport `if (saving) return`（闩型=MP2-R2 裁决正典，静默拒=R2 最小修复集口径；原「窗内落引擎 dirty 保持真」前置行为钉随闩落地翻转，注记见块头）', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面，MP2-Q-T 例 2 同手法）
    const { el, onDirty, surface } = await mount({ text: MIND_TEXT, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 保存序列化源=打开时树
    saveBtnOf(el).click() // 保存起飞：merged/value 已在 await 前算完，挂起于 await putObject（飞行窗开）
    await flush()
    expect(putObject, '前置面：保存已入飞行窗（putObject 已调且 pending 未决）').toHaveBeenCalledTimes(1)
    // 飞行窗内触发导入（MP2-X1 describe 手法：真 zipSync File 桩+change 派发）——saving 闩拒面
    const expected = ['mindmap', '  导入根', '    分支一'].join('\n')
    const zip = mkXmindZip([mkXmindSheet(mkXmindTopic('导入根', [mkXmindTopic('分支一')]))])
    dispatchXmindImport(xmindInputOf(el), new File([zip], 'import.xmind', { type: 'application/xmind' }))
    await new Promise((r) => setTimeout(r, 20)) // 闩失守时导入链飞行窗（X1 失败例 20ms 同域窗宽）
    // 断言①②③（闩拒三零）：零引擎写/零 markDirty/零树变化（静默拒不加 warn=R2 最小修复集口径）
    expect(engine.state.setDataCalls, 'P2-1：saving 闩拒——窗内导入零引擎写（原置假吞脏红例的闩拒正典面）').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（updateData 通道同禁）').toEqual([])
    expect(onDirty, '闩拒链零 markDirty（零标脏）').not.toHaveBeenCalled()
    // 放行：保存收尾链随微任务排空跑完（saving=false，飞行窗闭）
    resolvePut()
    await flush()
    expect(saveBtnOf(el).classList.contains('is-dirty'), '前置面：保存收尾置假三连照常（非脏基线）').toBe(false)
    // 补一腿（闩只在 saving 期间生效）：保存完成后（resolve 后）导入照常成功——闩不误伤窗外导入
    dispatchXmindImport(xmindInputOf(el), new File([zip], 'import.xmind', { type: 'application/xmind' }))
    await vi.waitFor(() => expect(engine.state.setDataCalls, '窗外导入照常落引擎（闩不误伤）').toHaveLength(1))
    expect(engine.state.setDataCalls[0], '引擎收导入等价树').toEqual(toEngineTree(parseMindmap(expected)))
    expect(onDirty, '导入显式 markDirty 已翻真').toHaveBeenCalledWith(true)
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'is-dirty 在场（导入脏标）').toBe(true)
    surface.dispose() // 清理（飞行窗已 resolve）
  })

  it('MP2-Q3（MP2-R2 P2-2）导入重入闩：首链挂起窗（await arrayBuffer）内同 tick 连派第二文件→第二链不执行（setData 恰一次+onDirty(true) 恰一次+存活树=首文件）——现实现预期红：无重入闩两链并发落引擎（setData×2/标脏×2）', async () => {
    const { el, onDirty } = await mount()
    const expectedA = ['mindmap', '  导入甲'].join('\n')
    const zipA = mkXmindZip([mkXmindSheet(mkXmindTopic('导入甲'))])
    const zipB = mkXmindZip([mkXmindSheet(mkXmindTopic('导入乙'))])
    const input = xmindInputOf(el)
    dispatchXmindImport(input, new File([zipA], 'a.xmind', { type: 'application/xmind' }))
    dispatchXmindImport(input, new File([zipB], 'b.xmind', { type: 'application/xmind' })) // 首链 await arrayBuffer 挂起窗内再派（同 tick 连发=「连选两文件」形态）
    await vi.waitFor(() =>
      expect(engine.state.setDataCalls.length, '前置面：至少首链已落引擎').toBeGreaterThanOrEqual(1),
    )
    await new Promise((r) => setTimeout(r, 40)) // 第二链（若未被闩拒）排空窗——X1 失败例 20ms 同域放大
    // 断言①（红形态一）：setData 恰一次（第二链被 importBusy 闩拒；现实现两链并发=×2 → 红）
    expect(engine.state.setDataCalls, '重入窗内第二链不得落引擎（importBusy 闩拒）').toHaveLength(1)
    // 断言②（红形态二）：真 markDirty 恰一次（闩拒链零标脏；现实现 ×2 → 红）
    expect(onDirty.mock.calls.filter((c) => c[0] === true), 'onDirty(true) 恰一次（闩拒链零 markDirty）').toHaveLength(1)
    // 断言③：存活树=首文件（闩拒=先到先得，非被第二文件覆写）
    expect(engine.state.setDataCalls[0]).toEqual(toEngineTree(parseMindmap(expectedA)))
  })

  it('MP2-Q3（MP2-R2 P2-3·U+200B①）空标题占位绿钉：contentJson 含空 title（空串+纯空白两形态）→转换产物占位行在场（U+200B 裸 token、根 2 空格缩进 canonical、needsQuote 不命中不加包裹）+parseMindmap 不吞（占位节点存活+子级正挂其下，不重挂栈顶祖先）——红=占位策略回归（空标题行被 trim 吞+子级重挂）', () => {
    const empty = xmindToMindmap([mkXmindSheet(mkXmindTopic('', [mkXmindTopic('子甲')]))])
    expect(empty.split('\n'), '占位行在场：空串 title → U+200B 裸 token（MP2-X1-C 空标题占位裁决的测试钉）').toEqual([
      'mindmap',
      '  \u200B',
      '    子甲',
    ])
    const tree = toEngineTree(parseMindmap(empty))
    expect(tree.data.text, 'parseMindmap 不吞：占位节点以 U+200B 文本存活（trim 白名单不含 U+200B）').toBe('\u200B')
    expect(tree.children.map((c) => c.data.text), '子级正挂占位节点下（trim 吞行回归=子级重挂即在此红）').toEqual(['子甲'])
    // 纯空白 title 同走占位通道（trim 后空=同一分支——「空串与空格均被 parseMindmap trim 吞行」陷阱面）
    const blank = xmindToMindmap([mkXmindSheet(mkXmindTopic('   ', [mkXmindTopic('子乙')]))])
    expect(blank.split('\n'), '纯空白 title 同走占位通道').toEqual(['mindmap', '  \u200B', '    子乙'])
    expect(toEngineTree(parseMindmap(blank)).children.map((c) => c.data.text), '纯空白形态子级同正挂').toEqual(['子乙'])
  })

  it('MP2-Q3（MP2-R2 P2-3·U+200B②）往返字节稳定绿钉：转换→parseMindmap→serializeMindmap 与直转换字节全等（占位 token 往返零漂移——不吞行/不加包裹/不重排/缩进 canonical 同构）——红=占位往返漂移', () => {
    const text = xmindToMindmap([mkXmindSheet(mkXmindTopic('', [mkXmindTopic('子甲', [mkXmindTopic('孙乙')])]))])
    expect(serializeMindmap(parseMindmap(text)), '转换→parse→serialize 与直转换字节全等（三层含占位根）').toBe(text)
  })

  it('MP2-Q3（MP2-R2 P2-3·readonly×导入双闸）绿钉：4305 闩锁后导入钮 disabled（闸 1=setReadonly 禁钮，导入=数据写路径随闩）+编程派发 change 绕钮（闸 2=runXmindImport 处理器 readonly 早退兜底）→零 setData/updateData 零 dirty——红=双闸任一失守', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { el, onDirty, onReadonly } = await mount({ putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 闩锁须走完保存链至 putObject 抛 4305
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1))
    // 闸 1：setReadonly 禁导入钮（undo/redo 同族口径——写路径随闩）
    expect(xmindImportBtnOf(el).disabled, '闸 1：闩锁后导入钮 disabled').toBe(true)
    // 闸 2：编程派发 change（绕过 disabled 钮的兜底面——双闸语义本体）
    const zip = mkXmindZip([mkXmindSheet(mkXmindTopic('导入根'))])
    dispatchXmindImport(xmindInputOf(el), new File([zip], 'import.xmind', { type: 'application/xmind' }))
    await new Promise((r) => setTimeout(r, 20)) // 闸失守时导入链飞行窗（X1 失败例同域窗宽）
    expect(engine.state.setDataCalls, '闸 2：readonly 早退——零引擎写').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（updateData 通道同禁）').toEqual([])
    expect(onDirty, '零 dirty（处理器早退未触达 markDirty+readonly markDirty 自早退双保险）').not.toHaveBeenCalled()
  })

  it('MP2-Q3（MP2-R2 P2-3·theme 单轴残轴）绿钉（MP2-Q2 例 1 的 theme 轴变体）：putObject pending→窗内切 theme=xm-slate（残轴存活）→resolvePut→is-dirty 保持真+收尾零 onDirty(false)——红=残轴守卫退化成仅查 layout 轴（theme 轴漏查）', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面，MP2-Q2 例 1 同手法，轴改 theme）
    const { el, onDirty, surface } = await mount({ text: MIND_TEXT, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 正文未编辑
    saveBtnOf(el).click() // 保存起飞
    await flush()
    expect(putObject, '前置面：保存已入飞行窗').toHaveBeenCalledTimes(1)
    dispatchViewChange(mindViewSelectOf(el, 'theme'), 'xm-slate') // 窗内切 theme：viewOverride.theme 记录+显式 markDirty（MP1 切换口径）
    expect(saveBtnOf(el).classList.contains('is-dirty'), '前置面：窗内切换已翻脏').toBe(true)
    resolvePut() // 放行：CAS 判 theme 轴 'xm-slate'≠飞行前快照 undefined→残轴存活
    await flush()
    // 断言①：is-dirty 保持真——theme 残轴在场=下次保存必改字节（残轴守卫须两轴齐查）
    expect(saveBtnOf(el).classList.contains('is-dirty'), 'theme 残轴在场：dirty 须保持真').toBe(true)
    // 断言②：收尾不得随本次发出 onDirty(false)
    expect(onDirty, '收尾 onDirty(false) 不得发出（theme 活覆写=下次保存仍会改字节）').not.toHaveBeenCalledWith(false)
    surface.dispose() // 清理（飞行窗已 resolve）
  })

  it('MP2-Q3（MP2-R2 P2-3·残轴→reset 链）绿钉（例 6 链延长）：残轴 dirty 真存活使 reset 闸（!dirty 早退）放行→reset 覆写弃置（theme 回显归基线 xm-blue）+dirty 假+再保存输出不含窗内覆写（xm-slate 不落盘）——红=reset 闸对残轴 dirty 失效或覆写未弃置', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（残轴制造面，例 6 同源链）
      .mockResolvedValueOnce(undefined) // reset 后再保存（覆写弃置断言面）即时成功
    const { el, onDirty } = await mount({ text: MIND_TEXT_META, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META)) // 正文未编辑
    saveBtnOf(el).click() // 保存起飞：保存瞬间覆写空→merged.mindview=meta.mindview 原引用（零转正，基线仍=文件记录）
    await flush()
    expect(putObject).toHaveBeenCalledTimes(1)
    dispatchViewChange(mindViewSelectOf(el, 'theme'), 'xm-slate') // 窗内覆写→CAS 存活残轴
    resolvePut()
    await flush()
    expect(saveBtnOf(el).classList.contains('is-dirty'), '前置面：残轴守卫——dirty 保持真（例 6 断言同源）').toBe(true)
    // reset（残轴 dirty=true 使 resetToSaved 的 !dirty 早退不拦=reset 闸语义本体）
    const resetBtn = el.querySelector<HTMLButtonElement>(".mmx-edt__btn[data-act='reset']")
    expect(resetBtn, '统一工具栏重置钮应在容器子树内').not.toBeNull()
    const setDataBefore = engine.state.setDataCalls.length
    resetBtn!.click()
    await vi.waitFor(() => expect(onDirty).toHaveBeenCalledWith(false))
    // 断言①（覆写弃置·回显面）：theme 回显归基线（未转正基线=文件记录 xm-blue，窗内覆写弃置）；layout 沿基线 fishbone
    expect(mindViewSelectOf(el, 'theme').value, 'reset 后 theme 回显=基线 xm-blue（窗内覆写弃置）').toBe('xm-blue')
    expect(mindViewSelectOf(el, 'layout').value, 'reset 后 layout 回显=基线 fishbone').toBe('fishbone')
    expect(engine.state.setDataCalls.length, 'reset 闸语义：引擎重喂 mount 树（setData 增量在场）').toBeGreaterThan(setDataBefore)
    // 断言②（覆写弃置·字节面）：再保存输出不含窗内覆写（xm-slate 不落盘；_mindview 行=基线记录恰一次）
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META)) // 真引擎 setData 后现态=重喂树（mock 需手工回灌，MP2-P-T 例 1 同手法）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(2))
    const out = await blobText(putObject.mock.calls[1]![1] as Blob)
    expect(out).toContain('%% meta: _mindview {"layout":"fishbone","theme":"xm-blue"}')
    expect(out, '窗内覆写 xm-slate 须被 reset 弃置（不得落盘）').not.toContain('xm-slate')
    expect((out.match(/%% meta: _mindview/g) ?? []).length, '恰一次').toBe(1)
  })
})

// ═══════════════ MP2-TH-T 追加块：主题样式面板（测试先行——预期红，面板/持久化未落地） ═══════════════
// 契约正本：.claude/mind-loop-state.md「MP2-TH-T」行（含主代理持久化契约裁决）。插位=文件尾
// （任务裁决位），既有 115 例零字节改动。
//
// 【持久化契约（主代理已裁）】`_mindview` 记录增可选 `custom` 字段：
//   {layout, theme, custom?: {base: string, overrides: object}}
//  - theme 名随 custom 变为 `mind-custom-<n>`（n=会话计数器）；overrides=稀疏记录（只含已触轴）
//  - mount：meta.mindview?.custom 在场 → defineTheme(base+overrides 合成) → 主题应用；无 custom
//    → 既有路径零变化（记录复用通道/零 diff 红线不动——例 6 守卫哨兵）
//  - UI 应用 → defineTheme 新名（计数器避重注册 no-op）+setTheme+显式 markDirty（写路径口径）
//  - readonly/saving 双闩（内容写族口径——apply 影响保存字节，与模板 select 同款双闸+飞行窗闩）
//  - meta.ts 8K 单行闸（MAX_META_LINE_BYTES=8192）对 custom 天然适用（overrides 小对象）；
//    parseMindMeta 仅对 layout/theme 做 string 校验（meta.ts:98-104 `{...obj}` 其余字段保留）
//    → custom 对象字段过解析零损（勘察实证，非新闸需求）
//
// 【勘察三结论（实证正本，2026-11-10）】
//  1. 轴锚点（node_modules/simple-mind-map/src/theme/default.js + themes.ts D-THEME 勘误）：
//     - 节点填充色=按层键 root.fillColor/second.fillColor/node.fillColor（引擎按 layerIndex
//       只读 root/second/node 三层，third 键不被消费——写入即死数据）。
//       【键集提案·归 C 裁定】单控制轴写满三消费层同值。
//     - 线条颜色=顶层 lineColor（default.js:15；nodeSizeIndependenceList 在册顶层键）。
//     - 线型 solid|dashed=顶层 lineDasharray（default.js:17：'none'=实线缺省；虚线形态提案
//       '6,4'=引擎自产 associativeLineDasharray 缺省同形）。非 lineStyle——那是 curve/straight/
//       direct 连线形状轴（default.js:25，主题包已定），与实/虚线正交（任务 prompt「lineStyle/
//       dasharray」两可，勘察定锚 dasharray）。
//  2. 重注册语义：MindMap.defineTheme 同名再注册=`return new Error('该主题名称已存在')`——
//     静默 no-op、新 cfg 不落（index.js:836-841 实证，MC2 结论复核成立）→「计数器
//     mind-custom-<n>」必要（例 3 钉：同会话二次 apply 换新名，同名将滞留旧 cfg 使二次应用
//     失效）。MindMap.removeTheme 在场（index.js:843-846——置 null 非 delete；initTheme
//     `theme[name] || theme.default` 对 null 安全回退 default），契约采计数器路线，removeTheme
//     不入本批断言面（记账：如后续改走 removeTheme+定名路线须回本块翻例 3）。
//  3. setTheme 对 custom 名：未注册主题回退 default（index.js:371 `theme[this.opt.theme] ||
//     theme.default` 实证在案）——defineTheme 须先于生效。另 defineTheme 的 cfg 合成基准=引擎
//     defaultTheme（`mergeTheme(defaultTheme, config)` index.js:842），不含 base 层 →
//     「base⊕overrides 合成」须胶水自担后再 defineTheme（例 2/例 5 的 cfg 合成面断言据此钉）。
//
// 【DOM/i18n 键集提案（归 C 裁定；本块=可执行规格）】
//  - bar 钮 button[data-act='theme-style']（容器自有条 .mmagic-mind__bar 内，大纲/导入钮同族
//    ——不进 shared 工具栏四键集）；text/aria-label=t('app.mind-theme-panel.do')
//  - 浮动面板根 div.mmagic-mind-theme-panel（mindPanel 族同构：is-open 在场=显示、初始缺席=
//    隐藏）；行结构=div.row 内 label+控件（mindPanel 同构）
//  - 三控制轴：[data-field='fill'] input[type=color]（节点填充色）/[data-field='line']
//    input[type=color]（线条颜色）/[data-field='lineStyle'] select（选项 value 齐序 solid|dashed
//    ——UI 值；合成时映射引擎值 solid→'none'/dashed→'6,4'）
//  - 应用钮 button[data-act='apply']（面板根内——mindPanel close 钮 data-act 域同构）
//  - i18n 键集提案（恰七键，locales 落地归 C）：app.mind-theme-panel.{do, fill, line, lineStyle,
//    lineStyle.solid, lineStyle.dashed, apply}
//
// 【钉面裁量注记（偏离申报）】
//  - 例 5 生效通道：契约字面「setTheme 应用」——本例钉 constructor opt 面（lastOpt.theme=
//    回放名：基线 theme 直读 meta.mindview.theme，custom 在场即回放名，构造期生效/setTheme
//    生效两实现均过）；不反钉 setThemeCalls=通道自由度（回放路径若走显式 setTheme 亦兼容）。
//  - 例 8「基线」读法=保存转正后基线（含 custom）非文件原始记录——依据 MP1-UI-R P2-1
//    （reset 还原已存盘视图而非打开时视图）转正链同族；「控件回基线」=回显已存盘 custom 值。
//  - 注册先于生效的 UI 路径时序在 mock 域不可钉（mock 无注册表语义）；回放例经 log 序钉
//    construct 前置，UI 路径时序归 e2e 验收。
//  - 例 5 夹具回放名 mind-custom-1 与 per-mount 计数器首名恰同形（「文件名复用」vs「计数器
//    铸新」两读法在此夹具上重合）；跨会话同名碰撞语义（引擎注册表=模块级单例）不在本批
//    断言面=记账注记。
//  - 未钉角落（记账）：apply 后 data-act='theme' select 对 mind-custom-* 名的回显行为；
//    会话内 custom 应用后再切主题 select 至 xm-* 时 custom 字段去留；apply 与属性面板
//    （mmagic-mind-panel）互斥开合语义。
//
// 【例账（9 例）+ 预期红归因（初跑实测 8 红+116 绿=115 既有+例 6 守卫绿，2026-11-10）】
//  - 例 1 面板 DOM——红 @ themePanelOf 定位器（面板根缺位）；例 2/3/4/7/8/9——红 @
//    themeStyleBtnOf 定位器（面板钮缺位）——纯 UI 面未落地，断言面未触达，非假红
//  - 例 5 mount 回放——不走面板钮，红 @ defineThemeCalls 过滤断言（mount 无 custom 通道=断言红）
//  - 例 6 零 diff 守卫——预期绿（现行记录复用通道已满足；红=custom 可选字段破坏零 diff 红线）
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** 主题样式面板钮定位（容器自有 button[data-act=theme-style]——mindViewSelectOf 同手法） */
function themeStyleBtnOf(el: HTMLElement): HTMLButtonElement {
  const b = el.querySelector<HTMLButtonElement>("button[data-act='theme-style']")
  expect(b, "主题样式面板钮 button[data-act=theme-style] 应在容器子树内（MP2-TH DOM 契约）").not.toBeNull()
  return b!
}

/** 主题样式浮动面板定位（div.mmagic-mind-theme-panel——mindPanel 族钉类名浮层同构） */
function themePanelOf(el: HTMLElement): HTMLElement {
  const p = el.querySelector<HTMLElement>('.mmagic-mind-theme-panel')
  expect(p, '主题样式浮动面板 .mmagic-mind-theme-panel 应在容器子树内（MP2-TH DOM 契约）').not.toBeNull()
  return p!
}

/** 主题面板控制轴定位（[data-field=fill|line|lineStyle]——面板根内，mindPanel data-field 同构） */
function themeFieldOf(el: HTMLElement, field: 'fill' | 'line' | 'lineStyle'): HTMLElement {
  const c = themePanelOf(el).querySelector<HTMLElement>(`[data-field='${field}']`)
  expect(c, `主题面板控件 [data-field=${field}] 应在面板根内（MP2-TH DOM 契约）`).not.toBeNull()
  return c!
}

/** 主题面板应用钮定位（面板根内 button[data-act=apply]——mindPanel close 钮域同构） */
function applyBtnOf(el: HTMLElement): HTMLButtonElement {
  const b = themePanelOf(el).querySelector<HTMLButtonElement>("button[data-act='apply']")
  expect(b, "主题面板应用钮 button[data-act=apply] 应在面板根内（MP2-TH DOM 契约）").not.toBeNull()
  return b!
}

/** 开面板：bar 钮 click→is-open 在场（mindPanel 族可见性口径前置） */
function openThemeStylePanel(el: HTMLElement): void {
  themeStyleBtnOf(el).click()
  expect(themePanelOf(el).classList.contains('is-open'), '面板钮 click→浮动面板浮现（is-open 在场）').toBe(true)
}

/** 控件派发（置值+change 冒泡——dispatchViewChange 同手法；jsdom 程序置值不自动派发） */
function dispatchThemeFill(el: HTMLElement, value: string): void {
  const input = themeFieldOf(el, 'fill') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
function dispatchThemeLine(el: HTMLElement, value: string): void {
  const input = themeFieldOf(el, 'line') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
function dispatchThemeDash(el: HTMLElement, value: 'solid' | 'dashed'): void {
  const sel = themeFieldOf(el, 'lineStyle') as HTMLSelectElement
  sel.value = value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 自定义主题注册名单（defineThemeCalls 过滤 mind-custom-*——计数器断言出口） */
function customDefineNames(): string[] {
  return engine.state.defineThemeCalls.map((c) => String(c.name)).filter((n) => n.startsWith('mind-custom-'))
}

/** mount 回放夹具：_mindview 含 custom 字段（手写 canonical 形态——overrides 稀疏两轴：
 *  root.fillColor 覆写+lineDasharray 虚线；行序 schema→_mindview=writeMetaBlock 产出序） */
const MIND_TEXT_CUSTOM = [
  'mindmap',
  '  根主题',
  '    分支A',
  '%% meta: schema=v1',
  '%% meta: _mindview {"layout":"logicalStructure","theme":"mind-custom-1","custom":{"base":"xm-green","overrides":{"root":{"fillColor":"#123456"},"lineDasharray":"6,4"}}}',
].join('\n')

describe('MP2-TH 主题样式面板（浮动面板/三控制轴/自定义主题持久化——测试先行）', () => {
  it('MP2-TH 面板 DOM：bar 钮 data-act=theme-style（容器自有条内，大纲/导入钮同族，i18n 走 t(app.mind-theme-panel.do)）→click→浮动面板浮现（.mmagic-mind-theme-panel is-open，初始隐藏）+三控制轴在场（fill/line 两枚 color input+lineStyle select solid|dashed 齐序）+行标签/选项/应用钮 i18n 键面（app.mind-theme-panel.* 恰七键提案）+shared 工具栏四键集不被侵入', async () => {
    const { el } = await mount()
    const panel = themePanelOf(el)
    expect(panel.classList.contains('is-open'), '面板初始隐藏（is-open 缺席=mindPanel 族口径）').toBe(false)
    const btn = themeStyleBtnOf(el)
    expect(btn.closest('.mmagic-mind__bar'), '容器自有条内（大纲钮同族，非 shared 工具栏）').not.toBeNull()
    expect(
      [btn.getAttribute('aria-label'), btn.getAttribute('title'), btn.textContent].filter(Boolean),
      '面板钮 i18n 面至少一处走 t(app.mind-theme-panel.do)',
    ).toContain('app.mind-theme-panel.do')
    btn.click()
    expect(panel.classList.contains('is-open'), '面板钮 click→浮动面板浮现（is-open 在场）').toBe(true)
    const fill = themeFieldOf(el, 'fill')
    expect(fill, '节点填充色=input 元素').toBeInstanceOf(HTMLInputElement)
    expect((fill as HTMLInputElement).type, '节点填充色 color input').toBe('color')
    const line = themeFieldOf(el, 'line')
    expect(line, '线条颜色=input 元素').toBeInstanceOf(HTMLInputElement)
    expect((line as HTMLInputElement).type, '线条颜色 color input').toBe('color')
    const dash = themeFieldOf(el, 'lineStyle')
    expect(dash, '线型=select 元素').toBeInstanceOf(HTMLSelectElement)
    expect([...(dash as HTMLSelectElement).options].map((o) => o.value), '线型选项 value 齐序 solid|dashed').toEqual(['solid', 'dashed'])
    const labelOf = (field: 'fill' | 'line' | 'lineStyle'): string | null =>
      themeFieldOf(el, field).closest('.row')?.querySelector('label')?.textContent ?? null
    expect(labelOf('fill'), '填充行标签键面').toBe('app.mind-theme-panel.fill')
    expect(labelOf('line'), '线条行标签键面').toBe('app.mind-theme-panel.line')
    expect(labelOf('lineStyle'), '线型行标签键面').toBe('app.mind-theme-panel.lineStyle')
    expect(
      [...(dash as HTMLSelectElement).options].map((o) => o.textContent),
      '线型选项文本键面（mind-view.<act>.<enum> 两级命名族同构）',
    ).toEqual(['app.mind-theme-panel.lineStyle.solid', 'app.mind-theme-panel.lineStyle.dashed'])
    const apply = applyBtnOf(el)
    expect(
      [apply.textContent, apply.getAttribute('aria-label')].filter(Boolean),
      '应用钮 i18n 键面走 t(app.mind-theme-panel.apply)',
    ).toContain('app.mind-theme-panel.apply')
    const acts = [...el.querySelectorAll('.mmx-edt__btn[data-act]')].map((b) => b.getAttribute('data-act'))
    expect(acts, 'shared 工具栏四键集不得被面板钮侵入（锁定例红线双保险）').toEqual(['save', 'undo', 'redo', 'reset'])
  })

  it('MP2-TH 应用行为：改节点填充色+线型(dashed)→apply→defineTheme 恰一次收 mind-custom-1 且 cfg=base⊕overrides 合成面（root.fillColor 覆写+backgroundColor/lineColor/root.color 等 base 键保真+third 不被覆写——引擎不消费层不写死数据）+引擎 setTheme 恰一次收 mind-custom-1+onDirty(true)（写路径显式标脏）+零 setData/updateData（主题面板触主题通道不触内容通道）', async () => {
    const { el, onDirty } = await mount()
    openThemeStylePanel(el)
    dispatchThemeFill(el, '#ff0000')
    dispatchThemeDash(el, 'dashed')
    applyBtnOf(el).click()
    const customs = engine.state.defineThemeCalls.filter((c) => c.name === 'mind-custom-1')
    expect(customs, '自定义主题注册恰一次').toHaveLength(1)
    expect(customs[0]!.cfg).toMatchObject({
      backgroundColor: '#f7f8f7', // base（xm-green）保真——合成面含 base 层（defineTheme 只并引擎 default，base 层合成归胶水）
      lineColor: '#4f8a78', // 未触轴沿 base 原值（overrides 稀疏——line 轴未触不落键）
      lineDasharray: '6,4', // 线型覆写（UI dashed→引擎 '6,4'）
      root: { fillColor: '#ff0000', color: '#fff' }, // 填充覆写+base 其余键保真
      second: { fillColor: '#ff0000' },
      node: { fillColor: '#ff0000' },
    })
    expect(
      (customs[0]!.cfg as { third?: { fillColor?: unknown } }).third?.fillColor,
      'third 层不被填充覆写（D-THEME：引擎按 layerIndex 不消费 third，写之即死数据）',
    ).toBe('transparent')
    expect(engine.state.setThemeCalls, '引擎 setTheme 恰一次收自定义名（先 defineTheme 新名再 setTheme）').toEqual(['mind-custom-1'])
    expect(onDirty, '写路径显式 markDirty（引擎 setTheme 无 data_change 侧信道——MP1 同族口径）').toHaveBeenCalledWith(true)
    expect(engine.state.setDataCalls, '零内容通道写（主题面板触主题通道）').toEqual([])
    expect(engine.state.updateDataCalls, '零 updateData 双通道写').toEqual([])
  })

  it('MP2-TH 计数器（重注册 no-op 规避）：同会话二次 apply→defineTheme 名单互异 mind-custom-1/mind-custom-2（引擎同名再注册=静默 no-op，index.js:836-841 实证——同名将滞留旧 cfg 使二次应用失效）+第二次 setTheme 收 mind-custom-2+第二次 cfg 收新填充值+onDirty 两次均 true', async () => {
    const { el, onDirty } = await mount()
    openThemeStylePanel(el)
    dispatchThemeFill(el, '#ff0000')
    applyBtnOf(el).click()
    dispatchThemeFill(el, '#00ff00')
    applyBtnOf(el).click()
    expect(customDefineNames(), '两次 apply=两个不同主题名（计数器递增避 no-op）').toEqual(['mind-custom-1', 'mind-custom-2'])
    expect(engine.state.setThemeCalls, '第二次 setTheme 收新名').toEqual(['mind-custom-1', 'mind-custom-2'])
    const second = engine.state.defineThemeCalls.find((c) => c.name === 'mind-custom-2')
    expect(second, '第二次注册在场').toBeDefined()
    expect(second!.cfg, '第二次 cfg 收新填充值（no-op 规避有实效——同名滞留旧 cfg 即红）').toMatchObject({ root: { fillColor: '#00ff00' } })
    expect(onDirty, '两次均显式标脏（替换恒翻脏，无 false 流量）').toHaveBeenCalledTimes(2)
    expect(onDirty.mock.calls.every((c) => c[0] === true), '两次均 true').toBe(true)
  })

  it('MP2-TH 持久化：改三轴（填充/线条/线型）→apply→保存→_mindview 行=完整记录 {layout,theme:mind-custom-1,custom:{base,overrides}}（overrides 含三轴键集——root/second/node.fillColor+lineColor+lineDasharray）+行 layout→theme→custom 键序恰一次', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm } = await mount({ text: MIND_TEXT, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 正文未编辑（MP1 持久化例同手法）
    openThemeStylePanel(el)
    dispatchThemeFill(el, '#ff0000')
    dispatchThemeLine(el, '#00aa00')
    dispatchThemeDash(el, 'dashed')
    applyBtnOf(el).click()
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    expect(parseMindMeta(out).mindview as unknown, 'custom 字段完整形态（{base,overrides}——键集提案钉面）').toEqual({
      layout: 'logicalStructure',
      theme: 'mind-custom-1',
      custom: {
        base: 'xm-green',
        overrides: {
          root: { fillColor: '#ff0000' },
          second: { fillColor: '#ff0000' },
          node: { fillColor: '#ff0000' },
          lineColor: '#00aa00',
          lineDasharray: '6,4',
        },
      },
    })
    expect(out, '行字节形态 layout→theme→custom 键序（writeMetaBlock 产物单行）').toContain(
      '%% meta: _mindview {"layout":"logicalStructure","theme":"mind-custom-1","custom":',
    )
    expect((out.match(/%% meta: _mindview/g) ?? []).length, '恰一次（拼接唯一性既有口径）').toBe(1)
  })

  it('MP2-TH mount 回放：fixture _mindview 含 custom（手写 canonical）→mount→defineTheme 恰一次收回放名且 cfg=base⊕overrides 合成（先于实例化——log 序；未注册名 initTheme 回退 default，index.js:371 实证）+引擎 theme=回放名（constructor opt 面=基线直读 meta.mindview.theme——生效通道自由度不钉 setThemeCalls，见块头裁量注记）+零 dirty', async () => {
    const { onDirty } = await mount({ text: MIND_TEXT_CUSTOM })
    const customs = engine.state.defineThemeCalls.filter((c) => c.name === 'mind-custom-1')
    expect(customs, '回放主题注册恰一次').toHaveLength(1)
    expect(customs[0]!.cfg).toMatchObject({
      backgroundColor: '#f7f8f7', // base 保真
      lineColor: '#4f8a78', // base 保真（overrides 未触轴）
      lineDasharray: '6,4', // overrides 覆写
      root: { fillColor: '#123456', color: '#fff' }, // overrides 覆写+base 保真
      second: { fillColor: '#ffffff' }, // base 保真（overrides 未触轴）
    })
    const iDef = engine.state.log.indexOf('defineTheme:mind-custom-1')
    const iCon = engine.state.log.indexOf('construct')
    expect(iDef, '回放注册在场').toBeGreaterThanOrEqual(0)
    expect(iDef, 'defineTheme 先于实例化（回放时序红线——晚于 construct 则 initTheme 已按未注册名回退 default）').toBeLessThan(iCon)
    expect(engine.state.lastOpt?.theme, '引擎 theme=回放名').toBe('mind-custom-1')
    expect(onDirty, '回放零 dirty（mount 期恢复非编辑）').not.toHaveBeenCalled()
  })

  it('MP2-TH 零 diff 守卫（绿钉）：无 custom 文件（_mindview {layout,theme}）mount 未编辑保存→字节级零漂移（记录复用通道不受 custom 可选字段影响——mergedMeta 无覆写分支哨兵，MP1 零 diff 红线同源）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, mm } = await mount({ text: MIND_TEXT_META, putObject })
    seedViewFace(mm) // 真引擎 getter 面常驻（MP1 零 diff 例同手法——不制造 diff）
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT_META))
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    const out = await blobText(putObject.mock.calls[0]![1] as Blob)
    const metaLines = writeMetaBlock(parseMindMeta(MIND_TEXT_META))
    expect(out.split('\n'), '字节级零 diff（meta 行按 writeMetaBlock 产物插 header 后——MP1 例 5 同钉）').toEqual([
      'mindmap',
      ...metaLines,
      '  根主题',
      '    分支A',
    ])
    expect(out, '无 custom 键泄漏（可选字段不得凭空合成）').not.toContain('"custom"')
  })

  it('MP2-TH readonly 双闸：4305 闩锁后面板钮 disabled（闸 1 setReadonly 禁用——模板/导入写路径同族）+编程派发 apply 全链（闸 2 处理器 readonly 早退兜底——dispatchEvent 绕 disabled 激活抑制）→零 setTheme 零自定义注册零 dirty（主题 apply 影响保存字节=内容写族口径，非导出/大纲「视图态零写路径不闩」族）', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { el, onDirty, onReadonly } = await mount({ putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 闩锁须走完保存链至 putObject 抛 4305（MP2-TP 同手法）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(onReadonly).toHaveBeenCalledTimes(1)) // 闩锁在场（readonly=true）
    expect(themeStyleBtnOf(el).disabled, '闸 1：setReadonly 禁用面板钮（写路径随闩）').toBe(true)
    dispatchThemeFill(el, '#ff0000') // 闸 2 前奏：控件 change 派发（面板隐藏不影响 DOM 在场）
    applyBtnOf(el).dispatchEvent(new MouseEvent('click', { bubbles: true })) // 绕 disabled——闸 2 readonly 早退兜底
    await flush()
    expect(engine.state.setThemeCalls, '零 setTheme（readonly 早退）').toEqual([])
    expect(customDefineNames(), '零自定义主题注册').toEqual([])
    expect(onDirty, '零 dirty（闩锁后写路径全封——markDirty 自早退双保险）').not.toHaveBeenCalled()
  })

  it('MP2-TH reset 归位（转正链同族）：apply custom→保存（基线随保存转正）→编辑翻脏→reset→面板控件回基线（回显=已存盘 custom 值——MP1-UI-R P2-1 reset 还原已存盘视图同族，块头读法注记）+再保存输出仍含 custom 记录（红=转正/复用分支丢 custom——已存自定义主题再保存静默丢失）', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined)
    const { el, onDirty, mm } = await mount({ text: MIND_TEXT, putObject })
    openThemeStylePanel(el)
    dispatchThemeFill(el, '#123456')
    dispatchThemeDash(el, 'dashed')
    applyBtnOf(el).click()
    expect(onDirty, '前置面：apply 翻脏').toHaveBeenCalledWith(true)
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    // 编辑翻脏（门控前置：render_end 立初始基线；mock 无 command 闸 2 直通——既有手法）
    mm.emit('node_tree_render_end')
    mm.emit('data_change')
    expect(saveBtnOf(el).classList.contains('is-dirty'), '前置面：编辑已翻脏').toBe(true)
    const resetBtn = el.querySelector<HTMLButtonElement>("button[data-act='reset']")
    expect(resetBtn, '统一工具栏重置钮应在容器子树内').not.toBeNull()
    resetBtn!.click()
    await vi.waitFor(() => expect(onDirty).toHaveBeenCalledWith(false))
    expect((themeFieldOf(el, 'fill') as HTMLInputElement).value, 'reset 后填充回显=已存盘 custom 值（非清空/非打开时缺省）').toBe('#123456')
    expect((themeFieldOf(el, 'lineStyle') as HTMLSelectElement).value, 'reset 后线型回显=已存盘 custom 值').toBe('dashed')
    // 再保存：输出仍含 custom 记录（转正基线须携带 custom 过复用/重写分支——本例主牙）
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // reset 重喂 mount 树（mock 手工回灌，MP2-P-T 例 1 同手法）
    saveBtnOf(el).click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(2))
    const out2 = await blobText(putObject.mock.calls[1]![1] as Blob)
    expect(parseMindMeta(out2).mindview?.theme, '再保存 theme=mind-custom-1').toBe('mind-custom-1')
    expect(out2, 'custom 字段在再保存输出中存活（{base,overrides} 形态）').toContain('"custom":{"base":"xm-green"')
    expect((out2.match(/%% meta: _mindview/g) ?? []).length, '恰一次').toBe(1)
  })

  it('MP2-TH saving 闩（内容写族口径·模板/导入族同款）：保存飞行窗内（putObject 未决）apply→闩拒静默（零 setTheme/零自定义注册/零 dirty——窗内写会被收尾置假三连吞）+放行后重试 apply 照常（闩只拦窗内，非死锁）', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面，MP2-Q4 例 1 同手法）
    const { el, onDirty } = await mount({ text: MIND_TEXT, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT))
    saveBtnOf(el).click()
    await flush()
    expect(putObject, '前置面：保存已入飞行窗').toHaveBeenCalledTimes(1)
    openThemeStylePanel(el)
    dispatchThemeFill(el, '#ff0000')
    dispatchThemeDash(el, 'dashed')
    applyBtnOf(el).click()
    await flush()
    expect(engine.state.setThemeCalls, '窗内 apply 闩拒：零 setTheme').toEqual([])
    expect(customDefineNames(), '窗内 apply 闩拒：零自定义注册').toEqual([])
    expect(onDirty, '窗内 apply 闩拒：零 dirty（闩拒后无 markDirty 流量）').not.toHaveBeenCalled()
    resolvePut()
    await flush()
    dispatchThemeFill(el, '#00ff00')
    applyBtnOf(el).click()
    expect(engine.state.setThemeCalls, '放行后重试照常（闩只拦窗内，非死锁）').toEqual(['mind-custom-1'])
    expect(onDirty, '重试 apply 翻脏').toHaveBeenCalledWith(true)
  })
})

// ═══════════════ MP2-R5-T 追加块：R5 N1/N2 修复测试钉（跨 surface 主题注册表回收 + 未存盘切主题 apply 合成基准） ═══════════════
// 契约正本：.claude/mind-loop-state.md「MP2-R5」行（N1【P1·阻断】+N2【P2 顺手修】）。插位=文件尾
// （MP2-TH describe 之后，任务裁决位）。测试先行——预期红账：N1 两例红（现实现 dispose 零
// removeTheme 调用+glue 零名录）、N2 一例红（baseOf 仍读 mindviewBaseline.theme 不看
// viewOverride.theme 覆写轴）。
//
// 【mock 面扩展（本批）】FakeMindMap 补静态 removeTheme(name)=记录式桩（removeThemeCalls+
// log 'removeTheme:<name>'，见文件头 mock API 面注）——真引擎 index.js:843-846 置 null 非
// delete、initTheme `theme[name] || theme.default` 对 null 安全回退 default（MP2-TH 块头勘察
// 结论 2 同源实证）。R5 实证根因：mock defineTheme 纯 log 无注册表语义，跨会话回收洞 mock 域
// 不可达→补此静态使业务侧 cast-optional `(MindMap as …).removeTheme?.()` 消费面可达：mock 有
// 静态即被调、无则静默跳过=零测试扰动（R5 裁决口径）。
//
// 【业务修复面（归 MP2-TH2-C，不在本批）】
//  - N1：glue 闭包 Set 收录本 surface 定义名（mount 回放名+各 apply 名）→dispose 链
//    mm.destroy() 前逐名 cast-optional removeTheme。
//  - N2：baseOf 解析改 `viewOverride.theme ?? mindviewBaseline.theme`（一行——合成基准=
//    用户眼前主题：未存盘切走基线主题后 apply 不得仍以旧基线为底铸 cfg）。
describe('MP2-R5-T 测试钉（N1 dispose 回收本 surface 自定义主题名 + N2 未存盘切主题后 apply 合成基准）', () => {
  it('MP2-R5 N1 dispose 回收：surface A 面板 apply（铸 mind-custom-1）→dispose→removeTheme 恰一次收 mind-custom-1（回收本 surface 名录——引擎注册表=模块级单例跨 destroy 存续，计数器每 surface 从 0 重启→不回收则下个 surface 同名注册 no-op 滞留 A 的陈旧 cfg）→再 mount surface B（无 custom 文件）→apply→defineTheme 名单再收 mind-custom-1（计数器重启语义下重注册可达=回收后合法；真引擎 removeTheme 置 null→defineTheme 可再注册）', async () => {
    const a = await mount()
    openThemeStylePanel(a.el)
    dispatchThemeFill(a.el, '#ff0000')
    applyBtnOf(a.el).click()
    expect(customDefineNames(), '前置面：surface A apply 铸 mind-custom-1').toEqual(['mind-custom-1'])
    a.surface.dispose()
    expect(
      engine.state.removeThemeCalls,
      'dispose 回收本 surface 自定义名恰一次且收 mind-custom-1（红=dispose 零 removeTheme 调用——R5 N1 现症）',
    ).toEqual(['mind-custom-1'])
    const b = await mount()
    openThemeStylePanel(b.el)
    dispatchThemeFill(b.el, '#00ff00')
    applyBtnOf(b.el).click()
    expect(
      customDefineNames(),
      'surface B（计数器从 0 重启）apply 复铸同名 mind-custom-1=回收后重注册可达（mock 域钉名录可达性与重注册合法；真引擎同名 no-op 注册表语义归 e2e——R5 记账口径）',
    ).toEqual(['mind-custom-1', 'mind-custom-1'])
    expect(engine.state.setThemeCalls.at(-1), 'surface B 引擎现效名=复铸 mind-custom-1').toBe('mind-custom-1')
  })

  it('MP2-R5 N1b 回放名回收：fixture 含 custom（mount 回放通道已 defineTheme mind-custom-1）→mount→dispose→removeTheme 收 mind-custom-1（回放定义的名亦入回收名录——否则下个 surface 回放同名仍引擎 no-op 滞留陈旧 cfg=R5 N1 形态 b「mount 即错显零用户动作」）', async () => {
    const { surface } = await mount({ text: MIND_TEXT_CUSTOM })
    expect(customDefineNames(), '前置面：mount 回放已注册 mind-custom-1（MP2-TH 例 5 通道）').toEqual(['mind-custom-1'])
    surface.dispose()
    expect(
      engine.state.removeThemeCalls,
      'dispose 回收含回放名（红=dispose 零 removeTheme 调用——R5 现症如实红：现实现连名录都不录，回放名不随修复面自然入账）',
    ).toEqual(['mind-custom-1'])
  })

  it('MP2-R5 N2 未存盘切主题后 apply 合成基准：mount（基线 xm-green）→theme select 切 xm-blue（未保存——viewOverride.theme 覆写轴）→面板 fill 改色+apply→defineThemeCalls 末次 cfg=以主题包 xm-blue 配置为基准合成（合成基准=用户眼前主题——红=baseOf 仍读基线 xm-green，用户眼前蓝底却铸出绿底自定义主题）+overrides 稀疏覆写叠加', async () => {
    const { el, mm } = await mount()
    const { setTheme } = seedViewFace(mm) // 真引擎切换 API 面常驻（MP1 手法——记录+opt 回写+同名事件，mock 类体零改动；断言走播种 spy=MP1 同款口径）
    dispatchViewChange(mindViewSelectOf(el, 'theme'), 'xm-blue')
    expect(setTheme.mock.calls[0]![0], '前置面：切主题走引擎 setTheme 收 xm-blue（未保存——仅 viewOverride 覆写轴+引擎视图现效）').toBe('xm-blue')
    openThemeStylePanel(el)
    dispatchThemeFill(el, '#ff0011')
    applyBtnOf(el).click()
    const last = engine.state.defineThemeCalls.at(-1)
    expect(last?.name, '前置面：apply 铸 mind-custom-1').toBe('mind-custom-1')
    expect(last?.cfg).toMatchObject({
      backgroundColor: '#f5f8fc', // 基准=xm-blue 背景层（红=基准滞留 xm-green '#f7f8f7'——R5 N2 现症）
      lineColor: '#4a7db3', // 未触轴沿基准原值——xm-blue 线色（红=xm-green '#4f8a78'）
      root: { fillColor: '#ff0011' }, // overrides 稀疏覆写叠加在基准之上
      second: { color: '#2b4a63', borderColor: '#4a7db3' }, // 基准非覆写轴=xm-blue second（红=xm-green '#2f5d52'/'#4f8a78'）
    })
  })
})

// ═══════════════ MP2-Q5-T 追加块：快赢池终批红例（R4 P2-2 模板闩拒后 select 复位占位 + R4 P2-3 镜像窗 readonly 复检） ═══════════════
// 契约正本：.claude/mind-loop-state.md「MP2-R4」行 P2-2/P2-3 两入池项。插位=文件尾（MP2-R5-T
// describe 之后，任务裁决位）。测试先行——预期红账：两例红（现实现闩早退分支/镜像窗复检块均缺
// 复位与 readonly 面）。两例独立 mount 各持独立 pending promise，零纠缠。
//
// 【盘面锚点（mindEditor.ts 实测 1245 行，2026-11-11；任务书锚 :589-603/:543-567 为 1070 行期
// 陈值——行号漂移语义位不变）】
//  - 模板控件 change 处理器 :681-695——闩早退 `if (readonly || saving) return`（:685）先于置空
//    复位 `templateSelect.value = ''`（:687）→ 窗内选模板被闩拒后 select 残留所选值（native DOM
//    语义：value 残留时同项重选不触发 change=用户须先选他项再回；复位占位=可立即重选同项）。
//    修复面（归 MP2-Q5-C）=闩早退分支补 `templateSelect.value=''` 一行。
//  - runXmindImport :635-659——入口三闸 :636-638 后 `await file.arrayBuffer()`（:641）挂起窗
//    （镜像窗）；恢复后复检块 :645-646 只查 `saving`/`disposed` 不查 `readonly` → 挂起窗内
//    readonly 翻转后恢复链照常 setData+markDirty 落已闩锁面（闩锁封写面，导入绕行=写路径穿透）。
//    修复面（归 MP2-Q5-C）=复检块补 `if (readonly) return` 一行。
//  - readonly 翻转触发点（4305 形态注记）：真域=putObject reject code 4305 → save catch
//    （:1164）→ setReadonly（:879 唯一入口）；mock 域同链可钉（MP2-TP readonly 双闸例同手法）——
//    无需 setReadonly 直调等价形态，闩语义同构。
//
// 【红归因】例 1 红=`select.value===''` 实收 'project'（闩早退在置空复位之前）；例 2 红=
// `setDataCalls []` 实收 1（复检块无 readonly 查——setData 落已闩锁面）。
//
// 【判别面注记（例 2）】markDirty 自带 readonly 早退（:873）——红例下 onDirty 零调即绿（闩锁
// 封脏标），判别面=setData（已闩锁面不得落写）；setData/updateData/onDirty 三零断言=修复后
// 正典形态「导入不得落已闩锁面」的完整语义面。
describe('MP2-Q5-T 快赢池终批红例（R4 P2-2 模板闩拒后 select 复位占位 + R4 P2-3 镜像窗 readonly 复检）', () => {
  /** File 桩：arrayBuffer 手动 pending（镜像窗制造面——MP2-Q4 例 2 同手法：jsdom File 实例级
   *  defineProperty 覆写 prototype 方法；携带真 zip 字节的受控 promise；resolveBuf 预绑 zip
   *  字节——裸 resolve() 会以 undefined 兑现→new Uint8Array(undefined)=空→unzip 抛=链落 catch
   *  通道，镜像窗现行为钉不出） */
  function mkPendingArrayBufferFile(zip: Uint8Array): { file: File; resolveBuf: () => void } {
    let resolveInner!: (buf: ArrayBuffer) => void
    const bufPromise = new Promise<ArrayBuffer>((resolve) => { resolveInner = resolve })
    const file = new File([zip], 'import.xmind', { type: 'application/xmind' })
    Object.defineProperty(file, 'arrayBuffer', { value: () => bufPromise, configurable: true })
    return { file, resolveBuf: () => resolveInner(zip.slice().buffer as ArrayBuffer) }
  }

  it('MP2-Q5（MP2-R4 P2-2·模板闩拒后 select 复位占位）保存飞行窗内选模板被 saving 闩拒→select 复位占位（value=\'\'——native DOM 语义：value 残留所选值时同项重选不触发 change=闩拒后须先选他项再回；复位=可立即重选同项）：putObject pending→保存进飞行窗→change 选 project→闩拒（saving 早退）→断言 select.value===\'\'——现实现预期红：闩早退分支（mindEditor.ts :685）先于置空复位（:687）return→select 残留所选值；修复面（归 MP2-Q5-C）=闩早退分支补 templateSelect.value=\'\' 一行，修复后零改动转绿', async () => {
    let resolvePut!: () => void
    const putObject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePut = resolve })) // 首保存=手动放行（飞行窗制造面，Q4 例 1 同手法）
    const { MIND_TEMPLATES } = await loadTemplates()
    const { el, onDirty, surface } = await mount({ text: MIND_TEXT, putObject })
    const tpl = MIND_TEMPLATES.find((item) => item.id === 'project')
    expect(tpl, '前置面：project 模板在场（MP2-TP 契约例同钉）').toBeDefined()
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 保存序列化源=打开时树
    saveBtnOf(el).click() // 保存起飞：挂起于 await putObject（飞行窗开）
    await flush()
    expect(putObject, '前置面：保存已入飞行窗（putObject 已调且 pending 未决）').toHaveBeenCalledTimes(1)
    const sel = templatesSelectOf(el)
    dispatchTemplate(sel, tpl!.id) // 窗内选模板：闩拒面（模板 change=同步 handler，落引擎即时可见）
    // 闩拒写入面证据（Q4 例 1 三零同面——本例复述定位红面分支：早退确曾走过=非成功路径复位）
    expect(engine.state.setDataCalls, '闩拒面证据：零引擎写（saving 早退——成功路径必有 setData）').toEqual([])
    expect(onDirty, '闩拒面证据：零 markDirty').not.toHaveBeenCalled()
    // 本例主牙（R4 P2-2）：闩拒后 select 复位占位——现实现早退在复位之前→残留所选值 'project'=红
    expect(sel.value, '闩拒后 select 复位占位（红=残留所选值——native 语义下同项重选不触发 change）').toBe('')
    // 放行：保存收尾链随微任务排空跑完（saving=false，飞行窗闭）
    resolvePut()
    await flush()
    // 补腿（闩只在 saving 期生效+复位后可重选同项）：保存完成后重选 project 照常成功——注记：
    // 编程派发 dispatchEvent 与 value 差无关（jsdom 无原生 value-delta 闸），本腿两态皆绿=
    // 文档钉非判别面；判别力在上句 value===''（修复后 native 重选同项才真实可达）
    dispatchTemplate(sel, tpl!.id)
    expect(engine.state.setDataCalls, '窗外重选同模板照常落引擎（恰 1=窗内闩拒 0+补腿 1）').toHaveLength(1)
    expect(onDirty, '重选显式 markDirty 已翻真').toHaveBeenCalledWith(true)
    expect(sel.value, '成功路径复位占位照常（:687 既有复位面）').toBe('')
    surface.dispose() // 清理（飞行窗已 resolve）
  })

  it('MP2-Q5（MP2-R4 P2-3·镜像窗 readonly 复检）导入挂起窗（await arrayBuffer 镜像窗）内 4305 翻 readonly→resolveBuf 导入链恢复被 readonly 复检拒（readonly 已翻，导入不得落已闩锁面）：零 setData/updateData+零 markDirty——现实现预期红：复检块（mindEditor.ts :645-646）只查 saving/disposed 不查 readonly→恢复链 setData 落已闩锁面；修复面（归 MP2-Q5-C）=复检块补 if (readonly) return 一行，修复后零改动转绿。【4305 形态注记】真域触发=putObject reject code 4305→save catch（:1164）→setReadonly（:879 唯一入口）；mock 域同链可钉（MP2-TP readonly 双闸例同手法）——无需 setReadonly 直调等价形态，闩语义同构。【判别面注记】markDirty 自带 readonly 早退（:873）→onDirty 零调红例下即绿（闩锁封脏标），判别面=setData；三零=修复后「导入不得落已闩锁面」完整语义面', async () => {
    const putObject = vi.fn().mockRejectedValue(Object.assign(new Error('readonly'), { code: 4305 }))
    const { el, onDirty, onReadonly, surface } = await mount({ text: MIND_TEXT, putObject })
    engine.state.dataTree = toEngineTree(parseMindmap(MIND_TEXT)) // 保存序列化源=打开时树
    const zip = mkXmindZip([mkXmindSheet(mkXmindTopic('导入根', [mkXmindTopic('分支一')]))])
    const { file: importFile, resolveBuf } = mkPendingArrayBufferFile(zip)
    dispatchXmindImport(xmindInputOf(el), importFile) // 导入链挂起于 await arrayBuffer（镜像窗开；入口三闸此时 readonly=false 全过）
    await flush()
    expect(putObject, '前置面：镜像窗开（导入挂起、保存未起飞——putObject 零调）').not.toHaveBeenCalled()
    saveBtnOf(el).click() // 窗内保存起飞→putObject 即拒 4305→catch→setReadonly（readonly 翻转）→finally saving=false
    await vi.waitFor(() => expect(onReadonly, '前置面：镜像窗内 4305 已翻 readonly（真域闩语义同构——:1164 触发点）').toHaveBeenCalledTimes(1))
    await flush() // 收尾 finally（saving=false）排空富余
    expect(putObject, '前置面：保存链已走完至 4305 拒绝').toHaveBeenCalledTimes(1)
    expect(xmindImportBtnOf(el).disabled, '前置面：闩锁在场（闸 1 setReadonly 禁导入钮——readonly=true 实证）').toBe(true)
    resolveBuf() // 导入链恢复：readonly 复检（修复面）命中→拒——现实现复检块只查 saving/disposed→照常落引擎=红
    await new Promise((r) => setTimeout(r, 20)) // 恢复链飞行窗（unzip/parse 同步+微任务排空富余——Q4 disposed 例同域窗宽）
    // 主牙（R4 P2-3）：readonly 已翻，导入不得落已闩锁面
    expect(engine.state.setDataCalls, 'readonly 复检：已闩锁面零引擎写（红=setData 已落——复检块无 readonly 查）').toEqual([])
    expect(engine.state.updateDataCalls, '零引擎写（updateData 通道同禁）').toEqual([])
    expect(onDirty, '零 markDirty（判别面注记见块头——红例下即绿，三零=修复后完整语义面）').not.toHaveBeenCalled()
    surface.dispose() // 清理
  })
})
