/**
 * TrashPanel 组件测试（M3-UI 波次；TDD 红态先行——组件 frontend/src/files/ui/TrashPanel.vue 尚未落地）。
 * 契约（documents/v1.2.0执行进度.md §UI 波次契约）：
 *   props: { entries: TrashEntry[]; busy?: boolean }
 *   emits: 'restore'(选中 TrashEntry[]) | 'purge'(选中 TrashEntry[]) | 'empty'
 *   列表：checkbox 多选 + 原路径 + 删除时间（deletedAt null→'—'走 i18n）+ 版本数；
 *   工具栏：恢复 / 彻底删除 / 清空回收站（确认框在父级 workspace-ops 层，组件内不确认）
 * 断言口径：emit 实参严格；文案/testid 宽松——按契约实现侧最简路径钉位（testid 沿 UploadPanel
 *   习惯 trash-panel/trash-item；i18n 预期 t('files.trash.*') 且实现会补键，但组件测试的全局
 *   词典为空（setup.ts），t 直返 key 本身，故按钮定位同时兼容 testid / key 片段 / 中文文案）。
 * 纯展示组件：props 进事件出、无业务依赖，mount 即测（对齐 ui.test.ts 既有手法）。
 * 实现落地后本文件应转绿；若实现偏差（如另起 testid/时间格式），只调定位器与格式正则，
 * 不放宽 emit 实参断言。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { TrashEntry } from '../tree-store'
import TrashPanel from '../ui/TrashPanel.vue'

/** 条目工厂（deleteMarkerVersionId 类型必填，UI 不展示） */
const entry = (over: Partial<TrashEntry> = {}): TrashEntry => ({
  key: 'a.txt',
  deleteMarkerVersionId: 'marker-1',
  deletedAt: 1700000000000,
  versions: 1,
  ...over,
})

/** 3 条：deletedAt 分别为 时间戳 / null / 时间戳（时间列两种形态都可断言） */
const entries = (): TrashEntry[] => [
  entry({ key: 'docs/report.pdf', deletedAt: 1700000000000, versions: 3, deleteMarkerVersionId: 'm1' }),
  entry({ key: 'a/b/照片.png', deletedAt: null, versions: 2, deleteMarkerVersionId: 'm2' }),
  entry({ key: 'tmp/log.txt', deletedAt: 1735689600000, versions: 1, deleteMarkerVersionId: 'm3' }),
]

/** 行定位（testid 沿 UploadPanel 的 `<panel>-<item>` 习惯；最简实现路径） */
const rows = (w: VueWrapper) => w.findAll('[data-testid="trash-item"]')
/** 行内 checkbox（native input；el-checkbox/FcCheckbox 内层同样是 native input，通吃） */
const rowBoxes = (w: VueWrapper) => rows(w).map((r) => r.find('input[type="checkbox"]'))

/**
 * 操作按钮定位（宽松：testid 精确候选优先，按钮文本片段兜底——
 * 测试词典为空时 t 直返 key（如按钮文案='files.trash.restore'），key 片段可命中；
 * 实现若直接写中文文案（恢复/彻底删除/清空回收站）也可命中）
 */
function findBtn(w: VueWrapper, ...candidates: string[]) {
  for (const c of candidates) {
    const byTid = w.findAll(`[data-testid="${c}"]`)[0]
    if (byTid) return byTid
  }
  return w.findAll('button').find((b) => candidates.some((c) => b.text().includes(c)))
}

const RESTORE = ['trash-restore', 'restore', '恢复']
const PURGE = ['trash-purge', 'purge', '彻底删除']
const EMPTY = ['trash-empty', 'empty', '清空回收站', '清空']

describe('TrashPanel（M3-UI 契约：纯展示，emit 语义严格）', () => {
  it('渲染：3 行；每行原路径 + 版本数；时间列时间戳格式化出现、null 行显示「—」', () => {
    const w = mount(TrashPanel, { props: { entries: entries() } })
    const rs = rows(w)
    expect(rs).toHaveLength(3)
    // 原路径
    expect(rs[0]!.text()).toContain('docs/report.pdf')
    expect(rs[1]!.text()).toContain('a/b/照片.png')
    expect(rs[2]!.text()).toContain('tmp/log.txt')
    // 版本数（最简路径=数字直出，同 UploadPanel 的 `{{ x }}%`；null 行无时间数字，'2' 断言有效）
    expect(rs[0]!.text()).toContain('3')
    expect(rs[1]!.text()).toContain('2')
    expect(rs[2]!.text()).toContain('1')
    // 时间列：时间戳行格式化出现（含 4 位年份或 HH:mm——常见格式均命中，具体格式不钉）
    expect(rs[0]!.text()).toMatch(/\d{4}|\d{1,2}:\d{2}/)
    expect(rs[2]!.text()).toMatch(/\d{4}|\d{1,2}:\d{2}/)
    // null → '—'（契约原文）；若走 i18n 键（如 files.trash.no-time='—'），测试空词典直返键名——两者皆接受
    expect(rs[1]!.text()).toMatch(/—|files\.trash\./)
    w.unmount()
  })

  it('多选：勾选 2 条 → 恢复 emit("restore", 两条目数组)', async () => {
    const es = entries()
    const w = mount(TrashPanel, { props: { entries: es } })
    const boxes = rowBoxes(w)
    await boxes[0]!.setValue(true)
    await boxes[2]!.setValue(true)
    await findBtn(w, ...RESTORE)!.trigger('click')
    // 实参严格：升序勾选使「选择序」与「条目序」两种实现产出同一数组；
    // toEqual 深等同时兼容「原对象引用」与「同形状拷贝」两种实现
    expect(w.emitted('restore')).toHaveLength(1)
    expect(w.emitted('restore')?.[0]?.[0]).toEqual([es[0], es[2]])
    w.unmount()
  })

  it('多选：勾选 2 条 → 彻底删除 emit("purge", 两条目数组)（与 restore 同构）', async () => {
    const es = entries()
    const w = mount(TrashPanel, { props: { entries: es } })
    const boxes = rowBoxes(w)
    await boxes[0]!.setValue(true)
    await boxes[2]!.setValue(true)
    await findBtn(w, ...PURGE)!.trigger('click')
    expect(w.emitted('purge')).toHaveLength(1)
    expect(w.emitted('purge')?.[0]?.[0]).toEqual([es[0], es[2]])
    w.unmount()
  })

  it('清空回收站：单击即 emit("empty") 无参（组件内不确认——确认在父级/workspace-ops 层）', async () => {
    const w = mount(TrashPanel, { props: { entries: entries() } })
    await findBtn(w, ...EMPTY)!.trigger('click')
    expect(w.emitted('empty')).toHaveLength(1)
    expect(w.emitted('empty')?.[0]).toEqual([]) // 无实参
    w.unmount()
  })

  it('busy=true → 操作按钮禁用（disabled 属性，Toolbar 同款口径）；busy 缺省 → 清空钮可用', () => {
    const busy = mount(TrashPanel, { props: { entries: entries(), busy: true } })
    for (const cands of [RESTORE, PURGE, EMPTY]) {
      // restore/purge 可能叠加「无选中禁用」，busy 的主钉点是清空钮（它不依赖选中态）
      expect(findBtn(busy, ...cands)!.attributes('disabled')).toBeDefined()
    }
    busy.unmount()

    const idle = mount(TrashPanel, { props: { entries: entries() } })
    expect(findBtn(idle, ...EMPTY)!.attributes('disabled')).toBeUndefined()
    idle.unmount()
  })

  it('空态：entries=[] → 渲染空态提示（.fc-empty 空态壳或任意可见文案；非整块消失）', () => {
    const w = mount(TrashPanel, { props: { entries: [] } })
    // 文案宽松：i18n key 直返（如 'files.trash.empty'）/ '回收站为空' 等均可；红线=空态有可见提示
    expect(w.find('.fc-empty').exists() || w.text().trim().length > 0).toBe(true)
    w.unmount()
  })

  it('全选：表头 checkbox 勾选 → 全部行框选中；此时恢复=emit 全部条目', async () => {
    const es = entries()
    const w = mount(TrashPanel, { props: { entries: es } })
    // 表头全选框=DOM 首个 checkbox（表头在列表之前；行框随后）
    const selectAll = w.findAll('input[type="checkbox"]')[0]!
    await selectAll.setValue(true)
    for (const rb of rowBoxes(w)) {
      expect((rb.element as HTMLInputElement).checked).toBe(true)
    }
    await findBtn(w, ...RESTORE)!.trigger('click')
    expect(w.emitted('restore')?.[0]?.[0]).toEqual(es)
    w.unmount()
  })
})
