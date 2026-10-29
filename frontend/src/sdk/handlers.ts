/**
 * 16 命令 handler 表（契约《docs/design/jsdk-api.md》§三/§四/§五/§七；setCredentials=v1.1 增补）
 *
 * 门控次序（每命令统一先过两道门，再进实现，overrides 不例外）：
 *   ① 终态门控：会话已终态 → 5000 SESSION_EXPIRED（任何命令，含 destroy——契约 §七「终态后任何 cmd」）；
 *   ② 模式门控：config.mode==='file'（单文件）时仅 setTheme/setLocale/getInfo/destroy 可用（契约 §四
 *      命令子集），其余一律 4305 UNSUPPORTED_MODE；config.mode==='workspace' 时 tree/IO 类命令本期为桩
 *      → 4301 FEATURE_DISABLED（M1 接管；getTabs 例外=空集实做）。
 *
 * 边界与交接说明：
 * - **未知名不在本表兜**：返回表按 CommandName 穷举 15 键；表查不到的 name 由调用方（装配层/bus）
 *   回 4005 BAD_PARAM（契约 §五注④：未知命令属参数非法）。此文件只保证表内 15 键闭合。
 * - destroy 只调 session.destroy() 并 reply {}；`expired` 事件由装配层统一派发（契约 §三：先 ack 后 evt）。
 * - getConfig()=null（配置未就绪）时门控放行——ready 前命令的排队/拒绝是 bus（A1）职责，非此处。
 * - 依赖全部注入 + 结构类型：不 import bus/config/credentials（A1/A2 并行落地中）。
 * - getConfig/getSession/getTheme… 均为读写器函数而非裸值：单文件模式无 backend、工作台模式状态
 *   由装配层持有，handler 层零状态（除门控判定外不缓存），避免并行装配时的双写漂移。
 */

import { ERROR_CODES, SdkError } from './errorCodes'
import type {
  AppConfig,
  CommandName,
  EventName,
  GetInfoReply,
  SetLocalePayload,
  SetThemePayload,
  TabInfo,
} from './types'

/** SDK 版本（getInfo 回报；与 package.json version 对齐） */
export const SDK_VERSION = '0.1.0'

/** 会话句柄（SessionController 的结构子集；装配层可直接传控制器实例） */
export interface SessionHandle {
  remainingMs(): number
  isExpired(): boolean
  destroy(): void
  /** v1.1：setCredentials 重置自毁线（可选——句柄缺省时不重置） */
  extend?(opts: { ttlSeconds?: number; expiresAt?: number }): void
}

/** 单命令实现：payload 进、reply 出（可异步；装配层统一 await 后转 reply 信封） */
export type CommandHandler = (payload: unknown) => unknown | Promise<unknown>

export interface HandlerDeps {
  /** 当前配置读写器（null=配置未就绪，模式门控放行，见文件头注） */
  getConfig(): AppConfig | null
  /** 会话句柄读写器（null=无会话执法对象，终态门控跳过；如无 TTL 场景） */
  getSession(): SessionHandle | null
  /** 事件出口（本期 15 命令均不直接 emit——expired 由装配层派发；M1+ 业务事件接缝） */
  emit(evt: EventName, payload: unknown): void
  /** features 只读器（getInfo 回报；装配层从 config.features 归一读出） */
  getFeatures(): Record<string, boolean>
  /** 主题状态读写器 */
  getTheme(): SetThemePayload['theme']
  setTheme(theme: SetThemePayload['theme']): void
  /** 语言状态读写器 */
  getLocale(): SetLocalePayload['locale']
  setLocale(locale: SetLocalePayload['locale']): void
  /** M1+ 接缝：按命令名替换门控后的实现（仍受终态/模式两道门约束） */
  overrides?: Partial<Record<CommandName, CommandHandler>>
  /** getApps：按文件名枚举命中应用（内存文件独立区的「选打开应用」下拉数据源；装配层注入 registry 查询） */
  getApps?: (entry: { name: string }) => Array<{ id: string; label: string; actions: string[] }>
}

/** 单文件模式命令子集（契约 §四）：外观三件 + destroy + uploadFiles（仅内存通道——bucket 分支由 overrides 按模式拒绝 4305） */
const FILE_MODE_ALLOWED: ReadonlySet<CommandName> = new Set<CommandName>([
  'setTheme',
  'setLocale',
  'getInfo',
  'destroy',
  'uploadFiles',
  'getApps',
  'registerApp',
])

/** 工作台 tree/IO 类命令（本期桩；M1 接管后经 overrides 注入实现）；setCredentials=核心命令但实现同样在装配层 overrides（main.ts 热替换 client 凭证） */
const M1_STUB_NAMES = [
  'navigate',
  'openFile',
  'closeTab',
  'select',
  'createFolder',
  'uploadFiles',
  'download',
  'rename',
  'remove',
  // v1.2 回收站命令：工作台 tree/IO 类，同属 M1 桩面（实现在 M3 overrides，files/commands.ts createM1Overrides）
  'restore',
  'purge',
  'registerApp',
  'setCredentials',
  'getApps',
] as const satisfies readonly CommandName[]

const THEME_VALUES = ['light', 'dark', 'auto'] as const
const LOCALE_VALUES = ['zh-CN', 'en-US'] as const

/** payload 必须为普通对象（契约 §五注④：非法参数=4005） */
function asObject(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SdkError(ERROR_CODES.BAD_PARAM, 'payload 必须是对象')
  }
  return payload as Record<string, unknown>
}

/** 枚举字段校验（契约 §五注④：非法参数=4005） */
function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new SdkError(ERROR_CODES.BAD_PARAM, `${field} 非法：${String(value)}`)
  }
  return value as T
}

export function createCommandHandlers(deps: HandlerDeps): Record<CommandName, CommandHandler> {
  /** ① 终态门控：已终态 → 5000（任何命令） */
  const guardTerminal = (): void => {
    if (deps.getSession()?.isExpired()) {
      throw new SdkError(ERROR_CODES.SESSION_EXPIRED, '会话已终态，拒绝命令')
    }
  }

  /** ② 模式门控：单文件模式下调工作台命令 → 4305（契约 §四） */
  const guardMode = (name: CommandName): void => {
    if (deps.getConfig()?.mode === 'file' && !FILE_MODE_ALLOWED.has(name)) {
      throw new SdkError(ERROR_CODES.UNSUPPORTED_MODE, `单文件模式不支持命令 ${name}`)
    }
  }

  /** 工作台命令桩（M1 接管）：4301 FEATURE_DISABLED */
  const m1Stub = (name: (typeof M1_STUB_NAMES)[number]): CommandHandler => () => {
    throw new SdkError(ERROR_CODES.FEATURE_DISABLED, `工作台命令 ${name} 本期未接管（M1 接管）`)
  }

  const builtins: Record<CommandName, CommandHandler> = {
    navigate: m1Stub('navigate'),
    openFile: m1Stub('openFile'),
    closeTab: m1Stub('closeTab'),
    // M1 接管前无 tab 状态：空集实做（契约 reply 形状 { tabs: TabInfo[] }）
    getTabs: () => ({ tabs: [] as TabInfo[] }),
    select: m1Stub('select'),
    createFolder: m1Stub('createFolder'),
    uploadFiles: m1Stub('uploadFiles'),
    download: m1Stub('download'),
    rename: m1Stub('rename'),
    remove: m1Stub('remove'),
    // v1.2 回收站命令：桩兜 4301（overrides 注入 createM1Overrides 的 trashBatch 实做后接管）
    restore: m1Stub('restore'),
    purge: m1Stub('purge'),
    registerApp: m1Stub('registerApp'),
    // v1.1：核心命令但实现在装配层 overrides（main.ts：热替换 client 凭证 + session.extend）——
    // 桩兜 4301（workspace 未接管/单文件模式走 FILE_MODE 门 4305），凭证校验在 override 内做
    setCredentials: m1Stub('setCredentials'),
    // getApps（v1.2 内存文件独立区）：按扩展名枚举命中应用；装配层未注入=能力缺位回空集（不 4005，宿主 UI 可降级为手填 appId）
    getApps: (payload) => {
      const name = (asObject(payload).name as unknown) ?? undefined
      if (typeof name !== 'string' || name.trim() === '') throw new SdkError(ERROR_CODES.BAD_PARAM, 'getApps.name 必须是非空字符串')
      const apps = deps.getApps?.({ name: name.trim() }) ?? []
      return { apps }
    },

    setTheme: (payload) => {
      deps.setTheme(asEnum(asObject(payload).theme, THEME_VALUES, 'theme'))
      return {}
    },
    setLocale: (payload) => {
      deps.setLocale(asEnum(asObject(payload).locale, LOCALE_VALUES, 'locale'))
      return {}
    },
    getInfo: (): GetInfoReply => {
      const remainingMs = deps.getSession()?.remainingMs() ?? Number.POSITIVE_INFINITY
      // 无期限（未在表/无死线）用 -1 哨兵：Infinity 经 JSON 序列化会变 null，破坏协议
      const expiresInSec = Number.isFinite(remainingMs) ? Math.ceil(remainingMs / 1000) : -1
      return { sdkVersion: SDK_VERSION, session: { expiresInSec }, features: deps.getFeatures() }
    },
    destroy: () => {
      deps.getSession()?.destroy()
      // 仅 reply {}；`expired` 事件由装配层派发（契约 §三：先 ack 后 evt expired）
      return {}
    },
  }

  // 统一包装：两道门（终态/模式）对 15 键全量生效，overrides 只替换门控后的实现
  const table = {} as Record<CommandName, CommandHandler>
  for (const name of Object.keys(builtins) as CommandName[]) {
    const impl = deps.overrides?.[name] ?? builtins[name]
    table[name] = (payload) => {
      guardTerminal()
      guardMode(name)
      return impl(payload)
    }
  }
  return table
}
