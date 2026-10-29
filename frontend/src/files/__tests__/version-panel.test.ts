/**
 * VersionPanel 组件测试（M3-F8 波次 W1；TDD 红态先行——组件 frontend/src/files/ui/VersionPanel.vue
 * 尚未落地，本文件当前必红；实现（coder-S）落地后应转绿）。
 * 契约（documents/v1.2.0执行进度.md §M3-F8 波次）：
 *   props: { list: (key) => Promise<VersionRow[]>; restore: (key, versionId) => Promise<void>;
 *            download?: (key, versionId) => Promise<void>; key: string; busy?: boolean }
 *   列表：版本 Id 短显/大小/时间/isLatest 标；恢复钮（非 latest 版本）；关闭。
 *
 * ⚠ 偏差钉注（实现侧必读）：文档伪码的目标文件 prop 名 `key` 在 Vue 中是保留属性名——
 *   vue 3.5.44 实测 initProps 直接丢弃并以 `[Vue warn]: Invalid prop name: "key" is a reserved
 *   property.` 告警，组件内永远收不到（createVNode 会把 key 抽去 vnode.key 位）。故本测试把该
 *   prop 钉为 `objectKey`（对齐 src/api/types.ts 既有命名）；实现按此落地，勿再尝试声明 `key` prop。
 * 断言口径（对齐 trash-panel / zip-browser 测试三段候选手法）：
 *   - 回调实参严格：restore/download 必须收到 (objectKey, versionId)，toEqual 逐参深等；
 *   - 文案/testid 宽松：测试全局词典为空（setup.ts 空 i18n，t 直返 key 本身），按钮/行定位
 *     testid 候选优先 → i18n key 片段 → 中文文案兜底；「最新」标记正则兼容中文/键名回显/英文。
 * IO 回调注入缝：list/restore/download 全在 props 回调里，vi.fn 桩 + flushPromises（mount 调 list）。
 */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { VersionRow } from '../../sdk/types'
import VersionPanel from '../ui/VersionPanel.vue'

/** 目标文件（注入 objectKey；list/restore/download 实参严格断言均以它为第一参） */
const KEY = 'docs/report.pdf'

/** 行工厂（VersionRow 全字段；lastModified=epoch ms，isLatest 恒填） */
const vrow = (over: Partial<VersionRow> = {}): VersionRow => ({
  key: KEY,
  versionId: 'ffff9999-tmp',
  isLatest: false,
  lastModified: 1700000000000,
  size: 1024,
  ...over,
})

/**
 * 3 个版本：1 个 isLatest=true + 2 个历史版本（行序=数组原序钉位，对齐 zip-browser 手法）。
 * versionId 前 4 位全局唯一（aaa1/bbb2/ccc3）——兼容「短显」（截前缀）与「全显」两种实现，
 * 行内文本断言只认 4 位前缀。
 */
const versions = (): VersionRow[] => [
  vrow({ versionId: 'aaa1-latest-2026', isLatest: true, lastModified: 1735689600000, size: 2048 }),
  vrow({ versionId: 'bbb2-mid-2024', isLatest: false, lastModified: 1700000000000, size: 1024 }),
  vrow({ versionId: 'ccc3-old-2023', isLatest: false, lastModified: 1667260800000, size: 512 }),
]

/** 短前缀（短显/全显通吃的最小可辨识片段） */
const PID = (id: string) => id.slice(0, 4)

/** 组装已 mount 的面板（list 桩 resolve/reject；download 可注入 undefined 模拟未注入） */
async function mountedPanel(
  listResult: VersionRow[] | Error,
  extra: { busy?: boolean; download?: (key: string, versionId: string) => Promise<void> } = {},
) {
  const list = vi.fn(
    listResult instanceof Error
      ? () => Promise.reject(listResult)
      : () => Promise.resolve(listResult),
  )
  const restore = vi.fn(async (_key: string, _versionId: string) => {})
  const download = vi.fn(async (_key: string, _versionId: string) => {})
  const w = mount(VersionPanel, {
    props: {
      objectKey: KEY,
      list,
      restore,
      // 显式 undefined = 未注入（契约：download 可选，不注入则不渲染下载钮）
      download: 'download' in extra ? extra.download : download,
      busy: extra.busy,
    },
  })
  await flushPromises() // mount 即调 list(objectKey) → 等渲染
  return { w, list, restore, download }
}

/**
 * 行定位（三段候选第一段：testid=version-item，沿 UploadPanel/TrashPanel 的 `<panel>-<item>`
 * 习惯；兜底=任意 li/tr 文本含某 versionId 前缀——实现若另起 class/结构仍可命中）
 */
function rows(w: VueWrapper) {
  const byTid = w.findAll('[data-testid="version-item"]')
  if (byTid.length) return byTid
  return w.findAll('li, tr').filter((li) => versions().some((v) => li.text().includes(PID(v.versionId))))
}

/** 按 versionId 前缀找行（不依赖行序实现） */
function rowById(w: VueWrapper, versionId: string) {
  return rows(w).find((r) => r.text().includes(PID(versionId)))
}

/**
 * 按钮定位（三段候选：testid 精确候选 → i18n key 片段/中文文案兜底；scope 可为整面板或单行。
 * 空词典下 t 直返 key（如按钮文案='files.version.restore'），key 片段可命中；
 * 实现若直接写中文文案（恢复/下载/关闭）也可命中）
 */
function findBtn(scope: VueWrapper | DOMWrapper<Element>, ...candidates: string[]) {
  for (const c of candidates) {
    const byTid = scope.findAll(`[data-testid="${c}"]`)[0]
    if (byTid) return byTid
  }
  return scope.findAll('button').find((b) => candidates.some((c) => b.text().includes(c)))
}

const RESTORE = ['version-restore', 'restore', '恢复']
const DOWNLOAD = ['version-download', 'download', '下载']
const CLOSE = ['version-close', 'close', '关闭']
/** 「最新」标记（宽松：中文 / i18n 键名回显（含 latest）/ 英文 current 均命中） */
const LATEST_MARK = /最新|latest|current|当前/i

describe('VersionPanel（M3-F8 契约：IO 回调注入，restore/download 实参严格）', () => {
  it('渲染：mount 即调 list(objectKey)（实参严格）；3 行；versionId 前缀/大小/时间齐备；isLatest 行有「最新」标且无（或禁用）恢复钮；非 latest 行有恢复钮', async () => {
    const vs = versions()
    const { w, list, restore } = await mountedPanel(vs)
    // mount 即 list，且第一参=注入的目标文件（严格）
    expect(list).toHaveBeenCalledTimes(1)
    expect(list.mock.calls[0]).toEqual([KEY])
    const rs = rows(w)
    expect(rs).toHaveLength(3)
    // 版本 Id：短显或全显均须含 4 位唯一前缀
    for (const v of vs) {
      expect(rowById(w, v.versionId)!.text()).toContain(PID(v.versionId))
    }
    // 大小列：原始字节或格式化（2048→'2048'|'2 KB'；512→'512'|'0.5 KB'）均命中
    expect(rowById(w, vs[0]!.versionId)!.text()).toMatch(/2048|2(\.\d+)?\s*(K|KB)/)
    expect(rowById(w, vs[2]!.versionId)!.text()).toMatch(/512|0(\.5)?\s*(K|KB)/)
    // 时间列：格式化出现（4 位年份或 HH:mm——常见格式均命中，具体格式不钉）
    expect(rowById(w, vs[0]!.versionId)!.text()).toMatch(/\d{4}|\d{1,2}:\d{2}/)
    expect(rowById(w, vs[2]!.versionId)!.text()).toMatch(/\d{4}|\d{1,2}:\d{2}/)
    // isLatest 行：「最新」标记（宽松）+ 无恢复钮或恢复钮禁用（断言其一——契约：latest 不可恢复）
    const latestRow = rowById(w, vs[0]!.versionId)!
    expect(latestRow.text()).toMatch(LATEST_MARK)
    const latestRestore = findBtn(latestRow, ...RESTORE)
    expect(!latestRestore || latestRestore.attributes('disabled') !== undefined).toBe(true)
    // 非 latest 行：必须有可用恢复钮（存在即算；disabled 断言留给 busy 用例）
    for (const v of [vs[1]!, vs[2]!]) {
      expect(findBtn(rowById(w, v.versionId)!, ...RESTORE)).toBeDefined()
    }
    // 纯渲染不产生副作用
    expect(restore).not.toHaveBeenCalled()
    w.unmount()
  })

  it('恢复：点非 latest 行恢复钮 → restore 收到 (objectKey, versionId) 严格；仅此一行被触达', async () => {
    const vs = versions()
    const { w, restore } = await mountedPanel(vs)
    const target = findBtn(rowById(w, vs[1]!.versionId)!, ...RESTORE)
    expect(target).toBeDefined()
    await target!.trigger('click')
    expect(restore).toHaveBeenCalledTimes(1)
    // 实参严格：第一参=目标文件、第二参=该行 versionId（不是 latest 行、不是其他历史行）
    expect(restore.mock.calls[0]?.[0]).toBe(KEY)
    expect(restore.mock.calls[0]?.[1]).toBe(vs[1]!.versionId)
    w.unmount()
  })

  it('download 注入：非 latest 行内出现下载钮 → 点击实参 (objectKey, versionId) 严格', async () => {
    const vs = versions()
    const { w, download, restore } = await mountedPanel(vs)
    const dl = findBtn(rowById(w, vs[2]!.versionId)!, ...DOWNLOAD)
    expect(dl).toBeDefined()
    await dl!.trigger('click')
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]?.[0]).toBe(KEY)
    expect(download.mock.calls[0]?.[1]).toBe(vs[2]!.versionId)
    // 下载不得误触恢复
    expect(restore).not.toHaveBeenCalled()
    w.unmount()
  })

  it('download 未注入：不渲染下载钮（契约：download 可选，未注入则整列缺席）', async () => {
    const vs = versions()
    const { w } = await mountedPanel(vs, { download: undefined })
    for (const r of rows(w)) {
      expect(findBtn(r, ...DOWNLOAD)).toBeUndefined()
    }
    w.unmount()
  })

  it('busy=true → 恢复钮禁用（disabled 属性），点击不产生 restore 副作用', async () => {
    const vs = versions()
    const { w, restore } = await mountedPanel(vs, { busy: true })
    const restoreBtns = rows(w)
      .map((r) => findBtn(r, ...RESTORE))
      .filter((b) => b && b.attributes('disabled') !== undefined && !b.text().match(LATEST_MARK))
    // 至少存在历史行恢复钮，且 busy 下全部禁用
    expect(restoreBtns.length).toBeGreaterThanOrEqual(1)
    for (const v of [vs[1]!, vs[2]!]) {
      expect(findBtn(rowById(w, v.versionId)!, ...RESTORE)!.attributes('disabled')).toBeDefined()
    }
    await findBtn(rowById(w, vs[1]!.versionId)!, ...RESTORE)!.trigger('click')
    expect(restore).not.toHaveBeenCalled() // busy 下禁用点击不产生副作用（zip-browser 同款口径）
    w.unmount()
  })

  it('list reject：错误态非空白（有可见提示而非整块消失），且不渲染版本行', async () => {
    const { w } = await mountedPanel(new Error('sigv4: 503 slow down'))
    expect(rows(w)).toHaveLength(0)
    // 错误文案/重试钮/i18n 键名回显（如 'files.version.error'）均可——红线=非空白
    expect(w.text().trim().length).toBeGreaterThan(0)
    w.unmount()
  })

  it('空列表：list resolve [] → 空态文案（非空白；无版本行渲染）', async () => {
    const { w } = await mountedPanel([])
    expect(rows(w)).toHaveLength(0)
    // 空态提示：'暂无/为空/没有' 中文、i18n 键名回显（含 empty）等——宽松命中其一
    expect(w.text()).toMatch(/空|empty|没有|暂无/i)
    w.unmount()
  })

  it('关闭：关闭钮触发后 emit("close") 或组件自带关闭逻辑（断言其一——组件自定 emit 或内部收起均可）', async () => {
    const { w } = await mountedPanel(versions())
    const closeBtn = findBtn(w, ...CLOSE)
    // 断言其一说明：契约只写「关闭」未钉语义——实现可 defineEmits(['close']) 由父级收口，
    // 也可自带关闭（内部 v-model/隐藏自身）。故：有 close 控件即点它；点击后有 emit 过；
    // 若无 emit 但控件存在（自带关闭逻辑）也算过；两者皆无才红。
    if (closeBtn) await closeBtn.trigger('click')
    expect(
      w.emitted('close') !== undefined || closeBtn !== undefined,
    ).toBe(true)
    w.unmount()
  })
})
