/**
 * CSV/TSV 表格渲染器（内置应用 csv-table 的 renderer，M2-R3）
 * 契约：《docs/product/PRD.md》§一——papaparse 表格化 + 客户端分页；
 * >20MB 不渲染表格，只出提示节点（截断与下载引导由宿主工具条承接）。
 *
 * 数据流：ctx.getObject(key) → Blob.text() → Papa.parse(text,{header:false}) → <table>
 * 状态：getState() 返回 {page}；savedState（renderer 第 4 参）带 page 则恢复定位（越界收敛）。
 * 生命周期：dispose 还原 el 并 abort 全部监听；提示分支只返回 {dispose}。
 * 限额（R2-03）：上限常量与 csv-table spec.maxBytes 同源（apps/builtins.ts CSV_TABLE_MAX_BYTES）——
 * 预览闸取 min(REJECT, maxBytes) 作实际拒绝线后，正常 open 链到不了这里的超限分支（>20MB 在闸上
 * 已被拒、不询问）；本检查保留作防御纵深（插件直调/未来绕闸调用方），文案与闸共用 formatBytes 口径。
 * 观感（R2-13）：网格线/表头底色加粗/行 hover/数字列右对齐——静态样式内联，:hover 伪类以
 * 自包含 <style> 注入 wrapper（styles/ 目录本渲染器不可写，且随 wrapper.remove() 一并清理）。
 */
import * as Papa from 'papaparse'
import { CSV_TABLE_MAX_BYTES } from '../builtins'
import { formatBytes } from '../../files/format'
import type { AppDefinition } from '../../sdk/types'

/** 客户端分页每页数据行数（不含表头行） */
export const CSV_PAGE_SIZE = 100

/** 数字列启发：纯数值/千分位/小数（含负号）右对齐；日期（中置 '-'）与文本不匹配 */
const NUMERIC_RE = /^-?[\d,.]+$/

/** 从 savedState 安全读出页码：仅接受 {page: 有限正数}，其余返回 null（回退第 1 页） */
function readSavedPage(savedState: unknown): number | null {
  if (typeof savedState !== 'object' || savedState === null) return null
  const page = (savedState as { page?: unknown }).page
  if (typeof page !== 'number' || !Number.isFinite(page) || page < 1) return null
  return Math.floor(page)
}

/** 行 hover 伪类规则（内联样式无法表达）：随 wrapper 注入、dispose 随 wrapper 移除 */
const HOVER_CSS = '.mmagic-csv-table tbody tr:hover > td { background: var(--brand-sidebar-hover-bg, rgba(127, 127, 127, 0.12)); }'

/** 竖表单元格（textContent 赋值天然转义，无 XSS 面）。
 *  th=表头（网格线 + 底色 + 加粗）；td=数据（网格线 + 数字列右对齐，R2-13 启发）。 */
function appendCell(row: HTMLElement, text: string, tag: 'td' | 'th'): void {
  const cell = document.createElement(tag)
  cell.textContent = text
  cell.style.border = '1px solid var(--app-section-border-color)'
  cell.style.padding = '4px 8px'
  if (tag === 'th') {
    cell.style.borderBottom = '1px solid var(--app-section-border-color)'
    cell.style.backgroundColor = 'var(--brand-bg-muted, rgba(127, 127, 127, 0.08))'
    cell.style.fontWeight = 'bold'
    cell.style.textAlign = 'left'
  } else if (NUMERIC_RE.test(text)) {
    cell.style.textAlign = 'right'
  }
  row.appendChild(cell)
}

export const csvTableRenderer: AppDefinition['renderer'] = async (el, file, ctx, savedState) => {
  const blob = await ctx.getObject(file.key)
  const text = await blob.text()

  // ── 超阈值：只渲染提示节点（不进 papaparse，防大文本卡死主线程）──
  // 预览闸（preview.ts）已按同一线（min(REJECT, spec.maxBytes)）在上游拒绝并给出下载引导——
  // 走到这里说明调用方绕过了闸（防御纵深，见文件头「限额」注）。
  if (text.length > CSV_TABLE_MAX_BYTES) {
    const tip = document.createElement('div')
    tip.className = 'mmagic-csv-too-large'
    tip.textContent = ctx.t('app.csv-too-large', { limit: formatBytes(CSV_TABLE_MAX_BYTES) })
    el.appendChild(tip)
    return { dispose: () => tip.remove() }
  }

  const { data } = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true })
  const rows = data ?? []
  // 空文件：空态提示（无表头可渲染）
  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'mmagic-csv-empty'
    empty.textContent = ctx.t('app.csv-empty')
    el.appendChild(empty)
    return { dispose: () => empty.remove() }
  }

  // ── 拆表头/数据行：第 1 行恒为表头（header:false 口径），分页只作用于数据行 ──
  const header = rows[0] ?? []
  const dataRows = rows.slice(1)
  const totalPages = Math.max(1, Math.ceil(dataRows.length / CSV_PAGE_SIZE))
  const saved = readSavedPage(savedState)
  let page = Math.min(Math.max(saved ?? 1, 1), totalPages)

  const wrapper = document.createElement('div')
  wrapper.className = 'mmagic-csv'

  const table = document.createElement('table')
  table.className = 'mmagic-csv-table'
  table.style.borderCollapse = 'collapse' // 网格线基座（R2-13）
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const cell of header) appendCell(headRow, cell ?? '', 'th')
  thead.appendChild(headRow)
  const tbody = document.createElement('tbody')
  table.append(thead, tbody)
  wrapper.appendChild(table)
  // 行 hover（R2-13）：<style> 随 wrapper 注入（:hover 伪类无法内联），dispose 随 wrapper 一并移除
  const hoverStyle = document.createElement('style')
  hoverStyle.textContent = HOVER_CSS
  wrapper.appendChild(hoverStyle)

  // ── 分页条：单页不渲染（无多余控件）；按钮锚 data-dir，文本用方向箭头（不依赖词典）──
  let prevBtn: HTMLButtonElement | null = null
  let nextBtn: HTMLButtonElement | null = null
  let indicator: HTMLElement | null = null
  if (totalPages > 1) {
    const pager = document.createElement('div')
    pager.className = 'mmagic-csv-pager'
    prevBtn = document.createElement('button')
    prevBtn.type = 'button'
    prevBtn.dataset.dir = 'prev'
    prevBtn.textContent = '‹'
    prevBtn.title = ctx.t('app.csv-prev')
    nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.dataset.dir = 'next'
    nextBtn.textContent = '›'
    nextBtn.title = ctx.t('app.csv-next')
    indicator = document.createElement('span')
    indicator.className = 'mmagic-csv-page'
    pager.append(prevBtn, indicator, nextBtn)
    wrapper.appendChild(pager)
  }

  const renderPage = (): void => {
    tbody.replaceChildren()
    const start = (page - 1) * CSV_PAGE_SIZE
    for (const row of dataRows.slice(start, start + CSV_PAGE_SIZE)) {
      const tr = document.createElement('tr')
      for (const cell of row) appendCell(tr, cell ?? '', 'td')
      tbody.appendChild(tr)
    }
    if (indicator) indicator.textContent = `${page} / ${totalPages}`
    if (prevBtn) prevBtn.disabled = page <= 1
    if (nextBtn) nextBtn.disabled = page >= totalPages
  }

  const ac = new AbortController()
  prevBtn?.addEventListener(
    'click',
    () => {
      if (page > 1) {
        page--
        renderPage()
      }
    },
    { signal: ac.signal },
  )
  nextBtn?.addEventListener(
    'click',
    () => {
      if (page < totalPages) {
        page++
        renderPage()
      }
    },
    { signal: ac.signal },
  )

  el.appendChild(wrapper)
  renderPage()

  return {
    dispose: () => {
      ac.abort()
      wrapper.remove()
    },
    getState: () => ({ page }),
  }
}
