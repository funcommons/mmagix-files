/**
 * 客户端元数据索引 + 全局搜索（P0 Lane G2 组件级交付；Toolbar/Home 集成由主线收口）。
 *
 * 分层：
 *  - MetaStore：元数据持久化抽象（loadAll/put/clear/count）——IndexedDB 实现（浏览器常规路径）
 *    与内存实现（测试 / 无 idb 降级）可注入，本模块不引第三方 idb 库；
 *  - SearchIndex：scan（S3 delimiter='' 平铺翻页聚合入库）/ search（glob + size + type +
 *    rootPrefix 过滤，lastModified 降序，limit 截断）/ stats。
 *
 * 口径：
 *  - 只索引对象元数据（key/name/size/lastModified/rootPrefix），不取内容；仅存本地
 *    （词典 search.index-hint「仅存本地，不上传」与实现一致）；
 *  - 目录标记对象（key 以 '/' 结尾，mkdir 的 0 字节占位，见 tree-store.mkdir）不入索引——
 *    搜索语义是「找文件」；
 *  - cap（默认 50_000）防超大桶拖垮主线程/存储：遇到第 cap+1 个对象即停，返回 truncated:true，
 *    已拉取的部分照常入库（部分索引可用）；恰好 cap 个且无后续页则不算截断；
 *  - 每次扫描整体替换该 store 内容（clear+put）：索引是扫描时刻的快照，不做增量合并；
 *  - lastScanAt 只存内存（MetaStore 接口保持最小面）：会话重建后 stats 仅剩 count，重扫即恢复。
 */
import type { S3Client } from '@/sdk/types'
import { normalizePrefix } from './tree-store'

// ───────────────────────── 契约 ─────────────────────────

/** 索引行（对象元数据；rootPrefix 记录该行来自哪次扫描的根域） */
export interface MetaRow {
  key: string
  name: string
  size: number
  lastModified?: number
  rootPrefix: string
}

/** 元数据存储抽象：idb（持久）与 memory（测试/降级）双实现 */
export interface MetaStore {
  loadAll(): Promise<MetaRow[]>
  /** 按 key upsert（scan 前显式 clear，故 put 本身只做幂等覆盖） */
  put(rows: MetaRow[]): Promise<void>
  clear(): Promise<void>
  count(): Promise<number>
}

export interface ScanOptions {
  /** 每页聚合后回调（参数=已索引条数；0 起点先发一次，供 UI 显示进度） */
  onProgress?: (indexed: number) => void
  /** 索引条数上限（默认 50_000），超过即停并 truncated:true */
  cap?: number
}

export interface ScanResult {
  count: number
  truncated: boolean
}

export type SearchType = 'image' | 'video' | 'audio' | 'doc' | 'other'

export interface SearchQuery {
  /** fnmatch 风格 * ?；无通配符=包含匹配；空/缺省=不过滤 */
  glob?: string
  sizeMin?: number
  sizeMax?: number
  type?: SearchType
  /** 只取某次扫描根域下的行（规范化后精确比对） */
  rootPrefix?: string
  /** 返回上限（默认 200；结果已按 lastModified 降序，截断保留最新） */
  limit?: number
}

const DEFAULT_SCAN_CAP = 50_000
export const DEFAULT_SEARCH_LIMIT = 200

// ───────────────────────── 类型分类（按扩展名） ─────────────────────────

/** 扩展名 → 类型（小写、不带点；未命中=other）。刻意保守：歧义扩展名不收（如 .ts 传输流/TypeScript 两可）。 */
const EXT_TYPE: Record<string, Exclude<SearchType, 'other'>> = {
  // image
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image',
  bmp: 'image', ico: 'image', heic: 'image', heif: 'image', tif: 'image', tiff: 'image', avif: 'image',
  // video
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video',
  mpg: 'video', mpeg: 'video', wmv: 'video', flv: 'video',
  // audio
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio',
  opus: 'audio', wma: 'audio', aiff: 'audio', mid: 'audio',
  // doc（文档/表格/演示/纯文本标记）
  pdf: 'doc', doc: 'doc', docx: 'doc', xls: 'doc', xlsx: 'doc', ppt: 'doc', pptx: 'doc',
  csv: 'doc', tsv: 'doc', txt: 'doc', md: 'doc', rtf: 'doc',
  json: 'doc', xml: 'doc', yml: 'doc', yaml: 'doc', html: 'doc', htm: 'doc',
}

/** 按文件名扩展名分类；无扩展名/未命中=other（隐藏文件 .gitignore 视为无扩展名） */
export function classifyType(name: string): SearchType {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'other'
  return EXT_TYPE[name.slice(dot + 1).toLowerCase()] ?? 'other'
}

// ───────────────────────── glob（fnmatch 风格） ─────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 编译 glob 为谓词：`*`=任意串、`?`=单字符、`\x`=字面量 x（转义）；整体全名匹配。
 * 无通配符时退化为包含匹配（'report' 命中 'q3-report.pdf'）。
 * 大小写不敏感（客户端搜索惯例；fnmatch 平台差异收拢于此）。
 */
export function compileGlob(pattern: string): (name: string) => boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    const needle = pattern.toLowerCase()
    return (name) => name.toLowerCase().includes(needle)
  }
  let body = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string
    if (ch === '\\' && i + 1 < pattern.length) {
      i += 1
      body += escapeRegExp(pattern[i] as string)
    } else if (ch === '*') {
      body += '.*'
    } else if (ch === '?') {
      body += '.'
    } else {
      body += escapeRegExp(ch)
    }
  }
  const re = new RegExp(`^${body}$`, 'i')
  return (name) => re.test(name)
}

// ───────────────────────── SearchIndex ─────────────────────────

export class SearchIndex {
  private store: MetaStore
  private lastScanAt: number | null = null

  constructor(store: MetaStore) {
    this.store = store
  }

  /**
   * 平铺扫描入库：delimiter='' 翻页聚合到尽（复用 tree-store flatList 的 continuationToken
   * 循环口径）。进度按页回调；达到 cap 停止（truncated:true），已取部分照常入库。
   */
  async scan(prefix: string, client: S3Client, opts: ScanOptions = {}): Promise<ScanResult> {
    const cap = opts.cap ?? DEFAULT_SCAN_CAP
    const root = normalizePrefix(prefix)
    const rows: MetaRow[] = []
    let truncated = false
    let token: string | undefined
    opts.onProgress?.(0)
    do {
      const page = await client.list(
        root,
        token ? { delimiter: '', continuationToken: token } : { delimiter: '' },
      )
      for (const f of page.files) {
        if (f.key.endsWith('/')) continue // 目录标记对象不入索引
        if (rows.length >= cap) {
          truncated = true
          break
        }
        rows.push({ key: f.key, name: f.name, size: f.size, lastModified: f.lastModified, rootPrefix: root })
      }
      opts.onProgress?.(rows.length)
      token = page.continuationToken
    } while (token && !truncated)
    await this.store.clear()
    await this.store.put(rows)
    this.lastScanAt = Date.now()
    return { count: rows.length, truncated }
  }

  /** 全量过滤 + lastModified 降序 + limit 截断（稳定排序：并列时保持入库序） */
  async search(query: SearchQuery = {}): Promise<MetaRow[]> {
    const all = await this.store.loadAll()
    const root = query.rootPrefix !== undefined ? normalizePrefix(query.rootPrefix) : undefined
    const trimmed = query.glob?.trim()
    const glob = trimmed ? compileGlob(trimmed) : undefined
    const limit = Math.max(0, query.limit ?? DEFAULT_SEARCH_LIMIT)
    const hits = all.filter((row) => {
      if (root !== undefined && row.rootPrefix !== root) return false
      if (query.sizeMin !== undefined && row.size < query.sizeMin) return false
      if (query.sizeMax !== undefined && row.size > query.sizeMax) return false
      if (query.type !== undefined && classifyType(row.name) !== query.type) return false
      if (glob !== undefined && !glob(row.name)) return false
      return true
    })
    hits.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
    return hits.slice(0, limit)
  }

  /** 索引规模 + 最近扫描时刻（lastScanAt 内存态：重建实例后仅 count） */
  async stats(): Promise<{ count: number; lastScanAt?: number }> {
    const count = await this.store.count()
    return this.lastScanAt === null ? { count } : { count, lastScanAt: this.lastScanAt }
  }
}

// ───────────────────────── MetaStore 实现 ─────────────────────────

/** 内存实现（测试与降级共用；按 key upsert） */
export function createMemoryMetaStore(): MetaStore {
  const rows = new Map<string, MetaRow>()
  return {
    async loadAll() {
      return [...rows.values()]
    },
    async put(incoming) {
      for (const r of incoming) rows.set(r.key, r)
    },
    async clear() {
      rows.clear()
    },
    async count() {
      return rows.size
    },
  }
}

/** 索引库与两张表：objects=搜索元数据（v1 起）；uploads=上传断点（v2 起，见 checkpoint-store.ts） */
export const IDB_DB_NAME = 'mmagic-search'
const IDB_STORE = 'objects'
export const IDB_UPLOADS_STORE = 'uploads'
/** 库版本：v1=objects；v2=+uploads（schema 升级收口在 openSearchDb，调用方不得各开各的版本号） */
const IDB_DB_VERSION = 2

/**
 * 打开（或按需升级）索引库，schema 升级唯一收口于此（meta 与 checkpoint 两个实现共用）：
 *  - 全新库：一次建齐 objects + uploads（v0→v2）；
 *  - v1 旧库（仅 objects）：升 v2 补建 uploads，objects 及其数据原样保留；
 * 两处建表前均判 objectStoreNames.contains——升级事件只由首个打开者触发一次，
 * 但无论谁触发都必须建齐两表，否则后开的一方会在事务期报 store 不存在。
 */
export function openSearchDb(dbName: string = IDB_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, IDB_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(IDB_UPLOADS_STORE)) {
        db.createObjectStore(IDB_UPLOADS_STORE, { keyPath: 'fingerprint' })
      }
    }
    // 升级被旧标签页的旧版本连接阻塞 → 显式拒绝（否则 Promise 永不落定，搜索与断点全静默挂起）；
    // blocked → reject（快速失败+上层可见报错）；内存降级仅适用于环境无 indexedDB 的情形
    req.onblocked = () =>
      reject(
        new Error(
          `indexedDB.open('${dbName}', ${IDB_DB_VERSION}) 被其他标签页的旧版本连接阻塞（onblocked），请关闭旧标签页后重试`,
        ),
      )
    req.onsuccess = () => {
      const db = req.result
      // 自有连接让位：别处请求升级版本时主动关闭本连接（closed 后进行中的事务照常完成，仅不再发起新事务），
      // 避免反向把对方的 open 卡死在 blocked
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error(`indexedDB.open('${dbName}') 失败`))
  })
}

/**
 * IndexedDB 实现（原生 API，库/表：'mmagic-search'/'objects'，keyPath 'key'）。
 * SSR / jsdom / 隐私模式等无 indexedDB 环境降级内存实现并沿用同一接口——元数据本就只存
 * 本地、可随时重扫重建，降级只损失跨会话持久化，不损失正确性（jsdom 测试即走此分支）。
 */
export function createIdbMetaStore(dbName: string = IDB_DB_NAME): MetaStore {
  if (typeof indexedDB === 'undefined') return createMemoryMetaStore()

  let dbPromise: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => (dbPromise ??= openSearchDb(dbName))

  /** 单事务封装：run 发起请求（可无返回，如批量 put），complete 即 resolve */
  async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(IDB_STORE, mode)
      const store = t.objectStore(IDB_STORE)
      let result: T | undefined
      const req = run(store)
      if (req) req.onsuccess = () => { result = req.result }
      t.oncomplete = () => resolve(result as T)
      t.onerror = () => reject(t.error ?? new Error('indexedDB transaction 失败'))
      t.onabort = () => reject(t.error ?? new Error('indexedDB transaction 中止'))
    })
  }

  return {
    async loadAll() {
      return tx<MetaRow[]>('readonly', (s) => s.getAll() as IDBRequest<MetaRow[]>)
    },
    async put(rows) {
      await tx('readwrite', (s) => {
        for (const r of rows) s.put(r)
      })
    },
    async clear() {
      await tx('readwrite', (s) => s.clear())
    },
    async count() {
      return tx<number>('readonly', (s) => s.count())
    },
  }
}
