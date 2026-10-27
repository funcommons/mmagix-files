/**
 * PluginLoader 单测（Wave2-A12）
 * 被测：src/plugins/loader.ts——PluginLoader（fetch → SRI 自校验 → import(blobUrl) → activate(sdk)）
 * 契约：《docs/design/plugin-system.md》V1.1 §一/§二/§四
 * 策略：fetcher / importModule 全注入；registry 用真实 AppRegistry 验证接线；
 * SRI 期望值用 crypto.subtle 同算法现算（非硬编码）；失败一律走 onError 不上抛、load 恒 resolve
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { PluginLoader } from '../loader'
import type { PluginSdkHandle } from '../loader'
import { AppRegistry } from '../../apps/registry'
import { ERROR_CODES, SdkError } from '../../sdk/errorCodes'
import { PROTOCOL_VERSION } from '../../sdk/constants'
import type { AppDefinition } from '../../sdk/types'

// ───────────────────────── 环境补丁 ─────────────────────────

/** jsdom 缺 URL.createObjectURL：stub 成可观测 spy（按调用序返回稳定假 blob: URL） */
const createObjectURL = vi.fn((): string => `blob:mock-${createObjectURL.mock.calls.length}`)
/** jsdom 缺 URL.revokeObjectURL：stub 成可观测 spy（loader 在 import 结算后必须回收 blob URL） */
const revokeObjectURL = vi.fn()
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL,
    configurable: true,
    writable: true,
  })
})

beforeEach(() => {
  vi.clearAllMocks() // 清调用记录；实现（createObjectURL 的模板）保留
})

// ───────────────────────── 手写 Fake ─────────────────────────

/** 被加载的「插件字节」：'{}' 的 UTF-8 编码（2 字节，内容无关紧要，有确定哈希即可） */
const BYTES = new TextEncoder().encode('{}')

/** 与实现同算法现算 'sha384-<hex>'（非硬编码，字节改了期望值自动跟随） */
async function sha384Sri(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', bytes)
  return `sha384-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** 只实现 loader 用到的 Response 形状（jsdom 下不依赖真实 fetch Response） */
function fakeResponse(bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as unknown as Response
}

interface Harness {
  loader: PluginLoader
  registry: AppRegistry
  fetcher: Mock
  importModule: Mock
  onError: Mock
  activate: Mock
}

interface HarnessOpts {
  bytes?: Uint8Array
  ok?: boolean
  status?: number
  /** import() 结果；缺省 = { activate }（activate 为 spy，不抛） */
  module?: Record<string, unknown> | null
  fetcherRejects?: boolean
  /** 注册观察（并发/注册语义用例断言） */
  onRegister?: (def: AppDefinition, url: string) => void
}

function makeLoader(opts: HarnessOpts = {}): Harness {
  const registry = new AppRegistry()
  const onError = vi.fn()
  const activate = vi.fn()
  const resolved = opts.module === undefined ? { activate } : opts.module
  const fetcher = opts.fetcherRejects
    ? vi.fn(() => Promise.reject(new TypeError('network down')))
    : vi.fn(async () => fakeResponse(opts.bytes ?? BYTES, opts.ok ?? true, opts.status ?? 200))
  const importModule = vi.fn(async () => resolved) as unknown as Mock
  const loader = new PluginLoader({ registry, fetcher, importModule, onError, onRegister: opts.onRegister })
  return { loader, registry, fetcher, importModule, onError, activate }
}

/** 断言收到的 onError 是 SdkError 且 code 匹配，返回它供 detail 断言 */
function expectOnError(onError: Mock, code: number): SdkError {
  expect(onError).toHaveBeenCalledTimes(1)
  const err = onError.mock.calls[0]?.[0] as unknown
  expect(err).toBeInstanceOf(SdkError)
  expect((err as SdkError).code).toBe(code)
  return err as SdkError
}

/** 最小合法 AppDefinition（renderer 给空桩） */
function pluginDef(id: string, overrides: Partial<AppDefinition> = {}): AppDefinition {
  return { id, matcher: { ext: ['todo'] }, renderer: () => undefined, ...overrides }
}

const URL_ = 'https://cdn.example.com/plugin.js'

// ───────────────────────── 1. 成功路径 ─────────────────────────

describe('成功路径', () => {
  it('fetch 收到 url → import 收到 blob: URL → activate 被调一次且入参 {version, registerApp}', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_, sri: await sha384Sri(BYTES) })

    expect(h.fetcher).toHaveBeenCalledTimes(1)
    expect(h.fetcher).toHaveBeenCalledWith(URL_)

    expect(h.importModule).toHaveBeenCalledTimes(1)
    const blobUrl = h.importModule.mock.calls[0]?.[0] as unknown
    expect(typeof blobUrl).toBe('string')
    expect(blobUrl).toMatch(/^blob:/)

    expect(h.activate).toHaveBeenCalledTimes(1)
    const sdk = h.activate.mock.calls[0]?.[0] as PluginSdkHandle
    expect(sdk.version).toBe(PROTOCOL_VERSION)
    expect(typeof sdk.registerApp).toBe('function')

    expect(h.onError).not.toHaveBeenCalled()
  })

  it('import 收到的就是 loader 用 createObjectURL 造出的那个 URL', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_ })
    expect(h.importModule.mock.calls[0]?.[0]).toBe(createObjectURL.mock.results[0]?.value)
  })

  it('成功后 loader.has(url)=true', async () => {
    const h = makeLoader()
    expect(h.loader.has(URL_)).toBe(false)
    await h.loader.load({ url: URL_ })
    expect(h.loader.has(URL_)).toBe(true)
    expect(h.loader.loadedCount).toBe(1)
  })
})

// ───────────────────────── 2. SRI 自校验 ─────────────────────────

describe('SRI 校验', () => {
  it('sri=正确值（同算法现算）→ 通过并 activate', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_, sri: await sha384Sri(BYTES) })
    expect(h.activate).toHaveBeenCalledTimes(1)
    expect(h.onError).not.toHaveBeenCalled()
  })

  it("sri 错误值 'sha384-deadbeef' → 不 import，onError 收 4201（detail 含 expected/actual）", async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_, sri: 'sha384-deadbeef' })

    expect(h.importModule).not.toHaveBeenCalled()
    expect(h.activate).not.toHaveBeenCalled()

    const err = expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
    const detail = err.detail as { expected?: string; actual?: string }
    expect(detail.expected).toBe('sha384-deadbeef')
    expect(typeof detail.actual).toBe('string')
    expect(detail.actual).toMatch(/^sha384-[0-9a-f]{96}$/) // 实际哈希按真实字节算出
    expect(detail.actual).not.toBe('sha384-deadbeef')
  })

  it('缺 sri → 跳过校验直接 import', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_ })
    expect(h.importModule).toHaveBeenCalledTimes(1)
    expect(h.activate).toHaveBeenCalledTimes(1)
    expect(h.onError).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 3-5. 失败路径 ─────────────────────────

describe('失败路径', () => {
  it('fetch !ok（status 404）→ onError 4201，不 import', async () => {
    const h = makeLoader({ ok: false, status: 404 })
    await h.loader.load({ url: URL_ })
    expect(h.importModule).not.toHaveBeenCalled()
    const err = expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
    expect((err.detail as { status?: number }).status).toBe(404)
    expect(String(err.message)).toContain('404')
  })

  it('模块无 activate 导出 → onError 4201', async () => {
    const h = makeLoader({ module: {} })
    await h.loader.load({ url: URL_ })
    expect(h.activate).not.toHaveBeenCalled() // harness 自己的 activate 不该被碰
    expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
  })

  it('import 返回 null（防御形状）→ onError 4201，不上抛', async () => {
    const h = makeLoader({ module: null })
    await expect(h.loader.load({ url: URL_ })).resolves.toBe(true)
    expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
  })

  it('activate 抛错 → onError 4201（不上抛）', async () => {
    const h = makeLoader()
    h.activate.mockImplementation(() => {
      throw new Error('activate boom')
    })
    await expect(h.loader.load({ url: URL_ })).resolves.toBe(true)
    expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
  })

  it('fetcher reject（网络异常）→ 包装成 SdkError 4201 交给 onError，保留原 message', async () => {
    const h = makeLoader({ fetcherRejects: true })
    await expect(h.loader.load({ url: URL_ })).resolves.toBe(true)
    const err = expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
    expect(String(err.message)).toContain('network down')
    expect(h.importModule).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 6. 幂等去重 ─────────────────────────

describe('幂等去重', () => {
  it('同 url 二次 load → fetcher 仍只被调 1 次', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_, sri: await sha384Sri(BYTES) })
    await expect(h.loader.load({ url: URL_, sri: await sha384Sri(BYTES) })).resolves.toBe(false) // 已载短路
    expect(h.fetcher).toHaveBeenCalledTimes(1)
    expect(h.importModule).toHaveBeenCalledTimes(1)
    expect(h.activate).toHaveBeenCalledTimes(1)
  })

  it('不同 url 各自加载', async () => {
    const h = makeLoader()
    await h.loader.load({ url: 'https://cdn.example.com/a.js' })
    await h.loader.load({ url: 'https://cdn.example.com/b.js' })
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    expect(h.loader.loadedCount).toBe(2)
  })

  it('失败也计入已加载（不重试，重装需整页刷新）', async () => {
    const h = makeLoader({ ok: false, status: 404 })
    await h.loader.load({ url: URL_ })
    await h.loader.load({ url: URL_ })
    expect(h.fetcher).toHaveBeenCalledTimes(1)
    expect(h.onError).toHaveBeenCalledTimes(1) // 不重复上报
  })
})

// ───────────────────────── 7. registerApp 接线 ─────────────────────────

describe('registerApp 接线（真实 AppRegistry）', () => {
  it('activate 内 registerApp(合法 def) → registry.get(id) 命中，返回 {ok:true}', async () => {
    const h = makeLoader()
    let sdk!: PluginSdkHandle
    h.activate.mockImplementation((handle: PluginSdkHandle) => {
      sdk = handle
    })
    await h.loader.load({ url: URL_ })

    const def = pluginDef('plg-hello')
    expect(sdk.registerApp(def)).toEqual({ ok: true })
    expect(h.registry.get('plg-hello')).toBe(def)
  })

  it('requiresSdk 不匹配 → 透传 registry 的 {ok:false, reason:"sdk-version"}，不入表', async () => {
    const h = makeLoader()
    let sdk!: PluginSdkHandle
    h.activate.mockImplementation((handle: PluginSdkHandle) => {
      sdk = handle
    })
    await h.loader.load({ url: URL_ })

    const def = pluginDef('plg-future', { requiresSdk: PROTOCOL_VERSION + 1 })
    const r = sdk.registerApp(def)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('sdk-version')
    expect(h.registry.get('plg-future')).toBeUndefined()
  })

  it('重复 id → 透传 {ok:false, reason:"duplicate-id"}，保留先注册者', async () => {
    const h = makeLoader()
    let sdk!: PluginSdkHandle
    h.activate.mockImplementation((handle: PluginSdkHandle) => {
      sdk = handle
    })
    await h.loader.load({ url: URL_ })

    const first = pluginDef('plg-dup')
    expect(sdk.registerApp(first)).toEqual({ ok: true })
    const second = pluginDef('plg-dup')
    const r = sdk.registerApp(second)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('duplicate-id')
    expect(h.registry.get('plg-dup')).toBe(first)
  })
})

// ───────────────────────── 8. load 恒 resolve ─────────────────────────

describe('load 恒 resolve（失败不 reject）', () => {
  it('全部失败模式均不 reject（首次发起路径恒 resolve true）', async () => {
    const cases: HarnessOpts[] = [
      { ok: false, status: 404 },
      { ok: false, status: 500 },
      { module: {} },
      { module: null },
      { fetcherRejects: true },
    ]
    for (const opts of cases) {
      const h = makeLoader(opts)
      await expect(h.loader.load({ url: URL_, sri: 'sha384-deadbeef' })).resolves.toBe(true)
    }
  })
})

// ───────────────────────── 9. in-flight 竞态（F2） ─────────────────────────

describe('load 并发：按 url memoize 在途 Promise', () => {
  it('并发同 url：第二次 load await 同一 Promise——fetch/import/activate 各恰一次', async () => {
    const h = makeLoader()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.fetcher.mockImplementationOnce(() => gate.then(() => fakeResponse(BYTES)))

    const p1 = h.loader.load({ url: URL_ })
    const p2 = h.loader.load({ url: URL_ })
    expect(h.fetcher).toHaveBeenCalledTimes(1) // 第二次调用未触发第二次 fetch

    let p2Settled = false
    void p2.then(() => {
      p2Settled = true
    })
    expect(p2Settled).toBe(false) // 在途：第二调用方尚未结算

    release()
    await Promise.all([p1, p2])
    expect(p2Settled).toBe(true) // 与首次调用同拍结算（而非幂等短路提前返回）
    expect(h.fetcher).toHaveBeenCalledTimes(1)
    expect(h.importModule).toHaveBeenCalledTimes(1)
    expect(h.activate).toHaveBeenCalledTimes(1)
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('并发同 url：双方结算时注册已完成（registerApp 通道不误报 4201）', async () => {
    const onRegister = vi.fn()
    const h = makeLoader({ onRegister })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.fetcher.mockImplementationOnce(() => gate.then(() => fakeResponse(BYTES)))

    const p1 = h.loader.load({ url: URL_ })
    const p2 = h.loader.load({ url: URL_ })

    // activate 内即注册（等价 main.ts onRegister → appIdByUrl.set）——
    // 若第二调用方被「已载短路」提前放行，会在注册前查表而误报「插件未注册任何应用」
    h.activate.mockImplementation((sdk: PluginSdkHandle) => {
      sdk.registerApp(pluginDef('plg-race'))
    })

    release()
    await Promise.all([p1, p2])

    expect(onRegister).toHaveBeenCalledTimes(1)
    expect(h.registry.get('plg-race')).toBeDefined()
  })

  it('并发失败：双方共享同一次失败（onError 恰一次），结算后不重试', async () => {
    const h = makeLoader({ ok: false, status: 404 })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.fetcher.mockImplementationOnce(() => gate.then(() => fakeResponse(BYTES, false, 404)))

    const p1 = h.loader.load({ url: URL_ })
    const p2 = h.loader.load({ url: URL_ })
    release()
    await Promise.all([p1, p2])

    expect(h.fetcher).toHaveBeenCalledTimes(1)
    expect(h.onError).toHaveBeenCalledTimes(1)
    expect(h.loader.has(URL_)).toBe(true)
    await h.loader.load({ url: URL_ }) // 结算后：已载短路
    expect(h.fetcher).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── 10. blob URL 回收 ─────────────────────────

describe('blob URL 回收（import 结算后 revokeObjectURL）', () => {
  it('成功路径：import 收到的 blob URL 在结算后被 revoke', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_ })
    const blobUrl = h.importModule.mock.calls[0]?.[0] as string
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl)
  })

  it('import 拒绝（失败路径）也 revoke', async () => {
    const h = makeLoader()
    h.importModule.mockImplementationOnce(() => Promise.reject(new TypeError('import failed')))
    await expect(h.loader.load({ url: URL_ })).resolves.toBe(true)
    expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(h.importModule.mock.calls[0]?.[0])
  })

  it('模块缺 activate（import 成功后校验失败）已 revoke', async () => {
    const h = makeLoader({ module: {} })
    await h.loader.load({ url: URL_ })
    expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('activate 抛错也已 revoke（import 早已结算）', async () => {
    const h = makeLoader()
    h.activate.mockImplementation(() => {
      throw new Error('activate boom')
    })
    await h.loader.load({ url: URL_ })
    expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('import 未发生（SRI 不符 / fetch 失败）→ 无 blob 亦无 revoke', async () => {
    const sriFail = makeLoader()
    await sriFail.loader.load({ url: URL_, sri: 'sha384-deadbeef' })
    expect(revokeObjectURL).not.toHaveBeenCalled()

    const fetchFail = makeLoader({ ok: false, status: 404 })
    await fetchFail.loader.load({ url: URL_ })
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 11. options 透传（v1.1 增补） ─────────────────────────

describe('options 透传（activate 第二参）', () => {
  it('entry 带 options → activate 以 (handle, options) 调用，第二参与 entry.options 为同一对象引用', async () => {
    const h = makeLoader()
    const options = { theme: 'dark', limits: { maxApps: 3 }, nested: { flag: true } }
    await h.loader.load({ url: URL_, options })

    expect(h.activate).toHaveBeenCalledTimes(1)
    const call = h.activate.mock.calls[0] as unknown as [PluginSdkHandle, Record<string, unknown> | undefined]
    expect(call).toHaveLength(2) // 固定两参调用：activate(handle, options)
    expect(call[1]).toEqual(options) // deep equal
    expect(call[1]).toBe(options) // 同一引用（非深拷贝/重建）
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('entry 不带 options → activate 第二参为 undefined', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_ })

    expect(h.activate).toHaveBeenCalledTimes(1)
    const call = h.activate.mock.calls[0] as unknown as [PluginSdkHandle, Record<string, unknown> | undefined]
    expect(call).toHaveLength(2) // 缺省也显式传 undefined 第二参（契约注释：缺省不传=undefined 第二参）
    expect(call[1]).toBeUndefined()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('SRI 校验失败的 entry 即使带 options 也不调用 activate（options 路径不绕过校验）', async () => {
    const h = makeLoader()
    await h.loader.load({ url: URL_, sri: 'sha384-deadbeef', options: { sneaky: true } })

    expect(h.importModule).not.toHaveBeenCalled() // 校验失败根本不 import
    expect(h.activate).not.toHaveBeenCalled() // 更不会带着 options 激活
    const err = expectOnError(h.onError, ERROR_CODES.PLUGIN_LOAD_FAILED)
    expect(String(err.message)).toContain('SRI')
  })
})
