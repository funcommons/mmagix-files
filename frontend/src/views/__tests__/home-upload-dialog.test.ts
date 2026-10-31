/**
 * Home × UploadDialog 集成冒烟（用户回报「开始上传并不上传」BUG 复现架）：
 * 树头「上传」→ 弹窗上传页 → dropzone 选文件 → 开始上传 →
 * 断言 queue.enqueue 被调（文件+当前目录前缀）且弹窗不关、转到传输页签。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { BOOT_KEY } from '@/boot'
import Home from '@/views/Home.vue'

const mocks = vi.hoisted(() => ({
  setupWorkspace: vi.fn(),
  createPreview: vi.fn(),
  createWorkspaceOps: vi.fn(),
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

function makeQueue() {
  return {
    resumeCheckpoints: vi.fn(async () => []),
    discardCheckpoint: vi.fn(async () => {}),
    partSizeFor: vi.fn(() => 8 * 1024 * 1024),
    enqueue: vi.fn(
      async (
        _files: File[] = [],
        _prefix?: string,
      ): Promise<{ accepted: { id: string }[]; rejected: { name: string; reason: string }[] }> => ({
        accepted: [],
        rejected: [],
      }),
    ),
    enqueueResume: vi.fn(() => null),
    status: vi.fn(() => undefined),
    errorOf: vi.fn(() => undefined),
    abort: vi.fn(() => false),
    pause: vi.fn(async () => {}),
    resume: vi.fn(() => false),
    retry: vi.fn(() => false),
  }
}

const TreePanelStub = {
  name: 'TreePanel',
  template: `<div>
    <button type="button" data-testid="trash-open" @click="$emit('trash')" />
    <button type="button" data-testid="tree-upload" @click="$emit('upload-request')" />
  </div>`,
}

function mountHome() {
  const queue = makeQueue()
  mocks.setupWorkspace.mockReturnValue({
    client: { get: vi.fn() },
    tree: { currentPath: 'docs/', listTrash: vi.fn(async () => []), emptyTrash: vi.fn(), applyChange: vi.fn(), loadDir: vi.fn(async () => {}) },
    queue,
  })
  const w = mount(Home, {
    global: {
      stubs: {
        teleport: true,
        TreePanel: TreePanelStub,
        Toolbar: true,
        SearchDialog: true,
        ShareDialog: true,
        SessionBanner: true,
        PreviewTabs: true,
        ConnectWizard: true,
        FcPopover: true,
        FcEmpty: true,
      },
      provide: {
        [BOOT_KEY as symbol]: {
          ok: true,
          handle: {
            win: window,
            config: { mode: 'workspace', backend: { bucket: 'b', prefix: 'docs/' }, ui: {}, features: {} },
            bus: { on: vi.fn(() => () => {}), emit: vi.fn() },
            session: { remainingMs: () => Number.POSITIVE_INFINITY },
            registry: { listMatches: () => [], resolveDefault: () => null },
          },
        },
      },
    },
    attachTo: document.body,
  })
  return { w, queue }
}

/** dropzone 隐藏 input 灌文件（jsdom 无 DataTransfer；FcDropZone onFileInputChange 读 input.files） */
async function pickFiles(w: ReturnType<typeof mountHome>['w'], files: File[]) {
  const input = w.find('[data-testid="upload-dialog-zone"] input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
}

/** 关闭/重开走 el-dialog 过渡（~300ms fade，jsdom 也要真实时钟走完）——等稳定 */
const settle = (ms = 380) => new Promise((r) => setTimeout(r, ms))

describe('Home × UploadDialog：开始上传 → enqueue + 转传输页不关窗', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('确认 → 先关窗 → enqueue(files, 当前目录) 成功开始 → 重开弹窗落传输页签', async () => {
    const { w, queue } = mountHome()
    // 入队延迟 500ms：把「关窗（~300ms 过渡可观察）」与「重开」在时间轴上分离（模拟真实冲突 HEAD 探测间隔）
    queue.enqueue.mockImplementationOnce(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ accepted: [{ id: 'u1' }, { id: 'u2' }], rejected: [] }), 500),
        ),
    )
    await flushPromises()

    // 树头「上传」→ 弹窗开（上传页）
    await w.find('[data-testid="tree-upload"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="upload-dialog-zone"]').exists()).toBe(true)

    // dropzone 选 2 个文件 → 计数联动
    const f1 = new File(['aaa'], 'a.txt', { type: 'text/plain' })
    const f2 = new File(['bbb'], 'b.txt', { type: 'text/plain' })
    await pickFiles(w, [f1, f2])
    await flushPromises()
    expect(w.findAll('[data-testid="upload-dialog-file"]')).toHaveLength(2)

    // 开始上传 → 关窗（冲突提示不再被遮挡）；t≈380ms 时 enqueue 未返回 → 弹窗应处于关闭态
    await w.find('[data-testid="upload-dialog-confirm"]').trigger('click')
    await flushPromises()
    await settle()
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="upload-dialog-cancel"]').isVisible()).toBe(false)

    // t>500ms 入队成功返回（accepted>0）→ 重开弹窗落传输页签
    await settle(500)
    const [files, prefix] = queue.enqueue.mock.calls[0]!
    expect((files ?? []).map((f) => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(prefix).toBe('docs/')
    expect(w.find('[data-testid="upload-dialog-transfer"]').isVisible()).toBe(true)
    expect(w.find('[data-testid="upload-dialog-cancel"]').isVisible()).toBe(true)
    w.unmount()
  })

  it('确认后全部被拒（accepted=0）→ 弹窗保持关门（不空开传输页）', async () => {
    const { w, queue } = mountHome()
    queue.enqueue.mockResolvedValueOnce({ accepted: [], rejected: [{ name: 'bad.exe', reason: 'ext' }] })
    await flushPromises()
    await w.find('[data-testid="tree-upload"]').trigger('click')
    await flushPromises()
    await pickFiles(w, [new File(['MZ'], 'bad.exe', { type: 'application/octet-stream' })])
    await flushPromises()
    await w.find('[data-testid="upload-dialog-confirm"]').trigger('click')
    await flushPromises()
    await settle()
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="upload-dialog-cancel"]').isVisible()).toBe(false)
    // destroy-on-close：关门即卸内容，传输页签不存在（非隐藏）
    expect(w.find('[data-testid="upload-dialog-transfer"]').exists()).toBe(false)
    w.unmount()
  })
})
