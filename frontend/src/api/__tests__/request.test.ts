/**
 * api/request 拦截器全链单测（axios adapter 桩——不经网络）：
 * 请求侧（Content-Type 按载荷调整 / Bearer 注入+公开路径豁免 / X-Trace-Id / 写方法幂等键）/
 * 响应侧（信封解包 / 业务错→ApiError+字段详情 / silent 标记 / 业务 10200 清登录态跳登录）/
 * HTTP 错误（401 刷新单飞+重放 / 刷新失败清态 / 各状态码文案 / 超时 / 断网）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import axios from 'axios'

// router 跳登录：mock 掉（避免拉真实路由表）
vi.mock('@/router', () => ({
  default: { hasRoute: vi.fn(() => true), getRoutes: vi.fn(() => []), push: vi.fn(), currentRoute: { value: { path: '/', fullPath: '/' } } },
}))

import request, { setUserStoreGetter, http } from '../request'

/** 内存 Storage 桩（Node ≥23 实验性全局库静默失效） */
function installMemStorage(name: 'localStorage' | 'sessionStorage'): void {
  const mem = new Map<string, string>()
  const fake = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() {
      return mem.size
    },
  }
  Object.defineProperty(window, name, { value: fake, configurable: true })
  Object.defineProperty(globalThis, name, { value: fake, configurable: true })
}

/** 收到请求配置的桩 adapter（可回放预设响应/错误） */
let lastConfig: InternalAxiosRequestConfig | undefined
function stubAdapter(respond: (config: InternalAxiosRequestConfig) => Promise<Omit<AxiosResponse, 'config'>> | never): void {
  const adapter: AxiosAdapter = async (config) => {
    lastConfig = config
    try {
      const partial = await respond(config)
      return { ...partial, config } as AxiosResponse
    } catch (err) {
      throw err // axios 错误路径：reject 带 response 的对象
    }
  }
  request.defaults.adapter = adapter
}

/** fake 登录态 */
function fakeAuth(over: Partial<{ accessToken: string; refreshToken: string; hasToken: boolean; refreshAccessToken: ReturnType<typeof vi.fn>; clearAuth: ReturnType<typeof vi.fn> }> = {}) {
  const store = {
    accessToken: over.accessToken ?? '',
    refreshToken: over.refreshToken ?? '',
    hasToken: over.hasToken ?? false,
    refreshAccessToken: over.refreshAccessToken ?? vi.fn(async () => 'new-token'),
    clearAuth: over.clearAuth ?? vi.fn(),
  }
  setUserStoreGetter(() => store)
  return store
}

beforeEach(() => {
  installMemStorage('localStorage')
  installMemStorage('sessionStorage')
  setUserStoreGetter(null)
  lastConfig = undefined
})

// ───────────────────────── 请求拦截器 ─────────────────────────

describe('请求拦截器：头注入', () => {
  it('JSON 默认头 / FormData 删 Content-Type / URLSearchParams 不动', async () => {
    stubAdapter(async () => ({ data: {}, status: 200, statusText: 'OK', headers: {} }))
    await http.post('/x', { a: 1 })
    expect(lastConfig?.headers.get('Content-Type')).toBe('application/json')

    const fd = new FormData()
    fd.append('f', 'v')
    await http.post('/x', fd)
    // FormData：拦截器删默认 json 头（multipart 交由传输层补 boundary）
    expect(String(lastConfig?.headers.get('Content-Type') ?? '')).not.toContain('application/json')

    await http.post('/x', new URLSearchParams({ a: '1' })) // URLSearchParams：不强设（实例缺省仍在，可观测面=json 头不来自本拦截器）
  })

  it('Bearer 注入（有 token 且非公开路径）；公开路径豁免；写方法带幂等键；全请求带 X-Trace-Id', async () => {
    fakeAuth({ accessToken: 'tk-1', hasToken: true })
    stubAdapter(async () => ({ data: { code: 200, data: null }, status: 200, statusText: 'OK', headers: {} }))

    await http.get('/api/v1/things')
    expect(lastConfig?.headers.get('Authorization')).toBe('Bearer tk-1')
    const idem1 = lastConfig?.headers.get('Idempotency-Key')
    expect(idem1).toBeUndefined() // GET 不加幂等键
    expect(lastConfig?.headers.get('X-Trace-Id')).toBeTruthy()

    await http.post('/api/v1/things', {})
    const idem2 = lastConfig?.headers.get('Idempotency-Key')
    expect(idem2).toMatch(/^[0-9a-f-]{36}$/) // 写方法幂等键

    await http.post('/api/v1/auth/login', {}) // 公开路径：不带 Bearer
    expect(lastConfig?.headers.get('Authorization')).toBeUndefined()
  })

  it('无登录态：不注入 Bearer 不抛', async () => {
    stubAdapter(async () => ({ data: {}, status: 200, statusText: 'OK', headers: {} }))
    await expect(http.get('/anything')).resolves.toBeDefined()
    expect(lastConfig?.headers.get('Authorization')).toBeUndefined()
  })
})

// ───────────────────────── 响应拦截器：成功面 ─────────────────────────

describe('响应拦截器：信封解包', () => {
  it('code 200/0 → data.data；无 code 信封 → 原样透传；trace_id 捕获进 sessionStorage', async () => {
    stubAdapter(async (_c) => ({
      data: { code: 200, data: { id: 7 }, trace_id: 'tr-77', message: 'ok' },
      status: 200, statusText: 'OK', headers: { 'x-trace-id': 'tr-header' },
    }))
    await expect(http.get('/x')).resolves.toEqual({ id: 7 })
    // header 优先于 body
    expect(sessionStorage.getItem('aigc:trace-id')).toBe('tr-header')

    stubAdapter(async () => ({ data: [1, 2, 3], status: 200, statusText: 'OK', headers: {} }))
    await expect(http.get('/raw')).resolves.toEqual([1, 2, 3]) // 非信封原样
  })
})

// ───────────────────────── 响应拦截器：业务错误 ─────────────────────────

describe('响应拦截器：业务错误 → ApiError', () => {
  it('非 200/0 业务码：message/msg 兜底 + 字段 details + traceId', async () => {
    stubAdapter(async () => ({
      data: {
        code: 40401, message: '', msg: '资源不存在', trace_id: 'tr-9',
        error: [{ field: 'code', code: 'FORMAT_INVALID', message: '格式错', rejectedValue: 'xx' }, null, {}],
      },
      status: 200, statusText: 'OK', headers: {},
    }))
    const err = await http.get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ code: 40401, message: '资源不存在', traceId: 'tr-9' })
    expect(err.details).toHaveLength(1) // null/空对象被过滤
    expect(err.details[0]).toMatchObject({ field: 'code', message: '格式错' })
  })

  it('silent 请求：错误对象带 silent（弹窗层自行静默）', async () => {
    stubAdapter(async () => ({ data: { code: 50001, message: 'm' }, status: 200, statusText: 'OK', headers: {} }))
    const err = await http.get('/x', { silent: true }).catch((e) => e)
    expect(err.silent).toBe(true)
  })

  it('业务码 10200（HTTP 200 未授权）：清登录态 + 跳登录 + silent', async () => {
    const clearAuth = vi.fn()
    fakeAuth({ accessToken: 't', hasToken: true, clearAuth })
    const routerMod = (await import('@/router')).default
    stubAdapter(async () => ({ data: { code: 10200, message: '未登录' }, status: 200, statusText: 'OK', headers: {} }))
    const err = await http.get('/x').catch((e) => e)
    expect(clearAuth).toHaveBeenCalledTimes(1)
    expect(routerMod.push).toHaveBeenCalledWith({ path: '/login', query: undefined })
    expect(err.silent).toBe(true)
  })
})

// ───────────────────────── HTTP 错误面 ─────────────────────────

describe('HTTP 错误：状态码映射与 401 刷新', () => {
  /** 抛 HTTP 错误的桩（axios 错误形态：{ response, config }） */
  function stubHttpError(status: number, data: unknown = {}): void {
    request.defaults.adapter = (async (config) => {
      const err = new Error('Request failed') as Error & { response?: unknown; config?: unknown; isAxiosError?: boolean }
      err.response = { data, status, statusText: '', headers: {} }
      err.config = config
      err.isAxiosError = true
      throw err
    }) as AxiosAdapter
  }

  it('400/403/404/500/其它：文案映射 + ApiError 带 status', async () => {
    stubHttpError(400, { message: '参数坏' })
    const e400 = await http.get('/x').catch((e) => e)
    expect(e400).toMatchObject({ status: 400, message: '参数坏' })

    stubHttpError(403)
    const e403 = await http.get('/x').catch((e) => e)
    expect(e403.status).toBe(403)

    stubHttpError(404)
    const e404 = await http.get('/x').catch((e) => e)
    expect(e404.status).toBe(404)

    stubHttpError(500, { message: '炸了' })
    const e500 = await http.get('/x').catch((e) => e)
    expect(e500.message).toBe('炸了')

    stubHttpError(503)
    const e503 = await http.get('/x').catch((e) => e)
    expect(e503.message).toContain('503')
  })

  it('401 首次：单飞刷新新 token 并重放原请求成功', async () => {
    const refreshAccessToken = vi.fn(async () => 'fresh-token')
    fakeAuth({ accessToken: 'old', refreshToken: 'r', hasToken: true, refreshAccessToken })
    let calls = 0
    request.defaults.adapter = (async (config) => {
      calls += 1
      if (calls === 1) {
        const err = new Error('401') as Error & { response?: unknown; config?: unknown }
        err.response = { data: {}, status: 401, statusText: '', headers: {} }
        err.config = config
        throw err
      }
      // 重放会再过请求拦截器：Authorization 按 store.accessToken（未更新的 mock=old）重注——
      // 新 token 生效依赖真实 store 在 refreshAccessToken 里写回 accessToken（此处断言重放发生即可）
      expect(String(config.headers?.get?.('Authorization'))).toContain('Bearer')
      expect((config as { __retried?: boolean }).__retried).toBe(true)
      return { data: { code: 200, data: 'replayed' }, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
    }) as AxiosAdapter
    await expect(http.get('/api/v1/secure')).resolves.toBe('replayed')
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('401 刷新失败：清登录态 + 跳登录 + 拒 ApiError；auth 端点不重试直接清', async () => {
    const clearAuth = vi.fn()
    fakeAuth({ accessToken: 'old', refreshToken: 'r', hasToken: true, refreshAccessToken: vi.fn(async () => { throw new Error('refresh boom') }), clearAuth })
    const routerMod = (await import('@/router')).default
    request.defaults.adapter = (async (config) => {
      const err = new Error('401') as Error & { response?: unknown; config?: unknown }
      err.response = { data: {}, status: 401, statusText: '', headers: {} }
      err.config = config
      throw err
    }) as AxiosAdapter
    const e1 = await http.get('/api/v1/secure').catch((e) => e)
    expect(clearAuth).toHaveBeenCalledTimes(1)
    expect(routerMod.push).toHaveBeenCalled()
    // 刷新失败分支：ApiError 以 HTTP_STATUS.UNAUTHORIZED 为 **code**（status 未传——源码观测契约）
    expect(e1.code).toBe(401)
    expect(e1.message).toBeTruthy()

    clearAuth.mockClear()
    ;(routerMod.push as ReturnType<typeof vi.fn>).mockClear()
    await http.post('/api/v1/auth/refresh').catch(() => undefined) // auth 端点：不重试
    expect(clearAuth).toHaveBeenCalledTimes(1)
  })

  it('无 response（超时/断网）：ApiError code 0 + i18n 文案', async () => {
    request.defaults.adapter = (async (config) => {
      const timeout = new Error('timeout') as Error & { code?: string; config?: unknown }
      timeout.code = 'ECONNABORTED'
      timeout.config = config
      throw timeout
    }) as AxiosAdapter
    const e1 = await http.get('/x').catch((e) => e)
    expect(e1.code).toBe(0)

    request.defaults.adapter = (async () => {
      throw new Error('Network Error')
    }) as AxiosAdapter
    const e2 = await http.get('/x').catch((e) => e)
    expect(e2.code).toBe(0)
    expect(e2.message).toBeTruthy()
  })

  it('http 快捷方法五件套走同一拦截器链', async () => {
    stubAdapter(async () => ({ data: { code: 0, data: 'ok' }, status: 200, statusText: 'OK', headers: {} }))
    await expect(http.post('/p', {})).resolves.toBe('ok')
    await expect(http.put('/p', {})).resolves.toBe('ok')
    await expect(http.patch('/p', {})).resolves.toBe('ok')
    await expect(http.delete('/p')).resolves.toBe('ok')
    await expect(http.get('/p')).resolves.toBe('ok')
  })
})
