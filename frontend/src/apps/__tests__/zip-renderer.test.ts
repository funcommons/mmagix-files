/**
 * zip 渲染器 RangeReader 三档供给测试（M3 §W5）
 * 契约锚：《docs/design/webdav-support-design.md》§W5（M3）：makeReaderProvider 三档——
 *   直链优先（既有第一档，不变）→ ctx.getObjectRange 存在则 objectRangeReader（装配层
 *   client.get+RangeHeader 流式读；200 整读本地切片并实例内缓存、206 精确返回——对齐
 *   fetchRangeReader 同款缓存语义）→ Blob 兜底（既有金标准，不变）。
 * mem:// 键不提供 getObjectRange（装配层契约 + 渲染器 isMemKey 一等防线）→ 恒 Blob 兜底。
 * 手法：objectRangeReader/makeReaderProvider 为模块私有——经唯一公开缝 zipBrowserRenderer
 *   挂载驱动：ZipBrowser mount 即调 load → newReader().then(parseCentralDirectory)；读行为以
 *   ctx.getObjectRange 桩 / global fetch 桩记录断言，渲染成功判据=zip-item 行出条目名。
 * fixture：fflate zipSync 造真包，且 pad.bin（level 0 不压缩）使包体 >EOCD 尾窗上限（65557B）
 *   ——首个读窗口 ≠ 整包，从而把「206 逐窗精确（无脑缓存首窗必错）」与「200 整读缓存」两种
 *   实现形态干净分开（fixture 手法对齐 files/__tests__/zip-reader.test.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { zipBrowserRenderer } from '../renderers/zip'
import type { AppCtx } from '../../sdk/types'

const TE = new TextEncoder()
/** pad.bin 使包体 ≈70KB > EOCD 尾窗上限 65557B：首窗=[size-65557, size) ≠ [0, size) */
const ZIP = zipSync(
  {
    'pad.bin': new Uint8Array(70_000).fill(0xaa),
    'a.txt': TE.encode('hello zip'),
    'b/c.txt': TE.encode('nested'),
  },
  { level: 0 },
)
const ZIP_SIZE = ZIP.length

/** 包尾向前扫 EOCD 签名（PK\x05\x06）绝对偏移（fixture 无注释无拖尾，最后一处即真 EOCD） */
function eocdOffsetOf(bytes: Uint8Array): number {
  for (let i = bytes.length - 4; i >= 0; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i
  }
  throw new Error('fixture 无 EOCD')
}

/** 小端写 u64（伪 locator 的 z64At 字段；真值在安全整数范围） */
function le64Bytes(v: number): number[] {
  const lo = v % 2 ** 32
  const hi = Math.floor(v / 2 ** 32)
  return [0, 8, 16, 24].map((s) => (lo >>> s) & 0xff).concat([0, 8, 16, 24].map((s) => (hi >>> s) & 0xff))
}

/**
 * zip64 伪 locator 包（M3-V1 P1 夹短场景）：正常包剥 EOCD，接「伪 locator（z64At 指向包尾前
 * 30B）+ zip64 占位 EOCD」——zip-reader 的 z64 记录读 (z64At, z64At+56) 必越出包尾 26B（伪
 * z64At 攻击面，zip-reader 无前置界校验、靠读回长度先验兜错），服务端 206 夹短语义下恰好读回
 * <56B 短切片，命中「zip64 locator 指向处非 zip64 EOCD（包损坏）」拒绝路径。
 */
function buildZ64PoisonZip(): Uint8Array {
  const base = zipSync({ 'pad.bin': new Uint8Array(70_000).fill(0xaa), 'a.txt': TE.encode('hello') }, { level: 0 })
  const body = base.slice(0, eocdOffsetOf(base)) // 剥原 EOCD（fflate 无注释，恒 22B）
  const size = body.length + 20 + 22
  const z64At = size - 30 // 记录读越界：z64At + 56 = size + 26
  const locator = Uint8Array.from([
    0x50, 0x4b, 0x06, 0x07, // PK\x06\x07
    0, 0, 0, 0, // 定位记录所在盘
    ...le64Bytes(z64At), // 伪 zip64 EOCD 偏移（指向包尾前 30B）
    1, 0, 0, 0, // 总盘数
  ])
  const eocd = Uint8Array.from([
    0x50, 0x4b, 0x05, 0x06, // PK\x05\x06
    0xff, 0xff, 0xff, 0xff, // 当前盘/中心目录起始盘占位（zip64 通道）
    0xff, 0xff, 0xff, 0xff, // 条目数占位
    0xff, 0xff, 0xff, 0xff, // 中心目录大小占位
    0xff, 0xff, 0xff, 0xff, // 中心目录偏移占位
    0, 0, // 注释长
  ])
  const out = new Uint8Array(size)
  out.set(body, 0)
  out.set(locator, body.length)
  out.set(eocd, body.length + 20)
  return out
}

/** 头名大小写不敏感取值（fetch 桩用；兼容实现用 Record 或 Headers 两种形态） */
function headerOf(init: RequestInit | undefined, name: string): string {
  const h = init?.headers
  if (!h) return ''
  if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name) ?? ''
  const lower = name.toLowerCase()
  for (const k of Object.keys(h as Record<string, string>)) {
    if (k.toLowerCase() === lower) return (h as Record<string, string>)[k] ?? ''
  }
  return ''
}

/** ctx 构造：getObject 缺省=整包 Blob（Blob 兜底路径）；可选能力按用例叠加 */
function makeCtx(over: Partial<AppCtx> = {}): AppCtx {
  return {
    getObject: vi.fn(async () => new Blob([ZIP as BlobPart])),
    putObject: async () => {},
    t: (key) => key,
    theme: {},
    notify: () => {},
    ...over,
  }
}

/** 挂载渲染器（唯一公开缝）：mount 即 load → reader 读流全跑；返回挂载根 el 供行断言 */
async function mountZip(ctx: AppCtx, key = 'doc.zip', size = ZIP_SIZE) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const instance = await zipBrowserRenderer(el, { key, name: 'doc.zip', size }, ctx, undefined, undefined)
  return { el, instance }
}

const rowTexts = (el: HTMLElement): string =>
  [...el.querySelectorAll('[data-testid="zip-item"]')]
    .map((n) => n.textContent ?? '')
    .join('\n')

async function waitRows(el: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(rowTexts(el)).toContain('a.txt'))
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('makeReaderProvider 三档（§W5 M3：直链 → objectRange → Blob）', () => {
  it('objectRangeReader：206 精确区间——逐窗恰好 [start,end)（不整读、无脑缓存首窗必错位）', async () => {
    const calls: Array<{ key: string; start: number; end: number }> = []
    const ctx = makeCtx({
      getObjectRange: async (key, start, end) => {
        calls.push({ key, start, end })
        return ZIP.slice(start, end) // 206 语义：响应体=请求窗精确切片
      },
    })
    const { el, instance } = await mountZip(ctx)
    await waitRows(el) // 三个读窗口的字节精确喂进 parseCentralDirectory（渲染成功=切片正确金标准）
    expect(rowTexts(el)).toContain('b/c.txt')
    expect(calls.every((c) => c.key === 'doc.zip')).toBe(true)
    // 读取窗口集合 = zip-reader 既有序三窗（EOCD 尾窗 / zip64 locator 探针 / CD 本体），无第四窗；
    // 包体 >65557B → 首窗非整包：若实现「无脑缓存首窗当整包」，后续窗必错位、此处即红
    const eocdAbs = eocdOffsetOf(ZIP)
    const dv = new DataView(ZIP.buffer, ZIP.byteOffset, ZIP.byteLength)
    const cdSize = dv.getUint32(eocdAbs + 12, true)
    const cdOffset = dv.getUint32(eocdAbs + 16, true)
    const winStart = Math.max(0, ZIP_SIZE - 65_557)
    expect(calls.map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0])).toEqual(
      [
        [winStart, ZIP_SIZE], // EOCD 尾窗
        [eocdAbs - 20, eocdAbs], // zip64 locator 探针（非 zip64 包也探测）
        [cdOffset, cdOffset + cdSize], // 中心目录本体
      ].sort((a, b) => a[0] - b[0]),
    )
    expect(ctx.getObject).not.toHaveBeenCalled() // 未走 Blob 兜底
    instance?.dispose()
  })

  it('objectRangeReader：200 整读 → 实例内缓存，后续读本地切片不再发请求（fetchRangeReader 同款）', async () => {
    let calls = 0
    const ctx = makeCtx({
      getObjectRange: async () => {
        calls += 1
        return ZIP // 200 语义：源不支持 Range，每次都回整包
      },
    })
    const { el, instance } = await mountZip(ctx)
    await waitRows(el)
    expect(calls).toBe(1) // ≥3 次 read 只发 1 次请求（整包缓存于 reader 实例）
    expect(rowTexts(el)).toContain('b/c.txt') // 后续 read 本地切片仍喂对（不缓存错位）
    expect(ctx.getObject).not.toHaveBeenCalled()
    instance?.dispose()
  })

  it('M3-V1 P1：z64 探针越界读被夹到包尾——夹短切片不入 cached（缓存分支不可达）且结构校验报错非错位静默', async () => {
    const POISON = buildZ64PoisonZip()
    const SIZE = POISON.length
    const calls: Array<{ start: number; end: number }> = []
    const ctx = makeCtx({
      getObjectRange: async (_key, start, end) => {
        calls.push({ start, end })
        // 服务端 206 真实语义：请求窗越出包尾 → 夹到 size（[start, size) 短切片）
        return POISON.slice(start, Math.min(end, SIZE))
      },
    })
    const { el, instance } = await mountZip(ctx, 'poison.zip', SIZE)
    // ② 上层结构校验兜错（zip 包损坏类路径）：error 相位渲染、无任何条目行——「错位静默」不成立
    await vi.waitFor(() => expect(el.querySelector('.zip-browser__state--error')).not.toBeNull())
    expect(rowTexts(el)).toBe('')

    // ① 夹取在 reader 侧先于通道完成：请求窗全部落在包尾内（sizeHint）——「夹短 206」不可达，
    // 长度≠区间的缓存分支不可能被短切片喂中（短切片不落 cached，后续读不基于错误基址）；
    // 读取序=EOCD 尾窗 → 伪 locator 探针 → 夹短的 z64 记录读（第三窗若未夹取应为
    // z64At+56=SIZE+26，夹后恰为 (z64At, SIZE)）
    const z64At = SIZE - 30
    expect(calls).toEqual([
      { start: Math.max(0, SIZE - 65_557), end: SIZE }, // EOCD 尾窗
      { start: SIZE - 42, end: SIZE - 22 }, // 伪 locator 探针（EOCD 紧前 20B）
      { start: z64At, end: SIZE }, // z64 记录读越界 → reader 夹到包尾（M3-V1 修复面）
    ])
    expect(calls.every((c) => c.end <= SIZE && c.start >= 0)).toBe(true)
    instance?.dispose()
  })

  it('直链优先（既有第一档不变）：getMediaUrl 存在 → fetch Range 直链，objectRange/Blob 均不被咨询', async () => {
    const getObjectRange = vi.fn(async (): Promise<Uint8Array> => ZIP)
    const ctx = makeCtx({ getMediaUrl: () => 'https://s3.test/doc.zip', getObjectRange })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(headerOf(init, 'range'))
      const start = Number(m?.[1] ?? 0)
      const end = Number(m?.[2] ?? ZIP_SIZE - 1) + 1
      // body 直接给 Uint8Array——jsdom 全局 Blob 进 undici Response 会被字符串化（见 datasource.test.ts 注）
      return new Response(ZIP.slice(start, end) as BodyInit, { status: 206 })
    })
    const { el, instance } = await mountZip(ctx)
    await waitRows(el)
    expect(fetchSpy.mock.calls.every((c) => String(c[0]).startsWith('https://s3.test/doc.zip'))).toBe(true)
    expect(getObjectRange).not.toHaveBeenCalled() // 直链优先于 objectRange 档
    expect(ctx.getObject).not.toHaveBeenCalled()
    instance?.dispose()
  })

  it('mem:// 键不走 objectRange 档（mem 键域不提供语义+isMemKey 防线）→ Blob 兜底（getObject 整包）', async () => {
    const getObjectRange = vi.fn(async (): Promise<Uint8Array> => ZIP)
    const ctx = makeCtx({ getObjectRange })
    const { el, instance } = await mountZip(ctx, 'mem://1/doc.zip')
    await waitRows(el)
    expect(getObjectRange).not.toHaveBeenCalled() // mem:// 键恒 Blob 兜底（Range 无增益）
    expect(ctx.getObject).toHaveBeenCalledWith('mem://1/doc.zip')
    instance?.dispose()
  })

  it('getObjectRange 缺席（可选能力缺位）→ Blob 兜底不变（既有金标准）', async () => {
    const ctx = makeCtx() // 无 getMediaUrl / getObjectRange
    const { el, instance } = await mountZip(ctx)
    await waitRows(el)
    expect(ctx.getObject).toHaveBeenCalledWith('doc.zip')
    instance?.dispose()
  })
})
