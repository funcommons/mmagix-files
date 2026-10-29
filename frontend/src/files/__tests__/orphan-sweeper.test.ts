/**
 * 孤儿分片上传清扫测试（v1.2.0 §2.2 F5；M2 契约 §「M2 契约」）。
 * 被测：frontend/src/files/orphan-sweeper.ts 的 sweepOrphanUploads。
 * 契约：listMultipartUploads → initiated 距今 > maxAgeMs（默认 7d）→ abortMultipart(key, uploadId)
 * aborted:true；initiated 缺失/解析不出日期 → 保守跳过（aborted:false 不动）；未超龄 → aborted:false；
 * abortMultipart 单条抛错不中断整体（该条 aborted:false 继续其余）；listMultipartUploads 抛错整体上抛。
 * 假时钟 vi.setSystemTime 控制「距今」；client 用内联桩对象（只依赖 S3Client 类型契约，不依赖实现）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@/sdk/types'
import { sweepOrphanUploads } from '@/files/orphan-sweeper'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const SEVEN_DAYS = 604_800_000

type Upload = { key: string; uploadId: string; initiated?: string }
type ClientStub = Pick<S3Client, 'listMultipartUploads' | 'abortMultipart'> & {
  listMultipartUploads: ReturnType<typeof vi.fn>
  abortMultipart: ReturnType<typeof vi.fn>
}

const up = (key: string, uploadId: string, initiated?: string): Upload =>
  initiated === undefined ? { key, uploadId } : { key, uploadId, initiated }

/** 内联桩：list 固定返回 uploads；abort 默认成功，可按 key 注入失败 */
function stubClient(uploads: Upload[], abortFailKeys: Set<string> = new Set()): ClientStub {
  return {
    listMultipartUploads: vi.fn(() => Promise.resolve(uploads)),
    abortMultipart: vi.fn((key: string, _uploadId: string) =>
      abortFailKeys.has(key) ? Promise.reject(new Error(`abort failed: ${key}`)) : Promise.resolve(),
    ),
  }
}

const callPairs = (client: ClientStub) =>
  client.abortMultipart.mock.calls.map(([key, uploadId]) => `${key}/${uploadId}`).sort()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('sweepOrphanUploads（孤儿分片上传清扫）', () => {
  it('默认 7 天阈值：混合清单仅超龄被 abort，4 条结果齐全', async () => {
    const client = stubClient([
      up('old-a', 'u1', new Date(NOW - SEVEN_DAYS - 3 * 86_400_000).toISOString()), // 超龄 10d
      up('fresh', 'u2', new Date(NOW - 3 * 86_400_000).toISOString()), // 新鲜 3d
      up('old-b', 'u3', new Date(NOW - SEVEN_DAYS - 86_400_000).toISOString()), // 超龄 8d
      up('no-init', 'u4'), // initiated 缺失 → 保守跳过
    ])

    const results = await sweepOrphanUploads(client)

    expect(results).toHaveLength(4)
    const get = (key: string) => results.find(r => r.key === key)
    expect(get('old-a')).toEqual({ key: 'old-a', uploadId: 'u1', aborted: true })
    expect(get('old-b')).toEqual({ key: 'old-b', uploadId: 'u3', aborted: true })
    expect(get('fresh')).toEqual({ key: 'fresh', uploadId: 'u2', aborted: false })
    expect(get('no-init')).toEqual({ key: 'no-init', uploadId: 'u4', aborted: false })
    // 仅两条超龄被 abort，实参为 (key, uploadId) 位置传参；不关心处理顺序
    expect(callPairs(client)).toEqual(['old-a/u1', 'old-b/u3'])
    expect(client.listMultipartUploads).toHaveBeenCalledTimes(1)
  })

  it('maxAgeMs 自定义生效：0 → 全部 abort', async () => {
    const client = stubClient([
      up('a', 'u1', new Date(NOW - 1).toISOString()),
      up('b', 'u2', new Date(NOW - 1000).toISOString()),
    ])

    const results = await sweepOrphanUploads(client, { maxAgeMs: 0 })

    expect(results).toEqual([
      { key: 'a', uploadId: 'u1', aborted: true },
      { key: 'b', uploadId: 'u2', aborted: true },
    ])
    expect(callPairs(client)).toEqual(['a/u1', 'b/u2'])
  })

  it('阈值边界：超龄 1ms 即 abort；差 1ms 不到龄不 abort（严格 > maxAgeMs）', async () => {
    const client = stubClient([
      up('just-over', 'u1', new Date(NOW - SEVEN_DAYS - 1).toISOString()),
      up('just-under', 'u2', new Date(NOW - SEVEN_DAYS + 1).toISOString()),
    ])

    const results = await sweepOrphanUploads(client)

    expect(results).toEqual([
      { key: 'just-over', uploadId: 'u1', aborted: true },
      { key: 'just-under', uploadId: 'u2', aborted: false },
    ])
    expect(client.abortMultipart).toHaveBeenCalledTimes(1)
    expect(client.abortMultipart).toHaveBeenCalledWith('just-over', 'u1')
  })

  it('initiated 解析不出日期 → 跳过不动（aborted:false），不发起 abort', async () => {
    const client = stubClient([
      up('garbage', 'u1', 'not-a-date'),
      up('empty', 'u2', ''),
      up('old-ok', 'u3', new Date(NOW - 30 * 86_400_000).toISOString()),
    ])

    const results = await sweepOrphanUploads(client)

    expect(results).toEqual([
      { key: 'garbage', uploadId: 'u1', aborted: false },
      { key: 'empty', uploadId: 'u2', aborted: false },
      { key: 'old-ok', uploadId: 'u3', aborted: true },
    ])
    expect(callPairs(client)).toEqual(['old-ok/u3'])
  })

  it('abort 抛错隔离：第 1 条失败（aborted:false），第 2 条仍被 abort', async () => {
    const client = stubClient(
      [
        up('old-a', 'u1', new Date(NOW - SEVEN_DAYS - 86_400_000).toISOString()),
        up('old-b', 'u2', new Date(NOW - SEVEN_DAYS - 86_400_000).toISOString()),
      ],
      new Set(['old-a']),
    )

    const results = await sweepOrphanUploads(client)

    expect(results).toEqual([
      { key: 'old-a', uploadId: 'u1', aborted: false },
      { key: 'old-b', uploadId: 'u2', aborted: true },
    ])
    // 失败不中断整体：两条都尝试过 abort
    expect(callPairs(client)).toEqual(['old-a/u1', 'old-b/u2'])
  })

  it('空清单 → []，不发起任何 abort', async () => {
    const client = stubClient([])

    const results = await sweepOrphanUploads(client)

    expect(results).toEqual([])
    expect(client.abortMultipart).not.toHaveBeenCalled()
  })

  it('listMultipartUploads 抛错 → 整体向上抛，且不发起 abort', async () => {
    const client = stubClient([])
    vi.mocked(client.listMultipartUploads).mockImplementation(() =>
      Promise.reject(new Error('network down')),
    )

    await expect(sweepOrphanUploads(client)).rejects.toThrow('network down')
    expect(client.abortMultipart).not.toHaveBeenCalled()
  })

  it('maxAgeMs 非法回落：NaN（如 Number("7d")）→ 行为等同默认 7 天（超龄 abort、新鲜保留）', async () => {
    const client = stubClient([
      up('old', 'u1', new Date(NOW - SEVEN_DAYS - 86_400_000).toISOString()), // 超龄 8d
      up('fresh', 'u2', new Date(NOW - 3 * 86_400_000).toISOString()), // 新鲜 3d
    ])

    const results = await sweepOrphanUploads(client, { maxAgeMs: Number('7d') })

    // 若 NaN 直通：Date.now()-initiated <= NaN 恒 false，全部被误判超龄误杀
    expect(results).toEqual([
      { key: 'old', uploadId: 'u1', aborted: true },
      { key: 'fresh', uploadId: 'u2', aborted: false },
    ])
    expect(callPairs(client)).toEqual(['old/u1'])
  })

  it('maxAgeMs 非法回落：负数（-1）→ 行为等同默认 7 天（新鲜条目不被 abort）', async () => {
    const client = stubClient([
      up('fresh', 'u1', new Date(NOW - 86_400_000).toISOString()), // 新鲜 1d；负阈值生效则恒「超龄」被误杀
      up('old', 'u2', new Date(NOW - SEVEN_DAYS - 86_400_000).toISOString()), // 超龄 8d
    ])

    const results = await sweepOrphanUploads(client, { maxAgeMs: -1 })

    expect(results).toEqual([
      { key: 'fresh', uploadId: 'u1', aborted: false },
      { key: 'old', uploadId: 'u2', aborted: true },
    ])
    expect(callPairs(client)).toEqual(['old/u2'])
  })
})
