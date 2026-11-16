/**
 * 脑图 meta 注释通道——解析 / 身份键 / 块重建 / 图片 URL 安全闸（apps/mind 数据面）
 * 契约正本：docs/design/mind-editor-redesign/plan.md §四 + .claude/mind-loop-state.md MC0 契约节
 *
 * 纪律（沿用 flow-editor-design.md §三，零新造）：
 *  - 行匹配正则=import flow-model.ts META_RE（MC0-V P2-3 裁决：同一字面单一正本，禁双处维护；
 *    语义：行首缩进 / %% 与 meta: 间多空格 / body 可选）
 *  - 非法 JSON 行忽略不抛：告警 + 该行丢弃，其余行不受影响；载荷字段校验同口径
 *    （MC0-V P2-4：mindview.layout/theme 非 string 丢该字段、schema 值非法（非 string/空）丢、
 *    assoc.lines 元素非 {from,to,text?} 形态丢该元素——一律丢弃+console.warn 不抛）
 *  - 单行护栏：任一行 UTF-8 字节 > MAX_META_LINE_BYTES(8192) 抛 RangeError（调用方告警拒收）；
 *    字节经 TextEncoder 计——按字符数计会漏放 CJK（3000 汉字=9000 字节）
 *  - 图片只收 URL 不收 base64（data: 超限即毁图，直接禁入——isSafeImageUrl）
 *
 * 身份键（buildNodeKey）= 祖先文本链路径（无兄弟序号，MC0-T 裁决 3）：段内转义域扩展
 * （MC0-V P1-1 裁决：`\`→`\\`、`/`→`\/`、空格→`\s`、Tab→`\t`、换行→`\n`、CR→`\r`，
 * 先备份后逐项保双射）后以 `/` join——与多段路径可区分；兄弟重排键不变。
 * 保留键隔离（P2-1）：首段以 `_`/`schema` 开头时首字符前加 `\`（`\_mindview`/`\schema=v1`）→
 * 落 nodeMeta 不被通道劫持。parse 侧零改动（META_RE `\S+` 天然收编）。
 */
import { META_RE } from '../flow-model'

// ───────────────────────── 类型（全通道契约，plan.md §四 表格） ─────────────────────────

/** _mindview 视图态伪节点载荷——布局/主题本质是视图属性，存 meta 零数据风险（对应流程图 _layout） */
export interface MindViewMeta {
  layout?: string
  theme?: string
}

/** _assoc 关联线伪节点载荷——跨节点数据不挂单节点，走伪节点 */
export interface AssocMeta {
  lines: Array<{ from: string; to: string; text?: string }>
}

/** mindmap meta 全通道解析结果 */
export interface MindMeta {
  /** `%% meta: schema=v1` 的版本值（无行=null）。MC0-T 裁决 1：存值 'v1' 非整 token 'schema=v1' */
  schema: string | null
  mindview: MindViewMeta | null
  assoc: AssocMeta | null
  /** 节点行：身份键 → 节点超集数据（note/image/hyperlink/tags/generalization/style） */
  nodeMeta: Map<string, Record<string, unknown>>
}

// ───────────────────────── 解析 ─────────────────────────

/** 单行护栏上限（8KB，TextEncoder UTF-8 字节计） */
export const MAX_META_LINE_BYTES = 8192

/** 关联线元素形态闸（MC0-V P2-4）：须 `{from:string,to:string,text?:string}`——from/to 必为
 *  string，text 缺省放行、在场须 string；标量/数组/缺 from/to 一律不收（丢该元素口径） */
function isAssocLine(el: unknown): el is { from: string; to: string; text?: string } {
  if (el === null || typeof el !== 'object' || Array.isArray(el)) return false
  const o = el as Record<string, unknown>
  return (
    typeof o.from === 'string' &&
    typeof o.to === 'string' &&
    (o.text === undefined || typeof o.text === 'string')
  )
}

/** 解析 mindmap 源文本中的 meta 全通道（正文行不进任何通道；永不失败）。
 *  载荷字段级校验（MC0-V P2-4 裁决）：mindview.layout/theme 非 string 丢该字段（其余字段
 *  保留）、schema 值非法（非 string 或空）丢、assoc.lines 元素非形态丢该元素——
 *  一律丢弃+console.warn 不抛 */
export function parseMindMeta(text: string): MindMeta {
  const meta: MindMeta = { schema: null, mindview: null, assoc: null, nodeMeta: new Map() }
  text.split('\n').forEach((line, i) => {
    const m = META_RE.exec(line)
    if (!m) return
    const key = m[1] ?? '' // 捕获组必参与匹配，兜底不可达（noUncheckedIndexedAccess 窄化）
    const body = (m[2] ?? '').trim()
    if (key.startsWith('schema=')) {
      const v: unknown = key.slice('schema='.length)
      // P2-4：schema 值非法丢（非 string 防御钉 + 空值 `schema=` 无版本语义同非法）——warn 不抛
      if (typeof v === 'string' && v !== '') meta.schema = v
      else console.warn(`[mind/meta] schema 值非法，已丢弃（line ${i + 1}）`)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body || '{}') // body 可选（META_RE 口径同 flow-model）：无体=空对象
    } catch {
      // 非法 JSON：该行丢弃 + 告警（同 flow-model 口径），其余行不受影响
      console.warn(`[mind/meta] meta 行 JSON 非法，已忽略（line ${i + 1}）`)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // 合法 JSON 但非对象形态（标量/数组）：进不了任何通道的类型谎言，按非法行同口径丢弃
      console.warn(`[mind/meta] meta 行 JSON 非对象形态，已忽略（line ${i + 1}）`)
      return
    }
    const obj = parsed as Record<string, unknown>
    if (key === '_mindview') {
      // P2-4：layout/theme 非 string 丢该字段（其余字段保留不丢行）
      const view = { ...obj }
      for (const f of ['layout', 'theme'] as const) {
        const v = view[f]
        if (v !== undefined && typeof v !== 'string') {
          delete view[f]
          console.warn(`[mind/meta] _mindview.${f} 非 string，已丢该字段（line ${i + 1}）`)
        }
      }
      meta.mindview = view as MindViewMeta
    } else if (key === '_assoc') {
      if (!Array.isArray(obj.lines)) {
        // _assoc 载荷须含 lines 数组（plan.md §四 表格）；缺结构=非法行同口径丢弃
        console.warn(`[mind/meta] _assoc 行缺 lines 数组，已忽略（line ${i + 1}）`)
        return
      }
      // P2-4：元素非 {from,to,text?} 形态丢该元素（整行不丢，其余元素不受影响）
      const lines: AssocMeta['lines'] = []
      for (const el of obj.lines) {
        if (isAssocLine(el)) {
          const line: AssocMeta['lines'][number] = { from: el.from, to: el.to }
          if (el.text !== undefined) line.text = el.text
          lines.push(line)
        } else {
          console.warn(`[mind/meta] _assoc.lines 元素形态非法，已丢该元素（line ${i + 1}）`)
        }
      }
      meta.assoc = { lines }
    } else meta.nodeMeta.set(key, obj)
  })
  return meta
}

// ───────────────────────── 身份键 ─────────────────────────

/** 身份键（文本+路径，无歧义）：段内转义域扩展（MC0-V P1-1 裁决，先备份后逐项保双射——
 *  转义恒为字面两字符序列，与文本 `\\s`（`\\`+s）可区分）：`\`→`\\`、`/`→`\/`、空格→`\s`、
 *  Tab→`\t`、换行→`\n`、CR→`\r`；转义后以 `/` join（与多段路径可区分；兄弟重排键不变）。
 *  保留键隔离（P2-1）：首段以 `_`/`schema` 开头时首字符前加 `\`（`\_mindview`/`\schema=v1`）→
 *  落 nodeMeta 不被通道劫持。parse 侧零改动：META_RE `\S+` 天然收编，write→parse 往返不丢 */
export function buildNodeKey(path: string[]): string {
  const escaped = path.map((seg) =>
    seg
      .replace(/\\/g, '\\\\') // 先备份 `\`，再逐项替换（保双射）
      .replace(/\//g, '\\/')
      .replace(/ /g, '\\s')
      .replace(/\t/g, '\\t')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r'),
  )
  const head = escaped[0]
  if (head !== undefined && (head.startsWith('_') || head.startsWith('schema'))) {
    escaped[0] = `\\${head}` // 保留键隔离：首字符前加 `\`
  }
  return escaped.join('/')
}

// ───────────────────────── 块重建（parseMindMeta 的逆，往返等价） ─────────────────────────

/** 重建 meta 块行：schema → _mindview → _assoc → 节点行（按 Map 插入序）；全单行 JSON
 *  （JSON.stringify 天然单行，真实换行转义为字面 `\n` 序列）；空缺省字段不出行（全空 → []）。
 *  节点键经 buildNodeKey 转义域+保留键隔离保证：键段无裸空白/换行（空白→字面 `\s` 等两字符
 *  序列），天然匹配 META_RE `\S+` 且单行安全（P1-1 裁决：write→parse 往返零丢数据）。
 *  任一行 UTF-8 字节 > MAX_META_LINE_BYTES 抛 RangeError（调用方告警拒收） */
export function writeMetaBlock(meta: MindMeta): string[] {
  const lines: string[] = []
  if (meta.schema !== null) lines.push(`%% meta: schema=${meta.schema}`)
  if (meta.mindview !== null) lines.push(`%% meta: _mindview ${JSON.stringify(meta.mindview)}`)
  if (meta.assoc !== null) lines.push(`%% meta: _assoc ${JSON.stringify(meta.assoc)}`)
  for (const [key, data] of meta.nodeMeta) {
    lines.push(`%% meta: ${key} ${JSON.stringify(data)}`)
  }
  const encoder = new TextEncoder()
  for (const line of lines) {
    if (encoder.encode(line).byteLength > MAX_META_LINE_BYTES) {
      throw new RangeError(`[mind/meta] meta 行超 ${MAX_META_LINE_BYTES} 字节单行护栏，拒收`)
    }
  }
  return lines
}

// ───────────────────────── 图片 URL 安全闸 ─────────────────────────

/** 图片 URL 安全闸：仅 http(s) 绝对地址与相对路径放行；data:/blob:/javascript:/file:/
 *  协议相对 `//` 与其它协议一律拒绝（base64 data URL 超 8KB 护栏即毁图，禁入） */
export function isSafeImageUrl(u: string): boolean {
  const t = u.trim()
  if (t === '') return false
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(t)
  if (scheme) return /^https?$/i.test(scheme[1] ?? '') // 捕获组必参与匹配，兜底不可达
  return !t.startsWith('//') // 无协议：相对路径放行；协议相对（//host）拒
}
