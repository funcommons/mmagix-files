/**
 * 文件树 store · 回收站四方法测试（v1.2.0 M3）。
 * 契约：docs/design/capabilities-contract-v1.2.0.md §「M3 契约」——
 *   TrashEntry{key, deleteMarkerVersionId, deletedAt, versions} + listTrash / restoreTrash / purgeTrash / emptyTrash。
 * client 桩内联（listObjectVersions/deleteVersion 用 vi.fn），行序对齐 S3（key 升序、key 内新→旧）；
 * 分页桩按 maxKeys 切片并以 (keyMarker, versionIdMarker) 续拉，marker 对不上直接抛错以暴露实现误用。
 * 红态先行：四方法由 coder-G 在 tree-store.ts 落地后转绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, SdkError } from '@/sdk/errorCodes'
import type { S3Client } from '@/sdk/types'
import { createFileTree, TrashBatchError } from '@/files/tree-store'
import type { TrashEntry } from '@/files/tree-store'

/** ListObjectVersions 入参（对齐 S3Client 可选方法签名） */
interface ListVersionsOpts {
  prefix?: string
  keyMarker?: string
  versionIdMarker?: string
  maxKeys?: number
}

/** 桩内行形态：marker=true 即 DeleteMarker（无 size）；同 key 内压入序=新→旧 */
interface Row {
  key: string
  versionId: string
  isLatest: boolean
  lastModified?: number
  size?: number
  marker?: boolean
}

/** TrashEntry 构造器（restore/purge 入参；purge 只消费 key） */
const entry = (key: string, markerId: string, versions = 0, deletedAt = 1_700_000_000_000): TrashEntry => ({
  key, deleteMarkerVersionId: markerId, deletedAt, versions,
})

/**
 * 回收站域内存桩：
 * - listObjectVersions：prefix 过滤 + 按 key 升序稳定排序 + maxKeys 切片 + (keyMarker, versionIdMarker) 续拉；
 * - deleteVersion：可配失败集；可挂起（holdOn/releaseAll）并统计最大在途（并发断言用）。
 */
function makeStub() {
  const rows: Row[] = []
  const calls: ListVersionsOpts[] = []
  let maxKeys = 0 // 0 = 单页全量
  const listFailPrefixes = new Set<string>()
  const deleteFailIds = new Set<string>() // 命中 `${key}@${versionId}` 即抛
  let hold = false
  const gates: Array<() => void> = []
  let inflight = 0
  let maxInflight = 0

  const listObjectVersions = vi.fn(async (opts: ListVersionsOpts = {}) => {
    calls.push({ ...opts })
    if (listFailPrefixes.has(opts.prefix ?? '')) {
      throw new SdkError(ERROR_CODES.S3_ERROR, `list versions boom:${opts.prefix}`)
    }
    const ordered = rows
      .filter(r => r.key.startsWith(opts.prefix ?? ''))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) // 稳定：同 key 保持新→旧
    let start = 0
    const keyMarker = opts.keyMarker
    if (keyMarker !== undefined) {
      const vidMarker = opts.versionIdMarker
      if (vidMarker) {
        const i = ordered.findIndex(r => r.key === keyMarker && r.versionId === vidMarker)
        if (i < 0) throw new Error(`桩：续拉 marker 对不上 ${keyMarker}@${vidMarker}（实现续拉误用）`)
        start = i + 1
      } else {
        const i = ordered.findIndex(r => r.key > keyMarker)
        start = i < 0 ? ordered.length : i
      }
    }
    const size = maxKeys > 0 ? maxKeys : ordered.length
    const page = ordered.slice(start, start + size)
    const truncated = start + size < ordered.length
    const last = page[page.length - 1]
    return {
      versions: page.filter(r => !r.marker).map(r => ({
        key: r.key, versionId: r.versionId, isLatest: r.isLatest, lastModified: r.lastModified, size: r.size ?? 0,
      })),
      deleteMarkers: page.filter(r => r.marker).map(r => ({
        key: r.key, versionId: r.versionId, isLatest: r.isLatest, lastModified: r.lastModified,
      })),
      isTruncated: truncated,
      nextKeyMarker: truncated && last ? last.key : undefined,
      nextVersionIdMarker: truncated && last ? last.versionId : undefined,
    }
  })

  const deleteVersion = vi.fn(async (key: string, versionId: string): Promise<void> => {
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    try {
      if (deleteFailIds.has(`${key}@${versionId}`)) {
        throw new SdkError(ERROR_CODES.S3_ERROR, `delete boom:${key}@${versionId}`)
      }
      if (hold) await new Promise<void>(resolve => gates.push(resolve))
    } finally {
      inflight--
    }
  })

  /** 本套件只触达版本域两个方法，其余 S3Client 成员一律拒绝以暴露越界调用 */
  const never = () => vi.fn(async (): Promise<never> => { throw new Error('回收站用例不应触发的 S3Client 方法') })
  const client = {
    list: never(), get: never(), put: never(), head: never(), copy: never(), remove: never(),
    createMultipart: never(), uploadPart: never(), completeMultipart: never(), abortMultipart: never(),
    listObjectVersions,
    deleteVersion,
  } as unknown as S3Client

  return {
    client, listObjectVersions, deleteVersion, calls, listFailPrefixes, deleteFailIds,
    /** 压入一条 Version 行（latest：该 key 的最新实体版本） */
    ver(key: string, versionId: string, opts: { latest?: boolean; lastModified?: number; size?: number } = {}): void {
      rows.push({ key, versionId, isLatest: opts.latest === true, lastModified: opts.lastModified, size: opts.size ?? 1 })
    },
    /** 压入一条 DeleteMarker 行 */
    del(key: string, versionId: string, opts: { latest?: boolean; lastModified?: number } = {}): void {
      rows.push({ key, versionId, isLatest: opts.latest === true, lastModified: opts.lastModified, marker: true })
    },
    setMaxKeys(n: number): void { maxKeys = n },
    maxInflight: () => maxInflight,
    holdOn(): void { hold = true },
    releaseAll(): void { gates.splice(0).forEach(fn => fn()) },
  }
}

describe('文件树 store · 回收站四方法（M3）', () => {
  let stub: ReturnType<typeof makeStub>
  let client: S3Client
  const makeTree = () => createFileTree({ client })

  beforeEach(() => {
    stub = makeStub()
    client = stub.client
  })

  // ── listTrash ──────────────────────────────────────────────

  it('listTrash：多 key 分组——仅收 latest 为 DeleteMarker 的组；versions=实体 Version 数；deletedAt 取 marker LastModified', async () => {
    // docs/report.txt：删过 1 次（marker latest + 3 个实体版本）→ 入站
    stub.del('docs/report.txt', 'mk-r', { latest: true, lastModified: 1_700_000_000_000 })
    stub.ver('docs/report.txt', 'v-r3', { size: 30, lastModified: 1_699_999_990_000 })
    stub.ver('docs/report.txt', 'v-r2', { size: 20 })
    stub.ver('docs/report.txt', 'v-r1', { size: 10 })
    // docs/old.txt：删过又重传（latest 是实体版本，旧 marker isLatest=false）→ 不入站
    stub.ver('docs/old.txt', 'v-old2', { latest: true, size: 5 })
    stub.del('docs/old.txt', 'mk-old', { lastModified: 1_699_000_000_000 })
    stub.ver('docs/old.txt', 'v-old1')
    // live.txt：从未删除（latest 为实体版本）→ 不入站
    stub.ver('live.txt', 'v-live', { latest: true, size: 9 })
    // docs/nested/a.txt：marker latest + 1 实体版本 → 入站
    stub.del('docs/nested/a.txt', 'mk-a', { latest: true, lastModified: 1_700_000_050_000 })
    stub.ver('docs/nested/a.txt', 'v-a1')
    // x/only-marker.bin：仅剩一个 marker（实体版本 0 个）→ 入站
    stub.del('x/only-marker.bin', 'mk-x', { latest: true, lastModified: 1_700_000_060_000 })

    const entries = await makeTree().listTrash()
    expect(entries.map(e => e.key).sort()).toEqual(['docs/nested/a.txt', 'docs/report.txt', 'x/only-marker.bin'])
    const byKey = new Map(entries.map(e => [e.key, e]))
    expect(byKey.get('docs/report.txt')).toEqual({
      key: 'docs/report.txt',
      deleteMarkerVersionId: 'mk-r',
      deletedAt: 1_700_000_000_000,
      versions: 3,
    })
    expect(byKey.get('docs/nested/a.txt')).toEqual({
      key: 'docs/nested/a.txt', deleteMarkerVersionId: 'mk-a', deletedAt: 1_700_000_050_000, versions: 1,
    })
    expect(byKey.get('x/only-marker.bin')).toEqual({
      key: 'x/only-marker.bin', deleteMarkerVersionId: 'mk-x', deletedAt: 1_700_000_060_000, versions: 0,
    })
    expect(stub.calls).toHaveLength(1) // 单页数据不产生续拉
  })

  it('listTrash：latest 为实体版本的 key 不入站——删后又覆盖写的历史 marker 不算（latest 两种形态对照）', async () => {
    stub.ver('kept.txt', 'v2', { latest: true }) // 覆盖写的新版本
    stub.del('kept.txt', 'mk1', { lastModified: 1_690_000_000_000 }) // 历史 marker（isLatest=false）
    stub.ver('kept.txt', 'v1')
    stub.ver('gone.txt', 'v1', { latest: true }) // 对照组：latest=Version，也不入站
    expect(await makeTree().listTrash()).toEqual([])
  })

  it('listTrash：isTruncated 用 nextKeyMarker/nextVersionIdMarker 续拉到尽；分组跨页聚合', async () => {
    stub.setMaxKeys(2)
    // 压入序=同 key 内新→旧；10 行 → 5 页
    stub.del('a/one.txt', 'm1', { latest: true, lastModified: 1111 })
    stub.ver('a/one.txt', 'v1a')
    stub.del('b/two.txt', 'm2', { latest: true, lastModified: 2222 })
    stub.ver('b/two.txt', 'v2b')
    stub.ver('b/two.txt', 'v2b-old')
    stub.ver('c/live.txt', 'v3live', { latest: true }) // 唯一行，对照组
    stub.del('d/three.txt', 'm4', { latest: true, lastModified: 4444 })
    stub.ver('d/three.txt', 'v4d')
    stub.del('e/four.txt', 'm5', { latest: true, lastModified: 5555 })
    stub.ver('e/four.txt', 'v5e')

    const entries = await makeTree().listTrash()
    // 续拉标记逐页对齐（第 2 页页尾是 Version 行——versionIdMarker 必须用它，漏传会丢 v2b-old）
    expect(stub.calls.map(c => ({ keyMarker: c.keyMarker, versionIdMarker: c.versionIdMarker }))).toEqual([
      {},
      { keyMarker: 'a/one.txt', versionIdMarker: 'v1a' }, // 页尾行（桩回传值）
      { keyMarker: 'b/two.txt', versionIdMarker: 'v2b' },
      { keyMarker: 'c/live.txt', versionIdMarker: 'v3live' },
      { keyMarker: 'd/three.txt', versionIdMarker: 'v4d' },
    ])
    expect(entries.map(e => e.key).sort()).toEqual(['a/one.txt', 'b/two.txt', 'd/three.txt', 'e/four.txt'])
    const byKey = new Map(entries.map(e => [e.key, e]))
    expect(byKey.get('b/two.txt')?.versions).toBe(2) // marker 在第 2 页、末版本在第 3 页，跨页归组
    expect(byKey.get('a/one.txt')?.deletedAt).toBe(1111)
    expect(byKey.get('d/three.txt')?.deletedAt).toBe(4444)
  })

  it('listTrash：prefix 透传给 listObjectVersions，仅返回命中前缀的条目', async () => {
    stub.del('docs/gone.txt', 'mk-d', { latest: true, lastModified: 1_700_000_000_000 })
    stub.ver('docs/keep.txt', 'v-k', { latest: true })
    stub.del('photos/gone.png', 'mk-p', { latest: true })

    const entries = await makeTree().listTrash({ prefix: 'docs/' })
    expect(stub.calls[0]?.prefix).toBe('docs/')
    expect(entries).toEqual([
      { key: 'docs/gone.txt', deleteMarkerVersionId: 'mk-d', deletedAt: 1_700_000_000_000, versions: 0 },
    ])
  })

  it('listTrash：空桶（无任何版本行）返回空数组', async () => {
    expect(await makeTree().listTrash()).toEqual([])
  })

  // ── restoreTrash ───────────────────────────────────────────

  it('restoreTrash：逐条 deleteVersion(key, marker id)；空数组零调用', async () => {
    const tree = makeTree()
    await tree.restoreTrash([])
    expect(stub.deleteVersion).not.toHaveBeenCalled()
    await tree.restoreTrash([entry('a/gone.txt', 'mk-1', 2), entry('b/c/gone.bin', 'mk-2', 0)])
    expect(stub.deleteVersion.mock.calls).toEqual([
      ['a/gone.txt', 'mk-1'],
      ['b/c/gone.bin', 'mk-2'],
    ])
  })

  it('restoreTrash：并发 3——受控 promise 桩断言最大同时在途恰为 3 且恒不超 3', async () => {
    const entries = ['k1', 'k2', 'k3', 'k4', 'k5'].map((k, i) => entry(`${k}.txt`, `mk-${i + 1}`, 1))
    stub.holdOn()
    const p = makeTree().restoreTrash(entries)
    await vi.waitFor(() => expect(stub.deleteVersion).toHaveBeenCalledTimes(3))
    expect(stub.maxInflight()).toBe(3) // 闸门挂起时仍打满 3 路（串行=1、无上限=5 都会挂在这）
    stub.releaseAll()
    await vi.waitFor(() => expect(stub.deleteVersion).toHaveBeenCalledTimes(5))
    expect(stub.maxInflight()).toBe(3) // 放行后补位仍未超 3
    stub.releaseAll()
    await expect(p).resolves.toBeUndefined()
    expect(stub.deleteVersion.mock.calls).toEqual(entries.map(e => [e.key, e.deleteMarkerVersionId]))
  })

  // ── purgeTrash ─────────────────────────────────────────────

  it('purgeTrash：全版本删除——Version+DeleteMarker 都删（3 Version+2 Marker → 5 次 deleteVersion，跨页聚合）', async () => {
    stub.setMaxKeys(2) // 迫使该 key 的 5 行跨 3 页
    stub.del('docs/report.txt', 'mk-b', { latest: true, lastModified: 1_700_000_000_000 })
    stub.ver('docs/report.txt', 'v3', { size: 3 })
    stub.ver('docs/report.txt', 'v2', { size: 2 })
    stub.del('docs/report.txt', 'mk-a', { lastModified: 1_690_000_000_000 }) // 更早一次删除的残留 marker
    stub.ver('docs/report.txt', 'v1', { size: 1 })

    await makeTree().purgeTrash([entry('docs/report.txt', 'mk-b', 3)])
    expect(stub.listObjectVersions).toHaveBeenCalledWith({ prefix: 'docs/report.txt' })
    expect([...stub.deleteVersion.mock.calls].sort((a, b) => (a[1] < b[1] ? -1 : 1))).toEqual([
      ['docs/report.txt', 'mk-a'],
      ['docs/report.txt', 'mk-b'],
      ['docs/report.txt', 'v1'],
      ['docs/report.txt', 'v2'],
      ['docs/report.txt', 'v3'],
    ])
  })

  it('purgeTrash：单条失败不中断——其余 key 仍被清；结尾聚合抛错且消息含失败 key 清单', async () => {
    // a.txt：1 marker + 2 实体版本，全部成功
    stub.del('a.txt', 'mk-a', { latest: true })
    stub.ver('a.txt', 'av1')
    stub.ver('a.txt', 'av2')
    // b.txt：1 marker + 1 实体版本，全部失败
    stub.del('b.txt', 'mk-b', { latest: true })
    stub.ver('b.txt', 'bv1')
    // c.txt：仅 1 marker，失败
    stub.del('c.txt', 'mk-c', { latest: true })
    stub.deleteFailIds.add('b.txt@bv1').add('b.txt@mk-b').add('c.txt@mk-c')

    const err = await makeTree()
      .purgeTrash([entry('a.txt', 'mk-a'), entry('b.txt', 'mk-b'), entry('c.txt', 'mk-c')])
      .then(() => null, (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toContain('b.txt')
    expect(err?.message).toContain('c.txt')
    // 其余 key 仍被清：a.txt 三个版本号全删
    expect(stub.deleteVersion).toHaveBeenCalledWith('a.txt', 'mk-a')
    expect(stub.deleteVersion).toHaveBeenCalledWith('a.txt', 'av1')
    expect(stub.deleteVersion).toHaveBeenCalledWith('a.txt', 'av2')
    // 失败条目也是逐 versionId 尝试过（而非整条跳过）
    expect(stub.deleteVersion).toHaveBeenCalledWith('b.txt', 'bv1')
    expect(stub.deleteVersion).toHaveBeenCalledWith('b.txt', 'mk-b')
    expect(stub.deleteVersion).toHaveBeenCalledWith('c.txt', 'mk-c')
  })

  it('purgeTrash：listObjectVersions 失败同属单条失败——不中断其余 key，聚合错误含该 key', async () => {
    stub.del('ok.txt', 'mk-1', { latest: true })
    stub.ver('ok.txt', 'ov1')
    stub.listFailPrefixes.add('bad.txt')

    const err = await makeTree()
      .purgeTrash([entry('ok.txt', 'mk-1'), entry('bad.txt', 'mk-x')])
      .then(() => null, (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toContain('bad.txt')
    expect(stub.deleteVersion).toHaveBeenCalledWith('ok.txt', 'mk-1')
    expect(stub.deleteVersion).toHaveBeenCalledWith('ok.txt', 'ov1')
  })

  // ── emptyTrash ─────────────────────────────────────────────

  it('emptyTrash：listTrash→purgeTrash 全部，purged=条目数（非版本数）', async () => {
    stub.del('docs/g1.txt', 'mk-1', { latest: true })
    stub.ver('docs/g1.txt', 'v1')
    stub.ver('docs/g1.txt', 'v2')
    stub.del('photos/p1.png', 'mk-2', { latest: true })
    stub.ver('photos/p1.png', 'pv1')
    stub.ver('alive.txt', 'v-live', { latest: true }) // 未删除，不动

    await expect(makeTree().emptyTrash()).resolves.toEqual({ purged: 2 }) // 2 条（5 个版本号）
    expect(stub.deleteVersion).toHaveBeenCalledTimes(5)
    expect(stub.deleteVersion).toHaveBeenCalledWith('docs/g1.txt', 'v1')
    expect(stub.deleteVersion).toHaveBeenCalledWith('docs/g1.txt', 'v2')
    expect(stub.deleteVersion).toHaveBeenCalledWith('docs/g1.txt', 'mk-1')
    expect(stub.deleteVersion).toHaveBeenCalledWith('photos/p1.png', 'pv1')
    expect(stub.deleteVersion).toHaveBeenCalledWith('photos/p1.png', 'mk-2')
    expect(stub.deleteVersion).not.toHaveBeenCalledWith('alive.txt', 'v-live')
  })

  it('emptyTrash：prefix 过滤——仅清指定前缀下的条目并透传 prefix', async () => {
    stub.del('docs/g1.txt', 'mk-1', { latest: true })
    stub.del('photos/p1.png', 'mk-2', { latest: true })

    await expect(makeTree().emptyTrash({ prefix: 'docs/' })).resolves.toEqual({ purged: 1 })
    expect(stub.calls[0]?.prefix).toBe('docs/') // listTrash 前缀透传
    expect(stub.deleteVersion).toHaveBeenCalledTimes(1)
    expect(stub.deleteVersion).toHaveBeenCalledWith('docs/g1.txt', 'mk-1')
    expect(stub.deleteVersion).not.toHaveBeenCalledWith('photos/p1.png', 'mk-2')
  })

  it('emptyTrash：无可清条目 → purged 0 且零 deleteVersion', async () => {
    stub.ver('alive.txt', 'v1', { latest: true })
    await expect(makeTree().emptyTrash()).resolves.toEqual({ purged: 0 })
    expect(stub.deleteVersion).not.toHaveBeenCalled()
  })
})

// ───────────── 评审守卫（R1 fixer-G + R2 fixer-K 落地语义钉，只加不改）─────────────

describe('评审守卫（R1+R2 修复语义钉）', () => {
  let stub: ReturnType<typeof makeStub>
  let client: S3Client
  let restoreInfo: () => void
  const makeTree = () => createFileTree({ client })

  beforeEach(() => {
    stub = makeStub()
    client = stub.client
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {}) // 吞 purge 的留痕行，保持输出干净
    restoreInfo = () => spy.mockRestore()
  })
  afterEach(() => { restoreInfo() })

  it('①restoreTrash 失败聚合：抛 TrashBatchError，failedDetails 逐条 `${key}: ${cause.message}`', async () => {
    stub.deleteFailIds.add('k1.txt@mk-1')
    const err = await makeTree()
      .restoreTrash([entry('k1.txt', 'mk-1'), entry('k2.txt', 'mk-2')])
      .then(() => null, (e: unknown) => e as TrashBatchError)
    expect(err).toBeInstanceOf(TrashBatchError)
    expect(err?.message).toContain('恢复失败')
    expect(err?.message).toContain('k1.txt')
    expect(err?.failedDetails).toEqual(['k1.txt: delete boom:k1.txt@mk-1'])
    expect(stub.deleteVersion).toHaveBeenCalledWith('k2.txt', 'mk-2') // 停取只拦新任务，首波在途照常发出
  })

  it('②stop 停取：6 条目并发 3 首条 reject——失败后不再取新任务（总调用 <6），在途落定后聚合', async () => {
    stub.deleteFailIds.add('k1.txt@mk-1')
    const entries = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((k, i) => entry(`${k}.txt`, `mk-${i + 1}`))
    await expect(makeTree().restoreTrash(entries)).rejects.toBeInstanceOf(TrashBatchError)
    expect(stub.deleteVersion.mock.calls.length).toBeLessThan(6) // k4-k6 未被发起
  })

  it('③purge 复验跳过陈旧条目：latest 已是实体 Version → 零 deleteVersion、不抛错、计 skipped', async () => {
    stub.ver('stale.txt', 'sv1', { latest: true }) // listTrash 快照后已被恢复/覆盖写
    stub.del('ok.txt', 'mk-o', { latest: true })
    stub.ver('ok.txt', 'ov1')
    await expect(makeTree().purgeTrash([entry('stale.txt', 'mk-stale'), entry('ok.txt', 'mk-o')]))
      .resolves.toEqual({ skipped: 1 })
    expect(stub.deleteVersion.mock.calls).toEqual([['ok.txt', 'ov1'], ['ok.txt', 'mk-o']])
    expect(stub.deleteVersion).not.toHaveBeenCalledWith('stale.txt', expect.anything())
  })

  it('④deletedAt：marker 行缺 LastModified → null（非 0）', async () => {
    stub.del('nulled.txt', 'mk-n', { latest: true }) // 不给 lastModified
    const entries = await makeTree().listTrash()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.deletedAt).toBeNull()
  })

  it('⑤purge 零行 key：不进 skipped、零删除、不抛错', async () => {
    stub.del('ok.txt', 'mk-o', { latest: true }) // 对照：不因空 key 拦住其余条目
    await expect(makeTree().purgeTrash([entry('empty.txt', 'mk-e'), entry('ok.txt', 'mk-o')]))
      .resolves.toEqual({ skipped: 0 }) // 零行 ≠ 复验跳过
    expect(stub.deleteVersion).toHaveBeenCalledTimes(1)
    expect(stub.deleteVersion).toHaveBeenCalledWith('ok.txt', 'mk-o')
    expect(stub.deleteVersion).not.toHaveBeenCalledWith('empty.txt', expect.anything())
  })

  it('⑥purged=实清数：emptyTrash 混入 stale key 只清真删条目；purgeTrash 直喂陈旧快照返回 { skipped: 1 }', async () => {
    const tree = makeTree()
    // (a) emptyTrash：rows = 真删 key + stale key（latest 实体版本，listTrash 天然不收）→ purged 只算真清的
    stub.del('real.txt', 'mk-r', { latest: true })
    stub.ver('stale.txt', 'sv1', { latest: true })
    await expect(tree.emptyTrash()).resolves.toEqual({ purged: 1 }) // 非 2
    expect(stub.deleteVersion.mock.calls).toEqual([['real.txt', 'mk-r']])
    // (b) purgeTrash 直喂 2 条目（1 真删 + 1 陈旧快照）→ 清 1 跳 1（快照后 key 被恢复的场景）
    stub.del('real.txt', 'mk-r2', { latest: true }) // 模拟快照后再次删除
    await expect(tree.purgeTrash([entry('real.txt', 'mk-r2'), entry('stale.txt', 'mk-stale')]))
      .resolves.toEqual({ skipped: 1 })
    expect(stub.deleteVersion).toHaveBeenCalledWith('real.txt', 'mk-r2')
    expect(stub.deleteVersion).not.toHaveBeenCalledWith('stale.txt', expect.anything())
  })
})

describe('回归钉：client 方法脱 this 调用（2026-10-29 demo 实证）', () => {
  it('listTrash/restoreTrash 以绑定形态调用——client 方法可依赖 this（方法内走 this.request）', async () => {
    // 真 client 的 S3 方法全走 this.request；require* 助手若返回未绑定引用，this 即 undefined
    const calls: string[] = []
    const boundClient = {
      ...({} as S3Client),
      listObjectVersions: function (this: { tag: string }) {
        calls.push(`list:${this.tag}`)
        return Promise.resolve({
          versions: [], deleteMarkers: [
            { key: 'a.txt', versionId: 'mk-1', isLatest: true, lastModified: 1_700_000_000_000 },
          ],
          isTruncated: false,
        })
      },
      deleteVersion: function (this: { tag: string }, _k: string, _v: string) {
        calls.push(`del:${this.tag}`)
        return Promise.resolve()
      },
    } as S3Client & { tag?: string }
    Object.defineProperty(boundClient, 'tag', { value: 'bound' })
    const tree = createFileTree({ client: boundClient })

    const entries = await tree.listTrash!()
    await tree.restoreTrash!(entries)
    expect(calls).toEqual(['list:bound', 'del:bound'])
  })
})
