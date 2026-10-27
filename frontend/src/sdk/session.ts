/**
 * 会话自毁控制器（契约《docs/design/solution-design.md》§4.2 /《docs/design/jsdk-api.md》§三）
 *
 * 执法线分层：会话有效期=凭证 TTL，签发时定死、不延期——
 * - 服务侧硬线：STS 凭证真实 TTL（刷新/塞栓不可续命），TTL 到 → S3 全拒；
 * - 前端线：UX 自毁定时器 + T-5min（EXPIRE_WARN_BEFORE_MS）预警——刷新即从 fragment 重建，非安全线。
 *
 * 到期语义：定时器到点 → 停表 + onExpire('ttl')；宿主显式 destroy → 停表 + onExpire('destroyed')。
 * 终态恰好一次（先到先得，后到者 no-op）；`expired` 事件由装配层派发，本类只回调。
 *
 * 本文件不 import bus/config/credentials（A1/A2 并行落地中）——依赖全部注入 + 结构类型。
 * 本类形状满足 handlers.ts 的 SessionHandle（remainingMs/isExpired/destroy），可直接作句柄传入。
 */

import { EXPIRE_WARN_BEFORE_MS } from './constants'

/** 到期原因：'ttl'=定时器到点；'destroyed'=宿主显式 destroy 命令 */
export type ExpireReason = 'ttl' | 'destroyed'

/**
 * 计时器抽象（依赖注入面）。
 * 默认实现=全局 setTimeout/clearTimeout/Date.now——测试 vi.useFakeTimers（含 toFake:['Date']）直接兼容。
 */
export interface SessionTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
  now(): number
}

export interface SessionDeps {
  /** 前端自毁时长（秒）；契约义务：必须 ≤ STS 真实 TTL（建议略短） */
  ttlSeconds?: number
  /** 对齐 STS 真实到期时刻（epoch ms）；与 ttlSeconds 同时给定时优先生效 */
  expiresAt?: number
  /** 终态回调（恰好一次） */
  onExpire(reason: ExpireReason): void
  /** 到期预警回调（T-5min，恰好一次；剩余本就 ≤ 阈值时 start 即同步触发） */
  onWarn?(): void
  /** 计时器注入点（缺省用全局实现） */
  timers?: SessionTimers
}

const defaultTimers: SessionTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  now: () => Date.now(),
}

/** idle=未起表/已停表；running=在表；ended=终态（不可逆） */
type SessionPhase = 'idle' | 'running' | 'ended'

/**
 * 会话自毁控制器。
 * 状态机：idle --start()--> running --(到点)--> ended('ttl')
 *                                 --(destroy())--> ended('destroyed')
 * - stop() 仅拆定时器（无事件、非终态、可重入），拆后可重新 start()；
 * - 终态先到先得：ttl 与 destroyed 恰好回调一次，destroy() 在 ttl 终态后为 no-op。
 */
export class SessionController {
  private readonly deps: SessionDeps
  private readonly timers: SessionTimers
  private phase: SessionPhase = 'idle'
  /** 死线（epoch ms）；无前端死线=Infinity */
  private deadline = Number.POSITIVE_INFINITY
  /** 预警一次性标记（start 时复位） */
  private warned = false
  private warnHandle: unknown
  private expireHandle: unknown

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.timers = deps.timers ?? defaultTimers
  }

  /**
   * 起表：按 expiresAt（优先）或 now+ttlSeconds 计算死线，布防预警/到期定时器。
   * 可重入=先拆旧定时器再重算重布（刷新重建场景）。已终态则 no-op（终态不可逆）。
   */
  start(): void {
    if (this.phase === 'ended') return
    this.unarm()
    this.warned = false
    const now = this.timers.now()
    const at =
      this.deps.expiresAt !== undefined
        ? this.deps.expiresAt
        : this.deps.ttlSeconds !== undefined
          ? now + this.deps.ttlSeconds * 1000
          : undefined
    this.phase = 'running'
    if (at === undefined) return // 双缺省：无前端死线（单文件模式常态），永不到期
    this.deadline = at
    const remaining = at - now
    if (remaining <= 0) {
      // 起表即过期（如页面加载晚于 STS 真实到期）
      this.end('ttl')
      return
    }
    if (remaining <= EXPIRE_WARN_BEFORE_MS) {
      // 剩余本就 ≤ 阈值：启动即预警（一次性）
      this.warned = true
      this.deps.onWarn?.()
    } else {
      this.warnHandle = this.timers.set(() => {
        this.warned = true
        this.deps.onWarn?.()
      }, remaining - EXPIRE_WARN_BEFORE_MS)
    }
    this.expireHandle = this.timers.set(() => this.end('ttl'), remaining)
  }

  /** 停表：只拆定时器，不进终态、不发事件；可重入。停后 remainingMs 回到 Infinity（未在表）。 */
  stop(): void {
    this.unarm()
    if (this.phase === 'running') this.phase = 'idle'
  }

  /**
   * 续期重布（v1.1 setCredentials 通道）：更新死线源并重新 start()（重算重布预警/到期定时器，
   * 预警一次性标记复位）。已终态 no-op（终态不可逆）；双缺省=保持现死线仅重布。
   */
  extend(opts: { ttlSeconds?: number; expiresAt?: number }): void {
    if (this.phase === 'ended') return
    if (opts.expiresAt !== undefined) this.deps.expiresAt = opts.expiresAt
    if (opts.ttlSeconds !== undefined) this.deps.ttlSeconds = opts.ttlSeconds
    this.start()
  }

  /** 宿主显式自毁：进终态并回调 onExpire('destroyed')（已终态则 no-op） */
  destroy(): void {
    this.end('destroyed')
  }

  /** 只读：是否已进终态（ttl/destroyed） */
  isExpired(): boolean {
    return this.phase === 'ended'
  }

  /** 只读：剩余毫秒；终态=0，未在表或无死线=Infinity */
  remainingMs(): number {
    if (this.phase === 'ended') return 0
    if (this.phase === 'idle' || this.deadline === Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY
    }
    return Math.max(0, this.deadline - this.timers.now())
  }

  /** 预警是否已发（装配层判重/面板横幅用；一次性语义） */
  get warnedOnce(): boolean {
    return this.warned
  }

  /** 终态迁移（恰好一次）：置相位 → 拆表 → 回调 */
  private end(reason: ExpireReason): void {
    if (this.phase === 'ended') return
    this.phase = 'ended'
    this.unarm()
    this.deps.onExpire(reason)
  }

  private unarm(): void {
    this.timers.clear(this.warnHandle)
    this.timers.clear(this.expireHandle)
    this.warnHandle = undefined
    this.expireHandle = undefined
  }
}
