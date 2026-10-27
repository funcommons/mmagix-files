/**
 * URL fragment 配置解析（#config / #file）
 * 契约：《docs/design/solution-design.md》V1.2 §4.1 / §4.1b、《docs/operations/user-guide.md》V1.0 §一
 *
 * - 配置 JSON 走 fragment（#config={...} / #file={...}）：不到服务端/代理日志；
 *   解析完成后由 scrubFragment() 抹除（§4.1 建议 history.replaceState）
 * - 两键互斥、二选一；mode 字段可省略——按键名推断（config=→workspace、file=→file）
 * - 校验原则：必填缺项/格式错 → SdkError(4001 BAD_CONFIG)，detail 指明缺失段；
 *   任意未知键不报错、原样保留（只增不删纪律，向前兼容）
 */
import { CONFIG_VERSION } from './constants'
import { ERROR_CODES, SdkError } from './errorCodes'
import type { AppConfig, SessionMode } from './types'

/** fragment 上的合法配置键 → 模式推断 */
const KEY_MODE: Record<string, SessionMode> = { config: 'workspace', file: 'file' }

/** 非空字符串判定（纯空白视为空） */
function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 解析 URL fragment 配置。
 * @param hash 形如 `#config=<uriencoded>`；缺省取 window.location.hash
 * @returns 校验通过并注入 mode 的 AppConfig
 * @throws SdkError(4001 BAD_CONFIG)——detail 为 string[]，逐条指明问题/缺失段
 */
export function parseAppConfig(hash: string = window.location.hash): AppConfig {
  // 1. 定位配置键（两键互斥；其余键一律忽略）
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const found: Array<{ mode: SessionMode; value: string }> = []
  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const mode = KEY_MODE[key]
    if (!mode) continue // 未知键忽略（只增不删）
    found.push({ mode, value: eq === -1 ? '' : part.slice(eq + 1) })
  }
  if (found.length === 0) {
    throw new SdkError(ERROR_CODES.BAD_CONFIG, 'URL fragment 缺配置', ['URL fragment 缺 config/file 配置键'])
  }
  if (found.length > 1) {
    throw new SdkError(ERROR_CODES.BAD_CONFIG, 'URL fragment 配置冲突', ['#config 与 #file 互斥，二选一'])
  }
  const { mode: inferredMode, value } = found[0]!
  if (!value) {
    throw new SdkError(ERROR_CODES.BAD_CONFIG, 'URL fragment 配置为空', ['config/file 键缺配置内容'])
  }

  // 2. decodeURIComponent + JSON.parse（注意：不可用 URLSearchParams——它把 '+' 解成空格，
  //    会破坏 JSON 字符串值里的字面 '+'；encodeURIComponent 产物统一用 decodeURIComponent 还原）
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(value))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const why = err instanceof URIError ? `decodeURIComponent 失败: ${reason}` : `JSON 解析失败: ${reason}`
    throw new SdkError(ERROR_CODES.BAD_CONFIG, '配置解析失败', [why])
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SdkError(ERROR_CODES.BAD_CONFIG, '配置解析失败', ['配置 JSON 须为对象'])
  }
  const cfg = parsed as Record<string, unknown>

  // 3. 版本闸（独立口径：constants.CONFIG_VERSION）
  if (cfg.v !== CONFIG_VERSION) {
    throw new SdkError(ERROR_CODES.BAD_CONFIG, '配置版本不支持', [
      `v 版本不支持: ${JSON.stringify(cfg.v)}（当前支持 ${CONFIG_VERSION}）`,
    ])
  }

  // 4. 显式 mode 与键名推断冲突即拒（两套 shape 校验依赖 mode 定向）
  const problems: string[] = []
  if (cfg.mode !== undefined && cfg.mode !== inferredMode) {
    problems.push(`mode 与 URL 键冲突: ${JSON.stringify(cfg.mode)} ≠ ${inferredMode}`)
  }

  // 5. 分模式 shape 校验
  if (inferredMode === 'workspace') validateWorkspace(cfg, problems)
  else validateFile(cfg, problems)

  if (problems.length > 0) {
    throw new SdkError(ERROR_CODES.BAD_CONFIG, '配置校验失败', problems)
  }
  // 注入 mode（显式给出且一致时等价保留）；未知键经 spread 原样保留
  return { ...cfg, mode: inferredMode } as AppConfig
}

/** workspace 模式校验：backend 四要素 + credentials 三要素 + allowedOrigins + ttlSeconds(可选正数) */
function validateWorkspace(cfg: Record<string, unknown>, problems: string[]): void {
  const backend = cfg.backend
  if (typeof backend !== 'object' || backend === null) {
    problems.push('缺 backend')
    return // backend 缺失时其子段无从校验
  }
  const b = backend as Record<string, unknown>
  for (const key of ['endpoint', 'region', 'bucket'] as const) {
    if (!isNonEmptyString(b[key])) problems.push(`缺 backend.${key}`)
  }
  // prefix（三审修复：放开空值）——''=bucket 根为会话域（本地连接模式合法形态）。
  // 原非空强校验迫使 ConnectWizard 垫字面 '/'，运行时 list('/')/joinKey('/') 断裂
  // （空前缀 Profile「测试成功、连接后树空」）。手册「prefix=会话目录域」口径不回，
  // 空域语义与垫片收敛注释见 files/profiles.ts；手册字段表回写候 B 批。
  if (typeof b.prefix !== 'string') problems.push('缺 backend.prefix')

  const credentials = b.credentials
  if (typeof credentials !== 'object' || credentials === null) {
    problems.push('缺 backend.credentials')
  } else {
    const c = credentials as Record<string, unknown>
    // sessionToken（三审修复：放开空串）——本地长期 AK/SK 模式无 STS；sigv4 对空值
    // 不发 x-amz-security-token 头（语义就绪）。原非空强校验迫使向导垫假 token，
    // reload 后每请求携带伪造头，严格校验端点（AWS/OSS）403——「测试成功、连接后全挂」。
    // 手册「STS 三要素缺一不可」口径针对宿主嵌入模式，本地模式例外回写候 B 批。
    for (const key of ['accessKeyId', 'accessKeySecret'] as const) {
      if (!isNonEmptyString(c[key])) problems.push(`缺 backend.credentials.${key}`)
    }
    if (typeof c.sessionToken !== 'string') problems.push('缺 backend.credentials.sessionToken')
  }

  // ttlSeconds 可选；提供时须为正数（0/负数/非数字均拒）
  if (b.ttlSeconds !== undefined && (typeof b.ttlSeconds !== 'number' || !(b.ttlSeconds > 0))) {
    problems.push('backend.ttlSeconds 须为正数')
  }

  const security = cfg.security as { allowedOrigins?: unknown } | undefined | null
  const origins = typeof security === 'object' && security !== null ? security.allowedOrigins : undefined
  if (
    !Array.isArray(origins) ||
    origins.length === 0 ||
    !origins.every((s) => isNonEmptyString(s))
  ) {
    problems.push('缺 security.allowedOrigins（须为非空字符串数组）')
  }
}

/** file 模式校验：source.url 必填（v1.2 起允许空串=无源装载） + method 枚举 + save(可选) method 枚举/url 必填 */
function validateFile(cfg: Record<string, unknown>, problems: string[]): void {
  const source = cfg.source
  if (typeof source !== 'object' || source === null) {
    problems.push('缺 source')
    return
  }
  const s = source as Record<string, unknown>
  // v1.2「无源装载」：url='' 合法——容器模式（boot 不自动打开源文件，仅 uploadFiles 内存通道）；
  // url 缺失/非字符串仍是结构错误。无源时 save 段无回写目标意义，仍按显式配置校验不特殊放行
  if (typeof s.url !== 'string') problems.push('缺 source.url')
  if (s.method !== undefined && s.method !== 'GET' && s.method !== 'POST') {
    problems.push(`source.method 非法: ${JSON.stringify(s.method)}（仅 GET|POST）`)
  }

  const save = cfg.save
  if (save === undefined) return // 只读形态：无 save 段合法
  if (typeof save !== 'object' || save === null) {
    problems.push('save 须为对象')
    return
  }
  const sv = save as Record<string, unknown>
  if (sv.method !== undefined && sv.method !== 'PUT' && sv.method !== 'POST') {
    problems.push(`save.method 非法: ${JSON.stringify(sv.method)}（仅 PUT|POST）`)
  }
  if (!isNonEmptyString(sv.url)) problems.push('缺 save.url')
}

/**
 * 构建配置摘要（ready 事件 configSummary 用）。
 * 硬约束：绝不含凭证（backend.credentials 整段不进摘要）——只取展示/诊断字段。
 */
export function buildConfigSummary(cfg: AppConfig): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    mode: cfg.mode,
    v: cfg.v,
    brand: cfg.appearance?.brand?.name,
    theme: cfg.appearance?.theme,
    locale: cfg.appearance?.locale,
    // features 只取键列表（不泄露布尔配置细节也无妨，键名足够诊断）
    features: cfg.features ? Object.keys(cfg.features) : [],
  }
  if (cfg.mode === 'workspace') {
    summary.prefix = cfg.backend.prefix
    summary.plugins = cfg.plugins?.length ?? 0
  }
  return summary
}

/**
 * 抹除 location.hash（§4.1：配置解析完成后建议 history.replaceState 抹除 fragment，
 * 防配置随完整 URL 进浏览器历史/地址栏）。受限环境（沙箱 iframe 等）静默忽略。
 */
export function scrubFragment(): void {
  try {
    const { pathname, search } = window.location
    window.history.replaceState(window.history.state, '', pathname + search)
  } catch {
    // 静默：抹除失败不影响主流程
  }
}

// ───────────────────────── 原始 fragment 的 sessionStorage 备份 ─────────────────────────
//
// 手册承诺「页面刷新=从 URL 重建」，而 scrubFragment 抹掉了 fragment——刷新后 URL 已无配置。
// 本组函数把原始 fragment（#config=… / #file=… 整段）备份进 sessionStorage 作补偿：刷新后
// boot 读备份走同一 parseAppConfig 路径重建会话（不回写 URL）。
//
// 安全取舍（§4.2「前端持态 sessionStorage/内存，禁 localStorage」）：
// - sessionStorage 同源隔离、随页签关闭即焚——不随 URL/历史/Referer/服务端日志外泄；
// - 记录带 exp 到期戳（=now+min(ttl,24h)，与 TTL_HARD_CAP_SEC 同口径），到期读取即清；
// - 会话终态（expired 事件 / destroy 命令）即清——到期会话不可借刷新续命；
// - 读写全部静默容错：隐私模式/quota/受限环境降级为「无备份」，主流程（URL 解析）不受影响。

/** sessionStorage 备份键（boot 清理与测试用） */
export const RAW_CONFIG_STORAGE_KEY = 'mmagic.config.raw'

/** 备份寿命硬帽：24h（与 TTL_HARD_CAP_SEC 同口径；无 TTL 配置时的缺省寿命） */
const RAW_CONFIG_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 备份记录形状（JSON 序列化落盘） */
interface RawConfigRecord {
  raw: string
  /** 到期时刻（epoch ms） */
  exp: number
}

export interface RawConfigStoreOptions {
  /** 注入存储（测试用）；undefined=缺省 window.sessionStorage；null=显式无存储（全部静默 no-op，如受限环境） */
  storage?: Storage | null
}

/** 解析注入存储：undefined → 缺省 window.sessionStorage；null → 显式无存储（no-op） */
function resolveStorage(storage: Storage | null | undefined): Storage | null {
  return storage !== undefined ? storage : defaultRawConfigStorage()
}

/** URL fragment 是否带 config/file 配置键（boot 判断「URL 有配置」还是「读 sessionStorage 备份」） */
export function fragmentHasConfigKey(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  return raw.split('&').some((part) => {
    if (!part) return false
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    return key === 'config' || key === 'file' // 与 KEY_MODE 同源；字面比较防原型键误判
  })
}

/** 解析成功后备份原始 fragment（ttlSeconds=前端自毁时长，秒；缺省=24h） */
export function persistRawConfig(
  fragment: string,
  opts: RawConfigStoreOptions & { ttlSeconds?: number; now?: number } = {},
): void {
  const storage = resolveStorage(opts.storage)
  if (!storage) return
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlSeconds !== undefined ? opts.ttlSeconds * 1000 : RAW_CONFIG_MAX_AGE_MS
  const record: RawConfigRecord = { raw: fragment, exp: now + Math.min(ttlMs, RAW_CONFIG_MAX_AGE_MS) }
  try {
    storage.setItem(RAW_CONFIG_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // 静默：quota/禁写环境降级为无备份（刷新退回「URL 重建」原路径）
  }
}

/**
 * 读备份：有效→返回原始 fragment；缺失/过期/损坏→清除记录并返回 null（调用方按无配置处理）。
 * 过期判定用读侧 now（默认 Date.now()），不信任落盘时刻。
 */
export function restoreRawConfig(opts: RawConfigStoreOptions & { now?: number } = {}): string | null {
  const storage = resolveStorage(opts.storage)
  if (!storage) return null
  let text: string | null
  try {
    text = storage.getItem(RAW_CONFIG_STORAGE_KEY)
  } catch {
    return null // 读取即抛（隐私模式）：视为无备份
  }
  if (text === null) return null
  let record: RawConfigRecord
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as RawConfigRecord).raw !== 'string' ||
      typeof (parsed as RawConfigRecord).exp !== 'number'
    ) {
      throw new Error('形状不符')
    }
    record = parsed as RawConfigRecord
  } catch {
    clearRawConfig({ storage }) // 损坏：清除并按无备份处理
    return null
  }
  if ((opts.now ?? Date.now()) >= record.exp) {
    clearRawConfig({ storage }) // 过期：清除（到期会话不可借刷新续命）
    return null
  }
  return record.raw
}

/** 清除备份（expired 事件 / destroy 命令路径调用；无记录时静默） */
export function clearRawConfig(opts: RawConfigStoreOptions = {}): void {
  const storage = resolveStorage(opts.storage)
  if (!storage) return
  try {
    storage.removeItem(RAW_CONFIG_STORAGE_KEY)
  } catch {
    // 静默：清除失败不影响主流程
  }
}

/** 缺省存储：window.sessionStorage（访问即抛的受限环境返回 null） */
function defaultRawConfigStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? (window.sessionStorage ?? null) : null
  } catch {
    return null
  }
}
