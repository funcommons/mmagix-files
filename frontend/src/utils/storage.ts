/**
 * storage — 统一的 localStorage JSON 序列化 helper.
 *
 * 替代散落的:
 *   function load() { try { return JSON.parse(localStorage.getItem(...)) } catch { ... } }
 *   function save(x) { try { localStorage.setItem(..., JSON.stringify(x)) } catch { ... } }
 *
 * 用法:
 *   const history = loadJSON<ToolHistoryItem[]>('ldx2.tools.history', [])
 *   saveJSON('ldx2.tools.history', history)
 *
 *   // 带命名空间前缀 (避免不同模块 key 冲突)
 *   const scene = loadJSON<Scene>('current-scene', defaults, { prefix: 'director:' })
 *
 * loadJSON/saveJSON 是命令式 API (适合 store 初始化、一次性 hydrate).
 * 如需响应式双向同步, 可自行封装 ref + watch + 本 helper.
 */

export interface LoadJSONOptions {
  /** key 前缀, 用于模块隔离 */
  prefix?: string
}

export function loadJSON<T>(key: string, fallback: T, options: LoadJSONOptions = {}): T {
  if (typeof window === 'undefined') return fallback
  try {
    // prefix 缺省时不得字符串拼接出 'undefined' 前缀（历史 bug：'undefined'+key 污染存储键）
    const raw = window.localStorage.getItem((options.prefix ?? '') + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export interface SaveJSONOptions {
  prefix?: string
}

export function saveJSON<T>(key: string, value: T, options: SaveJSONOptions = {}): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem((options.prefix ?? '') + key, JSON.stringify(value))
  } catch {
    // quota exceeded / private mode — silent
  }
}

/** 合并 fallback 与持久化值: 持久化值覆盖 fallback 的同名字段, 其他字段保留 fallback. */
export function mergeJSON<T extends object>(key: string, fallback: T, options: LoadJSONOptions = {}): T {
  const persisted = loadJSON<Partial<T>>(key, {}, options)
  return { ...fallback, ...persisted } as T
}
