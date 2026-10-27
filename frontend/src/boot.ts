/**
 * boot——装配层（Wave2-T1）：把 config/bus/session/handlers/registry 接成可运行的 iframe 应用
 * 契约：《docs/design/jsdk-api.md》V1.0 §三（握手时序）、《docs/design/solution-design.md》V1.2 §4.1/§4.2
 *
 * 关键时序：destroy 命令 = 先 ack 后 evt:expired（§三）——handler 内 session.destroy() 同步进终态，
 * expired 的 emit 延迟到宏任务，保证 wrap 的 ack reply（微任务）先行。
 */
import { MessageBus } from './sdk/bus'
import type { MessageHandler } from './sdk/bus'
import {
  buildConfigSummary,
  clearRawConfig,
  fragmentHasConfigKey,
  parseAppConfig,
  persistRawConfig,
  restoreRawConfig,
  scrubFragment,
} from './sdk/config'
import { createCommandHandlers, SDK_VERSION } from './sdk/handlers'
import { SessionController } from './sdk/session'
import { resolveFeatures } from './sdk/features'
import { AppRegistry } from './apps/registry'
import { ERROR_CODES, SdkError } from './sdk/errorCodes'
import { PROTOCOL_VERSION, TTL_HARD_CAP_SEC } from './sdk/constants'
import type { AppConfig, CommandName, SetLocalePayload, SetThemePayload } from './sdk/types'
import type { CommandHandler, SessionHandle } from './sdk/handlers'
import type { InjectionKey } from 'vue'

/** Vue 注入键：main.ts provide、UI 层 inject（值=BootResult） */
export const BOOT_KEY: InjectionKey<BootResult> = Symbol('mmagic-boot')

export interface BootOptions {
  /** 宿主窗口（默认 window；测试注入 jsdom 窗口） */
  win?: Window
  /** T-5min 预警回调（UI 横幅消费） */
  onWarn?(): void
  /** 主题/语言变更回调（UI 消费） */
  onThemeChange?(theme: SetThemePayload['theme']): void
  onLocaleChange?(locale: SetLocalePayload['locale']): void
  /**
   * M1+ 接缝：config 就绪后构造命令 overrides（如 createM1Overrides）。
   * 回调形态的原因：overrides 的依赖（client/tree/queue）需要 config，而 config 在 bootApp 内部解析。
   */
  overrides?: (config: AppConfig, session: SessionHandle) => Partial<Record<CommandName, CommandHandler>> | undefined
  /** M3 接缝：registry 创建后构造插件加载器等；可返回 ensureApps（lazy 插件「首命中触发」由打开链调用） */
  setupPlugins?: (registry: AppRegistry, config: AppConfig) => void | {
    ensureApps?: (entry: { name: string; mime?: string; size?: number }, opts?: EnsureAppsOpts) => Promise<void>
  }
}

/** ensureApps 选项：force=跳过「默认应用已命中」短路，强制补载配置插件（指定插件应用 appId 未命中时用） */
export interface EnsureAppsOpts {
  force?: boolean
}

export interface BootHandle {
  win: Window
  config: AppConfig
  bus: MessageBus
  session: SessionController
  registry: AppRegistry
  /** 页面卸载/测试清理：停表 + 总线销毁（不发 expired） */
  dispose(): void
  /** M3：lazy 插件加载触发（preview 未命中时先加载配置插件再重解析） */
  ensureApps?(entry: { name: string; mime?: string; size?: number }, opts?: EnsureAppsOpts): Promise<void>
}

export type BootResult =
  | { ok: true; handle: BootHandle }
  | { ok: false; error: SdkError }

function originOf(url: string): string | null {
  try {
    return new URL(url, window.location.href).origin
  } catch {
    return null
  }
}

/** 取 win 的 sessionStorage（受限环境访问即抛 / 缺失 → null，备份降级为不可用） */
function sessionStorageOf(win: Window): Storage | null {
  try {
    return win.sessionStorage ?? null
  } catch {
    return null
  }
}

/** cmd 实现包装：同步/异步统一——成功 reply(result??{})；失败 replyError(code)（bus 同步 catch 只兜同步抛错） */
function wrapCommand(impl: (payload: unknown) => unknown | Promise<unknown>): MessageHandler {
  return (payload, ctx) => {
    Promise.resolve()
      .then(() => impl(payload))
      .then(
        (result) => ctx.reply(result ?? {}),
        (err: unknown) => {
          const code =
            err instanceof SdkError && Number.isFinite(err.code)
              ? err.code
              : ERROR_CODES.SESSION_EXPIRED
          ctx.replyError(code, { code, message: err instanceof Error ? err.message : 'command failed' })
        },
      )
  }
}

export function bootApp(options: BootOptions = {}): BootResult {
  const win = options.win ?? window
  const rawConfigStorage = sessionStorageOf(win)

  // ① 配置解析（失败→UI 错误态；宿主通知为 best-effort，本期跳过——决策档案 test-report/PROGRESS-2026-10-10-archived.md）
  //
  // 刷新重建（手册「刷新=从 URL 重建」的补偿兑现）：scrub 已抹掉 fragment，刷新后 URL 无配置键——
  // 此时读 sessionStorage 备份走同一 parseAppConfig 路径重建（不回写 URL）；备份过期/损坏由
  // restoreRawConfig 清除并按无配置处理（4001）。URL 带配置键时以 URL 为准（坏配置直接失败，
  // 不回落备份——避免掩盖宿主传入的真实坏 URL），解析成功后覆盖写新备份。
  let config: AppConfig
  let rawFromUrl: string | null = null
  try {
    const rawHash = win.location.hash
    if (fragmentHasConfigKey(rawHash)) {
      config = parseAppConfig(rawHash)
      rawFromUrl = rawHash
    } else {
      const restored = restoreRawConfig({ storage: rawConfigStorage })
      if (restored !== null) {
        try {
          config = parseAppConfig(restored)
        } catch (err) {
          clearRawConfig({ storage: rawConfigStorage }) // 备份内容失效（校验不过）→ 清除
          throw err
        }
      } else {
        config = parseAppConfig(rawHash) // 无备份：维持原路径的 4001 缺配置
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof SdkError ? err : new SdkError(ERROR_CODES.BAD_CONFIG, '配置解析失败', err) }
  }
  // 解析成功才备份（坏配置不落盘）；URL 来的才备份（备份重建不重写 exp——刷新不展期备份寿命）
  if (rawFromUrl !== null) {
    persistRawConfig(rawFromUrl, {
      storage: rawConfigStorage,
      ttlSeconds: config.mode === 'workspace' ? config.backend.ttlSeconds : undefined,
    })
  }
  scrubFragment()

  // ② 通道：iframe→parent，独立窗→opener；接收白名单与发送 target 分模式推导
  const referrerOrigin = originOf(win.document.referrer)
  const allowedOrigins =
    config.mode === 'workspace'
      ? config.security.allowedOrigins
      : (config.security?.allowedOrigins ?? (referrerOrigin ? [referrerOrigin] : []))
  const hostOrigin = referrerOrigin ?? (config.mode === 'workspace' ? (config.security.allowedOrigins[0] ?? null) : null)
  const remoteWindow = (): Window | null => {
    if (win.parent !== win) return win.parent // iframe
    const opener = (win as { opener?: Window | null }).opener
    return opener ?? null // window.open 独立窗
  }
  const targetOrigin = (): string => hostOrigin ?? ''

  const bus = new MessageBus(win, {
    allowedOrigins,
    targetOrigin: () => (hostOrigin ? targetOrigin() : '*-disabled-'), // 占位防误用：无 host origin 时 remote 必为 null
    remoteWindow: () => (hostOrigin ? remoteWindow() : null),
  })

  // ③ 会话：ttlSeconds 截断硬帽；expiresAt 优先（对齐 STS 真实到期）
  const ttlSeconds =
    config.mode === 'workspace' && config.backend.ttlSeconds !== undefined
      ? Math.min(config.backend.ttlSeconds, TTL_HARD_CAP_SEC)
      : undefined
  const expiresAt = config.mode === 'workspace' ? config.backend.expiresAt : undefined

  // 事件终态派发延迟到宏任务：保证 destroy 命令的 ack（微任务）先于 evt:expired（§三）。
  // F4（契约 §七「终态后任何 cmd→5000」）：到期不再销毁总线——监听与 handler 表保留，
  // 后续 cmd 经 wrapCommand→guardTerminal 抛 5000 正常回包；总线生命周期挂 page unload 与 dispose()。
  let busDown = false
  const onUnload = (): void => {
    busDown = true
    bus.destroy()
  }
  win.addEventListener('beforeunload', onUnload)
  const session = new SessionController({
    ttlSeconds,
    expiresAt,
    onWarn: () => options.onWarn?.(),
    onExpire: (reason) => {
      // 终态即清 fragment 备份（ttl 到点与 destroy 命令同经此回调）——到期会话不可借刷新续命
      clearRawConfig({ storage: rawConfigStorage })
      setTimeout(() => {
        if (busDown) return
        bus.emit('expired', { reason })
      }, 0)
    },
  })

  // ④ 应用注册表（先于命令表：setupPlugins/M1 overrides 均可引用）+ 插件加载器接缝
  const registry = new AppRegistry()
  const pluginsApi = options.setupPlugins?.(registry, config)

  // ⑤ 命令表：状态器 + 两道门 + overrides 之后的 wrap 注册
  const themeState: { value: SetThemePayload['theme'] } = { value: config.appearance?.theme ?? 'light' }
  const localeState: { value: SetLocalePayload['locale'] } = { value: config.appearance?.locale ?? 'zh-CN' }
  const features = resolveFeatures(config.features)
  const table = createCommandHandlers({
    getConfig: () => config,
    getSession: () => session,
    emit: (evt, payload) => bus.emit(evt, payload), // M1 起业务事件（pathChanged/upload* 等）经此缝出站
    getFeatures: () => features,
    getTheme: () => themeState.value,
    setTheme: (t) => {
      themeState.value = t
      options.onThemeChange?.(t)
    },
    getLocale: () => localeState.value,
    setLocale: (l) => {
      localeState.value = l
      options.onLocaleChange?.(l)
    },
    getApps: (entry) =>
      registry
        .listMatches(entry)
        .map((d) => ({ id: d.id, label: d.label ?? d.id, actions: d.actions ?? [] })),
    overrides: options.overrides?.(config, session),
  })
  for (const name of Object.keys(table) as CommandName[]) {
    bus.on(name, wrapCommand(table[name]))
  }

  // ⑥ 握手：emit ready → 置位 remoteReady（先 emit 后 mark，宿主收到 ready 后自行 mark 其侧）
  session.start()
  bus.emit('ready', {
    sdkVersion: SDK_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    configSummary: buildConfigSummary(config),
  })
  bus.markRemoteReady()

  const handle: BootHandle = {
    win,
    config,
    bus,
    session,
    registry,
    dispose: () => {
      busDown = true
      win.removeEventListener('beforeunload', onUnload)
      session.stop()
      bus.destroy()
    },
    ensureApps: pluginsApi?.ensureApps,
  }
  return { ok: true, handle }
}
