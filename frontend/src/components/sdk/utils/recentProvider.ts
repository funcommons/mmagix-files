/**
 * recentProvider — 最近列表后端抽象 + 默认 localStorage 实现 + Vue 集成.
 *
 * 业务可通过 FcImagePicker 的 recentProvider prop 注入自己的 backend (服务端 API,
 * IndexedDB, 跨账号隔离等), 不再绑死 localStorage.
 *
 * 用法 (业务侧):
 *   // 1. 默认 (localStorage)
 *   <FcImagePicker v-model="url" />
 *
 *   // 2. 自定义 key (兼容老 API)
 *   <FcImagePicker v-model="url" recent-storage-key="my:recent" />
 *
 *   // 3. 自定义后端
 *   const apiProvider: RecentProvider<string> = {
 *     load:  () => api.getRecentImages(),
 *     add:   (url) => api.pushRecentImage(url),
 *     remove:(url) => api.deleteRecentImage(url),
 *     clear: () => api.clearRecentImages(),
 *   }
 *   <FcImagePicker v-model="url" :recent-provider="apiProvider" />
 *
 *   // 4. localStorage 但跨账号隔离
 *   <FcImagePicker :recent-provider="createLocalStorageRecentProvider(`fc:recent:${userId}`)" />
 */
import { ref, type Ref } from 'vue'

export interface RecentProvider<T> {
  /** 拉取当前完整列表 (顺序敏感, 业务自行维护 LRU 顺序). */
  load(): Promise<T[]>
  /** 加入一条 (默认实现会去重 + 前置 + 截断, 业务可覆盖语义). */
  add(item: T): Promise<void>
  /** 删除一条. */
  remove(item: T): Promise<void>
  /** 清空. */
  clear(): Promise<void>
}

export interface LocalStorageRecentOptions<T> {
  /** 最多保留条数, 默认 12 */
  limit?: number
  /** 添加前过滤 (返回 false 跳过) */
  validate?: (item: T) => boolean
}

/**
 * 默认实现: 自含 localStorage LRU（去重前置 + 截断），对外暴露 async 接口.
 *
 * 2026-10-29 修复：原实现走 useRecentList 但调了其上不存在的 list.add/list.getAll/
 * list.clear（实际为 pick/list/clear——pick 存）→ load/add 一调即抛 TypeError，
 * useRecentProvider 的 catch 全部吞掉 → 「最近使用」静默失效。本实现不依赖 useRecentList，
 * 直接 loadJSON/saveJSON 精确对齐 RecentProvider 契约（T 为 string URL 或带 id 对象均可——
 * 去重按全等比较）。存储键沿用 'ux:recent:<key>' 形状（旧实现从未写成功，无数据迁移面）。
 */
export function createLocalStorageRecentProvider<T>(
  key: string,
  options: LocalStorageRecentOptions<T> = {},
): RecentProvider<T> {
  const storageKey = `ux:recent:${key}`
  const limit = options.limit ?? 12

  const readAll = (): T[] => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw === null ? [] : (JSON.parse(raw) as T[])
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const writeAll = (items: T[]): void => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(items.slice(0, limit)))
    } catch {
      // quota / private mode — silent
    }
  }

  /** 条目等价：string 直等；对象经 JSON 持久化往返后引用不同 → 序列化比较 */
  const same = (a: T, b: T): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

  return {
    load: async () => readAll(),
    add: async (item: T) => {
      if (options.validate && !options.validate(item)) return
      writeAll([item, ...readAll().filter((x) => !same(x, item))])
    },
    remove: async (item: T) => {
      writeAll(readAll().filter((x) => !same(x, item)))
    },
    clear: async () => {
      try {
        window.localStorage.removeItem(storageKey)
      } catch {
        // silent
      }
    },
  }
}

export interface UseRecentProviderResult<T> {
  items: Ref<T[]>
  ready: Ref<boolean>
  add: (item: T) => Promise<void>
  remove: (item: T) => Promise<void>
  clear: () => Promise<void>
  getAll: () => T[]
}

/**
 * 把任意 RecentProvider 包成 Vue 友好的 ref + 乐观更新.
 * - mount 时调一次 provider.load() 填 items
 * - add/remove/clear 先更新本地 items (乐观), 再 await provider.X
 * - provider 失败时本地 items 仍保留, 不回滚 (避免复杂; 失败 log warn)
 */
export function useRecentProvider<T>(
  provider: RecentProvider<T>,
  limit = 12,
): UseRecentProviderResult<T> {
  const items = ref<T[]>([]) as Ref<T[]>
  const ready = ref(false)
  const log = {
    warn: (...args: unknown[]) => console.warn(...args),
  }

  function applyLoaded(list: T[]) {
    items.value = list.slice(0, limit)
    ready.value = true
  }

  // mount: 异步拉取 (错误降级为空)
  provider.load().then(applyLoaded).catch((err) => {
    log.warn('[useRecentProvider] load failed:', err)
    ready.value = true  // ready 仍标 true, 业务可以正常用 (只是空的)
  })

  async function add(item: T) {
    // 乐观: 去重 + 前置 + 截断
    const next = [item, ...items.value.filter((x) => x !== item)].slice(0, limit)
    items.value = next
    try {
      await provider.add(item)
    } catch (err) {
      log.warn('[useRecentProvider] add failed:', err)
    }
  }

  async function remove(item: T) {
    items.value = items.value.filter((x) => x !== item)
    try {
      await provider.remove(item)
    } catch (err) {
      log.warn('[useRecentProvider] remove failed:', err)
    }
  }

  async function clear() {
    items.value = []
    try {
      await provider.clear()
    } catch (err) {
      log.warn('[useRecentProvider] clear failed:', err)
    }
  }

  function getAll(): T[] {
    return [...items.value]
  }

  return { items, ready, add, remove, clear, getAll }
}