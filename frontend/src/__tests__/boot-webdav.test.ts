/**
 * bootApp WebDAV 配置链单测（M2-T 测试先行）
 * 契约：《docs/design/webdav-support-design.md》§W6（M2 装配）
 *
 * 手法照既有 boot.test.ts（FakeWindow 纯对象注入、iframe 分支 parent≠win）：
 * 1. URL 直启：#config=+encodeURIComponent(webdav config) → boot ok →
 *    handle.config.backend.type==='webdav'，ready 握手照发且序列化全文不含密码；
 * 2. 备份重建链：persistRawConfig → 新 FakeWindow（hash=''、共享 sessionStorage）→
 *    restoreRawConfig → 同一 parseAppConfig 路径 → backend.type==='webdav'，不回写 URL。
 *
 * 注：bootApp 不做 store 装配（setupStores 在 main.ts），本文件只验配置解析/握手/备份链——
 * 分流装配见 files/__tests__/setup-webdav.test.ts。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootApp } from '../boot'
import type { BootHandle, BootResult } from '../boot'
import { RAW_CONFIG_STORAGE_KEY, persistRawConfig } from '../sdk/config'
import { NS, PROTOCOL_VERSION } from '../sdk/constants'

// ───────────────────────── 测试基建（照 boot.test.ts 收窄版） ─────────────────────────

const HOST_ORIGIN = 'https://host.example.com'
const REFERRER = 'https://host.example.com/app'

interface OutEnvelope {
  ns: string
  v: number
  kind: 'cmd' | 'evt' | 'reply'
  id: string
  name: string
  payload: unknown
}

/** webdav workspace 合法配置（密码用显眼假值，供「不泄漏」断言检索） */
function webdavConfig() {
  return {
    v: 1,
    mode: 'workspace',
    backend: {
      type: 'webdav',
      endpoint: 'https://dav.example.com',
      username: 'alice',
      password: 'DAVPASS-should-not-leak',
      rootPath: '/dav',
      ttlSeconds: 3600,
    },
    security: { allowedOrigins: [HOST_ORIGIN] },
  }
}

const webdavHash = () => `#config=${encodeURIComponent(JSON.stringify(webdavConfig()))}`

function makeFakeWindow(opts: { hash: string; referrer: string; sessionStorage?: Storage }) {
  const postMessage = vi.fn<(message: unknown, targetOrigin: string) => void>()
  const remote = { postMessage } as unknown as Window
  const listeners = new Set<(e: unknown) => void>()
  const win = {
    location: { hash: opts.hash },
    document: { referrer: opts.referrer },
    parent: remote, // ≠ win ⇒ bootApp 走 iframe 分支
    ...(opts.sessionStorage ? { sessionStorage: opts.sessionStorage } : {}),
    addEventListener(type: string, listener: (e: unknown) => void) {
      if (type === 'message') listeners.add(listener)
    },
    removeEventListener(type: string, listener: (e: unknown) => void) {
      if (type === 'message') listeners.delete(listener)
    },
  }
  const outbound = (): OutEnvelope[] => postMessage.mock.calls.map((c) => c[0] as OutEnvelope)
  return { win: win as unknown as Window, postMessage, outbound }
}

type FakeBundle = ReturnType<typeof makeFakeWindow>

const cleanups: Array<() => void> = []

function bootOk(fake: FakeBundle): BootHandle {
  const result: BootResult = bootApp({ win: fake.win })
  if (!result.ok) {
    throw new Error(`bootApp 应成功，实际失败 code=${result.error.code}: ${String(result.error.message)}`)
  }
  cleanups.push(() => result.handle.dispose())
  return result.handle
}

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

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  vi.restoreAllMocks()
})

// ───────────────────────── 用例 ─────────────────────────

describe('bootApp：webdav 配置（§W6 M2）', () => {
  it('URL 直启：#config= webdav → boot ok，handle.config.backend.type==="webdav"，ready 照发', () => {
    const fake = makeFakeWindow({ hash: webdavHash(), referrer: REFERRER })
    const handle = bootOk(fake)

    const cfg = handle.config as { mode: string; backend: Record<string, unknown> }
    expect(cfg.mode).toBe('workspace')
    expect(cfg.backend.type).toBe('webdav')
    expect(cfg.backend.endpoint).toBe('https://dav.example.com')

    // 握手不因分流缺失：ready 信封照发（ns/v/kind/name + targetOrigin=referrer origin）
    expect(fake.postMessage).toHaveBeenCalledTimes(1)
    const [raw, target] = fake.postMessage.mock.calls[0]!
    expect(target).toBe(HOST_ORIGIN)
    expect(raw).toMatchObject({ ns: NS, v: PROTOCOL_VERSION, kind: 'evt', name: 'ready' })

    // 硬约束：ready 全包（含 configSummary）不得透出密码——值与键名两级检索
    const serialized = JSON.stringify(raw)
    expect(serialized).not.toContain('DAVPASS-should-not-leak')
    expect(serialized).not.toContain('password')
    const payload = (raw as OutEnvelope).payload as { configSummary: Record<string, unknown> }
    expect(payload.configSummary.mode).toBe('workspace')
  })

  it('备份重建链：persistRawConfig(webdav fragment) → hash 已抹的新窗口 → restore 原链 → type==="webdav"，不回写 URL', () => {
    const storage = makeMemoryStorage()
    persistRawConfig(webdavHash(), { storage, ttlSeconds: 3600 })

    // 「刷新」：同页签新加载，hash 已被 scrub 抹掉
    const refreshed = makeFakeWindow({ hash: '', referrer: REFERRER, sessionStorage: storage })
    const handle = bootOk(refreshed)

    const cfg = handle.config as { mode: string; backend: Record<string, unknown> }
    expect(cfg.mode).toBe('workspace')
    expect(cfg.backend.type).toBe('webdav')
    expect(cfg.backend.endpoint).toBe('https://dav.example.com')
    expect(cfg.backend.rootPath).toBe('/dav')
    // 备份记录仍在（webdav 会话未终态；清除链由 expired/destroy 既有路径负责）
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).not.toBeNull()
    // 不回写 URL
    expect(refreshed.win.location.hash).toBe('')
    // 同一解析路径：完整握手照发且不透出密码
    const ready = refreshed.outbound().find((e) => e.kind === 'evt' && e.name === 'ready')
    expect(ready).toBeDefined()
    expect(JSON.stringify(ready)).not.toContain('DAVPASS-should-not-leak')
  })

  it('webdav 配置坏值（ttlSeconds=0）→ 4001 不抛、无任何外发（校验分流后负例仍走 BAD_CONFIG）', () => {
    const bad = webdavConfig()
    ;(bad.backend as Record<string, unknown>).ttlSeconds = 0
    const fake = makeFakeWindow({ hash: '#config=' + encodeURIComponent(JSON.stringify(bad)), referrer: REFERRER })
    const result = bootApp({ win: fake.win })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(4001)
    expect(fake.postMessage).not.toHaveBeenCalled()
  })
})
