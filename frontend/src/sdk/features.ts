/**
 * 功能开关门控（契约：《docs/operations/user-guide.md》V1.0 features 全集与命令映射）
 * 语义：default 全开，config.features 显式 false 覆盖（false 优先）；UI 隐藏+API 拒绝（4301）双层执法
 */
import { ERROR_CODES, SdkError } from './errorCodes'

/** 全集与命令映射（手册 §一 features 表） */
export const FEATURE_DEFAULTS: Record<string, boolean> = {
  upload: true,
  delete: true,
  rename: true,
  mkdir: true,
  download: true,
  multiTab: true,
  openWithMenu: true,
  plugins: true,
}

/** 合并配置：显式 false 优先，未列出的键用默认值（未知键原样保留，只增不删纪律） */
export function resolveFeatures(configFeatures?: Record<string, boolean>): Record<string, boolean> {
  return { ...FEATURE_DEFAULTS, ...(configFeatures ?? {}) }
}

/** 门控判定：仅显式 false 关闭（缺省=未配置=默认放开，对齐"default 全开、false 优先"），关闭即整链禁用（调用方 throw 4301） */
export function requireFeature(features: Record<string, boolean>, key: string): void {
  if (features[key] === false) {
    throw new SdkError(ERROR_CODES.FEATURE_DISABLED, `功能已关闭：features.${key}=false`)
  }
}

/**
 * features.plugins 总闸（《docs/design/plugin-system.md》§一：「插件加载受配置 features.plugins 总闸控制」）。
 * 仅显式 false 关闭（缺省=开，与 requireFeature 同判据）。false → 装配层不建 PluginLoader、
 * 不载配置注入的 plugins[]、不提供 ensureApps——动态插件整链不存在；registerApp 命令口
 * 另有 requireFeature(features, 'plugins') 兜底拒绝（4301）。
 */
export function pluginsEnabled(features?: Record<string, boolean>): boolean {
  return resolveFeatures(features).plugins !== false
}
