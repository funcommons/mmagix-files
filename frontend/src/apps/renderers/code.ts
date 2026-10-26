/**
 * 文本/代码编辑器渲染器（Monaco 完整编辑器版）——M2-R4，工具栏升级（R5）
 * 契约：《documents/第一期文件类型支持计划.md》§一（code-editor 行）+
 *       《动态插件方案.md》V1.1 §二 ctx 能力面（凭证不出、字节流进出）+ AppInstance 生命周期。
 * 链路：5MB 先判（file.size，超限不拉字节流）→ ctx.getObject → Blob.text() →
 *       monaco.editor.create（动态 import，绝不入主 bundle）→ dirty 跟踪 → Ctrl/Cmd+S 保存链。
 * 工具栏（26px 紧凑条）：统一编辑钮簇（保存｜撤销 重做 重置——shared/editToolbar 唯一样式源，
 *       一百四十三番口径：dirty=保存钮右上角红点，「未保存」文字徽标废弃）+ 格式化/查找/字号±/
 *       语言切换（按扩展名自动识别，可手切）/状态徽标（只读锁）。编辑类钮只读态隐藏。
 *       重置=恢复打开时内容（最后保存态），executeEdits 入 undo 栈可撤销取回。
 *       快捷键：Ctrl/Cmd+S 保存（既有链）；Ctrl/Cmd+F 查找（actions.find，
 *       捕获阶段拦截统一走本渲染器，浏览器默认页内查找不触发）；Ctrl/Cmd+Z/Y 由 monaco 原生接管（不拦）。
 * 只读两态：
 *       静态——file.size 超限：不建 editor，出只读提示（showTooLargeTip，无工具栏）；
 *       运行期——ctx.putObject 拒 4305 UNSUPPORTED_MODE（单文件模式无 save 段，写链在配置层不存在）：
 *       闩锁只读——editor.updateOptions({readOnly:true}) + 工具栏隐藏编辑类钮 + 只读徽标；
 *       dirty 复位（写不出去的内容无「未保存」可言，关闭不再拦）。瞬时失败（网络等非 4305）
 *       保持既有语义：dirty 不动、关闭仍确认、不闩只读。ctx 无前置只读信号（AppCtx 契约无该能力位），
 *       保存拒 4305 是唯一权威信号。
 * 保存链：getValue → new Blob → ctx.putObject(key, blob) → ctx.notify('saved', {key}) → dirty=false；
 *         保存中防重入（saving 闸，工具栏保存钮同步禁用）；失败保持 dirty（beforeDispose 仍拦截），不误报已保存。
 * beforeDispose 契约：非 dirty 同步放行 true；dirty 弹 confirm（false=暂缓关闭）；
 *         并与 3s 超时 Promise.race——confirm 卡死时强制放行，防 tab 永久悬挂。
 * 布局（防「Monaco stage 尺寸塌陷」复发）：挂载即给 el 注入 position:relative，root 以 absolute inset:0
 *         填满——el 高度由宿主链保证（.ws__preview-host flex:1+min-height:320px → .mmf-preview-stage
 *         min-height:100%），root 绝对定位不参与 content 高度计算，monaco 容器尺寸恒等于宿主预览区，
 *         与 C1 min-height 链口径一致。
 * worker：MonacoEnvironment 按 workerId 分发（json/css/html/ts 各自语言 worker + 基础
 *         editor.worker.start；vite ?worker 独立分块按需实例化）——语言服务 formatter/补全/
 *         折叠区间真正可用。格式化双链：worker 原生 formatter 优先（超时+文本变化双护栏），
 *         自研 json stringify/js-beautify 回退（doFormat）。
 */
import type { editor as monacoEditorNS } from 'monaco-editor'
import { CODE_MAX_BYTES } from '../builtins'
import { ERROR_CODES } from '../../sdk/errorCodes'
import { formatBytes } from '../../files/format'
import { createEditToolbar } from '../../shared/editToolbar'
import { buildMonacoTheme, isDarkHost, observeHostTheme, readHostThemeVars } from './code-theme'
import type { AppCtx, AppDefinition, AppInstance, DisposeReason } from '../../sdk/types'

// ───────────────────────── 常量 ─────────────────────────
// 文本类预览/编辑上限：5MiB（契约预览策略；按 file.size 先判，避免白拉超限字节流）。
// 与 code-editor spec.maxBytes 同源（builtins.ts，R2-03）——预览闸已按该线在上游拒绝，
// 此处保留作防御纵深（绕闸调用方/未登记 maxBytes 的注册路径）。
// 口径统一：原 5_000_000（十进制）废弃，改 5*1024*1024（1024 基）对齐 markdown/预览闸。

import { toast } from '@/components/sdk'
import EditorWorker from 'monaco-editor/editor/editor.worker.start.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

/** i18n key：超限只读提示 / 未保存关闭确认（词典在 locales，键缺省时 t 回退键名） */
const TOO_LARGE_KEY = 'app.code-too-large'
const UNSAVED_KEY = 'app.code-unsaved'

/** 工具栏文案 i18n key（词典 app.* 段；title/aria-label 共用，e2e/单测按 data-act 定位） */
const EDITOR_LABEL_KEY = 'app.code-editor'
const FORMAT_KEY = 'app.code-format'
const FIND_KEY = 'app.code-find'
const FONT_INC_KEY = 'app.code-font-inc'
const FONT_DEC_KEY = 'app.code-font-dec'
const LANG_KEY = 'app.code-language'
const READONLY_KEY = 'app.code-readonly'
/** 统一编辑钮簇文案（app.edt-*：内置+插件共用词典段；dirty 红点口径废除「未保存」文字徽标） */
const EDT_SAVE_KEY = 'app.edt-save'
const EDT_UNDO_KEY = 'app.edt-undo'
const EDT_REDO_KEY = 'app.edt-redo'
const RESET_KEY = 'app.edt-reset'

/** monaco 内建 action id（getAction 触发；format 无格式化器时 monaco 静默提示，不抛错） */
const ACTION_FORMAT = 'editor.action.formatDocument'
const ACTION_FIND = 'actions.find'

/** worker 格式化护栏超时：超时即放弃等待、走自研回退（本地 worker 常态 <100ms；5MB 大文件余量） */
const FORMAT_WORKER_TIMEOUT_MS = 2500

/** undo/redo trigger 的 source 标签（monaco 仅作遥测字符串，无语义） */
const TRIGGER_SOURCE = 'mmagic-code-bar'

/** 字号：初值=monaco 默认 14；缩放边界 9–32（紧凑可读双端兜底） */
const FONT_SIZE_DEFAULT = 14
const FONT_SIZE_MIN = 9
const FONT_SIZE_MAX = 32

/** beforeDispose 超时：confirm 卡死 3s 后强制放行（契约） */
const BEFORE_DISPOSE_TIMEOUT_MS = 3000

// ───────────────────────── 语言映射 ─────────────────────────

/**
 * ext → monaco language id 映射表（纯函数查表，无运行时依赖）
 * 值均为 monaco basic-languages / 内建语言 id；SFC(vue) 无专有语言，落 html 兜底高亮。
 */
const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', vue: 'html',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  py: 'python', pyw: 'python',
  java: 'java', go: 'go', rs: 'rust',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  yaml: 'yaml', yml: 'yaml', xml: 'xml',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  ini: 'ini', conf: 'ini', properties: 'ini',
  dockerfile: 'dockerfile', makefile: 'makefile',
}

/**
 * 扩展名 → monaco language id（导出供注册链/测试复用）
 * 归一化：忽略大小写与前导点；未命中/空值默认 'plaintext'。
 */
export function extToLanguage(ext: string): string {
  const key = ext.toLowerCase().replace(/^\.+/, '')
  return EXT_TO_LANGUAGE[key] ?? 'plaintext'
}

/** 文件名 → 扩展名（无后缀返回 ''，走 plaintext） */
function extOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1) : ''
}

/** 工具栏语言下拉清单：映射表值去重排序 + plaintext（手动切换项；技术 id 直出，不做词典文案） */
export const LANGUAGE_OPTIONS: string[] = [...new Set([...Object.values(EXT_TO_LANGUAGE), 'plaintext'])].sort()

// ───────────────────────── monaco 环境 ─────────────────────────

/**
 * MonacoEnvironment worker 分发（幂等）：
 * 0.57 的 getWorker(workerId, label) 中 workerId 恒为 "workerMain.js"——语言区别在 label
 * （=languageId：json/css/scss/less/html/typescript/javascript）。基础 editor.worker.start
 * 只承载 diff/word-based 等基础服务，语言服务（json/css/html 的 formatter·校验·折叠区间，
 * ts 的补全·悬停）各自独立 worker：统一返基础 worker 时语言服务静默降级（formatter 不落盘/
 * 折叠符号消失）——按 label 分发后真正可用。vite ?worker 构建期独立分块，运行时按需实例化。
 */
function ensureMonacoEnv(): void {
  const g = self as unknown as { MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker } }
  if (g.MonacoEnvironment) return
  g.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === 'json') return new JsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
      if (label === 'html') return new HtmlWorker()
      if (label === 'typescript' || label === 'javascript') return new TsWorker() // js/ts 共用 ts worker
      return new EditorWorker() // editorWorkerService（基础）+ basic-languages 系语言
    },
  }
}

/** 超限只读提示节点（不读全文、不建 editor、无工具栏；{limit} 与预览闸同源 formatBytes 口径，R2-05） */
function showTooLargeTip(el: HTMLElement, ctx: AppCtx): AppInstance {
  const tip = document.createElement('div')
  tip.className = 'code-too-large-tip'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = ctx.t(TOO_LARGE_KEY, { limit: formatBytes(CODE_MAX_BYTES) })
  el.replaceChildren(tip)
  return { dispose: () => el.replaceChildren() }
}

// ───────────────────────── beforeDispose 契约 ─────────────────────────

/**
 * confirm 应答 → Promise<boolean>：
 * window.confirm 原生为同步 API，包装成 Promise 以便与 3s 超时 Promise.race；
 * 同时兼容宿主把 confirm 替换为异步对话框（返回 thenable）——超时兜底对两者都成立。
 */
function askUser(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const answer = window.confirm(message) as boolean | Promise<boolean>
    const thenable = answer as {
      then?: (onOk: (v: boolean) => void, onErr: () => void) => void
    }
    if (thenable && typeof thenable.then === 'function') {
      // 异步应答：拒绝也放行（异常 dialog 不该卡死 tab）
      thenable.then(resolve, () => resolve(true))
      return
    }
    resolve(answer as boolean)
  })
}

// ───────────────────────── 工具栏样式（<style> 注入，dispose 随 root 移除） ─────────────────────────

/**
 * 26px 紧凑工具栏样式：ghost 图标钮口径复用工作台 ws-toolbar__act
 * （透明底 / hover bg-muted / 文字色 app-text-secondary→primary / 圆角 app-radius-button），
 * 取色全走 CSS token 变量（带品牌无关兜底值），禁硬编码主题色。
 * 高度链：root absolute inset:0（el 注入 relative），stage flex:1+min-height:0——
 * monaco 容器尺寸恒等于宿主预览区，杜绝「stage 尺寸塌陷」复发（C1 min-height 链口径不变）。
 */
const BAR_CSS = `
.mmagic-code { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.mmagic-code-bar { display: flex; align-items: center; gap: 4px; height: 36px; flex: none; padding: 0 8px; border-bottom: 1px solid var(--app-separator, rgba(127, 127, 127, 0.18)); background: var(--app-bg-card, #fafafa); }
.mmagic-code-bar__btn { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 28px; padding: 0 6px; border: 1px solid transparent; background: var(--app-bg-card, #fff); border-radius: var(--app-radius-button, 6px); color: var(--app-text-secondary); cursor: pointer; font-size: 14px; line-height: 1; transition: background 0.15s, color 0.15s, border-color 0.15s; }
.mmagic-code-bar__btn:hover:not(:disabled) { border-color: var(--app-separator, rgba(127, 127, 127, 0.25)); }
.mmagic-code-bar__btn--text { font-size: 12px; font-weight: 600; letter-spacing: 0.02em; padding: 0 7px; }
.mmagic-code-bar__btn:hover:not(:disabled) { background: var(--app-bg-muted); color: var(--app-text-primary); }
.mmagic-code-bar__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mmagic-code-bar__btn[hidden] { display: none; }
.mmagic-code-bar__sep { width: 1px; height: 14px; margin: 0 4px; flex: none; background: var(--app-separator, rgba(127, 127, 127, 0.18)); }
.mmagic-code-bar__lang { height: 28px; max-width: 140px; margin: 0 2px; padding: 0 4px; border: 1px solid transparent; border-radius: var(--app-radius-button, 6px); background: var(--app-bg-card, #fff); color: var(--app-text-secondary); font-size: 12px; cursor: pointer; }
.mmagic-code-bar__lang:hover { background: var(--app-bg-muted); color: var(--app-text-primary); }
.mmagic-code-bar__lang:focus-visible { outline: 1px solid var(--app-separator, rgba(127, 127, 127, 0.3)); }
.mmagic-code-bar__status { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; padding: 0 4px; font-size: 12px; color: var(--app-text-secondary); white-space: nowrap; }
.mmagic-code-bar__status:empty { display: none; }
.mmagic-code-stage { flex: 1 1 auto; min-height: 0; }
.mmagic-code-ctxmenu { position: fixed; z-index: 10000; min-width: 190px; padding: 4px; background: var(--app-bg-card, #fff); border: 1px solid var(--app-separator, rgba(127, 127, 127, 0.25)); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14); }
.mmagic-code-ctxmenu button { display: block; width: 100%; text-align: left; padding: 6px 12px; border: none; background: transparent; color: var(--app-text-primary, #1f2328); font-size: 13px; border-radius: 5px; cursor: pointer; }
.mmagic-code-ctxmenu button:hover { background: var(--app-bg-muted, rgba(127, 127, 127, 0.12)); }
.mmagic-code-ctxmenu button[aria-disabled='true'] { color: var(--app-text-tertiary, rgba(127, 127, 127, 0.7)); cursor: not-allowed; }
.mmagic-code-ctxmenu__sep { height: 1px; margin: 4px 6px; background: var(--app-separator, rgba(127, 127, 127, 0.18)); }
`

/**
 * 工具栏钮构建（ghost 口径）：icon=remixicon 类（innerHTML 仅拼固定类名字面量，无用户数据），
 * text=A±字面量；title/aria-label 同键同文案（与 ws-toolbar 口径一致）；editOnly=只读态隐藏。
 */
function barButton(
  act: string,
  label: string,
  opts: { icon?: string; text?: string; editOnly?: boolean } = {},
): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = opts.text ? 'mmagic-code-bar__btn mmagic-code-bar__btn--text' : 'mmagic-code-bar__btn'
  b.dataset.act = act
  b.title = label
  b.setAttribute('aria-label', label)
  if (opts.editOnly) b.dataset.editOnly = 'true'
  if (opts.icon) b.innerHTML = `<i class="${opts.icon}"></i>`
  else if (opts.text) b.textContent = opts.text
  return b
}

// ───────────────────────── 渲染器 ─────────────────────────

/**
 * Monaco 代码编辑器渲染器（内置应用 code-editor）
 * 渲染失败（getObject/读文本异常）向上抛，由 openFile 链路统一兜底（对齐 markdown 渲染器口径）；
 * 正常路径保证返回完整 AppInstance：dispose / getState / beforeDispose 三件套。
 */
export const codeEditorRenderer: AppDefinition['renderer'] = async (
  el,
  file,
  ctx,
  savedState,
) => {
  // 1) 5MiB 只读降级：先按 file.size 判，不建 editor、不拉字节流（契约预览策略；与闸关系见常量注）
  if (file.size > CODE_MAX_BYTES) {
    return showTooLargeTip(el, ctx)
  }

  // 2) 字节流 → 文本
  const blob = await ctx.getObject(file.key)
  const text = await blob.text()

  // 3) monaco 动态 import（顶层禁止 import——bundle 重量；类型走顶部 import type，编译期擦除）
  ensureMonacoEnv()
  const monaco = await import('monaco-editor')

  // 4) DOM 骨架：el 注入 relative → root absolute inset:0 填满宿主预览区（高度链见文件头布局注）
  el.style.position = 'relative'
  const root = document.createElement('div')
  root.className = 'mmagic-code'
  const styleEl = document.createElement('style')
  styleEl.textContent = BAR_CSS
  const bar = document.createElement('div')
  bar.className = 'mmagic-code-bar'
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', ctx.t(EDITOR_LABEL_KEY))
  const stage = document.createElement('div')
  stage.className = 'mmagic-code-stage'
  root.append(styleEl, bar, stage)
  el.replaceChildren(root)

  const editor: monacoEditorNS.IStandaloneCodeEditor = monaco.editor.create(stage, {
    value: text,
    language: extToLanguage(extOf(file.name)),
    fontSize: FONT_SIZE_DEFAULT,
    automaticLayout: true,
    // 编辑功能全开（用户订单：折叠/ minimap/智能提示/括号配色/粘滞滚动等；右键菜单自绘见下）
    folding: true,
    showFoldingControls: 'always', // 折叠符常显（默认 hover 才出现——用户「没看到折叠」的根因）
    foldingHighlight: true,
    minimap: { enabled: true, renderCharacters: false },
    quickSuggestions: { other: true, comments: false, strings: true },
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: 'matchingDocuments',
    snippetSuggestions: 'inline',
    formatOnPaste: true,
    formatOnType: true,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    stickyScroll: { enabled: true },
    linkedEditing: true,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    dragAndDrop: true,
    contextmenu: false, // 内置菜单无汉化通道（ESM 字符串编译期内联）——自绘全中文右键菜单，见下
  })

  // 自绘右键菜单（全 i18n）：项=monaco 内建 action id（getAction().run() 触发，行为与原生菜单一致）
  const CONTEXT_ITEMS: { act: string; tKey: string; sepBefore?: boolean }[] = [
    { act: 'editor.action.clipboardCutAction', tKey: 'app.code-menu-cut' },
    { act: 'editor.action.clipboardCopyAction', tKey: 'app.code-menu-copy' },
    { act: 'editor.action.clipboardPasteAction', tKey: 'app.code-menu-paste' },
    { act: 'editor.action.formatDocument', tKey: 'app.code-format', sepBefore: true },
    { act: 'actions.find', tKey: 'app.code-find' },
    { act: 'editor.action.changeAllOccurrences', tKey: 'app.code-menu-changeall' },
    { act: 'editor.action.quickOutline', tKey: 'app.code-menu-symbol', sepBefore: true },
    { act: 'editor.action.quickCommand', tKey: 'app.code-menu-palette' },
  ]
  /** 支持格式化的语言（白名单=worker formatter ∪ 自研回退）：json/css 系/html 系/js/ts——
   *  typescript 由 monaco ts worker formatter 支持（此前纯自研口径下置灰是历史遗留）；
   *  yaml/plaintext/markdown 等两链皆无——右键格式化项置灰、工具栏钮 toast 不支持 */
  const FORMAT_LANGS = new Set(['json', 'html', 'htm', 'css', 'scss', 'less', 'javascript', 'typescript'])

  /**
   * 统一格式化（工具栏钮与右键菜单同链）：
   * 1) 白名单外 → toast 不支持（拦截 monaco 无 formatter 时的英文内置提示）；
   * 2) 优先 monaco worker 原生格式化（json/css/html/js(ts) 官方语言服务，格式最标准）——
   *    双护栏：超时（worker 卡死/未就绪不拖 UI）+ 前后文本比对（run() 对无 provider
   *    的语言也静默 resolve，promise 本身不构成成功信号，文本变化才是）；
   * 3) 回退自研：json=JSON.stringify 重排、其余=js-beautify 动态 import（幂等——
   *    已规范文本不产生编辑）；json 非法抛错 → 不支持提示。
   * 超时后 worker 迟到落盘的竞态无害：两条链对已规范文本均幂等。
   */
  async function doFormat(): Promise<void> {
    const model = editor.getModel()
    if (!model) return
    const lang = model.getLanguageId()
    if (!FORMAT_LANGS.has(lang)) {
      toast.warning(ctx.t('app.code-format-unsupported'))
      return
    }
    const before = model.getValue()
    // worker 优先
    try {
      const action = editor.getAction(ACTION_FORMAT)
      if (action) {
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const guard = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true
            resolve()
          }, FORMAT_WORKER_TIMEOUT_MS)
        })
        await Promise.race([Promise.resolve(action.run()).catch(() => undefined), guard])
        if (timer !== undefined) clearTimeout(timer)
        if (!timedOut && model.getValue() !== before) {
          console.debug('[code-format] via worker')
          toast.success(ctx.t('app.code-formatted'))
          return
        }
      }
    } catch {
      /* worker 异常 → 自研回退 */
    }
    // 自研回退
    const src = model.getValue()
    try {
      let pretty: string
      if (lang === 'json') {
        pretty = JSON.stringify(JSON.parse(src), null, 2) // 非法 JSON 抛错 → 不支持提示
      } else {
        const beautify = await import('js-beautify')
        pretty =
          lang === 'html' || lang === 'htm'
            ? beautify.html(src, { indent_size: 2 })
            : lang === 'css' || lang === 'scss' || lang === 'less'
              ? beautify.css(src, { indent_size: 2 })
              : beautify.js(src, { indent_size: 2 }) // javascript/typescript：js-beautify 只重排空白，不解析语义，TS 标注不破坏
      }
      if (pretty !== src) {
        editor.executeEdits('mmagic-code-format', [{ range: model.getFullModelRange(), text: pretty }])
        // dirty 无需手动置位：executeEdits 触发 onDidChangeModelContent → 未保存徽标链
      }
      console.debug('[code-format] via local fallback')
      toast.success(ctx.t('app.code-formatted'))
    } catch {
      toast.warning(ctx.t('app.code-format-unsupported'))
    }
  }

  const showContextMenu = (x: number, y: number): void => {
    document.querySelector('.mmagic-code-ctxmenu')?.remove()
    const menu = document.createElement('div')
    menu.className = 'mmagic-code-ctxmenu'
    const model = editor.getModel()
    const formatSupported = model ? FORMAT_LANGS.has(model.getLanguageId()) : false
    for (const item of CONTEXT_ITEMS) {
      if (item.sepBefore) {
        const sepEl = document.createElement('div')
        sepEl.className = 'mmagic-code-ctxmenu__sep'
        menu.appendChild(sepEl)
      }
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = ctx.t(item.tKey)
      // 不可用项用 aria-disabled（不用 disabled 属性——它会吞 click，菜单就关不掉了）：
      // 点击时关菜单 + 明示「当前语言没有格式化程序」
      const unsupported = item.act === ACTION_FORMAT && !formatSupported
      if (unsupported) b.setAttribute('aria-disabled', 'true')
      b.addEventListener('click', () => {
        menu.remove()
        if (unsupported) {
          toast.warning(ctx.t('app.code-format-unsupported'))
          return
        }
        // 关键：点菜单项时焦点在菜单 DOM（editor 已 blur）——无焦点的 action 全部静默失效
        // （命令面板/转到符号/查找等 quick-access 系尤甚）。先还焦点再触发。
        editor.focus()
        // 复制/剪切：直接走 navigator.clipboard（monaco clipboard action 的 promise 链反馈不可靠，
        // 且无选区=整行语义用户感知不到）——成功/失败反馈完全确定
        if (item.act === 'editor.action.clipboardCopyAction' || item.act === 'editor.action.clipboardCutAction') {
          const cut = item.act === 'editor.action.clipboardCutAction'
          const sel = editor.getSelection()
          const model = editor.getModel()
          if (!sel || !model) return
          const range = sel.isEmpty()
            ? {
                startLineNumber: sel.positionLineNumber, startColumn: 1,
                endLineNumber: sel.positionLineNumber, endColumn: model.getLineMaxColumn(sel.positionLineNumber),
              }
            : { startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.endLineNumber, endColumn: sel.endColumn }
          const text = model.getValueInRange(range)
          navigator.clipboard
            .writeText(text)
            .then(() => toast.success(ctx.t(cut ? 'app.code-cut' : 'app.code-copied')))
            .catch(() => toast.error(ctx.t('app.code-paste-failed')))
          if (cut) {
            const delRange = sel.isEmpty()
              ? { ...range, endLineNumber: range.endLineNumber + 1, endColumn: 1 } // 整行含换行
              : range
            editor.executeEdits('mmagic-code-ctxmenu', [{ range: delRange, text: '' }])
          }
          return
        }
        // 格式化：统一走 doFormat（worker 原生优先 + 自研回退，工具栏/右键同链——见 doFormat 注）
        if (item.act === ACTION_FORMAT) {
          void doFormat()
          return
        }
        const action = editor.getAction(item.act)
        if (!action) return
        void Promise.resolve(action.run()).catch(() => {
          // 粘贴等剪贴板读权限失败：iframe allow 缺 clipboard-read 或用户拒绝
          toast.error(ctx.t('app.code-paste-failed'))
        })
      })
      menu.appendChild(b)
    }
    document.body.appendChild(menu)
    const r = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
    const close = (ev: MouseEvent): void => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove()
        window.removeEventListener('mousedown', close, true)
      }
    }
    window.addEventListener('mousedown', close, true)
  }
  stage.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    const e = ev as MouseEvent
    showContextMenu(e.clientX, e.clientY)
  })

  // P1-1 主题适配（code-editor升级建议）：宿主 --app-* 变量 → defineTheme 双主题（mmagic-light/
  // mmagic-dark，8 类核心 token，长尾 inherit 兜底）+ data-theme/data-brand 切换联动（MutationObserver）。
  const applyHostTheme = (): void => {
    const dark = isDarkHost(document)
    monaco.editor.defineTheme(dark ? 'mmagic-dark' : 'mmagic-light', buildMonacoTheme(readHostThemeVars(document), dark))
    monaco.editor.setTheme(dark ? 'mmagic-dark' : 'mmagic-light')
  }
  applyHostTheme()
  const unobserveTheme = observeHostTheme(document, applyHostTheme)

  // 5) 状态闸：dirty=有未保存修改；saving=保存中（防重入）；readonlyMode=写链判死闩锁（只读）
  let dirty = false
  let saving = false
  let readonlyMode = false
  let fontSize = FONT_SIZE_DEFAULT
  /** 监听统一 AbortController：dispose 一并摘除（键鼠/下拉全量） */
  const ac = new AbortController()

  // 6) 工具栏构建：统一编辑钮簇（保存红点｜撤销 重做 重置——一百四十三番口径，样式唯源 shared/editToolbar）
  //    + 格式化 | 查找 | 语言 | A− A+ …… 状态徽标（只读锁；「未保存」文字徽标废弃→保存钮红点）
  //    编辑类（簇内四钮/格式化）只读闩锁时隐藏（契约 R5-4）
  const toolbar = createEditToolbar(
    { save: ctx.t(EDT_SAVE_KEY), undo: ctx.t(EDT_UNDO_KEY), redo: ctx.t(EDT_REDO_KEY), reset: ctx.t(RESET_KEY) },
    {
      onSave: () => void save(),
      onUndo: () => editor.trigger(TRIGGER_SOURCE, 'undo', undefined),
      onRedo: () => editor.trigger(TRIGGER_SOURCE, 'redo', undefined),
      onReset: resetToSaved,
    },
  )
  const formatBtn = barButton('format', ctx.t(FORMAT_KEY), { icon: 'ri-magic-line', editOnly: true })
  const findBtn = barButton('find', ctx.t(FIND_KEY), { icon: 'ri-search-line' })
  const fontDecBtn = barButton('font-dec', ctx.t(FONT_DEC_KEY), { text: 'A−' })
  const fontIncBtn = barButton('font-inc', ctx.t(FONT_INC_KEY), { text: 'A+' })

  // 语言指示/切换：初值=按扩展名自动识别；选项=映射表值去重排序（技术 id 直出）
  const langSel = document.createElement('select')
  langSel.className = 'mmagic-code-bar__lang'
  langSel.title = ctx.t(LANG_KEY)
  langSel.setAttribute('aria-label', ctx.t(LANG_KEY))
  for (const id of LANGUAGE_OPTIONS) {
    const opt = document.createElement('option')
    opt.value = id
    opt.textContent = id
    langSel.appendChild(opt)
  }
  langSel.value = extToLanguage(extOf(file.name))

  const status = document.createElement('span')
  status.className = 'mmagic-code-bar__status'

  const sep1 = document.createElement('span')
  sep1.className = 'mmagic-code-bar__sep'
  const sep2 = document.createElement('span')
  sep2.className = 'mmagic-code-bar__sep'
  bar.append(toolbar.el, sep1, formatBtn, sep2, findBtn, langSel, fontDecBtn, fontIncBtn, status)

  /** 状态 → 工具栏同步（单口径出口；每次状态翻转全量刷一遍，量小无性能面）。
   *  dirty 只走保存钮红点（setDirty），「未保存」文字徽标口径退役（一百四十三番） */
  function syncBar(): void {
    for (const btn of bar.querySelectorAll<HTMLButtonElement>('[data-edit-only]')) {
      btn.hidden = readonlyMode
    }
    toolbar.setReadonly(readonlyMode)
    toolbar.setBusy(saving || readonlyMode)
    toolbar.setDirty(dirty && !readonlyMode)
    const model = editor.getModel()
    toolbar.setHistory(model?.canUndo() ?? false, model?.canRedo() ?? false)
    bar.classList.toggle('is-readonly', readonlyMode)
    if (readonlyMode) {
      status.innerHTML = '<i class="ri-lock-line"></i>'
      status.appendChild(document.createTextNode(ctx.t(READONLY_KEY)))
    } else {
      status.textContent = ''
    }
  }

  // 7) 只读闩锁（运行期）：putObject 拒 4305（单文件无 save 段，写链不存在）→ editor 只读 +
  //    工具栏隐藏编辑类钮 + 只读徽标；dirty 复位（写不出去的内容无「未保存」可言，关闭不再拦）
  function isWriteDenied(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === ERROR_CODES.UNSUPPORTED_MODE
    )
  }
  function enterReadonly(): void {
    readonlyMode = true
    dirty = false
    editor.updateOptions({ readOnly: true })
    syncBar()
  }

  // 8) 保存链：getValue → Blob → putObject → notify('saved') → dirty 复位（口径同既有契约）
  async function save(): Promise<void> {
    if (saving || readonlyMode) return // 保存中/只读：本次触发丢弃（防重入，不排队）
    saving = true
    syncBar()
    try {
      const value = editor.getValue()
      await ctx.putObject(file.key, new Blob([value], { type: 'text/plain;charset=utf-8' }))
      ctx.notify('saved', { key: file.key })
      dirty = false
    } catch (err) {
      if (isWriteDenied(err)) enterReadonly()
      // 其余失败：保持 dirty（beforeDispose 仍会拦），不误报已保存
      // 可见化出口（一百四十二番追补·宿主可写域补口）：ctx 带 notifyAppError 即上报宿主
      // bus 'error'（凭据拒 4002/4003 → 宿主换签重载; 其余码 → 宿主 toast）
      const sdkErr = err as { code?: unknown; message?: unknown } | null
      ctx.notifyAppError?.({
        code: typeof sdkErr?.code === 'number' ? sdkErr.code : 0,
        message: typeof sdkErr?.message === 'string' ? sdkErr.message : String(err),
      })
    } finally {
      saving = false
      syncBar()
    }
  }

  // 9) monaco 动作：查找/格式化走 getAction（无格式化器时 monaco 静默提示，不抛错）
  function runAction(id: string): void {
    void editor.getAction(id)?.run()
  }
  /** 字号增减（本地状态权威，边界 9–32；updateOptions 触发 monaco 重排，automaticLayout 兜底布局） */
  function nudgeFont(delta: number): void {
    fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + delta))
    editor.updateOptions({ fontSize })
  }

  // 10) dirty 跟踪：任何内容变化（含格式化/undo/redo）→ 保存钮红点；reset 的程序化改写不入 dirty
  //     （suppressDirty 闸：executeEdits 同步触发 onDidChangeModelContent，先标记后复位）
  let suppressDirty = false
  editor.onDidChangeModelContent(() => {
    if (suppressDirty) return
    dirty = true
    syncBar()
  })

  /** 重置：放弃未保存修改，恢复到打开时内容（最后保存态）。dirty 才有意义；
   *  可撤销——executeEdits 入 undo 栈，reset 后 Ctrl+Z 可取回未保存内容（dirty 随内容变化复归） */
  function resetToSaved(): void {
    if (saving || readonlyMode || !dirty) return
    const model = editor.getModel()
    if (!model) return
    suppressDirty = true
    try {
      editor.executeEdits('mmagic-reset', [{ range: model.getFullModelRange(), text }])
    } finally {
      suppressDirty = false
    }
    dirty = false
    syncBar()
  }

  // 11) 工具栏接线（signal 统一注册，dispose 随 ac.abort 全量摘除；簇内四钮回调在 §6 createEditToolbar）
  formatBtn.addEventListener('click', () => void doFormat(), { signal: ac.signal })
  findBtn.addEventListener('click', () => runAction(ACTION_FIND), { signal: ac.signal })
  fontIncBtn.addEventListener('click', () => nudgeFont(1), { signal: ac.signal })
  fontDecBtn.addEventListener('click', () => nudgeFont(-1), { signal: ac.signal })
  langSel.addEventListener(
    'change',
    () => {
      const model = editor.getModel()
      if (model) monaco.editor.setModelLanguage(model, langSel.value)
    },
    { signal: ac.signal },
  )

  // 12) 快捷键：容器捕获阶段监听（monaco 内部按键不吞捕获；测试可直接向 el 派发）
  //     Ctrl/Cmd+S 保存（既有链）；Ctrl/Cmd+F 查找（统一走 actions.find，拦浏览器默认页内查找）；
  //     Ctrl/Cmd+Z/Y 不拦——monaco 原生 undo/redo 接管
  function onKeyDown(ev: Event): void {
    const ke = ev as KeyboardEvent
    if (!(ke.ctrlKey || ke.metaKey) || ke.altKey) return
    const key = ke.key.toLowerCase()
    if (key === 's') {
      ke.preventDefault() // 拦浏览器默认「保存网页」
      ke.stopPropagation()
      void save()
    } else if (key === 'f') {
      ke.preventDefault()
      ke.stopPropagation()
      runAction(ACTION_FIND)
    }
  }
  el.addEventListener('keydown', onKeyDown, { capture: true, signal: ac.signal })

  // 13) savedState 恢复：切回 tab 重跑时还原视口（光标/滚动），并夺焦
  const prev = savedState as { viewState?: monacoEditorNS.ICodeEditorViewState } | undefined
  if (prev && typeof prev === 'object' && 'viewState' in prev && prev.viewState) {
    editor.restoreViewState(prev.viewState)
    editor.focus()
  }

  syncBar() // 初始状态刷一遍（干净态：无徽标）

  return {
    // getState：切 tab 时存视口；savedState 形状统一为 { viewState }
    getState: () => ({ viewState: editor.saveViewState() }),

    // beforeDispose 契约：非 dirty 同步放行；dirty 与 3s 超时竞速（confirm 卡死强制放行）；
    // expired/destroy=通知式，跳过询问直接放行（v1.1 reason 显式化，修「过期仍弹未保存确认」）
    beforeDispose: (reason?: DisposeReason): boolean | Promise<boolean> => {
      if (reason && reason !== 'close') return true
      if (!dirty) return true
      let timer: ReturnType<typeof setTimeout> | undefined
      const guard = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), BEFORE_DISPOSE_TIMEOUT_MS)
      })
      const asked = askUser(ctx.t(UNSAVED_KEY)).finally(() => {
        if (timer !== undefined) clearTimeout(timer) // 用户先应答：撤掉超时闸
      })
      return Promise.race([asked, guard])
    },

    // dispose：摘监听（ac.abort）→ 销毁 editor → 销毁 model → 清容器并还原 el 内联样式。
    // 顺序红线（DEF-1，test-report/2026-10-18-01）：必须先 editor.dispose 后 model.dispose——
    // 反序（model 先亡）会让 editor.dispose 的 setModel(null) 在 model 半死态下同步二连触发
    // Monaco 内部 emitter 队列，而队列投递走微任务，重入改写迭代数组 → uncaught `undefined[0]`
    // （600ms 节奏连开预览稳定复现）。同步段自包 try/catch：宿主 teardown 的 catch 拦不住
    // 微任务异常，同步段异常就地消化（CODE_DISPOSE_ERR），不阻断容器归还。
    dispose: () => {
      ac.abort()
      unobserveTheme()
      try {
        const model = editor.getModel()
        editor.dispose()
        model?.dispose()
      } catch (err) {
        console.warn('CODE_DISPOSE_ERR', String(err)?.slice(0, 200))
      }
      el.replaceChildren()
      el.style.removeProperty('position')
    },
  }
}
