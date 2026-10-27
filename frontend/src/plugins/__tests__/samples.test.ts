/**
 * 插件样例集成测试（Lane H6：审计缺口闭环——「3 个样例只存在于文档」→ 文档样例=可运行代码）
 * 被测：examples/plugins/{todo-viewer,ipynb-viewer,svg-painter}.js（正本：《docs/design/plugin-sample.md》V1.0）
 * 契约：《docs/design/plugin-system.md》V1.1 §二（registerApp/renderer/ctx 能力面）、§五（beforeDispose 暂缓语义）
 * 策略：
 *  - 直接 dynamic import 三个样例模块 → activate(spy sdk) → def 过真实 AppRegistry.register 校验（ok===true）
 *  - 渲染冒烟（jsdom）：fake ctx（getObject→Blob 文本）执行 renderer → 断言预期 DOM；
 *  - svg-painter 保存链：putObject/notify spy 收到；beforeDispose 未保存 → confirm stub true/false 双分支（false=暂缓）
 *  - 文案兜底：host 词典有键=走宿主译文；缺键（ctx.t 原样回 key）=走样例 tt() 兜底文案
 *  - SRI 可钉住性：样例字节现算 crypto.subtle sha384 → hex 恒 96 位（配置片段「sha384-<hex>」可真实生成的锚）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { AppRegistry } from '../../apps/registry'
import { PROTOCOL_VERSION } from '../../sdk/constants'
import type { AppAction, AppCtx, AppDefinition, AppInstance } from '../../sdk/types'
import type { PluginSdkHandle } from '../loader'

// ───────────────────────── 样例装载 ─────────────────────────

type SampleName = 'todo-viewer' | 'ipynb-viewer' | 'svg-painter'

/**
 * 样例正本路径（examples/ 不在 tsconfig include——纯 .js 零构建样例；变量化 import 顺带绕开 TS 模块解析，
 * @vite-ignore 防构建期分析。根绝对路径：vitest/vite 的动态 import 对变量说明符按项目根解析）
 */
const SAMPLE_PATHS: Record<SampleName, string> = {
  'todo-viewer': '/examples/plugins/todo-viewer.js',
  'ipynb-viewer': '/examples/plugins/ipynb-viewer.js',
  'svg-painter': '/examples/plugins/svg-painter.js',
}

/** 样例目录（自本测试文件定位，不受进程 cwd 影响） */
const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/plugins')

interface SampleModule {
  activate: (sdk: PluginSdkHandle) => void
}

async function loadSample(name: SampleName): Promise<SampleModule> {
  const mod = (await import(/* @vite-ignore */ SAMPLE_PATHS[name])) as Partial<SampleModule>
  expect(typeof mod.activate, `样例 ${name} 缺 export activate(sdk)`).toBe('function')
  return mod as SampleModule
}

// ───────────────────────── spy sdk / fake ctx ─────────────────────────

/** 宿主词典形态（与 src/locales/*.ts 的 plugin.* 段一致）——测「宿主有键=走宿主译文」 */
const HOST_ZH: Record<string, string> = {
  'plugin.parse-fail': '插件解析失败',
  'plugin.save': '保存',
  'plugin.unsaved-confirm': '有未保存的修改，确定关闭吗？',
}

/** 样例自带兜底文案（与样例文件内 tt() fallback 字面量一致——本测试即规格锚） */
const SAMPLE_FALLBACK = {
  parseFailIpynb: '无法解析 Notebook JSON',
  parseFailSvg: '无法解析 SVG（XML 语法错误？）',
  save: 'Save',
  unsavedConfirm: '有未保存的修改，确定关闭吗？',
}

interface Harness {
  sdk: PluginSdkHandle
  registry: AppRegistry
  registerApp: Mock
  captured: AppDefinition[]
}

/** spy sdk：registerApp 委托真实 AppRegistry——def 合法性由 registry 判（非测试自说自话） */
function makeSdk(): Harness {
  const registry = new AppRegistry()
  const captured: AppDefinition[] = []
  const registerApp = vi.fn((def: AppDefinition) => {
    const r = registry.register(def)
    if (r.ok) captured.push(def)
    return r
  })
  return { sdk: { version: PROTOCOL_VERSION, registerApp }, registry, registerApp, captured }
}

/** dynamic import → activate(spy sdk) → 收敛出被注册的 def（并证明 registerApp 恰一次且过校验） */
async function activateSample(name: SampleName): Promise<{ def: AppDefinition } & Harness> {
  const h = makeSdk()
  const mod = await loadSample(name)
  mod.activate(h.sdk)
  expect(h.registerApp).toHaveBeenCalledTimes(1)
  // 「过 AppRegistry.register 校验」的锚：registerApp 委托 registry.register 的返回值必须 ok
  expect(h.registerApp.mock.results[0]?.value).toEqual({ ok: true })
  const def = h.captured[0]
  if (!def) throw new Error(`样例 ${name} activate 未注册任何应用`)
  return { ...h, def }
}

interface CtxHarness {
  ctx: AppCtx
  getObject: Mock
  putObject: Mock
  notify: Mock
  t: Mock
}

/**
 * fake ctx：getObject → Blob 文本（AppCtx 契约面：字节流进出，凭证不出）
 * @param hostDictHasKeys true=宿主词典有 plugin.* 键（ctx.t 回译文）；false=缺键（ctx.t 原样回 key → 触发样例 tt 兜底）
 */
function makeCtx(fileText: string, hostDictHasKeys = true): CtxHarness {
  const t = vi.fn((key: string) => (hostDictHasKeys ? (HOST_ZH[key] ?? key) : key))
  const getObject = vi.fn(async () => new Blob([fileText], { type: 'application/octet-stream' }))
  const putObject = vi.fn(async (_key: string, _data: Blob, _contentType?: string) => {})
  const notify = vi.fn()
  const ctx: AppCtx = {
    getObject,
    putObject,
    t,
    theme: {},
    notify,
  }
  return { ctx, getObject, putObject, notify, t }
}

function renderFile(name: string): { key: string; name: string; size: number } {
  return { key: name, name, size: 128 }
}

/** renderer 执行助手：断言返回渲染实例（三样例均声明 dispose） */
async function render(def: AppDefinition, el: HTMLElement, ctx: AppCtx, fileName: string): Promise<AppInstance> {
  const out = await def.renderer(el, renderFile(fileName), ctx)
  expect(out).toBeTruthy()
  return out as AppInstance
}

/** 取 mock 首次调用实参（noUncheckedIndexedAccess 友好） */
function firstCall(m: Mock): unknown[] {
  const call = m.mock.calls[0]
  if (!call) throw new Error('预期至少一次调用')
  return call
}

const SAMPLE_NAMES = ['todo-viewer', 'ipynb-viewer', 'svg-painter'] as const

// ───────────────────────── 1. manifest 注册合法性（文档样例=可运行代码） ─────────────────────────

describe('activate → registerApp：def 过真实 AppRegistry 校验', () => {
  const MANIFESTS: Array<{ name: SampleName; ext: string; actions: AppAction[]; label: string }> = [
    { name: 'todo-viewer', ext: 'todo', actions: ['preview'], label: '清单预览' },
    { name: 'ipynb-viewer', ext: 'ipynb', actions: ['preview'], label: 'Notebook 预览' },
    { name: 'svg-painter', ext: 'svg', actions: ['edit'], label: 'SVG 画板' },
  ]

  for (const m of MANIFESTS) {
    it(`${m.name}：id/matcher/actions/requiresSdk 合法，matcher 端到端命中`, async () => {
      const { def, registry } = await activateSample(m.name)

      expect(def.id).toBe(m.name)
      expect(def.matcher).toEqual({ ext: [m.ext] })
      expect(def.actions).toEqual(m.actions)
      expect(def.label).toBe(m.label)
      expect(def.version).toBe('1.0.0')
      expect(def.requiresSdk).toBe(PROTOCOL_VERSION) // 本批契约=1
      expect(typeof def.renderer).toBe('function')

      // matcher 端到端：注册后按文件名可解析到本应用，非目标扩展名不误吞
      expect(registry.resolveDefault({ name: `demo.${m.ext}` })?.id).toBe(m.name)
      expect(registry.resolveDefault({ name: 'demo.md' })).toBeNull()
    })
  }

  it('三样例同 registry 共存（同类型多应用语义的注册面）', async () => {
    const registry = new AppRegistry()
    const sdk: PluginSdkHandle = { version: PROTOCOL_VERSION, registerApp: (def) => registry.register(def) }
    for (const name of SAMPLE_NAMES) {
      await loadSample(name).then((mod) => mod.activate(sdk))
    }
    expect(registry.list()).toHaveLength(3)
    expect(registry.resolveDefault({ name: 'a.todo' })?.id).toBe('todo-viewer')
    expect(registry.resolveDefault({ name: 'b.ipynb' })?.id).toBe('ipynb-viewer')
    expect(registry.resolveDefault({ name: 'c.svg' })?.id).toBe('svg-painter')
  })
})

// ───────────────────────── 2. todo-viewer 渲染冒烟 ─────────────────────────

describe('todo-viewer：.todo 文本 → 逐行 checkbox 列表（只读预览）', () => {
  const TODO_TEXT = '[x] 买牛奶\n[ ] 写周报\n不是清单行的原文\n\n' // 末尾空行不渲染

  it('逐行渲染：勾选态/原文行/空行跳过；dispose 清 DOM；getObject 走 ctx 取流', async () => {
    const { def } = await activateSample('todo-viewer')
    const { ctx, getObject } = makeCtx(TODO_TEXT)
    const el = document.createElement('div')

    const inst = await render(def, el, ctx, 'todo/a.todo')

    expect(getObject).toHaveBeenCalledWith('todo/a.todo') // getText 语义=ctx.getObject(key).text()
    const items = el.querySelectorAll('li')
    expect(items).toHaveLength(3) // 空行不计
    const boxes = el.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>
    expect(boxes).toHaveLength(3)
    expect(boxes[0]?.checked).toBe(true) // [x]
    expect(boxes[0]?.disabled).toBe(true) // preview 纯读
    expect(boxes[1]?.checked).toBe(false) // [ ]
    expect(boxes[2]?.checked).toBe(false) // 非行格式 → 未勾
    expect(items[0]?.textContent).toContain('买牛奶')
    expect(items[2]?.textContent).toContain('不是清单行的原文')

    inst.dispose()
    expect(el.querySelector('ul')).toBeNull()
  })
})

// ───────────────────────── 3. ipynb-viewer 渲染冒烟 ─────────────────────────

describe('ipynb-viewer：JSON.parse → code/markdown 分色渲染', () => {
  const NB = {
    cells: [
      { cell_type: 'markdown', source: ['# 标题\n', '\n', '说明文字'] },
      { cell_type: 'code', source: 'print("hi")', outputs: [{ text: ['hi\n'] }] },
      {
        cell_type: 'code',
        source: ['1+1'],
        outputs: [{ data: { 'text/plain': '2' } }, { name: 'stdout', text: ['log\n'] }],
      },
    ],
  }

  it('cell 分色 + source 数组/字符串双态 + outputs stream/data 归一；getState 可查', async () => {
    const { def } = await activateSample('ipynb-viewer')
    const { ctx } = makeCtx(JSON.stringify(NB))
    const el = document.createElement('div')

    const inst = await render(def, el, ctx, 'nb/demo.ipynb')

    const codes = el.querySelectorAll('pre.mmf-code')
    const mds = el.querySelectorAll('pre.mmf-markdown')
    expect(codes).toHaveLength(2)
    expect(mds).toHaveLength(1)
    expect(codes[0]?.textContent).toBe('print("hi")') // source 字符串态
    expect(codes[1]?.textContent).toBe('1+1') // source 数组态 join('')
    expect(mds[0]?.textContent).toBe('# 标题\n\n说明文字')
    const quotes = el.querySelectorAll('blockquote')
    expect(quotes).toHaveLength(2)
    expect(quotes[0]?.textContent).toBe('hi\n')
    expect(quotes[1]?.textContent).toBe('2log\n') // data['text/plain'] + stream 文本归一

    expect(inst.getState?.()).toEqual({ cells: 3 }) // 可选：宿主/工作台查询插件态
    inst.dispose()
    expect(el.querySelector('.mmf-plugin-ipynb')).toBeNull()
  })

  it('parse 失败 → 宿主词典提示节点，不抛', async () => {
    const { def } = await activateSample('ipynb-viewer')
    const { ctx, t } = makeCtx('{"cells": broken', true)
    const el = document.createElement('div')

    const inst = await render(def, el, ctx, 'nb/broken.ipynb') // 不抛=渲染冒烟本身通过

    expect(t).toHaveBeenCalledWith('plugin.parse-fail') // i18n 通道强制走宿主词典
    expect(el.textContent).toContain('插件解析失败')
    inst.dispose()
    expect(el.firstChild).toBeNull()
  })

  it('宿主词典缺 plugin.* 键 → tt 兜底样例文案（第三方插件惯例）', async () => {
    const { def } = await activateSample('ipynb-viewer')
    const { ctx, t } = makeCtx('not json at all', false)
    const el = document.createElement('div')

    await render(def, el, ctx, 'nb/broken.ipynb')

    expect(t).toHaveReturnedWith('plugin.parse-fail') // 缺键形态：原样回 key
    expect(el.textContent).toContain(SAMPLE_FALLBACK.parseFailIpynb)
  })

  it('解析结果非对象（如文件内容恰为 null）→ 同走 parse-fail 提示，不抛', async () => {
    const { def } = await activateSample('ipynb-viewer')
    const { ctx } = makeCtx('null', true)
    const el = document.createElement('div')

    await render(def, el, ctx, 'nb/null.ipynb')
    expect(el.textContent).toContain('插件解析失败')
  })
})

// ───────────────────────── 4. svg-painter 渲染/保存链/beforeDispose ─────────────────────────

const SVG_SRC =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#f00"/><script>alert(1)</script></svg>'
const SVG_EDITED =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0f0"/><rect x="1" y="1" width="3" height="3"/></svg>'

describe('svg-painter：textarea 编辑 → 保存链 → beforeDispose 暂缓语义', () => {
  function dirtyEdit(ta: HTMLTextAreaElement, value: string): void {
    ta.value = value
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('初始渲染：textarea 载入原文 + 消毒预览（script 丢弃）+ 保存钮走宿主词典', async () => {
    const { def } = await activateSample('svg-painter')
    const { ctx, t } = makeCtx(SVG_SRC, true)
    const el = document.createElement('div')

    await render(def, el, ctx, 'pic/a.svg')

    expect(t).toHaveBeenCalledWith('plugin.save')
    const ta = el.querySelector('textarea')
    expect(ta).not.toBeNull()
    expect((ta as HTMLTextAreaElement).value).toBe(SVG_SRC)
    const stage = el.querySelector('.mmf-plugin-svg-stage')
    expect(stage?.querySelector('circle')).not.toBeNull() // 消毒后预览
    expect(stage?.querySelector('script')).toBeNull() // XSS 向量丢弃
    expect(el.querySelector('button')?.textContent).toBe('保存')
  })

  it('保存链：编辑→保存钮→putObject(key, Blob[image/svg+xml])+notify(changed)→干净态 beforeDispose 直接过', async () => {
    const { def } = await activateSample('svg-painter')
    const { ctx, putObject, notify } = makeCtx(SVG_SRC, true)
    const el = document.createElement('div')
    const inst = await render(def, el, ctx, 'pic/a.svg')

    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)

    const ta = el.querySelector('textarea') as HTMLTextAreaElement
    dirtyEdit(ta, SVG_EDITED)
    // 预览随编辑实时重建（消毒后）
    expect(el.querySelector('.mmf-plugin-svg-stage')?.querySelector('rect')).not.toBeNull()

    el.querySelector('button')?.click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))

    const call = firstCall(putObject) as [string, Blob]
    expect(call[0]).toBe('pic/a.svg')
    expect(call[1].type).toBe('image/svg+xml')
    await expect(call[1].text()).resolves.toBe(SVG_EDITED) // 写回=编辑器文本
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('changed', { key: 'pic/a.svg' }) // → 宿主 fileChanged(action='put')

    // 已保存=干净：beforeDispose 直接过，不弹 confirm
    const bd = inst.beforeDispose
    if (!bd) throw new Error('svg-painter 渲染实例必须声明 beforeDispose')
    expect(await bd()).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()

    inst.dispose()
    expect(el.firstChild).toBeNull()
    vi.unstubAllGlobals()
  })

  it('beforeDispose：未保存 → confirm true=放行 / false=暂缓关闭；保存后不再询问', async () => {
    const { def } = await activateSample('svg-painter')
    const { ctx, putObject } = makeCtx(SVG_SRC, true)
    const el = document.createElement('div')
    const inst = await render(def, el, ctx, 'pic/a.svg')
    const bd = inst.beforeDispose
    if (!bd) throw new Error('svg-painter 渲染实例必须声明 beforeDispose')

    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)

    const ta = el.querySelector('textarea') as HTMLTextAreaElement
    dirtyEdit(ta, SVG_EDITED)

    // confirm=true → 放行
    expect(await bd()).toBe(true)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith('有未保存的修改，确定关闭吗？')

    // confirm=false → 暂缓关闭（契约：resolve false=暂缓，3 秒超时宿主强制放行）
    confirmSpy.mockReturnValue(false)
    dirtyEdit(ta, SVG_SRC) // 仍处未保存态
    expect(await bd()).toBe(false)
    expect(confirmSpy).toHaveBeenCalledTimes(2)

    // 保存 → 干净 → 不再询问
    el.querySelector('button')?.click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(await bd()).toBe(true)
    expect(confirmSpy).toHaveBeenCalledTimes(2)

    vi.unstubAllGlobals()
  })

  it('宿主词典缺 plugin.* 键 → 保存钮/未保存确认走 tt 兜底文案', async () => {
    const { def } = await activateSample('svg-painter')
    const { ctx, t } = makeCtx(SVG_SRC, false)
    const el = document.createElement('div')
    const inst = await render(def, el, ctx, 'pic/a.svg')

    expect(t).toHaveReturnedWith('plugin.save')
    expect(el.querySelector('button')?.textContent).toBe(SAMPLE_FALLBACK.save)

    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    const ta = el.querySelector('textarea') as HTMLTextAreaElement
    dirtyEdit(ta, SVG_EDITED)
    const bd = inst.beforeDispose
    if (!bd) throw new Error('svg-painter 渲染实例必须声明 beforeDispose')
    expect(await bd()).toBe(false)
    expect(confirmSpy).toHaveBeenCalledWith(SAMPLE_FALLBACK.unsavedConfirm)

    vi.unstubAllGlobals()
  })

  it('预览输入非 SVG（XML 语法错误）→ parse-fail 提示节点，保存链不受影响', async () => {
    const { def } = await activateSample('svg-painter')
    const { ctx, putObject, notify } = makeCtx(SVG_SRC, true)
    const el = document.createElement('div')
    await render(def, el, ctx, 'pic/a.svg')

    const ta = el.querySelector('textarea') as HTMLTextAreaElement
    dirtyEdit(ta, '<svg><g></svg> 残缺 XML')
    expect(el.querySelector('.mmf-plugin-svg-stage')?.textContent).toContain('插件解析失败')

    el.querySelector('button')?.click()
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1))
    expect(notify).toHaveBeenCalledWith('changed', { key: 'pic/a.svg' })
  })
})

// ───────────────────────── 5. SRI 可钉住性（配置片段可真实生成） ─────────────────────────

describe('SRI 可钉住性：样例字节现算 sha384', () => {
  it('三个样例文件字节 → crypto.subtle sha384 → hex 恒 96 位（「sha384-<hex>」配置片段可真实生成）', async () => {
    for (const name of SAMPLE_NAMES) {
      const bytes = new Uint8Array(readFileSync(join(SAMPLES_DIR, `${name}.js`)))
      expect(bytes.byteLength).toBeGreaterThan(0)
      const digest = await crypto.subtle.digest('SHA-384', bytes)
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
      expect(hex).toMatch(/^[0-9a-f]{96}$/)
    }
  })
})
