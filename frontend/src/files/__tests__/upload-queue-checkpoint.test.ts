/**
 * M2 断点上传测试（test-writer-D；契约：documents/v1.2.0执行进度.md §「M2 契约」，
 * 方案：documents/v1.2.0升级方案-断点上传-分享增强-在线解压-回收站.md §2）。
 * 覆盖：effectivePartSize 自适应分片（纯函数 + maxParts 接线）/ checkpointStore 生命周期
 * （入队 put、每片更 parts、complete/abort/终态失败 remove、直传不写）/ resumeCheckpoints
 * 探活（uploadId 不在存活清单→移除）/ 单片重试（网络错/5xx 重试 ≤partRetry、退避 ×2^n+抖动、
 * 4xx 与 4901 不重试）/ onProgress 参数化进度。
 *
 * 前提与假设（实现落地时若口径不同，改这里的错误构造/类型别名，不改断言语义）：
 *  - M2 新参数以局部超集类型 M2Params 承载（UploadParams 扩展前 vue-tsc 不红；实现给
 *    UploadParams 增加同名字段后自然对齐）。
 *  - 可重试判别沿用 s3/client.ts 错误映射约定：SdkError(S3_ERROR, msg, { status })——
 *    status===0（网络错）或 ≥500（5xx）可重试；400~499 语义错与 UPLOAD_ABORTED_CODE(4901) 不重试。
 *  - ResumeCandidate 形状契约未钉死，按最小寻址集断言：{ fingerprint, path, size, uploadId }。
 *  - effectivePartSize / resumeCheckpoints 经可选成员访问——实现未落地时给单例明确红态
 *    （而非 import 期语法错误盖掉全文件）。
 *  - 退避用 fake timers：driveUntil 以 20ms 虚拟步进驱动并返回累计虚拟毫秒（±20ms 量化），
 *    Math.random 桩 0 时抖动归零，可精确断言 500ms→1000ms→2000ms。
 * 与既有 upload-queue.test.ts 并列，不改动它（client 桩另造，专配分片错误脚本/存活清单）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, SdkError } from '@/sdk/errorCodes'
import type { S3Client, S3ListResult } from '@/sdk/types'
import { UPLOAD_ABORTED_CODE, UploadQueue } from '@/files/upload-queue'
import * as queueModule from '@/files/upload-queue'
import type { UploadParams } from '@/files/upload-queue'
import { createMemoryCheckpointStore } from '@/files/checkpoint-store'
import type { CheckpointStore, UploadCheckpoint } from '@/files/checkpoint-store'

// ───────────────────────── 契约承载（M2 未落地部分的可选访问） ─────────────────────────

/** M2 追加参数（进度文档 §M2：maxParts/partRetry/partRetryBaseMs/checkpointStore/onProgress） */
type M2Params = UploadParams & {
  maxParts?: number
  partRetry?: number
  partRetryBaseMs?: number
  checkpointStore?: CheckpointStore
  onProgress?: (p: { bytes: number; total: number; rate?: number }) => void
}

/** effectivePartSize（M2 新导出纯函数）：未导出时给出明确红态 */
function effectivePartSize(size: number, basePartSize: number, maxParts: number): number {
  const mod = queueModule as typeof queueModule & {
    effectivePartSize?: (size: number, basePartSize: number, maxParts: number) => number
  }
  if (!mod.effectivePartSize) throw new Error('effectivePartSize 未导出（M2 契约）')
  return mod.effectivePartSize(size, basePartSize, maxParts)
}

/** resumeCheckpoints 候选（契约未钉死形状；按最小寻址集断言，实现可携额外字段） */
interface ResumeCandidate {
  fingerprint: string
  path: string
  size: number
  uploadId: string
}

async function resumeCheckpoints(q: UploadQueue): Promise<ResumeCandidate[]> {
  const fn = (q as unknown as { resumeCheckpoints?: () => Promise<ResumeCandidate[]> }).resumeCheckpoints
  if (!fn) throw new Error('UploadQueue.resumeCheckpoints 未实现（M2 契约）')
  return fn.call(q)
}

// ───────────────────────── 测试基建 ─────────────────────────

/** 网络/5xx（契约可重试）与 4xx/取消（不重试）错误构造——沿用 client.ts detail={status} 约定 */
const netErr = (msg = 'network down') => new SdkError(ERROR_CODES.S3_ERROR, msg, { status: 0 })
const serverErr = (msg = 'HTTP 500') => new SdkError(ERROR_CODES.S3_ERROR, msg, { status: 500 })
const clientErr = (msg = 'HTTP 400') => new SdkError(ERROR_CODES.S3_ERROR, msg, { status: 400 })

const file = (name: string, size: number, o: { type?: string; lastModified?: number } = {}) =>
  new File([new Uint8Array(size)], name, {
    ...(o.type !== undefined ? { type: o.type } : {}),
    ...(o.lastModified !== undefined ? { lastModified: o.lastModified } : {}),
  })

/** 内存 S3：调用序列 + 每片错误脚本（依序抛出、耗尽即成功）+ 存活 multipart 清单 + 分片闸门 */
class FakeCheckpointClient implements S3Client {
  calls: string[] = []
  /** key#n → 分片上传调用时刻序列（fake timers 下与虚拟时钟同源） */
  partTimes: { tag: string; t: number }[] = []
  bodies = new Map<string, number>()
  parts = new Map<string, Map<number, number>>()
  completed: { key: string; uploadId: string; parts: { partNumber: number; etag: string }[] }[] = []
  abortCalls: string[] = []
  createdUploadIds = new Map<string, string>()
  /** resumeCheckpoints 探活用的存活 multipart 清单（?uploads 回包） */
  liveUploads: { key: string; uploadId: string; initiated?: string }[] = []
  /** key#partNumber → 依序抛出的错误脚本（空/耗尽后该片成功） */
  partErrors = new Map<string, SdkError[]>()
  /** 非空时 uploadPart 挂起直到放行（观测初写 checkpoint/abort 竞态） */
  partGate: Promise<void> | null = null
  puts: string[] = []

  async put(key: string): Promise<{ etag: string }> {
    this.calls.push(`put:${key}`)
    this.puts.push(key)
    return { etag: `etag-${key}` }
  }
  async uploadPart(key: string, _uploadId: string, partNumber: number, body: Blob): Promise<{ etag: string }> {
    const tag = `${key}#${partNumber}`
    this.calls.push(`part:${tag}`)
    this.partTimes.push({ tag, t: Date.now() })
    if (this.partGate) await this.partGate
    const script = this.partErrors.get(tag)
    if (script && script.length > 0) throw script.shift()!
    let m = this.parts.get(key)
    if (!m) { m = new Map(); this.parts.set(key, m) }
    m.set(partNumber, body.size)
    return { etag: `etag-${partNumber}` }
  }
  async createMultipart(key: string): Promise<{ uploadId: string }> {
    this.calls.push(`create:${key}`)
    const uploadId = `up-${key}`
    this.createdUploadIds.set(key, uploadId)
    return { uploadId }
  }
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    this.calls.push(`complete:${key}`)
    const m = this.parts.get(key)
    this.bodies.set(key, parts.reduce((sum, p) => sum + (m?.get(p.partNumber) ?? 0), 0))
    this.parts.delete(key)
    this.completed.push({ key, uploadId, parts })
  }
  async abortMultipart(key: string, _uploadId: string): Promise<void> {
    this.calls.push(`abort:${key}`)
    this.abortCalls.push(key)
    this.parts.delete(key)
  }
  async listMultipartUploads(): Promise<{ key: string; uploadId: string; initiated?: string }[]> {
    this.calls.push('uploads')
    return this.liveUploads
  }
  async list(prefix: string): Promise<S3ListResult> { return { prefix, dirs: [], files: [] } }
  async get(): Promise<Response> { throw new Error('未实现') }
  async head(): Promise<{ exists: boolean }> { return { exists: false } }
  async copy(): Promise<void> { throw new Error('未实现') }
  async remove(): Promise<void> { throw new Error('未实现') }
}

const partAttempts = (client: FakeCheckpointClient, tag: string): number =>
  client.partTimes.filter(x => x.tag === tag).length

/** 内存 checkpoint store + 观测：调用序列 + put 快照（防实现原地复用行对象致断言失真） */
function makeStore() {
  const inner = createMemoryCheckpointStore()
  const calls: string[] = []
  const puts: UploadCheckpoint[] = []
  const store: CheckpointStore = {
    async load(fp) { calls.push(`load:${fp}`); return inner.load(fp) },
    async put(row) {
      calls.push(`put:${row.fingerprint}`)
      puts.push({ ...row, parts: row.parts.map(p => ({ ...p })) })
      await inner.put(row)
    },
    async remove(fp) { calls.push(`remove:${fp}`); await inner.remove(fp) },
    async listAll() { calls.push('listAll'); return inner.listAll() },
  }
  return { store, inner, calls, puts }
}

/** 组装队列 + 终态回调记录 */
function makeQueue(client: FakeCheckpointClient, params: M2Params = {}) {
  const done: { id: string; key: string }[] = []
  const failed: { id: string; err: unknown }[] = []
  const q = new UploadQueue({
    client,
    params,
    hooks: {
      onDone: (id, key) => done.push({ id, key }),
      onFailed: (id, err) => failed.push({ id, err }),
    },
  })
  return { q, done, failed }
}

/** fake timers 虚拟步进驱动：直到谓词成立，返回累计虚拟毫秒（±stepMs 量化，退避窗口断言用） */
async function driveUntil(pred: () => boolean, { stepMs = 20, maxMs = 10000 } = {}): Promise<number> {
  let waited = 0
  while (!pred() && waited < maxMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
    waited += stepMs
  }
  expect(pred(), `驱动 ${waited}ms（虚拟）后条件仍未成立`).toBe(true)
  return waited
}

/** 预置 checkpoint 行（fingerprint 仅作唯一键用） */
const mkRow = (
  seed: string, path: string, size: number, lastModified: number,
  partSize: number, uploadId: string, parts: { number: number; etag: string }[],
): UploadCheckpoint => ({
  fingerprint: `fp-${seed}`.padEnd(64, '0'),
  path, size, lastModified, partSize, uploadId, parts,
  createdAt: 1, updatedAt: 2,
})

// ───────────────────────── effectivePartSize ─────────────────────────

describe('effectivePartSize（自适应分片纯函数）', () => {
  it('= max(basePartSize, pow2ceil(size/maxParts))：小文件保底 base，大文件自动放大', () => {
    const MB = 1024 * 1024
    // 小文件：size/maxParts < base → 保底 basePartSize（不缩片）
    expect(effectivePartSize(25, 10, 10000)).toBe(10)
    expect(effectivePartSize(2 ** 30, 8 * MB, 10000)).toBe(8 * MB) // 1GB/10000≈107KB → 仍取 8MB
    // 大文件放大：pow2ceil(size/maxParts) 超过 base 时取 pow2ceil
    expect(effectivePartSize(100 * 2 ** 30, 8 * MB, 10000)).toBe(16 * MB) // 10737418.24 → 2^24
    expect(effectivePartSize(500 * 2 ** 30, 8 * MB, 10000)).toBe(64 * MB) // 53687091.2 → 2^26
    expect(effectivePartSize(2 ** 40, 8 * MB, 10000)).toBe(128 * MB) // 1TB → 2^27
    // 幂边界：恰为 2 的幂取本身；非幂向上取整
    expect(effectivePartSize(16, 4, 4)).toBe(4)
    expect(effectivePartSize(17, 4, 4)).toBe(8)
  })

  it('保证片数 ≤ maxParts（S3/OSS ≤10000 硬约束）', () => {
    const MB = 1024 * 1024
    const cases: { size: number; base: number; maxParts: number }[] = [
      { size: 500 * 2 ** 30, base: 8 * MB, maxParts: 10000 },
      { size: 2 ** 40, base: 8 * MB, maxParts: 10000 },
      { size: 2 ** 30, base: 8 * MB, maxParts: 4 }, // maxParts 越小放大越多
      { size: 100, base: 8, maxParts: 3 },
    ]
    for (const { size, base, maxParts } of cases) {
      const partSize = effectivePartSize(size, base, maxParts)
      expect(partSize).toBeGreaterThanOrEqual(base) // 恒 ≥ basePartSize
      expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(maxParts) // 片数 ≤ maxParts
    }
    expect(effectivePartSize(2 ** 30, 8 * MB, 4)).toBe(256 * MB) // 2^30/4=2^28 → 256MB → 恰 4 片
  })
})

// ───────────────────────── checkpointStore 生命周期 ─────────────────────────

describe('checkpointStore 生命周期', () => {
  it('multipart 入队即 put：行字段齐全（fingerprint=sha256hex、path、size、partSize、uploadId）', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    const res = q.enqueue([file('big.bin', 25, { lastModified: 1111 })], 'docs/')
    expect(done).toHaveLength(0) // 同步入队即有断点先于完成
    await vi.waitFor(() => expect(s.puts.length).toBeGreaterThanOrEqual(1))
    const row = s.puts[0]!
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/) // sha256hex
    expect(row.path).toBe('docs/big.bin') // path 来源=前缀拼接后的对象 key
    expect(row.size).toBe(25)
    expect(row.lastModified).toBe(1111)
    expect(row.partSize).toBe(10)
    expect(row.uploadId).toBe(client.createdUploadIds.get('docs/big.bin')) // 与 createMultipart 回包一致
    expect(row.parts).toEqual([]) // 初写时尚无已落分片
    expect(typeof row.createdAt).toBe('number')
    expect(typeof row.updatedAt).toBe('number')
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(q.status(res.accepted[0]!.id)).toBe('done')
  })

  it('fingerprint 确定性：同 path:size:lastModified 同指纹；任一不同即不同（sha256hex 64 位）', async () => {
    const fpFor = async (f: File): Promise<string> => {
      const client = new FakeCheckpointClient()
      const s = makeStore()
      const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
      q.enqueue([f], 'docs/')
      await vi.waitFor(() => expect(done).toHaveLength(1))
      expect(s.puts.length).toBeGreaterThanOrEqual(1)
      return s.puts[0]!.fingerprint
    }
    const fp = await fpFor(file('a.bin', 25, { lastModified: 1000 }))
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(await fpFor(file('a.bin', 25, { lastModified: 1000 }))).toBe(fp) // 确定性：续传寻址键稳定
    expect(await fpFor(file('a.bin', 25, { lastModified: 2000 }))).not.toBe(fp) // lastModified 变
    expect(await fpFor(file('a.bin', 26, { lastModified: 1000 }))).not.toBe(fp) // size 变
    expect(await fpFor(file('b.bin', 25, { lastModified: 1000 }))).not.toBe(fp) // path 变
  })

  it('每片成功更新 parts：初写空 → 逐片回填 {number, etag}，complete 前已含全部分片', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    let release!: () => void
    client.partGate = new Promise<void>(r => { release = r })
    q.enqueue([file('g.bin', 25)])
    await vi.waitFor(() => expect(s.puts.length).toBeGreaterThanOrEqual(1))
    expect(s.puts[0]!.parts).toEqual([]) // 入队即写：分片未落
    release()
    await vi.waitFor(() => expect(done).toHaveLength(1))
    // 注：complete 后断点行已被移除（互斥用例「complete 后 remove → load=null」钉死该契约），
    // 逐片回填终态只能经 put 快照观测——实现侧三条流（逐片回写/complete 清行/终态失败清行）
    // 落笔时刻任务已终态，「remove 后存在复活行」与清行契约互斥（实现方缺陷证明成立，故不 load）。
    expect(s.puts.length).toBeGreaterThanOrEqual(2) // 初写之后还有逐片更新
    expect(s.puts.at(-1)!.parts).toEqual([
      { number: 1, etag: 'etag-1' },
      { number: 2, etag: 'etag-2' },
      { number: 3, etag: 'etag-3' },
    ]) // 末次回写快照=全部分片（complete 清行前的最终断点态）
  })

  it('complete 后 remove：store.load(fingerprint)=null', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    q.enqueue([file('c.bin', 25)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    const fp = s.puts[0]!.fingerprint
    expect(await s.inner.load(fp)).toBeNull()
    expect(s.calls).toContain(`put:${fp}`)
    expect(s.calls).toContain(`remove:${fp}`)
    expect(s.calls.indexOf(`remove:${fp}`)).toBeGreaterThan(s.calls.indexOf(`put:${fp}`))
  })

  it('abort（分片中）→ remove checkpoint + abortMultipart 清理，取消语义不被掩盖', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q, done, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    let release!: () => void
    client.partGate = new Promise<void>(r => { release = r })
    const res = q.enqueue([file('h.bin', 25)])
    await vi.waitFor(() => expect(s.puts.length).toBeGreaterThanOrEqual(1))
    const fp = s.puts[0]!.fingerprint
    expect(q.abort(res.accepted[0]!.id)).toBe(true)
    expect(await s.inner.load(fp)).toBeNull() // 取消即清断点
    expect(client.abortCalls).toContain('h.bin') // 服务端分片一并清理
    release()
    await vi.waitFor(() => expect(failed).toHaveLength(1))
    expect(done).toHaveLength(0)
    expect((failed[0]!.err as SdkError).code).toBe(UPLOAD_ABORTED_CODE)
    expect(await s.inner.load(fp)).toBeNull()
  })

  it('终态失败（4xx 不重试）→ remove checkpoint', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    client.partErrors.set('i.bin#2', [clientErr()])
    const res = q.enqueue([file('i.bin', 25)])
    await vi.waitFor(() => expect(failed).toHaveLength(1))
    expect(q.status(res.accepted[0]!.id)).toBe('failed')
    const fp = s.puts[0]!.fingerprint
    expect(await s.inner.load(fp)).toBeNull()
    expect(s.calls).toContain(`remove:${fp}`)
  })

  it('≤阈值单 PUT 直传不写 checkpoint（零 put/remove/load）', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q, done } = makeQueue(client, { multipartThreshold: 100, checkpointStore: s.store })
    q.enqueue([file('small.txt', 1)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(s.calls).toEqual([])
    expect(await s.inner.listAll()).toEqual([])
  })
})

// ───────────────────────── resumeCheckpoints 探活 ─────────────────────────

describe('resumeCheckpoints（跨会话续传候选）', () => {
  it('listAll→listMultipartUploads 探活：存活→候选；uploadId 不在存活清单→从 store remove', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q } = makeQueue(client, { checkpointStore: s.store })
    const live = mkRow('a', 'docs/a.bin', 25, 1000, 10, 'up-live', [{ number: 1, etag: 'etag-1' }])
    const dead = mkRow('b', 'docs/b.bin', 25, 1000, 10, 'up-dead', [])
    await s.inner.put(live)
    await s.inner.put(dead)
    client.liveUploads = [{ key: 'docs/a.bin', uploadId: 'up-live', initiated: '2026-10-20T00:00:00.000Z' }]
    const cands = await resumeCheckpoints(q)
    expect(cands).toHaveLength(1)
    expect(cands[0]).toMatchObject({
      fingerprint: live.fingerprint,
      path: 'docs/a.bin',
      size: 25,
      uploadId: 'up-live',
    })
    expect(await s.inner.load(dead.fingerprint)).toBeNull() // NoSuchUpload 侧：移除断点
    expect(await s.inner.load(live.fingerprint)).not.toBeNull() // 存活侧：保留供续传
    expect(client.calls).toContain('uploads')
  })

  it('全不存活→候选空且断点全清；空 store 再跑返回空（幂等不炸）', async () => {
    const client = new FakeCheckpointClient()
    const s = makeStore()
    const { q } = makeQueue(client, { checkpointStore: s.store })
    const gone = mkRow('c', 'docs/c.bin', 25, 1000, 10, 'up-gone', [])
    await s.inner.put(gone)
    client.liveUploads = []
    expect(await resumeCheckpoints(q)).toEqual([])
    expect(await s.inner.load(gone.fingerprint)).toBeNull()
    expect(await resumeCheckpoints(q)).toEqual([])
  })
})

// ───────────────────────── 单片重试（partRetry 退避；fake timers） ─────────────────────────

describe('单片重试（partRetry：网络/5xx 退避重试；4xx/4901 不重试）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('网络错重试至成功：失败 2 次后第 3 次成功（默认 partRetry=3），任务不失败', async () => {
    const client = new FakeCheckpointClient()
    const { q, done, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    client.partErrors.set('r.bin#2', [netErr(), netErr()])
    q.enqueue([file('r.bin', 25)])
    await driveUntil(() => done.length === 1)
    expect(failed).toHaveLength(0)
    expect(partAttempts(client, 'r.bin#2')).toBe(3) // 首传 1 + 重试 2
    expect(client.calls).toContain('complete:r.bin')
    expect(client.bodies.get('r.bin')).toBe(25)
  })

  it('5xx 可重试：连续 2 次 500 后成功', async () => {
    const client = new FakeCheckpointClient()
    const { q, done, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    client.partErrors.set('s5.bin#3', [serverErr(), serverErr()])
    q.enqueue([file('s5.bin', 25)])
    await driveUntil(() => done.length === 1)
    expect(failed).toHaveLength(0)
    expect(partAttempts(client, 's5.bin#3')).toBe(3)
  })

  it('耗尽：默认 partRetry=3，连续 4 次网络错 → failed（共 4 次尝试，之后不再重试）', async () => {
    const client = new FakeCheckpointClient()
    const { q, done, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    client.partErrors.set('x.bin#1', [netErr(), netErr(), netErr(), netErr()])
    const res = q.enqueue([file('x.bin', 25)])
    await driveUntil(() => failed.length === 1)
    expect(done).toHaveLength(0)
    expect(partAttempts(client, 'x.bin#1')).toBe(4) // 首传 1 + 重试 3（≤partRetry）
    await vi.advanceTimersByTimeAsync(3600) // 覆盖 500+1000+2000：确认无额外重试
    expect(partAttempts(client, 'x.bin#1')).toBe(4)
    expect(q.status(res.accepted[0]!.id)).toBe('failed')
    expect(client.calls).not.toContain('complete:x.bin')
    expect(failed[0]!.err).toBeInstanceOf(SdkError)
  })

  it('partRetry 覆盖=1：1 次失败即重试成功；连续 2 次失败即 failed', async () => {
    const client = new FakeCheckpointClient()
    const { q, done, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5, partRetry: 1 })
    client.partErrors.set('a.bin#2', [netErr()]) // 恰在预算内
    client.partErrors.set('b.bin#1', [netErr(), netErr()]) // 超预算
    q.enqueue([file('a.bin', 25), file('b.bin', 25)])
    await driveUntil(() => done.length + failed.length === 2)
    expect(done.map(d => d.key)).toEqual(['a.bin'])
    expect(failed.map(f => f.id)).toEqual([expect.any(String)])
    expect(partAttempts(client, 'a.bin#2')).toBe(2)
    expect(partAttempts(client, 'b.bin#1')).toBe(2) // 首传 1 + 重试 1 即止
  })

  it('退避时序（间隔制）：Math.random=0（零抖动）→ 相邻重试间隔恰 500ms、1000ms（base×2^n）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const client = new FakeCheckpointClient()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    client.partErrors.set('t.bin#2', [netErr(), netErr()])
    q.enqueue([file('t.bin', 25)])
    await driveUntil(() => done.length === 1)
    // 间隔制口径：取桩记录的相邻尝试时刻之差（fake timers 下 Date.now 与虚拟时钟同源），
    // 每次间隔 = base×2^n：500→1000（±20ms 步进量化，零抖动桩下恰等）。
    // 注：勿用 driveUntil 返回值差作基线——它按调用各自起算，混合基线恰被累计制满足（评审裁决）。
    const ts = client.partTimes.filter(x => x.tag === 't.bin#2').map(x => x.t)
    expect(ts.length).toBe(3) // 首传 + 2 重试
    expect(ts[1]! - ts[0]!).toBeGreaterThanOrEqual(500) // 间隔1 = 500ms×2^0
    expect(ts[1]! - ts[0]!).toBeLessThanOrEqual(520)
    expect(ts[2]! - ts[1]!).toBeGreaterThanOrEqual(1000) // 间隔2 = 500ms×2^1
    expect(ts[2]! - ts[1]!).toBeLessThanOrEqual(1020)
  })

  it('抖动窗口（默认随机源）：第 1 次重试 ∈ [500, 750]ms（base×2^0 + 0~250ms 抖动）', async () => {
    const client = new FakeCheckpointClient()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    client.partErrors.set('j.bin#2', [netErr()])
    q.enqueue([file('j.bin', 25)])
    const t0 = await driveUntil(() => partAttempts(client, 'j.bin#2') >= 2)
    expect(t0).toBeGreaterThanOrEqual(500)
    expect(t0).toBeLessThanOrEqual(770) // 750 抖动上限 + 20ms 量化
    await driveUntil(() => done.length === 1)
  })

  it('4xx 语义错不重试：该片仅 1 次尝试即 failed', async () => {
    const client = new FakeCheckpointClient()
    const { q, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    client.partErrors.set('c4.bin#1', [clientErr()])
    q.enqueue([file('c4.bin', 25)])
    await driveUntil(() => failed.length === 1)
    await vi.advanceTimersByTimeAsync(3600) // 若误调度重试也该在此窗口现身
    expect(partAttempts(client, 'c4.bin#1')).toBe(1)
    expect(client.calls).not.toContain('complete:c4.bin')
  })

  it('4901 取消语义错不重试：该片仅 1 次尝试即 failed', async () => {
    const client = new FakeCheckpointClient()
    const { q, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    client.partErrors.set('c9.bin#1', [new SdkError(UPLOAD_ABORTED_CODE, '已取消', null)])
    q.enqueue([file('c9.bin', 25)])
    await driveUntil(() => failed.length === 1)
    await vi.advanceTimersByTimeAsync(3600)
    expect(partAttempts(client, 'c9.bin#1')).toBe(1)
    expect((failed[0]!.err as SdkError).code).toBe(UPLOAD_ABORTED_CODE)
  })
})

// ───────────────────────── onProgress / maxParts 接线 ─────────────────────────

describe('onProgress 与 maxParts 接线', () => {
  it('multipart：分片完成推进 bytes（完成片×partSize），total 恒定、收于 total', async () => {
    const client = new FakeCheckpointClient()
    const progs: { bytes: number; total: number; rate?: number }[] = []
    const { q, done } = makeQueue(client, {
      partSize: 10,
      multipartThreshold: 5,
      onProgress: p => progs.push(p),
    })
    q.enqueue([file('p.bin', 25)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(progs.length).toBeGreaterThanOrEqual(3)
    const seq: number[] = []
    for (const p of progs) if (seq[seq.length - 1] !== p.bytes) seq.push(p.bytes) // 去连续重值
    expect(seq).toEqual([10, 20, 25])
    expect(progs.every(p => p.total === 25)).toBe(true)
    expect(progs.at(-1)!.bytes).toBe(25)
  })

  it('≤阈值单 PUT 直传不受管：onProgress 零回调', async () => {
    const client = new FakeCheckpointClient()
    const progs: { bytes: number; total: number }[] = []
    const { q, done } = makeQueue(client, { multipartThreshold: 100, onProgress: p => progs.push(p) })
    q.enqueue([file('tiny.txt', 1)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(progs).toEqual([])
  })

  it('maxParts 接线：自适应分片使片数 ≤ maxParts（25B、partSize=10、maxParts=2 → 2 片）', async () => {
    const client = new FakeCheckpointClient()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, maxParts: 2 })
    q.enqueue([file('m.bin', 25)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.calls.filter(c => c.startsWith('part:m.bin#')).length).toBe(2) // effective=16 → 16+9
    expect(client.completed[0]?.parts).toHaveLength(2)
    expect(client.bodies.get('m.bin')).toBe(25)
  })
})
