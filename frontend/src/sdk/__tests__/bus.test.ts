/**
 * MessageBus 单测（Wave1-A1）
 * 契约：《docs/design/jsdk-api.md》V1.0 §一/§二/§三/§七
 * 策略：接收侧用真实 jsdom window + MessageEvent 派发（确定性，不依赖真实跨窗投递）；
 *       发送侧用 fake remote window（{ postMessage: vi.fn() }）断言信封构造。
 *       jsdom 真实 postMessage 的 iframe 往返集成测试单独放最后一个 describe（可选，flaky 则跳过并注记）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../bus'
import type { MessageBusOptions } from '../bus'
import { DEFAULT_TIMEOUT_MS, NS, PROTOCOL_VERSION, READY_QUEUE_LIMIT } from '../constants'
import { ERROR_CODES, SdkError } from '../errorCodes'

/** 测试用的宿主源（白名单内）与发送目标源 */
const HOST_ORIGIN = 'https://host.example.com'
const TARGET_ORIGIN = 'https://files.example.com'

/** 所有测试创建的 bus，afterEach 统一销毁，避免监听器跨用例泄漏 */
const buses: MessageBus[] = []

/** fake remote window：只实现 postMessage，断言信封用（message 形参用 any 便于自由读取信封字段） */
function fakeRemote() {
  return { postMessage: vi.fn<(message: any, targetOrigin: string) => void>() }
}

/** 构造挂在本窗（jsdom window）上的 MessageBus，overrides 覆盖默认 opts */
function makeBus(overrides: Partial<MessageBusOptions> = {}) {
  const remote = fakeRemote()
  const opts: MessageBusOptions = {
    allowedOrigins: overrides.allowedOrigins ?? [HOST_ORIGIN],
    targetOrigin: overrides.targetOrigin ?? (() => TARGET_ORIGIN),
    remoteWindow: overrides.remoteWindow ?? (() => remote as unknown as Window),
    timeoutMs: overrides.timeoutMs,
  }
  const bus = new MessageBus(window, opts)
  buses.push(bus)
  return { bus, remote }
}

/** 在本窗派发一条收到的 message 事件（模拟远端发来的包） */
function incoming(data: unknown, origin: string = HOST_ORIGIN) {
  window.dispatchEvent(new MessageEvent('message', { data, origin }))
}

/** 构造一条标准 cmd 信封 */
function cmdEnvelope(name: string, id = 'req-1', payload: unknown = {}) {
  return { ns: NS, v: PROTOCOL_VERSION, kind: 'cmd', id, name, payload }
}

/** 挂一个空 catch，防止"故意不回复"的 promise 触发未处理拒绝 */
function silence<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

afterEach(() => {
  for (const b of buses.splice(0)) b.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ───────────────────────── 构造与安全规则（§一） ─────────────────────────

describe('构造', () => {
  it("targetOrigin() 返回 '*' 时直接 throw（禁 *）", () => {
    expect(() => makeBus({ targetOrigin: () => '*' })).toThrow(SdkError)
    expect(() => makeBus({ targetOrigin: () => '*' })).toThrow(/\*/)
  })

  // 注：post 为同步发送，运行时变更 targetOrigin 只能在 call 之前注入；
  // 该用例覆盖"发送侧兜底"分支（构造期禁 '*' 由上一用例覆盖）。
  it("构造合法后 targetOrigin() 运行时变 '*'：call 拒 BAD_PARAM，不外发", async () => {
    let target = TARGET_ORIGIN
    const { bus, remote } = makeBus({ targetOrigin: () => target })
    bus.markRemoteReady()
    target = '*'
    await expect(bus.call('navigate', {})).rejects.toMatchObject({ code: ERROR_CODES.BAD_PARAM })
    expect(remote.postMessage).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 信封构造与 call（§二） ─────────────────────────

describe('call：信封构造', () => {
  it('发送 cmd 信封：ns/v/kind/id/name/payload + targetOrigin 第二参', () => {
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    silence(bus.call('navigate', { path: '/a' }))

    expect(remote.postMessage).toHaveBeenCalledTimes(1)
    const [env, target] = remote.postMessage.mock.calls[0]!
    expect(target).toBe(TARGET_ORIGIN)
    expect(env).toMatchObject({
      ns: NS,
      v: PROTOCOL_VERSION,
      kind: 'cmd',
      name: 'navigate',
      payload: { path: '/a' },
    })
    expect(typeof env.id).toBe('string')
    expect(env.id.length).toBeGreaterThan(0)
    // cmd 信封不携带 reply 专属字段
    expect(env.ok).toBeUndefined()
    expect(env.code).toBeUndefined()
  })

  it('remoteWindow() 为 null → reject SdkError(BAD_PARAM)（ready 与否均拒，不排队）', async () => {
    const { bus } = makeBus({ remoteWindow: () => null })
    await expect(bus.call('navigate', {})).rejects.toMatchObject({ code: ERROR_CODES.BAD_PARAM })
    expect(bus.queueSize).toBe(0)

    bus.markRemoteReady()
    await expect(bus.call('navigate', {})).rejects.toMatchObject({ code: ERROR_CODES.BAD_PARAM })
  })

  it('连续 call 的 id 互不相同', () => {
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    silence(bus.call('a', {}))
    silence(bus.call('b', {}))
    const [id1, id2] = remote.postMessage.mock.calls!.map((c) => (c[0] as { id: string }).id)
    expect(id1).not.toBe(id2)
  })
})

// ───────────────────────── reply 匹配（§二/§三） ─────────────────────────

describe('call：reply 按 id 匹配', () => {
  it('ok=true reply → promise 以 payload resolve，pending 清空', async () => {
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    const p = bus.call<{ v: number }>('getInfo', {})
    const sentId = (remote.postMessage.mock.calls[0]![0] as { id: string }).id

    incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'reply', id: sentId, name: 'getInfo', ok: true, payload: { v: 2 } })
    await expect(p).resolves.toEqual({ v: 2 })
    expect(bus.pendingCount).toBe(0)
  })

  it('ok=false reply → reject SdkError，code 透传（4302）', async () => {
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    const p = bus.call('uploadFiles', {})
    p.catch(() => {})
    const sentId = (remote.postMessage.mock.calls[0]![0] as { id: string }).id

    incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'reply', id: sentId, name: 'uploadFiles', ok: false, code: ERROR_CODES.LIMIT_EXCEEDED })
    const err = (await p.catch((e) => e)) as SdkError
    expect(err).toBeInstanceOf(SdkError)
    expect(err.code).toBe(ERROR_CODES.LIMIT_EXCEEDED)
  })

  it('迟到/未知 id 的 reply → 忽略，不崩溃', () => {
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    expect(() =>
      incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'reply', id: 'no-such-id', name: 'getInfo', ok: true, payload: {} }),
    ).not.toThrow()
    expect(bus.pendingCount).toBe(0)
    expect(remote.postMessage).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 超时（§二：4004） ─────────────────────────

describe('call：超时', () => {
  it('默认超时（DEFAULT_TIMEOUT_MS）无 reply → reject 4004，pending 清空', async () => {
    vi.useFakeTimers()
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    const p = bus.call('getInfo', {})
    const assertion = expect(p).rejects.toMatchObject({ code: ERROR_CODES.TIMEOUT })

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
    await assertion
    expect(remote.postMessage).toHaveBeenCalledTimes(1)
    expect(bus.pendingCount).toBe(0)
  })

  it('opts.timeoutMs 覆盖默认值', async () => {
    vi.useFakeTimers()
    const { bus } = makeBus({ timeoutMs: 100 })
    bus.markRemoteReady()
    const p = bus.call('getInfo', {})
    const assertion = expect(p).rejects.toMatchObject({ code: ERROR_CODES.TIMEOUT })

    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('超时后的迟到 reply → 忽略（pending 已清，不 resolve）', async () => {
    vi.useFakeTimers()
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    const p = bus.call('getInfo', {})
    const settled = p.catch((e) => e)
    const sentId = (remote.postMessage.mock.calls[0]![0] as { id: string }).id

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
    await settled
    incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'reply', id: sentId, name: 'getInfo', ok: true, payload: { late: true } })
    expect(bus.pendingCount).toBe(0)
  })
})

// ───────────────────────── ready 前队列（§三：4303） ─────────────────────────

describe('ready 前队列', () => {
  it('remoteReady=false 时 call 入队，不外发', () => {
    const { bus, remote } = makeBus()
    silence(bus.call('navigate', {}))
    expect(bus.queueSize).toBe(1)
    expect(bus.isRemoteReady).toBe(false)
    expect(remote.postMessage).not.toHaveBeenCalled()
  })

  it(`队列上限 ${READY_QUEUE_LIMIT}：第 ${READY_QUEUE_LIMIT + 1} 条 reject 4303 且不入队`, async () => {
    const { bus, remote } = makeBus()
    for (let i = 0; i < READY_QUEUE_LIMIT; i++) silence(bus.call(`c${i}`, {}))
    expect(bus.queueSize).toBe(READY_QUEUE_LIMIT)

    await expect(bus.call('overflow', {})).rejects.toMatchObject({ code: ERROR_CODES.QUEUE_OVERFLOW })
    expect(bus.queueSize).toBe(READY_QUEUE_LIMIT)
    expect(remote.postMessage).not.toHaveBeenCalled()
  })

  it('markRemoteReady 按入队顺序冲刷，队列清空', () => {
    const { bus, remote } = makeBus()
    for (const n of ['a', 'b', 'c']) silence(bus.call(n, { n }))
    expect(bus.queueSize).toBe(3)

    bus.markRemoteReady()
    expect(bus.isRemoteReady).toBe(true)
    expect(bus.queueSize).toBe(0)
    expect(remote.postMessage).toHaveBeenCalledTimes(3)
    const names = remote.postMessage.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toEqual(['a', 'b', 'c'])
  })

  it('markRemoteReady 幂等：二次调用不再外发', () => {
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    bus.markRemoteReady()
    expect(remote.postMessage).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 收包：origin 白名单（§一） ─────────────────────────

describe('收包：origin 白名单', () => {
  it('白名单外 origin → 静默丢弃：处理器不触发、不回任何消息', () => {
    const { bus, remote } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)

    incoming(cmdEnvelope('navigate', 'req-evil'), 'https://evil.example.com')
    expect(handler).not.toHaveBeenCalled()
    expect(remote.postMessage).not.toHaveBeenCalled()
  })

  it('白名单内 origin 正常送达', () => {
    const { bus } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)
    incoming(cmdEnvelope('navigate', 'req-1', { path: '/x' }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── 收包：同窗回环（库内自 postMessage 噪声） ─────────────────────────

describe('收包：同窗回环', () => {
  /** 派发一条 e.source=本窗 的回环消息（插件内库如 pdf.js/univer 的自投递） */
  function loopback(data: unknown, origin: string) {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: window }))
  }

  it('同窗回环（origin 在白名单外，如插件库自 :origin 落回）→ 真静默：不打 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bus } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)

    const OWN_ORIGIN = 'https://files.example.com' // 本窗自身源（iframe 场景=白名单外的自己）
    loopback({ some: 'internal-lib-message' }, OWN_ORIGIN)
    loopback(cmdEnvelope('navigate', 'req-loop'), OWN_ORIGIN)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('同窗回环即便 origin 在白名单内也丢弃（回环不得冒充对端包）', () => {
    const { bus, remote } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)

    loopback(cmdEnvelope('navigate', 'req-loop', { path: '/x' }), HOST_ORIGIN)
    expect(handler).not.toHaveBeenCalled()
    expect(remote.postMessage).not.toHaveBeenCalled()
  })

  it('回环不干扰后续对端消息：回环后再来白名单内对端包照常送达', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bus } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)

    loopback({ noise: true }, 'https://files.example.com')
    incoming(cmdEnvelope('navigate', 'req-1', { path: '/x' }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── 收包：信封过滤（§二） ─────────────────────────

describe('收包：信封过滤', () => {
  it.each([
    ['ns 不符', { ns: 'other', v: PROTOCOL_VERSION, kind: 'cmd', id: '1', name: 'navigate', payload: {} }],
    ['v 不符', { ns: NS, v: 2, kind: 'cmd', id: '1', name: 'navigate', payload: {} }],
    ['data 为字符串', 'not-an-envelope'],
    ['data 为 null', null],
    ['data 为数字', 42],
    ['未知 kind', { ns: NS, v: PROTOCOL_VERSION, kind: 'bogus', id: '1', name: 'navigate', payload: {} }],
  ])('%s → 忽略，无处理器触发、无回包', (_label, data) => {
    const { bus, remote } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)
    expect(() => incoming(data)).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
    expect(remote.postMessage).not.toHaveBeenCalled()
  })
})

// ───────────────────────── 收包：cmd 派发与回包（§二/§七） ─────────────────────────

describe('收包：cmd 处理', () => {
  it('handler 收到 (payload, ctx)，ctx.origin 为发送方源', () => {
    const { bus } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)
    incoming(cmdEnvelope('navigate', 'req-1', { path: '/x' }))

    const [payload, ctx] = handler.mock.calls[0]!
    expect(payload).toEqual({ path: '/x' })
    expect(ctx.origin).toBe(HOST_ORIGIN)
  })

  it('ctx.reply(payload) → 回 ok=true 信封（id 对应 cmd、payload 透传、无 code）', () => {
    const { bus, remote } = makeBus()
    bus.on('add', (p, ctx) => ctx.reply({ sum: (p as { a: number; b: number }).a + (p as { a: number; b: number }).b }))
    incoming(cmdEnvelope('add', 'req-9', { a: 1, b: 2 }))

    expect(remote.postMessage).toHaveBeenCalledTimes(1)
    const [env, target] = remote.postMessage.mock.calls[0]!
    expect(target).toBe(TARGET_ORIGIN)
    expect(env).toMatchObject({ ns: NS, v: PROTOCOL_VERSION, kind: 'reply', id: 'req-9', name: 'add', ok: true, payload: { sum: 3 } })
    expect(env.code).toBeUndefined()
  })

  it('未知命令（无处理器）→ 回 ok=false code=4005', () => {
    const { remote } = makeBus()
    incoming(cmdEnvelope('nope', 'req-404'))

    expect(remote.postMessage).toHaveBeenCalledTimes(1)
    const [env] = remote.postMessage.mock.calls[0]!
    expect(env).toMatchObject({ kind: 'reply', id: 'req-404', name: 'nope', ok: false, code: ERROR_CODES.BAD_PARAM })
  })

  it('handler 抛 SdkError(4302) → 回 ok=false code=4302', () => {
    const { bus, remote } = makeBus()
    bus.on('remove', () => {
      throw new SdkError(ERROR_CODES.LIMIT_EXCEEDED, '超限')
    })
    incoming(cmdEnvelope('remove', 'req-e1'))

    const [env] = remote.postMessage.mock.calls[0]!
    expect(env).toMatchObject({ kind: 'reply', id: 'req-e1', ok: false, code: ERROR_CODES.LIMIT_EXCEEDED })
  })

  it('handler 抛普通 Error / 非 Error → 回 ok=false code=5000（SESSION_EXPIRED 兜底）', () => {
    const { bus, remote } = makeBus()
    bus.on('e1', () => {
      throw new Error('boom')
    })
    bus.on('e2', () => {
      throw 'str'
    })
    incoming(cmdEnvelope('e1', 'r1'))
    incoming(cmdEnvelope('e2', 'r2'))

    const codes = remote.postMessage.mock.calls.map((c) => (c[0] as { code?: number }).code)
    expect(codes).toEqual([ERROR_CODES.SESSION_EXPIRED, ERROR_CODES.SESSION_EXPIRED])
  })

  it('handler 先 reply 再抛错 → 以第一次 reply 为准，不重复回包', () => {
    const { bus, remote } = makeBus()
    bus.on('flaky', (_p, ctx) => {
      ctx.reply({ done: true })
      throw new Error('late boom')
    })
    incoming(cmdEnvelope('flaky', 'r1'))

    expect(remote.postMessage).toHaveBeenCalledTimes(1)
    expect(remote.postMessage.mock.calls[0]![0]).toMatchObject({ ok: true, payload: { done: true } })
  })
})

// ───────────────────────── 收包：evt 派发（§六语义，总线层只管派发） ─────────────────────────

describe('收包：evt 派发', () => {
  it('kind=evt 派发到同名处理器（payload + ctx.origin）', () => {
    const { bus } = makeBus()
    const handler = vi.fn()
    bus.on('pathChanged', handler)
    incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'evt', id: 'e-1', name: 'pathChanged', payload: { path: '/p' } })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ path: '/p' }, expect.objectContaining({ origin: HOST_ORIGIN }))
  })

  it('无处理器的 evt → 静默忽略，不回包', () => {
    const { remote } = makeBus()
    expect(() =>
      incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'evt', id: 'e-1', name: 'nobody-listens', payload: {} }),
    ).not.toThrow()
    expect(remote.postMessage).not.toHaveBeenCalled()
  })

  it('某 evt 处理器抛错不影响同事件其余处理器，也不回包', () => {
    const { bus, remote } = makeBus()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = vi.fn()
    bus.on('fileChanged', () => {
      throw new Error('bad handler')
    })
    bus.on('fileChanged', ok)
    incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'evt', id: 'e-1', name: 'fileChanged', payload: { key: 'k' } })

    expect(ok).toHaveBeenCalledTimes(1)
    expect(remote.postMessage).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })
})

// ───────────────────────── emit（§六方向：文件服务 → 宿主） ─────────────────────────

describe('emit', () => {
  it('发送 evt 信封（ns/v/kind/name/payload）', () => {
    const { bus, remote } = makeBus()
    bus.emit('pathChanged', { path: '/p' })

    expect(remote.postMessage).toHaveBeenCalledTimes(1)
    const [env, target] = remote.postMessage.mock.calls[0]!
    expect(target).toBe(TARGET_ORIGIN)
    expect(env).toMatchObject({ ns: NS, v: PROTOCOL_VERSION, kind: 'evt', name: 'pathChanged', payload: { path: '/p' } })
  })

  it('remoteWindow() 为 null → 丢弃 + console.warn，不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bus, remote } = makeBus({ remoteWindow: () => null })
    expect(() => bus.emit('fileChanged', { key: 'a' })).not.toThrow()
    expect(remote.postMessage).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it("targetOrigin() 运行时变 '*' → emit 丢弃 + console.warn（发送侧兜底，禁 * 外泄）", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let target = TARGET_ORIGIN
    const { bus, remote } = makeBus({ targetOrigin: () => target })
    target = '*'
    expect(() => bus.emit('ready', {})).not.toThrow()
    expect(remote.postMessage).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})

// ───────────────────────── on 解绑 ─────────────────────────

describe('on 解绑', () => {
  it('解绑函数生效：解绑后同名 cmd 视为未知命令（回 4005）', () => {
    const { bus, remote } = makeBus()
    const off = bus.on('navigate', vi.fn())
    off()
    incoming(cmdEnvelope('navigate', 'req-1'))

    const [env] = remote.postMessage.mock.calls[0]!
    expect(env).toMatchObject({ ok: false, code: ERROR_CODES.BAD_PARAM })
  })

  it('同事件多处理器：解绑其一，其余仍触发', () => {
    const { bus } = makeBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    const off1 = bus.on('ready', h1)
    bus.on('ready', h2)
    off1()
    incoming({ ns: NS, v: PROTOCOL_VERSION, kind: 'evt', id: 'e', name: 'ready', payload: {} })
    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────── destroy（§三终态） ─────────────────────────

describe('destroy', () => {
  it('pending 全部 reject 5000，销毁后 call 恒 reject 5000', async () => {
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    const p = bus.call('getInfo', {})
    const settled = p.catch((e) => e)

    bus.destroy()
    await expect(settled).resolves.toMatchObject({ code: ERROR_CODES.SESSION_EXPIRED })
    expect(bus.pendingCount).toBe(0)

    await expect(bus.call('anything', {})).rejects.toMatchObject({ code: ERROR_CODES.SESSION_EXPIRED })
    expect(remote.postMessage).toHaveBeenCalledTimes(1) // 销毁后不再外发
  })

  it('队列中的 call 全部 reject 5000，队列清空', async () => {
    const { bus, remote } = makeBus()
    const p = bus.call('queued', {})
    const settled = p.catch((e) => e)

    bus.destroy()
    await expect(settled).resolves.toMatchObject({ code: ERROR_CODES.SESSION_EXPIRED })
    expect(bus.queueSize).toBe(0)
    expect(remote.postMessage).not.toHaveBeenCalled()
  })

  it('销毁后移除监听：再来消息不派发、不回包', () => {
    const { bus, remote } = makeBus()
    const handler = vi.fn()
    bus.on('navigate', handler)
    bus.destroy()

    expect(() => incoming(cmdEnvelope('navigate'))).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
    expect(remote.postMessage).not.toHaveBeenCalled()
  })

  it('销毁后 emit 丢弃 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bus, remote } = makeBus()
    bus.destroy()
    bus.emit('ready', {})
    expect(remote.postMessage).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('destroy 幂等：二次调用不抛', () => {
    const { bus } = makeBus()
    expect(() => {
      bus.destroy()
      bus.destroy()
    }).not.toThrow()
  })
})

// ───────────────────────── uuid 兜底（jsdom 兼容） ─────────────────────────

describe('uuid', () => {
  it("crypto.randomUUID 缺失时回退 `${Date.now().toString(36)}-${seq}-${random}` 且唯一", () => {
    // 模拟无 randomUUID 的环境（bus 内部每次惰性读取 globalThis.crypto）
    vi.stubGlobal('crypto', {} as typeof globalThis.crypto)
    const { bus, remote } = makeBus()
    bus.markRemoteReady()
    silence(bus.call('a', {}))
    silence(bus.call('b', {}))

    const [id1, id2] = remote.postMessage.mock.calls.map((c) => (c[0] as { id: string }).id)
    expect(id1).not.toBe(id2)
    // 段1=时间36进制 段2=序号 段3=随机 8 位
    expect(id1).toMatch(/^[a-z0-9]+-\d+-[a-z0-9]{2,10}$/)
    expect(id2).toMatch(/^[a-z0-9]+-\d+-[a-z0-9]{2,10}$/)
  })
})

// ───────────────────────── jsdom 真实 postMessage 集成（可选） ─────────────────────────
// 【jsdom 限制注记】jsdom 的 window.postMessage 为半实现（见 jsdom/lib/jsdom/browser/Window.js）：
//  1) event.origin 恒为 ''（源码 TODO：origin 需要 incumbent window，未实现）——
//     因此"origin 白名单校验"这条安全路径在 jsdom 下无法真实验证；
//  2) 投递仅支持"在目标 window 对象上调用 postMessage"，事件经 setTimeout(0) 异步派发；
//  3) about:blank iframe 的 location.origin 为 opaque 'null'，须用同源 URL 才能拿到有效 origin。
// 故全安全路径用例 it.skip 保留（换 happy-dom / 真浏览器 e2e 时可启用），
// 另设"折衷版"用例：白名单放行 jsdom 恒定的空串 origin，其余信封/握手/回包全走真实异步投递。

describe('jsdom 真实 postMessage 集成（可选，flaky 则跳过并注记）', () => {
  it.skip('iframe 双窗全安全路径：origin 白名单校验 + cmd→reply 往返（jsdom 不实现 event.origin，留待 happy-dom/真浏览器）', async () => {
    const iframe = document.createElement('iframe')
    iframe.src = `${window.location.origin}/`
    document.body.appendChild(iframe)
    const remoteWin = iframe.contentWindow
    if (!remoteWin) {
      iframe.remove()
      throw new Error('jsdom 未提供 iframe contentWindow')
    }
    const ORIGIN = window.location.origin
    const host = new MessageBus(window, {
      allowedOrigins: [ORIGIN],
      targetOrigin: () => ORIGIN,
      remoteWindow: () => remoteWin,
      timeoutMs: 3000,
    })
    const guest = new MessageBus(remoteWin, {
      allowedOrigins: [ORIGIN],
      targetOrigin: () => ORIGIN,
      remoteWindow: () => window as unknown as Window,
      timeoutMs: 3000,
    })
    buses.push(host, guest)
    host.markRemoteReady()
    guest.markRemoteReady()

    guest.on('echo', (p, ctx) => ctx.reply({ echoed: p }))
    const res = await host.call<{ echoed: { n: number } }>('echo', { n: 1 })
    expect(res).toEqual({ echoed: { n: 1 } })
    iframe.remove()
  })

  it('iframe 双窗（jsdom 折衷版）：cmd→reply 真实异步往返（origin 恒为空串，见上方限制注记）', async () => {
    const iframe = document.createElement('iframe')
    iframe.src = `${window.location.origin}/` // jsdom 下 about:blank 的 origin 为 'null'，须同源 URL
    document.body.appendChild(iframe)
    const guestWin = iframe.contentWindow
    if (!guestWin) {
      iframe.remove()
      throw new Error('jsdom 未提供 iframe contentWindow，跳过真实投递集成测试')
    }
    const ORIGIN = window.location.origin
    const host = new MessageBus(window, {
      allowedOrigins: [''], // jsdom 的 event.origin 恒为 ''（限制注记 1）
      targetOrigin: () => ORIGIN,
      remoteWindow: () => guestWin,
      timeoutMs: 2000,
    })
    const guest = new MessageBus(guestWin, {
      allowedOrigins: [''],
      targetOrigin: () => ORIGIN,
      remoteWindow: () => window as unknown as Window,
      timeoutMs: 2000,
    })
    buses.push(host, guest)
    host.markRemoteReady()
    guest.markRemoteReady()

    guest.on('echo', (p, ctx) => ctx.reply({ echoed: p }))
    const res = await host.call<{ echoed: { n: number } }>('echo', { n: 1 })
    expect(res).toEqual({ echoed: { n: 1 } })
    iframe.remove()
  })
})
