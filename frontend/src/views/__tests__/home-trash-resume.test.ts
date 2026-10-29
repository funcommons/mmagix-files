/**
 * Home.vue 回收站入口 + resume 断点横幅接线冒烟（M2/M3 集成钉位）。
 * 范围（冒烟级——Home 体量大，只钉接线锚点，不测业务细节：TrashPanel 契约由
 * trash-panel.test.ts 覆盖、restore/purge 执行由 workspace-ops 单测覆盖、断点续传由
 * upload-queue 单测覆盖）：
 *   ① 回收站入口：点 trash-open → FcDrawer 挂 TrashPanel（listTrash 数据渲染 trash-item）→
 *      勾选 → @restore → workspace-ops.restoreEntries（stub 模块；全文件唯一严格实参断言=选中条目）
 *      → 成功后 listTrash 重拉（调用次数 +1）；
 *   ② empty 确认：TrashPanel 发 empty → toast.confirm 出现 → 确认（spy 直通 resolve）→
 *      tree.emptyTrash 被调；
 *   ③ resume 横幅：queue.resumeCheckpoints → 1 候选 → 横幅渲染（transfer.resume-title 宽松匹配）→
 *      点「放弃」（resume-discard）→ queue.discardCheckpoint 被调 + 横幅消失；
 *   ④ 无候选：resumeCheckpoints → [] → 横幅不渲染。
 * 装配：boot（BOOT_KEY provide，workspace 形状）+ 四个 vi.mock——
 *   '@/files/setup'（setupWorkspace → 假 stores：tree/queue）、'@/files/preview'（createPreview 假句柄）、
 *   '@/files/ui/workspace-ops'（createWorkspaceOps → restoreEntries/purgeEntries spy）、
 *   '@/files/search-index'（SearchIndex/createIdbMetaStore 假体——jsdom 无 indexedDB；
 *   SearchDialog 相对路径导入同一模块，vitest 按解析后 id 拦截，一并命中）。
 * 其余重 UI 子组件布尔 stub 化（teleport: true 沿 home.test.ts stub 面 + TreePanel/Toolbar/
 * UploadPanel/SearchDialog/ShareDialog/SessionBanner/PreviewTabs/ConnectWizard/FcPopover）；
 * TrashPanel 保持真实（testid 断言面），FcDrawer 保持真实（真开抽屉，teleport stub 后内容留在
 * wrapper 树内可查询——同 ui.test.ts 手法）。
 * i18n 测试词典为空（setup.ts），t 直返 key——文案断言按 key 片段宽松命中。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { BOOT_KEY } from '@/boot'
import { toast } from '@/components/sdk'
import type { AppConfig } from '@/sdk/types'
import type { TrashEntry } from '@/files/tree-store'
import type { ResumeCandidate } from '@/files/upload-queue'
import Home from '../Home.vue'

// ── 模块 mock（vi.hoisted：工厂提升前可用） ──

const mocks = vi.hoisted(() => ({
  setupWorkspace: vi.fn(),
  createPreview: vi.fn(),
  createWorkspaceOps: vi.fn(),
  restoreEntries: vi.fn(),
  purgeEntries: vi.fn(),
  SearchIndex: class {
    async search(): Promise<unknown[]> {
      return []
    }
    async stats(): Promise<{ count: number }> {
      return { count: 0 }
    }
  },
  createIdbMetaStore: vi.fn(() => ({})),
}))

vi.mock('@/files/setup', () => ({ setupWorkspace: mocks.setupWorkspace }))
vi.mock('@/files/preview', () => ({ createPreview: mocks.createPreview }))
vi.mock('@/files/ui/workspace-ops', () => ({ createWorkspaceOps: mocks.createWorkspaceOps }))
vi.mock('@/files/search-index', () => ({
  SearchIndex: mocks.SearchIndex,
  createIdbMetaStore: mocks.createIdbMetaStore,
}))

// ── fixtures ──

const PART_SIZE = 8 * 1024 * 1024

const trashEntry = (over: Partial<TrashEntry> = {}): TrashEntry => ({
  key: 'a.txt',
  deleteMarkerVersionId: 'marker-1',
  deletedAt: 1700000000000,
  versions: 1,
  ...over,
})

const trashEntries = (): TrashEntry[] => [
  trashEntry({ key: 'docs/a.txt', deleteMarkerVersionId: 'm1', versions: 2 }),
  trashEntry({ key: 'docs/b.txt', deleteMarkerVersionId: 'm2', deletedAt: null, versions: 1 }),
]

const resumeCandidate = (over: Partial<ResumeCandidate> = {}): ResumeCandidate => ({
  fingerprint: 'fp-1',
  path: 'docs/big.bin',
  size: 1024,
  lastModified: 1700000000000,
  partSize: PART_SIZE,
  uploadId: 'upload-1',
  parts: [{ number: 1, etag: 'etag-1' }],
  ...over,
})

/** 假 tree（Home 消费面：listTrash/emptyTrash/applyChange/loadDir/currentPath） */
function makeTree(entries: TrashEntry[]) {
  return {
    currentPath: 'docs/',
    listTrash: vi.fn(async () => entries.map((e) => ({ ...e }))),
    emptyTrash: vi.fn(async () => ({ purged: entries.length })),
    applyChange: vi.fn(),
    loadDir: vi.fn(async () => {}),
  }
}

/** 假 queue（Home 消费面：resumeCheckpoints/discardCheckpoint/partSizeFor + 传输面板只读面） */
function makeQueue(candidates: ResumeCandidate[]) {
  return {
    resumeCheckpoints: vi.fn(async () => candidates.map((c) => ({ ...c }))),
    discardCheckpoint: vi.fn(async () => {}),
    partSizeFor: vi.fn(() => PART_SIZE),
    enqueue: vi.fn(async () => ({ accepted: [], rejected: [] })),
    enqueueResume: vi.fn(() => null),
    status: vi.fn(() => undefined),
    errorOf: vi.fn(() => undefined),
    abort: vi.fn(() => false),
    pause: vi.fn(async () => {}),
    resume: vi.fn(() => false),
    retry: vi.fn(() => false),
  }
}

/** 假 boot（BOOT_KEY provide 值：workspace 模式形状；Home 只读 config/bus/session/registry 面） */
function makeBoot() {
  const config = {
    mode: 'workspace',
    backend: {
      bucket: 'test-bucket',
      prefix: 'docs/',
      region: 'us-east-1',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    },
    security: { allowedOrigins: ['https://host.example'] },
    ui: {},
    features: {},
  } as unknown as AppConfig
  return {
    ok: true as const,
    handle: {
      win: window,
      config,
      bus: { on: vi.fn(() => () => {}), emit: vi.fn() },
      session: { remainingMs: () => Number.POSITIVE_INFINITY },
      registry: { listMatches: () => [], resolveDefault: () => null },
    },
  }
}

/** 挂载（stub 面沿 home.test.ts：teleport: true + 重 UI 子组件布尔 stub；TrashPanel/FcDrawer 真实）。
 *  TreePanel 不能布尔 stub：回收站入口 2026-10 迁入树头簇（trash-open），stub 需渲染入口钮并转发 trash。 */
const TreePanelStub = {
  name: 'TreePanel',
  template: `<button type="button" data-testid="trash-open" @click="$emit('trash')" />`,
}
function mountHome(candidates: ResumeCandidate[]) {
  const entries = trashEntries()
  const tree = makeTree(entries)
  const queue = makeQueue(candidates)
  mocks.setupWorkspace.mockReturnValue({ client: { get: vi.fn() }, tree, queue })
  const w = mount(Home, {
    global: {
      stubs: {
        teleport: true,
        TreePanel: TreePanelStub,
        Toolbar: true,
        UploadPanel: true,
        SearchDialog: true,
        ShareDialog: true,
        SessionBanner: true,
        PreviewTabs: true,
        ConnectWizard: true,
        FcPopover: true,
      },
      provide: { [BOOT_KEY as symbol]: makeBoot() },
    },
  })
  return { w, tree, queue, entries }
}

// ── toast spy（toast.confirm 直通=自动确认；其余静音防 jsdom 弹层噪音） ──

let spies: { confirm: MockInstance }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createWorkspaceOps.mockReturnValue({
    restoreEntries: mocks.restoreEntries,
    purgeEntries: mocks.purgeEntries,
  })
  mocks.restoreEntries.mockResolvedValue(true)
  mocks.purgeEntries.mockResolvedValue(true)
  mocks.createPreview.mockReturnValue({
    open: vi.fn(),
    close: vi.fn(async () => true),
    expire: vi.fn(),
    clear: vi.fn(),
    current: () => null,
  })
  spies = { confirm: vi.spyOn(toast, 'confirm').mockResolvedValue(undefined) }
  vi.spyOn(toast, 'success').mockReturnValue(undefined)
  vi.spyOn(toast, 'info').mockReturnValue(undefined)
  vi.spyOn(toast, 'error').mockReturnValue(undefined)
  vi.spyOn(toast, 'warning').mockReturnValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// ── 用例 ──

describe('Home.vue 回收站 + resume 接线冒烟（M2/M3）', () => {
  it('① 回收站入口：点 trash-open → TrashPanel 渲染 2 条 → 勾选恢复 → restoreEntries(选中条目) + listTrash 重拉', async () => {
    const { w, tree, entries } = mountHome([])
    await flushPromises()

    // 入口钮在，抽屉未开（TrashPanel 未渲染）
    expect(w.find('[data-testid="trash-open"]').exists()).toBe(true)
    expect(w.find('[data-testid="trash-panel"]').exists()).toBe(false)

    await w.find('[data-testid="trash-open"]').trigger('click')
    await flushPromises()

    // 抽屉开 → listTrash 拉取一次 → 2 条目渲染
    expect(w.find('[data-testid="trash-panel"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="trash-item"]')).toHaveLength(2)
    expect(tree.listTrash).toHaveBeenCalledTimes(1)

    // 勾选全部行 → 恢复
    for (const row of w.findAll('[data-testid="trash-item"]')) {
      await row.find('input[type="checkbox"]').setValue(true)
    }
    await w.find('[data-testid="trash-restore"]').trigger('click')
    await flushPromises()

    // 实参严格（全文件唯一严格断言）：restoreEntries 收到选中条目集
    expect(mocks.restoreEntries).toHaveBeenCalledTimes(1)
    expect(mocks.restoreEntries.mock.calls[0]?.[0]).toEqual(entries)
    // 成功后刷新链：listTrash 重拉（1 → 2）
    expect(tree.listTrash).toHaveBeenCalledTimes(2)
    w.unmount()
  })

  it('② empty 确认：TrashPanel 发 empty → toast.confirm 出现；确认后 emptyTrash 被调', async () => {
    const { w, tree } = mountHome([])
    await flushPromises()
    await w.find('[data-testid="trash-open"]').trigger('click')
    await flushPromises()

    await w.find('[data-testid="trash-empty"]').trigger('click')

    // 确认框出现（warning 档）。注：confirm spy 直通 resolve，「确认后清空」在 trigger 的
    // await 期间微任务内即已推进——故「未确认前 emptyTrash 不调」无法在自动确认语义下断言
    // （取消路径的守卫由 toast.confirm 抛 reject 承担，见 Home.onTrashEmpty 的 catch 分支）。
    expect(spies.confirm).toHaveBeenCalledTimes(1)
    expect(spies.confirm.mock.calls[0]?.[0]).toMatchObject({ type: 'warning' })

    await flushPromises() // 收敛确认后的清空链

    expect(tree.emptyTrash).toHaveBeenCalledTimes(1)
    expect(tree.emptyTrash.mock.calls[0]?.[0]).toEqual({})
    w.unmount()
  })

  it('③ resume 横幅：1 候选 → 横幅渲染（resume-title）；点「放弃」→ discardCheckpoint + 横幅消失', async () => {
    const cand = resumeCandidate()
    const { w, queue } = mountHome([cand])
    await flushPromises()

    const banner = w.find('[data-testid="resume-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('transfer.resume-title')
    expect(w.findAll('[data-testid="resume-item"]')).toHaveLength(1)

    await w.find('[data-testid="resume-discard"]').trigger('click')
    await flushPromises()

    expect(queue.discardCheckpoint).toHaveBeenCalledTimes(1)
    expect(queue.discardCheckpoint.mock.calls[0]?.[0]).toEqual(cand)
    expect(w.find('[data-testid="resume-banner"]').exists()).toBe(false)
    w.unmount()
  })

  it('④ 无候选：resumeCheckpoints → [] → 横幅不渲染', async () => {
    const { w } = mountHome([])
    await flushPromises()

    expect(w.find('[data-testid="resume-banner"]').exists()).toBe(false)
    w.unmount()
  })
})
