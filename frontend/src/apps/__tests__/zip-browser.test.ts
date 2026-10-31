/**
 * ZipBrowser 组件测试（M4-UI 波次；TDD 红态先行——组件 frontend/src/apps/ui/ZipBrowser.vue 尚未落地）。
 * 契约（docs/design/capabilities-contract-v1.2.0.md §UI 波次契约 M4-UI）：
 *   props: { load: () => Promise<ZipCentral>; extract: (entries: ZipEntryMeta[]) => Promise<void>;
 *            download: (entries: ZipEntryMeta[]) => Promise<void>; busy?: boolean }
 *   行为：mount 调 load → 条目表（名称/大小/修改时间/🔒加密标）；勾选→「解出所选」调 extract；
 *        「全部解出」「下载所选」同构；load reject → 错误态；加密条目默认不可勾+提示行。
 *   回调注入缝：IO 全在 props 回调里，组件纯测——load/extract/download 用 vi.fn 桩，无业务依赖。
 * 断言口径（对齐 trash-panel.test.ts 三段候选手法）：回调实参严格（toEqual 深等，同时兼容原对象
 *   引用与同形状拷贝两种实现）；文案/testid 宽松——测试全局词典为空（setup.ts）时 t 直返 key 本身，
 *   故按钮定位 testid 候选优先、i18n key 片段与中文文案兜底。
 * 行渲染顺序按 entries 原序（最简实现路径钉位）；目录/加密条目的「不可解出」语义由「全部解出」
 *   用例兜底验证（extract 实参不含二者）。
 */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { ZipCentral, ZipEntryMeta } from '../../files/zip-reader'
import ZipBrowser from '../ui/ZipBrowser.vue'

/** 条目工厂（ZipEntryMeta 全字段必填；crc32/offset 等 UI 不展示但类型要求） */
const meta = (over: Partial<ZipEntryMeta> = {}): ZipEntryMeta => ({
  name: 'a.txt',
  size: 1024,
  compressedSize: 512,
  method: 8,
  crc32: 0xdeadbeef,
  lastModified: 1700000000000,
  encrypted: false,
  offset: 100,
  isDirectory: false,
  ...over,
})

/** 3 个可解文件条目 + 1 个加密条目 + 1 个目录条目（顺序即行序） */
const central = (): ZipCentral => ({
  entries: [
    meta({ name: 'a.txt' }),
    meta({ name: 'b/照片.png', size: 2048, compressedSize: 1800, offset: 800 }),
    meta({ name: 'd.log', size: 64, compressedSize: 64, method: 0, offset: 1600 }),
    meta({ name: 'secret.txt', size: 128, compressedSize: 144, encrypted: true, offset: 2000 }),
    meta({ name: 'docs/', size: 0, compressedSize: 0, method: 0, isDirectory: true, offset: 2400 }),
  ],
  zip64: false,
  comment: '',
})

const filesOf = (c: ZipCentral) => c.entries.filter((e) => !e.encrypted && !e.isDirectory)

async function mountedBrowser(centralResult: ZipCentral | Error, busy = false) {
  const load = vi.fn(
    centralResult instanceof Error
      ? () => Promise.reject(centralResult)
      : () => Promise.resolve(centralResult),
  )
  const extract = vi.fn(async (_entries: ZipEntryMeta[]) => {})
  const download = vi.fn(async (_entries: ZipEntryMeta[]) => {})
  const w = mount(ZipBrowser, { props: { load, extract, download, busy } })
  await flushPromises() // mount 调 load → 等渲染
  return { w, load, extract, download }
}

/** 行定位（testid 沿 UploadPanel 的 `<panel>-<item>` 习惯：zip-item） */
const rows = (w: VueWrapper) => w.findAll('[data-testid="zip-item"]')
/** 行内 checkbox（native input；el-checkbox/FcCheckbox 内层同为 native input，通吃） */
const rowBox = (r: ReturnType<VueWrapper['find']>) => r.find('input[type="checkbox"]')
/** 可勾行（checkbox 存在且未禁用）——加密/目录行按契约不可勾，天然被过滤 */
const checkableBoxes = (w: VueWrapper) =>
  rows(w)
    .map((r) => rowBox(r))
    .filter((b) => b.exists() && !(b.element as HTMLInputElement).disabled)

/**
 * 操作按钮定位（三段候选：testid 精确候选 → i18n key 片段/中文文案兜底；
 * 空词典下 t 直返 key（如按钮文案='zip.extract-selected'），key 片段可命中；
 * 实现若直接写中文文案（解出所选/全部解出/下载）也可命中）
 */
function findBtn(w: VueWrapper, ...candidates: string[]) {
  for (const c of candidates) {
    const byTid = w.findAll(`[data-testid="${c}"]`)[0]
    if (byTid) return byTid
  }
  return w.findAll('button').find((b) => candidates.some((c) => b.text().includes(c)))
}

const EXTRACT = ['zip-extract', 'extract-selected', '解出所选', 'extract']
const EXTRACT_ALL = ['zip-extract-all', 'extract-all', '全部解出']
const DOWNLOAD = ['zip-download', 'download-selected', '下载所选', '下载']
const RETRY = ['zip-retry', 'retry', '重试']

describe('ZipBrowser（M4-UI 契约：IO 回调注入，extract/download 实参严格）', () => {
  it('load 渲染：mount 即调 load；5 行（3 文件+1 加密+1 目录）；名称/大小/修改时间齐备；加密行有 🔒 标记', async () => {
    const c = central()
    const { w, load } = await mountedBrowser(c)
    // mount 即 load（契约：mount 调 load）
    expect(load).toHaveBeenCalledTimes(1)
    const rs = rows(w)
    expect(rs).toHaveLength(5)
    // 名称列（含目录与加密条目都在表中呈现）
    expect(rs[0]!.text()).toContain('a.txt')
    expect(rs[1]!.text()).toContain('b/照片.png')
    expect(rs[2]!.text()).toContain('d.log')
    expect(rs[3]!.text()).toContain('secret.txt')
    expect(rs[4]!.text()).toContain('docs/')
    // 大小列：原始字节或格式化（1024 → '1024' | '1.0 KB' | '1 KB' 等）均命中
    expect(rs[0]!.text()).toMatch(/1024|1(\.\d+)?\s*(K|KB)/)
    expect(rs[1]!.text()).toMatch(/2048|2(\.\d+)?\s*(K|KB)/)
    expect(rs[2]!.text()).toMatch(/64|(\d+(\.\d+)?)\s*B/)
    // 修改时间列：格式化出现（4 位年份或 HH:mm——常见格式均命中，具体格式不钉）
    expect(rs[0]!.text()).toMatch(/\d{4}|\d{1,2}:\d{2}/)
    expect(rs[2]!.text()).toMatch(/\d{4}|\d{1,2}:\d{2}/)
    // 加密标：🔒 或文案（含 i18n key 直返形态）/ disabled 等兜底记号——宽松命中其一
    expect(rs[3]!.text()).toMatch(/🔒|加密|encrypt|lock/i)
    // 目录条目：呈现但不可勾选或无解出意义（契约注释口径）——勾选侧由「全部解出」用例兜底
    //   （extract 实参不含目录）；若目录行也渲染 checkbox，其 excluded 语义已由用例 3 钉死
    const dirBox = rowBox(rs[4]!)
    if (dirBox.exists()) expect((dirBox.element as HTMLInputElement).disabled).toBe(true)
    w.unmount()
  })

  it('勾选解出：勾 2 条 → 「解出所选」→ extract 收到该 2 个 ZipEntryMeta（实参严格）', async () => {
    const c = central()
    const { w, extract } = await mountedBrowser(c)
    const boxes = checkableBoxes(w)
    expect(boxes.length).toBeGreaterThanOrEqual(3) // 3 个可解文件行可勾
    await boxes[0]!.setValue(true)
    await boxes[2]!.setValue(true)
    await findBtn(w, ...EXTRACT)!.trigger('click')
    // 实参严格：toEqual 深等同时兼容「原对象引用」与「同形状拷贝」两种实现；
    // 升序勾选使「选择序」与「条目序」两种实现产出同一数组；加密/目录行不可勾故不入参
    expect(extract).toHaveBeenCalledTimes(1)
    expect(extract.mock.calls[0]![0]).toEqual([c.entries[0], c.entries[2]])
    w.unmount()
  })

  it('全部解出：「全部解出」→ extract 收到全部非加密文件条目（不含加密条目、不含目录）', async () => {
    const c = central()
    const { w, extract } = await mountedBrowser(c)
    await findBtn(w, ...EXTRACT_ALL)!.trigger('click')
    expect(extract).toHaveBeenCalledTimes(1)
    // 严格口径：恰好 3 条文件条目按原序；secret.txt（加密）与 docs/（目录）被排除
    expect(extract.mock.calls[0]![0]).toEqual(filesOf(c))
    expect(extract.mock.calls[0]![0]).not.toContain(c.entries[3]) // 加密条目绝不入参
    expect(extract.mock.calls[0]![0]).not.toContain(c.entries[4]) // 目录条目不入参
    w.unmount()
  })

  it('加密条目不可勾：加密行 checkbox disabled 或缺失（其一即过）；顶部有加密提示文案（宽松）', async () => {
    const { w } = await mountedBrowser(central())
    const encRow = rows(w)[3]!
    const box = rowBox(encRow)
    // 断言其一：实现可渲染 disabled checkbox，也可干脆不渲染（两种都满足「默认不可勾」契约）
    expect(!box.exists() || (box.element as HTMLInputElement).disabled).toBe(true)
    // 顶部提示行：加密相关文案存在（'加密'中文 / i18n key 直返含 'encrypt' / 🔒 均可）
    expect(w.text()).toMatch(/加密|encrypt|🔒/i)
    w.unmount()
  })

  it('下载所选：勾 1 条 → 「下载」→ download 收到该 1 条（实参精确）', async () => {
    const c = central()
    const { w, download, extract } = await mountedBrowser(c)
    const boxes = checkableBoxes(w)
    await boxes[1]!.setValue(true) // 勾 b/照片.png
    await findBtn(w, ...DOWNLOAD)!.trigger('click')
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]![0]).toEqual([c.entries[1]])
    expect(extract).not.toHaveBeenCalled() // extract 不被误触
    w.unmount()
  })

  it('load reject：错误态渲染（错误文案/重试钮宽松断言——非空白即过；重试候选存在则复调 load）', async () => {
    const { w, load } = await mountedBrowser(new Error('zip: EOCD 未找到'))
    // 错误态非空白（错误文案或重试钮文案均可；i18n key 直返形态也算）
    expect(w.text().trim().length).toBeGreaterThan(0)
    const retry = findBtn(w, ...RETRY)
    if (retry) {
      load.mockClear()
      load.mockImplementation(() => Promise.resolve(central()))
      await retry.trigger('click')
      await flushPromises()
      expect(load).toHaveBeenCalledTimes(1) // 重试复走 load
    }
    w.unmount()
  })

  it('busy=true → 操作钮禁用（解出所选/全部解出/下载 均带 disabled）；不触发 extract', async () => {
    const { w, extract } = await mountedBrowser(central(), true)
    for (const cands of [EXTRACT, EXTRACT_ALL, DOWNLOAD]) {
      // 解出所选可能叠加「无选中禁用」，busy 的主钉点是全部解出/下载（不依赖选中态）
      expect(findBtn(w, ...cands)!.attributes('disabled')).toBeDefined()
    }
    await findBtn(w, ...EXTRACT_ALL)!.trigger('click')
    expect(extract).not.toHaveBeenCalled() // busy 下禁用点击不产生副作用
    w.unmount()
  })

  it('零条目：entries=[] → 空态文案（非空白；无行渲染）', async () => {
    const { w } = await mountedBrowser({ entries: [], zip64: false, comment: '' })
    expect(rows(w)).toHaveLength(0)
    // 空态提示：'为空'/'empty' 中文或 key 直返形态均可——红线=有可见提示而非整块空白
    expect(w.text().trim().length).toBeGreaterThan(0)
    w.unmount()
  })
})
