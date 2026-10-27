/**
 * profiles——本地连接模式 · 多 Profile 存储（Lane G5）
 * 契约：开发决策档案（test-report/PROGRESS-2026-10-10-archived.md）Wave G / G5「profiles(localStorage)+连接表单+测试连接；
 * 写入 mmagic.config.raw 备份→reload 走既有恢复链，不暴露 URL」。
 *
 * ⚠️ 明文存储风险定位（选型是显式的，不是疏漏）：
 * - Profile（含 secretAccessKey）以 **JSON 明文**落 localStorage（键 PROFILES_STORAGE_KEY）。
 *   动机：本地连接模式面向**个人设备**的一次配置长期复用（sessionStorage 随页签即焚，
 *   做不了「下次打开免输入」）；明文是 localStorage 的本性，无密钥可用的前端做不了真加密。
 * - 因此仅限个人设备使用——向导表单底部常驻 wizard.plaintext-warn 警示条；
 *   **企业嵌入一律走宿主 #config 注入（STS scoped 凭据 + sessionStorage 备份），不走此路径**
 *   （见《docs/operations/user-guide.md》§四「凭证必须是 STS scoped 临时凭证」与 config.ts §4.2 禁 localStorage 持态）。
 * - 与凭证备份的边界：连接动作产生的 #config 原始片段走 config.ts 的 sessionStorage 备份
 *   （带 exp 到期、会话终态即清），**不进 localStorage**——两套存储职责分离。
 *
 * 纯函数口径：list/save/update/remove 的存储均可注入（测试用内存 stub；null=显式无存储静默降级），
 * 生产缺省 window.localStorage；读写静默容错（quota/隐私模式降级为「不持久」，内存态照常工作）。
 */
import { CONFIG_VERSION, TTL_HARD_CAP_SEC } from '@/sdk/constants'
import type { BackendConfig, WorkspaceConfig } from '@/sdk/types'

// ───────────────────────── 常量 ─────────────────────────

/** localStorage 键（明文存储；风险定位见文件头注释） */
export const PROFILES_STORAGE_KEY = 'mmagic.profiles'

/** 容量上限：超出拒存（防 localStorage 膨胀与侧栏不可读；超出抛错由调用方提示） */
export const PROFILES_MAX = 10

/** 会话时长表单默认档（分钟）。3600 分钟超 24h 硬帽 → ttlSeconds 截断 TTL_HARD_CAP_SEC */
export const DEFAULT_TTL_MINUTES = 3600

/**
 * 校验垫片（三审修复后已收敛为 ''）：config.ts validateWorkspace 已放开空 sessionToken
 * （本地 AK/SK 模式无 STS；sigv4 对空值不发 x-amz-security-token 头——原假 token 垫片会令
 * reload 后每请求携带伪造头，严格校验端点 403「测试成功、连接后全挂」）。常量保留导出
 * 是为兼容既有测试引用；值收敛为真实语义 ''。
 */
export const LOCAL_SESSION_TOKEN = ''

/**
 * 校验垫片（三审修复后已收敛为 ''）：config.ts 已放开空 prefix（''=bucket 根为会话域）。
 * 原 '/' 垫片运行时断裂：normalizePrefix('/') 不归空 → list('/') 查不到对象、
 * joinKey('/','a')='/a' 带前导斜杠——空前缀 Profile「测试成功、连接后树空」。
 * buildWorkspaceConfig 另做 '/'→'' 归一化（防用户手输 '/' 复现同一断裂）。
 */
export const LOCAL_ROOT_PREFIX = ''

// ───────────────────────── 类型 ─────────────────────────

/** 连接 Profile（本文件仅做存储与校验；明文风险见文件头） */
export interface S3Profile {
  /** 唯一 id（createProfile 生成；crypto.randomUUID，受限环境回退时间+随机） */
  id: string
  /** 展示名（侧栏/选用） */
  name: string
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** 会话目录域（可空=bucket 根；构造 config 时空值走 LOCAL_ROOT_PREFIX 垫片） */
  prefix?: string
  /** path-style 寻址偏好；现客户端仅 path-style（S3SigV4Client 拼 endpoint/bucket/key），
   *  该字段作为向后兼容元数据随配置保留（parseAppConfig 未知键原样保留） */
  pathStyle?: boolean
  /** 创建时刻（epoch ms；更新不改） */
  createdAt: number
}

/** 新建入参（id/createdAt 由 createProfile 填充） */
export type ProfileInput = Omit<S3Profile, 'id' | 'createdAt'>

export interface ProfilesStoreOptions {
  /** 注入存储（测试用）；undefined=缺省 window.localStorage；null=显式无存储（静默 no-op） */
  storage?: Storage | null
}

export interface ConnectOptions {
  /** 允许域（=本页 origin：本地连接无宿主通道，allowedOrigins 取自身即可） */
  origin: string
  /** 会话时长（分钟）；缺省 DEFAULT_TTL_MINUTES；换算秒后截断 TTL_HARD_CAP_SEC */
  ttlMinutes?: number
}

// ───────────────────────── 存储底座 ─────────────────────────

/** 解析注入存储：undefined → 缺省 window.localStorage；null → 显式无存储（no-op） */
function resolveStorage(storage: Storage | null | undefined): Storage | null {
  return storage !== undefined ? storage : defaultProfilesStorage()
}

/** 缺省存储：window.localStorage（访问即抛的受限环境返回 null，走静默降级） */
export function defaultProfilesStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? (window.localStorage ?? null) : null
  } catch {
    return null
  }
}

/** 读全部：缺失/空 → []；损坏 JSON → 清键重建 []；数组内非法条目过滤（防脏数据外溢） */
function readProfiles(storage: Storage | null): S3Profile[] {
  if (!storage) return []
  let text: string | null
  try {
    text = storage.getItem(PROFILES_STORAGE_KEY)
  } catch {
    return [] // 读取即抛（隐私模式）：按空库处理
  }
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    clearProfiles(storage) // 损坏：清空重置（明文库无抢救价值）
    return []
  }
  if (!Array.isArray(parsed)) {
    clearProfiles(storage)
    return []
  }
  return parsed.filter((p): p is S3Profile => validateProfile(p).length === 0)
}

/** 写全部：静默容错（quota/禁写降级为不持久，调用方内存态照常） */
function writeProfiles(storage: Storage | null, profiles: S3Profile[]): void {
  if (!storage) return
  try {
    storage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles))
  } catch {
    // 静默：不持久化不影响本会话内存态
  }
}

function clearProfiles(storage: Storage | null): void {
  if (!storage) return
  try {
    storage.removeItem(PROFILES_STORAGE_KEY)
  } catch {
    // 静默
  }
}

// ───────────────────────── 校验 / 工厂 ─────────────────────────

/** 非空字符串判定（纯空白视为空；与 config.ts isNonEmptyString 同口径） */
function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * schema 校验：必填六字段（name/endpoint/region/bucket/accessKeyId/secretAccessKey）+
 * endpoint 须为合法 http(s) URL + 可选字段类型。返回问题清单（空=通过），风格对齐
 * config.ts 的 problems[] 口径（逐条可读、可直接拼给用户）。
 */
export function validateProfile(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['profile 须为对象']
  const p = value as Record<string, unknown>

  const problems: string[] = []
  for (const key of ['name', 'endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const) {
    if (!isNonEmptyString(p[key])) problems.push(`缺 ${key}`)
  }
  if (problems.length > 0) return problems // 必填缺失先行（endpoint 的 URL 校验无从做起）

  let url: URL
  try {
    url = new URL(p.endpoint as string) // 必填闸后 endpoint 必为 string
  } catch {
    return [...problems, 'endpoint 非法：须为合法 URL']
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') problems.push('endpoint 非法：仅支持 http(s)')

  if (p.prefix !== undefined && typeof p.prefix !== 'string') problems.push('prefix 须为字符串')
  if (p.pathStyle !== undefined && typeof p.pathStyle !== 'boolean') problems.push('pathStyle 须为布尔')
  if (p.id !== undefined && typeof p.id !== 'string') problems.push('id 须为字符串')
  if (p.createdAt !== undefined && typeof p.createdAt !== 'number') problems.push('createdAt 须为数字')
  return problems // 未知键不报错、原样保留（向前兼容，与配置解析同纪律）
}

/** 生成唯一 id：crypto.randomUUID 优先，受限环境回退时间+随机段 */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // 回退到下方拼装
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 工厂：填 id/createdAt、字段 trim；空 prefix 不落字段；pathStyle 仅 true 落字段 */
export function createProfile(input: ProfileInput): S3Profile {
  const profile: S3Profile = {
    id: newId(),
    name: input.name.trim(),
    endpoint: input.endpoint.trim(),
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKey: input.secretAccessKey,
    createdAt: Date.now(),
  }
  const prefix = input.prefix?.trim()
  if (prefix) profile.prefix = prefix
  if (input.pathStyle) profile.pathStyle = true
  return profile
}

// ───────────────────────── CRUD（存储可注入的纯函数） ─────────────────────────

/** 列出全部（顺序=保存顺序；静默容错见 readProfiles） */
export function listProfiles(opts: ProfilesStoreOptions = {}): S3Profile[] {
  return readProfiles(resolveStorage(opts.storage))
}

/**
 * 新增或按 id 覆写：非法抛错（消息含问题清单）；新增时已满 PROFILES_MAX 拒（注释见常量）。
 * 返回落盘后的新列表（内存态以返回值为准——存储降级时也能继续工作）。
 */
export function saveProfile(profile: S3Profile, opts: ProfilesStoreOptions = {}): S3Profile[] {
  const problems = validateProfile(profile)
  if (problems.length > 0) throw new Error(`profile 校验失败：${problems.join('；')}`)
  const storage = resolveStorage(opts.storage)
  const list = readProfiles(storage)
  const exists = list.some((p) => p.id === profile.id)
  if (!exists && list.length >= PROFILES_MAX) {
    // 容量硬上限：只拦新增不拦更新——满员改名/换密钥合法，第 11 份必须先删
    throw new Error(`profile 数已达上限 ${PROFILES_MAX}，请先删除后再保存`)
  }
  const next = exists ? list.map((p) => (p.id === profile.id ? profile : p)) : [...list, profile]
  writeProfiles(storage, next)
  return next
}

/**
 * 按 id 局部更新（id/createdAt 不可改）：不存在 → null；合并结果非法 → 抛错且不落盘。
 * 返回落盘后的新列表。
 */
export function updateProfile(
  id: string,
  patch: Partial<Omit<S3Profile, 'id' | 'createdAt'>>,
  opts: ProfilesStoreOptions = {},
): S3Profile[] | null {
  const storage = resolveStorage(opts.storage)
  const list = readProfiles(storage)
  if (!list.some((p) => p.id === id)) return null
  const next = list.map((p) => (p.id === id ? { ...p, ...patch, id: p.id, createdAt: p.createdAt } : p))
  const merged = next.find((p) => p.id === id)
  const problems = validateProfile(merged)
  if (problems.length > 0) throw new Error(`profile 校验失败：${problems.join('；')}`)
  writeProfiles(storage, next)
  return next
}

/** 按 id 删除（不存在=无操作）；返回落盘后的新列表 */
export function removeProfile(id: string, opts: ProfilesStoreOptions = {}): S3Profile[] {
  const storage = resolveStorage(opts.storage)
  const next = readProfiles(storage).filter((p) => p.id !== id)
  writeProfiles(storage, next)
  return next
}

// ───────────────────────── 连接配置构造 ─────────────────────────

/**
 * ttl 分钟 → 秒并截断硬帽：分钟钳到 ≥1（0/负数/NaN 回退缺省档语义由调用方决定，
 * 这里统一按 ≥1 分钟最小会话处理），秒截 TTL_HARD_CAP_SEC（86400）。
 */
export function resolveTtlSeconds(ttlMinutes: number | undefined): number {
  const minutes =
    ttlMinutes !== undefined && Number.isFinite(ttlMinutes) ? Math.max(1, Math.floor(ttlMinutes)) : DEFAULT_TTL_MINUTES
  return Math.min(minutes * 60, TTL_HARD_CAP_SEC)
}

/**
 * Profile → WorkspaceConfig（#config JSON 的对象形态）。
 * - v:1 / mode:'workspace'（CONFIG_VERSION 单一口径）；
 * - credentials：secretAccessKey 换名 accessKeySecret；sessionToken 走 LOCAL_SESSION_TOKEN 垫片
 *   （注释见常量；测试连接路径不用垫片——直接空串，sigv4 即不发 security-token 头）；
 * - prefix：空值走 LOCAL_ROOT_PREFIX 垫片；
 * - ttlSeconds：resolveTtlSeconds 截断；
 * - security.allowedOrigins=[origin]（本页自身——本地模式无宿主，boot 对 standalone 通道本就 best-effort）；
 * - pathStyle=true 时随 backend 保留（parseAppConfig 未知键原样保留，向前兼容虚拟 host-style 支持）。
 */
export function buildWorkspaceConfig(profile: S3Profile, opts: ConnectOptions): WorkspaceConfig {
  // prefix 归一化：空/纯 '/' → ''（bucket 根）。'/' 不归一会运行时断裂（list('/' ) 恒空、
  // joinKey 产出带前导斜杠的 key）——三审修复②的配套防线（防用户手输 '/'）。
  const trimmedPrefix = profile.prefix?.trim() ?? ''
  const prefix = trimmedPrefix === '/' || trimmedPrefix === '' ? LOCAL_ROOT_PREFIX : trimmedPrefix
  const backend = {
    endpoint: profile.endpoint,
    region: profile.region,
    bucket: profile.bucket,
    prefix,
    credentials: {
      accessKeyId: profile.accessKeyId,
      accessKeySecret: profile.secretAccessKey,
      sessionToken: LOCAL_SESSION_TOKEN,
    },
    ttlSeconds: resolveTtlSeconds(opts.ttlMinutes),
    ...(profile.pathStyle ? { pathStyle: true } : {}),
  } as BackendConfig // pathStyle 为向前兼容的保留键（类型暂未收编，见注释）
  return {
    mode: 'workspace',
    v: CONFIG_VERSION,
    backend,
    security: { allowedOrigins: [opts.origin] },
  }
}
