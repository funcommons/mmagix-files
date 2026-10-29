/**
 * ApiError 判定方法单测（业务错/HTTP 错/认证错三分类）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError, ApiErrorCode, HTTP_STATUS } from '../errorCodes'

describe('ApiError：三分类判定', () => {
  it('业务错（无 status）/ HTTP 错（带 status）', () => {
    const biz = new ApiError(ApiErrorCode.SYSTEM_ERROR, '业务错')
    expect(biz.isBusinessError()).toBe(true)
    expect(biz.isHttpError()).toBe(false)

    const http = new ApiError(500, '服务错', { status: 500 })
    expect(http.isBusinessError()).toBe(false)
    expect(http.isHttpError()).toBe(true)
  })

  it('isAuthError 四通道：HTTP 401 / code 10200 / TOKEN_EXPIRED / TOKEN_INVALID；其余 false', () => {
    expect(new ApiError(401, 'x', { status: HTTP_STATUS.UNAUTHORIZED }).isAuthError()).toBe(true)
    expect(new ApiError(ApiErrorCode.UNAUTHORIZED, 'x').isAuthError()).toBe(true)
    expect(new ApiError(ApiErrorCode.TOKEN_EXPIRED, 'x').isAuthError()).toBe(true)
    expect(new ApiError(ApiErrorCode.TOKEN_INVALID, 'x').isAuthError()).toBe(true)
    expect(new ApiError(ApiErrorCode.FORBIDDEN, 'x').isAuthError()).toBe(false)
    expect(new ApiError(500, 'x', { status: 500 }).isAuthError()).toBe(false)
  })

  it('可选字段透传：silent/traceId/details', () => {
    const e = new ApiError(1, 'm', { silent: true, traceId: 'tr', details: [{ field: 'f', message: 'fm' }] })
    expect(e.silent).toBe(true)
    expect(e.traceId).toBe('tr')
    expect(e.details).toHaveLength(1)
    expect(new ApiError(1, 'm').silent).toBe(false)
  })
})
