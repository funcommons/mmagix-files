/**
 * 工作台 UI 测试（Wave2-T2；Lane F5 交互面改版同步）。
 * - TreePanel：列表渲染、面包屑；交互模型（对齐手册「双击/回车打开」）：
 *   单击=仅选中（ctrl/cmd 切换、shift 范围）；双击文件/回车=emit open；目录双击=进入；
 *   右键菜单（openWithMenu 门控、open-with 多应用、动作派发、Esc 关闭）；拖拽上传 emit drop-files；
 *   2026-10 展开树（目录原位展开，chevron 懒加载；进入/面包屑/分页范式已废）；
 *   2026-10 布局改版：树头创建簇（上传/新建目录/刷新/搜索小图标钮 + 隐藏 input）与空白右键菜单
 * - Toolbar（选中簇：分享/下载/重命名/删除，挂预览区头右侧）：多选数组语义（下载批量启用/emit 数组、
 *   无选中禁用）、features 门控（创建簇已迁树头，不再有上传/新建目录/刷新/搜索）
 * - workspace-ops：mkdir/rename/remove（单选/多选确认文案）/ingestFiles 拒收 toast（Toolbar 与右键菜单共用链）
 * - UploadPanel：任务渲染（名/进度/状态）、取消、清除、无任务不渲染
 * - SessionBanner：正常/预警/到期（保持既有覆盖）
 * controller/queue/session 以最小 fake 注入（组件 props 面向接口，不依赖 setup 单例）。
 */
import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { ElMessageBox } from 'element-plus'
import { AppRegistry } from '@/apps/registry'
import { toast } from '@/components/sdk'
import type { DirBucket, FileTreeController } from '../tree-store'
import type { S3ObjectSummary } from '@/sdk/types'
import type { SessionController } from '@/sdk/session'
import { createWorkspaceOps } from '../ui/workspace-ops'
import TreePanel from '../ui/TreePanel.vue'
import Toolbar from '../ui/Toolbar.vue'
import UploadPanel from '../ui/UploadPanel.vue'
import SessionBanner from '../ui/SessionBanner.vue'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 测试词典：t 返回 'key'（无参）或 'key:{"n":2}' 形态（有参），便于断言用的键与参数 */
const t = vi.fn((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`,
)

function fakeTree(opts: { bucket?: DirBucket; loading?: boolean } = {}): FileTreeController {
  const nodes = new Map<string, DirBucket>()
  if (opts.bucket) nodes.set('root/', opts.bucket)
  return reactive({
    currentPath: 'root/',
    loading: opts.loading ?? false,
    error: null,
    nodes,
    loadDir: vi.fn(async () => {}),
    mkdir: vi.fn(async (p: string, name: string) => `${p}${name}/`),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  }) as unknown as FileTreeController
}

const dir = (key: string, name: string): S3ObjectSummary => ({ key, name, size: 0, isDir: true })
const file = (key: string, name: string, size = 12): S3ObjectSummary => ({ key, name, size, isDir: false })

function buttonByText(w: VueWrapper, text: string) {
  return w.findAll('button').find((b) => b.text().includes(text))
}

/** 目录+文件混合桶（a/ 目录、b.txt、c.txt、d.txt 四行） */
const mixedBucket = (): DirBucket => ({
  dirs: [dir('root/a/', 'a')],
  files: [file('root/a/b.txt', 'b.txt'), file('root/a/c.txt', 'c.txt'), file('root/a/d.txt', 'd.txt')],
  loaded: true,
})

describe('TreePanel', () => {
  it('渲染目录+文件行（名称/大小/类型），挂载即 loadDir 当前目录', () => {
    const tree = fakeTree({
      bucket: {
        dirs: [dir('root/a/', 'a')],
        files: [file('root/a/b.txt', 'b.txt', 2048)],
        loaded: true,
      },
    })
    const w = mount(TreePanel, { props: { controller: tree } })
    expect(tree.loadDir).toHaveBeenCalledWith('root/')
    expect(w.text()).toContain('a')
    expect(w.text()).toContain('b.txt')
    w.unmount()
  })

  it('目录名点击=选中+展开（loadDir 激活目录）；文件行单击=仅选中（emit select 数组）', async () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, { props: { controller: tree } })
    await w.find('[data-testid="dir-name"]').trigger('click')
    expect(w.emitted('select')?.[0]?.[0]).toEqual([expect.objectContaining({ key: 'root/a/', isDir: true })])
    expect(tree.loadDir).toHaveBeenCalledWith('root/a/') // 展开副作用=激活目录
    await w.findAll('[data-testid="row"]')[1]!.trigger('click') // b.txt（a/ 已展开，子级行在 files 段之后）
    const all = w.emitted('select') ?? []
    expect(all[all.length - 1]![0]).toEqual([expect.objectContaining({ key: 'root/a/b.txt', isDir: false })])
    w.unmount()
  })

  it('双击文件=emit open；双击目录=进入（不 emit open）', async () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, { props: { controller: tree } })
    const rows = w.findAll('[data-testid="row"]')
    await rows[1]!.trigger('dblclick') // b.txt
    expect(w.emitted('open')?.[0]?.[0]).toMatchObject({ key: 'root/a/b.txt' })
    await rows[0]!.trigger('dblclick') // a/
    expect(tree.loadDir).toHaveBeenCalledWith('root/a/')
    expect(w.emitted('open')).toHaveLength(1) // 目录双击不 emit open
    w.unmount()
  })

  it('回车=打开首个选中文件；目录选中回车=进入', async () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, {
      props: { controller: tree, selected: [file('root/a/b.txt', 'b.txt')] },
    })
    await w.find('[data-testid="tree-list"]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('open')?.[0]?.[0]).toMatchObject({ key: 'root/a/b.txt' })
    w.unmount()

    const tree2 = fakeTree({ bucket: mixedBucket() })
    const w2 = mount(TreePanel, { props: { controller: tree2, selected: [dir('root/a/', 'a')] } })
    await w2.find('[data-testid="tree-list"]').trigger('keydown', { key: 'Enter' })
    expect(w2.emitted('open')).toBeUndefined()
    expect(tree2.loadDir).toHaveBeenCalledWith('root/a/')
    w2.unmount()
  })

  it('多选：ctrl/cmd 点击切换；shift 点击取范围', async () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, { props: { controller: tree } })
    const rows = w.findAll('[data-testid="row"]')
    const lastSelect = (): S3ObjectSummary[] => {
      const all = w.emitted('select') ?? []
      return all[all.length - 1]![0] as S3ObjectSummary[]
    }
    await rows[1]!.trigger('click') // 锚点 b.txt → [b]
    await w.setProps({ selected: lastSelect() }) // 父层回传（Home 同款单向流）
    await rows[2]!.trigger('click', { ctrlKey: true }) // +c → [b,c]
    expect(lastSelect()).toEqual([
      expect.objectContaining({ key: 'root/a/b.txt' }),
      expect.objectContaining({ key: 'root/a/c.txt' }),
    ])
    await w.setProps({ selected: lastSelect() })
    await rows[1]!.trigger('click', { metaKey: true }) // 切换 b → [c]（锚点随最近一次点击移至 idx1）
    expect(lastSelect()).toEqual([expect.objectContaining({ key: 'root/a/c.txt' })])
    await w.setProps({ selected: lastSelect() })
    await rows[3]!.trigger('click', { shiftKey: true }) // 锚点 idx1 → 范围 [b,c,d]
    expect(lastSelect()).toEqual([
      expect.objectContaining({ key: 'root/a/b.txt' }),
      expect.objectContaining({ key: 'root/a/c.txt' }),
      expect.objectContaining({ key: 'root/a/d.txt' }),
    ])
    w.unmount()
  })

  it('选中高亮：selected 数组内行带 is-selected', () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, {
      props: { controller: tree, selected: [file('root/a/c.txt', 'c.txt')] },
    })
    const row = w.findAll('[data-testid="row"]')[2]!
    expect(row.classes()).toContain('is-selected')
    w.unmount()
  })

  it('拖拽：dragenter 高亮、dragleave 复原、drop emit drop-files 携 files+当前目录', async () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, { props: { controller: tree } })
    const root = w.find('.tree-panel')
    const f = new File(['hi'], 'drop.txt')
    await root.trigger('dragenter')
    expect(root.classes()).toContain('is-dragover')
    await root.trigger('dragleave')
    expect(root.classes()).not.toContain('is-dragover')
    await root.trigger('drop', { dataTransfer: { files: [f] } })
    expect(w.emitted('drop-files')?.[0]?.[0]).toEqual({ files: [f], path: 'root/' })
    w.unmount()
  })

  it('右键菜单：行 contextmenu 打开菜单（打开/重命名/删除/新建目录），点删除 emit menu-action', async () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, {
      props: { controller: tree },
      global: { stubs: { teleport: true } },
    })
    await w.findAll('[data-testid="row"]')[1]!.trigger('contextmenu', { clientX: 30, clientY: 40 })
    const menu = w.find('.fc-menu')
    expect(menu.exists()).toBe(true)
    expect(menu.text()).toContain('files.menu.open')
    expect(menu.text()).toContain('files.menu.rename')
    expect(menu.text()).toContain('files.menu.delete')
    expect(menu.text()).toContain('files.menu.mkdir')
    await menu.findAll('button').find((b) => b.text().includes('files.menu.delete'))!.trigger('click')
    expect(w.emitted('menu-action')?.[0]?.[0]).toEqual({ action: 'delete', entry: expect.objectContaining({ key: 'root/a/b.txt' }) })
    w.unmount()
  })

  it('右键菜单：listMatches>1 时列出全部命中应用，点击 emit open-with；单命中不出应用子列', async () => {
    const registry = new AppRegistry()
    registry.register({ id: 'csv-table', matcher: { ext: ['csv'] }, renderer: vi.fn() })
    registry.register({ id: 'code-editor', matcher: { ext: ['csv', 'txt'] }, renderer: vi.fn() })
    const tree = fakeTree({
      bucket: { dirs: [], files: [file('root/a/data.csv', 'data.csv'), file('root/a/b.txt', 'b.txt')], loaded: true },
    })
    const w = mount(TreePanel, {
      props: { controller: tree, registry },
      global: { stubs: { teleport: true } },
    })
    const rows = w.findAll('[data-testid="row"]')
    await rows[0]!.trigger('contextmenu') // data.csv：双命中
    let menu = w.find('.fc-menu')
    expect(menu.text()).toContain('app.csv-table')
    expect(menu.text()).toContain('app.code-editor')
    await menu.findAll('button').find((b) => b.text().includes('app.code-editor'))!.trigger('click')
    expect(w.emitted('open-with')?.[0]?.[0]).toEqual({
      entry: expect.objectContaining({ key: 'root/a/data.csv' }),
      appId: 'code-editor',
    })
    expect(w.find('.fc-menu').exists()).toBe(false) // 选中后自动关

    await rows[1]!.trigger('contextmenu') // b.txt：单命中不出「打开方式」应用子列
    menu = w.find('.fc-menu')
    expect(menu.text()).not.toContain('app.code-editor')
    w.unmount()
  })

  it('打开方式子列：def.label 优先（复审②：动态插件 manifest 自带名），无 label 回退 t(app.<id>)', async () => {
    const registry = new AppRegistry()
    registry.register({ id: 'builtin-a', matcher: { ext: ['xyz'] }, renderer: vi.fn() })
    registry.register({ id: 'plugin-b', label: 'My Plugin App', matcher: { ext: ['xyz'] }, renderer: vi.fn() })
    const tree = fakeTree({
      bucket: { dirs: [], files: [file('root/a/thing.xyz', 'thing.xyz')], loaded: true },
    })
    const w = mount(TreePanel, {
      props: { controller: tree, registry },
      global: { stubs: { teleport: true } },
    })
    await w.findAll('[data-testid="row"]')[0]!.trigger('contextmenu')
    const menu = w.find('.fc-menu')
    expect(menu.text()).toContain('My Plugin App') // manifest label 优先
    expect(menu.text()).toContain('app.builtin-a') // 无 label 回退词典键（测试 t 直返 key 原文）
    w.unmount()
  })

  it('右键菜单：Esc 关闭；features.openWithMenu=false 时不拦截默认菜单（不打开菜单）', async () => {
    const tree = fakeTree({ bucket: mixedBucket() })
    const w = mount(TreePanel, {
      props: { controller: tree },
      global: { stubs: { teleport: true } },
    })
    await w.findAll('[data-testid="row"]')[0]!.trigger('contextmenu')
    expect(w.find('.fc-menu').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await sleep(0)
    expect(w.find('.fc-menu').exists()).toBe(false)
    w.unmount()

    const off = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: mixedBucket() }), features: { openWithMenu: false } },
      global: { stubs: { teleport: true } },
    })
    await off.findAll('[data-testid="row"]')[0]!.trigger('contextmenu')
    expect(off.find('.fc-menu').exists()).toBe(false)
    off.unmount()
  })

  it('未加载/加载中显示骨架；已加载空目录显示空态', () => {
    const loading = mount(TreePanel, { props: { controller: fakeTree({ loading: true }) } })
    expect(loading.find('.fc-skeleton').exists()).toBe(true)
    loading.unmount()

    const empty = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: { dirs: [], files: [], loaded: true } }) },
    })
    expect(empty.find('.fc-empty').exists()).toBe(true)
    empty.unmount()
  })

  it('展开树：chevron 点击=懒加载展开（loadDir(dir)）+ 子级行下钻；再点收起', async () => {
    const tree = fakeTree({
      bucket: {
        dirs: [dir('root/a/', 'a')],
        files: [file('root/a/b.txt', 'b.txt')],
        loaded: true,
      },
    })
    // 预置子目录缓存（懒加载完成态）
    tree.nodes.set('root/a/', { dirs: [], files: [file('root/a/inner.md', 'inner.md')], loaded: true })
    const w = mount(TreePanel, { props: { controller: tree, rootPrefix: 'root/' } })
    // 初始：目录行 1 + 文件行 1，子级不可见
    expect(w.findAll('[data-testid="row"]')).toHaveLength(2)
    // chevron 点击 → loadDir(dir) + 子级行出现（深度缩进）
    await w.find('[data-testid="row"] .tree-panel__chev').trigger('click')
    expect(tree.loadDir).toHaveBeenCalledWith('root/a/')
    const rows = w.findAll('[data-testid="row"]')
    expect(rows).toHaveLength(3)
    expect(rows[1]!.text()).toContain('inner.md')
    expect(rows[1]!.attributes('style')).toContain('padding-left: 26px') // 10 + depth*16
    // 再点 chevron → 收起（loadDir 不再新增调用之外的状态变化）
    const calls = (tree.loadDir as ReturnType<typeof vi.fn>).mock.calls.length
    await rows[0]!.find('.tree-panel__chev').trigger('click')
    expect(w.findAll('[data-testid="row"]')).toHaveLength(2)
    expect((tree.loadDir as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
    w.unmount()
  })

  // ── 2026-10 布局改版：创建簇（上传/新建目录/刷新/搜索）自旧顶部工具条迁入树头 ──

  it('树头动作：features 缺省渲染 tree-upload/tree-mkdir/tree-refresh/tree-search/trash-open 五钮；点上传/回收站=emit upload-request/trash（选文件弹窗在 Home 层）；features.upload=false 时 tree-upload 不渲染', async () => {
    const w = mount(TreePanel, { props: { controller: fakeTree({ bucket: mixedBucket() }) } })
    for (const tid of ['tree-upload', 'tree-mkdir', 'tree-refresh', 'tree-search', 'trash-open']) {
      expect(w.find(`[data-testid="${tid}"]`).exists()).toBe(true)
    }
    await w.find('[data-testid="tree-upload"]').trigger('click')
    expect(w.emitted('upload-request')).toHaveLength(1)
    await w.find('[data-testid="trash-open"]').trigger('click')
    expect(w.emitted('trash')).toHaveLength(1)
    w.unmount()

    const off = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: mixedBucket() }), features: { upload: false } },
    })
    expect(off.find('[data-testid="tree-upload"]').exists()).toBe(false)
    expect(off.find('[data-testid="tree-mkdir"]').exists()).toBe(true)
    expect(off.find('[data-testid="tree-refresh"]').exists()).toBe(true)
    // 回收站入口独立于 upload 门控（features.trash 才管它）
    expect(off.find('[data-testid="trash-open"]').exists()).toBe(true)
    off.unmount()

    const noTrash = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: mixedBucket() }), features: { trash: false } },
    })
    expect(noTrash.find('[data-testid="trash-open"]').exists()).toBe(false)
    noTrash.unmount()
  })

  it('versioning=false（桶未开 Versioning/client 不支持）：回收站入口与右键「历史版本」均隐藏；缺省（undefined）=显示', async () => {
    const off = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: mixedBucket() }), versioning: false },
      global: { stubs: { teleport: true } },
    })
    expect(off.find('[data-testid="trash-open"]').exists()).toBe(false)
    // 行右键菜单仍开（其它动作不受影响），但无「历史版本」项（row[1]=文件行）
    await off.findAll('[data-testid="row"]')[1]!.trigger('contextmenu', { clientX: 10, clientY: 10 })
    const menu = off.find('.fc-menu')
    expect(menu.exists()).toBe(true)
    expect(menu.text()).not.toContain('files.history.menu')
    off.unmount()

    const on = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: mixedBucket() }) },
      global: { stubs: { teleport: true } },
    })
    expect(on.find('[data-testid="trash-open"]').exists()).toBe(true)
    await on.findAll('[data-testid="row"]')[1]!.trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(on.find('.fc-menu').text()).toContain('files.history.menu')
    on.unmount()
  })

  it('空白右键：.tree-panel contextmenu（非 ctrl）→ 空白菜单含 上传/新建目录/刷新 三项；features.openWithMenu=false 时不拦截（无菜单）', async () => {
    const w = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: mixedBucket() }) },
      global: { stubs: { teleport: true } },
    })
    await w.find('.tree-panel').trigger('contextmenu', { clientX: 20, clientY: 30 })
    const menu = w.find('.fc-menu')
    expect(menu.exists()).toBe(true)
    expect(menu.text()).toContain('files.toolbar.upload') // 上传
    expect(menu.text()).toContain('files.menu.mkdir') // 新建目录
    expect(menu.text()).toContain('files.toolbar.refresh') // 刷新
    w.unmount()

    const off = mount(TreePanel, {
      props: { controller: fakeTree({ bucket: mixedBucket() }), features: { openWithMenu: false } },
      global: { stubs: { teleport: true } },
    })
    await off.find('.tree-panel').trigger('contextmenu')
    expect(off.find('.fc-menu').exists()).toBe(false)
    off.unmount()
  })
})

// ───────────── Lane H-2：键盘流（Alt+↑/↓、type-ahead 循环跳转、Esc 清选、双击空白全选） ─────────────

describe('TreePanel 键盘流（Lane H-2）', () => {
  /** a/ 目录 + b1/b2/b3/c 四行文件（type-ahead 循环与接续可断言） */
  const alphaBucket = (): DirBucket => ({
    dirs: [dir('root/a/', 'a')],
    files: [
      file('root/a/b1.txt', 'b1.txt'),
      file('root/a/b2.txt', 'b2.txt'),
      file('root/a/b3.txt', 'b3.txt'),
      file('root/a/c.txt', 'c.txt'),
    ],
    loaded: true,
  })

  const list = (w: VueWrapper) => w.find('[data-testid="tree-list"]')
  const lastSelect = (w: VueWrapper): S3ObjectSummary[] => {
    const all = w.emitted('select') ?? []
    return all[all.length - 1]![0] as S3ObjectSummary[]
  }
  const selectedNames = (w: VueWrapper): string[] => lastSelect(w).map((e) => e.name)
  /** 最近一次 emit 的首参（emitted 数组无 .at，lib 口径） */
  const lastEmit = (w: VueWrapper, name: string): unknown => {
    const all = w.emitted(name) ?? []
    return all[all.length - 1]?.[0]
  }

  it('Alt+↑：收起首个选中的目录（未展开=无效）；无目录选中=无效', async () => {
    const tree = fakeTree({ bucket: alphaBucket() })
    const w = mount(TreePanel, {
      props: { controller: tree, selected: [dir('root/a/', 'a')] },
    })
    // a/ 未展开：Alt+↑ 无效果（仅挂载首刷那一次 loadDir）
    await list(w).trigger('keydown', { key: 'ArrowUp', altKey: true })
    expect(tree.loadDir).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('Alt+↓：展开首个选中的目录（loadDir 激活）；无目录选中=无效（不多发 loadDir）', async () => {
    const noDir = fakeTree({ bucket: alphaBucket() })
    const w = mount(TreePanel, { props: { controller: noDir, selected: [file('root/a/b1.txt', 'b1.txt')] } })
    await list(w).trigger('keydown', { key: 'ArrowDown', altKey: true })
    expect(noDir.loadDir).toHaveBeenCalledTimes(1) // 仅挂载首刷
    w.unmount()

    const tree = fakeTree({ bucket: alphaBucket() })
    const w2 = mount(TreePanel, { props: { controller: tree, selected: [file('root/a/b1.txt', 'b1.txt'), dir('root/a/', 'a')] } })
    await list(w2).trigger('keydown', { key: 'ArrowDown', altKey: true })
    expect(tree.loadDir).toHaveBeenCalledWith('root/a/')
    w2.unmount()
  })

  it('type-ahead：命中首个匹配并滚动可见；500ms 内同键接续下一个；绕回循环；窗口超时回锚点；大小写不敏感', async () => {
    vi.useFakeTimers()
    try {
      const tree = fakeTree({ bucket: alphaBucket() })
      const w = mount(TreePanel, { props: { controller: tree } })
      const press = (key: string) => list(w).trigger('keydown', { key })

      await press('b') // 锚点无 → 从 0 起（含）：目录 a 不匹配 → b1.txt
      expect(selectedNames(w)).toEqual(['b1.txt'])
      vi.advanceTimersByTime(100)
      await press('b') // 窗口内接续 → b2.txt
      expect(selectedNames(w)).toEqual(['b2.txt'])
      vi.advanceTimersByTime(100)
      await press('b') // → b3.txt
      expect(selectedNames(w)).toEqual(['b3.txt'])
      vi.advanceTimersByTime(100)
      await press('b') // 尾后再无 b → 绕回首个匹配 b1.txt（Quantum 循环口径）
      expect(selectedNames(w)).toEqual(['b1.txt'])
      vi.advanceTimersByTime(100)
      await press('B') // 大小写不敏感，接续 → b2.txt
      expect(selectedNames(w)).toEqual(['b2.txt'])
      vi.advanceTimersByTime(600) // 超出 500ms 窗口 → 断链
      await press('b') // 回锚点（上次命中行 b2）起算（含）→ b2.txt 重选中
      expect(selectedNames(w)).toEqual(['b2.txt'])
      vi.advanceTimersByTime(50)
      await press('z') // 无匹配：不 emit、断链
      expect(selectedNames(w)).toEqual(['b2.txt'])
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Esc：清空选中（emit select []）并关闭右键菜单', async () => {
    const tree = fakeTree({ bucket: alphaBucket() })
    const w = mount(TreePanel, {
      props: { controller: tree, selected: [file('root/a/b1.txt', 'b1.txt')] },
      global: { stubs: { teleport: true } },
    })
    await w.findAll('[data-testid="row"]')[0]!.trigger('contextmenu')
    expect(w.find('.fc-menu').exists()).toBe(true)
    await list(w).trigger('keydown', { key: 'Escape' })
    await sleep(0) // window 级 Esc 监听异步关菜单
    expect(w.find('.fc-menu').exists()).toBe(false)
    expect(lastEmit(w, 'select')).toEqual([])
    w.unmount()
  })

  it('双击列表空白区（非行）：全选当前页条目 emit select(pagedEntries)', async () => {
    const tree = fakeTree({ bucket: alphaBucket() })
    const w = mount(TreePanel, { props: { controller: tree } })
    await list(w).trigger('dblclick') // 目标=ul 自身（.self 口径）
    const all = lastSelect(w)
    expect(all).toHaveLength(5) // 目录 + 4 文件
    expect(all.map((e) => e.name)).toEqual(['a', 'b1.txt', 'b2.txt', 'b3.txt', 'c.txt'])
    w.unmount()
  })

  it('右键菜单：文件行含「分享」，点击 emit menu-action {action:"share"}；目录行不含分享项', async () => {
    const tree = fakeTree({ bucket: alphaBucket() })
    const w = mount(TreePanel, {
      props: { controller: tree },
      global: { stubs: { teleport: true } },
    })
    await w.findAll('[data-testid="row"]')[1]!.trigger('contextmenu') // b1.txt（文件）
    const menu = w.find('.fc-menu')
    expect(menu.text()).toContain('files.menu.share')
    await menu.findAll('button').find((b) => b.text().includes('files.menu.share'))!.trigger('click')
    expect(lastEmit(w, 'menu-action')).toEqual({
      action: 'share',
      entry: expect.objectContaining({ key: 'root/a/b1.txt' }),
    })

    await w.findAll('[data-testid="row"]')[0]!.trigger('contextmenu') // a/（目录）
    expect(w.find('.fc-menu').text()).not.toContain('files.menu.share')
    w.unmount()
  })
})

/** Toolbar 图标钮定位（2026-10 紧凑图标改版：无文本，按 data-testid；findAll[0]=缺位时 undefined，同 buttonByText 契约） */
function toolbarButtonByTestid(w: VueWrapper, key: 'share' | 'download' | 'rename' | 'delete') {
  return w.findAll(`[data-testid="toolbar-${key}"]`)[0]
}

describe('Toolbar（选中簇语义；2026-10 布局改版后挂预览区头右侧，创建簇已迁树头 TreePanel）', () => {
  it('无选中：删除/重命名/下载禁用；单文件选中：全部启用', () => {
    const common = { controller: fakeTree() }
    const w0 = mount(Toolbar, { props: { ...common, selected: [] } })
    expect(toolbarButtonByTestid(w0, 'delete')!.attributes('disabled')).toBeDefined()
    expect(toolbarButtonByTestid(w0, 'rename')!.attributes('disabled')).toBeDefined()
    expect(toolbarButtonByTestid(w0, 'download')!.attributes('disabled')).toBeDefined()
    w0.unmount()

    const w1 = mount(Toolbar, { props: { ...common, selected: [file('root/a/b.txt', 'b.txt')] } })
    expect(toolbarButtonByTestid(w1, 'delete')!.attributes('disabled')).toBeUndefined()
    expect(toolbarButtonByTestid(w1, 'rename')!.attributes('disabled')).toBeUndefined()
    expect(toolbarButtonByTestid(w1, 'download')!.attributes('disabled')).toBeUndefined()
    w1.unmount()
  })

  it('目录选中：下载禁用；多文件选中：下载启用且点击 emit download 数组（批量打包语义）', async () => {
    const common = { controller: fakeTree() }
    const wd = mount(Toolbar, { props: { ...common, selected: [dir('root/a/', 'a')] } })
    expect(toolbarButtonByTestid(wd, 'download')!.attributes('disabled')).toBeDefined()
    wd.unmount()

    const entries = [file('root/a/b.txt', 'b.txt'), file('root/a/c.txt', 'c.txt')]
    const wm = mount(Toolbar, { props: { ...common, selected: entries } })
    const dl = toolbarButtonByTestid(wm, 'download')!
    expect(dl.attributes('disabled')).toBeUndefined()
    await dl.trigger('click')
    expect(wm.emitted('download')?.[0]?.[0]).toEqual(entries)
    // 多文件（含目录混合）→ 下载禁用（打包仅收文件）
    const wmix = mount(Toolbar, { props: { ...common, selected: [dir('root/a/', 'a'), ...entries] } })
    expect(toolbarButtonByTestid(wmix, 'download')!.attributes('disabled')).toBeDefined()
    wmix.unmount()
    wm.unmount()
  })

  // F1 门控（UI 隐藏层）：features 显式 false → 对应操作入口不渲染。
  // 2026-10 布局改版后 Toolbar 只剩选中簇（分享/下载/重命名/删除），上传/新建目录门控移树头（见 TreePanel 用例）
  it('features 显式 false → 对应按钮隐藏（重命名/删除）；缺省键（下载）不受门控', () => {
    const w = mount(Toolbar, {
      props: {
        controller: fakeTree(),
        features: { rename: false, delete: false },
      },
    })
    expect(toolbarButtonByTestid(w, 'rename')).toBeUndefined()
    expect(toolbarButtonByTestid(w, 'delete')).toBeUndefined()
    expect(toolbarButtonByTestid(w, 'download')).toBeTruthy()
    w.unmount()

    const w2 = mount(Toolbar, {
      props: {
        controller: fakeTree(),
        features: { delete: false },
      },
    })
    expect(toolbarButtonByTestid(w2, 'delete')).toBeUndefined()
    expect(toolbarButtonByTestid(w2, 'rename')).toBeTruthy()
    expect(toolbarButtonByTestid(w2, 'download')).toBeTruthy()
    w2.unmount()
  })

  it('features.download=false → 下载按钮隐藏；其余选中簇按钮（重命名/删除）不受影响', () => {
    const w = mount(Toolbar, {
      props: {
        controller: fakeTree(),
        features: { download: false },
      },
    })
    expect(toolbarButtonByTestid(w, 'download')).toBeUndefined()
    expect(toolbarButtonByTestid(w, 'rename')).toBeTruthy()
    expect(toolbarButtonByTestid(w, 'delete')).toBeTruthy()
    w.unmount()
  })

  // Lane H-2 分享生成器入口：仅单选文件启用（目录/多选不给分享——前缀分享列 P2）
  it('分享：单选文件启用且点击 emit share(entry)；目录/多选/空选中禁用', async () => {
    const common = { controller: fakeTree() }
    const w0 = mount(Toolbar, { props: { ...common, selected: [] } })
    expect(toolbarButtonByTestid(w0, 'share')!.attributes('disabled')).toBeDefined()
    w0.unmount()

    const wd = mount(Toolbar, { props: { ...common, selected: [dir('root/a/', 'a')] } })
    expect(toolbarButtonByTestid(wd, 'share')!.attributes('disabled')).toBeDefined()
    wd.unmount()

    const wm = mount(Toolbar, {
      props: { ...common, selected: [file('root/a/b.txt', 'b.txt'), file('root/a/c.txt', 'c.txt')] },
    })
    expect(toolbarButtonByTestid(wm, 'share')!.attributes('disabled')).toBeDefined()
    wm.unmount()

    const w1 = mount(Toolbar, { props: { ...common, selected: [file('root/a/b.txt', 'b.txt')] } })
    const share = toolbarButtonByTestid(w1, 'share')!
    expect(share.attributes('disabled')).toBeUndefined()
    await share.trigger('click')
    expect(w1.emitted('share')?.[0]?.[0]).toEqual(expect.objectContaining({ key: 'root/a/b.txt' }))
    w1.unmount()
  })
})

describe('workspace-ops（Toolbar 与右键菜单共用操作链）', () => {
  const setup = () => {
    // mockReset：清调用历史（spy 跨用例共享同一 mock）并移除上例的 resolved/rejected 值
    vi.spyOn(ElMessageBox, 'prompt').mockReset()
    vi.spyOn(toast, 'confirm').mockReset()
    vi.spyOn(toast, 'error').mockReset()
    vi.spyOn(toast, 'warning').mockReset()
  }

  it('createDir：prompt 成功 → mkdir 当前目录；cancel 静默返回 null', async () => {
    setup()
    const tree = fakeTree()
    const ops = createWorkspaceOps({ tree, t })
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: ' newdir ' } as never)
    expect(await ops.createDir()).toBe('root/newdir/')
    expect(tree.mkdir).toHaveBeenCalledWith('root/', 'newdir')

    vi.mocked(ElMessageBox.prompt).mockRejectedValue('cancel')
    expect(await ops.createDir()).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()

    vi.mocked(ElMessageBox.prompt).mockRejectedValue(new Error('boom'))
    expect(await ops.createDir()).toBeNull()
    expect(toast.error).toHaveBeenCalledWith('boom')
  })

  it('createDir(target)：右键目录=其内建（mkdir 收 entry.key）；文件=其所在目录（与上传同口径）', async () => {
    setup()
    const tree = fakeTree()
    const ops = createWorkspaceOps({ tree, t })
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: 'sub' } as never)
    // 目录行右键 → 建在它里面
    expect(await ops.createDir(dir('root/apps-demo/', 'apps-demo'))).toBe('root/apps-demo/sub/')
    expect(tree.mkdir).toHaveBeenCalledWith('root/apps-demo/', 'sub')
    // 文件行右键 → 建在其所在目录
    expect(await ops.createDir(file('root/x/b.txt', 'b.txt'))).toBe('root/x/sub/')
    expect(tree.mkdir).toHaveBeenCalledWith('root/x/', 'sub')
  })

  it('renameEntry：成功返回 {from,to}（目录保尾 /）；取消返回 null', async () => {
    setup()
    const tree = fakeTree()
    const ops = createWorkspaceOps({ tree, t })
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: 'z.txt' } as never)
    expect(await ops.renameEntry(file('root/a/b.txt', 'b.txt'))).toEqual({ from: 'root/a/b.txt', to: 'root/a/z.txt' })
    expect(await ops.renameEntry(dir('root/a/', 'a'))).toEqual({ from: 'root/a/', to: 'root/z.txt/' })

    vi.mocked(ElMessageBox.prompt).mockRejectedValue('close')
    expect(await ops.renameEntry(file('root/a/b.txt', 'b.txt'))).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('removeEntries：单选用 delete-confirm(名称)、多选用 delete-multi-confirm({n})；取消/成功语义', async () => {
    setup()
    const tree = fakeTree()
    const ops = createWorkspaceOps({ tree, t })

    vi.mocked(toast.confirm).mockResolvedValue(undefined)
    expect(await ops.removeEntries([file('root/a/b.txt', 'b.txt')])).toEqual(['root/a/b.txt'])
    expect(toast.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'files.msg.delete-confirm:{"name":"b.txt"}' }))
    expect(tree.remove).toHaveBeenCalledWith(['root/a/b.txt'])

    const multi = [file('root/a/b.txt', 'b.txt'), file('root/a/c.txt', 'c.txt'), dir('root/a/', 'a')]
    expect(await ops.removeEntries(multi)).toEqual(multi.map((e) => e.key))
    expect(toast.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: `files.msg.delete-multi-confirm:${JSON.stringify({ n: 3 })}` }),
    )
    expect(tree.remove).toHaveBeenCalledWith(['root/a/b.txt', 'root/a/c.txt', 'root/a/'])

    vi.mocked(toast.confirm).mockRejectedValue('cancel')
    expect(await ops.removeEntries(multi)).toBeNull()
    expect(tree.remove).toHaveBeenCalledTimes(2)
  })

  it('ingestFiles：enqueue 透传 + 拒收汇总 toast', () => {
    setup()
    const ops = createWorkspaceOps({ tree: fakeTree(), t })
    const enqueue = vi.fn(() => ({ accepted: [{ id: 'u1' }], rejected: [{ name: 'evil.exe', reason: 'ext' as const }] }))
    const f = new File(['x'], 'ok.txt')
    ops.ingestFiles(enqueue, [f], 'root/')
    expect(enqueue).toHaveBeenCalledWith([f], 'root/')
    expect(toast.warning).toHaveBeenCalledWith(`files.msg.upload-rejected:${JSON.stringify({ n: 1 })}`)

    const enqueueOk = vi.fn(() => ({ accepted: [{ id: 'u2' }], rejected: [] }))
    ops.ingestFiles(enqueueOk, [f], 'root/')
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })
})

describe('UploadPanel', () => {
  const task = (over: Partial<{ id: string; name: string; loaded: number; total: number; status: 'uploading' | 'paused' | 'done' | 'failed' | 'cancelled' }> = {}) => ({
    id: 'u1',
    name: 'a.txt',
    loaded: 40,
    total: 100,
    status: 'uploading' as const,
    ...over,
  })

  it('无任务时不渲染', () => {
    const w = mount(UploadPanel, { props: { tasks: [] } })
    expect(w.find('[data-testid="upload-panel"]').exists()).toBe(false)
    w.unmount()
  })

  it('embedded（弹窗「传输」页签嵌入）：无面板头/无拖高把手/无关闭钮，仅裸任务清单', () => {
    const w = mount(UploadPanel, { props: { tasks: [task()], embedded: true } })
    expect(w.find('[data-testid="upload-panel"]').exists()).toBe(true)
    expect(w.find('[data-testid="upload-resize"]').exists()).toBe(false)
    expect(w.find('[data-testid="upload-close"]').exists()).toBe(false)
    expect(w.find('.upload-panel__head').exists()).toBe(false)
    expect(w.findAll('[data-testid="upload-item"]').length).toBe(1)
    expect(w.find('.upload-panel.is-embedded').exists()).toBe(true)
    w.unmount()
  })

  it('渲染任务（名/进度/状态）；取消钮仅上传中出现；点击 emit cancel(id)', async () => {
    const w = mount(UploadPanel, {
      props: {
        tasks: [
          task(),
          task({ id: 'u2', name: 'b.txt', loaded: 100, total: 100, status: 'done' }),
          task({ id: 'u3', name: 'c.txt', status: 'failed' }),
        ],
      },
    })
    expect(w.find('[data-testid="upload-panel"]').exists()).toBe(true)
    expect(w.text()).toContain('a.txt')
    expect(w.text()).toContain('40%')
    expect(w.text()).toContain('b.txt')
    expect(w.text()).toContain('c.txt')
    expect(w.findAll('[data-testid="upload-item"]').length).toBe(3)
    // 状态文案（测试 i18n 透传 key）
    expect(w.text()).toContain('files.upload.uploading')
    expect(w.text()).toContain('files.upload.done')
    expect(w.text()).toContain('files.upload.failed')
    // 取消钮：仅 uploading 项
    const cancels = w.findAll('[data-testid="upload-cancel"]')
    expect(cancels.length).toBe(1)
    await cancels[0]!.trigger('click')
    expect(w.emitted('cancel')?.[0]).toEqual(['u1'])
    w.unmount()
  })

  it('存在终态任务时显示清除钮；点击 emit clear', async () => {
    const w0 = mount(UploadPanel, { props: { tasks: [task()] } })
    expect(w0.find('[data-testid="upload-clear"]').exists()).toBe(false)
    w0.unmount()

    const w = mount(UploadPanel, { props: { tasks: [task({ status: 'cancelled' })] } })
    await w.find('[data-testid="upload-clear"]').trigger('click')
    expect(w.emitted('clear')).toHaveLength(1)
    w.unmount()
  })

  // R2-10：暂停态不再渲染灰显「暂停」钮——paused 行只显 继续/取消
  it('paused 任务：无暂停钮（R2-10），继续/取消可见；uploading 任务：暂停钮可见', async () => {
    const w = mount(UploadPanel, {
      props: {
        tasks: [
          task({ id: 'u1', status: 'paused' }),
          task({ id: 'u2', name: 'b.txt', status: 'uploading' }),
        ],
      },
    })
    expect(w.text()).toContain('transfer.paused')
    const items = w.findAll('[data-testid="upload-item"]')
    expect(items).toHaveLength(2)
    // paused 行：无暂停钮，有继续/取消
    const pausedItem = items[0]!
    expect(pausedItem.find('[data-testid="upload-pause"]').exists()).toBe(false)
    expect(pausedItem.find('[data-testid="upload-resume"]').exists()).toBe(true)
    expect(pausedItem.find('[data-testid="upload-cancel"]').exists()).toBe(true)
    await pausedItem.find('[data-testid="upload-resume"]').trigger('click')
    expect(w.emitted('resume')?.[0]).toEqual(['u1'])
    // uploading 行：暂停钮可见且 emit pause(id)
    const uploadingItem = items[1]!
    expect(uploadingItem.find('[data-testid="upload-pause"]').exists()).toBe(true)
    await uploadingItem.find('[data-testid="upload-pause"]').trigger('click')
    expect(w.emitted('pause')?.[0]).toEqual(['u2'])
    w.unmount()
  })
})

describe('SessionBanner', () => {
  function fakeSession(state: { warned: boolean; expired: boolean }): SessionController {
    return {
      get warnedOnce() {
        return state.warned
      },
      isExpired: () => state.expired,
    } as unknown as SessionController
  }

  it('正常态不渲染横幅与整屏终态', async () => {
    const state = { warned: false, expired: false }
    const w = mount(SessionBanner, { props: { session: fakeSession(state), intervalMs: 5 } })
    await sleep(20)
    expect(w.find('.el-alert').exists()).toBe(false)
    expect(w.find('[data-testid="expired-mask"]').exists()).toBe(false)
    w.unmount()
  })

  it('轮询捕获 warned → 预警横幅；expired → 整屏终态（含重新加载按钮）', async () => {
    const state = { warned: false, expired: false }
    const w = mount(SessionBanner, { props: { session: fakeSession(state), intervalMs: 5 } })
    state.warned = true
    await sleep(20)
    expect(w.find('.el-alert').exists()).toBe(true)
    state.expired = true
    await sleep(20)
    expect(w.find('[data-testid="expired-mask"]').exists()).toBe(true)
    expect(buttonByText(w, 'reload')).toBeTruthy()
    w.unmount()
  })
})
