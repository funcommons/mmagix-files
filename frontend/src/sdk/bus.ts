/**
 * MessageBus —— postMessage 双向通道（Wave1-A1）
 * 契约正本：《docs/design/jsdk-api.md》V1.0 §一/§二/§三/§七
 *
 * 职责边界：
 *  - 信封构造/解析（ns/v/kind/id/name/payload）、cmd id ↔ pending 匹配、超时（4004）
 *  - origin 白名单校验（不符静默丢弃，不回任何消息）、targetOrigin 禁 '*'
 *  - ready 前命令队列（上限 constants.READY_QUEUE_LIMIT，超限拒 4303）、markRemoteReady 按序冲刷
 *  - cmd/evt 处理器注册与派发、未知命令回 4005、handler 抛错回其 code（否则 5000）
 *  - destroy：解绑监听、pending/队列全部 reject 5000、清处理器
 * 不负责：握手时序（evt ready → markRemoteReady 的接线属上层）、命令/事件业务语义。
 */
import { NS, PROTOCOL_VERSION, DEFAULT_TIMEOUT_MS, READY_QUEUE_LIMIT } from './constants'
import { ERROR_CODES, SdkError } from './errorCodes'
import type { Envelope } from './types'

/** 处理器上下文：origin=发送方精确源；reply=对本条 cmd 回 ok 包（evt 处理器中调用为空操作） */
export interface HandlerContext {
  origin: string
  reply(payload: unknown): void
  /** 异步失败专用：回 ok:false + code（bus 的同步 catch 只覆盖同步抛错；首回包优先） */
  replyError(code: number, payload?: unknown): void
}

/** cmd/evt 处理器：显式通过 ctx.reply 回包；不 reply 也不抛则对端按超时处理 */
export type MessageHandler = (payload: unknown, ctx: HandlerContext) => void

export interface MessageBusOptions {
  /** 接收方白名单：event.origin 不在表内 → 静默丢弃（§一） */
  allowedOrigins: string[]
  /** 发送目标精确源（函数化：iframe 晚建/换址时可动态取）；返回 '*' 视为非法 */
  targetOrigin: () => string
  /** 远端窗（iframe.contentWindow / window.open 返回值）；null = 通道未就绪 */
  remoteWindow: () => Window | null
  /** 命令超时，缺省 constants.DEFAULT_TIMEOUT_MS */
  timeoutMs?: number
}

interface PendingEntry {
  resolve(value: unknown): void
  reject(err: SdkError): void
  timer: ReturnType<typeof setTimeout>
}

interface QueuedEntry {
  name: string
  payload: unknown
  resolve(value: unknown): void
  reject(err: SdkError): void
}

/** uuid：优先 crypto.randomUUID；缺失时用 时间-序号-随机数 兜底（jsdom/老环境兼容） */
let seq = 0
function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  seq += 1
  return `${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

export class MessageBus {
  private readonly win: Window
  private readonly opts: MessageBusOptions
  private readonly timeoutMs: number
  /** cmd 与 evt 共用一张处理器表（§三/§五/§六 同名分发） */
  private readonly handlers = new Map<string, Set<MessageHandler>>()
  /** 已外发未回包的命令，key=cmd id */
  private readonly pending = new Map<string, PendingEntry>()
  /** ready 前命令队列（FIFO） */
  private queue: QueuedEntry[] = []
  private remoteReady = false
  private destroyed = false
  private readonly onMessageBound = (e: MessageEvent) => this.handleMessage(e)

  constructor(win: Window, opts: MessageBusOptions) {
    // 安全规则（§一）：发送方精确 targetOrigin，禁 '*'
    if (opts.targetOrigin() === '*') {
      throw new SdkError(ERROR_CODES.BAD_PARAM, 'targetOrigin 禁止为 "*"，必须指定精确源')
    }
    this.win = win
    this.opts = opts
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    win.addEventListener('message', this.onMessageBound as EventListener)
  }

  // ── 只读测试辅助 ──

  /** ready 前队列长度 */
  get queueSize(): number {
    return this.queue.length
  }

  /** 已外发未回包命令数 */
  get pendingCount(): number {
    return this.pending.size
  }

  /** 是否已握手就绪（markRemoteReady 后为 true） */
  get isRemoteReady(): boolean {
    return this.remoteReady
  }

  // ── 处理器注册 ──

  /** 注册 cmd/evt 处理器，返回解绑函数 */
  on(name: string, handler: MessageHandler): () => void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set()
      this.handlers.set(name, set)
    }
    set.add(handler)
    return () => {
      const s = this.handlers.get(name)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) this.handlers.delete(name)
    }
  }

  // ── 发命令（§二/§三） ──

  /**
   * 发 cmd 并等待 reply：
   *  - 已销毁 → reject 5000；remoteWindow() 为 null → reject 4005
   *  - 未 ready → 入队（上限 READY_QUEUE_LIMIT，超限 reject 4303 不入队）
   *  - 超时（timeoutMs，默认 10s）→ reject 4004；定时器在实际外发时启动
   */
  call<T = unknown>(name: string, payload?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.destroyed) {
        reject(new SdkError(ERROR_CODES.SESSION_EXPIRED, `会话已销毁，命令 ${name} 拒绝`))
        return
      }
      if (!this.opts.remoteWindow()) {
        reject(new SdkError(ERROR_CODES.BAD_PARAM, `remoteWindow 为空，命令 ${name} 无法发送`))
        return
      }
      if (!this.remoteReady) {
        if (this.queue.length >= READY_QUEUE_LIMIT) {
          reject(new SdkError(ERROR_CODES.QUEUE_OVERFLOW, `ready 前队列已满（${READY_QUEUE_LIMIT}），命令 ${name} 拒绝`))
          return
        }
        this.queue.push({ name, payload, resolve: resolve as (v: unknown) => void, reject })
        return
      }
      try {
        this.sendCmd(name, payload, resolve as (v: unknown) => void, reject)
      } catch (err) {
        reject(err instanceof SdkError ? err : new SdkError(ERROR_CODES.BAD_PARAM, `命令 ${name} 发送失败`, err))
      }
    })
  }

  /** 握手就绪：置位并按入队顺序冲刷队列（幂等；销毁后调用为空操作） */
  markRemoteReady(): void {
    if (this.remoteReady || this.destroyed) return
    this.remoteReady = true
    const queued = this.queue
    this.queue = []
    for (const item of queued) this.sendCmdSafe(item)
  }

  /** 发 evt（fire-and-forget）：remote 为 null / 已销毁 / 外发异常 → 丢弃 + console.warn */
  emit(name: string, payload?: unknown): void {
    if (this.destroyed) {
      console.warn(`[MessageBus] 已销毁，事件 ${name} 丢弃`)
      return
    }
    if (!this.opts.remoteWindow()) {
      console.warn(`[MessageBus] remoteWindow 为空，事件 ${name} 丢弃`)
      return
    }
    try {
      this.post(this.envelope('evt', uuid(), name, payload))
    } catch (err) {
      console.warn(`[MessageBus] 事件 ${name} 外发失败，已丢弃`, err)
    }
  }

  /** 销毁：解绑监听、pending/队列全部 reject 5000、清处理器（幂等） */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.win.removeEventListener('message', this.onMessageBound as EventListener)
    const err = new SdkError(ERROR_CODES.SESSION_EXPIRED, '会话已销毁')
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    for (const q of this.queue.splice(0)) q.reject(err)
    this.handlers.clear()
    this.remoteReady = false
  }

  // ── 收包 ──

  private handleMessage(e: MessageEvent): void {
    // 同窗回环（e.source=本窗）：本窗内库（pdf.js/univer 等调度器）自 postMessage 落回自身，
    // 必非对端流量——真静默丢弃（不打日志）；即便 origin 恰在白名单（同源部署）也不得当对端包处理
    if (e.source === this.win) return
    // §一：origin 不在白名单 → 静默丢弃，不回任何消息（仅日志）
    if (!this.opts.allowedOrigins.includes(e.origin)) {
      console.warn(`[MessageBus] origin 不在白名单，静默丢弃: ${e.origin}`)
      return
    }
    const data = e.data as Partial<Envelope> | null | undefined
    if (typeof data !== 'object' || data === null) return
    if (data.ns !== NS || data.v !== PROTOCOL_VERSION) return
    switch (data.kind) {
      case 'cmd':
        this.handleCmd(data as Envelope, e.origin)
        return
      case 'reply':
        this.handleReply(data as Envelope)
        return
      case 'evt':
        this.dispatch(data.name as string, data.payload, e.origin)
        return
      default:
        return
    }
  }

  /** cmd 分发：无处理器回 4005；handler 抛错回其 code（非数值兜底 5000）；首 reply 优先 */
  private handleCmd(env: Envelope, origin: string): void {
    const handlers = this.handlers.get(env.name)
    if (!handlers || handlers.size === 0) {
      this.sendReply(env, false, null, ERROR_CODES.BAD_PARAM)
      return
    }
    let replied = false
    const ctx: HandlerContext = {
      origin,
      reply: (payload: unknown) => {
        if (replied) return
        replied = true
        this.sendReply(env, true, payload)
      },
      replyError: (code, payload) => {
        if (replied) return
        replied = true
        this.sendReply(env, false, payload ?? null, code)
      },
    }
    try {
      for (const h of [...handlers]) h(env.payload, ctx)
    } catch (err) {
      if (!replied) this.sendReply(env, false, null, this.codeOf(err))
    }
  }

  /** reply 匹配 pending：ok=true resolve payload；否则 reject SdkError(code) */
  private handleReply(env: Envelope): void {
    const entry = this.pending.get(env.id)
    if (!entry) return // 迟到/重复/未知 id 的 reply，忽略
    this.pending.delete(env.id)
    clearTimeout(entry.timer)
    if (env.ok) {
      entry.resolve(env.payload)
    } else {
      const code = typeof env.code === 'number' ? env.code : ERROR_CODES.SESSION_EXPIRED
      entry.reject(new SdkError(code, `命令 ${env.name} 失败（code=${code}）`, env.payload))
    }
  }

  /** evt 分发：无处理器静默；单个处理器异常不阻断其余处理器、不回包 */
  private dispatch(name: string, payload: unknown, origin: string): void {
    const handlers = this.handlers.get(name)
    if (!handlers) return
    const ctx: HandlerContext = { origin, reply: () => {}, replyError: () => {} } // evt 无回包语义
    for (const h of [...handlers]) {
      try {
        h(payload, ctx)
      } catch (err) {
        console.error(`[MessageBus] 事件 ${name} 处理器异常`, err)
      }
    }
  }

  // ── 外发 ──

  /** 外发 cmd：post 成功后再挂 pending 与超时定时器（post 抛错则调用方 reject，不产生孤儿 pending） */
  private sendCmd(name: string, payload: unknown, resolve: (v: unknown) => void, reject: (e: SdkError) => void): void {
    const id = uuid()
    this.post(this.envelope('cmd', id, name, payload))
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        reject(new SdkError(ERROR_CODES.TIMEOUT, `命令 ${name} 超时（${this.timeoutMs}ms）`))
      }
    }, this.timeoutMs)
    this.pending.set(id, { resolve, reject, timer })
  }

  /** 队列冲刷单项：异常转 reject，不阻断后续项 */
  private sendCmdSafe(item: QueuedEntry): void {
    if (this.destroyed) {
      item.reject(new SdkError(ERROR_CODES.SESSION_EXPIRED, '会话已销毁'))
      return
    }
    try {
      this.sendCmd(item.name, item.payload, item.resolve, item.reject)
    } catch (err) {
      item.reject(err instanceof SdkError ? err : new SdkError(ERROR_CODES.BAD_PARAM, `命令 ${item.name} 发送失败`, err))
    }
  }

  /** 回 reply 信封：id=请求 cmd 的 id，失败携 §七 code */
  private sendReply(req: Envelope, ok: boolean, payload: unknown, code?: number): void {
    const env: Envelope = { ...this.envelope('reply', req.id, req.name, payload), ok }
    if (!ok) env.code = code
    try {
      this.post(env)
    } catch (err) {
      console.warn(`[MessageBus] reply 外发失败（${req.name}），已丢弃`, err)
    }
  }

  /** 底层投递：remote 缺失或 targetOrigin 为 '*' 时抛错（由各入口决定 reject 或 warn+丢弃） */
  private post(env: Envelope): void {
    const remote = this.opts.remoteWindow()
    if (!remote) throw new SdkError(ERROR_CODES.BAD_PARAM, 'remoteWindow 为空，无法发送')
    const target = this.opts.targetOrigin()
    if (target === '*') throw new SdkError(ERROR_CODES.BAD_PARAM, 'targetOrigin 禁止为 "*"')
    remote.postMessage(env, target)
  }

  /** 信封构造（§二通用格式） */
  private envelope(kind: Envelope['kind'], id: string, name: string, payload: unknown): Envelope {
    return { ns: NS, v: PROTOCOL_VERSION, kind, id, name, payload }
  }

  /** handler 抛错 → 回包 code：取 err.code（数值），否则兜底 5000 */
  private codeOf(err: unknown): number {
    const code = (err as { code?: unknown } | null | undefined)?.code
    return typeof code === 'number' && Number.isFinite(code) ? code : ERROR_CODES.SESSION_EXPIRED
  }
}
