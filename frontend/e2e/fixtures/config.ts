/**
 * #config / #file fragment 构造（契约《../../../docs/design/jsdk-api.md》§4.1/§4.1b）
 * backend 指向假端点 https://s3.mock.local（由 s3-mock.ts 拦截应答）。
 */

export const HOST_ORIGIN = 'http://localhost:5199'

export const MOCK_ENDPOINT = 'https://s3.mock.local'
export const MOCK_BUCKET = 'mock-bucket'
export const MOCK_PREFIX = 'sessions/test/'

export const MOCK_CREDENTIALS = {
  accessKeyId: 'AKIDMOCKEXAMPLE',
  accessKeySecret: 'mock-secret-key',
  sessionToken: 'mock-session-token',
}

/** 深合并（plain object；数组/原始值直接覆盖） */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (typeof base === 'object' && base !== null && !Array.isArray(base) &&
      typeof patch === 'object' && patch !== null && !Array.isArray(patch)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v)
    }
    return out as T
  }
  return patch as T
}

export type WorkspaceConfig = Record<string, unknown>

/** workspace 模式基线配置（ttl 1h；允许任意深度 override） */
export function workspaceConfig(overrides: WorkspaceConfig = {}): WorkspaceConfig {
  const base: WorkspaceConfig = {
    mode: 'workspace',
    v: 1,
    backend: {
      endpoint: MOCK_ENDPOINT,
      region: 'us-mock-1',
      bucket: MOCK_BUCKET,
      prefix: MOCK_PREFIX,
      credentials: { ...MOCK_CREDENTIALS },
      ttlSeconds: 3600,
    },
    security: { allowedOrigins: [HOST_ORIGIN] },
    appearance: { theme: 'light', locale: 'zh-CN' },
  }
  return deepMerge(base, overrides)
}

/** 单文件模式配置（只读=无 save） */
export function singleFileConfig(
  sourceUrl: string,
  overrides: WorkspaceConfig = {},
): WorkspaceConfig {
  const base: WorkspaceConfig = {
    v: 1,
    source: { url: sourceUrl, method: 'GET' },
    name: 'README.md',
    appearance: { theme: 'light', locale: 'zh-CN' },
  }
  return deepMerge(base, overrides)
}

/** workspace 直开 URL（顶层导航，无宿主） */
export function configUrl(cfg: WorkspaceConfig): string {
  return '/#config=' + encodeURIComponent(JSON.stringify(cfg))
}

/** 单文件直开 URL */
export function fileUrl(cfg: WorkspaceConfig): string {
  return '/#file=' + encodeURIComponent(JSON.stringify(cfg))
}

/** 宿主 harness URL：host.html 内嵌 iframe 加载应用（捕获 bus 事件） */
export function hostConfigUrl(cfg: WorkspaceConfig): string {
  return '/e2e/host.html?config=' + encodeURIComponent(JSON.stringify(cfg))
}

export function hostFileUrl(cfg: WorkspaceConfig): string {
  return '/e2e/host.html?file=' + encodeURIComponent(JSON.stringify(cfg))
}
