/**
 * xlsx/xls 渲染器（内置应用 xlsx-viewer，B 方案保真升级 2026-10-21）
 * 契约：《docs/product/PRD.md》§一（xlsx-viewer 行，多 sheet 切换）+
 *       《docs/design/plugin-system.md》V1.1 §二 ctx 能力面（凭证不出、字节流进出）。
 * 双引擎分流：
 *   .xlsx → ExcelJS（4.4.0）读**样式**（底色/字色/粗斜/字号/边框/对齐/合并/列宽/行高）自研
 *           HTML 表格渲染（保真度「中」——SheetJS sheet_to_html 是纯数据网格，样式全丢）；
 *   .xls  → SheetJS 旧链保留（ExcelJS 不支持 BIFF 旧格式）——纯数据网格降级可接受
 *           （旧格式文件的样式诉求低频；完整保真走 Univer 插件，右键打开方式）。
 * 安全红线：单元格文本一律 textContent 呈现（零 innerHTML 拼接）；sheet 名同。旧链的
 *           sheet_to_html innerHTML + 剥属性口径原样保留（xls 路径）。
 * 大表防护：xlsx 路径行数截断（RENDER_ROW_LIMIT，超限渲染前 N 行 + 截断提示行）。
 * 状态：getState()={sheet}（当前 sheet 下标）；savedState（第 4 参）带 sheet 则恢复（越界收敛）。
 * 生命周期：dispose=abort 监听 + 清空容器；getObject/解析失败→错误提示节点、空工作簿→空态
 * 提示节点，两者只返回 {dispose}，不向调用侧抛出。
 */
import type { WorkBook, WorkSheet } from 'xlsx'
import type { Worksheet, Cell as ExcelCell } from 'exceljs'
import type { AppCtx, AppDefinition } from '../../sdk/types'
import { buildMergeIndex, borderCss, cellValueText, colWidthPx, colorToCss, rowHeightPx } from './xlsxStyle'

/** i18n key：加载/解析失败 / 空工作簿 / 大表截断提示 */
const LOAD_FAIL_KEY = 'app.xlsx-load-fail'
const EMPTY_KEY = 'app.xlsx-empty'
const TRUNCATED_KEY = 'app.xlsx-truncated'

/** xlsx 路径渲染行数上限（全样式 DOM 渲染的体积护栏；超限截断+提示） */
const RENDER_ROW_LIMIT = 2000

/** 表格基础样式（挂 <style>，随容器 dispose 移除；取色走宿主 token） */
const VIEW_CSS = `
.xlsx-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.xlsx-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; border-bottom: 1px solid var(--app-separator, rgba(127,127,127,.18)); background: var(--app-bg-card, #fff); }
.xlsx-tab { padding: 4px 12px; border: 1px solid transparent; border-radius: var(--app-radius-button, 6px); background: var(--app-bg-card, #fff); color: var(--app-text-secondary); font-size: 12px; cursor: pointer; }
.xlsx-tab:hover { background: var(--app-bg-muted); color: var(--app-text-primary); }
.xlsx-tab--active { border-color: var(--app-primary, #409eff); color: var(--app-primary, #409eff); font-weight: 600; }
.xlsx-sheet { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px; background: var(--app-bg-page, #f2f3f5); }
.xlsx-table { border-collapse: collapse; background: var(--app-bg-card, #fff); }
.xlsx-table td, .xlsx-table th { padding: 2px 6px; min-width: 40px; font-size: 12px; white-space: nowrap; text-align: left; vertical-align: middle; color: var(--app-text-primary, #333); border: 1px solid var(--app-separator, rgba(127,127,127,.22)); }
.xlsx-truncated { padding: 8px; color: var(--app-text-secondary, #888); font-size: 12px; }
`

/** 从 savedState 安全读出 sheet 下标：仅接受 {sheet: 非负整数}，其余返回 null（回退第 1 个） */
function readSavedSheet(savedState: unknown): number | null {
  if (typeof savedState !== 'object' || savedState === null) return null
  const sheet = (savedState as { sheet?: unknown }).sheet
  if (typeof sheet !== 'number' || !Number.isInteger(sheet) || sheet < 0) return null
  return sheet
}

/** 提示节点（文案走宿主词典；样式对齐 pdf/csv 渲染器口径） */
function buildTip(ctx: AppCtx, key: string, className: string, params?: Record<string, unknown>): HTMLDivElement {
  const tip = document.createElement('div')
  tip.className = className
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = ctx.t(key, params)
  return tip
}

/** 剥除 sheet 区内全部属性（xls 旧链 SheetJS 欠转义 data-v 的防线），只保结构 */
function stripAttributes(root: HTMLElement): void {
  for (const node of root.querySelectorAll('*')) {
    for (const attr of Array.from(node.attributes)) node.removeAttribute(attr.name)
  }
}

// ───────────────────────── ExcelJS 路径（.xlsx：样式渲染） ─────────────────────────

/** 单元格样式 → cssText 片段（填充/字体/边框/对齐）；无样式返回 '' */
function cellCss(cell: ExcelCell | undefined): string {
  if (!cell || !cell.style || typeof cell.style !== 'object') return ''
  const s = cell.style as {
    fill?: { type?: string; pattern?: string; fgColor?: Parameters<typeof colorToCss>[0] }
    font?: {
      bold?: boolean
      italic?: boolean
      size?: number
      name?: string
      strike?: boolean
      underline?: boolean | string
      color?: Parameters<typeof colorToCss>[0]
    }
    border?: Record<'top' | 'bottom' | 'left' | 'right', Parameters<typeof borderCss>[0]>
    alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean }
  }
  const parts: string[] = []
  if (s.fill?.type === 'pattern' && s.fill.pattern === 'solid') {
    const bg = colorToCss(s.fill.fgColor)
    if (bg) parts.push(`background:${bg}`)
  }
  if (s.font) {
    if (s.font.bold) parts.push('font-weight:600')
    if (s.font.italic) parts.push('font-style:italic')
    if (typeof s.font.size === 'number') parts.push(`font-size:${Math.min(28, Math.max(8, Math.round(s.font.size)))}px`)
    if (typeof s.font.name === 'string' && s.font.name) parts.push(`font-family:${s.font.name.includes(' ') ? `'${s.font.name}'` : s.font.name}`)
    if (s.font.strike) parts.push('text-decoration:line-through')
    else if (s.font.underline) parts.push('text-decoration:underline')
    const fc = colorToCss(s.font.color)
    if (fc) parts.push(`color:${fc}`)
  }
  if (s.border) {
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const b = borderCss(s.border[side])
      if (b) parts.push(`border-${side}:${b}`)
    }
  }
  if (s.alignment) {
    const h = { left: 'left', center: 'center', right: 'right', justify: 'justify' }[s.alignment.horizontal ?? ''] as string | undefined
    if (h) parts.push(`text-align:${h}`)
    const v = { top: 'top', middle: 'middle', bottom: 'bottom' }[s.alignment.vertical ?? ''] as string | undefined
    if (v) parts.push(`vertical-align:${v}`)
    if (s.alignment.wrapText) parts.push('white-space:pre-wrap')
  }
  return parts.join(';')
}

/** 单 sheet → 表格 DOM（样式还原核心；文本全 textContent，零 innerHTML） */
function buildExcelSheetTable(ws: Worksheet, ctx: AppCtx): { table: HTMLTableElement; truncated: boolean } {
  const table = document.createElement('table')
  table.className = 'xlsx-table'

  const rowCount = Math.min(ws.rowCount ?? 0, RENDER_ROW_LIMIT)
  const colCount = ws.columnCount ?? 0
  const truncated = (ws.rowCount ?? 0) > RENDER_ROW_LIMIT

  // 列宽（字符单位 → px）
  if (colCount > 0) {
    const colgroup = document.createElement('colgroup')
    for (let c = 1; c <= colCount; c++) {
      const col = document.createElement('col')
      const w = colWidthPx(ws.getColumn(c)?.width)
      if (w) col.style.width = `${w}px`
      colgroup.appendChild(col)
    }
    table.appendChild(colgroup)
  }

  const merges = buildMergeIndex((ws.model?.merges ?? []) as string[])

  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r)
    const tr = document.createElement('tr')
    const h = rowHeightPx(row.height)
    if (h) tr.style.height = `${h}px`
    for (let c = 1; c <= colCount; c++) {
      const key = `${r - 1}:${c - 1}`
      if (merges.skipped.has(key)) continue // 合并区从格：不生成 td
      const cell = row.getCell(c)
      const td = document.createElement('td')
      const text = cellValueText(cell.value)
      if (text !== '') td.textContent = text
      const span = merges.spans.get(key)
      if (span) {
        if (span.colSpan > 1) td.colSpan = span.colSpan
        if (span.rowSpan > 1) td.rowSpan = span.rowSpan
      }
      const css = cellCss(cell)
      if (css) td.style.cssText = css
      tr.appendChild(td)
    }
    table.appendChild(tr)
  }
  if (truncated) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.className = 'xlsx-truncated'
    td.colSpan = Math.max(1, colCount)
    td.textContent = ctx.t(TRUNCATED_KEY, { limit: String(RENDER_ROW_LIMIT) })
    tr.appendChild(td)
    table.appendChild(tr)
  }
  return { table, truncated }
}

// ───────────────────────── 渲染器入口（分流 + 公共骨架） ─────────────────────────

export const xlsxRenderer: AppDefinition['renderer'] = async (el, file, ctx, savedState) => {
  const isLegacyXls = /\.xls$/i.test(file.name)

  // 骨架：tabs 行 + sheet 滚动区（两引擎共用；样式表随骨架挂载）
  const wrapper = document.createElement('div')
  wrapper.className = 'xlsx-view'
  const styleEl = document.createElement('style')
  styleEl.textContent = VIEW_CSS
  const tabsRow = document.createElement('div')
  tabsRow.className = 'xlsx-tabs'
  const sheetArea = document.createElement('div')
  sheetArea.className = 'xlsx-sheet'
  wrapper.append(styleEl, tabsRow, sheetArea)
  const tabs: HTMLButtonElement[] = []
  const ac = new AbortController()
  let current = 0
  let sheetCount = 0

  /** tab 行重刷（active 态） */
  const syncTabs = (): void => {
    for (let i = 0; i < tabs.length; i++) {
      tabs[i]!.classList.toggle('xlsx-tab--active', i === current)
      tabs[i]!.setAttribute('aria-selected', String(i === current))
    }
  }

  // ── .xlsx：ExcelJS 样式路径 ──
  if (!isLegacyXls) {
    let wb: import('exceljs').Workbook | undefined
    try {
      const blob = await ctx.getObject(file.key)
      const data = await blob.arrayBuffer()
      const ExcelJS = await import('exceljs')
      wb = new ExcelJS.Workbook()
      await wb.xlsx.load(data)
    } catch {
      const tip = buildTip(ctx, LOAD_FAIL_KEY, 'xlsx-load-fail')
      el.replaceChildren(tip)
      return { dispose: () => tip.remove() }
    }
    const sheets = wb.worksheets
    if (sheets.length === 0) {
      const tip = buildTip(ctx, EMPTY_KEY, 'xlsx-empty')
      el.replaceChildren(tip)
      return { dispose: () => tip.remove() }
    }
    sheetCount = sheets.length
    current = Math.min(readSavedSheet(savedState) ?? 0, sheetCount - 1)

    const renderSheet = (): void => {
      sheetArea.replaceChildren(buildExcelSheetTable(sheets[current]!, ctx).table)
      syncTabs()
    }
    sheets.forEach((ws, i) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'xlsx-tab'
      btn.dataset.sheet = String(i)
      btn.textContent = ws.name // sheet 名按文本呈现
      btn.addEventListener('click', () => {
        if (current !== i) {
          current = i
          renderSheet()
        }
      }, { signal: ac.signal })
      tabsRow.appendChild(btn)
      tabs.push(btn)
    })
    el.replaceChildren(wrapper)
    renderSheet()
  } else {
    // ── .xls：SheetJS 旧链（ExcelJS 不支持 BIFF；纯数据网格降级）──
    let wb: WorkBook | undefined
    let XLSX: typeof import('xlsx') | undefined
    try {
      const blob = await ctx.getObject(file.key)
      const data = await blob.arrayBuffer()
      XLSX = await import('xlsx')
      wb = XLSX.read(data, { type: 'array' })
    } catch {
      const tip = buildTip(ctx, LOAD_FAIL_KEY, 'xlsx-load-fail')
      el.replaceChildren(tip)
      return { dispose: () => tip.remove() }
    }
    const names = wb.SheetNames
    if (names.length === 0) {
      const tip = buildTip(ctx, EMPTY_KEY, 'xlsx-empty')
      el.replaceChildren(tip)
      return { dispose: () => tip.remove() }
    }
    sheetCount = names.length
    current = Math.min(readSavedSheet(savedState) ?? 0, sheetCount - 1)

    const renderSheet = (): void => {
      const sheet: WorkSheet | undefined = wb?.Sheets[names[current] ?? '']
      sheetArea.innerHTML = sheet ? XLSX!.utils.sheet_to_html(sheet) : ''
      const table = sheetArea.querySelector('table')
      if (table) {
        // sheet_to_html 产出整段文档串：只保留 table，弃 head/meta/title，再剥属性（安全防线）
        sheetArea.replaceChildren(table)
        stripAttributes(sheetArea)
        table.className = 'xlsx-table'
      }
      syncTabs()
    }
    names.forEach((name, i) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'xlsx-tab'
      btn.dataset.sheet = String(i)
      btn.textContent = name
      btn.addEventListener('click', () => {
        if (current !== i) {
          current = i
          renderSheet()
        }
      }, { signal: ac.signal })
      tabsRow.appendChild(btn)
      tabs.push(btn)
    })
    el.replaceChildren(wrapper)
    renderSheet()
  }

  return {
    dispose: () => {
      ac.abort()
      wrapper.remove()
      styleEl.remove()
    },
    getState: () => ({ sheet: current }),
  }
}
