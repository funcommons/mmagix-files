/**
 * ShareAccess 校验页组件测试（M5-UI-a 波次；TDD 红态先行——组件 src/views/share/ShareAccess.vue 尚未落地）。
 * 契约（documents/v1.2.0执行进度.md §「UI 波次契约」M5-UI-a）：
 *   props: {
 *     shareId: string
 *     fetchMeta: (shareId: string) => Promise<ShareMetaV1 | null>   // null=已撤销/不存在
 *     openSecret: (meta: ShareMetaV1, password: string) => Promise<string>  // 返回下载 URL
 *   }
 *   状态机：loading→(meta null→已取消态 | isShareExpired→到期态 | 密码框)；错密码→错误提示 +
 *   本地错 5 次锁 30s（localStorage 计数器 key 'share:lock:<shareId>'）；成功→文件名/大小+「下载」按钮
 *
 * 断言口径（对齐 trash-panel.test.ts 手法）：
 *   - 回调实参严格：fetchMeta 收到的实参 === props.shareId；openSecret 收到 (meta, password)；
 *   - 文案/testid 宽松：testid 候选优先（share-loading/share-submit/share-download/share-error），
 *     文案片段兜底——组件测试的全局 i18n 词典为空（setup.ts），t 直返 key 本身，故定位同时兼容
 *     testid / key 片段 / 中文文案；
 *   - meta 用真料：sealShareSecret({iterations:1000}) + buildShareMeta 构造（GCM 真实可解，1000 轮
 *     开销可忽略，同 share-crypto.test.ts 夹具手法）；openSecret 一律用桩（真开封路径已由
 *     share-crypto.test.ts 覆盖，此处只测状态机接线）。
 *
 * 环境要点：jsdom 无 crypto.subtle → beforeEach 以 node:crypto webcrypto 顶替全局（同
 * share-crypto.test.ts）；锁定用例用 fake timers（自写微任务冲刷 flush，不依赖宏任务——
 * VTU flushPromises 在 fake timers 下可能悬挂）。
 * 实现落地后本文件应转绿；若实现偏差（如另起 testid/文案），只调定位器候选，不放宽回调实参断言。
 */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ShareAccess from '../ShareAccess.vue'
import { buildShareMeta, sealShareSecret } from '../../../files/share-crypto'
import type { ShareMetaV1 } from '../../../files/share-crypto'

// ───────────────────────── 环境桩：jsdom 无 subtle，顶替全局 crypto；锁计数隔离 ─────────────────────────

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
})

// ───────────────────────── 常量与 meta 真料夹具 ─────────────────────────

const SHARE_ID = 'share-abc'
/** 演示密码（无歧义字符集内；真 seal 即用它，桩开封用例同样提交它） */
const PASSWORD = 'k7Rm2x'
/** openSecret 成功路径返回的下载 URL（=blob 明文语义：对象预签名 GET URL） */
const PRESIGNED_URL =
  'https://s3.test/bucket/docs/report.pdf' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800' +
  `&X-Amz-Signature=${'a'.repeat(64)}`

type Sealed = Awaited<ReturnType<typeof sealShareSecret>>

/** 1000 轮 seal 结果（夹具共享，开销可忽略；GCM 语义与轮次无关） */
let sealedP: Promise<Sealed> | undefined
const sealedOnce = (): Promise<Sealed> =>
  (sealedP ??= sealShareSecret(PRESIGNED_URL, PASSWORD, { iterations: 1000 }))

/** 真料 meta：seal-then-assemble（blob 明文=预签名 URL，与契约 blob 语义一致）；默认有效期 1h */
const mkMeta = async (over: Partial<ShareMetaV1> = {}): Promise<ShareMetaV1> => {
  const meta = buildShareMeta({
    key: 'docs/report.pdf',
    name: 'report.pdf',
    size: 2048,
    sealed: await sealedOnce(),
    ttlMs: 3_600_000,
  })
  return { ...meta, ...over }
}

// ───────────────────────── 挂载与定位器 ─────────────────────────

type FetchMeta = (shareId: string) => Promise<ShareMetaV1 | null>
type OpenSecret = (meta: ShareMetaV1, password: string) => Promise<string>

const mountPage = (
  shareId: string,
  fetchMeta: FetchMeta,
  openSecret: OpenSecret = vi.fn() as unknown as OpenSecret,
) => mount(ShareAccess, { props: { shareId, fetchMeta, openSecret } })

/**
 * 微任务冲刷：nextTick 多轮。fake timers 安全——纯微任务链，不碰宏任务
 * （VTU flushPromises 实现走 setTimeout，在 vi.useFakeTimers() 下会悬挂）。
 */
const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

/**
 * 按钮/链接定位（三段候选，对齐 trash-panel.test.ts 的 findBtn）：
 * testid 精确候选优先 → a/button 文本片段兜底（空词典时 t 直返 key，key 片段可命中；中文文案亦可）。
 */
function findBtn(w: VueWrapper, ...candidates: string[]) {
  for (const c of candidates) {
    const byTid = w.findAll(`[data-testid="${c}"]`)[0]
    if (byTid) return byTid
  }
  return w.findAll('a, button').find((b) => candidates.some((c) => b.text().includes(c)))
}

/** 下载按钮定位：testid → href 含预签名 URL 特征的 <a>（最简实现路径）→ 「下载」文案 */
function findDownload(w: VueWrapper) {
  for (const c of ['share-download', 'download']) {
    const byTid = w.findAll(`[data-testid="${c}"]`)[0]
    if (byTid) return byTid
  }
  const anchor = w
    .findAll('a')
    .find((a) => (a.attributes('href') ?? '').includes('X-Amz-Signature'))
  if (anchor) return anchor
  return w
    .findAll('a, button')
    .find((b) => b.text().includes('下载') || /download/i.test(b.text()))
}

/** 提交钮候选（密码框态；「下载」兜底——密码态无下载钮，不冲突） */
const SUBMIT = ['share-submit', 'submit', '解锁', '打开', '提交', '下载', '确认']

/** 错误提示（宽松）：share-error testid 或 错误类文案（中/key/桩 reject message） */
const hasErrHint = (w: VueWrapper) =>
  w.find('[data-testid="share-error"]').exists() ||
  /错误|不正确|失败|无效|重试|已锁定|invalid|incorrect|wrong|error|retry/i.test(w.text())

/** 加载态（宽松）：share-loading testid / 骨架壳 / 加载类文案 */
const hasLoadingUi = (w: VueWrapper) =>
  w.find('[data-testid="share-loading"]').exists() ||
  w.find('.el-skeleton, .skeleton').exists() ||
  /加载|载入|loading|skeleton|骨架/i.test(w.text())

/** 已取消态（宽松）：任务书原文「已取消/不存在」，键或中文皆放行 */
const hasCancelledUi = (w: VueWrapper) =>
  w.find('[data-testid="share-cancelled"]').exists() ||
  /已取消|取消|撤销|不存在|失效|已删除|找不到|not.?found|revoked|cancel|invalid|exist/i.test(w.text())

/** 到期态（宽松）：契约原文「到期态」，过期/到期/失效皆放行 */
const hasExpiredUi = (w: VueWrapper) =>
  w.find('[data-testid="share-expired"]').exists() ||
  /过期|到期|失效|expire/i.test(w.text())

// ───────────────────────── 用例 ─────────────────────────

describe('ShareAccess（M5-UI-a 契约：IO 回调注入，状态机）', () => {
  it('shareId 透传：fetchMeta 收到的实参严格 === props.shareId（单参、仅调用一次）', async () => {
    const meta = await mkMeta()
    const fetchMeta = vi.fn<FetchMeta>().mockResolvedValue(meta)
    const w = mountPage(SHARE_ID, fetchMeta)
    await flush()
    expect(fetchMeta).toHaveBeenCalledTimes(1)
    // 单参严格：既断言值 === shareId，也断言没有多余实参
    expect(fetchMeta.mock.calls[0]).toHaveLength(1)
    expect(fetchMeta.mock.calls[0]![0]).toBe(SHARE_ID)
    w.unmount()
  })

  it('loading 态：fetchMeta 未决 → 骨架/加载文案存在', async () => {
    const w = mountPage(SHARE_ID, vi.fn().mockReturnValue(new Promise(() => {})))
    await flush()
    expect(hasLoadingUi(w)).toBe(true)
    w.unmount()
  })

  it('已取消态：fetchMeta → null → 「已取消/不存在」文案；密码框不出现', async () => {
    const w = mountPage(SHARE_ID, vi.fn().mockResolvedValue(null))
    await flush()
    expect(hasCancelledUi(w)).toBe(true)
    expect(w.find('input[type="password"]').exists()).toBe(false)
    w.unmount()
  })

  it('到期态：meta.expiresAt < now → 到期文案；密码框不出现', async () => {
    const meta = await mkMeta({ expiresAt: Date.now() - 1000 })
    const w = mountPage(SHARE_ID, vi.fn().mockResolvedValue(meta))
    await flush()
    expect(hasExpiredUi(w)).toBe(true)
    expect(w.find('input[type="password"]').exists()).toBe(false)
    w.unmount()
  })

  it('正常：有效 meta → 密码输入框 + 提交钮；未提交前 openSecret 不触达', async () => {
    const meta = await mkMeta()
    const openSecret = vi.fn<OpenSecret>().mockResolvedValue(PRESIGNED_URL)
    const w = mountPage(SHARE_ID, vi.fn().mockResolvedValue(meta), openSecret)
    await flush()
    expect(w.find('input[type="password"]').exists()).toBe(true)
    expect(findBtn(w, ...SUBMIT)).toBeTruthy()
    expect(openSecret).not.toHaveBeenCalled()
    w.unmount()
  })

  it('错密码：openSecret reject → 错误提示；实参严格 (meta, password)；未达 5 次不禁用', async () => {
    const meta = await mkMeta()
    const openSecret = vi.fn<OpenSecret>().mockRejectedValue(new Error('密码不正确'))
    const w = mountPage(SHARE_ID, vi.fn().mockResolvedValue(meta), openSecret)
    await flush()
    await w.find('input[type="password"]').setValue('wr0ng-pw')
    await findBtn(w, ...SUBMIT)!.trigger('click')
    await flush()
    // 回调实参严格：meta 深等 + 用户输入的密码原样
    expect(openSecret).toHaveBeenCalledTimes(1)
    expect(openSecret).toHaveBeenCalledWith(meta, 'wr0ng-pw')
    // 错误提示出现（桩 reject 的 message / 错误文案 / share-error testid 皆算）
    expect(hasErrHint(w)).toBe(true)
    // 仅错 1 次（<5）：不得提前锁定
    expect(findBtn(w, ...SUBMIT)!.attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('防暴破锁定：连错 5 次 → localStorage 计数器 share:lock:<shareId> 出现；第 6 次前禁用/提示锁定；30s 后解锁恢复', async () => {
    vi.useFakeTimers()
    const meta = await mkMeta()
    const openSecret = vi.fn<OpenSecret>().mockRejectedValue(new Error('密码不正确'))
    const w = mountPage('share-lock', vi.fn().mockResolvedValue(meta), openSecret)
    await flush()
    // 连错 5 次（每轮重输：实现可能在失败后清空输入框）
    for (let i = 0; i < 5; i++) {
      await w.find('input[type="password"]').setValue('wr0ng-pw')
      await findBtn(w, ...SUBMIT)!.trigger('click')
      await flush()
    }
    expect(openSecret).toHaveBeenCalledTimes(5)
    // 本地锁计数器落盘（值格式不钉——字符串计数或 JSON {count,until} 皆可，键存在即算）
    expect(localStorage.getItem('share:lock:share-lock')).toBeTruthy()
    // 第 6 次前：按钮禁用 或 锁定提示（含 30s 倒计时），二者居其一
    const btn = findBtn(w, ...SUBMIT)!
    const lockedUi =
      btn.attributes('disabled') !== undefined ||
      /锁定|稍后|重试|locked|30/.test(w.text())
    expect(lockedUi).toBe(true)
    // 锁定期内第 6 次点击不触达回调
    await btn.trigger('click')
    await flush()
    expect(openSecret).toHaveBeenCalledTimes(5)
    // fake timers 驱动 30s（+1s 余量；Date 亦被 fake，惰性 Date.now 判定的实现同样解锁）
    vi.advanceTimersByTime(31_000)
    await flush()
    // 解锁恢复：再点触达回调（第 6 次）。恢复口径=回调可再触达——不钉「禁用属性是否摘除」，
    // 因实现可能以 Date.now() 惰性判定锁定（禁用属性不随 timer 自行摘除，但点击放行）
    await findBtn(w, ...SUBMIT)!.trigger('click')
    await flush()
    expect(openSecret).toHaveBeenCalledTimes(6)
    w.unmount()
  })

  it('成功：正确密码 → openSecret resolve(URL) → 文件名/大小渲染 + 「下载」指向该 URL（href 或 onclick 其一）', async () => {
    const meta = await mkMeta()
    const openSecret = vi.fn<OpenSecret>().mockResolvedValue(PRESIGNED_URL)
    const w = mountPage(SHARE_ID, vi.fn().mockResolvedValue(meta), openSecret)
    await flush()
    await w.find('input[type="password"]').setValue(PASSWORD)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    await findBtn(w, ...SUBMIT)!.trigger('click')
    await flush()
    // 回调实参严格：meta 深等 + 正确密码
    expect(openSecret).toHaveBeenCalledTimes(1)
    expect(openSecret).toHaveBeenCalledWith(meta, PASSWORD)
    // 文件名 + 大小（格式化器风格不钉：'2 KB'/'2.0 KB'/'2 KiB' 或裸字节数 2048 皆放行）
    expect(w.text()).toContain('report.pdf')
    expect(w.text()).toMatch(/2(?:\.\d+)?\s*(KB|KiB)|2048/)
    // 下载钉位（断言其一，契约原文「href/onclick 指向该 URL」）：<a href> 直指，或点击触发 window.open(URL)
    const dl = findDownload(w)
    expect(dl).toBeTruthy()
    const href = dl!.attributes('href')
    if (href) {
      expect(href).toBe(PRESIGNED_URL)
    } else {
      await dl!.trigger('click')
      expect(openSpy.mock.calls.some((c) => c[0] === PRESIGNED_URL)).toBe(true)
    }
    openSpy.mockRestore()
    w.unmount()
  })
})
