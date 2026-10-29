/**
 * zip 在线解压解析器（M4）：纯函数模块，无 DOM 依赖——输入是 RangeReader 抽象
 * （[start, end) 半开区间分片读），浏览只读尾部窗口（≤65557B，EOCD 最大跨度）+ 中心目录，
 * 大包秒开不解全包；解出按条目 Range 读 local header + 压缩数据。
 *
 * 二进制结构对齐 APPNOTE.TXT：LFH 30B（PK\x03\x04）/ CD 46B（PK\x01\x02）/
 * EOCD 22B（PK\x05\x06）/ zip64 EOCD 56B（PK\x06\x06）/ zip64 locator 20B（PK\x06\x07）。
 *
 * 安全面（三闸 + 一拒绝）：
 *  - zip slip：sanitizeEntryName 拒绝绝对路径/盘符/'..' 段，反斜杠归一为 /；
 *  - 解压炸弹：checkBomb 拦 解压总量 ≤2GB / 条目数 ≤10000 / 单条压缩比 >200；
 *    extractEntry 执行闸：inflate 输出以声明 size 封顶（不信任声明值），伪造声明无法放大内存；
 *  - 加密包：CD flag bit0 识别 → meta.encrypted（UI 标 🔒），extractEntry 兜底拒绝；
 *  - 文件名编码：flag bit11=UTF-8，否则严格 UTF-8 失败回退 GBK（Windows 中文压缩包生态）。
 */
import { inflateSync } from 'fflate'

// ───────────────────────── 契约 ─────────────────────────

/** 中心目录条目元数据（浏览表单行；offset 指向 local header，解出时用） */
export interface ZipEntryMeta {
  /** 已解码条目名（bit11/GBK 已归一），目录条目保留结尾 '/' */
  name: string
  /** 原始大小（字节） */
  size: number
  /** 压缩后大小（字节） */
  compressedSize: number
  /** 压缩方法：0 store / 8 deflate（其余不支持，解出时拒绝） */
  method: number
  /** 原始数据 CRC-32（解出后实算比对，不一致拒绝） */
  crc32: number
  /** 修改时间 epoch ms（DOS 时间无时区语义，按 UTC 定标） */
  lastModified: number
  /** CD flag bit0：加密条目（在线解压不支持） */
  encrypted: boolean
  /** local header 在包内的绝对偏移 */
  offset: number
  /** 目录条目（名字以 / 结尾，无数据） */
  isDirectory: boolean
}

/** 中心目录整体解析结果 */
export interface ZipCentral {
  entries: ZipEntryMeta[]
  /** 包走 zip64 通道（locator + zip64 EOCD） */
  zip64: boolean
  /** EOCD 注释（UTF-8 宽松解码） */
  comment: string
}

/** 分片读抽象：[start, end) 半开区间；实现方为 S3 Range 读 / 内存切片等 */
export interface RangeReader {
  size(): Promise<number>
  read(start: number, end: number): Promise<Uint8Array>
}

/** 解压炸弹单条压缩比上限（解压后/压缩前），超过即拦；=200 放行 */
export const ZIP_BOMB_RATIO_LIMIT = 200

/** checkBomb 可调闸口（缺省对齐方案 F7：2GB / 10000 条 / ratio 200） */
export interface CheckBombOptions {
  /** 声明解压总量上限（字节），默认 2GB */
  maxTotalBytes?: number
  /** 条目数上限，默认 10000 */
  maxEntries?: number
  /** 单条压缩比上限，默认 ZIP_BOMB_RATIO_LIMIT */
  ratio?: number
}

// ───────────────────────── 字节读取工具 ─────────────────────────

/** zip 签名（小端 u32 口径） */
const SIG_LFH = 0x04034b50 // PK\x03\x04
const SIG_CD = 0x02014b50 // PK\x01\x02
const SIG_EOCD = 0x06054b50 // PK\x05\x06
const SIG_Z64_EOCD = 0x06064b50 // PK\x06\x06
const SIG_Z64_LOC = 0x07064b50 // PK\x06\x07
/** EOCD 定位窗口：22B 定长 + 65535B 注释上限，即 EOCD 起点距文件尾的最大可能距离 */
const EOCD_WINDOW_MAX = 65557
const EOCD_MIN_LEN = 22
/** u32 占位符（zip64：真值在 extra field 0x0001） */
const U32_MAX = 0xffffffff

/** DataView 包装（显式带 byteOffset/byteLength，兼容子数组视图共享底层 buffer 的情形） */
function dvOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}
const u16 = (d: DataView, at: number): number => d.getUint16(at, true)
const u32 = (d: DataView, at: number): number => d.getUint32(at, true)
/**
 * u64 → number（低 32 位在前）。> 2^53 时丢精度——zip 单条目/偏移到 PB 级不现实，
 * 换 BigInt 徒增全体调用方负担，故按 number 口径。
 */
const u64 = (d: DataView, at: number): number => d.getUint32(at, true) + d.getUint32(at + 4, true) * 2 ** 32

// ───────────────────────── CRC-32（IEEE 0xEDB88320，与 zip/fflate 一致） ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** CRC-32 → u32（对照中心目录 crc32 字段） */
function crc32Of(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ───────────────────────── DOS 时间 / 文件名解码 ─────────────────────────

/**
 * DOS 日期/时间 → epoch ms。DOS 时间无时区语义，契约口径按 UTC 定标（Date.UTC）。
 * 日期：bit15-9=年-1980，bit8-5=月，bit4-0=日；时间：bit15-11=时，bit10-5=分，bit4-0=秒/2。
 */
function dosDateTimeToEpochMs(dosDate: number, dosTime: number): number {
  return Date.UTC(
    (dosDate >> 9) + 1980,
    ((dosDate >> 5) & 0x0f) - 1,
    dosDate & 0x1f,
    dosTime >> 11,
    (dosTime >> 5) & 0x3f,
    (dosTime & 0x1f) * 2,
  )
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true }) // 无 bit11 时先试严格解码（失败→GBK）
const UTF8_LOOSE = new TextDecoder('utf-8')
/** GBK 惰性实例化：个别精简运行时无 gbk 编码表，避免模块加载即炸 */
let gbkDecoder: TextDecoder | null = null

/** 条目名解码：bit11=1 直走 UTF-8；否则严格 UTF-8 失败回退 GBK */
function decodeEntryName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return UTF8_LOOSE.decode(bytes)
  try {
    return UTF8_STRICT.decode(bytes)
  } catch {
    // 回退解码器构造也包一层：gbk 编码表缺失时 new TextDecoder('gbk') 自身会抛，
    // 若放任其冒泡会顶替上面原始的严格 UTF-8 解码错误——构造失败退 latin1
    // （'latin1' 是 WHATWG 规范必实现标签 windows-1252 的别名，恒可用且全字节域无 fatal）。
    try {
      gbkDecoder ??= new TextDecoder('gbk')
    } catch {
      gbkDecoder = new TextDecoder('latin1')
    }
    return gbkDecoder.decode(bytes)
  }
}

// ───────────────────────── 安全闸 ─────────────────────────

/**
 * zip slip 防护：反斜杠归一为 /；绝对路径 / 盘符 / 含 '..' 段 → null（拒绝该条目）；
 * '.' 段顺带归一（'a/./b' → 'a/b'），空段折叠；纯 '.' / 空名 → null；
 * 含 NUL（\u0000）→ null（S3 键虽无害，但 UI 消费面不该见 NUL 控制字符）。
 */
export function sanitizeEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.includes('\u0000')) return null // NUL 截断类攻击面（C 语言族按 NUL 截名）
  if (/^[a-zA-Z]:/.test(normalized)) return null // 盘符（C:\x）
  if (normalized.startsWith('/')) return null // 绝对路径
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..')) return null // 越前缀
  return parts.join('/') + (normalized.endsWith('/') ? '/' : '')
}

/**
 * 解压炸弹防护三闸：条目数 ≤maxEntries、声明解压总量 ≤maxTotalBytes、
 * 单条压缩比 size/compressedSize ≤ratio（>ratio 拦，=ratio 放行）。
 * 通过返回 { ok: true }；超限返回 { ok: false, reason }（toast 直出）。
 */
export function checkBomb(entries: ZipEntryMeta[], opts?: CheckBombOptions): { ok: boolean; reason?: string } {
  const maxTotalBytes = opts?.maxTotalBytes ?? 2 * 1024 ** 3
  const maxEntries = opts?.maxEntries ?? 10000
  const ratio = opts?.ratio ?? ZIP_BOMB_RATIO_LIMIT
  if (entries.length > maxEntries) return { ok: false, reason: `条目数超限：${entries.length} > ${maxEntries}` }
  let total = 0
  for (const e of entries) {
    if (e.compressedSize > 0 && e.size / e.compressedSize > ratio) {
      return { ok: false, reason: `压缩比超限：${e.name}（${Math.round(e.size / e.compressedSize)} 倍 > ${ratio} 倍）` }
    }
    total += e.size
    if (total > maxTotalBytes) return { ok: false, reason: `解压总量超限：>${Math.round(maxTotalBytes / 1024 ** 3)}GB` }
  }
  return { ok: true }
}

// ───────────────────────── 中心目录解析 ─────────────────────────

/** EOCD 定位结果：dv/at 指向尾窗内记录头，abs 为包内绝对偏移，tail 供注释取字节 */
interface EocdLocation {
  dv: DataView
  at: number
  abs: number
  tail: Uint8Array
}

/**
 * EOCD 定位：只读尾部 min(65557, size) 窗口，从尾向头扫「最后一个」PK\x05\x06
 * （注释内可有伪 signature，注释长度恰好顶到窗口尾作辅助校验）；
 * 无恰好贴合者再放宽为「注释不越窗」（容忍文件尾有无关拖尾字节）。
 *
 * 已知局限（ZIP 格式固有两义性，Info-ZIP / Python zipfile 同行为，不修）：
 * 注释内若存在「comment 长度字段恰好顶到文件尾」的伪 EOCD，倒序扫会先命中它——
 * 真伪两者声明值不同时解析结果可被注入。升级路径（如需）：命中后做后验——
 * 按其声明读 cdOffset+cdSize，确认中心目录数据恰好终结于该 EOCD 绝对位置（≈eocd.abs）
 * 才接受，否则继续向前扫。
 */
async function locateEocd(r: RangeReader, size: number): Promise<EocdLocation> {
  const winStart = Math.max(0, size - EOCD_WINDOW_MAX)
  const tail = await r.read(winStart, size)
  const dv = dvOf(tail)
  for (const exactFit of [true, false]) {
    for (let i = tail.length - EOCD_MIN_LEN; i >= 0; i--) {
      if (u32(dv, i) !== SIG_EOCD) continue
      const end = i + EOCD_MIN_LEN + u16(dv, i + 20)
      if (end === tail.length || (!exactFit && end < tail.length)) return { dv, at: i, abs: winStart + i, tail }
    }
  }
  throw new Error('zip: EOCD 未找到（不是 zip 包，或尾部结构损坏）')
}

/**
 * zip64 通道：EOCD 紧前 20B 有 locator（PK\x06\x07）→ 按其指向读 zip64 EOCD（PK\x06\x06，56B）。
 * EOCD 侧 0xFFFF/0xFFFFFFFF 占位才取 zip64 真值（字段级回退，兼容混用形态）。
 */
async function applyZip64Eocd(
  r: RangeReader,
  eocdAbs: number,
  fields: { count: number; cdSize: number; cdOffset: number },
): Promise<boolean> {
  if (eocdAbs < 20) return false
  const locBytes = await r.read(eocdAbs - 20, eocdAbs)
  if (locBytes.length < 20 || u32(dvOf(locBytes), 0) !== SIG_Z64_LOC) return false
  const loc = dvOf(locBytes)
  const z64At = u64(loc, 8)
  // 伪 locator 的 z64At 攻击者可控（可指向任意/越界偏移）——读回不足 56B 时先验长度，
  // 不让裸 DataView 读抛 RangeError，统一收敛为中文「包损坏」错误
  const recBytes = await r.read(z64At, z64At + 56)
  if (recBytes.length < 56 || u32(dvOf(recBytes), 0) !== SIG_Z64_EOCD) {
    throw new Error('zip: zip64 locator 指向处非 zip64 EOCD（包损坏）')
  }
  const rec = dvOf(recBytes)
  if (fields.count === 0xffff) fields.count = u64(rec, 32) // 本盘条目数/总条目数在单盘包内取总口径即可
  if (fields.cdSize === U32_MAX) fields.cdSize = u64(rec, 40)
  if (fields.cdOffset === U32_MAX) fields.cdOffset = u64(rec, 48)
  return true
}

/**
 * 条目内 zip64 extra（field id 0x0001）：CD 三字段出现 0xFFFFFFFF 占位时，
 * 按 APPNOTE 固定顺序（原始大小 → 压缩后大小 → LFH 偏移）逐个消费 8 字节真值
 * （只有占位的字段才写进 extra，故按字段缺序取）。
 */
function applyZip64Extra(
  dv: DataView,
  extraStart: number,
  extraEnd: number,
  fields: { usize: number; csize: number; lfhOffset: number },
): void {
  // 界收敛：extraStart/extraEnd 取自条目自声明的 nameLen/extraLen，畸形包（如 extraLen=0xFFFF）
  // 会越过 buffer——不收敛则裸 DataView 读抛 RangeError；夹到真实界内即可（while 条件自会跳过越界段）
  extraEnd = Math.min(extraEnd, dv.byteLength)
  let at = extraStart
  while (at + 4 <= extraEnd) {
    const id = u16(dv, at)
    const len = u16(dv, at + 2)
    const body = at + 4
    if (id === 0x0001) {
      let f = body
      const fEnd = Math.min(body + len, extraEnd)
      if (fields.usize === U32_MAX && f + 8 <= fEnd) {
        fields.usize = u64(dv, f)
        f += 8
      }
      if (fields.csize === U32_MAX && f + 8 <= fEnd) {
        fields.csize = u64(dv, f)
        f += 8
      }
      if (fields.lfhOffset === U32_MAX && f + 8 <= fEnd) fields.lfhOffset = u64(dv, f)
      return
    }
    at = body + len
  }
}

/** 中心目录全量解析（只读 EOCD 尾窗 + zip64 记录 + CD 本体，不解条目数据） */
export async function parseCentralDirectory(r: RangeReader): Promise<ZipCentral> {
  const size = await r.size()
  const eocd = await locateEocd(r, size)

  const fields = {
    count: u16(eocd.dv, eocd.at + 10),
    cdSize: u32(eocd.dv, eocd.at + 12),
    cdOffset: u32(eocd.dv, eocd.at + 16),
  }
  const zip64 = await applyZip64Eocd(r, eocd.abs, fields)
  const commentLen = u16(eocd.dv, eocd.at + 20)
  const comment = UTF8_LOOSE.decode(eocd.tail.subarray(eocd.at + EOCD_MIN_LEN, eocd.at + EOCD_MIN_LEN + commentLen))

  // EOCD/zip64 EOCD 的声明值不可信：伪 cdSize=0xFFFFFFFF 会强制发起 ~4GB Range 拉取——
  // 发读之前先验界（cdSize ≤ size 且 cdOffset + cdSize ≤ size），不合法按「中心目录损坏」拒绝
  if (fields.cdSize > size || fields.cdOffset > size - fields.cdSize) {
    throw new Error('zip: 中心目录损坏（CD 偏移/大小越界，EOCD 声明不可信）')
  }
  const cd = await r.read(fields.cdOffset, fields.cdOffset + fields.cdSize)
  const cdDv = dvOf(cd)
  const entries: ZipEntryMeta[] = []
  let p = 0
  for (let n = 0; n < fields.count; n++) {
    if (p + 46 > cd.length || u32(cdDv, p) !== SIG_CD) throw new Error('zip: 中心目录损坏（PK\\x01\\x02 不符或条目不足）')
    const flags = u16(cdDv, p + 8)
    const method = u16(cdDv, p + 10)
    const dosTime = u16(cdDv, p + 12)
    const dosDate = u16(cdDv, p + 14)
    const item = { usize: u32(cdDv, p + 24), csize: u32(cdDv, p + 20), lfhOffset: u32(cdDv, p + 42) }
    const nameLen = u16(cdDv, p + 28)
    const extraLen = u16(cdDv, p + 30)
    const itemCommentLen = u16(cdDv, p + 32)
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen)
    if (item.usize === U32_MAX || item.csize === U32_MAX || item.lfhOffset === U32_MAX) {
      applyZip64Extra(cdDv, p + 46 + nameLen, p + 46 + nameLen + extraLen, item)
      // 消费后仍留 0xFFFFFFFF 占位 = zip64 extra 0x0001 缺失或截短——显式拒绝，
      // 勿把占位符当真值产出 size=4294967295 的元数据行
      if (item.usize === U32_MAX || item.csize === U32_MAX || item.lfhOffset === U32_MAX) {
        throw new Error('zip: 中心目录损坏（zip64 字段损坏：0xFFFFFFFF 占位未被 extra 0x0001 真值替换）')
      }
    }
    entries.push({
      name: decodeEntryName(nameBytes, (flags & 0x0800) !== 0),
      size: item.usize,
      compressedSize: item.csize,
      method,
      crc32: u32(cdDv, p + 16),
      lastModified: dosDateTimeToEpochMs(dosDate, dosTime),
      encrypted: (flags & 0x0001) !== 0,
      offset: item.lfhOffset,
      isDirectory: (nameBytes[nameBytes.length - 1] ?? 0) === 0x2f, // 名尾 '/'，按原始字节判（编码无关）
    })
    p += 46 + nameLen + extraLen + itemCommentLen
  }
  return { entries, zip64, comment }
}

// ───────────────────────── 条目解出 ─────────────────────────

/**
 * 单条目解出：Range 读 local header（extraLen 以 local 为准，与 CD 侧可不同）→
 * method 0 store 原样 / 8 deflate inflateSync（fflate 的 raw inflate 同步口径）→
 * CRC-32 实算比对（失败 err.name='CrcMismatch'）；加密条目兜底拒绝（UI 先拦）。
 */
export async function extractEntry(r: RangeReader, entry: ZipEntryMeta): Promise<Uint8Array> {
  if (entry.encrypted) throw new Error(`zip: 条目已加密，不支持在线解压：${entry.name}`)
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`zip: 不支持的压缩方法 ${entry.method}（仅 store/deflate）：${entry.name}`)
  }

  const lfhBytes = await r.read(entry.offset, entry.offset + 30)
  // local header 短读（伪 offset 贴近包尾 / 包损坏）若直接 dv 读会裸抛 RangeError——先验长度，
  // 包一层模块统一的「zip: ...」中文错误再抛（无原始异常可保留，短读即病因本身）
  if (lfhBytes.length < 30) {
    throw new Error(`zip: local header 读取不足 30 字节（偏移越界或包损坏）：${entry.name}`)
  }
  const lfh = dvOf(lfhBytes)
  if (u32(lfh, 0) !== SIG_LFH) throw new Error(`zip: local header 签名不符（PK\\x03\\x04）：${entry.name}`)
  const dataStart = entry.offset + 30 + u16(lfh, 26) + u16(lfh, 28) // extraLen 取 local 头，不取 CD 侧

  // 发读前置界验：csize 不受 checkBomb 约束（伪造 usize=1KB + csize=5GB → ratio≈0 全过），
  // 直信声明 csize 会把越 EOF 读放大成整包拉内存——诚实包的 csize 永不越 EOF，零误伤；
  // dataStart 自身越界（<0 / >size）同在此拒。与 CD 侧同款「声明不可信」口径。
  const size = await r.size()
  if (dataStart < 0 || dataStart > size || entry.compressedSize > size - dataStart) {
    throw new Error(`zip: 压缩数据越界（声明大小/偏移超出包长，CD/local 声明不可信）：${entry.name}`)
  }
  const raw = await r.read(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return raw.slice() // store：恰好大小 memcpy，脱离 reader 可能复用的底层大 buffer
  // 执行闸：不信任声明值，inflate 输出封顶——out 以 CD 声明 size 预分配，内存上界=声明值，
  // 杜绝「伪造声明 65KB 实解 64MB」的炸弹放大（声明总量另受 checkBomb 2GB 闸约束）。
  // 注意 fflate 0.8.3 超出 out 的实际行为按块类型二分：stored 块 buf.set 越界抛 RangeError（下方
  // try/catch 归一为模块统一中文错误），huffman 块写入变 no-op 静默截断——故返回后再硬校验
  // 「输出恰等于声明 size」兜短侧；截断侧由 CRC 兜底——除非 CRC 同被伪造，此时输出已封顶
  // 声明值，仅损失完整性语义、无内存放大。
  let out: Uint8Array
  try {
    out = inflateSync(raw, { out: new Uint8Array(entry.size) })
  } catch (cause) {
    throw new Error(`zip: 解压失败（stored 块超出声明大小或流损坏）：${entry.name}`, { cause })
  }
  if (out.length !== entry.size) {
    throw new Error(`zip: 解压输出与声明大小不符（疑似解压炸弹或包损坏）：${entry.name}（实解 ${out.length}B ≠ 声明 ${entry.size}B）`)
  }
  if (crc32Of(out) !== entry.crc32) {
    const err = new Error(`zip: CRC-32 校验失败：${entry.name}`)
    err.name = 'CrcMismatch'
    throw err
  }
  // out 即「恰好大小」的新 buffer（byteOffset 0 的完整视图），直接返回无需再拷贝。
  // 旧 structuredClone 是反向优化：fflate 产物本已恰好大小，而 clone 一个视图会克隆
  // 整个底层 buffer 且保留 byteOffset（实测视图 32B + 底层 1MB → 克隆 1MB），纯属浪费。
  return out
}
