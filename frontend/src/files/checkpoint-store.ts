/**
 * 分片上传断点持久化：multipart 上传中断后按 fingerprint 取回 uploadId/已传分片，
 * 续传只补缺失分片，避免整文件重传。
 *
 * 分层：
 *  - CheckpointStore：load / put（按 fingerprint upsert）/ remove / listAll，IDB 与内存双实现可注入；
 *  - IDB 实现：复用 search-index 的 'mmagic-search' 库（uploads 表，keyPath 'fingerprint'），
 *    建库/schema 升级收口在该模块的 openSearchDb，本模块只按表名开事务，不自己管版本号；
 *  - 内存实现：无 indexedDB 环境（SSR / jsdom / 隐私模式）降级——断点本就只存本地，丢了最多
 *    重新整传，降级只损失跨会话续传，不损失正确性。
 */
import { IDB_DB_NAME, IDB_UPLOADS_STORE, openSearchDb } from './search-index'

// ───────────────────────── 契约 ─────────────────────────

/** 上传断点行（fingerprint 作主键；createdAt/updatedAt 由调用方维护，store 不加工） */
export interface UploadCheckpoint {
  /** 文件指纹（内容摘要或 size+mtime 组合），同一文件续传的寻址键 */
  fingerprint: string
  /** 目标对象 key */
  path: string
  size: number
  lastModified: number
  /** 分片大小（字节），complete 时据此校验分片覆盖完整性 */
  partSize: number
  /** S3 multipart uploadId（中断后凭它续传同一 upload 会话） */
  uploadId: string
  /** 已上传成功的分片（number 为分片号，etag 为 S3 回填的响应头原样值） */
  parts: { number: number; etag: string }[]
  createdAt: number
  updatedAt: number
}

/** 断点存储抽象：idb（持久）与 memory（测试/降级）双实现 */
export interface CheckpointStore {
  /** 无断点返回 null（区别于空） */
  load(fingerprint: string): Promise<UploadCheckpoint | null>
  /** 按 fingerprint upsert（同键整体覆盖旧行，parts 以调用方传入为准） */
  put(row: UploadCheckpoint): Promise<void>
  remove(fingerprint: string): Promise<void>
  listAll(): Promise<UploadCheckpoint[]>
}

// ───────────────────────── 实现 ─────────────────────────

/** 内存实现（测试与降级共用；按 fingerprint upsert） */
export function createMemoryCheckpointStore(): CheckpointStore {
  const rows = new Map<string, UploadCheckpoint>()
  return {
    async load(fingerprint) {
      return rows.get(fingerprint) ?? null
    },
    async put(row) {
      rows.set(row.fingerprint, row)
    },
    async remove(fingerprint) {
      rows.delete(fingerprint)
    },
    async listAll() {
      return [...rows.values()]
    },
  }
}

/**
 * IndexedDB 实现（原生 API，库/表：'mmagic-search'/'uploads'，keyPath 'fingerprint'）。
 * 无 indexedDB 环境降级内存实现（口径与 createIdbMetaStore 一致：只损失跨会话续传，
 * 不损失正确性；jsdom 测试即走此分支）。
 */
export function createIdbCheckpointStore(dbName: string = IDB_DB_NAME): CheckpointStore {
  if (typeof indexedDB === 'undefined') return createMemoryCheckpointStore()

  // 打开即升级（v1→v2 迁移契约）：创建工厂就发起 open（建表/补版本收口在 openSearchDb），
  // 不等首次 CRUD——调用方「只创建不写」时库也必须已升 v2；兜底 catch 防 open 失败在
  // 无人 await 窗口期报 unhandledrejection（首个 tx await 时错误原样抛出，语义不变）。
  const dbPromise: Promise<IDBDatabase> = openSearchDb(dbName)
  dbPromise.catch(() => {})
  const open = (): Promise<IDBDatabase> => dbPromise

  /** 单事务封装（与 createIdbMetaStore 同手法，指向 uploads 表）：complete 即 resolve */
  async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(IDB_UPLOADS_STORE, mode)
      const store = t.objectStore(IDB_UPLOADS_STORE)
      let result: T | undefined
      const req = run(store)
      if (req) req.onsuccess = () => { result = req.result }
      t.oncomplete = () => resolve(result as T)
      t.onerror = () => reject(t.error ?? new Error('indexedDB transaction 失败'))
      t.onabort = () => reject(t.error ?? new Error('indexedDB transaction 中止'))
    })
  }

  return {
    async load(fingerprint) {
      return (await tx<UploadCheckpoint | undefined>('readonly', (s) => s.get(fingerprint))) ?? null
    },
    async put(row) {
      await tx('readwrite', (s) => s.put(row))
    },
    async remove(fingerprint) {
      await tx('readwrite', (s) => s.delete(fingerprint))
    },
    async listAll() {
      return tx<UploadCheckpoint[]>('readonly', (s) => s.getAll() as IDBRequest<UploadCheckpoint[]>)
    },
  }
}
