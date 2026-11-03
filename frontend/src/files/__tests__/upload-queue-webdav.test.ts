/**
 * M4 上传矩阵测试（WebDAV）：queue × multipartStrategy 分流 + maxUploadSize 超限拒收 + probe 续传三分支。
 * 契约锚：《docs/design/webdav-support-design.md》§W4（M4）
 *
 * - 's3-multipart'（缺省）：零改动回归锚——金标准=既有 upload-queue.test.ts（18 例）与
 *   upload-queue-checkpoint.test.ts（22 例）全绿；此处仅钉「显式声明 / client 未声明两形态同行为」。
 * - 'none'（§W4 ②降级面）：effectiveThreshold=∞ 全部整包 PUT（不触 multipart 四方法）、
 *   不写断点（诚实：无续传）；入队时超 maxUploadSize 拒收（复用 rejected reason 'size'；
 *   缺省 1GB、仅 'none' 策略生效）。
 * - 'content-range'（§W4 ①路径）：分片串行（并发=1——Content-Range 追加语义怕乱序）；
 *   resume 经 checkpoint.uploadId → probeUploadProgress 三分支：
 *   ==已确认字节数 → 续传余片；>（半片残留）/<（服务端丢失）/-1（temp 消失）→
 *   abortMultipart 清残（先于 create）+ checkpoint 重置 + 新 createMultipart 整件重传。
 *   probe 入口经公开 API enqueueResume（Home resume 面包条续传路径）黑盒驱动。
 * - 矩阵集成例：真 WebDavClient(chunkedWrite:true) + 真 UploadQueue——分块 PUT temp ×N →
 *   complete MOVE 落目标全链（§六测试策略「上传矩阵例」），并钉 §W4 红线「不得直写目标路径」。
 *
 * M4 已全部落地（UploadParams.maxUploadSize / S3Client.multipartStrategy / probeUploadProgress
 * 均为正型成员），测试直用正型，不再保留「局部超集类型」脚手架。
 * 1GB 缺省边界用「实例 size 属性遮蔽原型 getter」避免真实分配——queue 分支只读 f.size。
 * probe 桩手法：probeScript 依序消费脚本值（钉续传入口分支裁决），耗尽后回退到「temp 簿记字节和」
 * （预置前缀 + 本会话分片）——兼容 M4-V1 P1「complete 前 probe 对账」（发布前对账时服务器字节
 * 面=已传全量，脚本外自然成立），abort 清残会同步清簿记（真实 temp 已随会话销毁）。
 */
import { describe, expect, it, vi } from 'vitest'
import { sha256HexSync } from '@/sdk/s3/sigv4'
import type { S3Client, S3ListResult } from '@/sdk/types'
import { WebDavClient } from '@/sdk/webdav/client'
import { UploadQueue } from '@/files/upload-queue'
import type { ResumeCandidate, UploadParams } from '@/files/upload-queue'
import { createMemoryCheckpointStore } from '@/files/checkpoint-store'
import type { CheckpointStore, UploadCheckpoint } from '@/files/checkpoint-store'

const tick = () => new Promise<void>(r => setTimeout(r, 0))
const GB = 1024 ** 3

type Strategy = 's3-multipart' | 'content-range' | 'none'

const file = (name: string, size: number, lastModified?: number) =>
  new File([new Uint8Array(size)], name, lastModified !== undefined ? { lastModified } : {})

/** 实例 size 遮蔽法：queue 分支只读 f.size，不触发真实大文件分配（1GB 缺省边界断言专用） */
function fileWithSpoofedSize(name: string, realBytes: number, spoofedSize: number): File {
  const f = file(name, realBytes)
  Object.defineProperty(f, 'size', { value: spoofedSize })
  return f
}

/** 头名大小写不敏感取值（兼容 Record/Headers 两种形态；与 webdav client 测试同款 helper） */
function headerOf(init: RequestInit | undefined, name: string): string {
  const h = init?.headers
  if (!h) return ''
  if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name) ?? ''
  const lower = name.toLowerCase()
  for (const k of Object.keys(h as Record<string, string>)) {
    if (k.toLowerCase() === lower) return (h as Record<string, string>)[k] ?? ''
  }
  return ''
}

/**
 * 内存 S3（策略声明版）：调用序列以 start:/end: 标记分片在途窗口（串行断言）；
 * probeUploadProgress 回包脚本 probeScript（依序消费，耗尽回退簿记字节和），probes 记录探传入参。
 */
class FakeStrategyClient implements S3Client {
  multipartStrategy: Strategy
  /** probe 回包脚本（依序消费；耗尽后回退簿记字节和，见文件头「probe 桩手法」） */
  probeScript: number[] = []
  /** 非空时 probeUploadProgress 抛该错误（探测异常保守视活分支用） */
  probeError: Error | null = null
  /** resumeCheckpoints（s3 分流）探活用的存活 multipart 清单（listMultipartUploads 回包） */
  liveUploads: { key: string; uploadId: string; initiated?: string }[] = []
  probes: { key: string; uploadId: string }[] = []
  calls: string[] = []
  bodies = new Map<string, number>()
  parts = new Map<string, Map<number, number>>()
  completed: { key: string; uploadId: string; parts: { partNumber: number; etag: string }[] }[] = []
  createdIds: string[] = []
  abortCalls: { key: string; uploadId: string }[] = []
  partInflight = 0
  partPeak = 0
  /** 非空时 uploadPart 挂起直到放行（串行断言用） */
  partGate: Promise<void> | null = null
  private createSeq = 0

  constructor(strategy: Strategy = 's3-multipart') {
    this.multipartStrategy = strategy
  }

  async put(key: string, body: Blob | ArrayBuffer, _contentType?: string): Promise<{ etag: string }> {
    this.calls.push(`put:${key}`)
    this.bodies.set(key, body instanceof Blob ? body.size : body.byteLength)
    return { etag: `etag-${key}` }
  }

  async uploadPart(key: string, _uploadId: string, partNumber: number, body: Blob): Promise<{ etag: string }> {
    this.calls.push(`start:${key}#${partNumber}`) // 在途窗口起点（先于 gate：并发派发立即可观测）
    this.partInflight++
    this.partPeak = Math.max(this.partPeak, this.partInflight)
    try {
      if (this.partGate) await this.partGate
      await tick()
      let m = this.parts.get(key)
      if (!m) { m = new Map(); this.parts.set(key, m) }
      m.set(partNumber, body.size)
      this.calls.push(`end:${key}#${partNumber}`) // resolve 落定（成功才有 end 标记）
      return { etag: `etag-${partNumber}` }
    } finally {
      this.partInflight--
    }
  }

  async createMultipart(key: string): Promise<{ uploadId: string }> {
    this.calls.push(`create:${key}`)
    const uploadId = `up-${key}#${++this.createSeq}` // 自增：重置分支的新 ID 恒异于旧 ID
    this.createdIds.push(uploadId)
    return { uploadId }
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    this.calls.push(`complete:${key}`)
    const m = this.parts.get(key)
    this.bodies.set(key, parts.reduce((sum, p) => sum + (m?.get(p.partNumber) ?? 0), 0))
    this.parts.delete(key)
    this.completed.push({ key, uploadId, parts })
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    this.calls.push(`abort:${key}`)
    this.abortCalls.push({ key, uploadId })
    this.parts.delete(key)
  }

  async probeUploadProgress(key: string, uploadId: string): Promise<number> {
    this.calls.push(`probe:${key}:${uploadId}`)
    this.probes.push({ key, uploadId })
    if (this.probeError) throw this.probeError
    if (this.probeScript.length > 0) return this.probeScript.shift()!
    // 脚本耗尽后回退到簿记字节和：真实 temp 的当前字节面。无簿记 key（新会话 temp 从未追加）
    // 回 -1 忠实建模真实客户端 404→-1——勿回 0 假造「已存在的 0 字节 temp」（桩保真度，M4-V2）
    const m = this.parts.get(key)
    if (!m) return -1
    let sum = 0
    for (const v of m.values()) sum += v
    return sum
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

/** 内存 checkpoint store + 观测（同 upload-queue-checkpoint.test.ts 手法） */
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
    async listAll() { return inner.listAll() },
  }
  return { store, inner, calls, puts }
}

/** 组装队列 + 终态回调记录 */
function makeQueue(client: S3Client, params: UploadParams = {}) {
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

/** 构造 ResumeCandidate（fingerprint 与队列口径同源：sha256hex(path:size:lastModified)） */
const FP_TE = new TextEncoder()
function candidateOf(f: File, key: string, uploadId: string, parts: { number: number; etag: string }[]): ResumeCandidate {
  return {
    fingerprint: sha256HexSync(FP_TE.encode(`${key}:${f.size}:${f.lastModified}`)),
    path: key,
    size: f.size,
    lastModified: f.lastModified,
    partSize: 10, // 与用例 partSize 一致（续传分片覆盖校验前提）
    uploadId,
    parts,
  }
}

/** 预置断点行（fingerprint 仅作唯一键；手法同 upload-queue-checkpoint.test.ts mkRow） */
function presetRow(
  seed: string,
  path: string,
  size: number,
  lastModified: number,
  partSize: number,
  uploadId: string,
  parts: { number: number; etag: string }[],
): UploadCheckpoint {
  return {
    fingerprint: `fp-${seed}`.padEnd(64, '0'),
    path,
    size,
    lastModified,
    partSize,
    uploadId,
    parts,
    createdAt: 1,
    updatedAt: 2,
  }
}

// ───────────────────────── none：整包 PUT 降级（§W4 ②） ─────────────────────────

describe("strategy 'none'：整包 PUT 降级（effectiveThreshold=∞）", () => {
  it('超阈值文件也整包 PUT：不触 multipart 四方法（显式小阈值下 25B 亦直传）', async () => {
    const client = new FakeStrategyClient('none')
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    const res = q.enqueue([file('big.bin', 25)]) // 25 > 5：S3 世界必走 multipart；none → 整包
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.calls).toContain('put:big.bin')
    expect(client.calls.some(c => c.startsWith('create:'))).toBe(false)
    expect(client.calls.some(c => c.startsWith('start:'))).toBe(false)
    expect(client.calls.some(c => c.startsWith('complete:'))).toBe(false)
    expect(client.bodies.get('big.bin')).toBe(25) // 整包：单 PUT 全量字节
    expect(q.status(res.accepted[0]!.id)).toBe('done')
  })

  it('缺省参数（multipartThreshold=16MB）下 >16MB 文件仍整包 PUT（降级不依赖显式阈值）', async () => {
    const client = new FakeStrategyClient('none')
    const { q, done } = makeQueue(client)
    const size = 16 * 1024 * 1024 + 1
    q.enqueue([file('huge.bin', size)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.calls).toContain('put:huge.bin')
    expect(client.calls.some(c => c.startsWith('create:'))).toBe(false)
    expect(client.bodies.get('huge.bin')).toBe(size)
  })

  it("不写断点（诚实降级：无续传——§W4 矩阵②「checkpoint 不写」）：store 零调用零行", async () => {
    const client = new FakeStrategyClient('none')
    const s = makeStore()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    q.enqueue([file('big.bin', 25)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(s.calls).toEqual([]) // 零 load/put/remove
    expect(await s.inner.listAll()).toEqual([])
  })
})

// ───────────────────────── none：maxUploadSize 超限拒收（§W4 ②「>上限明确拒收」） ─────────────────────────

describe("strategy 'none'：maxUploadSize 超限拒收", () => {
  it('入队时超上限拒收 reason="size"（拒收文件零请求）；恰等于上限不拒', () => {
    const client = new FakeStrategyClient('none')
    const { q, done, failed } = makeQueue(client, { maxUploadSize: 10 })
    const res = q.enqueue([file('over.bin', 11), file('eq.bin', 10), file('under.bin', 9)])
    expect(res.rejected).toEqual([{ name: 'over.bin', reason: 'size' }])
    expect(res.accepted).toHaveLength(2)
    // 拒收发生在分类期（先于落池）：被拒文件不得发起任何请求（受理文件照常直传）
    expect(client.calls.some(c => c === 'put:over.bin')).toBe(false)
    return vi.waitFor(() => {
      expect(done).toHaveLength(2)
      expect(failed).toHaveLength(0)
    })
  })

  it('缺省上限=1GB：恰 1GB 放行、1GB+1 拒收（size 遮蔽法免真实分配）', () => {
    const client = new FakeStrategyClient('none')
    const { q } = makeQueue(client) // 缺省 maxUploadSize
    const res = q.enqueue([
      fileWithSpoofedSize('edge.bin', 1, GB), // 恰 1GB：超=严格大于，放行
      fileWithSpoofedSize('over.bin', 1, GB + 1),
    ])
    expect(res.rejected).toEqual([{ name: 'over.bin', reason: 'size' }])
    expect(res.accepted).toHaveLength(1)
  })

  it('maxUploadSize 仅 none 生效：s3-multipart 超限照常受理（multipart 面不受此参数约束）', async () => {
    const client = new FakeStrategyClient('s3-multipart')
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, maxUploadSize: 10 })
    const res = q.enqueue([file('big.bin', 25)]) // 25 > maxUploadSize(10)：不得拒
    expect(res.rejected).toEqual([])
    expect(res.accepted).toHaveLength(1)
    await vi.waitFor(() => expect(done).toHaveLength(1))
  })

  it('maxUploadSize 仅 none 生效：content-range 超限照常受理', () => {
    const client = new FakeStrategyClient('content-range')
    const { q } = makeQueue(client, { partSize: 10, multipartThreshold: 5, maxUploadSize: 10 })
    const res = q.enqueue([file('big.bin', 25)])
    expect(res.rejected).toEqual([])
    expect(res.accepted).toHaveLength(1)
  })
})

// ───────────────────────── content-range：分片串行 + 矩阵集成 ─────────────────────────

describe("strategy 'content-range'：分片串行（并发=1，追加语义怕乱序）", () => {
  it('第二片请求在第一片 resolve 后才发出；全程在途峰值=1', async () => {
    const client = new FakeStrategyClient('content-range')
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    let release!: () => void
    client.partGate = new Promise<void>(r => { release = r })
    try {
      q.enqueue([file('s.bin', 25)]) // 10+10+5 → 3 片
      await vi.waitFor(() => expect(client.calls).toContain('start:s.bin#1'))
      await tick()
      await tick()
      // 第一片在途（挂起）期间第二片不得发出（s3-multipart 世界此处必已双发）
      expect(client.calls.filter(c => c.startsWith('start:'))).toEqual(['start:s.bin#1'])
    } finally {
      release() // 失败也要放行，避免挂死在途分片泄漏进后续用例
    }
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.calls.filter(c => c.startsWith('start:') || c.startsWith('end:'))).toEqual([
      'start:s.bin#1', 'end:s.bin#1',
      'start:s.bin#2', 'end:s.bin#2',
      'start:s.bin#3', 'end:s.bin#3',
    ])
    expect(client.partPeak).toBe(1) // 并发=1（区别于 s3-multipart 的 2）
    expect(client.bodies.get('s.bin')).toBe(25)
  })
})

describe("strategy 'content-range'：矩阵集成（真 WebDavClient：分块 PUT temp → MOVE 落目标）", () => {
  it('完整链路：3×PUT 临时对象（Content-Range 逐片追加）→ 发布前 probe 对账 → MOVE 到目标；全程不直写目标路径（§W4 红线）', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    // 有状态 fake 服务器：PUT 按 Content-Range 声明的字节数追加进 temp；HEAD 回 temp 当前字节面
    // （M4-V1 发布前 probe 对账会真实 HEAD temp——无状态 201 桩会判 -1 对账不符而误清残重开）
    const tempBytes = new Map<string, number>()
    fetcher.mockImplementation(async (url, init) => {
      const method = String(init?.method ?? '').toUpperCase()
      if (method === 'PUT') {
        const size = Number(headerOf(init, 'content-range').replace('bytes=-', '')) || 0
        tempBytes.set(url, (tempBytes.get(url) ?? 0) + size)
        return new Response('', { status: 201 })
      }
      if (method === 'HEAD') {
        const n = tempBytes.get(url)
        if (n === undefined) return new Response('', { status: 404 })
        return new Response('', { status: 200, headers: { 'content-length': String(n) } })
      }
      return new Response('', { status: 201 }) // MOVE / DELETE
    })
    const dav = new WebDavClient(
      {
        endpoint: 'https://dav.test',
        username: 'a',
        password: 'b',
        rootPath: '/dav',
        chunkedWrite: true, // §W4① 家族开关（M4 已落地于 WebDavBackendConfig/types）
      },
      fetcher as unknown as typeof fetch,
    )
    const { q, done, failed } = makeQueue(dav, { partSize: 10, multipartThreshold: 5 })
    q.enqueue([file('big.bin', 25)], 'docs/')
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(failed).toHaveLength(0)

    const calls = fetcher.mock.calls
    const target = 'https://dav.test/dav/docs/big.bin'
    const puts = calls.filter(c => c[1]?.method === 'PUT')
    expect(puts).toHaveLength(3)
    const tempUrl = puts[0]![0] as string
    expect(tempUrl).toMatch(/^https:\/\/dav\.test\/dav\/docs\/\.big\.bin\.[^.]+\.mmagix-part$/)
    expect(puts.every(c => c[0] === tempUrl)).toBe(true) // 所有分片追加同一临时对象
    expect(puts.map(c => headerOf(c[1], 'content-range'))).toEqual(['bytes=-10', 'bytes=-10', 'bytes=-5'])

    const moves = calls.filter(c => c[1]?.method === 'MOVE')
    expect(moves).toHaveLength(1)
    expect(moves[0]![0]).toBe(tempUrl) // 源=temp 对象
    expect(headerOf(moves[0]![1], 'destination')).toBe(target) // 绝对 URI 落目标
    expect(headerOf(moves[0]![1], 'overwrite')).toBe('T')
    // §W4 红线：分片过程不得直写目标路径（中断残缺文件会直接对用户可见）——
    // 目标 URL 只允许出现在 MOVE 的 Destination 头，不得作为任何请求的 URL
    expect(calls.filter(c => c[0] === target)).toEqual([])
  })
})

// ───────────────────────── content-range：probe 三分支续传（enqueueResume 路径） ─────────────────────────

describe("strategy 'content-range'：probe 续传三分支（==续传 / >、<、-1 重置重传）", () => {
  it('probe == 已确认字节数 → 续传余片：不 create 不 abort，已确认分片跳过、只补缺失分片', async () => {
    const client = new FakeStrategyClient('content-range')
    client.probeScript = [10] // 首探（续传入口）：part1(10B) 已落服务器，与 checkpoint 已确认字节一致
    // fake 侧为服务端续传前缀建模：part1 的 10B 是本会话之前落 temp 的既有字节面（与首探脚本
    // 同源）——本会话分片簿记只含 #2/#3，complete 汇总不补该基线只能得 15，属 fake 算术缺前缀；
    // 同时也是 complete 前 probe 对账（M4-V1 防线纵深）的回退值来源：#2/#3 落定后簿记和=25=已确认
    client.parts.set('docs/r.bin', new Map([[1, 10]]))
    const s = makeStore() // enqueueResume 预置 cpRow，须配 store（真实装配：候选本就来自断点库）
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    const f = file('r.bin', 25, 1000)
    const id = q.enqueueResume(f, candidateOf(f, 'docs/r.bin', 'up-live-1', [{ number: 1, etag: 'etag-1' }]))
    expect(id).not.toBeNull()
    await vi.waitFor(() => expect(done).toHaveLength(1))
    // 续传前先探（三分支裁决的入口证据；只钉首探——发布前对账还会再探，不锁调用总数）
    expect(client.probes[0]).toEqual({ key: 'docs/r.bin', uploadId: 'up-live-1' })
    expect(client.calls.some(c => c.startsWith('create:'))).toBe(false) // uploadId 复用，不新建会话
    expect(client.calls.some(c => c.startsWith('abort:'))).toBe(false) // 校验通过不清残
    expect(client.calls.some(c => c === 'start:docs/r.bin#1')).toBe(false) // 已确认分片不重传
    expect(client.calls.filter(c => c === 'start:docs/r.bin#2')).toHaveLength(1)
    expect(client.calls.filter(c => c === 'start:docs/r.bin#3')).toHaveLength(1)
    expect(client.completed[0]?.uploadId).toBe('up-live-1')
    expect(client.completed[0]?.parts).toEqual([
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 3, etag: 'etag-3' },
    ])
    expect(client.bodies.get('docs/r.bin')).toBe(25)
    await vi.waitFor(async () => expect(await s.inner.listAll()).toEqual([])) // complete=终态：行移除
  })

  it('probe > 已确认（半片残留）→ 先 abort 旧会话清残，再新 createMultipart 整件重传 + checkpoint 重置', async () => {
    const client = new FakeStrategyClient('content-range')
    client.probeScript = [15] // 服务器比已确认多 5B（part2 写一半崩溃）：追加流无法对齐，只能重置
    const s = makeStore()
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    const f = file('h.bin', 25, 1000)
    q.enqueueResume(f, candidateOf(f, 'docs/h.bin', 'up-stale-1', [{ number: 1, etag: 'etag-1' }]))
    await vi.waitFor(() => expect(done).toHaveLength(1))
    // 顺序：probe → abort（清残先行）→ create（新会话）
    const probeIdx = client.calls.findIndex(c => c.startsWith('probe:'))
    const abortIdx = client.calls.indexOf('abort:docs/h.bin')
    const createIdx = client.calls.findIndex(c => c.startsWith('create:'))
    expect(probeIdx).toBeGreaterThanOrEqual(0)
    expect(abortIdx).toBeGreaterThan(probeIdx)
    expect(createIdx).toBeGreaterThan(abortIdx)
    expect(client.abortCalls).toEqual([{ key: 'docs/h.bin', uploadId: 'up-stale-1' }]) // 清的是旧会话
    expect(client.createdIds).toHaveLength(1)
    expect(client.createdIds[0]).not.toBe('up-stale-1')
    // 三片全量重传（旧已确认分片作废）
    for (const n of [1, 2, 3]) {
      expect(client.calls.filter(c => c === `start:docs/h.bin#${n}`)).toHaveLength(1)
    }
    expect(client.completed[0]?.uploadId).toBe(client.createdIds[0])
    // checkpoint 重置：新会话断点行（uploadId 换新、parts 清零重记）；完成后终态移除
    const resetRow = s.puts.find(p => p.uploadId === client.createdIds[0] && p.parts.length === 0)
    expect(resetRow, '重置后应落新会话断点行（新 uploadId + 空 parts）').toBeDefined()
    await vi.waitFor(async () => expect(await s.inner.listAll()).toEqual([])) // complete=终态：行移除
  })

  it('probe < 已确认（服务端丢失）→ 同走 abort 清残 + 新会话整件重传', async () => {
    const client = new FakeStrategyClient('content-range')
    client.probeScript = [5] // 服务器只剩 5B：比已确认(10B)少——续写会拼出坏字节序，必须重置
    const s = makeStore() // enqueueResume 预置 cpRow，须配 store（同 == 分支口径）
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    const f = file('l.bin', 25, 1000)
    q.enqueueResume(f, candidateOf(f, 'docs/l.bin', 'up-stale-2', [{ number: 1, etag: 'etag-1' }]))
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.abortCalls).toEqual([{ key: 'docs/l.bin', uploadId: 'up-stale-2' }])
    const abortIdx = client.calls.indexOf('abort:docs/l.bin')
    expect(client.calls.findIndex(c => c.startsWith('create:'))).toBeGreaterThan(abortIdx)
    for (const n of [1, 2, 3]) {
      expect(client.calls.filter(c => c === `start:docs/l.bin#${n}`)).toHaveLength(1)
    }
    expect(client.completed[0]?.uploadId).toBe(client.createdIds[0])
  })

  it('probe = -1（temp 对象已消失/404）→ abort 容忍语义下重置 + 新会话整件重传', async () => {
    const client = new FakeStrategyClient('content-range')
    client.probeScript = [-1] // temp 不存在：无续传基础
    const s = makeStore() // enqueueResume 预置 cpRow，须配 store（同 == 分支口径）
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    const f = file('g.bin', 25, 1000)
    q.enqueueResume(f, candidateOf(f, 'docs/g.bin', 'up-gone-1', [{ number: 1, etag: 'etag-1' }]))
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.probes[0]).toEqual({ key: 'docs/g.bin', uploadId: 'up-gone-1' }) // 首探；发布前对账还会再探，不锁总数
    expect(client.abortCalls).toEqual([{ key: 'docs/g.bin', uploadId: 'up-gone-1' }])
    const abortIdx = client.calls.indexOf('abort:docs/g.bin')
    expect(client.calls.findIndex(c => c.startsWith('create:'))).toBeGreaterThan(abortIdx)
    for (const n of [1, 2, 3]) {
      expect(client.calls.filter(c => c === `start:docs/g.bin#${n}`)).toHaveLength(1)
    }
    expect(client.completed[0]?.uploadId).toBe(client.createdIds[0])
    expect(client.bodies.get('docs/g.bin')).toBe(25)
  })
})

// ───────────────────────── content-range：pause/resume（M4-V1 P1 补测） ─────────────────────────

describe("strategy 'content-range'：pause/resume（串行暂停路径，手法对照 upload-queue.test.ts 金标准）", () => {
  it('在途片落定即停派（peak=1、pause 期间 #2/#3 零 start）→ resume probe 对账续余片 → complete 全 3 片', async () => {
    const client = new FakeStrategyClient('content-range')
    const s = makeStore()
    const { q, done, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    let release!: () => void
    client.partGate = new Promise<void>(r => { release = r })
    let id = ''
    try {
      const res = q.enqueue([file('p.bin', 25)], 'docs/')
      id = res.accepted[0]!.id
      await vi.waitFor(() => expect(client.calls).toContain('start:docs/p.bin#1'))
      expect(q.pause(id)).toBe(true)
    } finally {
      release() // 失败也要放行，避免挂死在途分片泄漏进后续用例
    }
    await vi.waitFor(() => expect(q.status(id)).toBe('paused'))
    // 暂停收敛：非失败终态；不 complete 不 abort（uploadId/已落分片保留供续传）
    expect(done).toHaveLength(0)
    expect(failed).toHaveLength(0)
    expect(client.calls.some(c => c.startsWith('complete:'))).toBe(false)
    expect(client.calls.some(c => c.startsWith('abort:'))).toBe(false)
    // 在途片落定即停派：pause 期间 #2/#3 零 start；全程并发=1；不二次 create
    expect(client.calls.filter(c => c === 'start:docs/p.bin#2')).toHaveLength(0)
    expect(client.calls.filter(c => c === 'start:docs/p.bin#3')).toHaveLength(0)
    expect(client.partPeak).toBe(1)
    expect(client.calls.filter(c => c.startsWith('create:')).length).toBe(1)
    // 暂停路径零 probe（不发布不清理，无需对账）
    expect(client.probes).toEqual([])

    // resume：入口 probe 与簿记和(10)对账相等 → 续 #2/#3 → 发布前对账(25) → complete 全 3 片
    expect(q.resume(id)).toBe(true)
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(failed).toHaveLength(0)
    expect(client.calls.filter(c => c.startsWith('create:')).length).toBe(1) // 复用 uploadId，不二次 create
    expect(client.calls.filter(c => c === 'start:docs/p.bin#1').length).toBe(1) // 已落定片不重传
    expect(client.calls.filter(c => c === 'start:docs/p.bin#2').length).toBe(1)
    expect(client.calls.filter(c => c === 'start:docs/p.bin#3').length).toBe(1) // resume 后补传
    expect(client.completed[0]?.uploadId).toBe(client.createdIds[0])
    expect(client.completed[0]?.parts).toEqual([
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 3, etag: 'etag-3' },
    ])
    expect(client.bodies.get('docs/p.bin')).toBe(25)
    expect(client.probes[0]).toEqual({ key: 'docs/p.bin', uploadId: client.createdIds[0] }) // resume 前先探
    await vi.waitFor(async () => expect(await s.inner.listAll()).toEqual([])) // complete=终态：行移除
  })
})

// ───────────────────────── content-range：complete 前 probe 对账（M4-V1 防线纵深） ─────────────────────────

describe('content-range：complete 前 probe 对账（M4-V1 防线纵深——对账不符绝不发布）', () => {
  it('发布前对账不符（脚本注入漂移值）→ 清残重开、全片重传、再对账通过才 MOVE', async () => {
    const client = new FakeStrategyClient('content-range')
    const s = makeStore()
    // 首探=10（入口对账通过、续传 #2/#3）；发布前对账注入漂移值 999 ≠ 已确认 25 → 禁止 MOVE
    client.probeScript = [10, 999]
    const { q, done, failed } = makeQueue(client, { partSize: 10, multipartThreshold: 5, checkpointStore: s.store })
    const f = file('v.bin', 25, 1000)
    q.enqueueResume(f, candidateOf(f, 'docs/v.bin', 'up-live-2', [{ number: 1, etag: 'etag-1' }]))
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(failed).toHaveLength(0)
    // 发布前对账不符 → abort 旧会话清残 + 新 createMultipart（簿记随清残归零 → 重开入口对账 0===0 通过）
    expect(client.abortCalls).toEqual([{ key: 'docs/v.bin', uploadId: 'up-live-2' }])
    expect(client.createdIds).toHaveLength(1)
    // 全片重传：#1 首轮按断点跳过、重开后补传（1 次）；#2/#3 两轮各 1 次（共 2 次）
    expect(client.calls.filter(c => c === 'start:docs/v.bin#1')).toHaveLength(1)
    expect(client.calls.filter(c => c === 'start:docs/v.bin#2')).toHaveLength(2)
    expect(client.calls.filter(c => c === 'start:docs/v.bin#3')).toHaveLength(2)
    expect(client.completed[0]?.uploadId).toBe(client.createdIds[0])
    expect(client.completed[0]?.parts).toHaveLength(3)
    expect(client.bodies.get('docs/v.bin')).toBe(25)
    // 对账 reset 同步重置断点行（新会话新行、parts 清零）
    const resetRow = s.puts.find(p => p.uploadId === client.createdIds[0] && p.parts.length === 0)
    expect(resetRow, '对账重开应落新会话断点行（新 uploadId + 空 parts）').toBeDefined()
    // 探测节奏：入口对账 ×2 + 发布前对账 ×2（两轮循环各一对）
    expect(client.probes).toHaveLength(4)
  })
})

// ───────────────── content-range：resumeCheckpoints 逐行 probe 判活（M4-C 跨会话续传） ─────────────────

describe('resumeCheckpoints content-range 分流（resumeCheckpointsByProbe：逐行 probeUploadProgress 判活）', () => {
  it('存活行（probe != -1）→ 透出候选（key/uploadId 形状对），行保留不清算', async () => {
    const client = new FakeStrategyClient('content-range')
    client.probeScript = [1234] // temp 存活：非 -1 即活
    const s = makeStore()
    const { q } = makeQueue(client, { checkpointStore: s.store })
    const row = presetRow('a', 'docs/a.bin', 25, 1000, 10, 'up-live-x', [{ number: 1, etag: 'etag-1' }])
    await s.inner.put(row)
    const cands = await q.resumeCheckpoints()
    expect(cands).toHaveLength(1)
    expect(cands[0]).toMatchObject({
      fingerprint: row.fingerprint,
      path: 'docs/a.bin',
      size: 25,
      lastModified: 1000,
      partSize: 10,
      uploadId: 'up-live-x',
      parts: [{ number: 1, etag: 'etag-1' }],
    })
    expect(client.probes[0]).toEqual({ key: 'docs/a.bin', uploadId: 'up-live-x' }) // 逐行 probe 判活
    expect(await s.inner.load(row.fingerprint)).not.toBeNull() // 存活行保留
  })

  it('死行（probe = -1，temp 已清理/丢失）→ 不透出且 store.remove 就地清算', async () => {
    const client = new FakeStrategyClient('content-range')
    client.probeScript = [-1]
    const s = makeStore()
    const { q } = makeQueue(client, { checkpointStore: s.store })
    const row = presetRow('b', 'docs/b.bin', 25, 1000, 10, 'up-dead-x', [])
    await s.inner.put(row)
    expect(await q.resumeCheckpoints()).toEqual([])
    expect(await s.inner.load(row.fingerprint)).toBeNull() // 死行清算（对齐 s3 分支口径）
  })

  it('probe 抛错（网络抖动）→ 保守视活透出、不删行（enqueueResume 入口续传校验会再兜底）', async () => {
    const client = new FakeStrategyClient('content-range')
    client.probeError = new Error('probe boom')
    const s = makeStore()
    const { q } = makeQueue(client, { checkpointStore: s.store })
    const row = presetRow('c', 'docs/c.bin', 25, 1000, 10, 'up-shaky', [])
    await s.inner.put(row)
    const cands = await q.resumeCheckpoints()
    expect(cands).toHaveLength(1)
    expect(cands[0]!.uploadId).toBe('up-shaky')
    expect(await s.inner.load(row.fingerprint)).not.toBeNull() // 探测异常不判死：不误删断点
  })

  it('content-range 无探测通道（防御分支）→ 返回 [] 且不删行（无法判活时不销毁断点）', async () => {
    const client = new FakeStrategyClient('content-range')
    // 实例自身属性遮蔽原型方法 ⇒ client.probeUploadProgress 判缺席（实现按 `if (!probe)` 判定，
    // spyOn 包装的 spy 函数仍为真值不可用；不可 delete 类原型方法——共享原型会污染后续用例）。
    // 真 WebDAV 客户端恒有此方法，该分支只为防御注入面。
    ;(client as { probeUploadProgress?: unknown }).probeUploadProgress = undefined
    const s = makeStore()
    const { q } = makeQueue(client, { checkpointStore: s.store })
    const row = presetRow('d', 'docs/d.bin', 25, 1000, 10, 'up-noprobe', [])
    await s.inner.put(row)
    expect(await q.resumeCheckpoints()).toEqual([])
    expect(await s.inner.load(row.fingerprint)).not.toBeNull()
  })

  it('对照锚：s3-multipart 分流不走 probe 判活（listMultipartUploads 交叉；probe 即便回 -1 也不影响判定）', async () => {
    const client = new FakeStrategyClient('s3-multipart')
    client.probeScript = [-1] // 若误走 probe 分支则两行全判死——用 live 行存活反证未走
    client.liveUploads = [{ key: 'docs/a.bin', uploadId: 'up-live-s3', initiated: '2026-11-01T00:00:00.000Z' }]
    const s = makeStore()
    const { q } = makeQueue(client, { checkpointStore: s.store })
    const live = presetRow('e', 'docs/a.bin', 25, 1000, 10, 'up-live-s3', [])
    const dead = presetRow('f', 'docs/b.bin', 25, 1000, 10, 'up-dead-s3', [])
    await s.inner.put(live)
    await s.inner.put(dead)
    const cands = await q.resumeCheckpoints()
    expect(cands).toHaveLength(1)
    expect(cands[0]!.uploadId).toBe('up-live-s3')
    expect(client.probes).toHaveLength(0) // probe 分支未被走（金标准=upload-queue-checkpoint.test.ts 探活用例）
    expect(await s.inner.load(live.fingerprint)).not.toBeNull()
    expect(await s.inner.load(dead.fingerprint)).toBeNull() // 死行清算走 list 交叉（非 probe）
  })
})

// ───────────────────────── s3-multipart：零改动回归锚 ─────────────────────────

describe("strategy 's3-multipart'：零改动回归锚（金标准=既有 upload-queue 两个测试文件）", () => {
  it("显式声明 's3-multipart'：分片并发=2、complete 按 partNumber 升序（既有行为不变）", async () => {
    const client = new FakeStrategyClient('s3-multipart')
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    q.enqueue([file('a.bin', 25)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.calls.filter(c => c.startsWith('start:'))).toHaveLength(3)
    expect(client.partPeak).toBe(2) // 单片并发 2 不变（区别于 content-range 的串行）
    expect(client.completed[0]?.parts.map(p => p.partNumber)).toEqual([1, 2, 3])
  })

  it('client 未声明 multipartStrategy（S3 客户端现状）→ 按 s3-multipart 处理（向后兼容缺省）', async () => {
    const client = new FakeStrategyClient('s3-multipart')
    delete (client as { multipartStrategy?: Strategy }).multipartStrategy // 模拟未声明的 S3 客户端
    const { q, done } = makeQueue(client, { partSize: 10, multipartThreshold: 5 })
    q.enqueue([file('b.bin', 25)])
    await vi.waitFor(() => expect(done).toHaveLength(1))
    expect(client.calls.filter(c => c.startsWith('start:'))).toHaveLength(3)
    expect(client.partPeak).toBe(2)
    expect(client.calls).toContain('complete:b.bin')
  })
})
