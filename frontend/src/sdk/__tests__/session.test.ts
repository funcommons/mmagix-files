/**
 * SessionController 单测（契约《docs/design/solution-design.md》§4.2 /《docs/design/jsdk-api.md》§三）
 * 覆盖：TTL 到点自毁 / T-5min 预警恰一次 / expiresAt 优先 / destroy 终态 / stop 重入 / DI 计时器 / extend 续期重布（v1.1）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPIRE_WARN_BEFORE_MS } from '../constants'
import { SessionController } from '../session'
import type { SessionTimers } from '../session'

const WARN_MS = EXPIRE_WARN_BEFORE_MS

describe('SessionController', () => {
  // 显式 toFake Date：expiresAt 用例依赖 Date.now 可控
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('TTL 到点触发 onExpire("ttl") 恰一次，isExpired/remainingMs 收口', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 60, onExpire })
    c.start()
    vi.advanceTimersByTime(59_999)
    expect(onExpire).not.toHaveBeenCalled()
    expect(c.isExpired()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
    expect(c.isExpired()).toBe(true)
    expect(c.remainingMs()).toBe(0)
    // 终态后时间继续走也不重复触发
    vi.advanceTimersByTime(60_000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('T-5min 触发 onWarn 恰一次（到期时也不重复）', () => {
    const onWarn = vi.fn()
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 600, onWarn, onExpire })
    c.start()
    vi.advanceTimersByTime(600_000 - WARN_MS - 1)
    expect(onWarn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1) // 恰到 T-5min
    expect(onWarn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(WARN_MS - 1)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
    expect(onWarn).toHaveBeenCalledTimes(1)
  })

  it('剩余本就 ≤ 预警阈值：start 即同步 warn 一次', () => {
    const onWarn = vi.fn()
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 60, onWarn, onExpire })
    c.start()
    expect(onWarn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(c.isExpired()).toBe(true)
  })

  it('expiresAt 优先于 ttlSeconds', () => {
    vi.setSystemTime(1_000_000)
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 3600, expiresAt: Date.now() + 30_000, onExpire })
    c.start()
    expect(c.remainingMs()).toBe(30_000)
    vi.advanceTimersByTime(29_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
  })

  it('destroy → onExpire("destroyed") 恰一次，且 ttl 定时器被拆除', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 60, onExpire })
    c.start()
    c.destroy()
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('destroyed')
    expect(c.isExpired()).toBe(true)
    expect(c.remainingMs()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(onExpire).toHaveBeenCalledTimes(1)
    c.destroy() // 重入 no-op
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('ttl 自然到期后 destroy 不再回调（终态先到先得）', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 10, onExpire })
    c.start()
    vi.advanceTimersByTime(10_000)
    c.destroy()
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
  })

  it('stop() 可重入且不发事件；重启后能正常到期', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 30, onExpire })
    c.start()
    c.stop()
    c.stop()
    expect(onExpire).not.toHaveBeenCalled()
    expect(c.isExpired()).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
    c.start() // 重新起表（同一 deps，重算 30s）
    vi.advanceTimersByTime(29_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('expiresAt 已过去：start 即 ttl（起表即过期）', () => {
    vi.setSystemTime(1_000_000)
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 3600, expiresAt: 999_999, onExpire })
    c.start()
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
    expect(c.isExpired()).toBe(true)
  })

  it('ttlSeconds/expiresAt 双缺省：永不到期（无前端死线，单文件常态）', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ onExpire })
    c.start()
    expect(c.remainingMs()).toBe(Number.POSITIVE_INFINITY)
    vi.advanceTimersByTime(24 * 3600 * 1000)
    expect(onExpire).not.toHaveBeenCalled()
    expect(c.isExpired()).toBe(false)
  })

  it('未 start：isExpired=false、remainingMs=Infinity', () => {
    const c = new SessionController({ ttlSeconds: 60, onExpire: vi.fn() })
    expect(c.isExpired()).toBe(false)
    expect(c.remainingMs()).toBe(Number.POSITIVE_INFINITY)
  })

  it('可注入 timers：调度与时刻均走注入点（不经全局 setTimeout）', () => {
    let now = 0
    let fired: (() => void) | undefined
    const timers: SessionTimers = {
      set: (fn, ms) => {
        fired = fn
        return ms
      },
      clear: () => {},
      now: () => now,
    }
    const onWarn = vi.fn()
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 5, onWarn, onExpire, timers })
    c.start()
    expect(onWarn).toHaveBeenCalledTimes(1) // 5s < 5min → 启动即预警
    now = 4_999
    expect(c.remainingMs()).toBe(1)
    fired?.()
    expect(onExpire).toHaveBeenCalledWith('ttl')
    expect(c.remainingMs()).toBe(0)
    expect(c.isExpired()).toBe(true)
  })
})

describe('SessionController.extend（v1.1 setCredentials 续期重布）', () => {
  // 沿用文件内既有 timers stub（显式 toFake Date：expiresAt 用例依赖 Date.now 可控）
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('更新 ttlSeconds 死线源：remainingMs 增长，旧到期定时器已拆（原死线点不发火）', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 60, onExpire })
    c.start()
    vi.advanceTimersByTime(50_000)
    expect(c.remainingMs()).toBe(10_000)
    c.extend({ ttlSeconds: 300 })
    expect(c.remainingMs()).toBe(300_000) // 新死线 = extend 时刻 + 新 TTL
    vi.advanceTimersByTime(60_000) // 越过原死线点：旧定时器已被 start() 的 unarm 拆除
    expect(onExpire).not.toHaveBeenCalled()
    expect(c.isExpired()).toBe(false)
  })

  it('extend 后到期定时器按新死线触发 onExpire("ttl") 恰一次', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 60, onExpire })
    c.start()
    c.extend({ ttlSeconds: 120 })
    vi.advanceTimersByTime(119_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
  })

  it('预警一次性标记复位：extend 后 warnedOnce=false，按新死线再次预警', () => {
    const onWarn = vi.fn()
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 600, onWarn, onExpire })
    c.start()
    vi.advanceTimersByTime(600_000 - WARN_MS) // 恰到 T-5min：第一轮预警
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(c.warnedOnce).toBe(true)
    c.extend({ ttlSeconds: 600 }) // 重布：预警标记复位，新死线重走一轮
    expect(c.warnedOnce).toBe(false)
    expect(onWarn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(600_000 - WARN_MS)
    expect(onWarn).toHaveBeenCalledTimes(2) // 第二轮预警照常恰一次
    expect(c.warnedOnce).toBe(true)
  })

  it('已终态：extend no-op（不复活、不布新定时器）', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 10, onExpire })
    c.start()
    vi.advanceTimersByTime(10_000)
    c.extend({ ttlSeconds: 600 })
    expect(c.isExpired()).toBe(true)
    expect(c.remainingMs()).toBe(0)
    vi.advanceTimersByTime(700_000)
    expect(onExpire).toHaveBeenCalledTimes(1) // 终态恰好一次，不因 extend 复活
  })

  it('双缺省 extend({})：expiresAt 死线保持原值，仅重布定时器', () => {
    vi.setSystemTime(1_000_000)
    const onExpire = vi.fn()
    const c = new SessionController({ expiresAt: 1_020_000, onExpire })
    c.start()
    expect(c.remainingMs()).toBe(20_000)
    vi.advanceTimersByTime(10_000)
    expect(c.remainingMs()).toBe(10_000)
    c.extend({})
    expect(c.remainingMs()).toBe(10_000) // 死线源未更新 → 死线原值不动
    vi.advanceTimersByTime(9_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
  })

  it('双缺省 extend({}) 且死线源为 ttlSeconds：从当前时刻按原 TTL 重算（重布语义，窗口重启）', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 60, onExpire })
    c.start()
    vi.advanceTimersByTime(50_000)
    c.extend({}) // ttlSeconds 派生死线 = 重算 now+60s，而非钉住旧绝对死线
    expect(c.remainingMs()).toBe(60_000)
    vi.advanceTimersByTime(59_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
  })

  it('extend 到已过去的 expiresAt（负剩余）：立即 end("ttl")（起表即过期）', () => {
    const onExpire = vi.fn()
    const c = new SessionController({ ttlSeconds: 60, onExpire })
    c.start()
    vi.advanceTimersByTime(10_000)
    c.extend({ expiresAt: Date.now() - 1 })
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith('ttl')
    expect(c.isExpired()).toBe(true)
    expect(c.remainingMs()).toBe(0)
  })
})
