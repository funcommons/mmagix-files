/**
 * WebDAV 207 multistatus XML 解析（M1 骨架）
 * 契约锚：《docs/design/webdav-support-design.md》§W1/W3（M1 骨架）
 * 命名空间兼容（§W3）：不依赖固定前缀——统一按 localName 全命名空间匹配
 * （getElementsByTagNameNS('*')），默认命名空间（xmlns="DAV:"）与 d:/D: 前缀形态、
 * 乃至漏声明 xmlns 的非标服务器均可解析。
 * 评审裁决（M1-V1）：href 只做单次逐段解码，不做双重编码二次解码（见 decodeSegment 注释）。
 */
import { ERROR_CODES, SdkError } from '../errorCodes'

/** multistatus <response> 解析结果：相对 key（percent-decoded，目录不带尾斜杠） */
export interface DavEntry {
  key: string
  isDir: boolean
  /** 目录恒 0；文件缺 getcontentlength 时容错为 0 */
  size: number
  /** getlastmodified（HTTP-date）→ epoch ms；缺失/非法省略 */
  lastModified?: number
  etag?: string
}

// ───────────────────────── 纯工具 ─────────────────────────

/** 解析失败（parsererror / 无 multistatus 根）统一错误；detail 携 'multistatus' 便于上游辨识 */
function multistatusError(): SdkError {
  return new SdkError(ERROR_CODES.S3_ERROR, 'WebDAV 207 响应解析失败：缺少 multistatus 根元素', {
    reason: 'multistatus',
  })
}

/** scope 下首个「非空文本」的元素（按 localName 全命名空间匹配；404 propstat 空壳不干扰） */
function firstText(scope: Element | Document, localName: string): string {
  for (const el of Array.from(scope.getElementsByTagNameNS('*', localName))) {
    const text = el.textContent?.trim()
    if (text) return text
  }
  return ''
}

/** scope 的直接子元素中首个非空文本（href 限定直接子级读取，避免嵌套 href 如 lockroot 误取） */
function childText(scope: Element, localName: string): string {
  for (const child of Array.from(scope.children)) {
    if (child.localName !== localName) continue
    const text = child.textContent?.trim()
    if (text) return text
  }
  return ''
}

/** resourcetype 含 <collection> 子元素 → 目录（§W3 判定口径） */
function isCollection(resp: Element): boolean {
  for (const rt of Array.from(resp.getElementsByTagNameNS('*', 'resourcetype'))) {
    if (rt.getElementsByTagNameNS('*', 'collection').length > 0) return true
  }
  return false
}

/** getcontentlength → 数值；缺失/非法容错为 0（DavEntry.size 恒为数值） */
function contentLength(resp: Element): number {
  const n = Number(firstText(resp, 'getcontentlength'))
  return Number.isNaN(n) ? 0 : n
}

/** getlastmodified（HTTP-date，RFC 1123 形态）→ epoch ms；缺失/非法省略 */
function lastModifiedMs(resp: Element): number | undefined {
  const text = firstText(resp, 'getlastmodified')
  if (!text) return undefined
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? undefined : ms
}

/** href 可能是绝对 URI（部分服务器返回 http://host/dav/…）→ 截取 path 部分；其余原样返回 */
function hrefToPath(href: string): string {
  return /^https?:\/\/[^/]*(\/.*)$/i.exec(href)?.[1] ?? href
}

/**
 * 逐段 percent-decode，单次（M1-V1 评审裁决，推翻 M1 初版的双重编码二次解码）：
 * 规范服务器单次编码足够；双重编码属非规范服务器，名字将显示为转义形态（实机批次如实记录，
 * 确有需求 M4 再加家族开关）。不做二次解码的实证：真名 a%20b.txt 的 href=a%2520b.txt，
 * 二次解码会误写成 a b.txt——与同目录真名 a b.txt 撞 key，get/remove 将打错对象。
 * 解码失败（含合法 '%' 的不可解码序列）原样保留。
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** 路径逐段解码，'/' 作分隔符保留 */
function decodePathPerSegment(path: string): string {
  return path.split('/').map(decodeSegment).join('/')
}

// ───────────────────────── 解析入口 ─────────────────────────

/**
 * 解析 207 multistatus → DavEntry 列表。
 * collectionPath 为本次 PROPFIND 的（编码后）请求路径：self 条目（collection 本体）排除，
 * 其余 href 剥离该前缀后逐段解码成相对 key；请求范围外的 href（非标服务器）防御性丢弃。
 */
export function parseMultistatus(xmlText: string, collectionPath: string): DavEntry[] {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw multistatusError()
  if (doc.getElementsByTagNameNS('*', 'multistatus').length === 0) throw multistatusError()

  // 尾斜杠归一（collectionPath 与 href 各自剥除）再比对/剥离，self 判定与目录 key 口径不受影响
  const base = collectionPath.replace(/\/+$/, '')
  const prefix = `${base}/`
  const entries: DavEntry[] = []
  for (const resp of Array.from(doc.getElementsByTagNameNS('*', 'response'))) {
    const href = childText(resp, 'href')
    if (!href) continue
    const path = hrefToPath(href).replace(/\/+$/, '')
    if (path === base) continue // self 条目：collection 本体
    if (!path.startsWith(prefix)) continue // 请求范围外（Depth:1 不应出现，防御性丢弃）
    const key = decodePathPerSegment(path.slice(prefix.length))
    if (!key) continue
    const isDir = isCollection(resp)
    entries.push({
      key,
      isDir,
      size: isDir ? 0 : contentLength(resp),
      lastModified: lastModifiedMs(resp),
      etag: firstText(resp, 'getetag') || undefined,
    })
  }
  return entries
}
