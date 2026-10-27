/**
 * AppCtx 工厂——把数据面实现（工作台=S3Client / 单文件=UrlSourceProvider）装配成插件能力面
 * 契约：《docs/design/plugin-system.md》V1.1 §二 ctx 能力面 + notify→fileChanged 映射表
 */
import type { AppCtx, FileChangedPayload } from '../sdk/types'

export interface NotifySink {
  /** 装配层接 bus.emit('fileChanged', payload) */
  (payload: FileChangedPayload): void
}

export interface AppCtxDeps {
  getObject(key: string): Promise<Blob>
  putObject(key: string, data: Blob, contentType?: string): Promise<void>
  /** params 具名插值实参透传（R2-03/R2-05：渲染器超限文案 {limit}） */
  t(key: string, params?: Record<string, unknown>): string
  theme: Record<string, string>
  /** fileChanged 出口 */
  notifyFileChanged: NotifySink
  /** 可选能力：媒体直链透传（s3=presigned / url source=原始 URL；缺省=ctx 不带该键） */
  getMediaUrl?: (key: string) => string
  /** 可选能力：应用级故障上报 → 宿主 bus 'error' 事件（缺省=ctx 不带该键, 渲染器探测回落静默） */
  notifyAppError?: (err: { code: number; message: string }) => void
}

/** notify type → fileChanged action 映射（契约正本：《docs/design/plugin-system.md》§二） */
export function mapNotifyAction(type: 'saved' | 'changed' | 'deleted' | 'renamed'): FileChangedPayload['action'] {
  switch (type) {
    case 'saved':
    case 'changed':
      return 'put'
    case 'deleted':
      return 'delete'
    case 'renamed':
      return 'rename'
  }
}

export function createAppCtx(deps: AppCtxDeps): AppCtx {
  return {
    getObject: (key) => deps.getObject(key),
    putObject: (key, data, contentType) => deps.putObject(key, data, contentType),
    // 无 params 时保持单参调用（零可观察变化，既有 1 参 deps.t/宿主包装器不受影响）
    t: (key, params) => (params === undefined ? deps.t(key) : deps.t(key, params)),
    theme: deps.theme,
    notify: (type, payload) => {
      // html-open-rejected = html-viewer 外链代理拒绝面（非法 scheme 等）——非文件变更,
      // 不误入 notifyFileChanged; 控制台留痕（用户可见提示通道候批）
      if (type === 'html-open-rejected') {
        console.warn('[mmx] html open rejected:', (payload as { url?: string }).url)
        return
      }
      deps.notifyFileChanged({ key: (payload as { key: string }).key, action: mapNotifyAction(type), from: (payload as { from?: string }).from })
    },
    // 条件展开：能力缺省时 ctx 上不带该键（渲染器按 getMediaUrl? 探测，回落 Blob 路径）
    ...(deps.getMediaUrl ? { getMediaUrl: (key: string) => deps.getMediaUrl!(key) } : {}),
    ...(deps.notifyAppError ? { notifyAppError: (err: { code: number; message: string }) => deps.notifyAppError!(err) } : {}),
  }
}
