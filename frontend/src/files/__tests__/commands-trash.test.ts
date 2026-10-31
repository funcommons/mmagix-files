/**
 * M3-UI 命令/操作链回收站接线测试（W2+ 波次：commands restore/purge + workspace-ops
 * restoreEntries/purgeEntries + FileTreeWithTrash DI 消费面）。
 * 契约：《docs/design/capabilities-contract-v1.2.0.md》M3 契约节 + UI 波次节（TrashPanel emits →
 * workspace-ops / JSSDK restore/purge 命令挂既有 features 通道）。
 *
 * TDD 红态说明：restore/purge 命令与 restoreEntries/purgeEntries 操作链**尚未实现**——
 * 本文件先钉契约，红点：
 *   ① createM1Overrides 无 restore/purge（cmd() 取不到 handler 即抛「未注册」）；
 *   ② createWorkspaceOps 无 restoreEntries/purgeEntries（调用即 TypeError）；
 *   ③ purge 确认文案 zh-CN 词典无「不可恢复」措辞键（真词典解析回退成 key 本身 → 不匹配）。
 * FileTreeWithTrash 四方法面（DI 消费面）tree-store 已落地，对应 describe 应为绿（防回退钉）。
 *
 * 隔离策略：手法对齐 commands.test.ts（手写 Fake tree/queue/client/emit，不依赖真实
 * S3Client / pinia）与 ui.test.ts workspace-ops 节（vi.spyOn(toast,'confirm') + mockReset）。
 * 不修改既有测试文件。
 */
import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, SdkError } from '@/sdk/errorCodes'
import zhCN from '@/locales/zh-CN'
import { toast } from '@/components/sdk'
import type { EventName, S3Client } from '@/sdk/types'
import type { CommandHandler } from '@/sdk/handlers'
import { createFileTree, TrashBatchError } from '../tree-store'
import type { DirBucket, FileTreeWithTrash, TrashEntry } from '../tree-store'
import type { EnqueueResult, UploadQueue } from '../upload-queue'
import { createM1Overrides } from '../commands'
import type { M1OverridesDeps } from '../commands'
import { createWorkspaceOps } from '../ui/workspace-ops'
import type { WorkspaceOps } from '../ui/workspace-ops'

// ───────────────────────── 手写 Fake ─────────────────────────

/** 回收站条目工厂 */
const trashEntry = (key: string): TrashEntry => ({
  key,
  deleteMarkerVersionId: `vm-${key}`,
  deletedAt: 1767000000000,
  versions: 1,
})

/** 含回收站四方法的树桩（listTrash 返回固定 entries，restore/purge/empty 可观测） */
function makeTrashTree(entries: TrashEntry[]): FileTreeWithTrash {
  return {
    currentPath: '',
    loading: false,
    error: null,
    nodes: new Map<string, DirBucket>(),
    loadDir: vi.fn(() => Promise.resolve()),
    mkdir: vi.fn(() => Promise.resolve('new/')),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    applyChange: vi.fn(),
    listTrash: vi.fn(() => Promise.resolve(entries)),
    restoreTrash: vi.fn(() => Promise.resolve()),
    purgeTrash: vi.fn(() => Promise.resolve({ skipped: 0 })),
    emptyTrash: vi.fn(() => Promise.resolve({ purged: 0 })),
  }
}

function makeQueue(): UploadQueue {
  return {
    enqueue: vi.fn((_files: File[]): EnqueueResult => ({ accepted: [], rejected: [] })),
  } as unknown as UploadQueue
}

function makeClient(): S3Client {
  return {} as S3Client // restore/purge 不触 client
}

const ALL_ON: Record<string, boolean> = {
  upload: true,
  delete: true,
  rename: true,
  mkdir: true,
  download: true,
  restore: true,
  purge: true,
}

/** 测试词典：t 返回 'key'（无参）或 'key:{"n":2}'（有参），便于按键断言 */
const tFake = vi.fn((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`,
)

/** 真词典解析器：按 zh-CN 默认导出做点路径查找 + {n} 插值（键缺失回退为 key 本身） */
const tZh = (key: string, params?: Record<string, unknown>): string => {
  const raw = key
    .split('.')
    .reduce<unknown>(
      (node, seg) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined),
      zhCN as unknown,
    )
  const tpl = typeof raw === 'string' ? raw : key
  if (!params) return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

// ───────────────────────── restore / purge 命令 ─────────────────────────

interface TrashHarness {
  tree: FileTreeWithTrash
  emit: ReturnType<typeof vi.fn<(evt: EventName, payload: unknown) => void>>
  overrides: ReturnType<typeof createM1Overrides>
}

function setupTrash(opts?: {
  rootPrefix?: string
  features?: Record<string, boolean>
  trashEntries?: TrashEntry[]
}): TrashHarness {
  const tree = makeTrashTree(opts?.trashEntries ?? [trashEntry('a.txt'), trashEntry('d/b.txt'), trashEntry('other.txt')])
  const emit = vi.fn<(evt: EventName, payload: unknown) => void>()
  const deps: M1OverridesDeps = {
    tree,
    queue: makeQueue(),
    client: makeClient(),
    rootPrefix: opts?.rootPrefix ?? '',
    features: opts?.features ?? { ...ALL_ON },
    emit,
  }
  return { tree, emit, overrides: createM1Overrides(deps) }
}

/** 取 restore/purge handler；未注册（红态）即抛明确错误 */
function trashCmd(h: TrashHarness, name: 'restore' | 'purge'): CommandHandler {
  const handler = (h.overrides as unknown as Record<string, CommandHandler | undefined>)[name]
  if (typeof handler !== 'function') {
    throw new Error(`命令 ${name} 未在 features 通道注册（createM1Overrides 缺 ${name}）`)
  }
  return handler
}

/** 断言抛 SdkError 且 code 匹配（requireFeature 在返回 Promise 前同步 throw，await 兼容两形态） */
async function expectSdkError(run: () => unknown, code: number): Promise<void> {
  try {
    await run()
    expect.unreachable(`应抛出 SdkError(code=${code})`)
  } catch (e) {
    expect(e).toBeInstanceOf(SdkError)
    expect((e as SdkError).code).toBe(code)
  }
}

describe('restore 命令（features 通道）', () => {
  it("features.restore=false → 4301 且 tree.restoreTrash 未调", async () => {
    const h = setupTrash({ features: { ...ALL_ON, restore: false } })
    await expectSdkError(() => trashCmd(h, 'restore')({ paths: ['a.txt'] }), ERROR_CODES.FEATURE_DISABLED)
    expect(h.tree.restoreTrash).not.toHaveBeenCalled()
  })

  it("features 门开 → 经 listTrash 解析后调 tree.restoreTrash，实参 keys 与 payload 对应（rootPrefix='' 全键=相对路径）", async () => {
    const h = setupTrash({ trashEntries: [trashEntry('a.txt'), trashEntry('d/b.txt'), trashEntry('other.txt')] })
    await trashCmd(h, 'restore')({ paths: ['a.txt', 'd/b.txt'] })

    expect(h.tree.listTrash).toHaveBeenCalled() // 条目由 listTrash 解析得到
    expect(h.tree.restoreTrash).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(h.tree.restoreTrash).mock.calls[0]![0]
    expect(passed).toHaveLength(2) // 只恢复 payload 命中的条目
    expect(passed.map((e) => e.key)).toEqual(expect.arrayContaining(['a.txt', 'd/b.txt']))
    expect(passed.map((e) => e.key)).not.toContain('other.txt')
    // 完整 TrashEntry 保真（deleteMarkerVersionId 等不被削掉——恢复=删 marker 版本，缺它即坏）
    expect(passed).toEqual(expect.arrayContaining([trashEntry('a.txt'), trashEntry('d/b.txt')]))
  })

  it('rel 路径经 rootPrefix 拼全键后匹配条目（对齐 remove 的 joinKey 口径）', async () => {
    const h = setupTrash({
      rootPrefix: 'sessions/abc/',
      trashEntries: [trashEntry('sessions/abc/a.txt'), trashEntry('sessions/abc/other.txt')],
    })
    await trashCmd(h, 'restore')({ paths: ['/a.txt'] })
    const passed = vi.mocked(h.tree.restoreTrash).mock.calls[0]![0]
    expect(passed.map((e) => e.key)).toEqual(['sessions/abc/a.txt'])
  })

  it('TrashBatchError 冒泡为命令错误（不吞、不包装）', async () => {
    const h = setupTrash()
    const batchErr = new TrashBatchError('回收站恢复失败', new Map([['a.txt', new Error('boom')]]))
    vi.mocked(h.tree.restoreTrash).mockRejectedValue(batchErr)
    await expect(trashCmd(h, 'restore')({ paths: ['a.txt'] })).rejects.toBe(batchErr)
  })
})

describe('purge 命令（features 通道）', () => {
  it("features.purge=false → 4301 且 tree.purgeTrash 未调", async () => {
    const h = setupTrash({ features: { ...ALL_ON, purge: false } })
    await expectSdkError(() => trashCmd(h, 'purge')({ paths: ['a.txt'] }), ERROR_CODES.FEATURE_DISABLED)
    expect(h.tree.purgeTrash).not.toHaveBeenCalled()
  })

  it('features 门开 → 实参 keys 与 payload 对应，未命中条目不入参', async () => {
    const h = setupTrash({ trashEntries: [trashEntry('a.txt'), trashEntry('d/b.txt'), trashEntry('other.txt')] })
    await trashCmd(h, 'purge')({ paths: ['a.txt', 'd/b.txt'] })

    expect(h.tree.purgeTrash).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(h.tree.purgeTrash).mock.calls[0]![0]
    expect(passed).toHaveLength(2)
    expect(passed.map((e) => e.key)).toEqual(expect.arrayContaining(['a.txt', 'd/b.txt']))
    expect(passed.map((e) => e.key)).not.toContain('other.txt')
  })

  it('TrashBatchError 冒泡为命令错误（不吞、不包装）', async () => {
    const h = setupTrash()
    const batchErr = new TrashBatchError('回收站彻底删除失败', new Map([['a.txt', new Error('boom')]]))
    vi.mocked(h.tree.purgeTrash).mockRejectedValue(batchErr)
    await expect(trashCmd(h, 'purge')({ paths: ['a.txt'] })).rejects.toBe(batchErr)
  })
})

// ───────────────────────── FileTreeWithTrash DI 消费面 ─────────────────────────

describe('FileTreeWithTrash DI 消费面（setup/commands 贯通前提）', () => {
  it('createFileTree 返回控制器含回收站四方法（listTrash/restoreTrash/purgeTrash/emptyTrash）', () => {
    const ctrl = createFileTree({ client: {} as S3Client })
    for (const m of ['listTrash', 'restoreTrash', 'purgeTrash', 'emptyTrash'] as const) {
      expect(typeof ctrl[m], `createFileTree 缺方法 ${m}`).toBe('function')
    }
  })
})

// ───────────────────────── workspace-ops：restoreEntries / purgeEntries ─────────────────────────

/** restoreEntries/purgeEntries 操作链面（实现落地前经交叉类型访问，红态=调用即 TypeError） */
type TrashWorkspaceOps = WorkspaceOps & {
  restoreEntries(entries: TrashEntry[]): Promise<unknown>
  purgeEntries(entries: TrashEntry[]): Promise<unknown>
}

describe('workspace-ops 回收站操作链', () => {
  const setupOps = (t: (key: string, params?: Record<string, unknown>) => string = tFake) => {
    // mockReset：清调用历史并移除上例的 resolved/rejected 值（spy 跨用例共享同一 mock）
    vi.spyOn(toast, 'confirm').mockReset()
    vi.spyOn(toast, 'error').mockReset()
    const entries = [trashEntry('root/a.txt'), trashEntry('root/d/b.txt')]
    const tree = makeTrashTree(entries)
    const ops = createWorkspaceOps({ tree, t: (key, params) => t(key, params) }) as TrashWorkspaceOps
    return { tree, ops, entries }
  }

  it('restoreEntries：无确认直接 tree.restoreTrash(entries)（confirm 全程未弹）', async () => {
    const { tree, ops, entries } = setupOps()
    vi.mocked(toast.confirm).mockResolvedValue(undefined) // 若实现误弹确认框，此例仍干净收场并在此断言失败
    await ops.restoreEntries(entries)
    expect(toast.confirm).not.toHaveBeenCalled() // 恢复可逆 → 无确认
    expect(tree.restoreTrash).toHaveBeenCalledTimes(1)
    expect(tree.restoreTrash).toHaveBeenCalledWith(entries)
  })

  it('purgeEntries：确认框取消 → tree.purgeTrash 零调用', async () => {
    const { tree, ops, entries } = setupOps()
    vi.mocked(toast.confirm).mockRejectedValue('cancel')
    await ops.purgeEntries(entries)
    expect(toast.confirm).toHaveBeenCalledTimes(1)
    expect(tree.purgeTrash).not.toHaveBeenCalled()
  })

  it('purgeEntries：确认 → tree.purgeTrash(entries)（同批同参）', async () => {
    const { tree, ops, entries } = setupOps()
    vi.mocked(toast.confirm).mockResolvedValue(undefined)
    await ops.purgeEntries(entries)
    expect(toast.confirm).toHaveBeenCalledTimes(1)
    expect(tree.purgeTrash).toHaveBeenCalledTimes(1)
    expect(tree.purgeTrash).toHaveBeenCalledWith(entries)
  })

  it('purgeEntries：确认文案含「不可恢复」语义（真词典 zh-CN 解析，宽松拼接 title+message）', async () => {
    const { ops } = setupOps(tZh)
    vi.mocked(toast.confirm).mockResolvedValue(undefined)
    await ops.purgeEntries([trashEntry('root/a.txt')])
    const arg = vi.mocked(toast.confirm).mock.calls[0]![0] as { title?: string; message?: string }
    expect(`${arg.title ?? ''}${arg.message ?? ''}`).toMatch(/不可恢复/)
  })
})
