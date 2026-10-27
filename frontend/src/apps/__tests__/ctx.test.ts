/**
 * ctx.ts 单测（Wave1-A8）：AppCtx 工厂与 notify→fileChanged 映射
 * 被测：src/apps/ctx.ts——mapNotifyAction / createAppCtx
 * 契约：《docs/design/plugin-system.md》V1.1 §二——ctx 能力面（白名单：凭证不出、字节流进出）
 *       + notify 映射表（'saved'|'changed'→put；'deleted'→delete；'renamed'→rename）
 */
import { describe, expect, it, vi } from 'vitest'
import { createAppCtx, mapNotifyAction } from '../ctx'
import type { AppCtxDeps } from '../ctx'
import type { FileChangedPayload } from '../../sdk/types'

/** 构造全 vi.fn 的 deps：getObject 返回预造 Promise（断言返回引用一致） */
function makeDeps() {
  const blob = new Blob(['hello'])
  const blobPromise = Promise.resolve(blob)
  const deps = {
    getObject: vi.fn((_key: string) => blobPromise),
    putObject: vi.fn((_key: string, _data: Blob, _contentType?: string) => Promise.resolve()),
    t: vi.fn((key: string) => `i18n:${key}`),
    theme: { '--fc-bg': '#ffffff' },
    notifyFileChanged: vi.fn((_payload: FileChangedPayload) => undefined),
  } satisfies AppCtxDeps
  return { deps, blob, blobPromise }
}

// ───────────────────────── mapNotifyAction ─────────────────────────

describe('mapNotifyAction（契约映射表）', () => {
  it("'saved' → 'put'", () => {
    expect(mapNotifyAction('saved')).toBe('put')
  })

  it("'changed' → 'put'", () => {
    expect(mapNotifyAction('changed')).toBe('put')
  })

  it("'deleted' → 'delete'", () => {
    expect(mapNotifyAction('deleted')).toBe('delete')
  })

  it("'renamed' → 'rename'", () => {
    expect(mapNotifyAction('renamed')).toBe('rename')
  })
})

// ───────────────────────── createAppCtx：能力面透传 ─────────────────────────

describe('createAppCtx：能力面透传', () => {
  it('getObject(key)：参数透传，返回同一 Promise 引用，解析为同一 Blob', async () => {
    const { deps, blobPromise, blob } = makeDeps()
    const ctx = createAppCtx(deps)
    const out = ctx.getObject('docs/a.md')
    expect(deps.getObject).toHaveBeenCalledTimes(1)
    expect(deps.getObject).toHaveBeenCalledWith('docs/a.md')
    expect(out).toBe(blobPromise)
    await expect(out).resolves.toBe(blob)
  })

  it('putObject(key, data, contentType)：三参透传', async () => {
    const { deps, blob } = makeDeps()
    const ctx = createAppCtx(deps)
    await ctx.putObject('docs/a.md', blob, 'text/markdown')
    expect(deps.putObject).toHaveBeenCalledTimes(1)
    expect(deps.putObject).toHaveBeenCalledWith('docs/a.md', blob, 'text/markdown')
  })

  it('putObject 缺省 contentType → 透传 undefined（不篡改默认值）', async () => {
    const { deps, blob } = makeDeps()
    const ctx = createAppCtx(deps)
    await ctx.putObject('docs/a.md', blob)
    expect(deps.putObject).toHaveBeenCalledWith('docs/a.md', blob, undefined)
  })

  it('t(key)：透传并返回宿主词典文案', () => {
    const { deps } = makeDeps()
    const ctx = createAppCtx(deps)
    expect(ctx.t('ctx.save')).toBe('i18n:ctx.save')
    expect(deps.t).toHaveBeenCalledTimes(1)
    expect(deps.t).toHaveBeenCalledWith('ctx.save')
  })

  it('theme：与 deps.theme 同一引用（不拷贝）', () => {
    const { deps } = makeDeps()
    expect(createAppCtx(deps).theme).toBe(deps.theme)
  })
})

// ───────────────────────── createAppCtx：notify → fileChanged ─────────────────────────

describe('createAppCtx：notify → fileChanged 映射', () => {
  it("notify('changed',{key:'a'}) → {key:'a', action:'put', from:undefined}", () => {
    const { deps } = makeDeps()
    const ctx = createAppCtx(deps)
    ctx.notify('changed', { key: 'a' })
    expect(deps.notifyFileChanged).toHaveBeenCalledTimes(1)
    expect(deps.notifyFileChanged).toHaveBeenCalledWith({ key: 'a', action: 'put', from: undefined })
    // 显式携带 from 字段（=undefined），而非整个省略
    const payload = deps.notifyFileChanged.mock.calls[0]![0]
    expect(Object.prototype.hasOwnProperty.call(payload, 'from')).toBe(true)
  })

  it("notify('saved',{key:'a.md'}) → action 'put'", () => {
    const { deps } = makeDeps()
    createAppCtx(deps).notify('saved', { key: 'a.md' })
    expect(deps.notifyFileChanged).toHaveBeenCalledWith({ key: 'a.md', action: 'put', from: undefined })
  })

  it("notify('deleted',{key:'gone.txt'}) → {action:'delete', from:undefined}", () => {
    const { deps } = makeDeps()
    createAppCtx(deps).notify('deleted', { key: 'gone.txt' })
    expect(deps.notifyFileChanged).toHaveBeenCalledWith({ key: 'gone.txt', action: 'delete', from: undefined })
  })

  it("notify('renamed',{key:'b',from:'x'}) → {key:'b', action:'rename', from:'x'}", () => {
    const { deps } = makeDeps()
    const ctx = createAppCtx(deps)
    ctx.notify('renamed', { key: 'b', from: 'x' })
    expect(deps.notifyFileChanged).toHaveBeenCalledTimes(1)
    expect(deps.notifyFileChanged).toHaveBeenCalledWith({ key: 'b', action: 'rename', from: 'x' })
  })
})
