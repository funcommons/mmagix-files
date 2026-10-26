/**
 * 渲染装配（方案 §二/§三/§四）：三态状态机（源码 CM6 / 可视 Tiptap / 预览沙箱）
 * - 布局（防 stage 尺寸塌陷，md 插件同口径）：el 注入 relative，root absolute inset:0
 * - 三态单实例互斥：source CM6 常驻（权威文本载体）；wysiwyg 进态创建/离态销毁（HTML 字符串交接）；
 *   preview 按需 srcdoc（只读，不动编辑内容）
 * - 单体化：open pass（外链→base64，script[src] 内联保语义）+ save pass（inline 兜底 + strip 漏网）
 * - 保存链：幂等（非 dirty/在途直接返回）+ Ctrl/Cmd+S + 未保存确认（3s 强制放行竞态，md 同款）
 * - 统一编辑钮簇（一百四十三番）：保存红点（「未保存」文字徽标废弃；徽标仅剩错误/警告文案通道）｜
 *   撤销 重做（按活动形态分流：source=CM 命令 / wysiwyg=Tiptap）｜重置=恢复打开时内容；
 *   预览态只读→整簇隐藏
 * - 预览跳转代理：message（校验 event.source===iframe）→ 确认条 → window.open(_blank,noopener)
 * - savedState：{ mode }；切 tab 回来恢复形态
 * 样式钉在 .mm-html-* 命名空间（多实例零串扰）。
 */
import { inlineAssets, stripExternalAssets } from './inline'
import { isHtmlMode, resolveInitialMode, writeStoredMode } from './options'
import { buildPreviewDoc, normalizeOpenUrl, parseOpenRequest, PREVIEW_SANDBOX } from './sandbox'
import { createSourceEditor, type SourceHandle } from './source'
import { createWysiwyg, type WysiwygHandle } from './wysiwyg'
import { createEditToolbar } from '../../../src/shared/editToolbar'
import type { HostCtx, HostFile, HostInstance, HtmlEditorOptions, HtmlMode } from './types'

const MODES: { key: HtmlMode; tKey: string; icon: string }[] = [
  { key: 'source', tKey: 'app.html-mode-source', icon: '<path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/>' },
  { key: 'wysiwyg', tKey: 'app.html-mode-wysiwyg', icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>' },
  { key: 'preview', tKey: 'app.html-mode-preview', icon: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/>' },
]
/** 可视工具栏图标（内联 SVG path 片段，24×24 stroke 口径同 svgIcon；全字面量，无用户数据拼入） */
const ICONS = {
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
  bold: '<path d="M6 4h8a4 4 0 0 1 0 8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  color: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alignLeft: '<line x1="21" x2="3" y1="6" y2="6"/><line x1="15" x2="3" y1="12" y2="12"/><line x1="17" x2="3" y1="18" y2="18"/>',
  alignCenter: '<line x1="21" x2="3" y1="6" y2="6"/><line x1="17" x2="7" y1="12" y2="12"/><line x1="19" x2="5" y1="18" y2="18"/>',
  alignRight: '<line x1="21" x2="3" y1="6" y2="6"/><line x1="19" x2="5" y1="12" y2="12"/><line x1="17" x2="7" y1="18" y2="18"/>',
  alignJustify: '<line x1="21" x2="3" y1="6" y2="6"/><line x1="21" x2="3" y1="12" y2="12"/><line x1="21" x2="3" y1="18" y2="18"/>',
  ul: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
  ol: '<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  task: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  quote: '<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v7a3 3 0 0 1-3 3"/><path d="M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v7a3 3 0 0 1-3 3"/>',
  codeBlock: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  hr: '<line x1="3" x2="21" y1="12" y2="12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  unlink: '<path d="M18.84 12.25l1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  imageWidth: '<polyline points="18 8 22 12 18 16"/><polyline points="6 8 2 12 6 16"/><line x1="2" x2="22" y1="12" y2="12"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  rowAdd: '<path d="M3 5h18"/><path d="M3 19h18"/><path d="M12 9v6"/><path d="M9 12h6"/>',
  colAdd: '<path d="M5 3v18"/><path d="M19 3v18"/><path d="M9 12h6"/><path d="M12 9v6"/>',
  rowDel: '<path d="M3 5h18"/><path d="M3 19h18"/><path d="M9 12h6"/>',
  colDel: '<path d="M5 3v18"/><path d="M19 3v18"/><path d="M12 9v6"/>',
  merge: '<path d="M4 12h16"/><path d="m8 8 4 4 4-4"/><path d="m8 16 4-4 4 4"/>',
  split: '<path d="M4 12h16"/><path d="m8 4 4 4 4-4"/><path d="m8 20 4-4 4 4"/>',
  header: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 9v12"/><path d="M15 9v12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  find: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
}

/** 会话级「不再询问」域名表（模块级：同页多实例共享；不持久化——方案 §4.2） */
const trustedOrigins = new Set<string>()
/** wysiwyg→source 重排提示（用户勾选不再提示后会话内跳过） */
let rewriteNoticeDismissed = false

let styleInjected = false
/** 插件级样式：全部钉在 .mm-html-* 命名空间（同类多实例共享同一份——样式恒等，无串扰面） */
function ensureStyles(): void {
  if (styleInjected) return
  styleInjected = true
  const style = document.createElement('style')
  style.textContent = `
.mm-html-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#fff;color:#1f2328;font-size:14px}
.mm-html-toolbar{display:flex;align-items:center;gap:8px;flex:none;padding:6px 10px;border-bottom:1px solid #e5e7eb;background:#fafafa;flex-wrap:wrap}
.mm-html-modes{display:flex;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}
.mm-html-modes button{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:none;background:transparent;color:#57606a;cursor:pointer;font-size:12px}
.mm-html-modes button[data-active="true"]{background:#eaeef2;color:#1f2328;font-weight:600}
.mm-html-badge{font-size:12px;color:#b88230;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mm-html-badge.is-warn{color:#d54941}
.mm-html-wysiwyg-bar{display:flex;align-items:center;gap:2px;flex:none;min-height:26px;padding:2px 6px;border-bottom:1px solid var(--app-separator,rgba(127,127,127,.18));background:transparent;flex-wrap:wrap}
.mm-html-wysiwyg-bar button{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 3px;border:none;border-radius:var(--app-radius-button,6px);background:transparent;color:var(--app-text-secondary,#57606a);cursor:pointer;font-size:14px;line-height:1;transition:background .15s,color .15s}
.mm-html-wysiwyg-bar button:hover{background:var(--app-bg-muted,#eaeef2);color:var(--app-text-primary,#1f2328)}
.mm-html-wysiwyg-bar button[data-active="true"]{background:#dbeafe;color:#1d4ed8}
.mm-html-wysiwyg-bar button.is-text{font-size:12px;font-weight:600;letter-spacing:.02em;padding:0 5px}
.mm-html-wysiwyg-bar button svg{display:block}
.mm-html-wysiwyg-group{display:inline-flex;align-items:center;gap:2px}
.mm-html-views{flex:1;min-height:0;position:relative}
.mm-html-pane{position:absolute;inset:0;display:none;overflow:auto}
.mm-html-pane[data-active="true"]{display:block}
.mm-html-pane .cm-editor{height:100%}
.mm-html-pane .cm-scroller{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.mm-html-wysiwyg .tiptap{outline:none;min-height:100%;padding:24px 32px;box-sizing:border-box;line-height:1.65}
.mm-html-wysiwyg .tiptap p:first-child{margin-top:0}
.mm-html-wysiwyg .tiptap img{max-width:100%;height:auto}
.mm-html-wysiwyg .tiptap table{border-collapse:collapse;width:100%}
.mm-html-wysiwyg .tiptap th,.mm-html-wysiwyg .tiptap td{border:1px solid #d0d7de;padding:6px 10px}
.mm-html-wysiwyg .tiptap th{background:#f6f8fa}
.mm-html-wysiwyg .tiptap pre{background:#f6f8fa;border-radius:6px;padding:12px}
.mm-html-wysiwyg .tiptap blockquote{border-left:3px solid #d0d7de;margin-left:0;padding-left:14px;color:#57606a}
.mm-html-preview iframe{width:100%;height:100%;border:none;background:#fff;display:block}
.mm-html-confirm{display:none;position:absolute;left:0;right:0;bottom:0;z-index:10;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid #d0d7de;background:#fffdf5;box-shadow:0 -2px 8px rgba(0,0,0,.06);font-size:12px;color:#1f2328}
.mm-html-confirm[data-active="true"]{display:flex}
.mm-html-confirm .mm-html-confirm-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#57606a}
.mm-html-confirm button{padding:3px 10px;border:1px solid #d0d7de;border-radius:5px;background:#fff;color:#1f2328;cursor:pointer;font-size:12px}
.mm-html-confirm button.is-primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
.mm-html-confirm label{display:inline-flex;align-items:center;gap:4px;color:#57606a;cursor:pointer;white-space:nowrap}
.mm-html-wysiwyg-sep{width:1px;height:14px;background:var(--app-separator,rgba(127,127,127,.18));margin:0 4px;flex:none}
.mm-html-wysiwyg-bar select{height:20px;max-width:96px;margin:0 2px;padding:0 2px;border:1px solid var(--app-separator,rgba(127,127,127,.18));border-radius:var(--app-radius-button,6px);background:transparent;color:var(--app-text-secondary,#57606a);font-size:12px;cursor:pointer}
.mm-html-wysiwyg-bar select:hover{background:var(--app-bg-muted,#eaeef2);color:var(--app-text-primary,#1f2328)}
.mm-html-wysiwyg-bar input[type=color]{width:22px;height:22px;margin:0 2px;padding:0;border:1px solid var(--app-separator,rgba(127,127,127,.18));border-radius:var(--app-radius-button,6px);background:transparent;cursor:pointer}
.mm-html-wysiwyg .tiptap ul[data-type="taskList"]{list-style:none;padding-left:4px}
.mm-html-wysiwyg .tiptap ul[data-type="taskList"] li{display:flex;gap:6px}
.mm-html-wysiwyg .tiptap ul[data-type="taskList"] li>label{flex:none;margin-top:4px}
.mm-html-wysiwyg .tiptap ul[data-type="taskList"] li>div{flex:1;min-width:0}
.mm-html-findbar{display:none;flex:none;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid #e5e7eb;background:#f6f8fa;font-size:12px;flex-wrap:wrap}
.mm-html-findbar[data-active="true"]{display:flex}
.mm-html-findbar input{border:1px solid #d0d7de;border-radius:4px;padding:3px 6px;font-size:12px;width:130px}
.mm-html-findbar .mm-html-find-count{color:#57606a;min-width:48px;text-align:center}
.mm-html-findbar button{padding:3px 8px;border:1px solid #d0d7de;border-radius:4px;background:#fff;cursor:pointer;font-size:12px}
`
  document.head.appendChild(style)
}

function svgIcon(inner: string): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('width', '14')
  el.setAttribute('height', '14')
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', '2')
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  el.innerHTML = inner
  return el
}

/** 片段 → 完整文档骨架（保存/预览统一载体） */
function wrapFragment(bodyHtml: string, title: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title.replace(/[<>&]/g, '')}</title></head>\n<body>\n${bodyHtml}\n</body></html>`
}

export function renderTooLargeTip(el: HTMLElement, ctx: HostCtx, limitText: string): HostInstance {
  const tip = document.createElement('div')
  tip.style.cssText = 'padding:16px;font-size:13px;color:#888'
  tip.textContent = ctx.t('app.html-too-large', { limit: limitText })
  el.appendChild(tip)
  return { dispose: () => tip.remove() }
}

export async function renderEditor(
  el: HTMLElement,
  file: HostFile,
  ctx: HostCtx,
  options: HtmlEditorOptions,
  rawText: string,
  savedState?: unknown,
): Promise<HostInstance> {
  ensureStyles()
  el.style.position = 'relative'
  const saved = (savedState ?? {}) as { mode?: unknown }

  // ── 打开 pass（方案 §3.1）：外链资源 → base64 内联（script[src] 内联保源码语义）──
  // 完整文档保留 head（内联后的 style 等）；片段取 body 内联结果为编辑文本
  let isFullDoc = /<!doctype\s+html|<html[\s>]/i.test(rawText)
  const inlineWarn: string[] = []
  let sourceText: string
  {
    const parsed = new DOMParser().parseFromString(rawText, 'text/html')
    isFullDoc = isFullDoc && !!parsed.querySelector('html')
    const report = await inlineAssets(parsed, { inlineScripts: true })
    inlineWarn.push(...report.failed.slice(0, 20))
    sourceText = isFullDoc
      ? '<!doctype html>\n' + parsed.documentElement.outerHTML
      : parsed.body.innerHTML
  }

  // ── DOM 骨架 ──
  const root = document.createElement('div')
  root.className = 'mm-html-root'
  const toolbar = document.createElement('div')
  toolbar.className = 'mm-html-toolbar'
  const modesEl = document.createElement('div')
  modesEl.className = 'mm-html-modes'
  // 统一编辑钮簇（一百四十三番：保存红点｜撤销 重做 重置——样式唯源 shared/editToolbar，构建期内联）。
  // undo/redo 按活动形态分流（source=CM 命令 / wysiwyg=Tiptap 命令）；preview 只读→整簇隐藏（setReadonly）
  const toolbarCtl = createEditToolbar(
    { save: ctx.t('app.edt-save'), undo: ctx.t('app.edt-undo'), redo: ctx.t('app.edt-redo'), reset: ctx.t('app.edt-reset') },
    {
      onSave: () => void save(),
      onUndo: () => {
        if (mode === 'wysiwyg') wysiwyg?.undo()
        else source?.undo()
      },
      onRedo: () => {
        if (mode === 'wysiwyg') wysiwyg?.redo()
        else source?.redo()
      },
      onReset: () => resetToSaved(),
    },
  )
  toolbarCtl.el.querySelector<HTMLElement>('[data-act="save"]')?.setAttribute('data-mm-save', '1')
  toolbarCtl.el.querySelector<HTMLElement>('[data-act="reset"]')?.setAttribute('data-mm-reset', '1')
  // 徽标保留错误/警告文案通道（内联失败/剥离警告/保存失败）；dirty 一律=保存钮红点，不再写「未保存」文字
  const badge = document.createElement('span')
  badge.className = 'mm-html-badge'
  // 布局（v3 口径延续）：编辑钮簇+徽标居左，三态按钮组居右
  toolbar.appendChild(toolbarCtl.el)
  toolbar.appendChild(badge)
  toolbar.appendChild(modesEl)
  modesEl.style.marginLeft = 'auto'
  const wysiwygBar = document.createElement('div')
  wysiwygBar.className = 'mm-html-wysiwyg-bar'
  wysiwygBar.style.display = 'none'
  // 查找替换面板（C 档）：可视态工具栏下浮动条（显隐唯一开关=data-active；基础 CSS 已 display:none，
  // 不写内联 style——内联样式会盖过 [data-active="true"] 规则导致面板永远展不开）
  const findBar = document.createElement('div')
  findBar.className = 'mm-html-findbar'
  const findInput = document.createElement('input')
  findInput.placeholder = ctx.t('app.html-find')
  const findCount = document.createElement('span')
  findCount.className = 'mm-html-find-count'
  findCount.textContent = '0/0'
  const findBtn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', fn)
    return b
  }
  const updCount = (): void => {
    const n = wysiwyg?.hitCount() ?? 0
    findCount.textContent = `${n === 0 ? 0 : (wysiwyg?.hitCursor() ?? 0) + 1}/${n}`
  }
  const replaceInput = document.createElement('input')
  replaceInput.placeholder = ctx.t('app.html-replace')
  findInput.addEventListener('input', () => {
    wysiwyg?.find(findInput.value)
    updCount()
  })
  findBar.appendChild(findInput)
  findBar.appendChild(findCount)
  findBar.appendChild(findBtn('▲', ctx.t('app.html-find-prev'), () => { wysiwyg?.findPrev(); updCount() }))
  findBar.appendChild(findBtn('▼', ctx.t('app.html-find-next'), () => { wysiwyg?.findNext(); updCount() }))
  findBar.appendChild(replaceInput)
  findBar.appendChild(findBtn(ctx.t('app.html-replace-one'), ctx.t('app.html-replace-one'), () => { wysiwyg?.replace(replaceInput.value); updCount() }))
  findBar.appendChild(findBtn(ctx.t('app.html-replace-all'), ctx.t('app.html-replace-all'), () => { const n = wysiwyg?.replaceAll(replaceInput.value) ?? 0; if (n > 0) markDirty(); updCount() }))
  findBar.appendChild(findBtn('✕', ctx.t('app.html-close'), () => { findBar.dataset.active = 'false' }))
  const views = document.createElement('div')
  views.className = 'mm-html-views'
  const sourcePane = document.createElement('div')
  sourcePane.className = 'mm-html-pane'
  const wysiwygPane = document.createElement('div')
  wysiwygPane.className = 'mm-html-pane mm-html-wysiwyg'
  const previewPane = document.createElement('div')
  previewPane.className = 'mm-html-pane mm-html-preview'
  views.appendChild(sourcePane)
  views.appendChild(wysiwygPane)
  views.appendChild(previewPane)
  // 确认条（复用：预览跳转代理 / wysiwyg→source 重排确认）
  const confirmBar = document.createElement('div')
  confirmBar.className = 'mm-html-confirm'
  const confirmText = document.createElement('span')
  confirmText.className = 'mm-html-confirm-url'
  const confirmTrust = document.createElement('label')
  const confirmTrustBox = document.createElement('input')
  confirmTrustBox.type = 'checkbox'
  confirmTrust.appendChild(confirmTrustBox)
  const confirmYes = document.createElement('button')
  confirmYes.className = 'is-primary'
  const confirmNo = document.createElement('button')
  confirmBar.appendChild(confirmText)
  confirmBar.appendChild(confirmTrust)
  confirmBar.appendChild(confirmNo)
  confirmBar.appendChild(confirmYes)
  root.appendChild(toolbar)
  root.appendChild(wysiwygBar)
  root.appendChild(findBar)
  root.appendChild(views)
  root.appendChild(confirmBar)
  el.appendChild(root)

  // ── 状态 ──
  let disposed = false
  let saving = false
  let dirty = false
  let mode: HtmlMode = resolveInitialMode(options, readStoredSafe(saved.mode))
  let source: SourceHandle | null = null
  let wysiwyg: WysiwygHandle | null = null
  /** 可视工具栏 active 态同步队列（buildWysiwygBar 填充；onStateChange/编辑事件派发） */
  const barSyncs: (() => void)[] = []
  /** onStateChange 订阅解绑函数（离态销毁/实例销毁时摘除） */
  let wysiwygStateUnbind: (() => void) | null = null
  /** 可视编辑会话的 body 片段（进态创建时喂入；离态销毁——内容已交接） */
  let previewUrlShown = ''

  function readStoredSafe(v: unknown): HtmlMode | null {
    return isHtmlMode(v) ? v : null
  }

  // ── 权威内容读写（三态交接介质=HTML 字符串）──
  /** 当前完整文档 HTML（保存/预览统一取口）：source 权威=CM 全文；wysiwyg 权威=模板 body+getHTML */
  function currentFullHtml(): string {
    if (mode === 'wysiwyg' && wysiwyg) {
      const bodyHtml = wysiwyg.getHTML()
      return isFullDoc ? injectBody(source!.getText(), bodyHtml) : wrapFragment(bodyHtml, file.name)
    }
    return source!.getText()
  }
  /** 当前 body 片段（wysiwyg 进态交接）：CM 全文解析出 body；已是片段则原样 */
  function currentBodyFragment(): string {
    const text = source!.getText()
    const parsed = new DOMParser().parseFromString(text, 'text/html')
    return isFullDoc || !!parsed.querySelector('html') ? parsed.body.innerHTML : text
  }
  /** 把 body 片段写回完整文档模板（保留 head 资产） */
  function injectBody(fullDocText: string, bodyHtml: string): string {
    const parsed = new DOMParser().parseFromString(fullDocText, 'text/html')
    parsed.body.innerHTML = bodyHtml
    return '<!doctype html>\n' + parsed.documentElement.outerHTML
  }

  // ── 脏标 ──
  // dirty 只走统一钮簇保存钮红点（一百四十三番）；徽标仅剩错误/警告文案通道（内联失败/剥离警告/保存失败）
  const markDirty = (): void => {
    dirty = true
    toolbarCtl.setDirty(true)
    // 顺带刷工具栏 active 态：save() 在可视态内重建实例走的是纯 markDirty 回调，
    // 挂在这里保证重建后的新实例也持续驱动按钮态（onStateChange 订阅只盖 enter 路径）
    barSyncs.forEach((f) => f())
  }
  const clearDirty = (): void => {
    dirty = false
    toolbarCtl.setDirty(false)
    badge.textContent = inlineWarn.length > 0 ? ctx.t('app.html-inline-failed', { n: inlineWarn.length }) : ''
    badge.style.color = '#d54941'
    badge.title = inlineWarn.join('\n')
  }
  function refreshBadge(): void {
    if (dirty) markDirty()
    else clearDirty()
  }

  /** 重置：放弃未保存修改恢复打开时内容（source 权威载体写回；可视态按新 body 片段重建实例） */
  function resetToSaved(): void {
    if (disposed || saving || !dirty || !source) return
    suppressDirty = true
    try {
      source.setText(sourceText)
      if (mode === 'wysiwyg' && wysiwyg) {
        wysiwygStateUnbind?.()
        wysiwygStateUnbind = null
        wysiwyg.dispose()
        wysiwyg = createWysiwyg(wysiwygPane, { html: currentBodyFragment(), onChange: onEditChange })
        wysiwygStateUnbind = wysiwyg.onStateChange(() => barSyncs.forEach((f) => f()))
        barSyncs.forEach((f) => f())
      }
    } finally {
      suppressDirty = false
    }
    clearDirty()
  }
  /** reset 的程序化改写不入 dirty（CM/Tiptap onChange 同步触发；预览重排不误报脏） */
  let suppressDirty = false
  const onEditChange = (): void => {
    if (!suppressDirty) markDirty()
  }

  // ── 保存链（幂等双闸 + save pass 单体化，方案 §3.3）──
  const save = async (): Promise<void> => {
    if (disposed || saving || !dirty) return
    const htmlNow = currentFullHtml()
    saving = true
    toolbarCtl.setBusy(true)
    try {
      // save pass：内联兜底（可视编辑中新贴的外链 href 等）→ 强制剥离仍外指的资源
      const parsed = new DOMParser().parseFromString(htmlNow, 'text/html')
      await inlineAssets(parsed, { inlineScripts: false })
      const stripped = stripExternalAssets(parsed)
      const finalHtml =
        '<!doctype html>\n' + parsed.documentElement.outerHTML
      const blob = new Blob([finalHtml], { type: 'text/html' })
      await ctx.putObject(file.key, blob, 'text/html; charset=utf-8')
      ctx.notify('saved', { key: file.key })
      // 来源若是可视编辑：把重排+剥离后的结果写回活动视图（所见即所存）
      if (mode === 'wysiwyg' && wysiwyg) {
        const body = new DOMParser().parseFromString(finalHtml, 'text/html').body.innerHTML
        wysiwyg.dispose()
        wysiwyg = createWysiwyg(wysiwygPane, { html: body, onChange: onEditChange })
      } else if (source) {
        source.setText(finalHtml)
      }
      if (stripped.length > 0) {
        badge.textContent = ctx.t('app.html-strip-warning', { n: stripped.length })
        badge.style.color = '#b88230'
        badge.title = stripped.join('\n')
      } else {
        clearDirty()
      }
    } catch (err) {
      console.warn('HTML_SAVE_ERR', String(err)?.slice(0, 200))
      badge.textContent = ctx.t('app.html-save-failed')
      badge.style.color = '#d54941'
    } finally {
      saving = false
      toolbarCtl.setBusy(false)
    }
  }
  const onKey = (ev: KeyboardEvent): void => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void save()
    }
  }

  // ── 确认条（预览跳转 / 重排确认 复用）──
  let confirmResolve: ((v: boolean) => void) | null = null
  function askConfirm(opts: { text: string; yes: string; no: string; trustLabel?: string; onTrust?: () => void }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmResolve = resolve
      confirmText.textContent = opts.text
      confirmYes.textContent = opts.yes
      confirmNo.textContent = opts.no
      confirmTrust.style.display = opts.trustLabel ? 'inline-flex' : 'none'
      if (opts.trustLabel) {
        confirmTrustBox.checked = false
        let labelNode = confirmTrust.querySelector('span')
        if (!labelNode) {
          labelNode = document.createElement('span')
          confirmTrust.appendChild(labelNode)
        }
        labelNode.textContent = opts.trustLabel
      }
      confirmBar.dataset.active = 'true'
      confirmYes.onclick = () => {
        confirmBar.dataset.active = 'false'
        if (opts.trustLabel && confirmTrustBox.checked) opts.onTrust?.()
        confirmResolve?.(true)
        confirmResolve = null
      }
      confirmNo.onclick = () => {
        confirmBar.dataset.active = 'false'
        confirmResolve?.(false)
        confirmResolve = null
      }
    })
  }

  // ── 预览跳转代理（方案 §4.2）：message 校验 event.source → 白名单 → 确认 → window.open ──
  const onMessage = (e: MessageEvent): void => {
    if (disposed || e.source !== previewFrame?.contentWindow) return
    const req = parseOpenRequest(e.data)
    if (!req) return
    const abs = normalizeOpenUrl(req.url)
    if (!abs) {
      ctx.notify('html-open-rejected', { url: req.url })
      return
    }
    const origin = new URL(abs).origin
    if (trustedOrigins.has(origin)) {
      window.open(abs, '_blank', 'noopener,noreferrer')
      return
    }
    previewUrlShown = abs
    void askConfirm({
      text: ctx.t('app.html-open-confirm', { url: abs.length > 80 ? abs.slice(0, 80) + '…' : abs }),
      yes: ctx.t('app.html-open-open'),
      no: ctx.t('app.html-open-cancel'),
      trustLabel: ctx.t('app.html-open-trust'),
      onTrust: () => trustedOrigins.add(origin),
    }).then((ok) => {
      if (ok && !disposed) window.open(abs, '_blank', 'noopener,noreferrer')
    })
  }
  window.addEventListener('message', onMessage)

  // ── 预览态 ──
  let previewFrame: HTMLIFrameElement | null = null
  function enterPreview(): void {
    previewPane.textContent = ''
    previewFrame = document.createElement('iframe')
    previewFrame.setAttribute('sandbox', PREVIEW_SANDBOX)
    previewFrame.srcdoc = buildPreviewDoc(currentFullHtml())
    previewPane.appendChild(previewFrame)
  }
  function leavePreview(): void {
    previewPane.textContent = ''
    previewFrame = null
  }

  // ── 可视态（进态创建/离态销毁——单实例互斥，方案 §二）──
  function enterWysiwyg(): void {
    wysiwygPane.textContent = ''
    wysiwygBar.style.display = 'flex'
    buildWysiwygBar()
    wysiwyg = createWysiwyg(wysiwygPane, { html: currentBodyFragment(), onChange: onEditChange })
    // 工具栏 active 态：选区/文档事务派发（markDirty 只盖文档变更，选区移动靠这条）
    wysiwygStateUnbind = wysiwyg.onStateChange(() => barSyncs.forEach((f) => f()))
    barSyncs.forEach((f) => f()) // 初态对齐（进态首帧无事务）
  }
  /** 离态：内容交接回 CM（重排确认后整文档写回）；返回是否完成（用户取消则不切） */
  async function leaveWysiwyg(): Promise<boolean> {
    if (!wysiwyg) return true
    const bodyHtml = wysiwyg.getHTML()
    if (!rewriteNoticeDismissed) {
      const ok = await askConfirm({
        text: ctx.t('app.html-rewrite'),
        yes: ctx.t('app.html-rewrite-ok'),
        no: ctx.t('app.html-rewrite-cancel'),
        trustLabel: ctx.t('app.html-rewrite-dismiss'),
        onTrust: () => {
          rewriteNoticeDismissed = true
        },
      })
      if (!ok) return false
    }
    const full = isFullDoc ? injectBody(source!.getText(), bodyHtml) : wrapFragment(bodyHtml, file.name)
    source!.setText(full)
    wysiwygStateUnbind?.()
    wysiwygStateUnbind = null
    wysiwyg.dispose()
    wysiwyg = null
    wysiwygBar.style.display = 'none'
    findBar.dataset.active = 'false' // 查找面板随可视态一起收起
    wysiwygPane.textContent = ''
    return true
  }

  // ── 可视工具栏（仅图标 + title 悬浮 hint；观感对齐内置 code-editor 工具栏：ghost 钮/紧凑分组）──
  function buildWysiwygBar(): void {
    wysiwygBar.textContent = ''
    findBar.dataset.active = 'false' // 重建即收起（上一会话遗留展开态）
    barSyncs.length = 0
    /** ghost 图标钮：icon=ICONS 片段或 text=字面量短标签（H1/x² 等）；activeOf 同步函数入队统一派发 */
    const addBtn = (
      title: string,
      fn: () => void,
      opt: { icon?: string; text?: string; activeOf?: () => boolean } = {},
    ): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.title = title
      b.setAttribute('aria-label', title)
      if (opt.text) {
        b.className = 'is-text'
        b.textContent = opt.text
      } else if (opt.icon) {
        b.appendChild(svgIcon(opt.icon))
      }
      if (opt.activeOf) {
        const activeOf = opt.activeOf
        const sync = (): void => {
          b.dataset.active = String(activeOf())
        }
        sync()
        barSyncs.push(sync)
      }
      b.addEventListener('click', fn)
      wysiwygBar.appendChild(b)
      return b
    }
    const addSep = (): void => {
      const s = document.createElement('span')
      s.className = 'mm-html-wysiwyg-sep'
      wysiwygBar.appendChild(s)
    }
    const alignOf = (v: string) => (): boolean =>
      !!wysiwyg?.isActive('paragraph', { textAlign: v }) || !!wysiwyg?.isActive('heading', { textAlign: v })

    // 历史
    addBtn(ctx.t('app.html-undo'), () => wysiwyg?.undo(), { icon: ICONS.undo })
    addBtn(ctx.t('app.html-redo'), () => wysiwyg?.redo(), { icon: ICONS.redo })
    addSep()
    // 标题
    addBtn(ctx.t('app.html-h1'), () => wysiwyg?.toggleHeading(1), { text: 'H1', activeOf: () => !!wysiwyg?.isActive('heading', { level: 1 }) })
    addBtn(ctx.t('app.html-h2'), () => wysiwyg?.toggleHeading(2), { text: 'H2', activeOf: () => !!wysiwyg?.isActive('heading', { level: 2 }) })
    addBtn(ctx.t('app.html-h3'), () => wysiwyg?.toggleHeading(3), { text: 'H3', activeOf: () => !!wysiwyg?.isActive('heading', { level: 3 }) })
    addSep()
    // 行内格式 + 文字颜色
    addBtn(ctx.t('app.html-bold'), () => wysiwyg?.toggleBold(), { icon: ICONS.bold, activeOf: () => !!wysiwyg?.isActive('bold') })
    addBtn(ctx.t('app.html-italic'), () => wysiwyg?.toggleItalic(), { icon: ICONS.italic, activeOf: () => !!wysiwyg?.isActive('italic') })
    addBtn(ctx.t('app.html-underline'), () => wysiwyg?.toggleUnderline(), { icon: ICONS.underline, activeOf: () => !!wysiwyg?.isActive('underline') })
    addBtn(ctx.t('app.html-strike'), () => wysiwyg?.toggleStrike(), { icon: ICONS.strike, activeOf: () => !!wysiwyg?.isActive('strike') })
    addBtn(ctx.t('app.html-code'), () => wysiwyg?.toggleCode(), { icon: ICONS.code, activeOf: () => !!wysiwyg?.isActive('code') })
    addBtn(ctx.t('app.html-highlight'), () => wysiwyg?.toggleHighlight(), { icon: ICONS.highlight, activeOf: () => !!wysiwyg?.isActive('highlight') })
    const colorInput = document.createElement('input')
    colorInput.type = 'color'
    colorInput.value = '#1f2328'
    colorInput.title = ctx.t('app.html-color')
    colorInput.setAttribute('aria-label', ctx.t('app.html-color'))
    colorInput.addEventListener('input', () => wysiwyg?.setColor(colorInput.value))
    wysiwygBar.appendChild(colorInput)
    addBtn(ctx.t('app.html-color-clear'), () => wysiwyg?.unsetColor(), { icon: ICONS.x })
    addSep()
    // 对齐
    addBtn(ctx.t('app.html-align-left'), () => wysiwyg?.setTextAlign('left'), { icon: ICONS.alignLeft, activeOf: alignOf('left') })
    addBtn(ctx.t('app.html-align-center'), () => wysiwyg?.setTextAlign('center'), { icon: ICONS.alignCenter, activeOf: alignOf('center') })
    addBtn(ctx.t('app.html-align-right'), () => wysiwyg?.setTextAlign('right'), { icon: ICONS.alignRight, activeOf: alignOf('right') })
    addBtn(ctx.t('app.html-align-justify'), () => wysiwyg?.setTextAlign('justify'), { icon: ICONS.alignJustify, activeOf: alignOf('justify') })
    addSep()
    // 列表 / 引用 / 代码块 / 水平线
    addBtn(ctx.t('app.html-ul'), () => wysiwyg?.toggleBulletList(), { icon: ICONS.ul, activeOf: () => !!wysiwyg?.isActive('bulletList') })
    addBtn(ctx.t('app.html-ol'), () => wysiwyg?.toggleOrderedList(), { icon: ICONS.ol, activeOf: () => !!wysiwyg?.isActive('orderedList') })
    addBtn(ctx.t('app.html-task'), () => wysiwyg?.toggleTaskList(), { icon: ICONS.task, activeOf: () => !!wysiwyg?.isActive('taskList') })
    addBtn(ctx.t('app.html-quote'), () => wysiwyg?.toggleBlockquote(), { icon: ICONS.quote, activeOf: () => !!wysiwyg?.isActive('blockquote') })
    addBtn(ctx.t('app.html-codeblock'), () => wysiwyg?.toggleCodeBlock(), { icon: ICONS.codeBlock, activeOf: () => !!wysiwyg?.isActive('codeBlock') })
    addBtn(ctx.t('app.html-hr'), () => wysiwyg?.setHorizontalRule(), { icon: ICONS.hr })
    addSep()
    // 上下标
    addBtn(ctx.t('app.html-sup'), () => wysiwyg?.toggleSuperscript(), { text: 'x²', activeOf: () => !!wysiwyg?.isActive('superscript') })
    addBtn(ctx.t('app.html-sub'), () => wysiwyg?.toggleSubscript(), { text: 'x₂', activeOf: () => !!wysiwyg?.isActive('subscript') })
    addSep()
    // 链接 / 图片
    addBtn(ctx.t('app.html-link'), () => wysiwyg?.setLink(), { icon: ICONS.link, activeOf: () => !!wysiwyg?.isActive('link') })
    addBtn(ctx.t('app.html-unlink'), () => wysiwyg?.unsetLink(), { icon: ICONS.unlink })
    addBtn(ctx.t('app.html-image'), () => wysiwyg?.insertImage(), { icon: ICONS.image })
    addBtn(ctx.t('app.html-image-width'), () => {
      const ans = globalThis.prompt(ctx.t('app.html-image-width'), wysiwyg?.getImageWidth() ?? '')
      if (ans === null) return
      const v = ans.trim()
      if (v === '') {
        wysiwyg?.unsetImageWidth()
        return
      }
      wysiwyg?.setImageWidth(/^\d+(\.\d+)?$/.test(v) ? `${v}px` : v)
    }, { icon: ICONS.imageWidth })
    addSep()
    // 表格：插入 + 操作组（仅光标在表内时展示，随事务派发刷新）
    addBtn(ctx.t('app.html-table'), () => wysiwyg?.insertTable(), { icon: ICONS.table })
    const tableOps = document.createElement('span')
    tableOps.className = 'mm-html-wysiwyg-group'
    tableOps.style.display = 'none'
    const addOp = (icon: string, title: string, fn: () => void): void => {
      const b = document.createElement('button')
      b.type = 'button'
      b.title = title
      b.setAttribute('aria-label', title)
      b.appendChild(svgIcon(icon))
      b.addEventListener('click', fn)
      tableOps.appendChild(b)
    }
    addOp(ICONS.rowAdd, ctx.t('app.html-table-addrow'), () => wysiwyg?.tableCommand('addRowAfter'))
    addOp(ICONS.colAdd, ctx.t('app.html-table-addcol'), () => wysiwyg?.tableCommand('addColumnAfter'))
    addOp(ICONS.rowDel, ctx.t('app.html-table-delrow'), () => wysiwyg?.tableCommand('deleteRow'))
    addOp(ICONS.colDel, ctx.t('app.html-table-delcol'), () => wysiwyg?.tableCommand('deleteColumn'))
    addOp(ICONS.merge, ctx.t('app.html-table-merge'), () => wysiwyg?.tableCommand('mergeCells'))
    addOp(ICONS.split, ctx.t('app.html-table-split'), () => wysiwyg?.tableCommand('splitCell'))
    addOp(ICONS.header, ctx.t('app.html-table-header'), () => wysiwyg?.tableCommand('toggleHeaderRow'))
    addOp(ICONS.trash, ctx.t('app.html-table-delete'), () => wysiwyg?.tableCommand('deleteTable'))
    wysiwygBar.appendChild(tableOps)
    barSyncs.push(() => {
      tableOps.style.display = wysiwyg?.isActive('table') ? 'inline-flex' : 'none'
    })
    addSep()
    // 查找替换（开/关 findBar 并聚焦查找框）
    const findToggle = addBtn(ctx.t('app.html-find-toggle'), () => {
      const open = findBar.dataset.active !== 'true'
      findBar.dataset.active = String(open)
      findToggle.dataset.active = String(open)
      if (open) {
        findInput.focus()
        updCount()
      }
    }, { icon: ICONS.find })
    // 字号 / 字体（工具栏最右，观感对齐 code-editor 的字号/语言下拉）
    const spacer = document.createElement('span')
    spacer.style.marginLeft = 'auto'
    wysiwygBar.appendChild(spacer)
    const addSelect = (title: string, options: { value: string; label: string }[], apply: (v: string) => void): HTMLSelectElement => {
      const sel = document.createElement('select')
      sel.title = title
      sel.setAttribute('aria-label', title)
      for (const o of options) {
        const optEl = document.createElement('option')
        optEl.value = o.value
        optEl.textContent = o.label
        sel.appendChild(optEl)
      }
      sel.addEventListener('change', () => {
        apply(sel.value)
        sel.value = '' // 动作型控件：用后回「默认」（无态回读通道，避免误导）
      })
      wysiwygBar.appendChild(sel)
      return sel
    }
    addSelect(ctx.t('app.html-font-size'), [
      { value: '', label: ctx.t('app.html-font-default') },
      ...['12px', '14px', '16px', '18px', '20px', '24px', '32px'].map((px) => ({ value: px, label: px })),
    ], (v) => (v ? wysiwyg?.setFontSize(v) : wysiwyg?.unsetFontSize()))
    addSelect(ctx.t('app.html-font-family'), [
      { value: '', label: ctx.t('app.html-font-default') },
      { value: 'sans-serif', label: ctx.t('app.html-font-sans') },
      { value: 'serif', label: ctx.t('app.html-font-serif') },
      { value: 'monospace', label: ctx.t('app.html-font-mono') },
    ], (v) => (v ? wysiwyg?.setFontFamily(v) : wysiwyg?.unsetFontFamily()))
  }

  // ── 三态切换 ──
  async function setMode(next: HtmlMode): Promise<void> {
    if (disposed || next === mode) return
    if (mode === 'wysiwyg' && next !== 'wysiwyg') {
      const done = await leaveWysiwyg()
      if (!done) return // 用户取消重排确认：停留
    }
    if (mode === 'preview' && next !== 'preview') leavePreview()
    const prev = mode
    mode = next
    writeStoredMode(mode)
    if (next === 'wysiwyg') enterWysiwyg()
    if (next === 'preview') enterPreview()
    applyMode()
    void prev
  }
  function applyMode(): void {
    sourcePane.dataset.active = String(mode === 'source')
    wysiwygPane.dataset.active = String(mode === 'wysiwyg')
    previewPane.dataset.active = String(mode === 'preview')
    wysiwygBar.style.display = mode === 'wysiwyg' ? 'flex' : 'none'
    toolbarCtl.setReadonly(mode === 'preview') // 预览态只读：统一钮簇整簇隐藏
    for (const m of MODES) {
      const b = modesEl.querySelector<HTMLButtonElement>(`button[data-mode="${m.key}"]`)
      if (b) b.dataset.active = String(mode === m.key)
    }
  }
  for (const m of MODES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.mode = m.key
    b.appendChild(svgIcon(m.icon))
    b.appendChild(document.createTextNode(ctx.t(m.tKey)))
    b.addEventListener('click', () => void setMode(m.key))
    modesEl.appendChild(b)
  }

  // ── 编辑器装配（source 常驻=权威文本载体；首文本为内联后的序列化结果）──
  source = createSourceEditor(sourcePane, {
    text: sourceText,
    onSave: () => void save(),
    onChange: onEditChange,
  })
  el.addEventListener('keydown', onKey, true)
  applyMode()
  refreshBadge()
  if (mode === 'wysiwyg') enterWysiwyg()
  if (mode === 'preview') enterPreview()

  const instance: HostInstance = {
    dispose: () => {
      if (disposed) return
      disposed = true
      el.removeEventListener('keydown', onKey, true)
      window.removeEventListener('message', onMessage)
      source?.dispose()
      source = null
      wysiwygStateUnbind?.()
      wysiwygStateUnbind = null
      wysiwyg?.dispose()
      wysiwyg = null
      leavePreview()
      root.remove()
    },
    getState: () => ({ mode }),
    beforeDispose: (reason?: 'close' | 'expired' | 'destroy') => {
      if (reason && reason !== 'close') return true // expired/destroy 通知式：不询问（契约 v1.1）
      if (!dirty) return true
      const ans = window.confirm(ctx.t('app.html-unsaved')) as boolean | Promise<boolean>
      return Promise.race([Promise.resolve(ans), new Promise<boolean>((r) => setTimeout(() => r(true), 3000))])
    },
  }
  return instance
}
