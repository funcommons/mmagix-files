/**
 * 预览打开链——选中文件 → registry 解析默认应用（或按 appId 指定）→ ctx 装配 → 渲染器执行
 * 契约：《方案设计.md》V1.2 §4.6（AppRegistry/同类型多应用）、《动态插件方案.md》§五（dispose/恢复/beforeDispose）、
 *      《第一期文件类型支持计划.md》缺口 7（渲染失败/超时 10s 错误边界）
 * 生命周期：
 *  - 切换（open）/关闭（close）：先过 beforeDispose gate——false=暂缓本次操作（实例与容器完整保留），
 *    3s 超时强制放行，true/无 beforeDispose=直接放行；放行后 dispose 前 getState 采集 savedState（per-key，容量 32）
 *  - expire：通知式——beforeDispose('expired') fire-and-forget，不等结果立即 dispose 并清容器（契约：expired 只通知不询问）
 *  - clear：强制语义（unmount 用，不走 gate）
 *  - 切回=renderer 重跑，第 4 参回注 savedStates.get(entry.key)（插件未声明 getState 时为 undefined）
 *  - renderer 同步抛/拒绝/10s 超时 → per-tab 错误边界（标题+信息+重试+下载门控）；超时后迟到的结算 dispose 其结果并忽略
 *  - open(entry, { appId })：指定应用走 registry.require（既有 not-found 语义），未命中=错误节点不抛裸异常
 *  - Lane G4 尺寸总闸（R2-03 起：def 解析先行，实际拒绝线吃渲染器限额）：
 *      def（appId/默认解析，含 lazy ensureApps）先于尺寸闸解析——实际拒绝线 = min(REJECT(50MB), def.maxBytes ?? ∞)。
 *      size ≤ CONFIRM(20MB) 直开；CONFIRM < size ≤ 实际拒绝线 询问宿主 confirmLargeFile（false/异常=取消，
 *      零半更新；无回调=放行向后兼容）；size > 实际拒绝线 拒绝节点（不取流不渲染不询问，文案带实际线 limit）。
 *      效果：25.1MB csv（渲染器限 20MB）不再「确认后仍被拒」——确认带收窄到渲染器真能渲染的区段；
 *      maxBytes ≤ CONFIRM 的类型（md/code 5MB）根本不进确认带，与渲染器 5MB 拒转语义一致。
 *    层次：本闸=预览链上游总闸（仅凭列表元数据判定，零取流）；渲染器自有上限=下游兜底防线
 *      （已取流/直调渲染器时的内存防线，与闸同源常量——见 apps/builtins.ts 限额表；本闸在位时正常路径
 *      不可达，保留作防御纵深：插件应用未登记 maxBytes、未来绕过本闸的调用方）。
 *      size 缺失/0（单文件模式伪条目）跳过本闸，渲染器自有上限兜底。
 */
import { AppRegistry } from '@/apps/registry'
import { createAppCtx } from '@/apps/ctx'
import { formatBytes } from '@/files/format'
import type { AppDataSource } from '@/apps/datasource'
import type { AppDefinition, AppInstance, S3ObjectSummary } from '@/sdk/types'

/** beforeDispose 询问超时：超时强制放行（契约 §五） */
const BEFORE_DISPOSE_TIMEOUT_MS = 3_000
/** 渲染超时：失败/超时降级错误节点，不崩工作台（缺口 7） */
const RENDER_TIMEOUT_MS = 10_000
/** savedState per-key 容量上限：超出淘汰最旧 */
const SAVED_STATE_LIMIT = 32

/**
 * 大文件分级闸阈值（Lane G4，建议默认值——《第一期文件类型支持计划.md》§三「可配」口径）：
 * CONFIRM 以上询问宿主、REJECT 以上直接拒绝；两者间留给确认 UI 裁决。
 */
export const PREVIEW_CONFIRM_BYTES = 20 * 1024 * 1024
export const PREVIEW_REJECT_BYTES = 50 * 1024 * 1024

/** 阈值展示统一走 formatBytes（R2-05：'50 MB' 带空格口径，与树列表/渲染器提示同源） */

export interface PreviewOptions {
  container: HTMLElement
  registry: AppRegistry
  datasource: AppDataSource
  /** 宿主词典（i18n）：params 透传做占位插值（vue-i18n 具名插值口径；宿主包装器需把第二参转发给 t） */
  t: (key: string, params?: Record<string, unknown>) => string
  theme: Record<string, string>
  notifyFileChanged: (payload: { key: string; action: 'put' | 'delete' | 'rename'; from?: string }) => void
  /** 应用级故障出口（缺省=不上报）: 渲染失败/保存链失败 → 宿主 bus 'error'（toast/换签重载） */
  notifyAppError?: (err: { code: number; message: string }) => void
  /** 下载处理器（fallback/错误节点下载钮用；缺省=提示文案 only） */
  onDownload?: (entry: S3ObjectSummary) => void
  /** lazy 插件触发（registry 未命中时先加载配置插件再重解析一次；契约：lazy 默认开、首匹配才 import） */
  ensureApps?: (
    entry: { name: string; mime?: string; size?: number },
    opts?: { force?: boolean }, // force=跳过「默认应用已命中」短路（指定插件 appId 未命中时强制补载）
  ) => Promise<void>
  /** 下载总闸（缺省 true）：false 时 fallback 与错误节点均不出下载钮 */
  canDownload?: boolean
  /**
   * 大文件确认 UI（Lane G4 确认档，CONFIRM < size ≤ 该类型实际拒绝线 时询问——R2-03：
   * 实际拒绝线=min(REJECT, def.maxBytes)，渲染器限额类型不再询问注定被拒的区段）：
   * true=继续渲染，false=取消本次 open。
   * 缺省=确认档直接放行——默认策略：宿主未注入确认 UI 时不得把中型文件变成死路（向后兼容：
   * 既有宿主升级 SDK 后行为不变，大文件防护只在其显式接线时收紧）。
   */
  confirmLargeFile?: (entry: S3ObjectSummary, sizeBytes: number) => Promise<boolean>
  /**
   * 打开链接管通知（Lane H1 预览 tab 条所需最小暴露）：open 链过闸并接管容器（含大文件拒绝节点）
   * 时以 entry 通知——「open 链成功」的权威信号；被暂缓/取消/被新链接管的链不触发（零半更新同步）。
   * 渲染随后失败也照常通知（错误节点同样是接管态，tab 重试链自洽）。
   */
  onOpened?: (entry: S3ObjectSummary) => void
}

export interface PreviewOpenOptions {
  /** 指定应用（「打开方式」）：registry.require 按 id 取（既有 not-found 语义），未命中→错误节点，不抛裸异常 */
  appId?: string
  /** 打开参数（第 5 参透传渲染器；消费方自决——如 markdown-editor 的 { initialMode }，其它渲染器忽略） */
  appOptions?: Record<string, unknown>
}

export interface PreviewHandle {
  /** 打开/切换文件；先过大文件尺寸闸（Lane G4：>REJECT 拒绝节点 / 确认档取消——均状态零变更），
   *  再过 beforeDispose gate 后 dispose 旧实例。registry 无命中→fallback 下载提示；
   *  渲染失败/超时→错误节点。被暂缓（gate=false）时本链不生效（状态零变更） */
  open(entry: S3ObjectSummary, openOpts?: PreviewOpenOptions): Promise<void>
  /** 关闭当前预览（走 gate）；返回是否真的关闭，false=被 beforeDispose 暂缓 */
  close(): Promise<boolean>
  /** 会话过期/销毁：通知式 beforeDispose('expired')（不等结果）后立即 dispose 并清容器 */
  expire(): void
  /** 清空（含当前实例 dispose；强制语义不走 gate，unmount 用） */
  clear(): void
  /** 当前打开的条目（供 UI 高亮/测试） */
  current(): S3ObjectSummary | null
}

/** 渲染结果归一：ok=拿到实例（或无返回）；failed=同步抛/拒绝/超时 */
type RenderOutcome = { status: 'ok'; instance: AppInstance | null } | { status: 'failed'; error: unknown }

export function createPreview(opts: PreviewOptions): PreviewHandle {
  const { container, registry, datasource, t, theme, notifyFileChanged, onDownload, ensureApps, confirmLargeFile, onOpened } =
    opts
  /** 应用级故障出口（缺省=不上报——渲染器 ctx 不带 notifyAppError 键, 探测回落静默） */
  const notifyAppError = opts.notifyAppError
  /** 下载门：缺省 true；fallback 与错误节点下载钮共用 */
  const canDownload = opts.canDownload !== false
  let instance: AppInstance | null = null
  let current: S3ObjectSummary | null = null
  /** 生命周期代际：gate/渲染等 await 点之后校验，被新链接管的老链整体退出（防半更新） */
  let seq = 0
  /** per-key savedState：dispose 前 getState 采集；Map 插入序=新鲜度序，超限淘汰最旧 */
  const savedStates = new Map<string, unknown>()

  function captureSavedState(key: string, state: unknown): void {
    // 重写先删再插=刷新新鲜度；超限从最旧端淘汰
    savedStates.delete(key)
    savedStates.set(key, state)
    while (savedStates.size > SAVED_STATE_LIMIT) {
      const oldest = savedStates.keys().next()
      if (oldest.done) break
      savedStates.delete(oldest.value)
    }
  }

  /** 销毁实例：dispose 前 getState 采集（契约「切回=重跑+状态恢复」）；getState/dispose 异常不阻断销毁 */
  function teardown(inst: AppInstance | null, key: string | null): void {
    if (!inst) return
    if (key !== null && typeof inst.getState === 'function') {
      try {
        captureSavedState(key, inst.getState())
      } catch {
        // getState 异常不阻断 dispose
      }
    }
    try {
      inst.dispose()
    } catch {
      // dispose 异常不阻断切换/关闭
    }
  }

  /** beforeDispose gate：false=暂缓；3s 超时/异常=强制放行；true/无 beforeDispose=放行 */
  function askBeforeDispose(inst: AppInstance | null): Promise<boolean> {
    const ask = inst?.beforeDispose
    if (!inst || !ask) return Promise.resolve(true)
    let outcome: boolean | Promise<boolean>
    try {
      outcome = ask.call(inst)
    } catch {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolveGate) => {
      let settled = false
      const finish = (v: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveGate(v)
      }
      const timer = setTimeout(() => finish(true), BEFORE_DISPOSE_TIMEOUT_MS)
      Promise.resolve(outcome).then(
        (v) => finish(v !== false),
        () => finish(true),
      )
    })
  }

  function errMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    if (err !== null && typeof err === 'object') {
      const m = (err as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
    return err == null ? '' : String(err)
  }

  function appendDownloadButton(wrap: HTMLElement, entry: S3ObjectSummary): void {
    if (!canDownload || !onDownload) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'fc-button'
    btn.textContent = t('files.preview-download')
    btn.addEventListener('click', () => onDownload(entry))
    wrap.appendChild(btn)
  }

  function renderFallback(entry: S3ObjectSummary): void {
    const wrap = document.createElement('div')
    wrap.className = 'mmf-preview-fallback'
    const tip = document.createElement('p')
    tip.textContent = t('files.preview-fallback')
    wrap.appendChild(tip)
    appendDownloadButton(wrap, entry)
    container.appendChild(wrap)
  }

  /** per-tab 错误边界节点：标题+信息+重试（重跑同一 open）+下载（门控） */
  function renderErrorNode(entry: S3ObjectSummary, message: string, openOpts: PreviewOpenOptions): void {
    const wrap = document.createElement('div')
    wrap.className = 'mmf-preview-error'
    const title = document.createElement('p')
    title.className = 'mmf-preview-error__title'
    title.textContent = t('files.preview-error-title')
    wrap.appendChild(title)
    if (message) {
      const info = document.createElement('p')
      info.className = 'mmf-preview-error__message'
      info.textContent = message
      wrap.appendChild(info)
    }
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'fc-button'
    retry.textContent = t('files.preview-error-retry')
    retry.addEventListener('click', () => {
      void open(entry, openOpts)
    })
    wrap.appendChild(retry)
    appendDownloadButton(wrap, entry)
    container.appendChild(wrap)
  }

  /** 大文件拒绝节点（Lane G4 拒绝档）：拒绝文案（limit=实际拒绝线，R2-03）+ 下载钮（canDownload/onDownload 双门） */
  function renderRejectedNode(entry: S3ObjectSummary, rejectBytes: number): void {
    const wrap = document.createElement('div')
    wrap.className = 'mmf-preview-rejected'
    const tip = document.createElement('p')
    tip.className = 'mmf-preview-rejected__message'
    tip.textContent = t('largefile.rejected', { limit: formatBytes(rejectBytes) })
    wrap.appendChild(tip)
    appendDownloadButton(wrap, entry)
    container.appendChild(wrap)
  }

  /**
   * 容器接管（open 主链与尺寸闸拒绝档共用）：销毁旧实例（dispose 前 getState 采集）→ 清容器 → current 切换
   * → onOpened 通知（Lane H1：接管即「open 链成功」信号，渲染成败不影响）。
   * 前置条件：调用方已过代际校验（my === seq）与 beforeDispose gate——本函数不做任何询问。
   */
  function takeOver(entry: S3ObjectSummary, prev: AppInstance | null, prevKey: string | null): void {
    instance = null
    teardown(prev, prevKey)
    container.innerHTML = ''
    current = entry
    try {
      onOpened?.(entry)
    } catch {
      // 宿主回调异常不阻断渲染链
    }
  }

  /** 渲染器执行：10s 超时竞速；超时后迟到的结算 dispose 其结果并忽略（防泄漏/后台请求） */
  function runRenderer(
    def: AppDefinition,
    el: HTMLElement,
    file: { key: string; name: string; size: number },
    ctx: Parameters<AppDefinition['renderer']>[2],
    savedState: unknown,
    appOptions?: Record<string, unknown>,
  ): Promise<RenderOutcome> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (o: RenderOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(o)
      }
      const timer = setTimeout(() => {
        finish({ status: 'failed', error: new Error(`渲染超时（${RENDER_TIMEOUT_MS / 1000}s）`) })
      }, RENDER_TIMEOUT_MS)
      const disposeLate = (result: unknown): void => {
        if (result && typeof (result as AppInstance).dispose === 'function') {
          try {
            ;(result as AppInstance).dispose()
          } catch {
            // 迟到结果的销毁异常忽略
          }
        }
      }
      let running: Promise<void | AppInstance>
      try {
        running = Promise.resolve(def.renderer(el, file, ctx, savedState, appOptions))
      } catch (err) {
        finish({ status: 'failed', error: err })
        return
      }
      running.then(
        (result) => {
          if (settled) {
            disposeLate(result) // 超时后迟到结算：销毁并忽略
            return
          }
          finish({ status: 'ok', instance: result && typeof result === 'object' ? (result as AppInstance) : null })
        },
        (err: unknown) => {
          if (settled) return // 迟到的拒绝：忽略
          finish({ status: 'failed', error: err })
        },
      )
    })
  }

  async function open(entry: S3ObjectSummary, openOpts: PreviewOpenOptions = {}): Promise<void> {
    const my = ++seq
    // ===== def 解析（R2-03 前移：实际拒绝线依赖 def.maxBytes，须先于尺寸闸拿到）=====
    // appId 未命中（require 抛 4102）暂存 defError，错误节点仍在 gate+takeOver 之后出（原时机不变）；
    // lazy ensureApps 随之前移——插件应用的 maxBytes 也必须参与拒绝线判定，否则插件限额类型会
    // 误入确认带（「确认后仍被拒」换个形态复发）。被新链/关闭接管时代际校验整体退出。
    const fileRef = { name: entry.name, mime: entry.mime, size: entry.size }
    let def: AppDefinition | null = null
    let defError: unknown = null
    if (openOpts.appId !== undefined) {
      // 指定应用：registry.require 既有 not-found 语义（4102）——未命中降级错误节点，不抛裸异常。
      // 插件注册竞态兜底：启动即载插件是 void load()（不阻塞 ready），uploadFiles+appId 可在
      // activate 完成前到达 → require 未命中；走 ensureApps 补载后再 require 一次（与下方默认
      // 解析分支的 ensureApps 兜底对称）。仍失败才落 defError。
      try {
        def = registry.require(openOpts.appId)
      } catch (err) {
        defError = err
        if (ensureApps) {
          try {
            // force：默认解析命中内置应用不代表目标插件已注册，须强制补载配置插件再重试
            await ensureApps(fileRef, { force: true })
          } catch {
            // 加载失败保持 defError
          }
          if (my !== seq) return
          try {
            def = registry.require(openOpts.appId)
            defError = null
          } catch {
            // 仍未命中：保持 defError（错误节点在 gate+takeOver 之后出，时机不变）
          }
        }
      }
    } else {
      def = registry.resolveDefault(fileRef)
      if (!def && ensureApps) {
        // lazy 插件首命中触发：未命中先尝试加载配置插件，再解析一次
        try {
          await ensureApps(fileRef)
        } catch {
          // 加载失败按未命中处理
        }
        if (my !== seq) return
        def = registry.resolveDefault(fileRef)
      }
    }
    // 实际拒绝线 = min(全局 REJECT, def.maxBytes)（R2-03）：def 未解析到（fallback/require 未命中）
    // 无限额可依，退回全局线
    const rejectBytes =
      def?.maxBytes !== undefined ? Math.min(PREVIEW_REJECT_BYTES, def.maxBytes) : PREVIEW_REJECT_BYTES
    // ===== Lane G4 尺寸总闸（appId 路径同样生效）=====
    // 闸序决策：先于 beforeDispose gate——「确认了却被旧实例暂缓」是体验割裂（用户为一次注定不生效的
    // open 付出确认成本），故先裁尺寸、后问旧实例；确认档被新链接管时走代际校验整体退出。
    // size 缺失/0（单文件模式伪条目）：无法判定，跳过本闸，下游渲染器自有上限兜底（见文件头层次注）。
    const sizeBytes = entry.size
    if (sizeBytes > 0) {
      if (sizeBytes > rejectBytes) {
        // 拒绝档：不取流不渲染不询问（渲染器限额类型不再「确认后仍被拒」，R2-03）；
        // 容器仍按常规链接管（gate→接管→拒绝节点），下载引导兜底
        const gate = await askBeforeDispose(instance)
        if (my !== seq) return
        if (!gate) return // 暂缓：拒绝节点不出，旧预览完整保留
        takeOver(entry, instance, current?.key ?? null)
        renderRejectedNode(entry, rejectBytes)
        return
      }
      if (sizeBytes > PREVIEW_CONFIRM_BYTES && confirmLargeFile) {
        // 确认档（size ≤ rejectBytes 已由上支保证）：仅宿主注入了确认 UI 才询问；
        // 同步抛/拒绝异常一律视为取消（宁可少渲染，不可误渲染）。
        // maxBytes ≤ CONFIRM 的类型两区段无交集（如 md/code 5MB）→ 根本不进确认带。
        let ok = false
        try {
          ok = await confirmLargeFile(entry, sizeBytes)
        } catch {
          ok = false
        }
        if (my !== seq) return // 确认挂起期间被新链/关闭接管：本链整体退出
        if (!ok) return // 取消：保持当前预览不变（复用 beforeDispose 暂缓的「零半更新」纪律）
      }
      // 确认档无回调：直接放行（默认策略与理由见 PreviewOptions.confirmLargeFile 注——宿主未注入
      // 确认 UI 时不得把中型文件变成死路，向后兼容）
    }
    const gate = await askBeforeDispose(instance)
    if (my !== seq) return // 已被更新的 open/close/clear/expire 接管：本链整体退出
    if (!gate) return // 暂缓：保留当前实例与容器内容，本次 open 不生效
    takeOver(entry, instance, current?.key ?? null)
    if (defError !== null) {
      renderErrorNode(entry, errMessage(defError), openOpts)
      return
    }
    if (!def) {
      renderFallback(entry)
      return
    }
    const ctx = createAppCtx({
      getObject: (key) => datasource.getObject(key),
      putObject: (key, data, contentType) => datasource.putObject(key, data, contentType),
      t,
      theme,
      notifyFileChanged,
      // 媒体直链能力透传（s3=presigned URL / url source=原始 URL；缺省不带，渲染器探测回落 Blob）
      ...(datasource.getMediaUrl ? { getMediaUrl: (key: string) => datasource.getMediaUrl!(key) } : {}),
      // 应用级故障出口透传（宿主接 bus 'error'——toast/换签重载; 缺省不带）
      ...(notifyAppError ? { notifyAppError: (err: { code: number; message: string }) => notifyAppError!(err) } : {}),
    })
    const el = document.createElement('div')
    el.className = 'mmf-preview-stage'
    container.appendChild(el)
    const outcome = await runRenderer(
      def,
      el,
      { key: entry.key, name: entry.name, size: entry.size },
      ctx,
      savedStates.get(entry.key),
      openOpts.appOptions,
    )
    if (my !== seq) {
      // 渲染期间被接管：丢弃结果（实例类则销毁），容器归新链所有
      if (outcome.status === 'ok' && outcome.instance) {
        try {
          outcome.instance.dispose()
        } catch {
          // 忽略
        }
      }
      return
    }
    if (outcome.status === 'failed') {
      container.innerHTML = ''
      renderErrorNode(entry, errMessage(outcome.error), openOpts)
      // 渲染失败上报宿主（源 401/403 → SdkError 4002/4003——宿主据此换签重载; 其余码 toast）
      const sdkErr = outcome.error as { code?: unknown; message?: unknown } | null
      notifyAppError?.({
        code: typeof sdkErr?.code === 'number' ? sdkErr.code : 0,
        message: typeof sdkErr?.message === 'string' ? sdkErr.message : errMessage(outcome.error),
      })
      return
    }
    instance = outcome.instance
  }

  return {
    open,
    async close(): Promise<boolean> {
      const my = ++seq
      const inst = instance
      const key = current?.key ?? null
      const gate = await askBeforeDispose(inst)
      if (my !== seq) return true // 已被后续 open/close/clear 接管：未暂缓
      if (!gate) return false // 被暂缓
      instance = null
      current = null
      teardown(inst, key)
      container.innerHTML = ''
      return true
    },
    expire(): void {
      seq++
      const inst = instance
      const key = current?.key ?? null
      instance = null
      current = null
      if (!inst) {
        container.innerHTML = ''
        return
      }
      // 通知式（契约：expired 只通知不询问）——reason 实参对插件可选透传（签名无参，插件可忽略）
      const notify = inst.beforeDispose as unknown as ((reason: 'expired') => unknown) | undefined
      try {
        notify?.('expired')
      } catch {
        // 通知异常不阻断销毁
      }
      teardown(inst, key)
      container.innerHTML = ''
    },
    clear(): void {
      seq++
      const inst = instance
      const key = current?.key ?? null
      instance = null
      current = null
      teardown(inst, key) // 强制语义：不走 gate（unmount 用）
      container.innerHTML = ''
    },
    current: () => current,
  }
}
