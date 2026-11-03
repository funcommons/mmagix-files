/**
 * config.ts WebDAV 分支单测（M2-T 测试先行）
 * 契约：《docs/design/webdav-support-design.md》§W6（M2 装配）
 *
 * - workspace 校验按 backend.type 分流：'webdav' → endpoint 非空必填、username/password/rootPath
 *   可选字符串、ttlSeconds 正数（同现行）；'s3'/缺省 → 现行四要素+credentials 校验逐字节不变。
 * - 非法 type（如 'ftp'）→ problems 报错（文案锚：backend.type 须为 's3' | 'webdav'）。
 * - 黄金向后兼容：缺 type 的现行 S3 config 行为不变（既有 config.test.ts 53 例全绿即为主证据，
 *   本文件另补一例显式守门）。
 * - buildConfigSummary webdav 分支不得透出 password（对照现行 S3 credentials 整段不进摘要照做）。
 */
import { describe, it, expect } from 'vitest'
import { parseAppConfig, buildConfigSummary, persistRawConfig, restoreRawConfig } from '../config'
import { SdkError, ERROR_CODES } from '../errorCodes'
import { CONFIG_VERSION } from '../constants'
import type { AppConfig, WorkspaceConfig } from '../types'

// ───────────────────────── 样例 ─────────────────────────

/** 现行 S3 workspace 样例（缺 type=黄金向后兼容形态；与 config.test.ts 同构） */
const s3WorkspaceJson = {
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
}

/** webdav workspace 最小形状（仅 type+endpoint 必填） */
const webdavMinimalJson = {
  v: CONFIG_VERSION,
  mode: 'workspace',
  backend: { type: 'webdav', endpoint: 'https://dav.example.com' },
  security: { allowedOrigins: ['https://your-app.example.com'] },
}

/** webdav workspace 全字段形状（§W6 向导 WebDAV 分支的落盘形态） */
const webdavFullJson = {
  ...webdavMinimalJson,
  backend: {
    type: 'webdav',
    endpoint: 'https://dav.example.com',
    username: 'alice',
    password: 'DAVPASS-should-not-leak',
    rootPath: '/dav',
    ttlSeconds: 3600,
  },
}

const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o))

/** 断言 fn 抛 SdkError(4001) 并返回该错误（与 config.test.ts 同款 helper） */
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

/** webdav 样例 backend 段局部覆盖后解析 */
function parseWebdavWith(override: Record<string, unknown>): AppConfig {
  return parseAppConfig('#config=' + enc({ ...webdavFullJson, backend: { ...webdavFullJson.backend, ...override } }))
}

// ───────────────────────── 正例 ─────────────────────────

describe('parseAppConfig：webdav 正例（§W6 M2）', () => {
  it('最小形状 {type:"webdav", endpoint} 解析成功，mode 注入 workspace、type 保留', () => {
    const cfg = parseAppConfig('#config=' + enc(webdavMinimalJson))
    const w = cfg as WorkspaceConfig
    expect(w.mode).toBe('workspace')
    expect(w.v).toBe(CONFIG_VERSION)
    expect((w.backend as Record<string, unknown>).type).toBe('webdav')
    expect(w.backend.endpoint).toBe('https://dav.example.com')
    // security 校验对 webdav 分支同口径不豁免
    expect(w.security.allowedOrigins).toEqual(['https://your-app.example.com'])
  })

  it('全字段形状：username/password/rootPath/ttlSeconds 原样保留（只增不删）', () => {
    const cfg = parseAppConfig('#config=' + enc(webdavFullJson)) as WorkspaceConfig
    expect(cfg.backend.endpoint).toBe('https://dav.example.com')
    const b = cfg.backend as Record<string, unknown>
    expect(b.username).toBe('alice')
    expect(b.password).toBe('DAVPASS-should-not-leak')
    expect(b.rootPath).toBe('/dav')
    expect(b.ttlSeconds).toBe(3600)
  })

  it('可选项（username/password/rootPath/ttlSeconds）全部缺省 → 通过', () => {
    // webdavMinimalJson 即全缺省形态；再叠 mode 与键名一致路径
    expect(() => parseAppConfig('#config=' + enc(webdavMinimalJson))).not.toThrow()
  })

  it("显式 type:'s3' → 走现行 S3 校验分支：合法样例通过", () => {
    const cfg = parseAppConfig(
      '#config=' + enc({ ...s3WorkspaceJson, backend: { type: 's3', ...s3WorkspaceJson.backend } }),
    ) as WorkspaceConfig
    expect((cfg.backend as Record<string, unknown>).type).toBe('s3')
    expect(cfg.backend.bucket).toBe('your-bucket')
  })
})

// ───────────────────────── 负例矩阵 ─────────────────────────

describe('parseAppConfig：webdav 负例矩阵（§W6 M2）', () => {
  it('缺 endpoint → detail 含 backend.endpoint（非空必填）', () => {
    const e = expectBad(() => parseWebdavWith({ endpoint: undefined }))
    expect(detailOf(e)).toContain('backend.endpoint')
  })

  it('endpoint 空串 / 纯空白 → detail 含 backend.endpoint', () => {
    for (const bad of ['', '   ']) {
      const e = expectBad(() => parseWebdavWith({ endpoint: bad }))
      expect(detailOf(e)).toContain('backend.endpoint')
    }
  })

  it("非法 type 'ftp' → detail 含 backend.type（文案锚：backend.type 须为 's3' | 'webdav'）", () => {
    const e = expectBad(() => parseWebdavWith({ type: 'ftp' }))
    expect(detailOf(e)).toContain('backend.type')
    // 非 's3'/'webdav' 一律拒（大小写敏感，判别联合字面量）
    const e2 = expectBad(() => parseWebdavWith({ type: 'WebDAV' }))
    expect(detailOf(e2)).toContain('backend.type')
  })

  it('ttlSeconds 非正数（0/负数/非数字）→ detail 含 backend.ttlSeconds 须为正数（同现行口径）', () => {
    for (const bad of [0, -5, '3600']) {
      const e = expectBad(() => parseWebdavWith({ ttlSeconds: bad }))
      expect(detailOf(e)).toContain('backend.ttlSeconds')
    }
  })

  it('可选项类型闸：username/password/rootPath 出现但非字符串 → detail 指明该字段（可选字符串契约）', () => {
    for (const key of ['username', 'password', 'rootPath'] as const) {
      const e = expectBad(() => parseWebdavWith({ [key]: 42 }))
      expect(detailOf(e)).toContain(`backend.${key}`)
    }
  })

  it('security.allowedOrigins 对 webdav 分支同口径校验（缺失 → detail 含 allowedOrigins）', () => {
    const e = expectBad(() => parseAppConfig('#config=' + enc({ ...webdavMinimalJson, security: undefined })))
    expect(detailOf(e)).toContain('allowedOrigins')
  })
})

// ───────────────────────── 黄金向后兼容 ─────────────────────────

describe('parseAppConfig：黄金向后兼容（缺 type = 现行 S3 路径零改动）', () => {
  it('缺 type 的现行 S3 config 照常通过（既有 config.test.ts 53 例全绿为主证据，此为显式守门）', () => {
    const cfg = parseAppConfig('#config=' + enc(s3WorkspaceJson)) as WorkspaceConfig
    expect(cfg.mode).toBe('workspace')
    expect(cfg.backend.bucket).toBe('your-bucket')
    expect(cfg.backend.credentials.accessKeyId).toBe('STS.xxx')
    // 缺 type 时 backend 上不得凭空注入 type 键（只增不删的反面：不无中生有）
    expect((cfg.backend as Record<string, unknown>).type).toBeUndefined()
  })

  it('缺 type 时 S3 缺项报错口径不变（缺 bucket → 缺 backend.bucket，不误报 backend.type）', () => {
    const e = expectBad(
      () => parseAppConfig('#config=' + enc({ ...s3WorkspaceJson, backend: { ...s3WorkspaceJson.backend, bucket: '' } })),
    )
    expect(detailOf(e)).toContain('backend.bucket')
  })
})

// ───────────────────────── buildConfigSummary ─────────────────────────

describe('buildConfigSummary：webdav 分支不得透出 password（§W6 M2）', () => {
  it('序列化全文不含密码值、不含 password 键名（对照现行 credentials 整段不进摘要照做）', () => {
    const cfg = parseAppConfig('#config=' + enc(webdavFullJson))
    const s = buildConfigSummary(cfg)
    const text = JSON.stringify(s)
    // 密码值（显眼假值，供全文检索）
    expect(text).not.toContain('DAVPASS-should-not-leak')
    // 键名同样不透出（S3 对 credentials 是整段缺席；webdav 对 password 同法）
    expect(text).not.toContain('password')
  })

  it('摘要基本形状不因分流缺失：mode/v 照常透出（features 键列表同现行）', () => {
    const cfg = parseAppConfig('#config=' + enc({ ...webdavFullJson, features: { upload: true } }))
    const s = buildConfigSummary(cfg)
    expect(s.mode).toBe('workspace')
    expect(s.v).toBe(CONFIG_VERSION)
    expect(s.features).toEqual(['upload'])
    // username 非凭证机密字段（WebDAV Basic 里 password 才是），透出与否均不违反红线——契约只锁 password
  })
})

// ───────────────────────── fragment 备份往返 ─────────────────────────

describe('persistRawConfig/restoreRawConfig：webdav fragment 往返（§W6 凭证通道不变）', () => {
  /** 内存版 Storage（与 config.test.ts 同形） */
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

  it('webdav #config= 片段落盘 → 读回原文 → parseAppConfig 原链重建成功', () => {
    const storage = makeMemoryStorage()
    const fragment = '#config=' + enc(webdavFullJson)
    persistRawConfig(fragment, { storage, ttlSeconds: 3600 })
    const restored = restoreRawConfig({ storage })
    expect(restored).toBe(fragment) // 原文往返（encodeURIComponent 形态不改动）
    const cfg = parseAppConfig(restored!) as WorkspaceConfig
    expect(cfg.mode).toBe('workspace')
    expect((cfg.backend as Record<string, unknown>).type).toBe('webdav')
    // 凭证通道承诺：密码只进 sessionStorage 备份，备份读回后解析层不丢
    expect((cfg.backend as Record<string, unknown>).password).toBe('DAVPASS-should-not-leak')
  })
})

// ───────────────────────── M4：chunkedWrite / maxUploadSize（§W4 上传矩阵） ─────────────────────────

/**
 * M4 契约（《docs/design/webdav-support-design.md》§W4）：WebDavBackend += chunkedWrite?: boolean
 * （「支持分块续写」家族开关，缺省 false=安全降级——无标准化探测方法，known-good 清单由实机
 * 取证批次维护）与 maxUploadSize?: number（'none' 整包降级面的单文件上限，缺省 1GB，仅 'none'
 * 策略生效）。校验手法照既有可选字段矩阵：类型闸（布尔）/ 正数闸（同 ttlSeconds 口径）。
 * 追加用例不改动上方既有用例（只增不改义）。
 */
describe('parseAppConfig：webdav chunkedWrite/maxUploadSize 校验（§W4 M4）', () => {
  it('chunkedWrite 出现但非布尔（字符串/数字/null）→ detail 含 backend.chunkedWrite', () => {
    for (const bad of ['true', 1, null]) {
      const e = expectBad(() => parseWebdavWith({ chunkedWrite: bad }))
      expect(detailOf(e)).toContain('backend.chunkedWrite')
    }
  })

  it('chunkedWrite 布尔合法：true/false 均放行且原样保留（缺省关=安全降级，缺省不传仍过）', () => {
    for (const ok of [true, false]) {
      const cfg = parseWebdavWith({ chunkedWrite: ok }) as WorkspaceConfig
      expect((cfg.backend as Record<string, unknown>).chunkedWrite).toBe(ok)
    }
  })

  it('maxUploadSize 非正数（0/负数/非数字）→ detail 含 backend.maxUploadSize（须为正数，同 ttlSeconds 口径）', () => {
    for (const bad of [0, -5, '100']) {
      const e = expectBad(() => parseWebdavWith({ maxUploadSize: bad }))
      expect(detailOf(e)).toContain('backend.maxUploadSize')
    }
  })

  it('chunkedWrite + maxUploadSize 合法组合放行：字段只增不删、既有字段不因新增校验受损', () => {
    const cfg = parseWebdavWith({ chunkedWrite: true, maxUploadSize: 5 * 1024 * 1024 }) as WorkspaceConfig
    const b = cfg.backend as Record<string, unknown>
    expect(b.chunkedWrite).toBe(true)
    expect(b.maxUploadSize).toBe(5 * 1024 * 1024)
    expect(b.endpoint).toBe('https://dav.example.com')
    expect(b.username).toBe('alice')
    expect(b.password).toBe('DAVPASS-should-not-leak')
  })

  it('两字段均缺省（不传）→ 照常通过（缺省形状向后兼容，勿强校验必填）', () => {
    expect(() => parseAppConfig('#config=' + enc(webdavMinimalJson))).not.toThrow()
  })
})
