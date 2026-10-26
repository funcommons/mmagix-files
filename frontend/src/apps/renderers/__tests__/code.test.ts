/**
 * Monaco 文本/代码编辑器渲染器单测（M2-R4 + R5 工具栏）
 * 被测：src/apps/renderers/code.ts——codeEditorRenderer + extToLanguage + LANGUAGE_OPTIONS
 * 要点：动态 import 触发 monaco.editor.create（language 映射正确/挂进 .mmagic-code-stage）/
 *       Ctrl+Cmd+S 保存链（getValue→Blob→putObject→notify('saved')→dirty 复位、保存中防重入）/
 *       工具栏状态机（保存钮 dirty 圆点+禁用、状态徽标、编辑类钮只读态隐藏）/
 *       快捷键（Ctrl+S 保存、Ctrl+F 查找 actions.find）/ undo/redo trigger /
 *       格式化双链（worker 原生 formatDocument 优先——文本变化=成功信号+超时护栏；
 *         无变化/超时/异常 → 自研回退 json stringify/js-beautify；白名单外 toast 不支持）/
 *       字号增减边界 / 语言手切 setModelLanguage / 运行期只读闩锁（putObject 拒 4305）/
 *       beforeDispose 契约（非 dirty 直接放行；dirty 弹 confirm；3s 超时强制放行）/
 *       file.size > 5MB 只读降级（不建 editor）/ savedState.viewState 恢复 / dispose 清理
 * mock：vi.mock('monaco-editor') 最小面——create 返回 fake editor
 *       （getValue/setValue/onDidChangeModelContent 收集器/restoreViewState/saveViewState/
 *         getModel（含 getLanguageId/getValue/getFullModelRange 供格式化双链改写）/
 *         dispose/getAction/trigger/updateOptions/executeEdits…），测试经 editors[-1] 直取实例断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeEditorRenderer, extToLanguage, LANGUAGE_OPTIONS } from '../code'
import { ERROR_CODES } from '../../../sdk/errorCodes'
import type { AppInstance } from '../../../sdk/types'

// ───────────────────────── monaco-editor mock ─────────────────────────

/** fake action（getAction 返回面；run 供断言） */
interface FakeAction {
  run: ReturnType<typeof vi.fn>
}

/** fake model（doFormat 需要语言/取值/全模型范围面；均 vi.fn 供用例 mockReturnValue 定向改写） */
interface FakeModel {
  dispose: ReturnType<typeof vi.fn>
  getLanguageId: ReturnType<typeof vi.fn>
  getValue: ReturnType<typeof vi.fn>
  /** 全模型范围（重置用例直调取比较基准；签名具体化避免 Mock 联合类型不可调用 TS2348） */
  getFullModelRange: () => {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
  /** undo/redo 可用性（统一钮簇 setHistory 数据源；用例可定向改写模拟历史栈态） */
  canUndo: ReturnType<typeof vi.fn>
  canRedo: ReturnType<typeof vi.fn>
}

/** fake editor 最小面（与 monaco 被测调用点一一对应） */
interface FakeEditor {
  getValue: () => string
  setValue: (v: string) => void
  /** 内容变化监听收集器：测试用 listeners[n]?.() 模拟用户输入 → dirty */
  onDidChangeModelContent: (cb: () => void) => { dispose: () => void }
  restoreViewState: ReturnType<typeof vi.fn>
  saveViewState: () => unknown
  focus: ReturnType<typeof vi.fn>
  getModel: () => FakeModel
  dispose: ReturnType<typeof vi.fn>
  /** monaco action 注册表：getAction 按 id 取（测试可注入/置空） */
  actions: Record<string, FakeAction>
  getAction: (id: string) => FakeAction | null
  trigger: ReturnType<typeof vi.fn>
  updateOptions: ReturnType<typeof vi.fn>
  /** 自研回退格式的落盘通道（实现按首个 edit.text 改 value，供断言文本流转） */
  executeEdits: ReturnType<typeof vi.fn>
  /** onDidChangeModelContent 收集到的回调 */
  listeners: Array<() => void>
}

// vi.hoisted：vi.mock 工厂与测试体共享同一份 fake 状态
const monacoMock = vi.hoisted((): {
  create: ReturnType<typeof vi.fn>
  createModel: ReturnType<typeof vi.fn>
  setModelLanguage: ReturnType<typeof vi.fn>
  defineTheme: ReturnType<typeof vi.fn>
  setTheme: ReturnType<typeof vi.fn>
  editors: FakeEditor[]
  reset: () => void
} => {
  const editors: FakeEditor[] = []
  const setModelLanguage = vi.fn()

  /** create 桩：按 options.value 建 fake editor（value 可由 setValue/executeEdits 演进） */
  const create = vi.fn((_el: HTMLElement, opts: { value?: string; language?: string }) => {
    const listeners: Array<() => void> = []
    let value = opts.value ?? ''
    // model 单例：monaco 一个 editor 绑一个 model（实现与测试须拿到同一实例）——
    // getValue 与 editor 共享 value 闭包（doFormat 的 worker 成功判定读 model.getValue）
    const model: FakeModel = {
      dispose: vi.fn(),
      getLanguageId: vi.fn(() => opts.language ?? 'plaintext'),
      getValue: vi.fn(() => value),
      getFullModelRange: vi.fn(() => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: value.length + 1,
      })),
      canUndo: vi.fn(() => false),
      canRedo: vi.fn(() => false),
    }
    const actions: Record<string, FakeAction> = {}
    const editor: FakeEditor = {
      getValue: vi.fn(() => value),
      setValue: vi.fn((v: string) => {
        value = v
      }),
      onDidChangeModelContent: vi.fn((cb: () => void) => {
        listeners.push(cb)
        return { dispose: vi.fn() }
      }),
      restoreViewState: vi.fn(),
      saveViewState: vi.fn(() => ({ line: 1, column: 1 })),
      focus: vi.fn(),
      getModel: vi.fn(() => model),
      dispose: vi.fn(),
      actions,
      getAction: vi.fn((id: string) => actions[id] ?? null),
      trigger: vi.fn(),
      updateOptions: vi.fn(),
      executeEdits: vi.fn((_src: string, edits: Array<{ text: string }>) => {
        if (edits[0]) value = edits[0].text
      }),
      listeners,
    }
    editors.push(editor)
    return editor
  })

  const reset = () => {
    editors.length = 0
    create.mockClear()
    createModel.mockClear()
    setModelLanguage.mockClear()
    defineTheme.mockClear()
    setTheme.mockClear()
  }

  const createModel = vi.fn()
  const defineTheme = vi.fn()
  const setTheme = vi.fn()
  return { create, createModel, setModelLanguage, defineTheme, setTheme, editors, reset }
})

vi.mock('monaco-editor', () => ({
  editor: {
    create: monacoMock.create,
    createModel: monacoMock.createModel,
    setModelLanguage: monacoMock.setModelLanguage,
    defineTheme: monacoMock.defineTheme,
    setTheme: monacoMock.setTheme,
  },
  Uri: { parse: vi.fn() },
}))

// toast mock（doFormat 双链的反馈断言面；code.ts 仅从 sdk 取 toast）
const toastMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('@/components/sdk', () => ({ toast: toastMock }))

// ───────────────────────── 测试基建 ─────────────────────────

/** 渲染文件实参（name 后缀决定 language 映射） */
const FILE = { key: 'docs/demo.ts', name: 'demo.ts', size: 24 }
const TEXT = 'const answer = 42\n'

/** fake ctx：getObject 返回给定文本 Blob；putObject/notify 为 spy（保留 vi.fn 类型便于断言） */
function makeCtx(blob: Blob) {
  return {
    getObject: vi.fn(async (_key: string) => blob),
    putObject: vi.fn(async (_key: string, _data: Blob, _contentType?: string) => {
      /* 默认立即成功 */
    }),
    t: vi.fn((key: string) => `i18n:${key}`),
    notify: vi.fn(),
    theme: {},
  }
}

/** 本渲染器保证 dispose/getState/beforeDispose 三件套齐备（契约：渲染器必须返回 AppInstance） */
type EditorInstance = AppInstance & Required<Pick<AppInstance, 'beforeDispose' | 'getState'>>

/** 渲染助手：容器 + fake ctx → 跑渲染器 → 返回 el/ctx/实例/最后一个 fake editor */
async function render(opts?: { text?: string; file?: { key: string; name: string; size: number }; savedState?: unknown }) {
  const el = document.createElement('div')
  const blob = new Blob([opts?.text ?? TEXT], { type: 'text/plain' })
  const ctx = makeCtx(blob)
  const inst = (await codeEditorRenderer(el, opts?.file ?? FILE, ctx, opts?.savedState)) as EditorInstance
  const editor = monacoMock.editors[monacoMock.editors.length - 1]
  if (!editor) throw new Error('monaco.editor.create 未被调用（应已建 fake editor）')
  return { el, ctx, inst, editor }
}

/** 微任务冲刷：让 doSave 的 await 链（putObject→notify→dirty 复位）跑完 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** doFormat 异步链冲刷（worker race 微任务 + 自研回退同步段；无动态 import 的 json 用例） */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
}

/** doFormat 含 js-beautify 动态 import 的链冲刷（真模块加载多拍，宽限 100ms） */
async function settleBig(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
}

/** 与实现同源的格式化 action id（注入 fake action 用） */
const ACTION_FORMAT = 'editor.action.formatDocument'

/** 与实现同源的 worker 超时护栏（advanceTimersByTimeAsync 步进基准） */
const FORMAT_WORKER_TIMEOUT_MS = 2500

/** 派发 Ctrl/Cmd+S 键盘事件到容器 */
function dispatchSave(el: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true, ...init })
  el.dispatchEvent(ev)
  return ev
}

/** 工具栏定位器：按 data-act 取钮（缺位=抛错，防静默空转） */
function btn(el: HTMLElement, act: string): HTMLButtonElement {
  const b = el.querySelector<HTMLButtonElement>(`.mmagic-code-bar [data-act="${act}"]`)
  if (!b) throw new Error(`工具栏缺 [data-act=${act}] 钮`)
  return b
}

/** 状态徽标（只读锁；「未保存」文字已废→保存钮红点，见一百四十三番口径） */
function statusEl(el: HTMLElement): HTMLElement {
  const s = el.querySelector<HTMLElement>('.mmagic-code-bar__status')
  if (!s) throw new Error('工具栏缺状态徽标')
  return s
}

/** 统一编辑钮簇根节点（保存红点/只读隐藏的契约载体） */
function clusterEl(el: HTMLElement): HTMLElement {
  const c = el.querySelector<HTMLElement>('.mmagic-code-bar .mmx-edt')
  if (!c) throw new Error('工具栏缺统一编辑钮簇')
  return c
}

let confirmSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  monacoMock.reset()
  toastMock.success.mockClear()
  toastMock.warning.mockClear()
  toastMock.error.mockClear()
  // jsdom 未实现 window.confirm：统一挂 spy（默认=用户确认）
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  // MonacoEnvironment 全局态逐测清理（实现只在缺位时设置一次）
  delete (self as { MonacoEnvironment?: unknown }).MonacoEnvironment
})

afterEach(() => {
  confirmSpy.mockRestore()
  vi.useRealTimers()
})

// ───────────────────────── extToLanguage 纯函数 ─────────────────────────

describe('extToLanguage：ext→monaco language id', () => {
  it('常见扩展名映射（js/ts/json/html/css/md/py/java/go/rs/sql/sh/yaml/xml…）', () => {
    expect(extToLanguage('js')).toBe('javascript')
    expect(extToLanguage('jsx')).toBe('javascript')
    expect(extToLanguage('ts')).toBe('typescript')
    expect(extToLanguage('tsx')).toBe('typescript')
    expect(extToLanguage('json')).toBe('json')
    expect(extToLanguage('html')).toBe('html')
    expect(extToLanguage('css')).toBe('css')
    expect(extToLanguage('scss')).toBe('scss')
    expect(extToLanguage('md')).toBe('markdown')
    expect(extToLanguage('py')).toBe('python')
    expect(extToLanguage('java')).toBe('java')
    expect(extToLanguage('go')).toBe('go')
    expect(extToLanguage('rs')).toBe('rust')
    expect(extToLanguage('sql')).toBe('sql')
    expect(extToLanguage('sh')).toBe('shell')
    expect(extToLanguage('yaml')).toBe('yaml')
    expect(extToLanguage('yml')).toBe('yaml')
    expect(extToLanguage('xml')).toBe('xml')
    expect(extToLanguage('c')).toBe('c')
    expect(extToLanguage('cpp')).toBe('cpp')
    expect(extToLanguage('cs')).toBe('csharp')
    expect(extToLanguage('rb')).toBe('ruby')
    expect(extToLanguage('php')).toBe('php')
    expect(extToLanguage('kt')).toBe('kotlin')
    expect(extToLanguage('swift')).toBe('swift')
    expect(extToLanguage('vue')).toBe('html')
    expect(extToLanguage('ini')).toBe('ini')
  })

  it('归一化：忽略大小写与前导点', () => {
    expect(extToLanguage('TS')).toBe('typescript')
    expect(extToLanguage('.Py')).toBe('python')
    expect(extToLanguage('JSON')).toBe('json')
  })

  it('未知扩展名 / 空值默认 plaintext', () => {
    expect(extToLanguage('xyz')).toBe('plaintext')
    expect(extToLanguage('txt')).toBe('plaintext')
    expect(extToLanguage('')).toBe('plaintext')
    expect(extToLanguage('..')).toBe('plaintext')
  })
})

// ───────────────────────── 挂载与 monaco 环境 ─────────────────────────

describe('codeEditorRenderer：挂载', () => {
  it('动态 import 触发 editor.create：value=文件文本、language 按扩展名映射、automaticLayout/minimap/fontSize 契约', async () => {
    const { ctx, inst } = await render()
    expect(ctx.getObject).toHaveBeenCalledWith('docs/demo.ts')
    expect(monacoMock.create).toHaveBeenCalledTimes(1)
    const [stageEl, opts] = monacoMock.create.mock.calls[0] as unknown as [
      HTMLElement,
      { value: string; language: string; fontSize: number; automaticLayout: boolean; minimap: { enabled: boolean } },
    ]
    // monaco 挂进工具条下的 stage 容器（root absolute inset:0 填满宿主——防 stage 尺寸塌陷布局）
    expect(stageEl.className).toBe('mmagic-code-stage')
    expect(stageEl.parentElement?.className).toBe('mmagic-code')
    expect(opts.value).toBe(TEXT)
    expect(opts.language).toBe('typescript')
    expect(opts.fontSize).toBe(14)
    expect(opts.automaticLayout).toBe(true)
    expect(opts.minimap.enabled).toBe(true) // 功能全开口径（minimap 常开）
    inst.dispose()
  })

  it('language 映射按文件名后缀取（py→python；无后缀→plaintext）', async () => {
    await render({ file: { key: 'scripts/run.py', name: 'run.py', size: 4 } })
    expect((monacoMock.create.mock.calls[0] as unknown as [HTMLElement, { language: string }])[1].language).toBe('python')

    monacoMock.reset()
    await render({ file: { key: 'etc/motd', name: 'motd', size: 4 } })
    expect((monacoMock.create.mock.calls[0] as unknown as [HTMLElement, { language: string }])[1].language).toBe('plaintext')
  })

  it('挂载后准备 MonacoEnvironment 占位 worker（getWorker 就位；占位策略后续收口）', async () => {
    await render()
    const env = (self as { MonacoEnvironment?: { getWorker?: unknown } }).MonacoEnvironment
    expect(typeof env?.getWorker).toBe('function')
  })
})

// ───────────────────────── 保存链 ─────────────────────────

describe('codeEditorRenderer：Ctrl/Cmd+S 保存链', () => {
  it('编辑变化→dirty；Ctrl+S→getValue→Blob→putObject→notify(saved)→dirty 复位', async () => {
    const { el, ctx, inst, editor } = await render()
    // 模拟用户输入：内容变化回调 → dirty
    expect(editor.listeners.length).toBeGreaterThan(0)
    editor.listeners[0]!()

    const ev = dispatchSave(el)
    expect(ev.defaultPrevented).toBe(true) // 拦截浏览器默认「保存网页」
    await flush()

    expect(editor.getValue).toHaveBeenCalled()
    expect(ctx.putObject).toHaveBeenCalledTimes(1)
    const [key, data] = ctx.putObject.mock.calls[0] as unknown as [string, Blob]
    expect(key).toBe('docs/demo.ts')
    expect(data).toBeInstanceOf(Blob)
    expect(await data.text()).toBe(TEXT)
    expect(ctx.notify).toHaveBeenCalledWith('saved', { key: 'docs/demo.ts' })

    // dirty 复位：非 dirty → beforeDispose 同步放行 true，不弹 confirm
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(inst.beforeDispose()).toBe(true)
    inst.dispose()
  })

  it('Cmd+S（macOS metaKey）同样触发保存', async () => {
    const { el, ctx, editor } = await render()
    editor.listeners[0]!()
    dispatchSave(el, { key: 'S', metaKey: true, ctrlKey: false })
    await flush()
    expect(ctx.putObject).toHaveBeenCalledTimes(1)
  })

  it('无修饰键 / Ctrl+Alt+S 不触发保存', async () => {
    const { el, ctx, editor } = await render()
    editor.listeners[0]!()
    dispatchSave(el, { ctrlKey: false })
    dispatchSave(el, { altKey: true })
    await flush()
    expect(ctx.putObject).not.toHaveBeenCalled()
    expect(ctx.notify).not.toHaveBeenCalled()
  })

  it('保存中防重入：putObject 未决期间重复 Ctrl+S 只触发一次保存', async () => {
    const { el, ctx, editor } = await render()
    editor.listeners[0]!()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ctx.putObject.mockReturnValueOnce(gate)

    dispatchSave(el)
    dispatchSave(el)
    expect(ctx.putObject).toHaveBeenCalledTimes(1)

    release()
    await flush()
    expect(ctx.putObject).toHaveBeenCalledTimes(1) // 放行后也不再补发
    expect(ctx.notify).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── beforeDispose 契约 ─────────────────────────

describe('codeEditorRenderer：beforeDispose 契约', () => {
  it('非 dirty：直接放行 true，不弹 confirm', async () => {
    const { inst } = await render()
    expect(inst.beforeDispose()).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('dirty：弹 confirm，用户取消=false=暂缓关闭', async () => {
    const { inst, editor } = await render()
    confirmSpy.mockReturnValue(false)
    editor.listeners[0]!()
    await expect(inst.beforeDispose()).resolves.toBe(false)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith('i18n:app.code-unsaved')
  })

  it('dirty 且 confirm 未决：3s 超时强制放行 true（Promise.race 契约）', async () => {
    vi.useFakeTimers()
    const { inst, editor } = await render()
    // confirm 挂死（模拟异步对话框不返回）：超时兜底必须接管
    confirmSpy.mockImplementation(() => new Promise<boolean>(() => undefined) as unknown as boolean)
    editor.listeners[0]!()

    const pending = Promise.resolve(inst.beforeDispose())
    let result: boolean | undefined
    void pending.then((v) => {
      result = v
    })

    await vi.advanceTimersByTimeAsync(2999)
    await Promise.resolve()
    expect(result).toBeUndefined() // 未到 3s：不决出

    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(result).toBe(true) // 3s 到：强制放行
  })
})

// ───────────────────────── 5MB 只读降级 ─────────────────────────

describe('codeEditorRenderer：5MB 只读降级', () => {
  const CODE_MAX = 5 * 1024 * 1024 // R2-03：与 spec.maxBytes 同源（1024 基，原 5_000_000 十进制口径废弃）

  it('file.size > 5MiB：不建 editor，显示只读提示（ctx.t 带 {limit} 实参），dispose 清容器', async () => {
    const el = document.createElement('div')
    const ctx = makeCtx(new Blob(['x'], { type: 'text/plain' }))
    const inst = (await codeEditorRenderer(el, { ...FILE, size: CODE_MAX + 1 }, ctx)) as AppInstance

    expect(monacoMock.create).not.toHaveBeenCalled()
    expect(monacoMock.editors).toHaveLength(0)
    expect(ctx.getObject).not.toHaveBeenCalled() // 超限不拉字节流
    expect(ctx.t).toHaveBeenCalledWith('app.code-too-large', { limit: '5.0 MB' })
    expect(el.textContent).toBe('i18n:app.code-too-large')
    expect(el.querySelector('.mmagic-code-bar')).toBeNull() // 无工具栏

    inst.dispose()
    expect(el.innerHTML).toBe('')
  })

  it('file.size 恰为 5MiB：不降级，正常建 editor', async () => {
    await render({ file: { ...FILE, size: CODE_MAX } })
    expect(monacoMock.create).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── savedState / 生命周期 ─────────────────────────

describe('codeEditorRenderer：savedState 与生命周期', () => {
  it('savedState 携带 viewState：restoreViewState(viewState) + focus', async () => {
    const viewState = { cursorState: [{ inSelection: false }], scrollLeft: 0 }
    const { editor } = await render({ savedState: { viewState } })
    expect(editor.restoreViewState).toHaveBeenCalledWith(viewState)
    expect(editor.focus).toHaveBeenCalledTimes(1)
  })

  it('无 savedState / 形状不符：不调 restoreViewState', async () => {
    await render({ savedState: 'junk' })
    const editor = monacoMock.editors[monacoMock.editors.length - 1]!
    expect(editor.restoreViewState).not.toHaveBeenCalled()
  })

  it('getState 返回 { viewState }（切 tab 重跑注入 savedState 用）', async () => {
    const { inst } = await render()
    expect(inst.getState).toEqual(expect.any(Function))
    expect(inst.getState?.()).toEqual({ viewState: { line: 1, column: 1 } })
  })

  it('dispose：editor.dispose → model.dispose（DEF-1 顺序红线），按键监听一并移除（dispose 后 Ctrl+S 不再保存）', async () => {
    const { el, ctx, inst, editor } = await render()
    const model = editor.getModel()
    inst.dispose()

    // DEF-1（test-report/2026-10-18-01）：必须先 editor.dispose 后 model.dispose——
    // 反序会同步二连触发 Monaco 内部 emitter 队列（model detach + setModel(null)），
    // 微任务投递重入 → uncaught undefined[0]。用 invocationCallOrder 锁顺序防回退。
    expect(editor.dispose).toHaveBeenCalledTimes(1)
    expect(model?.dispose).toHaveBeenCalledTimes(1)
    const editorOrder = editor.dispose.mock.invocationCallOrder[0] ?? 0
    const modelOrder = model!.dispose.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    expect(editorOrder).toBeLessThan(modelOrder)

    ctx.putObject.mockClear()
    dispatchSave(el)
    await flush()
    expect(ctx.putObject).not.toHaveBeenCalled()
    expect(el.innerHTML).toBe('') // 容器清空
    expect(el.style.getPropertyValue('position')).toBe('') // 注入的 relative 已还原
  })

  it('dispose 容错（DEF-1 P2 防御）：dispose 抛错 → console.warn 就地消化不外抛，容器清理照常', async () => {
    const { el, inst, editor } = await render()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    editor.dispose.mockImplementationOnce(() => {
      throw new Error('mock dispose boom')
    })

    expect(() => inst.dispose()).not.toThrow()
    expect(warn).toHaveBeenCalledWith('CODE_DISPOSE_ERR', expect.stringContaining('mock dispose boom'))
    expect(el.innerHTML).toBe('') // try/catch 不吞 DOM 清理
    warn.mockRestore()
  })
})

// ───────────────────────── 工具栏渲染与文案 ─────────────────────────

describe('codeEditorRenderer：工具栏渲染与文案', () => {
  it('36px 工具条就位：role=toolbar、aria-label=code-editor 词典键、样式含 36px 高度口径与 ghost 取色变量', async () => {
    const { el, inst } = await render()
    const bar = el.querySelector<HTMLElement>('.mmagic-code-bar')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('role')).toBe('toolbar')
    expect(bar?.getAttribute('aria-label')).toBe('i18n:app.code-editor')
    const css = el.querySelector('style')?.textContent ?? ''
    expect(css).toContain('height: 36px') // 插件风格紧凑口径（28px 白底描边钮）
    expect(css).toContain('var(--app-bg-muted)') // ghost hover 底色走 token
    expect(css).toContain('var(--app-text-secondary)') // 取色禁硬编码
    expect(el.style.getPropertyValue('position')).toBe('relative') // root absolute 定位锚
    inst.dispose()
  })

  it('钮位与 i18n 文案：簇内保存/撤销/重做/重置 + 格式化（编辑类）+ 查找/字号±（视图类），title=aria-label 同键', async () => {
    const { el, inst } = await render()
    const cases: Array<[string, string]> = [
      ['save', 'i18n:app.edt-save'],
      ['undo', 'i18n:app.edt-undo'],
      ['redo', 'i18n:app.edt-redo'],
      ['reset', 'i18n:app.edt-reset'],
      ['format', 'i18n:app.code-format'],
      ['find', 'i18n:app.code-find'],
      ['font-inc', 'i18n:app.code-font-inc'],
      ['font-dec', 'i18n:app.code-font-dec'],
    ]
    for (const [act, label] of cases) {
      const b = btn(el, act)
      expect(b.title).toBe(label)
      expect(b.getAttribute('aria-label')).toBe(label)
    }
    // 簇内四钮带 data-edit 标记 + 内联 SVG（统一簇契约，只读按 is-readonly 整簇隐藏）
    expect(clusterEl(el).querySelectorAll('[data-edit="true"]').length).toBe(4)
    expect(btn(el, 'save').querySelector('svg')).not.toBeNull()
    // 编辑类 format 带 data-edit-only 标记（只读闩锁按它隐藏）
    expect(btn(el, 'format').dataset.editOnly).toBe('true')
    expect(btn(el, 'find').dataset.editOnly).toBeUndefined() // 视图类：只读态保留
    inst.dispose()
  })

  it('语言下拉：选项=映射值去重排序+plaintext，初值=按扩展名自动识别', async () => {
    const { el, inst } = await render({ file: { key: 'd/demo.ts', name: 'demo.ts', size: 4 } })
    const sel = el.querySelector<HTMLSelectElement>('.mmagic-code-bar__lang')
    expect(sel).not.toBeNull()
    expect([...sel!.options].map((o) => o.value)).toEqual(LANGUAGE_OPTIONS)
    expect(LANGUAGE_OPTIONS).toContain('plaintext')
    expect(LANGUAGE_OPTIONS).toContain('typescript')
    expect(sel!.value).toBe('typescript') // 按扩展名自动识别
    inst.dispose()
  })

  it('初始干净态：状态徽标为空，保存钮可点、无红点，重置禁用（干净态无可重置）', async () => {
    const { el, inst } = await render()
    expect(statusEl(el).textContent).toBe('')
    expect(btn(el, 'save').disabled).toBe(false)
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(false)
    expect(btn(el, 'reset').disabled).toBe(true)
    inst.dispose()
  })
})

// ───────────────────────── 工具栏动作 ─────────────────────────

describe('codeEditorRenderer：工具栏动作', () => {
  it('保存钮：点击走既有保存链（putObject→notify），与 Ctrl+S 同链', async () => {
    const { el, ctx, editor, inst } = await render()
    editor.listeners[0]!()
    btn(el, 'save').click()
    await flush()
    expect(ctx.putObject).toHaveBeenCalledTimes(1)
    expect(ctx.notify).toHaveBeenCalledWith('saved', { key: 'docs/demo.ts' })
    inst.dispose()
  })

  it('dirty 流转：内容变化→保存钮红点（「未保存」文字徽标废弃）+重置解锁；保存成功→双清', async () => {
    const { el, editor, inst } = await render()
    editor.listeners[0]!()
    expect(statusEl(el).textContent).toBe('')
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(true)
    expect(btn(el, 'reset').disabled).toBe(false)
    btn(el, 'save').click()
    await flush()
    expect(statusEl(el).textContent).toBe('')
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(false)
    expect(btn(el, 'reset').disabled).toBe(true)
    inst.dispose()
  })

  it('重置：dirty 下点击恢复打开时内容并清 dirty（beforeDispose 放行）；干净态禁用不动作', async () => {
    const { el, editor, inst } = await render({ text: TEXT })
    editor.setValue('const changed = true\n')
    editor.listeners[0]!() // 弄脏（fake setValue 不触发监听，手动拍一拍）
    expect(btn(el, 'reset').disabled).toBe(false)
    // 全模型范围须点击前取：mock 的 getFullModelRange 随当前 value 动态变，
    // 点击后 fake executeEdits 已把 value 复位成 TEXT，再取就是恢复态的范围（比较基准漂移）
    const fullRange = editor.getModel().getFullModelRange()
    btn(el, 'reset').click()
    expect(editor.executeEdits).toHaveBeenCalledWith('mmagic-reset', [
      { range: fullRange, text: TEXT },
    ])
    expect(editor.getValue()).toBe(TEXT) // fake executeEdits 落盘通道：恢复原文
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(false)
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(inst.beforeDispose()).toBe(true) // 干净态同步放行
    inst.dispose()
  })

  it('历史可用性：model.canUndo/canRedo → 簇内撤销/重做禁用联动', async () => {
    const { el, editor, inst } = await render()
    const model = editor.getModel()
    expect(btn(el, 'undo').disabled).toBe(true) // 初始空历史
    expect(btn(el, 'redo').disabled).toBe(true)
    model.canUndo.mockReturnValue(true)
    model.canRedo.mockReturnValue(true)
    editor.listeners[0]!() // 内容变化触发 syncBar
    expect(btn(el, 'undo').disabled).toBe(false)
    expect(btn(el, 'redo').disabled).toBe(false)
    inst.dispose()
  })

  it('保存中：保存钮禁用（saving 闸可视化），完成后恢复', async () => {
    const { el, ctx, editor, inst } = await render()
    editor.listeners[0]!()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ctx.putObject.mockReturnValueOnce(gate)
    btn(el, 'save').click()
    expect(btn(el, 'save').disabled).toBe(true)
    release()
    await flush()
    expect(btn(el, 'save').disabled).toBe(false)
    inst.dispose()
  })

  it('撤销/重做：editor.trigger("mmagic-code-bar", "undo"/"redo")', async () => {
    const { el, editor, inst } = await render()
    // 簇内撤销/重做钮随历史栈态禁用（初始空历史=disabled，见「历史可用性」用例，
    // jsdom 对 disabled 钮不派发 click）——先造历史可用态再点
    const model = editor.getModel()
    model.canUndo.mockReturnValue(true)
    model.canRedo.mockReturnValue(true)
    editor.listeners[0]!() // 内容变化触发 syncBar → setHistory 联动解锁
    btn(el, 'undo').click()
    btn(el, 'redo').click()
    expect(editor.trigger).toHaveBeenCalledWith('mmagic-code-bar', 'undo', undefined)
    expect(editor.trigger).toHaveBeenCalledWith('mmagic-code-bar', 'redo', undefined)
    inst.dispose()
  })

  it('格式化钮统一走 doFormat：点击同步触发 worker action.run；action 缺位静默回退不抛', async () => {
    const { el, editor, inst } = await render() // demo.ts → typescript（白名单内）
    const run = vi.fn()
    editor.actions[ACTION_FORMAT] = { run }
    btn(el, 'format').click()
    expect(run).toHaveBeenCalledTimes(1) // doFormat 同步段即调 worker action
    await settleBig() // typescript 自研回退走 js-beautify 动态 import（真模块多拍）

    delete editor.actions[ACTION_FORMAT] // worker action 缺位：跳过 → 自研回退，不抛
    expect(() => btn(el, 'format').click()).not.toThrow()
    await settleBig()
    inst.dispose()
  })

  it('查找：钮点与 Ctrl+F/Cmd+F 均走 actions.find；快捷键拦浏览器默认页内查找', async () => {
    const { el, editor, inst } = await render()
    const run = vi.fn()
    editor.actions['actions.find'] = { run }

    btn(el, 'find').click()
    expect(run).toHaveBeenCalledTimes(1)

    const ev = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    el.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', metaKey: true, ctrlKey: false, cancelable: true }))
    expect(run).toHaveBeenCalledTimes(3)

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, altKey: true, cancelable: true }))
    expect(run).toHaveBeenCalledTimes(3) // Ctrl+Alt+F 不触发（与 Ctrl+S 同守卫口径）
    inst.dispose()
  })

  it('字号增减：updateOptions({fontSize})；边界 9–32 双端收敛', async () => {
    const { el, editor, inst } = await render()
    btn(el, 'font-inc').click()
    expect(editor.updateOptions).toHaveBeenLastCalledWith({ fontSize: 15 })

    for (let i = 0; i < 40; i++) btn(el, 'font-inc').click()
    expect(editor.updateOptions).toHaveBeenLastCalledWith({ fontSize: 32 }) // 上界收敛

    for (let i = 0; i < 40; i++) btn(el, 'font-dec').click()
    expect(editor.updateOptions).toHaveBeenLastCalledWith({ fontSize: 9 }) // 下界收敛
    inst.dispose()
  })

  it('语言手切：change → setModelLanguage(model, 语言 id)', async () => {
    const { el, editor, inst } = await render()
    const sel = el.querySelector<HTMLSelectElement>('.mmagic-code-bar__lang')!
    sel.value = 'python'
    sel.dispatchEvent(new Event('change'))
    expect(monacoMock.setModelLanguage).toHaveBeenCalledTimes(1)
    const [model, lang] = monacoMock.setModelLanguage.mock.calls[0] as unknown as [object, string]
    expect(model).toBe(editor.getModel())
    expect(lang).toBe('python')
    inst.dispose()
  })
})

// ───────────────────────── 运行期只读闩锁（putObject 拒 4305） ─────────────────────────

describe('codeEditorRenderer：运行期只读闩锁', () => {
  /** putObject 拒 4305 的 ctx 替换（单文件模式无 save 段的运行期形态） */
  async function renderWriteDenied() {
    const r = await render()
    r.ctx.putObject.mockRejectedValueOnce(
      Object.assign(new Error('单文件模式为只读（配置无 save 段），无写链'), { code: ERROR_CODES.UNSUPPORTED_MODE }),
    )
    return r
  }

  it('保存拒 4305：editor 转只读、编辑类钮隐藏、视图类保留、只读徽标', async () => {
    const { el, editor, inst } = await renderWriteDenied()
    editor.listeners[0]!() // 先弄脏：徽标可见
    btn(el, 'save').click()
    await flush()

    expect(editor.updateOptions).toHaveBeenCalledWith({ readOnly: true })
    // 簇内四钮只读整簇隐藏（is-readonly + data-edit 的 CSS 契约）
    expect(clusterEl(el).classList.contains('is-readonly')).toBe(true)
    expect(clusterEl(el).querySelectorAll('[data-edit="true"]').length).toBe(4)
    expect(btn(el, 'format').hidden).toBe(true)
    expect(btn(el, 'find').hidden).toBe(false) // 视图类：只读态保留
    const sel = el.querySelector<HTMLSelectElement>('.mmagic-code-bar__lang')!
    expect(sel.hidden).toBe(false)
    expect(statusEl(el).textContent).toBe('i18n:app.code-readonly')
    expect(statusEl(el).classList.contains('is-dirty')).toBe(false)
    inst.dispose()
  })

  it('闩锁后 dirty 复位：关闭不再拦（写不出去的内容无「未保存」可言），Ctrl+S 不再触发写链', async () => {
    const { el, ctx, editor, inst } = await renderWriteDenied()
    editor.listeners[0]!()
    btn(el, 'save').click()
    await flush()
    expect(ctx.putObject).toHaveBeenCalledTimes(1) // 那次被拒的保存

    dispatchSave(el) // 只读后快捷键保存：静默丢弃
    await flush()
    expect(ctx.putObject).toHaveBeenCalledTimes(1)

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(inst.beforeDispose()).toBe(true) // 同步放行
    inst.dispose()
  })

  it('只读态查找仍可用（视图类动作不受闩锁影响）', async () => {
    const { el, editor, inst } = await renderWriteDenied()
    const run = vi.fn()
    editor.actions['actions.find'] = { run }
    btn(el, 'save').click()
    await flush()
    btn(el, 'find').click()
    expect(run).toHaveBeenCalledTimes(1)
    inst.dispose()
  })

  it('瞬时保存失败（非 4305，如网络）：不闩只读、dirty 保持、关闭仍确认', async () => {
    const { el, ctx, editor, inst } = await render()
    ctx.putObject.mockRejectedValueOnce(new Error('network down'))
    editor.listeners[0]!()
    btn(el, 'save').click()
    await flush()

    expect(editor.updateOptions).not.toHaveBeenCalledWith({ readOnly: true })
    expect(btn(el, 'save').disabled).toBe(false)
    expect(statusEl(el).textContent).toBe('') // dirty 只走保存钮红点（文字徽标废弃）
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(true)

    confirmSpy.mockReturnValue(false)
    await expect(inst.beforeDispose()).resolves.toBe(false) // 关闭仍拦
    expect(confirmSpy).toHaveBeenCalledWith('i18n:app.code-unsaved')
    inst.dispose()
  })
})

// ───────────────────────── 格式化双链（worker 优先 + 自研回退） ─────────────────────────

describe('codeEditorRenderer：格式化双链', () => {
  /** json 文件渲染助手（json 是双链主战场：worker=monaco-json formatter、自研=stringify） */
  async function renderJson(text: string) {
    return render({ text, file: { key: 'd/data.json', name: 'data.json', size: text.length } })
  }

  it('worker 原生格式化生效：action.run 改文本 → 直接成功，自研回退不介入', async () => {
    const pretty = '{\n  "a": 1,\n  "b": 2\n}'
    const { el, editor, inst } = await renderJson('{"b":2,"a":1}')
    editor.actions[ACTION_FORMAT] = { run: vi.fn(() => editor.setValue(pretty)) }
    btn(el, 'format').click()
    await settle()
    expect(editor.getValue()).toBe(pretty)
    expect(editor.executeEdits).not.toHaveBeenCalled() // worker 路径已落盘，自研未介入
    expect(toastMock.success).toHaveBeenCalledWith('i18n:app.code-formatted')
    inst.dispose()
  })

  it('worker 无变化（provider 未就绪/已规范）→ 自研回退：json 规整 executeEdits 落盘', async () => {
    const { el, editor, inst } = await renderJson('{"b":2,"a":1}')
    editor.actions[ACTION_FORMAT] = { run: vi.fn() } // run 静默 resolve 且不改文本
    btn(el, 'format').click()
    await settle()
    expect(editor.executeEdits).toHaveBeenCalledWith('mmagic-code-format', [
      { range: expect.anything(), text: '{\n  "b": 2,\n  "a": 1\n}' }, // stringify 重排（键序保留）
    ])
    expect(editor.getValue()).toBe('{\n  "b": 2,\n  "a": 1\n}')
    expect(toastMock.success).toHaveBeenCalledWith('i18n:app.code-formatted')
    inst.dispose()
  })

  it('worker 卡死（run 永不决出）：超时护栏放行 → 自研回退照常落盘', async () => {
    vi.useFakeTimers()
    const { el, editor, inst } = await renderJson('{"b":2,"a":1}')
    editor.actions[ACTION_FORMAT] = { run: vi.fn(() => new Promise<void>(() => undefined)) }
    btn(el, 'format').click()
    await vi.advanceTimersByTimeAsync(FORMAT_WORKER_TIMEOUT_MS + 100)
    expect(editor.executeEdits).toHaveBeenCalledTimes(1)
    expect(toastMock.success).toHaveBeenCalledWith('i18n:app.code-formatted')
    inst.dispose()
  })

  it('白名单外语言（markdown）：toast 不支持，worker/自研均不介入', async () => {
    const { el, editor, inst } = await render({
      text: '# hi',
      file: { key: 'd/readme.md', name: 'readme.md', size: 4 },
    })
    const run = vi.fn()
    editor.actions[ACTION_FORMAT] = { run }
    btn(el, 'format').click()
    await settle()
    expect(toastMock.warning).toHaveBeenCalledWith('i18n:app.code-format-unsupported')
    expect(run).not.toHaveBeenCalled() // 白名单外不触碰 worker action（拦 monaco 英文内置提示）
    expect(editor.executeEdits).not.toHaveBeenCalled()
    inst.dispose()
  })

  it('json 非法：自研回退抛错 → toast 不支持（不误报成功）', async () => {
    const { el, editor, inst } = await renderJson('{oops')
    editor.actions[ACTION_FORMAT] = { run: vi.fn() }
    btn(el, 'format').click()
    await settle()
    expect(toastMock.warning).toHaveBeenCalledWith('i18n:app.code-format-unsupported')
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(editor.executeEdits).not.toHaveBeenCalled()
    inst.dispose()
  })

  it('typescript 在白名单（ts worker formatter）：自研回退 beautify.js 兜底落盘', async () => {
    const { el, editor, inst } = await render({
      text: 'const x:number=1',
      file: { key: 'd/a.ts', name: 'a.ts', size: 15 },
    })
    editor.actions[ACTION_FORMAT] = { run: vi.fn() } // worker 不动文本 → 回退链
    btn(el, 'format').click()
    await settleBig() // js-beautify 动态 import（真模块加载）
    expect(editor.executeEdits).toHaveBeenCalledTimes(1)
    expect(editor.getValue()).toContain('const x: number = 1') // beautify 重排空白，TS 标注不破坏
    expect(toastMock.success).toHaveBeenCalled()
    inst.dispose()
  })
})
