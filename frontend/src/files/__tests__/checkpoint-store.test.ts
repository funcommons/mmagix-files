/**
 * checkpoint-store 契约红测试（v1.2.0 M1/M2：断点续传 checkpoint 持久层，契约先行）。
 *
 * 被测模块 src/files/checkpoint-store.ts 尚未实现——本文件钉住契约：
 *  - CheckpointStore 四方法（load/put/remove/listAll）在 IDB 与内存双实现下逐条等价
 *    （往返相等 / 未命中 null / remove / upsert / listAll 全量与序无关 / parts 保真）；
 *  - IDB 落默认库 'mmagic-search'，版本 2，新增 store 'uploads'（keyPath 'fingerprint'）；
 *  - v1→v2 迁移：既有 'objects' store 及其数据必须原样保留（与 search-index 同库共存）；
 *  - 无 indexedDB 环境（SSR/jsdom/隐私模式）降级内存实现（与 createIdbMetaStore 同口径）。
 *
 * IDB 手法：jsdom 原生无 indexedDB（见 search-index.test.ts 降级用例的前置钉住），故每用例
 * `vi.stubGlobal('indexedDB', new IDBFactory())` 注入全新 fake-indexeddb 工厂——库不跨用例残留。
 *
 * 已知口径（fake-indexeddb 6.2.6 实证，spec 一致）：
 *  - 对已升 v2 的库 `open(name, 1)`（createIdbMetaStore 现状硬编码）按 spec 抛 VersionError——
 *    因此迁移后读 'objects' 用裸事务直读，不经 createIdbMetaStore；实现侧若要让 search-index
 *    继续可用需另行调整其 open 版本口径（不在本测试范围）；
 *  - `open(name)`（版本号省略）=按现版本打开，可与既有连接并存，用于迁移后裸读断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdbCheckpointStore, createMemoryCheckpointStore } from '../checkpoint-store'
import type { CheckpointStore, UploadCheckpoint } from '../checkpoint-store'
import type { MetaRow } from '../search-index'

/** 契约默认库名（与 search-index 的 IDB_DB_NAME 同库） */
const DB = 'mmagic-search'

/** v1 时代的 MetaRow 形状种子（migration 用：v1→v2 后必须原样仍在 objects 里） */
const V1_META_ROW: MetaRow = {
  key: 'root/legacy.txt',
  name: 'legacy.txt',
  size: 7,
  lastModified: 1_700_000_000_000,
  rootPrefix: 'root/',
}

/** checkpoint 行构造器：字段齐全的合法行，仅覆写关注的字段 */
const mkCheckpoint = (over: Partial<UploadCheckpoint> = {}): UploadCheckpoint => ({
  fingerprint: 'fp-default',
  path: 'root/big.bin',
  size: 32 * 1024 * 1024,
  lastModified: 1_700_000_000_000,
  partSize: 8 * 1024 * 1024,
  uploadId: 'upload-id-1',
  parts: [{ number: 1, etag: 'etag-1' }],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...over,
})

// ───────────────────────── 裸 IDB 工具（走被 stub 的全局 indexedDB，DOM 类型口径） ─────────────────────────

/** 打开库：版本号省略=按现版本打开（迁移后裸读用）；upgrade 在 onupgradeneeded 里建 store */
function openRaw(name: string, version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
    req.onupgradeneeded = () => upgrade?.(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error(`indexedDB.open('${name}') 失败`))
  })
}

/** 单事务封装（镜像 search-index.ts 的 tx 手法）：run 发请求，complete 即 resolve */
function txRaw<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(storeName, mode)
    let result: T | undefined
    const req = run(t.objectStore(storeName))
    if (req) req.onsuccess = () => { result = req.result }
    t.oncomplete = () => resolve(result as T)
    t.onerror = () => reject(t.error ?? new Error('indexedDB transaction 失败'))
    t.onabort = () => reject(t.error ?? new Error('indexedDB transaction 中止'))
  })
}

/** 手工建 v1 库：只有 objects store（keyPath 'key'），写入一条 MetaRow 后关闭连接 */
async function seedV1(dbName: string): Promise<void> {
  const db = await openRaw(dbName, 1, (d) => {
    d.createObjectStore('objects', { keyPath: 'key' })
  })
  await txRaw(db, 'objects', 'readwrite', (s) => { s.put(V1_META_ROW) })
  db.close()
}

/** 裸读某 store 全部行（迁移后验证 objects 旧数据用） */
function getAllRaw<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return txRaw<T[]>(db, storeName, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
}

// ───────────────────────── 双实现共用契约套件 ─────────────────────────

/**
 * 契约等价套件：IDB 实现与内存实现必须逐条通过同一组用例（换实现不换契约）。
 * make() 每次返回独立实例（同一测试内可多次取，共享同一底层存储语义）。
 */
function contractSuite(title: string, make: () => CheckpointStore): void {
  describe(title, () => {
    it('put→load 往返相等（全字段，时间戳不被改写）', async () => {
      const store = make()
      const cp = mkCheckpoint({ fingerprint: 'fp-rt' })
      await store.put(cp)
      expect(await store.load('fp-rt')).toEqual(cp)
    })

    it('load 不存在的 fingerprint 返回 null（而非抛错/undefined）', async () => {
      const store = make()
      expect(await store.load('never-seen')).toBeNull()
    })

    it('remove 后 load=null、listAll 清空；remove 不存在的 key 不抛', async () => {
      const store = make()
      await store.put(mkCheckpoint({ fingerprint: 'fp-rm' }))
      await store.remove('fp-rm')
      expect(await store.load('fp-rm')).toBeNull()
      expect(await store.listAll()).toEqual([])
      await expect(store.remove('never-existed')).resolves.toBeUndefined()
    })

    it('put 同 fingerprint 覆盖（upsert）：读新值、listAll 不重复累积', async () => {
      const store = make()
      await store.put(mkCheckpoint({
        fingerprint: 'fp-u', uploadId: 'old-id', parts: [{ number: 1, etag: 'e1' }], updatedAt: 1,
      }))
      await store.put(mkCheckpoint({
        fingerprint: 'fp-u', uploadId: 'new-id',
        parts: [{ number: 1, etag: 'e1' }, { number: 2, etag: 'e2' }], updatedAt: 2,
      }))
      const loaded = await store.load('fp-u')
      expect(loaded?.uploadId).toBe('new-id')
      expect(loaded?.parts).toHaveLength(2)
      expect(loaded?.updatedAt).toBe(2)
      expect(await store.listAll()).toHaveLength(1)
    })

    it('listAll 全量返回且与写入序无关；行间互不串扰', async () => {
      const store = make()
      // 刻意按 fingerprint 逆序写入（IDB getAll 按主键序、内存按插入序——返回序不是契约，集合才是）
      const fps = ['fp-c', 'fp-a', 'fp-b']
      for (const f of fps) await store.put(mkCheckpoint({ fingerprint: f, uploadId: `u-${f}` }))
      const all = await store.listAll()
      expect(all.map((c) => c.fingerprint).sort()).toEqual(['fp-a', 'fp-b', 'fp-c'])
      for (const c of all) expect(c.uploadId).toBe(`u-${c.fingerprint}`)
      // remove 中间一行，其余行原样（隔离性）
      await store.remove('fp-b')
      expect((await store.listAll()).map((c) => c.fingerprint).sort()).toEqual(['fp-a', 'fp-c'])
      expect(await store.load('fp-a')).toEqual(mkCheckpoint({ fingerprint: 'fp-a', uploadId: 'u-fp-a' }))
    })

    it('parts 多分片保真：12 片升序写入原样读回（顺序与字段不丢）', async () => {
      const store = make()
      const parts = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, etag: `etag-${i + 1}` }))
      const cp = mkCheckpoint({
        fingerprint: 'fp-parts', size: 100 * 1024 * 1024, partSize: 8 * 1024 * 1024, parts,
      })
      await store.put(cp)
      expect(await store.load('fp-parts')).toEqual(cp)
    })
  })
}

// ───────────────────────── IDB 实现（fake-indexeddb 注入） ─────────────────────────

describe('createIdbCheckpointStore（fake-indexeddb）', () => {
  beforeEach(() => {
    // 每用例注入全新工厂：库不跨用例残留；实现侧经全局 indexedDB 取到它
    vi.stubGlobal('indexedDB', new IDBFactory())
  })

  contractSuite('契约等价（IDB 实现）', () => createIdbCheckpointStore(DB))

  it('建库：默认库名 mmagic-search、版本 2、uploads store（keyPath fingerprint）真实落盘', async () => {
    const store = createIdbCheckpointStore() // dbName 缺省 → 'mmagic-search'
    const cp = mkCheckpoint({ fingerprint: 'fp-db' })
    await store.put(cp)
    // 绕开被测 API 裸读：证明数据真的落进 IDB 的 uploads store，而非内存影子
    const db = await openRaw(DB)
    expect(db.version).toBe(2)
    expect(db.objectStoreNames.contains('uploads')).toBe(true)
    expect(await getAllRaw<UploadCheckpoint>(db, 'uploads')).toEqual([cp])
    db.close()
  })

  it('迁移 v1→v2：既有 objects store 及数据原样保留，uploads 可正常 CRUD（同库共存）', async () => {
    await seedV1(DB) // 先有 v1（只有 objects + 一条 MetaRow），连接已关闭
    const store = createIdbCheckpointStore(DB) // 打开即升 v2、建 uploads
    // 升级后 objects 旧数据仍在（裸事务直读；不经 createIdbMetaStore——见文件头 VersionError 口径）
    {
      const db = await openRaw(DB)
      expect(db.version).toBe(2)
      expect(db.objectStoreNames.contains('objects')).toBe(true)
      expect(await getAllRaw<MetaRow>(db, 'objects')).toEqual([V1_META_ROW])
      db.close()
    }
    // uploads 在迁移后的库里正常 CRUD
    const cpA = mkCheckpoint({ fingerprint: 'fp-a' })
    const cpB = mkCheckpoint({ fingerprint: 'fp-b' })
    await store.put(cpA)
    await store.put(cpB)
    expect(await store.load('fp-a')).toEqual(cpA)
    await store.remove('fp-a')
    expect((await store.listAll()).map((c) => c.fingerprint)).toEqual(['fp-b'])
    // CRUD 之后 objects 数据依旧原样（迁移不因后续写而被清）
    {
      const db = await openRaw(DB)
      expect(await getAllRaw<MetaRow>(db, 'objects')).toEqual([V1_META_ROW])
      db.close()
    }
  })
})

// ───────────────────────── 内存实现 ─────────────────────────

describe('createMemoryCheckpointStore', () => {
  contractSuite('契约等价（内存实现）', () => createMemoryCheckpointStore())
})

// ───────────────────────── 降级路径 ─────────────────────────

describe('createIdbCheckpointStore 降级：无 indexedDB 环境', () => {
  it('indexedDB 缺席（SSR/jsdom/隐私模式）→ 降级为可用的内存实现，契约不破', async () => {
    // 前置钉住：本文件未引 fake-indexeddb/auto，jsdom 原生无 indexedDB。
    // 若未来环境内置 idb，这里先红，提示把降级分支改成显式注入路径来测（与 search-index.test.ts 同守则）。
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    expect(typeof indexedDB === 'undefined' || indexedDB === null).toBe(true)
    vi.stubGlobal('indexedDB', undefined) // 再显式钉死降级判定路径
    const store = createIdbCheckpointStore(DB)
    const cp = mkCheckpoint({ fingerprint: 'fp-deg' })
    await store.put(cp)
    expect(await store.load('fp-deg')).toEqual(cp)
    await store.put(mkCheckpoint({ fingerprint: 'fp-deg-2' }))
    expect((await store.listAll()).map((c) => c.fingerprint).sort()).toEqual(['fp-deg', 'fp-deg-2'])
    await store.remove('fp-deg')
    expect(await store.load('fp-deg')).toBeNull()
    expect(await store.listAll()).toHaveLength(1)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
