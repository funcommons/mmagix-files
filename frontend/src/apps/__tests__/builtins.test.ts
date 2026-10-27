/**
 * 内置应用预置表单测（Wave2-A11）
 * 契约正本：builtins.ts 文件头注释——「正本：《docs/product/PRD.md》§一应用清单」
 * （正本 docs/product/PRD.md §3.2；测试侧以 builtins.ts 头注释口径为核对基准：13 个内置 + fallback 常量不入表）
 *
 * 覆盖点：
 *  1. 表完整性——code 无重复；每项 code/labelKey/matcher/actions 齐全；actions 与 type 语义一致
 *     （edit 类含 'edit'、view 类含 'preview'，互不串）
 *  2. id 集合 = 13 个内置；FALLBACK_APP_ID='fallback-download' 是独立常量，不入表
 *     （空 matcher 语义=不命中，防吞所有类型，走 resolveOrFallback 链）
 *  3. registerBuiltins——新 AppRegistry 返回全集 13 个（注册序）；注册序=默认应用优先级：
 *     a.png→image-viewer（首个图片类）；a.md 双命中 markdown-renderer+code-editor 且默认=前者；
 *     a.csv/a.tsv 默认=csv-table（F3 契约：渲染类先于 code-editor 注册，文本态经「打开方式」）；
 *     a.heic→heic-viewer；a.unknown→null
 *  4. renderers 注入——注入的 code 用注入方 renderer；未注入用占位渲染器（jsdom el 上执行
 *     返回 {dispose}，dispose 后 DOM 还原）
 *  5. 二次 registerBuiltins（同 registry）——全部拒载（duplicate-id，逐条 warn），返回空集，
 *     原注册项不被覆盖（首注册注入的 renderer 保持不变）
 */
import { describe, expect, it, vi } from 'vitest'
import { AppRegistry } from '../registry'
import {
  BUILTIN_APP_SPECS,
  CODE_MAX_BYTES,
  CSV_TABLE_MAX_BYTES,
  FALLBACK_APP_ID,
  HEIC_VIEWER_MAX_BYTES,
  MARKDOWN_MAX_BYTES,
  registerBuiltins,
} from '../builtins'
import { PROTOCOL_VERSION } from '../../sdk/constants'
import type { AppCtx, AppInstance } from '../../sdk/types'

/** 计划 §一表口径：13 个内置应用 id（image-painter 已拆除）（即注册序；fallback-download 不入表）。
 *  F3 修订：csv-table/html-viewer 先于 code-editor（注册序=默认应用优先级，渲染类默认可达——
 *  html 默认进净化式预览，源码/三态编辑经「打开方式」）；
 *  图示双应用（flow-editor/mermaid-viewer）依据《../../../../docs/design/flow-editor-design.md》V1.0 增补 */
const EXPECTED_IDS = [
  'image-viewer',
  'video-player',
  'audio-player',
  'pdf-viewer',
  'markdown-renderer',
  'flow-editor',
  'mermaid-viewer',
  'csv-table',
  'html-viewer',
  'code-editor',
  'heic-viewer',
  'docx-viewer',
  'xlsx-viewer',
]

/** AppCtx 桩：占位渲染器不触达 ctx，只需形状完整供调用侧类型收窄 */
function noopCtx(): AppCtx {
  return {
    getObject: vi.fn(async () => new Blob()),
    putObject: vi.fn(async () => undefined),
    t: (key: string) => key,
    notify: vi.fn(),
    theme: {},
  }
}

/** 渲染文件实参（占位渲染器只用 el，其余字段满足签名即可） */
const RENDER_FILE = { key: 'dir/a.txt', name: 'a.txt', size: 3 }

describe('BUILTIN_APP_SPECS 表完整性', () => {
  it('共 13 项，id 集合与计划 §一表一致（注册序），fallback-download 不入表', () => {
    expect(BUILTIN_APP_SPECS).toHaveLength(13)
    expect(BUILTIN_APP_SPECS.map((s) => s.code)).toEqual(EXPECTED_IDS)
    expect(BUILTIN_APP_SPECS.map((s) => s.code)).not.toContain(FALLBACK_APP_ID)
    expect(FALLBACK_APP_ID).toBe('fallback-download')
  })

  it('code 无重复', () => {
    const codes = BUILTIN_APP_SPECS.map((s) => s.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('每项 code/labelKey/matcher.ext/actions 齐全（labelKey 走 app.<code> 词典口径）', () => {
    for (const spec of BUILTIN_APP_SPECS) {
      expect(spec.code.trim(), `${spec.code}: code 非空`).not.toBe('')
      expect(spec.labelKey.trim(), `${spec.code}: labelKey 非空`).not.toBe('')
      expect(spec.labelKey, `${spec.code}: labelKey=词典 key`).toBe(`app.${spec.code}`)
      expect(Array.isArray(spec.matcher.ext), `${spec.code}: matcher.ext 是数组`).toBe(true)
      expect(spec.matcher.ext!.length, `${spec.code}: matcher.ext 非空`).toBeGreaterThan(0)
      expect(
        spec.matcher.ext!.every((e) => typeof e === 'string' && e.trim() !== ''),
        `${spec.code}: matcher.ext 项均为非空串`,
      ).toBe(true)
      expect(Array.isArray(spec.actions), `${spec.code}: actions 是数组`).toBe(true)
      expect(spec.actions.length, `${spec.code}: actions 非空`).toBeGreaterThan(0)
    }
  })

  it('actions 与 type 语义一致：edit 类含 edit 不含 preview；view 类含 preview 不含 edit', () => {
    for (const spec of BUILTIN_APP_SPECS) {
      if (spec.type === 'edit') {
        expect(spec.actions, `${spec.code}: edit 类含 'edit'`).toContain('edit')
        expect(spec.actions, `${spec.code}: edit 类不含 'preview'`).not.toContain('preview')
      } else {
        expect(spec.actions, `${spec.code}: view 类含 'preview'`).toContain('preview')
        expect(spec.actions, `${spec.code}: view 类不含 'edit'`).not.toContain('edit')
      }
    }
  })
})

describe('渲染器字节限额登记（R2-03：预览闸与渲染器单一事实源）', () => {
  const MB = 1024 * 1024

  it('spec maxBytes 值：markdown=code=5MiB、csv=20MiB、heic=32MiB；其余应用不登记（undefined）', () => {
    const byCode = new Map(BUILTIN_APP_SPECS.map((s) => [s.code, s]))
    expect(byCode.get('markdown-renderer')?.maxBytes).toBe(5 * MB)
    expect(byCode.get('code-editor')?.maxBytes).toBe(5 * MB)
    expect(byCode.get('csv-table')?.maxBytes).toBe(20 * MB)
    expect(byCode.get('heic-viewer')?.maxBytes).toBe(32 * MB)
    expect(byCode.get('mermaid-viewer')?.maxBytes).toBe(5 * MB)
    expect(byCode.get('flow-editor')?.maxBytes).toBe(5 * MB)
    for (const noLimit of ['image-viewer', 'video-player', 'audio-player', 'pdf-viewer', 'docx-viewer', 'xlsx-viewer']) {
      expect(byCode.get(noLimit)?.maxBytes, `${noLimit}: 不登记 maxBytes`).toBeUndefined()
    }
  })

  it('导出常量与 spec 同源（渲染器 import 同一常量，杜绝双份字面量漂移）', () => {
    expect(MARKDOWN_MAX_BYTES).toBe(5 * MB)
    expect(CODE_MAX_BYTES).toBe(5 * MB)
    expect(CSV_TABLE_MAX_BYTES).toBe(20 * MB)
    expect(HEIC_VIEWER_MAX_BYTES).toBe(32 * MB)
  })

  it('registerBuiltins 把 spec.maxBytes 透传到 AppDefinition（预览闸读取入口）', () => {
    const registry = new AppRegistry()
    registerBuiltins(registry)
    expect(registry.get('csv-table')?.maxBytes).toBe(CSV_TABLE_MAX_BYTES)
    expect(registry.get('markdown-renderer')?.maxBytes).toBe(MARKDOWN_MAX_BYTES)
    expect(registry.get('code-editor')?.maxBytes).toBe(CODE_MAX_BYTES)
    expect(registry.get('heic-viewer')?.maxBytes).toBe(HEIC_VIEWER_MAX_BYTES)
    expect(registry.get('pdf-viewer')?.maxBytes).toBeUndefined()
  })
})

describe('registerBuiltins', () => {
  it('新 AppRegistry：返回全集 13 个（注册序），registry.list 同长', () => {
    const registry = new AppRegistry()
    expect(registerBuiltins(registry)).toEqual(EXPECTED_IDS)
    expect(registry.list()).toHaveLength(13)
  })

  it('spec → AppDefinition 映射：label=词典 key、matcher/actions 透传、requiresSdk=协议主版本', () => {
    const registry = new AppRegistry()
    registerBuiltins(registry)
    const spec = BUILTIN_APP_SPECS.find((s) => s.code === 'xlsx-viewer')!
    const def = registry.get('xlsx-viewer')!
    expect(def.id).toBe('xlsx-viewer')
    expect(def.label).toBe(spec.labelKey)
    expect(def.matcher).toEqual(spec.matcher)
    expect(def.actions).toEqual(spec.actions)
    expect(def.requiresSdk).toBe(PROTOCOL_VERSION)
    expect(typeof def.version).toBe('string')
    expect(typeof def.renderer).toBe('function')
  })

  it('resolveDefault：a.png → image-viewer（注册序第一个图片类；image-painter 已拆除，默认位唯一）', () => {
    const registry = new AppRegistry()
    registerBuiltins(registry)
    expect(registry.resolveDefault({ name: 'a.png' })?.id).toBe('image-viewer')
  })

  it('a.md：listMatches 命中 markdown-renderer 与 code-editor 两个（注册序），默认=markdown-renderer', () => {
    const registry = new AppRegistry()
    registerBuiltins(registry)
    expect(registry.listMatches({ name: 'a.md' }).map((d) => d.id)).toEqual([
      'markdown-renderer',
      'code-editor',
    ])
    expect(registry.resolveDefault({ name: 'a.md' })?.id).toBe('markdown-renderer')
  })

  // F3 契约：csv/tsv 默认进 csv-table 表格预览；code-editor 仍命中（「打开方式」次选），但不再抢占默认
  it('a.csv/a.tsv：默认=csv-table（注册序先于 code-editor），code-editor 仍在命中列表', () => {
    const registry = new AppRegistry()
    registerBuiltins(registry)
    expect(registry.listMatches({ name: 'a.csv' }).map((d) => d.id)).toEqual([
      'csv-table',
      'code-editor',
    ])
    expect(registry.resolveDefault({ name: 'a.csv' })?.id).toBe('csv-table')
    expect(registry.resolveDefault({ name: 'a.tsv' })?.id).toBe('csv-table')
  })

  it('a.heic → heic-viewer；a.unknown → null', () => {
    const registry = new AppRegistry()
    registerBuiltins(registry)
    expect(registry.resolveDefault({ name: 'a.heic' })?.id).toBe('heic-viewer')
    expect(registry.resolveDefault({ name: 'a.unknown' })).toBeNull()
  })

  it('renderers 注入：注入的 code 用注入 renderer（且注册不调用）；未注入用占位（可渲染、可 dispose）', () => {
    const registry = new AppRegistry()
    const spy = vi.fn(() => undefined)
    const registered = registerBuiltins(registry, { 'image-viewer': spy })
    expect(registered).toHaveLength(13)
    expect(registry.get('image-viewer')?.renderer).toBe(spy)
    expect(spy).not.toHaveBeenCalled()

    // 占位渲染器：同步执行 → el 挂占位提示节点，返回 {dispose}，dispose 后还原
    const el = document.createElement('div')
    const renderer = registry.get('code-editor')!.renderer
    const ret = renderer(el, RENDER_FILE, noopCtx())
    expect(ret).not.toBeInstanceOf(Promise)
    const inst = ret as AppInstance
    expect(inst && typeof inst.dispose === 'function').toBe(true)
    expect(el.childElementCount).toBe(1)
    inst.dispose()
    expect(el.childElementCount).toBe(0)
  })

  it('二次注册（同 registry）：全部拒载（duplicate-id 逐条 warn），返回空集且不覆盖原注册项', () => {
    const registry = new AppRegistry()
    const spy = vi.fn(() => undefined)
    registerBuiltins(registry, { 'image-viewer': spy })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(registerBuiltins(registry)).toEqual([])
      expect(registry.list()).toHaveLength(13)
      // registry 仅在 id 冲突时 warn → 13 条 warn 覆盖全部 code，即拒载原因=duplicate-id
      expect(warn).toHaveBeenCalledTimes(13)
      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n')
      for (const id of EXPECTED_IDS) expect(warned, `warn 含 ${id}`).toContain(id)
      // 拒载不覆盖：首注册注入的 renderer 保持不变
      expect(registry.get('image-viewer')?.renderer).toBe(spy)
    } finally {
      warn.mockRestore()
    }
  })
})
