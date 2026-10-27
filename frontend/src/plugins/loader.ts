/**
 * T1 宿主自管插件加载器（契约：《docs/design/plugin-system.md》V1.1 §一/§四）
 *
 * 机制说明（与文档 §一 的 script 标签差异，等价更强）：
 * `<script type="module" src integrity>` 只执行模块顶层、拿不到导出——插件的
 * `export activate(sdk)` 无人调用。因此实现走：fetch 字节 → crypto.subtle 自算
 * sha384 校验（等价 SRI 强度、失败路径可控）→ Blob URL import() → activate(sdk)。
 * 裁决⑥（无租户概念）下 SPA 不设 script-src，blob: 加载无 CSP 顾虑。
 */
import { ERROR_CODES, SdkError } from '../sdk/errorCodes'
import { PROTOCOL_VERSION } from '../sdk/constants'
import type { AppDefinition } from '../sdk/types'
import type { AppRegistry } from '../apps/registry'

export interface PluginEntryInput {
  url: string
  /** 'sha384-<hex>'；缺省=不校验（不推荐，契约红线 2） */
  sri?: string
  /** 透传给 activate(sdk, options) 的插件参数（v1.1 增补；缺省不传=undefined 第二参） */
  options?: Record<string, unknown>
}

/** 注入给插件 activate(sdk) 的句柄（契约 §二：完整 API 面就这么大） */
export interface PluginSdkHandle {
  registerApp(def: AppDefinition): { ok: boolean; reason?: string }
  version: number
}

export interface PluginLoaderDeps {
  registry: AppRegistry
  /** 加载失败上报（装配层接 emit('error', {code:4201,...})） */
  onError?: (err: SdkError) => void
  /** 应用注册观察（registerApp 通道回 appId 用；def 为插件 manifest，url=来源插件地址——同 url 幂等短路不再 activate，调用方据此按 url 建映射） */
  onRegister?: (def: AppDefinition, url: string) => void
  /** 可注入 import（测试用；生产=动态 import(blobUrl)，vite 下需 @vite-ignore） */
  importModule?: (url: string) => Promise<{ activate?: unknown }>
  /** 可注入 fetch（测试用） */
  fetcher?: typeof fetch
}

async function sha384Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class PluginLoader {
  private readonly loaded = new Set<string>()
  /**
   * 在途 Promise（按 url memoize）：并发 load 同 url → 双方 await 同一 Promise。
   * 若只按 loaded 短路，第二调用方会在 activate/onRegister 完成前提前返回——
   * registerApp 通道据 appIdByUrl 查表回 appId 时误报 4201「插件未注册任何应用」。
   */
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly deps: PluginLoaderDeps

  constructor(deps: PluginLoaderDeps) {
    this.deps = deps
  }

  get loadedCount(): number {
    return this.loaded.size
  }

  /** 已加载过（含失败——失败不重试，重装需整页刷新；lazy 语义由调用方首命中时触发） */
  has(url: string): boolean {
    return this.loaded.has(url)
  }

  /**
   * 加载并激活插件：fetch → SRI 自校验 → import → activate(sdk, options)。幂等（同 url 只载一次，并发共享同一在途 Promise）。
   * @returns 本次调用是否处于「发起激活」路径——true=激活由本调用的 entry（含 options）驱动；
   *          false=同 url 已载/在途加入（本次 entry 的 options 不适用，registerApp 据此回 applied:false）
   */
  async load(entry: PluginEntryInput): Promise<boolean> {
    const { url } = entry
    // 在途检查先于已载检查：load 起步即记入 loaded（has() 语义不变），仅靠 loaded 短路会放过在途竞态
    const pending = this.inflight.get(url)
    if (pending) {
      await pending
      return false
    }
    if (this.loaded.has(url)) return false
    const task = this.doLoad(entry).finally(() => {
      this.inflight.delete(url)
    })
    this.inflight.set(url, task)
    await task
    return true
  }

  private async doLoad(entry: PluginEntryInput): Promise<void> {
    const { url, sri } = entry
    this.loaded.add(url)
    try {
      const fetcher = this.deps.fetcher ?? fetch.bind(globalThis)
      const res = await fetcher(url)
      if (!res.ok) {
        throw new SdkError(ERROR_CODES.PLUGIN_LOAD_FAILED, `插件拉取失败（${res.status}）：${url}`, { status: res.status })
      }
      const bytes = await res.arrayBuffer()
      if (sri) {
        const actual = `sha384-${await sha384Hex(bytes)}`
        if (actual !== sri) {
          throw new SdkError(ERROR_CODES.PLUGIN_LOAD_FAILED, `插件 SRI 校验不符：${url}`, { expected: sri, actual })
        }
      }
      // blob URL 用后即焚：import 结算=模块评估完成（含拒绝路径），字节已进模块记录，URL 不再被引用
      const blobUrl = blobUrlOf(bytes)
      let mod: { activate?: unknown } | null | undefined
      try {
        mod = await (this.deps.importModule ?? defaultImport)(blobUrl)
      } finally {
        revokeBlobUrl(blobUrl)
      }
      if (typeof mod?.activate !== 'function') {
        throw new SdkError(ERROR_CODES.PLUGIN_LOAD_FAILED, `插件缺少 export activate(sdk)：${url}`)
      }
      const handle: PluginSdkHandle = {
        version: PROTOCOL_VERSION,
        registerApp: (def) => {
          const r = this.deps.registry.register(def)
          // 仅成功注册才观察：拒载（duplicate-id/sdk-version）的 def 不进 appId 通道，
          // 防宿主 registerApp 回一个实际不可用的 appId
          if (r.ok) this.deps.onRegister?.(def, url)
          return { ok: r.ok, reason: r.reason }
        },
      }
      ;(mod.activate as (sdk: PluginSdkHandle, options?: Record<string, unknown>) => void)(handle, entry.options)
    } catch (err) {
      const e = err instanceof SdkError ? err : new SdkError(ERROR_CODES.PLUGIN_LOAD_FAILED, `插件加载失败：${(err as Error)?.message ?? String(err)}`, err)
      this.deps.onError?.(e)
      // 失败不上抛（契约：加载失败走 error 事件 4201，不崩工作台）
    }
  }
}

function blobUrlOf(bytes: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))
}

/** 回收 blob URL（缺 API/受限环境静默——泄漏由页面生命周期兜底） */
function revokeBlobUrl(url: string): void {
  try {
    URL.revokeObjectURL(url)
  } catch {
    // 静默
  }
}

/** 生产 import：动态 import Blob URL（@vite-ignore 防构建期分析） */
async function defaultImport(url: string): Promise<{ activate?: unknown }> {
  return import(/* @vite-ignore */ url)
}
