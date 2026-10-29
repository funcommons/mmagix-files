/**
 * errorHandler / notify / errorMessages / idempotency 单测（element-plus 弹层 mock——
 * 被测点是我们拼的参数与分支，不测 EP 渲染）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ApiErrorCode } from '@/api/errorCodes'

const elMessage = vi.hoisted(() => {
  const fn = vi.fn() as unknown as { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn>; mock: unknown }
  fn.error = vi.fn()
  fn.success = vi.fn()
  fn.warning = vi.fn()
  return fn
})
const elNotification = vi.hoisted(() => vi.fn())
const elMessageBox = vi.hoisted(() => ({ confirm: vi.fn() }))

vi.mock('element-plus', () => ({
  ElMessage: elMessage,
  ElNotification: elNotification,
  ElMessageBox: elMessageBox,
  ElMessageBox_default: elMessageBox,
}))

import { errMsg, handleError, showSuccess, showWarning } from '../errorHandler'
import { extractErrorMessage, notifyError, notifyInfo, notifySuccess, notifyWarning } from '../notify'
import { getFriendlyMessage, isKnownCode } from '../errorMessages'
import { useIdempotentSubmit } from '../idempotency'

beforeEach(() => {
  elMessage.mockClear()
  elMessage.error.mockClear()
  elMessage.success.mockClear()
  elMessage.warning.mockClear()
  elNotification.mockClear()
})

// ───────────────────────── errorHandler ─────────────────────────

describe('handleError：统一错误入口', () => {
  it('ApiError：message 直出', () => {
    handleError(new ApiError(ApiErrorCode.SYSTEM_ERROR, '服务开小差'))
    expect(elMessage.error).toHaveBeenCalledWith('服务开小差')
  })

  it('ApiError silent：完全静默', () => {
    handleError(new ApiError(ApiErrorCode.SYSTEM_ERROR, 'quiet', { silent: true }))
    expect(elMessage.error).not.toHaveBeenCalled()
    expect(elMessage).not.toHaveBeenCalled()
  })

  it('ApiError 带字段详情：顶层 message + field: message (rejectedValue) 多行', () => {
    handleError(
      new ApiError(ApiErrorCode.INVALID_PARAMETER, '校验失败', {
        details: [
          { field: 'code', message: '不能为空' },
          { field: 'name', message: '过长', rejectedValue: 'x'.repeat(70) },
          { message: '无名错误' },
        ],
      }),
    )
    const msg = elMessage.mock.calls[0]![0] as { message: string }
    const lines = msg.message.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('校验失败')
    expect(lines[1]).toBe('code: 不能为空')
    expect(lines[2]).toMatch(/^name: 过长 \("x{60}\.\.\."\)$/) // 长字符串截断（60 位 + 引号内省略号）
    expect(lines[3]).toBe('无名错误')
    expect(msg.duration).toBe(6000)
  })

  it('普通 Error message 直出；无 message Error / 未知类型回退 fallback', () => {
    handleError(new Error('boom'))
    expect(elMessage.error).toHaveBeenCalledWith('boom')
    handleError(new Error())
    expect(elMessage.error).toHaveBeenLastCalledWith('操作失败')
    handleError(42, '数字错')
    expect(elMessage.error).toHaveBeenLastCalledWith('数字错')
  })

  it('errMsg / showSuccess / showWarning', () => {
    expect(errMsg(new Error('m1'))).toBe('m1')
    expect(errMsg('raw')).toBe('raw')
    showSuccess('ok')
    expect(elMessage.success).toHaveBeenCalledWith('ok')
    showWarning('hm')
    expect(elMessage.warning).toHaveBeenCalledWith('hm')
  })
})

// ───────────────────────── notify ─────────────────────────

describe('notify：Notification 封装与错误提取', () => {
  it('四类型透传 title/message（top-right/10s/offset 基础项）', () => {
    notifySuccess('t1', 'm1')
    notifyError('t2', 'm2')
    notifyWarning('t3', 'm3')
    notifyInfo('t4', 'm4')
    expect(elNotification).toHaveBeenCalledTimes(4)
    const first = elNotification.mock.calls[0]![0] as Record<string, unknown>
    expect(first).toMatchObject({ type: 'success', title: 't1', message: 'm1', position: 'top-right', duration: 10000, offset: 16 })
    expect((elNotification.mock.calls[1]![0] as Record<string, unknown>).type).toBe('error')
  })

  it('extractErrorMessage 优先级：ApiError > Error > fallback；traceId 追加', () => {
    expect(extractErrorMessage(new ApiError(1, '业务错', { traceId: 'tr-9' }))).toBe('业务错 (trace: tr-9)')
    expect(extractErrorMessage(new ApiError(1, '  带空白  '), undefined, false)).toBe('带空白')
    expect(extractErrorMessage(new Error('普通错'))).toBe('普通错')
    expect(extractErrorMessage('乱入', '兜底文案')).toBe('兜底文案')
  })
})

// ───────────────────────── errorMessages ─────────────────────────

describe('errorMessages：错误码 → i18n key', () => {
  it('已知码映射 / 未知码 null / isKnownCode', () => {
    expect(getFriendlyMessage(ApiErrorCode.TOKEN_EXPIRED)).toBe('ux.error.TOKEN_EXPIRED')
    expect(getFriendlyMessage(ApiErrorCode.RATE_LIMIT_EXCEEDED)).toBe('ux.error.RATE_LIMIT_EXCEEDED')
    expect(getFriendlyMessage(999999)).toBeNull()
    expect(isKnownCode(ApiErrorCode.FORBIDDEN)).toBe(true)
    expect(isKnownCode(123456)).toBe(false)
  })
})

// ───────────────────────── idempotency ─────────────────────────

describe('useIdempotentSubmit：按钮级防重', () => {
  it('首次执行放行 + loading 流转；锁内再调抛 DUPLICATE_SUBMISSION；完成自动解锁', async () => {
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => (release = r))
    const submit = useIdempotentSubmit((_x: string) => gate)
    expect(submit.loading.value).toBe(false)

    const p1 = submit('a')
    expect(submit.loading.value).toBe(true)
    await expect(submit('b')).rejects.toMatchObject({ code: ApiErrorCode.DUPLICATE_SUBMISSION })

    release('done')
    await expect(p1).resolves.toBe('done')
    expect(submit.loading.value).toBe(false)
    // 解锁后可再次执行（fn 即返）
    const again = useIdempotentSubmit(async (x: string) => x)
    await expect(again('re')).resolves.toBe('re')
    expect(again.loading.value).toBe(false)
  })

  it('fn 抛错同样解锁（finally）', async () => {
    const submit = useIdempotentSubmit(async () => {
      throw new Error('boom')
    })
    await expect(submit()).rejects.toThrow('boom')
    expect(submit.loading.value).toBe(false)
    await expect(submit()).rejects.toThrow('boom') // 可重试
  })

  it('reset 手动复位', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const submit = useIdempotentSubmit(() => gate)
    const p = submit()
    expect(submit.loading.value).toBe(true)
    submit.reset()
    expect(submit.loading.value).toBe(false)
    release()
    await p
  })
})
