/**
 * 渲染装配：三形态机（源码/双窗/预览）+ CodeMirror 编辑窗 + markdown/mermaid 预览窗。
 * - 布局（防 stage 尺寸塌陷，code.ts 同口径）：el 注入 relative，root absolute inset:0。
 * - 形态切换纯 display/flex 控制（不重建编辑器、不丢光标）；用户切换写本地记忆。
 * - 双窗联动：编辑防抖 400ms → markdown 重渲染；mermaid 同码缓存防闪烁。
 * - 保存链：幂等（非 dirty/在途直接返回）+ Ctrl/Cmd+S + 未保存确认（3s 强制放行竞态）。
 * - savedState：{ mode, scrollTop }，切 tab 回来恢复形态与编辑滚动。
 * 样式全内联（无全局 <style> 注入，多实例零串扰）。
 */
import { createEditor, EditorHandle } from './editor'
import { renderMarkdown } from './md'
import { renderMermaidBlocks } from './mermaid'
import { isMdMode, readStoredMode, resolveInitialMode, writeStoredMode } from './options'
import { createEditToolbar } from '../../../src/shared/editToolbar'
import type { HostCtx, HostFile, HostInstance, MdEditorOptions, MdMode } from './types'

const DEBOUNCE_MS = 400
const MODES: { key: MdMode; tKey: string }[] = [
  { key: 'source', tKey: 'app.md-mode-source' },
  { key: 'split', tKey: 'app.md-mode-split' },
  { key: 'preview', tKey: 'app.md-mode-preview' },
]

/** 工具栏小图标（内联 SVG stroke 图形——零宿主图标字体依赖，currentColor 随主题） */
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

const MODE_ICONS: Record<MdMode, string> = {
  // 源码=尖括号 / 双窗=分栏矩形 / 预览=眼睛
  source: '<path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  preview: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/>',
}

/**
 * 插件级样式：全部钉在 .mm-md-* 命名空间下（同类多实例共享同一份——样式恒等，无串扰面）。
 * 内容排版（GitHub 系观感）+ CodeMirror 撑满窗格 + mermaid 占位/错误框。
 */
let styleInjected = false
function injectPluginStyles(): void {
  if (styleInjected) return
  styleInjected = true
  const st = document.createElement('style')
  st.textContent = `
.mm-md-editor-pane .cm-editor { height: 100%; }
.mm-md-editor-pane .cm-scroller { overflow: auto; }
.mm-md-preview h1,.mm-md-preview h2,.mm-md-preview h3,.mm-md-preview h4 { margin:1.2em 0 .6em; line-height:1.4; }
.mm-md-preview h1 { font-size:1.7em; border-bottom:1px solid #eaecef; padding-bottom:.3em; }
.mm-md-preview h2 { font-size:1.4em; border-bottom:1px solid #eaecef; padding-bottom:.3em; }
.mm-md-preview p { margin:.8em 0; }
.mm-md-preview ul,.mm-md-preview ol { padding-left:1.6em; margin:.6em 0; }
.mm-md-preview blockquote { margin:.8em 0; padding:.2em 1em; color:#57606a; border-left:4px solid #d0d7de; }
.mm-md-preview code { background:#f6f8fa; border-radius:4px; padding:.15em .35em; font-size:.9em; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.mm-md-preview pre { background:#f6f8fa; border-radius:8px; padding:12px 14px; overflow:auto; }
.mm-md-preview pre code { background:transparent; padding:0; }
.mm-md-preview table { border-collapse:collapse; margin:.8em 0; }
.mm-md-preview th,.mm-md-preview td { border:1px solid #d0d7de; padding:6px 12px; }
.mm-md-preview th { background:#f6f8fa; }
.mm-md-preview img { max-width:100%; }
.mm-md-preview hr { border:none; border-top:1px solid #eaecef; margin:1.2em 0; }
.mm-md-preview a { color:#0969da; }
.mm-md-mermaid { margin:1em 0; text-align:center; overflow:auto; }
`
  document.head.appendChild(st)
}

interface MdSavedState {
  mode?: unknown
  scrollTop?: unknown
}

/** 出站链接加固（内置 markdown-renderer 同款：新窗 + 断开 opener） */
function hardenLinks(root: HTMLElement): void {
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  }
}

/** 超限只读提示（防御纵深：file.size 缺失/0 时上游预览闸会被绕过——方案 §3.4；limitText 由调用方按 MAX_BYTES 格式化） */
export function renderTooLargeTip(el: HTMLElement, ctx: HostCtx, limitText: string): HostInstance {
  const tip = document.createElement('div')
  tip.className = 'mm-md-too-large'
  tip.style.cssText = 'padding:16px;font-size:13px;color:#888'
  tip.textContent = ctx.t('app.markdown-too-large', { limit: limitText })
  el.replaceChildren(tip)
  return { dispose: () => void (el.innerHTML = '') }
}

export function renderEditor(
  el: HTMLElement,
  file: HostFile,
  ctx: HostCtx,
  options: MdEditorOptions,
  text: string,
  savedState?: unknown,
): HostInstance {
  // 形态初值：savedState（切 tab 恢复）> initialMode > 用户记忆 > defaultMode > split
  const saved = (savedState ?? {}) as MdSavedState
  const stored = resolveInitialMode(options, readStoredMode())
  let mode: MdMode = isMdMode(saved.mode) ? saved.mode : stored

  let dirty = false
  let disposed = false
  let saving = false

  // ── 骨架 ──────────────────────────────────────────────────
  injectPluginStyles()
  el.style.position = 'relative'
  const root = document.createElement('div')
  root.className = 'mm-md-root'
  root.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:#fff;z-index:0'

  const toolbar = document.createElement('div')
  toolbar.className = 'mm-md-toolbar'
  toolbar.style.cssText =
    'flex:none;display:flex;align-items:center;gap:8px;height:36px;padding:0 8px;border-bottom:1px solid #e5e7eb;background:#fafafa'

  const seg = document.createElement('div')
  seg.className = 'mm-md-modes'
  seg.setAttribute('role', 'tablist')
  seg.style.cssText = 'display:flex;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;background:#fff'
  const segBtns = new Map<MdMode, HTMLButtonElement>()
  for (const m of MODES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('data-mm-mode', m.key)
    // 小图标 + hint（原生 title；label 走宿主词典 i18n）
    b.appendChild(svgIcon(MODE_ICONS[m.key]))
    b.title = ctx.t(m.tKey)
    b.setAttribute('aria-label', ctx.t(m.tKey))
    b.style.cssText =
      'border:none;background:transparent;width:28px;height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#374151;padding:0'
    b.addEventListener('click', () => {
      if (disposed || mode === m.key) return
      mode = m.key
      writeStoredMode(mode)
      applyMode()
      if (mode !== 'source') void renderPreview()
    })
    seg.appendChild(b)
    segBtns.set(m.key, b)
  }

  const spacer = document.createElement('div')
  spacer.style.cssText = 'flex:1 1 auto;min-width:0'

  // 统一编辑钮簇（一百四十三番：保存红点｜撤销 重做 重置——样式唯源 shared/editToolbar，构建期内联）。
  // testid 透传保留 data-mm-* 口径（E2E/单测历史脚本稳定）；undo/redo 直调 CM6 命令，reset 见 resetToSaved
  const toolbarCtl = createEditToolbar(
    { save: ctx.t('app.edt-save'), undo: ctx.t('app.edt-undo'), redo: ctx.t('app.edt-redo'), reset: ctx.t('app.edt-reset') },
    {
      onSave: () => void save(),
      onUndo: () => void editor?.undo(),
      onRedo: () => void editor?.redo(),
      onReset: () => resetToSaved(),
    },
  )
  const clusterBtn = (act: string, tid: string): HTMLButtonElement => {
    const b = toolbarCtl.el.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!
    b.setAttribute(tid, '1')
    return b
  }
  clusterBtn('save', 'data-mm-save')
  clusterBtn('undo', 'data-mm-undo')
  clusterBtn('redo', 'data-mm-redo')
  clusterBtn('reset', 'data-mm-reset')

  // 布局（用户口径）：编辑钮簇居左，形态切换图标组居右
  toolbar.append(toolbarCtl.el, spacer, seg)

  const body = document.createElement('div')
  body.className = 'mm-md-body'
  body.style.cssText = 'flex:1 1 auto;min-height:0;display:flex'

  const editorPane = document.createElement('div')
  editorPane.className = 'mm-md-editor-pane'
  editorPane.setAttribute('data-mm-editor', '1')
  editorPane.style.cssText = 'flex:1 1 0;min-width:0;min-height:0;overflow:hidden;display:flex'
  const editorHost = document.createElement('div')
  editorHost.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden'
  editorPane.appendChild(editorHost)

  const divider = document.createElement('div')
  divider.className = 'mm-md-divider'
  divider.style.cssText = 'flex:none;width:1px;background:#e5e7eb'

  const previewPane = document.createElement('div')
  previewPane.className = 'mm-md-preview-pane'
  previewPane.setAttribute('data-mm-preview', '1')
  // 预览排版：窄栏居中（WPS/Word 观感），md 正文不铺满宽窗
  previewPane.style.cssText =
    'flex:1 1 0;min-width:0;min-height:0;overflow:auto;background:#fff'
  const preview = document.createElement('div')
  preview.className = 'mm-md-preview'
  preview.style.cssText =
    'max-width:860px;margin:0 auto;padding:20px 28px 48px;font-size:14px;line-height:1.7;color:#24292f'
  previewPane.appendChild(preview)

  body.append(editorPane, divider, previewPane)
  root.append(toolbar, body)
  el.appendChild(root)

  // ── 形态机 ────────────────────────────────────────────────
  const applyMode = (): void => {
    editorPane.style.display = mode === 'preview' ? 'none' : 'flex'
    previewPane.style.display = mode === 'source' ? 'none' : 'block'
    divider.style.display = mode === 'split' ? 'block' : 'none'
    const grow = mode === 'split' ? '1 1 0' : '1 1 100%'
    editorPane.style.flex = grow
    previewPane.style.flex = grow
    for (const [k, b] of segBtns) {
      b.style.background = k === mode ? '#eef2f7' : 'transparent'
      b.style.fontWeight = k === mode ? '600' : '400'
      b.setAttribute('aria-selected', k === mode ? 'true' : 'false')
    }
    // display 复位后 CodeMirror 需重测几何（0→非 0 尺寸），否则光标/滚动错位
    if (mode !== 'preview') requestAnimationFrame(() => editor?.requestMeasure())
  }

  // ── 预览管线 ──────────────────────────────────────────────
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleRender = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (!disposed && mode !== 'source') void renderPreview()
    }, DEBOUNCE_MS)
  }
  const renderPreview = async (): Promise<void> => {
    if (disposed) return
    const { html, mermaidBlocks } = renderMarkdown(editor.getText())
    preview.innerHTML = html // markdown-it html:false + fence 钩子产出，见 md.ts 安全基线
    hardenLinks(preview)
    await renderMermaidBlocks(preview, mermaidBlocks)
  }

  // ── 保存链 ────────────────────────────────────────────────
  // dirty 只走统一钮簇保存钮红点（一百四十三番），「未保存」文字徽标废弃
  const markDirty = (): void => {
    dirty = true
    toolbarCtl.setDirty(true)
  }
  const clearDirty = (): void => {
    dirty = false
    toolbarCtl.setDirty(false)
  }
  const save = async (): Promise<void> => {
    // 幂等双闸：未变更不写；在途不重入（CM keymap 与窗口级监听可能双触发）
    if (disposed || saving || !dirty || !editor) return
    const ed = editor
    // 保存起点快照：await 直传 RTT 期间的增量输入不得被误标已保存（P1——否则关 tab 无确认，增量静默丢失）
    const snapshot = ed.getText()
    saving = true
    toolbarCtl.setBusy(true)
    try {
      await ctx.putObject(file.key, new Blob([snapshot], { type: 'text/markdown' }), 'text/markdown; charset=utf-8')
      ctx.notify('saved', { key: file.key })
      // 结算时正文仍=快照才清脏；期间继续输入则保持 dirty（下一轮保存/关闭确认兜底增量）
      if (!disposed && editor === ed && ed.getText() === snapshot) clearDirty()
    } catch (err) {
      console.warn('MD_SAVE_ERR', String(err)?.slice(0, 200))
      // 可见化出口（宿主可写域补口）: ctx 带 notifyAppError 即上报宿主 bus 'error'
      // （凭据拒 4002/4003 → 宿主换签重载; 其余码 → 宿主 toast）
      const sdkErr = err as { code?: unknown; message?: unknown } | null
      ctx.notifyAppError?.({
        code: typeof sdkErr?.code === 'number' ? sdkErr.code : 0,
        message: typeof sdkErr?.message === 'string' ? sdkErr.message : String(err),
      })
    } finally {
      saving = false
      toolbarCtl.setBusy(false)
    }
  }

  /** 重置：放弃未保存修改恢复打开时内容（CM dispatch 入 history 可撤销；onChange 里 preview 照常重渲） */
  const resetToSaved = (): void => {
    if (disposed || saving || !dirty || !editor) return
    suppressDirty = true
    try {
      editor.setText(text)
    } finally {
      suppressDirty = false
    }
    clearDirty()
  }
  // 注意：keydown 监听在编辑器创建成功后才挂 el（捕获级、作用域=本实例容器）——
  // P2：createEditor 抛错时 instance 不返回、dispose 无人调，先挂 window 会孤儿化（全局 Ctrl+S 被吞）；
  // P3：window 级在多实例并存时会互相触发保存，容器级与内置 code.ts 同口径（save 本身幂等双闸兜底重入）
  const onKey = (ev: KeyboardEvent): void => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void save()
    }
  }

  // ── 编辑器 ────────────────────────────────────────────────
  let editor: EditorHandle | null = null

  const instance: HostInstance = {
    dispose: () => {
      if (disposed) return
      disposed = true
      if (debounceTimer) clearTimeout(debounceTimer)
      el.removeEventListener('keydown', onKey, true)
      editor?.dispose()
      editor = null
      root.remove()
    },
    getState: () => ({
      mode,
      scrollTop: editor && mode !== 'preview' ? editor.getScrollTop() : undefined,
    }),
    beforeDispose: (reason?: 'close' | 'expired' | 'destroy') => {
      if (reason && reason !== 'close') return true // expired/destroy 通知式：不询问（契约 v1.1）
      if (!dirty) return true
      const ans = window.confirm(ctx.t('app.code-unsaved')) as boolean | Promise<boolean>
      return Promise.race([Promise.resolve(ans), new Promise<boolean>((r) => setTimeout(() => r(true), 3000))])
    },
  }

  // 编辑器装配（正文已在手——getObject 由 index.ts 外层先取）
  // suppressDirty：resetToSaved 的程序化改写不入 dirty，但预览管线照常重渲（scheduleRender 不抑制）
  let suppressDirty = false
  editor = createEditor(editorHost, {
    text,
    onSave: () => void save(),
    onChange: () => {
      if (!suppressDirty) markDirty()
      scheduleRender()
    },
  })
  el.addEventListener('keydown', onKey, true) // 容器捕获级，编辑器创建成功后注册（防孤儿/防多实例互扰，见上）
  applyMode()
  // 恢复编辑滚动（切 tab 回来；preview 态无编辑滚动可恢复）
  if (typeof saved.scrollTop === 'number' && mode !== 'preview') editor.setScrollTop(saved.scrollTop)
  // 首开即渲染预览（split/preview 态）——此前只挂切换/编辑触发，首开预览窗空（E2E R1 抓获）
  if (mode !== 'source') void renderPreview()

  return instance
}
