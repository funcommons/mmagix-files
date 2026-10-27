/**
 * createCommandHandlers 单测（契约《docs/design/jsdk-api.md》§四/§五/§七）
 * 覆盖：16 键命令表形状（含 v1.1 setCredentials）/ 单文件模式 4305 / 工作台桩 4301 / 终态 5000 / getInfo / destroy / setTheme / setLocale
 */
import { describe, expect, it, vi } from 'vitest'
import { SdkError } from '../errorCodes'
import { createCommandHandlers, SDK_VERSION } from '../handlers'
import type { HandlerDeps } from '../handlers'
import type { CommandName, GetInfoReply, SingleFileConfig, WorkspaceConfig } from '../types'

/** 断言命令抛错并取其错误码（handler 同步抛 SdkError，由装配层转 reply.code） */
function codeOf(fn: () => unknown): number {
  try {
    fn()
  } catch (e) {
    if (e instanceof SdkError) return e.code
    throw e
  }
  throw new Error('预期命令抛出 SdkError，实际正常返回')
}

const backend = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'bucket',
  prefix: 'apps/x/',
  credentials: { accessKeyId: 'ak', accessKeySecret: 'sk', sessionToken: 'tk' },
}
const wsConfig: WorkspaceConfig = {
  mode: 'workspace',
  v: 1,
  backend,
  security: { allowedOrigins: ['https://host.example.com'] },
}
const fileConfig: SingleFileConfig = {
  mode: 'file',
  v: 1,
  source: { url: 'https://cdn.example.com/a.pdf' },
}

function makeDeps(
  opts: { mode?: 'workspace' | 'file'; expired?: boolean; remainingMs?: number; withSession?: boolean } = {},
) {
  const themeBox = { value: 'light' as 'light' | 'dark' | 'auto' }
  const localeBox = { value: 'zh-CN' as 'zh-CN' | 'en-US' }
  const session = {
    remainingMs: vi.fn(() => opts.remainingMs ?? 120_000),
    isExpired: vi.fn(() => opts.expired ?? false),
    destroy: vi.fn(),
  }
  const config = opts.mode === 'file' ? fileConfig : opts.mode === 'workspace' ? wsConfig : null
  const deps: HandlerDeps = {
    getConfig: vi.fn(() => config),
    getSession: vi.fn(() => (opts.withSession === false ? null : session)),
    emit: vi.fn(),
    getFeatures: vi.fn(() => ({ upload: true, delete: false })),
    getTheme: () => themeBox.value,
    setTheme: (t) => {
      themeBox.value = t
    },
    getLocale: () => localeBox.value,
    setLocale: (l) => {
      localeBox.value = l
    },
  }
  return { deps, session, themeBox, localeBox }
}

describe('createCommandHandlers', () => {
  it('表形状：恰含 17 个命令键（含 v1.1 setCredentials、v1.2 getApps）；未知名不在表内（由调用方兜 4005）', () => {
    const handlers = createCommandHandlers(makeDeps({ mode: 'workspace' }).deps)
    const names = Object.keys(handlers)
    expect(names).toHaveLength(17)
    expect(new Set(names)).toEqual(
      new Set([
        'navigate', 'openFile', 'closeTab', 'getTabs', 'select', 'createFolder',
        'uploadFiles', 'download', 'rename', 'remove', 'registerApp',
        'setTheme', 'setLocale', 'getInfo', 'destroy', 'setCredentials', 'getApps',
      ]),
    )
    expect(handlers['formatDisk' as CommandName]).toBeUndefined()
  })

  it('单文件模式：工作台命令一律 4305 UNSUPPORTED_MODE（uploadFiles 例外=内存通道放行，bucket 由 overrides 拒 4305）', () => {
    const handlers = createCommandHandlers(makeDeps({ mode: 'file' }).deps)
    const gated: CommandName[] = [
      'navigate', 'openFile', 'closeTab', 'getTabs', 'select', 'createFolder',
      'download', 'rename', 'remove',
    ]
    for (const name of gated) {
      expect(codeOf(() => handlers[name](undefined))).toBe(4305)
    }
  })

  it('单文件模式：uploadFiles 放行（FILE_MODE_ALLOWED），实现由装配层 overrides 提供（memory 通路）', () => {
    const memPut = vi.fn((f: File) => ({ key: 'mem://1', name: (f as File).name, size: (f as File).size, mime: 'image/png', blob: f }))
    const notify = vi.fn()
    const { deps } = makeDeps({ mode: 'file' })
    deps.overrides = {
      uploadFiles: (payload) => {
        const files = (payload as { files: File[] }).files
        const accepted = files.map((f) => { const e = memPut(f); notify(e); return { key: e.key, name: e.name, size: e.size } })
        return { accepted, rejected: [], memory: true }
      },
    }
    const handlers = createCommandHandlers(deps)
    const reply = handlers.uploadFiles({ files: [new File(['x'], 'm.png', { type: 'image/png' })], target: 'memory' }) as { memory: boolean }
    expect(reply.memory).toBe(true)
    expect(memPut).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('单文件模式：子集放行（setTheme/setLocale/getInfo/destroy + uploadFiles/getApps/registerApp 内存文件通道）', () => {
    const { deps } = makeDeps({ mode: 'file' })
    const handlers = createCommandHandlers(deps)
    expect(handlers.setTheme({ theme: 'dark' })).toEqual({})
    expect(deps.getTheme()).toBe('dark')
    expect(handlers.setLocale({ locale: 'en-US' })).toEqual({})
    expect(handlers.getInfo({})).toMatchObject({ sdkVersion: SDK_VERSION })
    expect(handlers.destroy({})).toEqual({})
  })

  it('工作台模式：tree 类命令桩 → 4301 FEATURE_DISABLED（M1 接管），getTabs 空集实做', () => {
    const handlers = createCommandHandlers(makeDeps({ mode: 'workspace' }).deps)
    expect(codeOf(() => handlers.navigate({ path: '/' }))).toBe(4301)
    expect(codeOf(() => handlers.openFile({ path: '/a.txt' }))).toBe(4301)
    expect(codeOf(() => handlers.registerApp({ url: 'https://p.example.com/x.js' }))).toBe(4301)
    expect(handlers.getTabs({})).toEqual({ tabs: [] })
  })

  it('会话已终态：任何命令（含 destroy/getInfo/setTheme）→ 5000 SESSION_EXPIRED', () => {
    const handlers = createCommandHandlers(makeDeps({ mode: 'workspace', expired: true }).deps)
    expect(codeOf(() => handlers.getInfo({}))).toBe(5000)
    expect(codeOf(() => handlers.destroy({}))).toBe(5000)
    expect(codeOf(() => handlers.setTheme({ theme: 'light' }))).toBe(5000)
    expect(codeOf(() => handlers.navigate({ path: '/' }))).toBe(5000)
  })

  it('getInfo：expiresInSec=ceil(remainingMs/1000)，sdkVersion/features 透传', () => {
    const { deps } = makeDeps({ mode: 'workspace', remainingMs: 12_345 })
    const handlers = createCommandHandlers(deps)
    const reply = handlers.getInfo({}) as GetInfoReply
    expect(reply.session.expiresInSec).toBe(13)
    expect(reply.sdkVersion).toBe('0.1.0')
    expect(reply.features).toEqual({ upload: true, delete: false })
  })

  it('destroy：只调 session.destroy 并 reply {}，不 emit（expired 由装配层派发）', () => {
    const { deps, session } = makeDeps({ mode: 'workspace' })
    const handlers = createCommandHandlers(deps)
    expect(handlers.destroy({})).toEqual({})
    expect(session.destroy).toHaveBeenCalledTimes(1)
    expect(deps.emit).not.toHaveBeenCalled()
  })

  it('setTheme/setLocale 写入状态器并回 ack；非法 payload → 4005 BAD_PARAM', () => {
    const { deps } = makeDeps({ mode: 'workspace' })
    const handlers = createCommandHandlers(deps)
    expect(handlers.setTheme({ theme: 'auto' })).toEqual({})
    expect(deps.getTheme()).toBe('auto')
    expect(handlers.setLocale({ locale: 'en-US' })).toEqual({})
    expect(deps.getLocale()).toBe('en-US')
    expect(codeOf(() => handlers.setTheme({ theme: 'blue' }))).toBe(4005)
    expect(codeOf(() => handlers.setLocale('en-US'))).toBe(4005) // payload 非对象
    expect(codeOf(() => handlers.setTheme(undefined))).toBe(4005)
  })

  it('无会话句柄（getSession()=null）：终态门控跳过，expiresInSec=-1（无期限哨兵）', () => {
    const { deps } = makeDeps({ mode: 'workspace', withSession: false })
    const handlers = createCommandHandlers(deps)
    const reply = handlers.getInfo({}) as GetInfoReply
    expect(reply.session.expiresInSec).toBe(-1)
    expect(handlers.destroy({})).toEqual({})
  })

  it('overrides：门控之后替换实现（M1 接缝），且不绕过门控', () => {
    const { deps } = makeDeps({ mode: 'workspace' })
    const navigate = vi.fn(() => ({ path: '/a' }))
    const handlers = createCommandHandlers({ ...deps, overrides: { navigate } })
    expect(handlers.navigate({ path: '/a' })).toEqual({ path: '/a' })
    expect(navigate).toHaveBeenCalledTimes(1)
    // 门控仍在：单文件模式下被 override 的 navigate 仍 4305
    const fileDeps = makeDeps({ mode: 'file' }).deps
    const fileHandlers = createCommandHandlers({ ...fileDeps, overrides: { navigate } })
    expect(codeOf(() => fileHandlers.navigate({ path: '/' }))).toBe(4305)
    // 终态门控仍在
    const expiredDeps = makeDeps({ mode: 'workspace', expired: true }).deps
    const expiredHandlers = createCommandHandlers({ ...expiredDeps, overrides: { navigate } })
    expect(codeOf(() => expiredHandlers.navigate({ path: '/' }))).toBe(5000)
  })
})

describe('setCredentials（v1.1：M1_STUB_NAMES 成员，实现在装配层 overrides）', () => {
  const payload = { credentials: { accessKeyId: 'ak2', accessKeySecret: 'sk2', sessionToken: 'tk2' } }

  it('工作台模式无 override：桩兜 4301 FEATURE_DISABLED（M1/装配层接管前）', () => {
    const handlers = createCommandHandlers(makeDeps({ mode: 'workspace' }).deps)
    expect(codeOf(() => handlers.setCredentials(payload))).toBe(4301)
  })

  it('单文件模式：不在 FILE_MODE_ALLOWED（仅 setTheme/setLocale/getInfo/destroy）→ 4305 UNSUPPORTED_MODE', () => {
    const handlers = createCommandHandlers(makeDeps({ mode: 'file' }).deps)
    expect(codeOf(() => handlers.setCredentials(payload))).toBe(4305)
  })

  it('会话已终态：任何模式 → 5000 SESSION_EXPIRED（终态门先于模式门/桩）', () => {
    const wsHandlers = createCommandHandlers(makeDeps({ mode: 'workspace', expired: true }).deps)
    expect(codeOf(() => wsHandlers.setCredentials(payload))).toBe(5000)
    const fileHandlers = createCommandHandlers(makeDeps({ mode: 'file', expired: true }).deps)
    expect(codeOf(() => fileHandlers.setCredentials(payload))).toBe(5000)
  })

  it('override 接管：门控后原样透传 payload（handlers 层不校验凭证形状，校验在 override）', () => {
    const { deps } = makeDeps({ mode: 'workspace' })
    const setCredentials = vi.fn(() => ({ expiresInSec: 300 }))
    const handlers = createCommandHandlers({ ...deps, overrides: { setCredentials } })
    const garbage = { credentials: null } // 非法形状不 4005：拒绝职责在 override
    expect(handlers.setCredentials(garbage)).toEqual({ expiresInSec: 300 })
    expect(setCredentials).toHaveBeenCalledTimes(1)
    expect(setCredentials).toHaveBeenCalledWith(garbage)
  })
})
