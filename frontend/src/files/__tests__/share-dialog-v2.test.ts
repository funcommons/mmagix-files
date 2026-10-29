/**
 * ShareDialog 增强面组件测试（M5-UI-b 波次；TDD 红态先行——增强 props 尚未落地，预期红）。
 * 契约（documents/v1.2.0执行进度.md §UI 波次契约 M5-UI-b）：props 追加（皆可选，注入则启用增强面）：
 *   createShare?: (input: { key; name; size; password; ttlMs }) => Promise<{ shareId; url }>
 *   listShares?: () => Promise<ShareRow[]>      // ShareRow = { shareId; key; name; createdAt; expiresAt }
 *   revokeShare?: (shareId: string) => Promise<void>
 * 行为：密码开关（默认随机 6 位+重掷）+ 有效期（1h/24h/7d/自定义≤7d 超标禁用/拒调）→ 生成调
 *   createShare → 结果区链接+密码同框各带复制；「管理」区：listShares 列表（目标/到期/复制/撤销）；
 *   回调未注入 → 增强面整体不渲染（向后兼容，既有用例零回归）。
 * 断言口径：
 *   - 向后兼容红线（用例 1）为常绿护栏：三回调全缺 → 增强面三锚点（密码框/重掷/管理区）absence
 *     + 有效期仍三档——实现落地前后都必须绿；
 *   - createShare 实参严格 toEqual 五键（key/name/size/password/ttlMs），多余键/错值即红；
 *   - 定位器宽松三段候选（testid / i18n key 片段 / 中文文案，参照 trash-panel.test.ts）——
 *     测试全局词典为空（setup.ts），t 直返 key 本身，键片段（如 'reroll'/'revoke'）即可命中按钮文本；
 *   - 「断言其一」处（超标=禁用或拒调；错误提示=内联文本或 toast；行消失=本地移除或重拉）
 *     均已在用例内注释取舍依据；
 *   - mount 手法/i18n 与既有 share-dialog.test.ts 对齐：fake client 注入、toast 模块级换桩、
 *     逐用例 unmount；本文件不改既有测试与组件源码。
 * 实现落地后本文件应转绿；若实现偏差（另起 testid/文案），只调定位器候选，不放宽实参断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { S3Client, S3ObjectSummary } from '@/sdk/types'
import ShareDialog from '../ui/ShareDialog.vue'

const { toastSpies } = vi.hoisted(() => ({
  toastSpies: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

// 只换 toast（reject 用例可能走 toast.error 通道），组件库其余导出保持原实现
vi.mock('@/components/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/sdk')>()
  return { ...actual, toast: toastSpies as unknown as typeof actual.toast }
})

/** 契约 ShareRow（M5-UI-b 原文五字段；实现可另写类型，测试面以形状为准） */
interface ShareRowLike {
  shareId: string
  key: string
  name: string
  createdAt: number
  expiresAt: number
}

const fileEntry = (over: Partial<S3ObjectSummary> = {}): S3ObjectSummary => ({
  key: 'root/a/report.pdf',
  name: 'report.pdf',
  size: 1024,
  isDir: false,
  ...over,
})

/** 双预签名 fake（沿用既有测试：增强面生成可能仍要求 canShare 门控，故统一给满能力 client） */
function makePresignClient(): S3Client {
  return {
    getPresignedUrl: vi.fn((key: string, expiresSec?: number) => `https://s3.test/get/${key}?expires=${String(expiresSec)}&m=get`),
    presignPutUrl: vi.fn((key: string, expiresSec?: number) => `https://s3.test/put/${key}?expires=${String(expiresSec)}&m=put`),
  } as unknown as S3Client
}

const shareRow = (over: Partial<ShareRowLike> = {}): ShareRowLike => ({
  shareId: 'sid-a',
  key: 'root/a/report.pdf',
  name: 'report.pdf',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_086_400_000,
  ...over,
})

const createShareOk = (): Mock => vi.fn().mockResolvedValue({ shareId: 'sid-new', url: 'https://share.test/s/sid-new' })

function mountV2(opts: {
  client?: S3Client
  entry?: S3ObjectSummary | null
  createShare?: Mock
  listShares?: Mock
  revokeShare?: Mock
} = {}) {
  const { client, entry, createShare, listShares, revokeShare } = opts
  const w: VueWrapper = mount(ShareDialog, {
    props: {
      client: client ?? makePresignClient(),
      entry: entry !== undefined ? entry : fileEntry(),
      // 未注入的回调不传键：贴近「未注入」语义（undefined 键在 Vue 侧与缺省同形，但显式省略更纯）
      ...(createShare ? { createShare } : {}),
      ...(listShares ? { listShares } : {}),
      ...(revokeShare ? { revokeShare } : {}),
    },
  })
  return w
}

const body = (w: VueWrapper) => w.find('[data-testid="share-dialog"]')

// ── 定位器（三段候选：testid 精确 → i18n key 片段/中文文案兜底；空词典下 key 直返即文本） ──

const REROLL_CANDS = ['share-password-reroll', 'share-reroll', 'reroll', '重掷', '重新随机', '换一个']
const REVOKE_CANDS = ['share-revoke', 'revoke', '撤销']
const CUSTOM_CANDS = ['share-expiry-custom', 'expiry-custom', 'custom', '自定义']
const RESULT_TIDS = ['share-result', 'share-share-result', 'share-created']
const ERROR_TIDS = ['share-error', 'share-result-error', 'share-create-error']
const MANAGE_TIDS = ['share-manage', 'share-manage-area', 'share-list']

/** 按钮/控件定位：testid 候选优先，按钮文本片段兜底（同 trash-panel.test.ts 手法） */
function findBtn(w: VueWrapper, ...candidates: string[]) {
  for (const c of candidates) {
    const byTid = w.findAll(`[data-testid="${c}"]`)[0]
    if (byTid) return byTid
  }
  return w.findAll('button').find((b) => candidates.some((c) => b.text().includes(c)))
}

function findByTid(w: VueWrapper, ...tids: string[]) {
  for (const t of tids) {
    const el = w.find(`[data-testid="${t}"]`)
    if (el.exists()) return el
  }
  return null
}

/** 密码框定位：testid 命中元素本身是 input 直接用；是容器则找其内层第一个 input */
function findPasswordInput(w: VueWrapper) {
  for (const tid of ['share-password', 'share-password-input', 'share-pw']) {
    const el = w.find(`[data-testid="${tid}"]`)
    if (!el.exists()) continue
    if (el.element.tagName === 'INPUT') return el
    const inner = el.find('input')
    if (inner.exists()) return inner
  }
  return null
}

/**
 * 密码值抓取：testid 输入框 value 优先；无 testid 时退化为全文扫描——取「前后均非字母数字、
 * 恰 6 位 [A-Za-z0-9]」片段。扫描带两重启发式排除（仅用于定位，charset 断言仍独立执行）：
 *   - 歧义字符 0O1lI 排除（契约明文排除集）；
 *   - exclude 串的子串排除（防条目名等常驻文本误命中，如 report.pdf → 'report'）。
 */
function readPassword(w: VueWrapper, exclude: string[] = []): string | null {
  const input = findPasswordInput(w)
  if (input) {
    const v = (input.element as HTMLInputElement).value.trim()
    if (v) return v
  }
  const re = /(?<![A-Za-z0-9])[A-Za-z0-9]{6}(?![A-Za-z0-9])/g
  for (const m of w.text().matchAll(re)) {
    const tok = m[0]!
    if (/[0O1lI]/.test(tok)) continue
    if (exclude.some((e) => e.includes(tok))) continue
    return tok
  }
  return null
}

/** 开关选中态（checkbox 勾选 / el-switch aria-checked / is-checked 类，三者通吃） */
function isChecked(el: DOMWrapper<Element>): boolean {
  const node = el.element as HTMLElement
  const input: HTMLInputElement | null =
    el.element.tagName === 'INPUT' ? (el.element as HTMLInputElement) : node.querySelector('input')
  if (input) {
    if (input.type === 'checkbox') return input.checked
    const aria = input.getAttribute('aria-checked')
    if (aria !== null) return aria === 'true'
  }
  return node.classList.contains('is-checked') || node.classList.contains('checked')
}

/** 区域内容（text + 全部 input 值拼接）：链接/密码可能渲染为只读 input 或纯文本，两者通吃 */
function areaContent(area: DOMWrapper<Element>): string {
  const values = area.findAll('input').map((i) => (i.element as HTMLInputElement).value)
  return `${area.text()} ${values.join(' ')}`
}

/** 管理行定位：testid 候选优先；兜底=li/tr/类名含 row 的元素中「含撤销钮」者（管理行必有撤销） */
function findRows(w: VueWrapper): DOMWrapper<Element>[] {
  for (const tid of ['share-row', 'share-item', 'share-manage-row']) {
    const rs = w.findAll(`[data-testid="${tid}"]`)
    if (rs.length) return rs
  }
  const cands = [...w.findAll('li'), ...w.findAll('tr'), ...w.findAll('[class*="row" i]')]
  return cands.filter((r) => r.findAll('button').some((b) => REVOKE_CANDS.some((c) => b.text().includes(c))))
}

/** 管理区定位：testid 优先；文本兜底用完整短语（防无关「管理」字样误命中） */
function findManageArea(w: VueWrapper) {
  const byTid = findByTid(w, ...MANAGE_TIDS)
  if (byTid) return byTid
  return w.findAll('div, section, fieldset').find((n) => /share\.manage|我的分享|管理分享|分享管理/.test(n.text())) ?? null
}

/** 本地时区 yyyy-mm-dd（native date input 值格式；el-date-editor 默认展示格式相同） */
function ymd(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('ShareDialog 增强面（M5-UI-b：IO 回调注入，TDD 红态先行）', () => {
  it('向后兼容红线：三回调未注入 → 挂载无异常且增强 UI（密码框/重掷/管理区）不出现，有效期仍三档', async () => {
    const w = mountV2() // 不传 createShare/listShares/revokeShare
    await flushPromises()
    // 挂载无异常 + 常规体照常渲染
    expect(body(w).exists()).toBe(true)
    expect(w.text()).toContain('report.pdf')
    // 增强面三锚点全 absence（契约：回调未注入 → 增强面整体不渲染）
    expect(findPasswordInput(w)).toBeNull()
    expect(findBtn(w, ...REROLL_CANDS)).toBeUndefined()
    expect(findManageArea(w)).toBeNull()
    // 既有行为零回归：有效期仍三档（增强面注入后才出现第 4「自定义」档，对照用例 4）
    const labels = w.findAll('.share-dialog__opt').map((l) => l.text())
    expect(labels).toEqual(['share.expiry-h', 'share.expiry-d', 'share.expiry-d'])
    w.unmount()
  })

  it('密码开关：注入 createShare → 密码框默认开启，值=随机 6 位无歧义字符集（不含 0O1lI）', async () => {
    const w = mountV2({ createShare: createShareOk() })
    await flushPromises()
    // 增强面锚点：密码框存在（对照用例 1 的 absence）
    expect(findPasswordInput(w)).not.toBeNull()
    // 默认开的主证据：不点任何开关即有合规密码值
    const pw = readPassword(w, [fileEntry().key, fileEntry().name])
    expect(pw).toEqual(expect.stringMatching(/^[A-Za-z0-9]{6}$/))
    expect(pw).not.toMatch(/[0O1lI]/)
    // 开关控件若存在，则再断其选中态（testid 命名未定，按最常见三候选探测；缺失不阻断——值在场即默认开）
    const toggle = ['share-password-switch', 'share-password-toggle', 'share-enable-password']
      .map((t) => w.find(`[data-testid="${t}"]`))
      .find((el) => el.exists())
    if (toggle) expect(isChecked(toggle)).toBe(true)
    w.unmount()
  })

  it('重掷钮：点击后密码变化且仍合规（57^6≈3.4e10，两次同值概率可忽略）', async () => {
    const w = mountV2({ createShare: createShareOk() })
    await flushPromises()
    const entry = fileEntry()
    const pw1 = readPassword(w, [entry.key, entry.name])
    expect(pw1).toEqual(expect.stringMatching(/^[A-Za-z0-9]{6}$/))
    const reroll = findBtn(w, ...REROLL_CANDS)
    expect(reroll).not.toBeUndefined()
    await reroll!.trigger('click')
    await flushPromises()
    const pw2 = readPassword(w, [entry.key, entry.name])
    expect(pw2).toEqual(expect.stringMatching(/^[A-Za-z0-9]{6}$/))
    expect(pw2).not.toMatch(/[0O1lI]/)
    expect(pw2).not.toBe(pw1)
    w.unmount()
  })

  it('有效期：含自定义档（1h/24h/7d/自定义）；自定义选超 7d 日期 → 生成钮禁用或该日期被拒（断言其一）', async () => {
    const createShare = createShareOk()
    const w = mountV2({ createShare })
    await flushPromises()
    // 自定义档：含「自定义/custom」文案的 label，或 radio 组第 4 档（契约档序 1h/24h/7d/自定��）
    const customLabel = w.findAll('label').find((l) => CUSTOM_CANDS.some((c) => l.text().includes(c)))
    const radios = body(w).findAll('input[type="radio"]')
    expect(customLabel !== undefined || radios.length >= 4).toBe(true)
    const customRadio = customLabel ? customLabel.find('input[type="radio"]') : radios[3]!
    expect(customRadio.exists()).toBe(true)
    await customRadio.setValue()
    await flushPromises()
    // 日期框：native input[type=date] 优先，el-date-editor 内层 input 兜底
    const dateInput = w.find('input[type="date"]').exists() ? w.find('input[type="date"]') : w.find('.el-date-editor input')
    expect(dateInput.exists()).toBe(true)
    // 先填合规日期（6 天后）让实现状态机落位，再换超标日期——把「超标被拒」从「未选日期」态解耦
    await dateInput.setValue(ymd(Date.now() + 6 * 86_400_000))
    await dateInput.trigger('change') // el-date-editor 在 change 上解析
    await flushPromises()
    await dateInput.setValue(ymd(Date.now() + 8 * 86_400_000)) // 8 天后：确定越 7d 上限
    await dateInput.trigger('change')
    await flushPromises()
    // 断言其一：生成钮禁用（超标禁用）｜点击后 createShare 未被调（日期被拒）——
    // 两支覆盖「确认钮」语义（增强面确认钮即生成钮；若实现另有确认钮，禁用支同样命中其联动效果）
    const gen = body(w).find('[data-testid="share-generate"]')
    let blocked = gen.attributes('disabled') !== undefined || (gen.element as HTMLButtonElement).disabled === true
    if (!blocked) {
      await gen.trigger('click')
      await flushPromises()
      blocked = createShare.mock.calls.length === 0
    }
    expect(blocked).toBe(true)
    w.unmount()
  })

  it('生成：填密码+选 24h → createShare 实参五键严格相等；resolve → 结果区链接+密码同框+复制钮在场', async () => {
    const createShare = createShareOk()
    const w = mountV2({ createShare })
    await flushPromises()
    // 填密码（框内值即断言基准）
    const pwInput = findPasswordInput(w)
    expect(pwInput).not.toBeNull()
    await pwInput!.setValue('aB3x9K')
    // 选 24h：契约档序 1h/24h/7d/自定义 → index 1（1d 与 7d 空词典下 label 同键，故按序号取）
    const radios = body(w).findAll('input[type="radio"]')
    await radios[1]!.setValue()
    await body(w).find('[data-testid="share-generate"]').trigger('click')
    // 实参严格：五键精确（多余键/错值即红）
    expect(createShare).toHaveBeenCalledTimes(1)
    expect(createShare.mock.calls[0]![0]).toEqual({
      key: 'root/a/report.pdf',
      name: 'report.pdf',
      size: 1024,
      password: 'aB3x9K',
      ttlMs: 86_400_000,
    })
    await flushPromises()
    // 结果区：链接与密码同框（区域 text 或内部 input 值同时含 url 与框内密码），且框内带复制钮（存在即可，不点）
    const result = findByTid(w, ...RESULT_TIDS) ?? body(w) // testid 未命中时退化为对话框整体，「同框」降级为「同屏齐现」
    const content = areaContent(result)
    expect(content).toContain('https://share.test/s/sid-new')
    expect(content).toContain('aB3x9K')
    expect(result.findAll('button').length).toBeGreaterThan(0)
    w.unmount()
  })

  it('管理区：listShares 桩 2 行 → 列表渲染（key/到期）；点撤销 → revokeShare 收精确 shareId；行消失', async () => {
    const rowA = shareRow()
    const rowB = shareRow({
      shareId: 'sid-b',
      key: 'root/b/old.txt',
      name: 'old.txt',
      createdAt: 1_690_000_000_000,
      expiresAt: 1_690_086_400_000,
    })
    // 二次 listShares 预置缩短列表：实现若走「重拉」支路同样满足末段「行消失」断言（两支合一，见末注释）
    const listShares = vi.fn().mockResolvedValueOnce([rowA, rowB]).mockResolvedValueOnce([rowB])
    const revokeShare = vi.fn().mockResolvedValue(undefined)
    const w = mountV2({
      entry: fileEntry({ key: 'root/cur/file.bin', name: 'file.bin', size: 7 }), // 当前条目与列表行 key 隔离，防文案串场
      listShares,
      revokeShare,
    })
    await flushPromises()
    // 实现若把管理区做成折叠懒加载，先展开再断言（已加载则此支跳过）
    if (listShares.mock.calls.length === 0) {
      const toggle = findBtn(w, 'share-manage-toggle', 'share-manage', '管理')
      if (toggle) {
        await toggle.trigger('click')
        await flushPromises()
      }
    }
    expect(listShares.mock.calls.length).toBeGreaterThan(0)
    const rows = findRows(w)
    expect(rows).toHaveLength(2)
    // 行内容：目标 key + 到期时间（格式化含 4 位年份，或原始毫秒直出——两者其一）
    expect(rows[0]!.text()).toContain('root/a/report.pdf')
    expect(rows[1]!.text()).toContain('root/b/old.txt')
    expect(rows[0]!.text()).toMatch(/\d{4}|1700086400000/)
    expect(rows[1]!.text()).toMatch(/\d{4}|1690086400000/)
    // 撤销第一行：revokeShare 收到精确 shareId（单次、实参精确）
    const revokeBtn = rows[0]!.findAll('button').find((b) => REVOKE_CANDS.some((c) => b.text().includes(c)))
    expect(revokeBtn).not.toBeUndefined()
    await revokeBtn!.trigger('click')
    expect(revokeShare).toHaveBeenCalledTimes(1)
    expect(revokeShare).toHaveBeenCalledWith('sid-a')
    await flushPromises()
    // 行消失（断言其一的合一口径）：「本地移除」与「重拉 listShares」两支实现的共同可观察结果
    // =该行不再渲染——桩已预置二次 listShares 返回缩短列表，重拉支路同样通过本断言
    const rowsAfter = findRows(w)
    expect(rowsAfter.some((r) => r.text().includes('sid-a') || r.text().includes('root/a/report.pdf'))).toBe(false)
    w.unmount()
  })

  it('createShare reject → 错误提示非空（内联错误文本或 error toast，其一即可）', async () => {
    const createShare = vi.fn().mockRejectedValue(new Error('quota exceeded'))
    const w = mountV2({ createShare })
    await flushPromises()
    await body(w).find('[data-testid="share-generate"]').trigger('click')
    await flushPromises()
    expect(createShare).toHaveBeenCalledTimes(1) // 前置：reject 确实走到了桩
    const errEl = findByTid(w, ...ERROR_TIDS)
    const inlineMsg = errEl ? errEl.text().trim() : ''
    const toastMsg = toastSpies.error.mock.calls[0] ? String(toastSpies.error.mock.calls[0]![0]) : ''
    // 断言其一（实现可走内联错误区或 toast.error），但提示内容必须非空
    expect(inlineMsg.length > 0 || toastMsg.length > 0).toBe(true)
    w.unmount()
  })
})
