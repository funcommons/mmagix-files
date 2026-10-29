/**
 * zip-reader 单测（M4 W1，红测先行：frontend/src/files/zip-reader.ts 尚未实现，首跑应整红）。
 * 契约：documents/v1.2.0执行进度.md §「M4 契约」；方案：documents/v1.2.0升级方案-断点上传-分享增强-在线解压-回收站.md §4。
 * fixture：常规包用 fflate zipSync 造；GBK 名 / 加密位 / zip64 / EOCD 干扰 / DOS 时间 用本文件内的
 * 手工二进制构造器（字段逐行注释对齐 APPNOTE.TXT：LFH 30B / CD 46B / EOCD 22B / zip64 EOCD 56B / locator 20B）。
 * 注：Node 无 gbk TextEncoder，GBK 字节以硬编码 hex 给出（报=0xB1A8 表=0xB1ED，已用 TextDecoder('gbk') 验证）。
 * 注：DOS 时间无时区语义，契约口径为「DOS→epoch ms」纯函数，本测试按 UTC 定标（Date.UTC）断言具体值。
 */
import { describe, expect, it, vi } from 'vitest'
import { deflateSync, zipSync } from 'fflate'
import {
  ZIP_BOMB_RATIO_LIMIT,
  checkBomb,
  extractEntry,
  parseCentralDirectory,
  sanitizeEntryName,
} from '../zip-reader'
import type { RangeReader, ZipEntryMeta } from '../zip-reader'

// ---------- 基础工具 ----------

const TE = new TextEncoder()

/** 小端写 u16 */
const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff]
/** 小端写 u32 */
const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
/** 小端写 u64（低 32 位在前；本文件真值均在安全整数范围内） */
const le64 = (v: number): number[] => [...le32(v >>> 0), ...le32(Math.floor(v / 2 ** 32))]

const EMPTY = new Uint8Array(0)

/**
 * 跨 realm 安全的字节比较：vitest jsdom 下 globalThis.Uint8Array 与 TextEncoder 内部用的构造器
 * 不是同一个 realm（vitest#4043），toEqual 首关比 constructor 必败；改用 Buffer.equals
 * （仓库先例 src/files/__tests__/zip.test.ts:45 同款手法）。
 */
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b))

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** 标准 CRC-32（IEEE，多项式 0xEDB88320），与 zip/fflate 一致（向量 "123456789" → 0xCBF43926） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()
const crc32 = (d: Uint8Array): number => {
  let c = 0xffffffff
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** RangeReader 桩：内存 Uint8Array 切片，[start, end)；按任务口径桩只做切片，不额外做越界校验 */
const readerOf = (bytes: Uint8Array): RangeReader => ({
  size: async () => bytes.length,
  read: async (start, end) => bytes.slice(start, end),
})

/** 记录读取区间的 RangeReader 包装（钉住「EOCD 定位走尾部窗口」行为） */
const recordingReader = (bytes: Uint8Array): { r: RangeReader; ranges: { start: number; end: number }[] } => {
  const ranges: { start: number; end: number }[] = []
  return {
    r: {
      size: async () => bytes.length,
      read: async (start, end) => {
        ranges.push({ start, end })
        return bytes.slice(start, end)
      },
    },
    ranges,
  }
}

/** checkBomb 用的 ZipEntryMeta 桩（不需要真字节） */
const stubMeta = (over: Partial<ZipEntryMeta> = {}): ZipEntryMeta => ({
  name: 'f.txt',
  size: 1,
  compressedSize: 1,
  method: 0,
  crc32: 0,
  lastModified: 0,
  encrypted: false,
  offset: 0,
  isDirectory: false,
  ...over,
})

// ---------- 手工 zip 二进制构造器（对齐 APPNOTE.TXT） ----------

interface RawSpec {
  /** 条目名字节（编码由调用方决定：GBK 用例给 GBK 字节，bit11=1 用例给 UTF-8 字节） */
  name: Uint8Array
  data: Uint8Array
  /** general purpose bit flag：bit0 加密 / bit11 UTF-8（默认 0） */
  flags?: number
  /** 压缩方法（构造器只造 store；可故意给 12=bzip2 等未支持值测 throw）（默认 0） */
  method?: number
  /** CRC-32（默认按 data 实算） */
  crc?: number
  /** DOS 时间 / 日期（默认 0） */
  dosTime?: number
  dosDate?: number
  /** true → CD 的 csize/usize/offset 写 0xFFFFFFFF 并自动生成 0x0001 zip64 extra 真值；EOCD 侧 count=0xFFFF + zip64 EOCD + locator */
  zip64?: boolean
  /** LFH 侧 extra（默认无；可与 CD 侧故意不同，钉住「extraLen 以 local 为准」） */
  lfhExtra?: Uint8Array
  /** CD 侧 extra（默认无；zip64=true 时自动生成，本字段忽略） */
  cdExtra?: Uint8Array
}

/** zip64 extra field（id 0x0001）：APPNOTE 顺序 = 原始大小(8) → 压缩后大小(8) → LFH 偏移(8) */
const zip64Extra = (usize: number, csize: number, lfhOffset: number): Uint8Array =>
  Uint8Array.from([
    ...le16(0x0001), // +0 extra field id：zip64
    ...le16(24), // +2 本 extra 数据字节数（3 × 8）
    ...le64(usize), // +4 原始大小真值
    ...le64(csize), // +12 压缩后大小真值
    ...le64(lfhOffset), // +20 本地头偏移真值
  ])

function buildRawZip(specs: RawSpec[], opts: { comment?: string } = {}): Uint8Array {
  const F32 = 0xffffffff
  const locals: Uint8Array[] = []
  const lfhOffsets: number[] = []
  let off = 0
  for (const s of specs) {
    const lfhExtra = s.lfhExtra ?? EMPTY
    locals.push(
      Uint8Array.from([
        ...le32(0x04034b50), // +0 本地头签名 PK\x03\x04
        ...le16(20), // +4 解压所需版本 2.0
        ...le16(s.flags ?? 0), // +6 general purpose bit flag
        ...le16(s.method ?? 0), // +8 压缩方法（0 store）
        ...le16(s.dosTime ?? 0), // +10 DOS 修改时间
        ...le16(s.dosDate ?? 0), // +12 DOS 修改日期
        ...le32(s.crc ?? crc32(s.data)), // +14 CRC-32
        ...le32(s.data.length), // +18 压缩后大小（store=原大小）
        ...le32(s.data.length), // +22 原始大小
        ...le16(s.name.length), // +26 文件名长度
        ...le16(lfhExtra.length), // +28 LFH extra 长度（与 CD 侧独立）
        ...s.name, // +30 文件名
        ...lfhExtra, // 文件名后 LFH extra
        ...s.data, // 压缩数据（store）
      ]),
    )
    lfhOffsets.push(off)
    off += locals[locals.length - 1].length
  }

  const cdOffset = off
  const cdParts = specs.map((s, i) => {
    const cdExtra = s.zip64 ? zip64Extra(s.data.length, s.data.length, lfhOffsets[i]) : (s.cdExtra ?? EMPTY)
    return Uint8Array.from([
      ...le32(0x02014b50), // +0 中心目录签名 PK\x01\x02
      ...le16(20), // +4 创建端版本
      ...le16(20), // +6 解压所需版本
      ...le16(s.flags ?? 0), // +8 general purpose bit flag（bit0 加密 / bit11 UTF-8）
      ...le16(s.method ?? 0), // +10 压缩方法
      ...le16(s.dosTime ?? 0), // +12 DOS 修改时间
      ...le16(s.dosDate ?? 0), // +14 DOS 修改日期
      ...le32(s.crc ?? crc32(s.data)), // +16 CRC-32
      ...le32(s.zip64 ? F32 : s.data.length), // +20 压缩后大小（zip64 占位 0xFFFFFFFF）
      ...le32(s.zip64 ? F32 : s.data.length), // +24 原始大小（zip64 占位 0xFFFFFFFF）
      ...le16(s.name.length), // +28 文件名长度
      ...le16(cdExtra.length), // +30 CD extra 长度
      ...le16(0), // +32 条目注释长度
      ...le16(0), // +34 起始盘号
      ...le16(0), // +36 内部属性
      ...le32(0), // +38 外部属性
      ...le32(s.zip64 ? F32 : lfhOffsets[i]), // +42 本地头偏移（zip64 占位 0xFFFFFFFF）
      ...s.name, // +46 文件名
      ...cdExtra, // 文件名后 CD extra
    ])
  })
  const cdSize = cdParts.reduce((a, c) => a + c.length, 0)
  const comment = opts.comment ? TE.encode(opts.comment) : EMPTY

  const tail: Uint8Array[] = []
  if (specs.some((s) => s.zip64)) {
    const z64EocdOffset = cdOffset + cdSize
    tail.push(
      Uint8Array.from([
        ...le32(0x06064b50), // +0 zip64 EOCD 签名 PK\x06\x06
        ...le64(44), // +4 本记录字节数（56 - 12）
        ...le16(45), // +12 创建版本 4.5
        ...le16(45), // +14 解压所需版本 4.5
        ...le32(0), // +16 当前盘号
        ...le32(0), // +20 中心目录起始盘
        ...le64(specs.length), // +24 本盘条目数（真值）
        ...le64(specs.length), // +32 总条目数（真值，EOCD count=0xFFFF 时走此通道）
        ...le64(cdSize), // +40 中心目录大小（真值）
        ...le64(cdOffset), // +48 中心目录偏移（真值）
      ]),
      Uint8Array.from([
        ...le32(0x07064b50), // +0 zip64 locator 签名 PK\x06\x07
        ...le32(0), // +4 zip64 EOCD 所在盘
        ...le64(z64EocdOffset), // +8 zip64 EOCD 绝对偏移
        ...le32(1), // +16 总盘数
      ]),
    )
  }
  const zip64 = tail.length > 0
  tail.push(
    Uint8Array.from([
      ...le32(0x06054b50), // +0 EOCD 签名 PK\x05\x06
      ...le16(zip64 ? 0xffff : 0), // +4 当前盘号
      ...le16(zip64 ? 0xffff : 0), // +6 中心目录起始盘
      ...le16(zip64 ? 0xffff : specs.length), // +8 本盘条目数（zip64 占位 0xFFFF → count 路径）
      ...le16(zip64 ? 0xffff : specs.length), // +10 中心目录总条目数
      ...le32(zip64 ? F32 : cdSize), // +12 中心目录大小（zip64 占位）
      ...le32(zip64 ? F32 : cdOffset), // +16 中心目录偏移（zip64 占位）
      ...le16(comment.length), // +20 注释长度
      ...comment, // +22 注释
    ]),
  )
  return concat(...locals, ...cdParts, ...tail)
}

// ---------- fixture ----------

const REGULAR_FILES: Record<string, Uint8Array> = {
  'readme.txt': TE.encode('hello zip-reader\n'),
  'bin/blob.bin': Uint8Array.from(Array.from({ length: 256 }, (_, i) => i)),
  'a/b/c.txt': TE.encode('nested'),
  'empty-dir/': EMPTY, // 目录条目：名字以 / 结尾 + 0 字节
}

/** GBK 字节名「报表.txt」：报=0xB1A8 表=0xB1ED + '.txt'（Node 无 gbk TextEncoder，只能硬编码 hex） */
const GBK_NAME = Uint8Array.of(0xb1, 0xa8, 0xb1, 0xed, 0x2e, 0x74, 0x78, 0x74)
const UTF8_NAME = TE.encode('报表.txt')

// ---------- 用例 ----------

describe('zip-reader（M4 在线解压解析器）', () => {
  describe('parseCentralDirectory · 常规包（fflate zipSync 造）', () => {
    it('条目数 4；名称/size/method/crc32/isDirectory/encrypted 正确', async () => {
      const zip = zipSync(REGULAR_FILES)
      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.zip64).toBe(false)
      expect(central.comment).toBe('')
      expect(central.entries.length).toBe(Object.keys(REGULAR_FILES).length)
      const byName = new Map(central.entries.map((e) => [e.name, e]))
      expect([...byName.keys()].sort()).toEqual(Object.keys(REGULAR_FILES).sort())

      const readme = byName.get('readme.txt')
      expect(readme).toBeDefined()
      expect(readme!.size).toBe(REGULAR_FILES['readme.txt'].length)
      expect(readme!.method).toBe(8) // fflate 默认 level 6 → deflate
      expect(readme!.encrypted).toBe(false)
      expect(readme!.isDirectory).toBe(false)
      expect(readme!.crc32).toBe(crc32(REGULAR_FILES['readme.txt']))

      const blob = byName.get('bin/blob.bin')
      expect(blob).toBeDefined()
      expect(blob!.size).toBe(256)
      expect(blob!.crc32).toBe(crc32(REGULAR_FILES['bin/blob.bin']))

      const nested = byName.get('a/b/c.txt')
      expect(nested).toBeDefined()
      expect(nested!.size).toBe(6) // 'nested'
      expect(nested!.isDirectory).toBe(false)

      const dir = byName.get('empty-dir/')
      expect(dir).toBeDefined()
      expect(dir!.isDirectory).toBe(true) // 目录条目以 / 结尾
      expect(dir!.size).toBe(0)
      expect(dir!.encrypted).toBe(false)
    })

    it('extractEntry：3 个文件逐字节与原字节一致（CRC 通过）', async () => {
      const zip = zipSync(REGULAR_FILES)
      const central = await parseCentralDirectory(readerOf(zip))
      const byName = new Map(central.entries.map((e) => [e.name, e]))
      for (const [name, data] of Object.entries(REGULAR_FILES)) {
        if (name.endsWith('/')) continue // 目录条目无数据，不在本用例范围
        const out = await extractEntry(readerOf(zip), byName.get(name)!)
        expect(bytesEqual(out, data)).toBe(true)
      }
    })

    it('EOCD 定位走尾部窗口：首个读取区间以文件尾为端点且 ≤65557 字节', async () => {
      const zip = zipSync(REGULAR_FILES)
      const { r, ranges } = recordingReader(zip)
      await parseCentralDirectory(r)
      expect(ranges.length).toBeGreaterThan(0)
      expect(ranges[0].end).toBe(zip.length)
      expect(ranges[0].end - ranges[0].start).toBeLessThanOrEqual(65557) // min(65557, size)
    })
  })

  describe('store 条目（method 0）', () => {
    it('fflate level=0 → meta.method=0 且 extract 原样返回', async () => {
      const data = TE.encode('a'.repeat(2048))
      const zip = zipSync({ 't.txt': data }, { level: 0 })
      const central = await parseCentralDirectory(readerOf(zip))
      const e = central.entries[0]
      expect(e.method).toBe(0)
      expect(e.size).toBe(2048)
      expect(e.compressedSize).toBe(2048)
      const out = await extractEntry(readerOf(zip), e)
      expect(bytesEqual(out, data)).toBe(true) // store：不 inflate，原样返回
    })
  })

  describe('文件名编码（bit11 / GBK 回退）', () => {
    it('flag bit11=0：UTF-8 严格解码失败 → 回退 GBK 解出中文', async () => {
      // fixture 自证：GBK 字节按严格 UTF-8 解不开、按 GBK 解出「报表.txt」
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(GBK_NAME)).toThrow()
      expect(new TextDecoder('gbk').decode(GBK_NAME)).toBe('报表.txt')

      const zip = buildRawZip([{ name: GBK_NAME, data: TE.encode('中文内容'), flags: 0 }]) // bit11=0
      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.entries.length).toBe(1)
      expect(central.entries[0].name).toBe('报表.txt')
      expect(central.entries[0].size).toBe(TE.encode('中文内容').length)
    })

    it('flag bit11=1：名字为 UTF-8 字节 → 走 flag 通道直接 UTF-8 解码（对照用例）', async () => {
      const zip = buildRawZip([{ name: UTF8_NAME, data: TE.encode('中文内容'), flags: 0x0800 }]) // bit11=1
      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.entries.length).toBe(1)
      expect(central.entries[0].name).toBe('报表.txt')
    })
  })

  describe('加密位（flag bit0）', () => {
    it('bit0=1 → meta.encrypted=true；extractEntry 对加密条目 reject（UI 先拦的兜底）', async () => {
      const zip = buildRawZip([{ name: TE.encode('secret.txt'), data: TE.encode('ciphertext-here'), flags: 0x0001 }])
      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.entries[0].encrypted).toBe(true)
      await expect(extractEntry(readerOf(zip), central.entries[0])).rejects.toThrow()
    })
  })

  describe('zip64', () => {
    it('CD 三字段 0xFFFFFFFF + extra 0x0001 真值；EOCD count=0xFFFF + zip64 EOCD 真值 → meta 取真值且 zip64=true', async () => {
      const data = TE.encode('0123456789abcdef') // 16 字节真数据（本用例只看 meta）
      const zip = buildRawZip([{ name: TE.encode('big.bin'), data, zip64: true }])
      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.zip64).toBe(true)
      expect(central.entries.length).toBe(1) // 条目数真值来自 zip64 EOCD（EOCD 侧 count=0xFFFF）
      const e = central.entries[0]
      expect(e.name).toBe('big.bin')
      expect(e.size).toBe(16) // extra 0x0001 真值（CD 字段是 0xFFFFFFFF 占位）
      expect(e.compressedSize).toBe(16)
      expect(e.offset).toBe(0) // LFH 在文件头，真偏移 0
      expect(e.method).toBe(0)
      expect(e.crc32).toBe(crc32(data))
    })
  })

  describe('EOCD 定位（取最后一个）', () => {
    it('尾部 ≥64KB 乱数据内两处假 PK\\x05\\x06 干扰 → 仍定位到真 EOCD 并解出 comment/条目', async () => {
      const base = buildRawZip([{ name: TE.encode('only.txt'), data: TE.encode('payload') }])
      const prefix = base.slice(0, base.length - 22) // 剥掉无注释的 22 字节 EOCD，自己拼带 comment 的真 EOCD
      const origEocd = base.slice(base.length - 22)
      const comment = TE.encode('tail-comment')

      // 70KB 乱数据（≥64KB），内嵌两处假 EOCD：注释长度字段填 0xFFFF 使其结构非法（尾部凑不满 65535 字节）
      const junk = new Uint8Array(70 * 1024)
      for (let i = 0; i < junk.length; i++) junk[i] = (i * 31 + 7) & 0xff
      const fake = (commentLen: number): number[] => [
        ...le32(0x06054b50), // +0 假 EOCD 签名 PK\x05\x06
        ...le16(0), // +4 盘号
        ...le16(0), // +6 CD 起始盘
        ...le16(0), // +8 条目数
        ...le16(0), // +10 总条目数
        ...le32(0), // +12 CD 大小
        ...le32(0), // +16 CD 偏移
        ...le16(commentLen), // +20 注释长度（0xFFFF → 非法）
      ]
      junk.set(Uint8Array.from(fake(0xffff)), 100)
      junk.set(Uint8Array.from(fake(0xffff)), 40000)

      // 真 EOCD：沿用原 EOCD 的 18 字节字段（含真 CD 大小/偏移），换上真注释
      const realEocd = Uint8Array.from([...origEocd.slice(0, 20), ...le16(comment.length), ...comment])
      const zip = concat(prefix, junk, realEocd)

      // 自证：文件里 PK\x05\x06 出现 ≥3 次（2 假 + 1 真）——正向找第一个必错
      let sigCount = 0
      for (let i = 0; i + 3 < zip.length; i++) {
        if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) sigCount++
      }
      expect(sigCount).toBeGreaterThanOrEqual(3)

      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.comment).toBe('tail-comment') // 取「最后一个」EOCD 的铁证
      expect(central.entries.length).toBe(1)
      expect(central.entries[0].name).toBe('only.txt')
      expect(central.zip64).toBe(false)
    })
  })

  describe('extractEntry 边界', () => {
    it('LFH extraLen 与 CD extraLen 不同 → 数据起点以 local 为准', async () => {
      const zip = buildRawZip([
        {
          name: TE.encode('x.txt'),
          data: TE.encode('payload-x'),
          lfhExtra: Uint8Array.of(0x99, 0x98, 0x02, 0x00, 0xaa, 0xbb), // LFH 侧 6 字节
          cdExtra: Uint8Array.of(0x99, 0x98, 0x04, 0x00, 1, 2, 3, 4), // CD 侧 8 字节（错用会把数据读偏 2 字节）
        },
      ])
      const central = await parseCentralDirectory(readerOf(zip))
      const out = await extractEntry(readerOf(zip), central.entries[0])
      expect(bytesEqual(out, TE.encode('payload-x'))).toBe(true)
    })

    it('未支持的压缩方法（12=bzip2）→ reject', async () => {
      const zip = buildRawZip([{ name: TE.encode('bz.bin'), data: TE.encode('data'), method: 12 }])
      const central = await parseCentralDirectory(readerOf(zip))
      await expect(extractEntry(readerOf(zip), central.entries[0])).rejects.toThrow()
    })

    it('CRC 错（CD 的 crc32 字段被改错）→ reject 且错误为 CrcMismatch', async () => {
      const zip = zipSync({ 'good.txt': TE.encode('intact payload') })
      // 把第一个中心目录条目（PK\x01\x02）的 CRC 字段（+16，4 字节）改成错值
      let cd = -1
      for (let i = 0; i + 3 < zip.length; i++) {
        if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
          cd = i
          break
        }
      }
      expect(cd).toBeGreaterThan(0)
      const bad = ((zip[cd + 16] | (zip[cd + 17] << 8) | (zip[cd + 18] << 16) | (zip[cd + 19] << 24)) + 1) >>> 0
      zip.set(le32(bad), cd + 16)

      const central = await parseCentralDirectory(readerOf(zip))
      const err: unknown = await extractEntry(readerOf(zip), central.entries[0]).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe('CrcMismatch')
    })
  })

  describe('sanitizeEntryName（zip slip 防护）', () => {
    // 契约：反斜杠→/；绝对路径/盘符/含 '..' 段 → null。
    // 其中 'a/./b' 契约未明确 '.' 段是否 normalize，两种实现均合法——断言其一（'a/b'），若实现选择原样返回 'a/./b' 也符合契约，此处以归一为准。
    it.each([
      ['../evil.txt', null], // 越前缀
      ['/abs/path', null], // 绝对路径
      ['C:\\x', null], // 盘符
      ['a\\b.txt', 'a/b.txt'], // 反斜杠归一为 /
      ['ok/dir/f.txt', 'ok/dir/f.txt'], // 正常相对路径原样
      ['a/../../x', null], // 内嵌 '..' 越前缀
      ['a/./b', 'a/b'], // '.' 段归一（或原样 'a/./b'，见上注）
    ])('%s → %s', (input, expected) => {
      const got = sanitizeEntryName(input)
      if (input === 'a/./b') {
        expect(['a/b', 'a/./b']).toContain(got) // 按契约 normalize 实现断言其一
      } else {
        expect(got).toBe(expected)
      }
    })
  })

  describe('checkBomb（解压炸弹防护）', () => {
    const GB = 1024 ** 3

    it('ZIP_BOMB_RATIO_LIMIT = 200', () => {
      expect(ZIP_BOMB_RATIO_LIMIT).toBe(200)
    })

    it('默认：解压总量 > 2GB 拦截', () => {
      const r = checkBomb([stubMeta({ size: 1.5 * GB }), stubMeta({ size: 0.6 * GB })]) // 合计 2.1GB
      expect(r.ok).toBe(false)
    })

    it('默认：条目数 > 10000 拦截，= 10000 放行', () => {
      expect(checkBomb(Array.from({ length: 10001 }, () => stubMeta())).ok).toBe(false)
      expect(checkBomb(Array.from({ length: 10000 }, () => stubMeta())).ok).toBe(true)
    })

    it('默认：单条压缩比 > 200 拦截（10 → 3000 为 300），= 200 放行', () => {
      expect(checkBomb([stubMeta({ size: 3000, compressedSize: 10 })]).ok).toBe(false)
      expect(checkBomb([stubMeta({ size: 2000, compressedSize: 10 })]).ok).toBe(true) // ratio 恰为 200
    })

    it('正常包 ok:true', () => {
      const r = checkBomb([
        stubMeta({ size: 100, compressedSize: 50 }),
        stubMeta({ size: 200, compressedSize: 180 }),
        stubMeta({ name: 'dir/', size: 0, compressedSize: 0, isDirectory: true }),
      ])
      expect(r).toEqual({ ok: true })
    })

    it('自定义 opts 生效：maxTotalBytes / maxEntries / ratio 覆盖默认', () => {
      // maxTotalBytes 收紧到 999：1000 字节即拦
      expect(checkBomb([stubMeta({ size: 1000, compressedSize: 1000 })], { maxTotalBytes: 999 }).ok).toBe(false)
      // maxEntries 放宽到 20000：10001 条放行
      expect(checkBomb(Array.from({ length: 10001 }, () => stubMeta()), { maxEntries: 20000 }).ok).toBe(true)
      // ratio 收紧到 10：300 倍即拦；放宽到 1000：300 倍放行
      const bomb = [stubMeta({ size: 3000, compressedSize: 10 })]
      expect(checkBomb(bomb, { ratio: 10 }).ok).toBe(false)
      expect(checkBomb(bomb, { ratio: 1000 }).ok).toBe(true)
    })
  })

  describe('DOS 时间 → epoch ms', () => {
    it('2026-01-02 03:04:00 → Date.UTC(2026,0,2,3,4,0)', async () => {
      // DOS 日期（高 16 位字）：((2026-1980)<<9) | (1<<5) | 2 = 0x5C22；DOS 时间（低 16 位字）：(3<<11) | (4<<5) | 0 = 0x1880
      // 契约口径：DOS 时间无时区语义，纯函数按 UTC 定标（若实现取本地时区，此断言首跑即暴露，属契约对齐点）
      const zip = buildRawZip([{ name: TE.encode('d.txt'), data: TE.encode('x'), dosDate: 0x5c22, dosTime: 0x1880 }])
      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.entries[0].lastModified).toBe(Date.UTC(2026, 0, 2, 3, 4, 0))
    })
  })

  // ---------- 评审守卫（R1 回归钉：P0-1 / P1-1 / P1-2 / P2-3 / P2-4） ----------

  /** 「声明值撒谎」单条目包：CD 的 usize/crc 由调用方指定（可与真实 deflate 流不符）；LFH 只被读 nameLen/extraLen，字段随意 */
  const buildLyingZip = (name: Uint8Array, deflated: Uint8Array, declaredUsize: number, declaredCrc: number): Uint8Array => {
    const lfh = Uint8Array.from([
      ...le32(0x04034b50), // +0 签名 PK\x03\x04
      ...le16(20), // +4 版本
      ...le16(0), // +6 flags
      ...le16(8), // +8 method=deflate
      ...le16(0), ...le16(0), // +10/+12 DOS 时间/日期
      ...le32(declaredCrc), // +14 CRC（extract 不读 LFH 侧）
      ...le32(deflated.length), // +18 压缩后大小（诚实）
      ...le32(declaredUsize), // +22 原始大小（同样撒谎，无实现读它）
      ...le16(name.length), // +26 文件名长度
      ...le16(0), // +28 LFH extra 长度
    ])
    const cd = Uint8Array.from([
      ...le32(0x02014b50), // +0 签名 PK\x01\x02
      ...le16(20), ...le16(20), // +4/+6 版本
      ...le16(0), // +8 flags
      ...le16(8), // +10 method=deflate
      ...le16(0), ...le16(0), // +12/+14 DOS 时间/日期
      ...le32(declaredCrc), // +16 CRC（撒谎位之一）
      ...le32(deflated.length), // +20 压缩后大小（诚实，流真实长度）
      ...le32(declaredUsize), // +24 原始大小（撒谎位之二：64B，真实流 64KB）
      ...le16(name.length), // +28 文件名长度
      ...le16(0), // +30 extra 长度
      ...le16(0), // +32 注释长度
      ...le16(0), // +34 盘号
      ...le16(0), // +36 内部属性
      ...le32(0), // +38 外部属性
      ...le32(0), // +42 LFH 偏移（文件头）
    ])
    const cdOffset = 30 + name.length + deflated.length
    const eocd = Uint8Array.from([
      ...le32(0x06054b50), // +0 EOCD 签名
      ...le16(0), ...le16(0), // +4/+6 盘号
      ...le16(1), ...le16(1), // +8/+10 条目数
      ...le32(cd.length), // +12 CD 大小
      ...le32(cdOffset), // +16 CD 偏移
      ...le16(0), // +20 注释长度
    ])
    return concat(lfh, name, deflated, cd, name, eocd)
  }

  describe('评审守卫（R1 回归钉）', () => {
    const A64 = TE.encode('A'.repeat(64))
    const A64K = TE.encode('A'.repeat(65536))

    it('P0-1 炸弹执行闸：CD 声明 64B、真实流解 64KB → 输出长度恒 === 声明值（无内存放大）', async () => {
      // 全 'A' 流的截断前缀 CRC 恰等于声明 CRC → 放行返回，可直接度量输出：64B，不是 64KB
      const zip = buildLyingZip(TE.encode('bomb.bin'), deflateSync(A64K), 64, crc32(A64))
      const central = await parseCentralDirectory(readerOf(zip))
      expect(central.entries[0].size).toBe(64) // 声明值
      const out = await extractEntry(readerOf(zip), central.entries[0])
      expect(out.length).toBe(64) // 恒 === 声明 size：64KB 流不解出 64KB 内存
      expect(bytesEqual(out, A64)).toBe(true) // 内容=流的前 64 字节
    })

    it('P0-1 炸弹执行闸：截断输出撞诚实 CRC（全量流 CRC）→ CrcMismatch 兜底拒绝', async () => {
      const zip = buildLyingZip(TE.encode('bomb.bin'), deflateSync(A64K), 64, crc32(A64K))
      const central = await parseCentralDirectory(readerOf(zip))
      const err: unknown = await extractEntry(readerOf(zip), central.entries[0]).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe('CrcMismatch') // 截断必被 CRC 闸兜住
    })

    it('P1-2 cdSize 越界：EOCD 声明 cdSize > size → reject「中心目录损坏/越界」（不发 4GB Range）', async () => {
      const zip = buildRawZip([{ name: TE.encode('a.txt'), data: TE.encode('x') }])
      const eocdAt = zip.length - 22 // 无注释包的 EOCD 恰为末 22 字节
      zip.set(le32(zip.length + 1024), eocdAt + 12) // +12 = cdSize 字段撒谎成 size+1024
      const err: unknown = await parseCentralDirectory(readerOf(zip)).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).not.toBe('RangeError')
      expect((err as Error).message).toMatch(/中心目录损坏|越界/)
    })

    it('P1-1 畸形 extraLen：extraLen=0xFFFF 但 extra 实际 0 字节 → 不抛裸 RangeError，reject 中文错误', async () => {
      // CD 单条目 51 字节：usize/csize 走 0xFFFFFFFF 占位（触发 zip64 extra 通道这一裸读风险点），
      // extraLen 声明 0xFFFF 但名字后 0 字节；EOCD count=2 → 越界推进后第二条目收敛为「中心目录损坏」
      const nameBytes = TE.encode('a.txt')
      const cd = Uint8Array.from([
        ...le32(0x02014b50), // +0 签名 PK\x01\x02
        ...le16(20), ...le16(20), // +4/+6 版本
        ...le16(0), // +8 flags
        ...le16(0), // +10 method
        ...le16(0), ...le16(0), // +12/+14 DOS 时间/日期
        ...le32(0), // +16 CRC
        ...le32(0xffffffff), // +20 csize 占位
        ...le32(0xffffffff), // +24 usize 占位
        ...le16(nameBytes.length), // +28 文件名长度
        ...le16(0xffff), // +30 extra 长度（撒谎：实际 0 字节）
        ...le16(0), // +32 注释长度
        ...le16(0), // +34 盘号
        ...le16(0), // +36 内部属性
        ...le32(0), // +38 外部属性
        ...le32(0), // +42 LFH 偏移
        ...nameBytes, // +46 名字（此后无 extra 字节）
      ])
      const eocd = Uint8Array.from([
        ...le32(0x06054b50), ...le16(0), ...le16(0),
        ...le16(2), ...le16(2), // count=2：第一条目 extraLen 越界推进后，第二条目必越界
        ...le32(cd.length), ...le32(0), ...le16(0),
      ])
      const zip = concat(cd, eocd) // parseCentralDirectory 不读 LFH，无需构造
      const err: unknown = await parseCentralDirectory(readerOf(zip)).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).not.toBe('RangeError') // 畸形界不裸抛
      expect((err as Error).message).toMatch(/中心目录损坏/)
    })

    it('P2-3 NUL：条目名含 \\u0000 → null', () => {
      expect(sanitizeEntryName('x\u0000y')).toBeNull()
    })

    it('P2-4 GBK 回退不可用（stub TextDecoder 使 gbk 抛错）→ 不炸、有名称且走 latin1（全字节域 1:1）', async () => {
      // 既有 GBK 用例已把实现的模块级 gbkDecoder 缓存为真实实例，故换新模块实例 + stub 全局
      // TextDecoder（gbk 标签抛错、其余委派真实实现），在干净实例上逼出 latin1 回退分支
      const RealTextDecoder = TextDecoder
      class GbkLessDecoder {
        private real: TextDecoder
        constructor(label: string, opts?: TextDecoderOptions) {
          if (label === 'gbk') throw new Error('gbk 编码表缺失（stub 模拟精简运行时）')
          this.real = new RealTextDecoder(label, opts)
        }
        decode(input: ArrayBufferView | ArrayBuffer): string {
          return this.real.decode(input)
        }
      }
      vi.stubGlobal('TextDecoder', GbkLessDecoder)
      try {
        vi.resetModules()
        const fresh = await import('../zip-reader')
        const zip = buildRawZip([{ name: GBK_NAME, data: TE.encode('内容'), flags: 0 }])
        const central = await fresh.parseCentralDirectory(readerOf(zip))
        const name = central.entries[0].name
        expect(typeof name).toBe('string') // 不炸且有名称（宽松口径）
        expect(name.length).toBeGreaterThan(0)
        expect(name.length).toBe(GBK_NAME.length) // latin1 1 字节/字符 → 8 字；GBK 回退会是 6 字（报表.txt）
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
