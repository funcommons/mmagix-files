/**
 * config.ts 单测：URL fragment 配置解析（#config / #file）
 * 契约：《docs/design/solution-design.md》V1.2 §4.1 / §4.1b、《docs/operations/user-guide.md》V1.0 §一
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseAppConfig,
  buildConfigSummary,
  scrubFragment,
  fragmentHasConfigKey,
  persistRawConfig,
  restoreRawConfig,
  clearRawConfig,
  RAW_CONFIG_STORAGE_KEY,
} from '../config'
import { SdkError, ERROR_CODES } from '../errorCodes'
import { CONFIG_VERSION } from '../constants'
import type { AppConfig, SingleFileConfig, WorkspaceConfig } from '../types'

// ───────────────────────── 样例（照抄《docs/operations/user-guide.md》§一配置示例） ─────────────────────────

const workspaceJson = {
  v: CONFIG_VERSION,
  backend: {
    endpoint: 'https://oss-cn-shenzhen.aliyuncs.com',
    region: 'oss-cn-shenzhen',
    bucket: 'your-bucket',
    prefix: 'sessions/20261008-abc/',
    credentials: { accessKeyId: 'STS.xxx', accessKeySecret: 'xxx', sessionToken: 'xxx' },
    ttlSeconds: 3600,
  },
  security: { allowedOrigins: ['https://your-app.example.com'] },
  params: { uploadMaxBytes: 104857600, uploadConcurrency: 3 },
  appearance: {
    theme: 'light',
    brand: { name: '你的产品名', logoUrl: 'https://example.com/logo.svg', primaryColor: '#4f6ef2' },
    locale: 'zh-CN',
  },
  features: { upload: true, delete: true, rename: true, mkdir: true, download: true },
  permissions: { denyExts: ['exe'] },
  plugins: [{ url: 'https://cdn.your.com/mmagic/ipynb-viewer.js', sri: 'sha384-xxx', lazy: true }],
  ui: { initialPath: '/', defaultOpen: 'reports/summary.md' },
}

const fileJson = {
  v: CONFIG_VERSION,
  source: { url: 'https://api.your.com/docs/42', method: 'GET', headers: { Authorization: 'Bearer token' } },
  save: { method: 'PUT', url: 'https://api.your.com/docs/42' },
  name: 'doc.md',
}

const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o))

/** 断言 fn 抛 SdkError(4001) 并返回该错误（detail 约定为 string[]） */
function expectBad(fn: () => unknown): SdkError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(SdkError)
    const e = err as SdkError
    expect(e.code).toBe(ERROR_CODES.BAD_CONFIG)
    return e
  }
  throw new Error('预期抛出 SdkError(4001)，但未抛出')
}

/** detail（string[]）拼成单串便于断言缺失段关键词 */
function detailOf(e: SdkError): string {
  return Array.isArray(e.detail) ? e.detail.join(';') : String(e.detail)
}

/** 在合法 workspace 样例上做局部覆盖后解析，专测缺项路径 */
function parseWorkspaceWith(override: Record<string, unknown>): AppConfig {
  return parseAppConfig('#config=' + enc({ ...workspaceJson, ...override }))
}

/** 在 backend 段上做局部覆盖后解析 */
function parseBackendWith(override: Record<string, unknown>): AppConfig {
  return parseWorkspaceWith({ backend: { ...workspaceJson.backend, ...override } })
}

/** 在 credentials 段上做局部覆盖后解析 */
function parseCredsWith(override: Record<string, unknown>): AppConfig {
  return parseBackendWith({ credentials: { ...workspaceJson.backend.credentials, ...override } })
}

// ───────────────────────── 合法样例 ─────────────────────────

describe('parseAppConfig：合法样例', () => {
  it('#config= 工作台样例解析成功，mode 注入 workspace', () => {
    const cfg = parseAppConfig('#config=' + enc(workspaceJson))
    const w = cfg as WorkspaceConfig
    expect(w.mode).toBe('workspace')
    expect(w.v).toBe(CONFIG_VERSION)
    expect(w.backend.endpoint).toBe('https://oss-cn-shenzhen.aliyuncs.com')
    expect(w.backend.credentials.accessKeyId).toBe('STS.xxx')
    expect(w.security.allowedOrigins).toEqual(['https://your-app.example.com'])
    expect(w.backend.ttlSeconds).toBe(3600)
  })

  it('#file= 单文件样例（可写含 save）解析成功', () => {
    const cfg = parseAppConfig('#file=' + enc(fileJson))
    const f = cfg as SingleFileConfig
    expect(f.mode).toBe('file')
    expect(f.source.url).toBe('https://api.your.com/docs/42')
    expect(f.source.method).toBe('GET')
    expect(f.save?.method).toBe('PUT')
    expect(f.name).toBe('doc.md')
  })

  it('#file= 只读样例（无 save 段）解析成功', () => {
    const readonlyJson = { v: CONFIG_VERSION, source: { url: 'https://a.com/x.md' }, name: 'x.md' }
    const cfg = parseAppConfig('#file=' + enc(readonlyJson)) as SingleFileConfig
    expect(cfg.mode).toBe('file')
    expect(cfg.save).toBeUndefined()
  })

  it('缺省参数取 window.location.hash', () => {
    window.location.hash = '#config=' + enc(workspaceJson)
    const cfg = parseAppConfig()
    expect((cfg as WorkspaceConfig).mode).toBe('workspace')
  })

  it('无前导 # 也能解析（容错）', () => {
    const cfg = parseAppConfig('config=' + enc(workspaceJson))
    expect((cfg as WorkspaceConfig).backend.bucket).toBe('your-bucket')
  })

  it('mode 字段存在且与键一致时保留', () => {
    const cfg = parseAppConfig('#config=' + enc({ ...workspaceJson, mode: 'workspace' }))
    expect((cfg as WorkspaceConfig).mode).toBe('workspace')
  })

  it('任意未知键不报错且原样保留（只增不删纪律）', () => {
    const cfg = parseAppConfig('#config=' + enc({ ...workspaceJson, futureField: { x: 1 } }))
    expect((cfg as unknown as Record<string, unknown>).futureField).toEqual({ x: 1 })
  })
})

// ───────────────────────── 解析失败 ─────────────────────────

describe('parseAppConfig：解析失败', () => {
  it('坏 JSON → 4001，detail 含原因', () => {
    const e = expectBad(() => parseAppConfig('#config=' + encodeURIComponent('{not-json')))
    expect(detailOf(e)).toContain('JSON 解析失败')
  })

  it('decodeURIComponent 失败 → 4001', () => {
    const e = expectBad(() => parseAppConfig('#config=%E0%A4%A'))
    expect(e.code).toBe(ERROR_CODES.BAD_CONFIG)
  })

  it('fragment 无 config/file 键 → 4001', () => {
    const e = expectBad(() => parseAppConfig('#other=1'))
    expect(detailOf(e)).toContain('config')
  })

  it('空 hash → 4001', () => {
    const e = expectBad(() => parseAppConfig(''))
    expect(e.code).toBe(ERROR_CODES.BAD_CONFIG)
  })

  it('config 与 file 同现 → 4001（互斥）', () => {
    const e = expectBad(() => parseAppConfig('#config=' + enc(workspaceJson) + '&file=' + enc(fileJson)))
    expect(detailOf(e)).toContain('互斥')
  })

  it('键缺配置内容（#config= 空值）→ 4001', () => {
    expectBad(() => parseAppConfig('#config='))
  })
})

// ───────────────────────── v 校验 ─────────────────────────

describe('parseAppConfig：v 版本校验', () => {
  it('v 缺失 → 4001', () => {
    const { v: _v, ...noV } = workspaceJson
    const e = expectBad(() => parseAppConfig('#config=' + enc(noV)))
    expect(detailOf(e)).toContain('v')
  })

  it('v 不支持 → 4001，detail 指明版本', () => {
    const e = expectBad(() => parseAppConfig('#config=' + enc({ ...workspaceJson, v: CONFIG_VERSION + 1 })))
    expect(detailOf(e)).toContain(String(CONFIG_VERSION + 1))
  })
})

// ───────────────────────── workspace 缺项校验 ─────────────────────────

describe('parseAppConfig：workspace 缺项', () => {
  it('缺 backend → detail 含 缺 backend', () => {
    const { backend: _b, ...noBackend } = workspaceJson
    const e = expectBad(() => parseAppConfig('#config=' + enc(noBackend)))
    expect(detailOf(e)).toContain('缺 backend')
  })

  it('backend 三要素(endpoint/region/bucket) 缺失/空串 → detail 指明缺失段', () => {
    const cases: Record<string, unknown>[] = [
      { endpoint: '' },
      { region: '  ' },
      { bucket: undefined },
    ]
    for (const override of cases) {
      const e = expectBad(() => parseBackendWith(override))
      const key = Object.keys(override)[0]
      expect(detailOf(e)).toContain(`backend.${key}`)
    }
  })

  it('prefix 放开空值（三审修复：本地连接 bucket 根形态）——缺失仍拒，空串/斜杠合法', () => {
    // 缺失（非 string）仍拒
    const e = expectBad(() => parseBackendWith({ prefix: undefined }))
    expect(detailOf(e)).toContain('backend.prefix')
    // 空串合法（''=bucket 根）；'/' 由 profiles.buildWorkspaceConfig 归一化为 ''，解析层不拒
    expect(() => parseBackendWith({ prefix: '' })).not.toThrow()
    expect(() => parseBackendWith({ prefix: '/' })).not.toThrow()
  })

  it('缺 backend.credentials → detail 指明', () => {
    const e = expectBad(() => parseBackendWith({ credentials: undefined }))
    expect(detailOf(e)).toContain('缺 backend.credentials')
  })

  it('credentials 双要素缺失/空串 → detail 指明缺失字段；sessionToken 放开空串（三审修复：本地 AK/SK 形态）', () => {
    for (const key of ['accessKeyId', 'accessKeySecret'] as const) {
      const e = expectBad(() => parseCredsWith({ [key]: '' }))
      expect(detailOf(e)).toContain(`backend.credentials.${key}`)
    }
    // sessionToken：缺失（非 string）仍拒；空串合法（sigv4 对空值不发 security-token 头）
    const e = expectBad(() => parseCredsWith({ sessionToken: undefined }))
    expect(detailOf(e)).toContain('backend.credentials.sessionToken')
    expect(() => parseCredsWith({ sessionToken: '' })).not.toThrow()
  })

  it('security 缺失 / allowedOrigins 空数组 / 含非字符串 → detail 含 allowedOrigins', () => {
    const e1 = expectBad(() => parseWorkspaceWith({ security: undefined }))
    expect(detailOf(e1)).toContain('allowedOrigins')

    const e2 = expectBad(() => parseWorkspaceWith({ security: { allowedOrigins: [] } }))
    expect(detailOf(e2)).toContain('allowedOrigins')

    const e3 = expectBad(() => parseWorkspaceWith({ security: { allowedOrigins: ['https://a.com', 42] } }))
    expect(detailOf(e3)).toContain('allowedOrigins')
  })
})

// ───────────────────────── ttlSeconds 校验 ─────────────────────────

describe('parseAppConfig：ttlSeconds 校验', () => {
  it('ttlSeconds=0 → 4001', () => {
    expectBad(() => parseBackendWith({ ttlSeconds: 0 }))
  })

  it('ttlSeconds 负数 → 4001', () => {
    expectBad(() => parseBackendWith({ ttlSeconds: -5 }))
  })

  it('ttlSeconds 非数字 → 4001', () => {
    expectBad(() => parseBackendWith({ ttlSeconds: '3600' }))
  })

  it('ttlSeconds 合法正数 / 缺省 → 通过', () => {
    const a = parseBackendWith({ ttlSeconds: 60 })
    const b = parseBackendWith({ ttlSeconds: undefined })
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
  })
})

// ───────────────────────── file 校验 ─────────────────────────

describe('parseAppConfig：file 缺项', () => {
  it('缺 source → detail 含 缺 source', () => {
    const { source: _s, ...noSource } = fileJson
    const e = expectBad(() => parseAppConfig('#file=' + enc(noSource)))
    expect(detailOf(e)).toContain('缺 source')
  })

  it('source.url 缺失 → 4001（空串合法，见下）', () => {
    const e = expectBad(() => parseAppConfig('#file=' + enc({ ...fileJson, source: { method: 'GET' } })))
    expect(detailOf(e)).toContain('source.url')
  })

  it('source.url 空串 → 合法（v1.2 无源装载：容器模式，boot 不自动打开源文件）', () => {
    const cfg = parseAppConfig('#file=' + enc({ ...fileJson, source: { url: '' }, name: 'container' })) as SingleFileConfig
    expect(cfg.mode).toBe('file')
    expect(cfg.source.url).toBe('')
  })

  it('source.url 非字符串（数字）→ 4001', () => {
    const e = expectBad(() => parseAppConfig('#file=' + enc({ ...fileJson, source: { url: 42 } })))
    expect(detailOf(e)).toContain('source.url')
  })

  it('source.method 非法（DELETE）→ 4001', () => {
    const e = expectBad(() =>
      parseAppConfig('#file=' + enc({ ...fileJson, source: { ...fileJson.source, method: 'DELETE' } })),
    )
    expect(detailOf(e)).toContain('source.method')
  })

  it('save.method 非法（DELETE）→ 4001', () => {
    const e = expectBad(() =>
      parseAppConfig('#file=' + enc({ ...fileJson, save: { ...fileJson.save, method: 'DELETE' } })),
    )
    expect(detailOf(e)).toContain('save.method')
  })

  it('save 缺 url → 4001', () => {
    const e = expectBad(() => parseAppConfig('#file=' + enc({ ...fileJson, save: { method: 'PUT' } })))
    expect(detailOf(e)).toContain('save.url')
  })

  it('mode 与 URL 键冲突（#file= 内 mode:workspace）→ 4001', () => {
    const e = expectBad(() => parseAppConfig('#file=' + enc({ ...fileJson, mode: 'workspace' })))
    expect(detailOf(e)).toContain('mode')
  })
})

// ───────────────────────── buildConfigSummary ─────────────────────────

describe('buildConfigSummary', () => {
  it('workspace 摘要含 mode/v/brand/theme/locale/features 键列表/plugins 数量/prefix', () => {
    const cfg = parseAppConfig('#config=' + enc(workspaceJson))
    const s = buildConfigSummary(cfg)
    expect(s.mode).toBe('workspace')
    expect(s.v).toBe(CONFIG_VERSION)
    expect(s.brand).toBe('你的产品名')
    expect(s.theme).toBe('light')
    expect(s.locale).toBe('zh-CN')
    expect(s.features).toEqual(['upload', 'delete', 'rename', 'mkdir', 'download'])
    expect(s.plugins).toBe(1)
    expect(s.prefix).toBe('sessions/20261008-abc/')
  })

  it('摘要绝不含凭证：序列化后无 accessKey/sessionToken/credentials 子串', () => {
    const cfg = parseAppConfig('#config=' + enc(workspaceJson))
    const s = buildConfigSummary(cfg)
    const text = JSON.stringify(s)
    expect(text).not.toContain('accessKeyId')
    expect(text).not.toContain('accessKeySecret')
    expect(text).not.toContain('sessionToken')
    expect(text).not.toContain('credentials')
    expect(text).not.toContain('STS.xxx')
  })

  it('file 模式摘要：无 prefix/plugins（无 S3 域）', () => {
    const cfg = parseAppConfig('#file=' + enc(fileJson))
    const s = buildConfigSummary(cfg)
    expect(s.mode).toBe('file')
    expect('prefix' in s).toBe(false)
    expect('plugins' in s).toBe(false)
  })

  it('缺省可选段（appearance/features/plugins）时摘要不炸', () => {
    const minimal = {
      v: CONFIG_VERSION,
      backend: workspaceJson.backend,
      security: workspaceJson.security,
    }
    const cfg = parseAppConfig('#config=' + enc(minimal))
    const s = buildConfigSummary(cfg)
    expect(s.features).toEqual([])
    expect(s.plugins).toBe(0)
    expect(s.brand).toBeUndefined()
  })
})

// ───────────────────────── scrubFragment ─────────────────────────

describe('scrubFragment', () => {
  beforeEach(() => {
    window.location.hash = '#config=' + enc(workspaceJson)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('用 history.replaceState 抹除 location.hash', () => {
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    scrubFragment()
    expect(spy).toHaveBeenCalledTimes(1)
    const calledUrl = spy.mock.calls[0]?.[2]
    expect(calledUrl).toBe(window.location.pathname + window.location.search)
  })

  it('replaceState 抛错时静默（沙箱 iframe 等受限环境）', () => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => scrubFragment()).not.toThrow()
  })
})

// ───────────────────────── fragmentHasConfigKey（boot 判断 URL 有无配置键） ─────────────────────────

describe('fragmentHasConfigKey', () => {
  it('#config= / #file= → true', () => {
    expect(fragmentHasConfigKey('#config=' + enc(workspaceJson))).toBe(true)
    expect(fragmentHasConfigKey('#file=' + enc(fileJson))).toBe(true)
  })

  it('空 hash / 仅 # / 未知键 → false', () => {
    expect(fragmentHasConfigKey('')).toBe(false)
    expect(fragmentHasConfigKey('#')).toBe(false)
    expect(fragmentHasConfigKey('#other=1&another=2')).toBe(false)
  })

  it('缺 # 前缀也能识别（与 parseAppConfig 同口径）', () => {
    expect(fragmentHasConfigKey('config=' + enc(workspaceJson))).toBe(true)
  })
})

// ───────────────────────── sessionStorage 备份（刷新重建会话的补偿） ─────────────────────────

/** 内存版 Storage：注入用，不依赖 jsdom 存储实现 */
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

describe('persistRawConfig / restoreRawConfig / clearRawConfig', () => {
  it('存：原始 fragment 整段落盘，值形如 {raw, exp}，exp=now+ttl*1000', () => {
    const storage = makeMemoryStorage()
    persistRawConfig('#config={"v":1}', { storage, ttlSeconds: 3600, now: 1_000_000 })
    const rec = JSON.parse(storage.getItem(RAW_CONFIG_STORAGE_KEY)!) as { raw: string; exp: number }
    expect(rec.raw).toBe('#config={"v":1}')
    expect(rec.exp).toBe(1_000_000 + 3600 * 1000)
  })

  it('存：ttl 超 24h → 截到 24h 硬帽', () => {
    const storage = makeMemoryStorage()
    persistRawConfig('#config=x', { storage, ttlSeconds: 100_000, now: 0 })
    const rec = JSON.parse(storage.getItem(RAW_CONFIG_STORAGE_KEY)!) as { exp: number }
    expect(rec.exp).toBe(24 * 60 * 60 * 1000)
  })

  it('存：无 TTL（file 模式等）→ 24h', () => {
    const storage = makeMemoryStorage()
    persistRawConfig('#file=x', { storage, now: 5_000 })
    const rec = JSON.parse(storage.getItem(RAW_CONFIG_STORAGE_KEY)!) as { exp: number }
    expect(rec.exp).toBe(5_000 + 24 * 60 * 60 * 1000)
  })

  it('取：有效期内读回原始 fragment；不回写、不改动记录', () => {
    const storage = makeMemoryStorage()
    persistRawConfig('#config=abc', { storage, ttlSeconds: 3600, now: 0 })
    expect(restoreRawConfig({ storage, now: 3_599 * 1000 })).toBe('#config=abc')
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).not.toBeNull()
  })

  it('取：过期 → null 且记录即清', () => {
    const storage = makeMemoryStorage()
    persistRawConfig('#config=abc', { storage, ttlSeconds: 3600, now: 0 })
    expect(restoreRawConfig({ storage, now: 3600 * 1000 })).toBeNull()
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()
  })

  it('取：记录损坏（非 JSON / 形状不符）→ null 且记录即清', () => {
    const storage = makeMemoryStorage()
    storage.setItem(RAW_CONFIG_STORAGE_KEY, '{not-json')
    expect(restoreRawConfig({ storage })).toBeNull()
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()

    const storage2 = makeMemoryStorage()
    storage2.setItem(RAW_CONFIG_STORAGE_KEY, JSON.stringify({ nope: 1 }))
    expect(restoreRawConfig({ storage: storage2 })).toBeNull()
    expect(storage2.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()
  })

  it('取：无记录 → null（不抛）', () => {
    expect(restoreRawConfig({ storage: makeMemoryStorage() })).toBeNull()
  })

  it('清除：clearRawConfig 移除记录；无记录时静默', () => {
    const storage = makeMemoryStorage()
    persistRawConfig('#config=abc', { storage })
    clearRawConfig({ storage })
    expect(storage.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()
    expect(() => clearRawConfig({ storage })).not.toThrow()
  })

  it('边界：storage 缺失/null → 存取清全部静默 no-op（沙箱 iframe 等无 sessionStorage 环境）', () => {
    expect(() => persistRawConfig('#config=x', { storage: null })).not.toThrow()
    expect(restoreRawConfig({ storage: null })).toBeNull()
    expect(() => clearRawConfig({ storage: null })).not.toThrow()
  })

  it('边界：storage 操作抛错（隐私模式/quota）→ 静默不炸', () => {
    const throwing: Storage = {
      ...makeMemoryStorage(),
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
      getItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => persistRawConfig('#config=x', { storage: throwing })).not.toThrow()
    expect(restoreRawConfig({ storage: throwing })).toBeNull()
  })

  it('env 缺省（未注入 storage）→ 落 window.sessionStorage', () => {
    const backup = window.sessionStorage
    try {
      const mem = makeMemoryStorage()
      Object.defineProperty(window, 'sessionStorage', { value: mem, configurable: true })
      persistRawConfig('#config=default-win', { ttlSeconds: 60 })
      expect(mem.getItem(RAW_CONFIG_STORAGE_KEY)).not.toBeNull()
      expect(restoreRawConfig()).toBe('#config=default-win')
      clearRawConfig()
      expect(mem.getItem(RAW_CONFIG_STORAGE_KEY)).toBeNull()
    } finally {
      Object.defineProperty(window, 'sessionStorage', { value: backup, configurable: true })
    }
  })
})
