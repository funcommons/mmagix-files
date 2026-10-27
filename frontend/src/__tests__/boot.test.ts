/**
 * bootApp 装配层单测（Wave2-A9）
 * 契约：《docs/design/jsdk-api.md》V1.0 §三（握手时序：先 ack 后 evt）、《docs/design/solution-design.md》V1.2 §4.1/§4.2
 *
 * 策略（A1 已探明 jsdom 限制：window.parent/opener 只读、postMessage 的 event.origin 恒为空串）：
 *  - 注入 FakeWindow 纯对象（实现 addEventListener/removeEventListener/location/document.referrer/parent，
 *    parent = fake remote ≠ win，走 iframe 分支）+ fake remote（{ postMessage: vi.fn() }）作宿主窗；
 *    出站断言 remote.postMessage 调用参数（信封 + targetOrigin）；
 *  - 入站 cmd 用 fakeWin 捕获的 message listener 手动派发 { origin, data }（bus.handleMessage 只读这两字段，
 *    无需真实 MessageEvent）。
 *
 * 覆盖点：坏配置 4001 不抛 / ready 握手（序列化无凭证子串）/ getInfo expiresInSec（有 ttl / 无 ttl=-1）/
 * TTL 硬帽截断 / destroy 先 reply 后 evt:expired（顺序）/ file 模式 4305 / 白名单外静默 /
 * 异步失败经 ctx.replyError 回包 / dispose 后不再发 expired / ttl 到点派发 expired 且总线保活（终态后 cmd 回 5000，F4）。
 *
 * 【注·异步失败用例的实现方式】BootOptions 未暴露 handlers overrides（该缝在 createCommandHandlers 内部
 * 闭合、装配层未透传），故以在 handle.bus 上追加一个「1 拍微任务即 reject」的异步 handler 驱动同一条
 * replyError 路径：内置 navigate 桩的失败链需 2 拍，bus 的首回包优先语义 ⇒ 4101 确定性胜出。
 * 同步抛错经 wrapCommand 异步链转 replyError 的路径另由 file 模式 4305 用例覆盖；M1 集成测试再补真实业务链。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootApp } from '../boot'
import type { BootHandle, BootResult } from '../boot'
import { AppRegistry } from '../apps/registry'
import { MessageBus } from '../sdk/bus'
import type { MessageHandler } from '../sdk/bus'
import { NS, PROTOCOL_VERSION, TTL_HARD_CAP_SEC } from '../sdk/constants'
import { ERROR_CODES, SdkError } from '../sdk/errorCodes'
import { SDK_VERSION } from '../sdk/handlers'
import { RAW_CONFIG_STORAGE_KEY } from '../sdk/config'
import { SessionController } from '../sdk/session'

// ───────────────────────── 测试基建 ─────────────────────────

/** 宿主源（白名单内 / 发送 targetOrigin）与其 referrer */
const HOST_ORIGIN = 'https://host.example.com'
const REFERRER = 'https://host.example.com/app'

/** 出站信封形状（断言用；message 形参在 bus 内部构造，测试侧只做形状收窄） */
interface OutEnvelope {
  ns: string
  v: number
  kind: 'cmd' | 'evt' | 'reply'
  id: string
  name: string
  payload: unknown
  ok?: boolean
  code?: number
}

/**
 * FakeWindow + fake remote：iframe 场景（parent=remote≠win）。
 * 捕获 message 监听器，入站经 dispatchInbound(origin, data) 手动派发。
 * 可选 sessionStorage 注入（刷新重建会话用例：两个 FakeWindow 共享同一 Storage 模拟同页签刷新）。
 */
function makeFakeWindow(opts: { hash: string; referrer: string; sessionStorage?: Storage }) {
  const postMessage = vi.fn<(message: unknown, targetOrigin: string) => void>()
  const remote = { postMessage } as unknown as Window
  const listeners = new Set<(e: unknown) => void>()
  const win = {
    location: { hash: opts.hash },
    document: { referrer: opts.referrer },
    parent: remote, // ≠ win ⇒ bootApp 走 iframe 分支，remoteWindow()=parent
    ...(opts.sessionStorage ? { sessionStorage: opts.sessionStorage } : {}),
    addEventListener(type: string, listener: (e: unknown) => void) {
      if (type === 'message') listeners.add(listener)
    },
    removeEventListener(type: string, listener: (e: unknown) => void) {
      if (type === 'message') listeners.delete(listener)
    },
  }
  const dispatchInbound = (origin: string, data: unknown): void => {
    for (const l of [...listeners]) l({ origin, data } as MessageEvent)
  }
  const outbound = (): OutEnvelope[] => postMessage.mock.calls.map((c) => c[0] as OutEnvelope)
  return { win: win as unknown as Window, postMessage, dispatchInbound, outbound }
}

type FakeBundle = ReturnType<typeof makeFakeWindow>

/** afterEach 统一 dispose，防会话定时器跨用例泄漏 */
const cleanups: Array<() => void> = []

/** bootApp 成功路径：断言 ok 并登记 dispose 清理 */
function bootOk(fake: FakeBundle): BootHandle {
  const result: BootResult = bootApp({ win: fake.win })
  if (!result.ok) {
    throw new Error(`bootApp 应成功，实际失败 code=${result.error.code}: ${String(result.error.message)}`)
  }
  cleanups.push(() => result.handle.dispose())
  return result.handle
}

/** workspace 合法配置（凭证用显眼假值，供「不泄漏」断言检索）；ttlSeconds 缺省=不带该键 */
function workspaceConfig(ttlSeconds?: number) {
  return {
    v: 1,
    backend: {
      endpoint: 'https://oss-cn-hangzhou.example.com',
      region: 'cn-hangzhou',
      bucket: 'mmagic-bkt',
      prefix: 'u/42/',
      credentials: {
        accessKeyId: 'AKID-should-not-leak',
        accessKeySecret: 'AKSECRET-should-not-leak',
        sessionToken: 'STSTOKEN-should-not-leak',
      },
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    },
    security: { allowedOrigins: [HOST_ORIGIN] },
  }
}

/** 单文件模式合法配置（无 security ⇒ 装配层从 referrer 推导白名单与 targetOrigin） */
const fileConfig = () => ({
  v: 1,
  source: { url: 'https://cdn.example.com/docs/report.pdf' },
  save: { method: 'PUT', url: 'https://cdn.example.com/docs/report.pdf' },
})

const configHash = (cfg: unknown) => `#config=${encodeURIComponent(JSON.stringify(cfg))}`
const fileHash = () => `#file=${encodeURIComponent(JSON.stringify(fileConfig()))}`

/** 内存版 Storage（模拟同页签 sessionStorage：两个 FakeWindow 共享实例=一次刷新） */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size
    },
  }
}

/** 入站 cmd 信封 */
const cmdEnv = (name: string, id: string, payload: unknown = {}) => ({
  ns: NS,
  v: PROTOCOL_VERSION,
  kind: 'cmd' as const,
  id,
  name,
  payload,
})

/** 只冲微任务、不进宏任务——expired 的 emit 挂在 setTimeout(0)，过早进宏任务会破坏 ack/expired 分步断言 */
async function flushMicro(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ───────────────────────── ① 配置解析 ─────────────────────────

describe('bootApp：配置解析（步骤①）', () => {
  it('坏配置（JSON 解析失败）→ {ok:false, error.code=4001}，不抛、无任何外发', () => {
    const fake = makeFakeWindow({ hash: '#config=%7Bbad', referrer: REFERRER }) // %7Bbad → '{bad' → JSON.parse 炸
    let captured: BootResult | undefined
    expect(() => {
      captured = bootApp({ win: fake.win })
    }).not.toThrow()

    expect(captured).toBeDefined()
    if (!captured || captured.ok) throw new Error('bootApp 应返回 ok:false')
    expect(captured.error).toBeInstanceOf(SdkError)
    expect(captured.error.code).toBe(ERROR_CODES.BAD_CONFIG)
    expect(fake.postMessage).not.toHaveBeenCalled() // 配置失败：不建通道、不发错误事件
  })

  it('fragment 缺配置键（hash 为空）→ 4001', () => {
    const fake = makeFakeWindow({ hash: '', referrer: REFERRER })
    const result = bootApp({ win: fake.win })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ERROR_CODES.BAD_CONFIG)
    expect(fake.postMessage).not.toHaveBeenCalled()
  })
})

// ───────────────────────── ⑥ 握手（workspace happy path） ─────────────────────────

describe('bootApp：workspace 握手（步骤⑥）', () => {
  it('ready 信封：ns/v/kind/name + payload 三要素（sdkVersion/protocolVersion/configSummary）；序列化无凭证子串；markRemoteReady 已置位', () => {
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig()), referrer: REFERRER })
    const handle = bootOk(fake)

    expect(fake.postMessage).toHaveBeenCalledTimes(1)
    const [raw, target] = fake.postMessage.mock.calls[0]!
    const env = raw as OutEnvelope
    expect(target).toBe(HOST_ORIGIN) // targetOrigin = referrer origin（精确源）
    expect(env).toMatchObject({ ns: NS, v: PROTOCOL_VERSION, kind: 'evt', name: 'ready' })

    const payload = env.payload as Record<string, unknown>
    expect(payload.sdkVersion).toBe(SDK_VERSION)
    expect(payload.protocolVersion).toBe(PROTOCOL_VERSION)
    expect((payload.configSummary as Record<string, unknown>).mode).toBe('workspace')

    // 硬约束：ready 全包（含 configSummary）不得携带任何凭证
    const serialized = JSON.stringify(raw)
    expect(serialized).not.toContain('accessKey')
    expect(serialized).not.toContain('sessionToken')
    expect(serialized).not.toContain('should-not-leak')

    // 先 emit 后 markRemoteReady（§三）
    expect(handle.bus.isRemoteReady).toBe(true)
    // 装配产物形状
    expect(handle.config.mode).toBe('workspace')
    expect(handle.win).toBe(fake.win)
    expect(handle.bus).toBeInstanceOf(MessageBus)
    expect(handle.session).toBeInstanceOf(SessionController)
    expect(handle.registry).toBeInstanceOf(AppRegistry)
    expect(typeof handle.dispose).toBe('function')
  })
})

// ───────────────────────── ④ 命令派发（入站 cmd → 出站 reply） ─────────────────────────

describe('bootApp：getInfo（会话 TTL 回报）', () => {
  it('ttlSeconds=3600 → ok reply，expiresInSec 为数值且 ∈ (0, 3600]', async () => {
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig(3600)), referrer: REFERRER })
    bootOk(fake)

    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('getInfo', 'gi-1', {}))
    await flushMicro()

    const replies = fake.outbound().filter((e) => e.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'gi-1', name: 'getInfo', ok: true })
    const sec = (replies[0]!.payload as { session?: { expiresInSec?: unknown } }).session?.expiresInSec
    expect(typeof sec).toBe('number')
    expect(sec as number).toBeGreaterThan(0)
    expect(sec as number).toBeLessThanOrEqual(3600)
  })

  it('无 ttlSeconds（无前端死线）→ expiresInSec = -1 哨兵', async () => {
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig()), referrer: REFERRER })
    bootOk(fake)

    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('getInfo', 'gi-2', {}))
    await flushMicro()

    const reply = fake.outbound().find((e) => e.kind === 'reply' && e.ok === true)
    expect(reply).toBeDefined()
    expect((reply!.payload as { session: { expiresInSec: number } }).session.expiresInSec).toBe(-1)
  })

  it(`ttlSeconds=100000 → 截断到硬帽 ${TTL_HARD_CAP_SEC}（expiresInSec ≤ 86400）`, async () => {
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig(100000)), referrer: REFERRER })
    bootOk(fake)

    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('getInfo', 'gi-3', {}))
    await flushMicro()

    const reply = fake.outbound().find((e) => e.kind === 'reply' && e.ok === true)
    expect(reply).toBeDefined()
    const sec = (reply!.payload as { session: { expiresInSec: number } }).session.expiresInSec
    expect(sec).toBeGreaterThan(0)
    expect(sec).toBeLessThanOrEqual(TTL_HARD_CAP_SEC)
  })
})

describe('bootApp：destroy（§三 时序：先 ack 后 evt:expired）', () => {
  it('先 reply {}（微任务），expired 延后到宏任务且 reason="destroyed"（顺序断言）', async () => {
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig()), referrer: REFERRER })
    const handle = bootOk(fake)

    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('destroy', 'destroy-1', {}))
    await flushMicro()

    // ack 已到，expired 尚未到（emit 挂在宏任务）
    const afterAck = fake.outbound()
    const ack = afterAck.find((e) => e.kind === 'reply' && e.id === 'destroy-1')
    expect(ack).toBeDefined()
    expect(ack!.ok).toBe(true)
    expect(ack!.payload).toEqual({})
    expect(afterAck.some((e) => e.kind === 'evt' && e.name === 'expired')).toBe(false)

    // 放行宏任务：expired 到达，且顺序在 ack 之后
    await new Promise((r) => setTimeout(r, 10))
    const all = fake.outbound()
    const ackIdx = all.findIndex((e) => e.kind === 'reply' && e.id === 'destroy-1')
    const expIdx = all.findIndex((e) => e.kind === 'evt' && e.name === 'expired')
    expect(ackIdx).toBeGreaterThanOrEqual(0)
    expect(expIdx).toBeGreaterThan(ackIdx)
    expect(all[expIdx]!.payload).toEqual({ reason: 'destroyed' })
    expect(handle.session.isExpired()).toBe(true)
  })
})

describe('bootApp：模式门控（file 模式）', () => {
  it('file 模式下发 navigate → reply ok:false code=4305（同步抛错经 wrapCommand 异步链转 replyError）', async () => {
    const fake = makeFakeWindow({ hash: fileHash(), referrer: REFERRER })
    const handle = bootOk(fake)
    expect(handle.config.mode).toBe('file')

    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('navigate', 'nav-1', { path: '/a.pdf' }))
    await flushMicro()

    const replies = fake.outbound().filter((e) => e.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      id: 'nav-1',
      name: 'navigate',
      ok: false,
      code: ERROR_CODES.UNSUPPORTED_MODE,
    })
    expect(replies[0]!.payload).toMatchObject({ code: ERROR_CODES.UNSUPPORTED_MODE })
  })
})

describe('bootApp：origin 白名单（§一）', () => {
  it('白名单外 origin 派发 cmd → 静默：无 reply、无任何新增外发', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig()), referrer: REFERRER })
    bootOk(fake)
    const before = fake.postMessage.mock.calls.length // ready 已发 1 条

    fake.dispatchInbound('https://evil.example.com', cmdEnv('getInfo', 'evil-1', {}))
    await flushMicro()

    expect(fake.postMessage.mock.calls.length).toBe(before)
    expect(warn).toHaveBeenCalled()
  })
})

describe('bootApp：异步失败回包（wrapCommand → ctx.replyError）', () => {
  it('async handler reject SdkError(4101) → 首回包 ok:false code=4101（同步抛错的内置桩 4301 被「首回包优先」吞掉）', async () => {
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig()), referrer: REFERRER })
    const handle = bootOk(fake)

    // BootOptions 未透传 overrides（见文件头注）：在总线上追加 1 拍即 reject 的异步 handler，
    // 与内置 navigate 桩（2 拍后 replyError 4301）同场竞争，bus 的 replied 标记保证先到者胜。
    const failure = Promise.reject(new SdkError(ERROR_CODES.S3_ERROR, 'S3 端点错误'))
    failure.catch(() => {}) // 防 unhandled rejection
    const asyncFailing: MessageHandler = (_payload, ctx) => {
      void failure.then(
        (v) => ctx.reply(v ?? {}),
        (err: unknown) => {
          const e = err as SdkError
          ctx.replyError(e.code, { code: e.code, message: e.message })
        },
      )
    }
    handle.bus.on('navigate', asyncFailing)

    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('navigate', 'nav-async', { path: '/x' }))
    await flushMicro()

    const replies = fake.outbound().filter((e) => e.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'nav-async', name: 'navigate', ok: false, code: ERROR_CODES.S3_ERROR })
    expect(replies[0]!.payload).toMatchObject({ code: ERROR_CODES.S3_ERROR, message: 'S3 端点错误' })
  })
})

// ───────────────────────── ③ 会话到期 / dispose ─────────────────────────

describe('bootApp：ttl 到点（onExpire 接线）', () => {
  // F4 契约修正（《JSSDK 接口文档》§七「终态后任何 cmd→5000」）：到期只派发 expired，不再销毁总线——
  // 监听与 handler 表保留，后续 cmd 由 guardTerminal 拒绝并回包 5000（原「destroy 复位握手位」断言废止）。
  it('ttl 到点 → 延后一拍派发 evt expired {reason:"ttl"}；总线保活，终态后 cmd 回 5000', async () => {
    vi.useFakeTimers()
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig(3600)), referrer: REFERRER })
    const handle = bootOk(fake)

    await vi.advanceTimersByTimeAsync(3600 * 1000 + 50) // +50ms：容纳 onExpire 里 setTimeout(0) 的嵌套延迟

    const evts = fake.outbound().filter((e) => e.kind === 'evt')
    expect(evts.map((e) => e.name)).toEqual(['ready', 'expired'])
    expect(evts[1]!.payload).toEqual({ reason: 'ttl' })
    expect(handle.session.isExpired()).toBe(true)
    // 总线未销毁：握手位保持，message 监听仍在
    expect(handle.bus.isRemoteReady).toBe(true)

    // 终态后任何 cmd → reply ok:false code=5000 SESSION_EXPIRED（guardTerminal 门）
    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('getInfo', 'after-expire', {}))
    await flushMicro()
    const reply = fake.outbound().find((e) => e.kind === 'reply' && e.id === 'after-expire')
    expect(reply).toBeDefined()
    expect(reply!.ok).toBe(false)
    expect(reply!.code).toBe(ERROR_CODES.SESSION_EXPIRED)
    expect(reply!.payload).toMatchObject({ code: ERROR_CODES.SESSION_EXPIRED })
  })
})

describe('bootApp：dispose（页面卸载/测试清理）', () => {
  it('dispose() 后 ttl 定时器到点不再发 expired；入站消息亦不再派发', async () => {
    vi.useFakeTimers()
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig(3600)), referrer: REFERRER })
    const handle = bootOk(fake)
    expect(fake.outbound().map((e) => e.name)).toEqual(['ready'])

    handle.dispose()
    await vi.advanceTimersByTimeAsync(3600 * 1000 + 5 * 60 * 1000)

    expect(fake.outbound().map((e) => e.name)).toEqual(['ready']) // 只有握手，无 expired

    // 总线已销毁：message 监听已解绑，入站不再产生任何外发
    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('getInfo', 'after-dispose', {}))
    await flushMicro()
    expect(fake.postMessage).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── sessionStorage 备份（刷新重建会话：《docs/operations/user-guide.md》「刷新=从 URL 重建」补偿） ─────────────────────────

describe('bootApp：原始 fragment 的 sessionStorage 备份', () => {
  it('解析成功后、scrub 前备份整段 fragment；exp=now+min(ttl,24h)', () => {
    const storage = makeMemoryStorage()
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig(3600)), referrer: REFERRER, sessionStorage: storage })
    bootOk(fake)

    const text = storage.getItem(RAW_CONFIG_STORAGE_KEY)
    expect(text).not.toBeNull()
    const rec = JSON.parse(text!) as { raw: string; exp: number }
    expect(rec.raw).toBe(configHash(workspaceConfig(3600))) // 整段原始 fragment（含 #config= 前缀）
    const now = Date.now()
    expect(rec.exp).toBeGreaterThan(now)
    expect(rec.exp).toBeLessThanOrEqual(now + 3600 * 1000)
  })

  it('无 TTL（ttlSeconds 缺省）→ exp 用 24h 硬帽', () => {
    const storage = makeMemoryStorage()
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig()), referrer: REFERRER, sessionStorage: storage })
    bootOk(fake)

    const rec = JSON.parse(storage.getItem(RAW_CONFIG_STORAGE_KEY)!) as { exp: number }
    const now = Date.now()
    expect(rec.exp).toBeGreaterThan(now + 23 * 60 * 60 * 1000)
    expect(rec.exp).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000)
  })

  it('刷新重建：URL 无 fragment + 备份有效 → 走同一解析路径成功 boot（ready 照发），且不回写 URL', () => {
    const storage = makeMemoryStorage()
    const first = makeFakeWindow({ hash: configHash(workspaceConfig(3600)), referrer: REFERRER, sessionStorage: storage })
    bootOk(first)

    // 「刷新」：同页签新加载，hash 已被 scrub 抹掉
    const refreshed = makeFakeWindow({ hash: '', referrer: REFERRER, sessionStorage: storage })
    const result = bootApp({ win: refreshed.win })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('应从备份重建成功')
    cleanups.push(() => result.handle.dispose())
    expect(result.handle.config.mode).toBe('workspace')
    expect((result.handle.config as { backend: { prefix: string } }).backend.prefix).toBe('u/42/')
    expect(refreshed.outbound().map((e) => e.name)).toEqual(['ready']) // 同一解析路径：完整握手
    expect(refreshed.win.location.hash).toBe('') // 不回写 URL
  })

  it('URL 带 config 键时以 URL 为准并覆盖旧备份；坏配置直接失败（不回落备份掩盖错误）', () => {
    const storage = makeMemoryStorage()
    storage.setItem(RAW_CONFIG_STORAGE_KEY, JSON.stringify({ raw: configHash(workspaceConfig()), exp: Date.now() + 60_000 }))

    const fresh = makeFakeWindow({ hash: configHash(workspaceConfig(60)), referrer: REFERRER, sessionStorage: storage })
    bootOk(fresh)
    const rec = JSON.parse(storage.getItem(RAW_CONFIG_STORAGE_KEY)!) as { raw: string }
    expect(rec.raw).toBe(configHash(workspaceConfig(60))) // 新会话覆盖旧备份

    const bad = makeFakeWindow({ hash: '#config=%7Bbad', referrer: REFERRER, sessionStorage: storage })
    const result = bootApp({ win: bad.win })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ERROR_CODES.BAD_CONFIG)
  })

  it('备份过期 → 清除并按无配置处理（4001），不产生任何外发', () => {
    const storage = makeMemoryStorage()
    storage.setItem(RAW_CONFIG_STORAGE_KEY, JSON.stringify({ raw: configHash(workspaceConfig()), exp: Date.now() - 1 }))

    const fake = makeFakeWindow({ hash: '', referrer: REFERRER, sessionStorage: storage })
    const result = bootApp({ win: fake.win })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ERROR_CODES.BAD_CONFIG)
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull() // 过期即清
    expect(fake.postMessage).not.toHaveBeenCalled()
  })

  it('备份损坏（非 JSON）→ 清除并按无配置处理（4001）', () => {
    const storage = makeMemoryStorage()
    storage.setItem(RAW_CONFIG_STORAGE_KEY, '{corrupt')

    const fake = makeFakeWindow({ hash: '', referrer: REFERRER, sessionStorage: storage })
    const result = bootApp({ win: fake.win })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ERROR_CODES.BAD_CONFIG)
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()
  })

  it('destroy 命令 → 备份清除（先 ack 后 evt 的时序不受影响）', async () => {
    const storage = makeMemoryStorage()
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig()), referrer: REFERRER, sessionStorage: storage })
    bootOk(fake)
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).not.toBeNull()

    fake.dispatchInbound(HOST_ORIGIN, cmdEnv('destroy', 'destroy-bk', {}))
    await flushMicro()
    await new Promise((r) => setTimeout(r, 10))

    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()
    const all = fake.outbound()
    expect(all.some((e) => e.kind === 'reply' && e.id === 'destroy-bk' && e.ok === true)).toBe(true)
    expect(all.some((e) => e.kind === 'evt' && e.name === 'expired')).toBe(true)
  })

  it('ttl 到点派发 expired → 备份清除（到期会话不可借刷新续命）', async () => {
    vi.useFakeTimers()
    const storage = makeMemoryStorage()
    const fake = makeFakeWindow({ hash: configHash(workspaceConfig(3600)), referrer: REFERRER, sessionStorage: storage })
    bootOk(fake)
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).not.toBeNull()

    await vi.advanceTimersByTimeAsync(3600 * 1000 + 50)

    expect(fake.outbound().filter((e) => e.kind === 'evt').map((e) => e.name)).toEqual(['ready', 'expired'])
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()
  })
})
