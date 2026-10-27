/**
 * AppRegistry 单测（Wave1-A7）
 * 被测：src/apps/registry.ts——normalizeExt / normalizeMime / matches / AppRegistry
 * 契约：《docs/design/solution-design.md》V1.2 §4.6、《docs/design/plugin-system.md》V1.1 §一/§二
 * matcher：字段间 AND、同字段内 OR；无任何字段=不命中（防吞所有类型）；
 * ext 命中要求点分隔（`a.todo` 命中 `todo`，裸名 `todo` 无扩展名不命中）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, SdkError } from '../../sdk/errorCodes'
import { PROTOCOL_VERSION } from '../../sdk/constants'
import type { AppDefinition, AppMatcher } from '../../sdk/types'
import { AppRegistry, matches, normalizeExt, normalizeMime } from '../registry'
import type { FileRef } from '../registry'

let seq = 0

/** 构造合法 AppDefinition（renderer 给最小桩，id 缺省自动唯一） */
function def(overrides: Partial<AppDefinition> & { matcher: AppMatcher }): AppDefinition {
  seq += 1
  return {
    id: `app-${seq}`,
    renderer: () => undefined,
    ...overrides,
  }
}

/** 取同步函数抛出的错误（不抛则测试失败） */
function catchSync(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e: unknown) {
    return e
  }
  throw new Error('应抛出异常，却正常返回')
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ───────────────────────── 归一化 ─────────────────────────

describe('normalizeExt', () => {
  it("'.TXT' → 'txt'（去前导点+小写）", () => {
    expect(normalizeExt('.TXT')).toBe('txt')
  })

  it("'md' → 'md'（无点原样小写）", () => {
    expect(normalizeExt('md')).toBe('md')
  })

  it("' .json ' → 'json'（去首尾空白+去前导点）", () => {
    expect(normalizeExt(' .json ')).toBe('json')
  })
})

describe('normalizeMime', () => {
  it("'image/svg+xml; charset=utf-8' → 'image/svg+xml'（去 ; 参数）", () => {
    expect(normalizeMime('image/svg+xml; charset=utf-8')).toBe('image/svg+xml')
  })

  it("'IMAGE/PNG' → 'image/png'（大小写不敏感）", () => {
    expect(normalizeMime('IMAGE/PNG')).toBe('image/png')
  })

  it("' text/plain ' → 'text/plain'（去首尾空白）", () => {
    expect(normalizeMime(' text/plain ')).toBe('text/plain')
  })
})

// ───────────────────────── matches：ext 字段 ─────────────────────────

describe('matches：ext', () => {
  it("{ext:['todo']} 命中 'a.todo'", () => {
    expect(matches({ ext: ['todo'] }, { name: 'a.todo' })).toBe(true)
  })

  it("{ext:['todo']} 命中 'A.TODO'（文件名大小写不敏感）", () => {
    expect(matches({ ext: ['todo'] }, { name: 'A.TODO' })).toBe(true)
  })

  it("{ext:['todo']} 不命中裸名 'todo'（无点分隔=无扩展名）", () => {
    expect(matches({ ext: ['todo'] }, { name: 'todo' })).toBe(false)
  })

  it("{ext:['todo']} 不命中 'todo.bak'", () => {
    expect(matches({ ext: ['todo'] }, { name: 'todo.bak' })).toBe(false)
  })

  it("{ext:['todo']} 不命中 'atodo'（缺点分隔）", () => {
    expect(matches({ ext: ['todo'] }, { name: 'atodo' })).toBe(false)
  })

  it("matcher 项也归一化：{ext:['.TODO']} 命中 'a.todo'", () => {
    expect(matches({ ext: ['.TODO'] }, { name: 'a.todo' })).toBe(true)
  })

  it("同字段内 OR：{ext:['todo','md']} 命中 'a.md'", () => {
    expect(matches({ ext: ['todo', 'md'] }, { name: 'a.md' })).toBe(true)
  })

  it("同字段内 OR：{ext:['todo','md']} 不命中 'a.txt'", () => {
    expect(matches({ ext: ['todo', 'md'] }, { name: 'a.txt' })).toBe(false)
  })

  it("ext 单字段对 mime=undefined 的文件照常命中（S3 常无 mime，只用 ext）", () => {
    expect(matches({ ext: ['todo'] }, { name: 'a.todo' })).toBe(true)
  })
})

// ───────────────────────── matches：mime 字段 ─────────────────────────

describe('matches：mime', () => {
  it("file.mime 带参数仍命中：'image/svg+xml; charset=utf-8' vs {mime:'image/svg+xml'}", () => {
    expect(matches({ mime: 'image/svg+xml' }, { name: 'a.svg', mime: 'image/svg+xml; charset=utf-8' })).toBe(true)
  })

  it('大小写不敏感：{mime:\'IMAGE/SVG+XML\'} vs mime \'image/svg+xml\'', () => {
    expect(matches({ mime: 'IMAGE/SVG+XML' }, { name: 'a.svg', mime: 'image/svg+xml' })).toBe(true)
  })

  it("mime 数组=OR：['image/svg+xml','text/plain'] 命中 'text/plain'", () => {
    expect(matches({ mime: ['image/svg+xml', 'text/plain'] }, { name: 'a.txt', mime: 'text/plain' })).toBe(true)
  })

  it("mime 数组=OR：['image/svg+xml','text/plain'] 不命中 'image/png'", () => {
    expect(matches({ mime: ['image/svg+xml', 'text/plain'] }, { name: 'a.png', mime: 'image/png' })).toBe(false)
  })

  it('file.mime=undefined 不命中 mime matcher', () => {
    expect(matches({ mime: 'image/svg+xml' }, { name: 'a.svg' })).toBe(false)
  })

  it('matcher 侧 mime 带参数也归一化：{mime:\'text/plain;charset=utf-8\'} vs \'text/plain\'', () => {
    expect(matches({ mime: 'text/plain;charset=utf-8' }, { name: 'a.txt', mime: 'text/plain' })).toBe(true)
  })
})

// ───────────────────────── matches：AND / probe / 空 matcher ─────────────────────────

describe('matches：AND / probe / 空 matcher', () => {
  const file: FileRef = { name: 'a.svg', mime: 'image/svg+xml' }

  it('AND：ext 命中但 mime 不命中 → false', () => {
    expect(matches({ ext: ['svg'], mime: 'image/svg+xml' }, { name: 'a.svg', mime: 'image/png' })).toBe(false)
  })

  it('AND：ext 与 mime 均命中 → true', () => {
    expect(matches({ ext: ['svg'], mime: 'image/svg+xml' }, file)).toBe(true)
  })

  it('probe=false → false（即使 ext 命中）', () => {
    expect(matches({ ext: ['todo'], probe: () => false }, { name: 'a.todo' })).toBe(false)
  })

  it('probe 与 ext 同给=AND：probe=true 且 ext 命中 → true', () => {
    expect(matches({ ext: ['todo'], probe: () => true }, { name: 'a.todo' })).toBe(true)
  })

  it('probe 与 ext 同给=AND：probe=true 但 ext 不命中 → false', () => {
    expect(matches({ ext: ['todo'], probe: () => true }, { name: 'a.txt' })).toBe(false)
  })

  it('probe 单字段独立成立：{probe:()=>true} → true', () => {
    expect(matches({ probe: () => true }, { name: 'anything.bin' })).toBe(true)
  })

  it('空 matcher（无字段）→ false（防吞所有类型）', () => {
    expect(matches({}, file)).toBe(false)
  })

  it('空 ext 数组视为无字段 → false', () => {
    expect(matches({ ext: [] }, file)).toBe(false)
  })
})

// ───────────────────────── register ─────────────────────────

describe('AppRegistry.register', () => {
  it('正常注册 ok，get/list 可取', () => {
    const r = new AppRegistry()
    const d = def({ matcher: { ext: ['todo'] } })
    expect(r.register(d)).toEqual({ ok: true })
    expect(r.get(d.id)).toBe(d)
    expect(r.list()).toEqual([d])
  })

  it(`requiresSdk=${PROTOCOL_VERSION}（=PROTOCOL_VERSION）→ ok`, () => {
    const r = new AppRegistry()
    const d = def({ matcher: { ext: ['md'] }, requiresSdk: PROTOCOL_VERSION })
    expect(r.register(d)).toEqual({ ok: true })
    expect(r.get(d.id)).toBe(d)
  })

  it('requiresSdk 缺省 → 不校验，ok', () => {
    const r = new AppRegistry()
    expect(r.register(def({ matcher: { ext: ['md'] } })).ok).toBe(true)
  })

  it('requiresSdk=2 → {ok:false, reason:sdk-version}，且不入表', () => {
    const r = new AppRegistry()
    const d = def({ id: 'future-app', matcher: { ext: ['x2'] }, requiresSdk: 2 })
    expect(r.register(d)).toEqual({ ok: false, reason: 'sdk-version' })
    expect(r.get('future-app')).toBeUndefined()
    expect(r.list()).toEqual([])
  })

  it('同 id 二次注册 → {ok:false, reason:duplicate-id}，保留首个并 warn', () => {
    const r = new AppRegistry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = def({ id: 'md-app', matcher: { ext: ['md'] } })
    const second = def({ id: 'md-app', matcher: { ext: ['markdown'] } })
    expect(r.register(first)).toEqual({ ok: true })
    expect(r.register(second)).toEqual({ ok: false, reason: 'duplicate-id' })
    expect(r.get('md-app')).toBe(first)
    expect(r.list()).toEqual([first])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('md-app'))
  })
})

// ───────────────────────── resolveDefault / listMatches ─────────────────────────

describe('AppRegistry.resolveDefault / listMatches', () => {
  it('无命中 → listMatches=[]、resolveDefault=null', () => {
    const r = new AppRegistry()
    r.register(def({ matcher: { ext: ['svg'] } }))
    const f: FileRef = { name: 'a.md' }
    expect(r.listMatches(f)).toEqual([])
    expect(r.resolveDefault(f)).toBeNull()
  })

  it('单应用：命中者即默认', () => {
    const r = new AppRegistry()
    const svg = def({ matcher: { ext: ['svg'] } })
    const md = def({ matcher: { ext: ['md'] } })
    r.register(svg)
    r.register(md)
    expect(r.resolveDefault({ name: 'a.svg' })).toBe(svg)
    expect(r.resolveDefault({ name: 'a.md' })).toBe(md)
  })

  it('多应用命中 → listMatches 返回全量且按注册序，resolveDefault=首个', () => {
    const r = new AppRegistry()
    const editor = def({ matcher: { ext: ['md'] } })
    const viewer = def({ matcher: { ext: ['md'] } })
    r.register(editor)
    r.register(viewer)
    const f: FileRef = { name: 'a.md' }
    expect(r.listMatches(f)).toEqual([editor, viewer])
    expect(r.resolveDefault(f)).toBe(editor)
  })

  it('注册序跨字段保持：先 ext 后 mime 命中同一文件仍按注册序', () => {
    const r = new AppRegistry()
    const byExt = def({ matcher: { ext: ['md'] } })
    const byMime = def({ matcher: { mime: 'text/markdown' } })
    r.register(byExt)
    r.register(byMime)
    const f: FileRef = { name: 'a.md', mime: 'text/markdown' }
    expect(r.listMatches(f)).toEqual([byExt, byMime])
  })

  it('被拒载的应用（requiresSdk 不符/重复 id）不参与命中', () => {
    const r = new AppRegistry()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    r.register(def({ id: 'ok-app', matcher: { ext: ['todo'] } }))
    r.register(def({ id: 'ok-app', matcher: { ext: ['todo'] } })) // duplicate-id 拒
    r.register(def({ id: 'bad-app', matcher: { ext: ['todo'] }, requiresSdk: 99 })) // sdk-version 拒
    expect(r.listMatches({ name: 'a.todo' })).toHaveLength(1)
    expect(r.resolveDefault({ name: 'a.todo' })?.id).toBe('ok-app')
  })
})

// ───────────────────────── require ─────────────────────────

describe('AppRegistry.require', () => {
  it('存在 → 返回同一 AppDefinition', () => {
    const r = new AppRegistry()
    const d = def({ matcher: { ext: ['svg'] } })
    r.register(d)
    expect(r.require(d.id)).toBe(d)
  })

  it('不存在 → 抛 SdkError 且 code=NOT_FOUND(4102)', () => {
    const r = new AppRegistry()
    const err = catchSync(() => r.require('nope'))
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.NOT_FOUND)
    expect((err as SdkError).code).toBe(4102)
  })
})

// ───────────────────────── unregister ─────────────────────────

describe('AppRegistry.unregister', () => {
  it('注销后命中消失：listMatches/resolveDefault 不再返回，require 抛 NOT_FOUND', () => {
    const r = new AppRegistry()
    const d = def({ id: 'todo-app', matcher: { ext: ['todo'] } })
    r.register(d)
    expect(r.resolveDefault({ name: 'a.todo' })).toBe(d)
    expect(r.unregister('todo-app')).toBe(true)
    expect(r.resolveDefault({ name: 'a.todo' })).toBeNull()
    expect(r.listMatches({ name: 'a.todo' })).toEqual([])
    expect(catchSync(() => r.require('todo-app'))).toBeInstanceOf(SdkError)
  })

  it('注销不存在的 id → false（不抛）', () => {
    const r = new AppRegistry()
    expect(r.unregister('ghost')).toBe(false)
  })
})
