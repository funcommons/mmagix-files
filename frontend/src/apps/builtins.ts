/**
 * 内置应用预置表——正本：《docs/product/PRD.md》§一应用清单
 * code=registry id（与计划表列一致）；label=i18n key（词典在 locales，M2 收口）；
 * renderer 由 M2 注入（registerBuiltins 的 renderers 参数），缺位时占位渲染。
 * fallback-download 不入 registry（空 matcher 语义=不命中，防吞所有类型）——
 * 由解析链「registry 无命中 → fallback」显式处理（见 resolveOrFallback）。
 */
import { AppRegistry } from './registry'
import type { AppAction, AppDefinition, AppMatcher } from '../sdk/types'

export const FALLBACK_APP_ID = 'fallback-download'

// ───────────────────────── 渲染器字节限额（R2-03 单一事实源） ─────────────────────────
// 本表是唯一正本：BUILTIN_APP_SPECS 的 maxBytes（预览闸读 def.maxBytes 取实际拒绝线）
// 与各渲染器内部防线（csv/markdown/code 的既有常量）共用同一导出常量——渲染器 import 这里的值，
// 杜绝「预览闸 50MB × 渲染器 20MB」两套字面量各自漂移（R2-03 双闸叠加事故的根因）。
// heic.ts 不在本 lane 可写范围：其 MAX_HEIC_BYTES=32MiB 与 HEIC_VIEWER_MAX_BYTES 保持同值，
// 修改时必须两处同步（两常量当前相等，见该渲染器常量注释）。
export const MARKDOWN_MAX_BYTES = 5 * 1024 * 1024
export const CODE_MAX_BYTES = 5 * 1024 * 1024
export const CSV_TABLE_MAX_BYTES = 20 * 1024 * 1024

/** html-viewer 预览上限（对齐 html-editor 插件口径——html 资产内联后的合理上界） */
export const HTML_VIEWER_MAX_BYTES = 20 * 1024 * 1024
export const HEIC_VIEWER_MAX_BYTES = 32 * 1024 * 1024
export const MERMAID_MAX_BYTES = 5 * 1024 * 1024
/** zip-browser 预览上限（M4-UI：在线解压按 Range 读，不做整包入内存；embed 可经 openFile 的
 *  appOptions.unzipMaxBytes 覆盖渲染器内防线值，缺省同源此常量——见 renderers/zip.ts） */
export const ZIP_BROWSER_MAX_BYTES = 512 * 1024 * 1024

export interface BuiltinAppSpec {
  code: string
  labelKey: string
  type: 'view' | 'edit'
  matcher: AppMatcher
  actions: AppAction[]
  /** 渲染器字节限额（缺省=无渲染器级限额；预览闸实际拒绝线=min(PREVIEW_REJECT, maxBytes)） */
  maxBytes?: number
}

export const BUILTIN_APP_SPECS: BuiltinAppSpec[] = [
  { code: 'image-viewer', labelKey: 'app.image-viewer', type: 'view', matcher: { ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'] }, actions: ['preview'] },
  { code: 'video-player', labelKey: 'app.video-player', type: 'view', matcher: { ext: ['mp4', 'webm', 'mov'] }, actions: ['preview'] },
  { code: 'audio-player', labelKey: 'app.audio-player', type: 'view', matcher: { ext: ['mp3', 'wav', 'ogg', 'flac', 'm4a'] }, actions: ['preview'] },
  { code: 'pdf-viewer', labelKey: 'app.pdf-viewer', type: 'view', matcher: { ext: ['pdf'] }, actions: ['preview'] },
  { code: 'markdown-renderer', labelKey: 'app.markdown-renderer', type: 'view', matcher: { ext: ['md', 'markdown'] }, actions: ['preview'], maxBytes: MARKDOWN_MAX_BYTES },
  // 图示双应用（设计正本《流程图应用设计（Mermaid+X6）》§六）：editor 默认（graph TD 可视化编辑），
  // viewer 经「打开方式」可达（其余 mermaid 语法 mindmap/sequence/architecture 只走 viewer）
  { code: 'flow-editor', labelKey: 'app.flow-editor', type: 'edit', matcher: { ext: ['mmd', 'mermaid'] }, actions: ['edit'], maxBytes: MERMAID_MAX_BYTES },
  { code: 'mermaid-viewer', labelKey: 'app.mermaid-viewer', type: 'view', matcher: { ext: ['mmd', 'mermaid'] }, actions: ['preview'], maxBytes: MERMAID_MAX_BYTES },
  // F3：渲染类应用先于 code-editor 注册（注册序=默认应用优先级）——
  // csv/tsv 默认进 csv-table 表格预览，code-editor 的文本态经「打开方式」可达（不再抢占默认）。
  { code: 'csv-table', labelKey: 'app.csv-table', type: 'view', matcher: { ext: ['csv', 'tsv'] }, actions: ['preview'], maxBytes: CSV_TABLE_MAX_BYTES },
  // html 同口径：默认进 html-viewer 净化式预览（sandbox srcdoc + 跳转代理=确认后新 tab，同 html-editor
  // 插件预览态）；code-editor 源码态与 html-editor 插件三态编辑均经「打开方式」可达。
  { code: 'html-viewer', labelKey: 'app.html-viewer', type: 'view', matcher: { ext: ['html', 'htm'] }, actions: ['preview'], maxBytes: HTML_VIEWER_MAX_BYTES },
  {
    code: 'code-editor',
    labelKey: 'app.code-editor',
    type: 'edit',
    matcher: {
      ext: [
        'txt', 'log', 'conf', 'ini', 'env',
        'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'php', 'rb', 'swift', 'kt',
        'sql', 'sh', 'yaml', 'yml', 'json', 'xml', 'html', 'css', 'scss', 'vue',
        'mmd', 'mermaid', // 图示源码态（mermaid-viewer 渲染，code-editor 文本态经「打开方式」）
        'md', 'markdown', 'csv', // 源码态/文本态（与渲染类应用并列「打开方式」）
      ],
    },
    actions: ['edit'],
    maxBytes: CODE_MAX_BYTES,
  },
  { code: 'heic-viewer', labelKey: 'app.heic-viewer', type: 'view', matcher: { ext: ['heic', 'heif'] }, actions: ['preview'], maxBytes: HEIC_VIEWER_MAX_BYTES },
  { code: 'docx-viewer', labelKey: 'app.docx-viewer', type: 'view', matcher: { ext: ['docx'] }, actions: ['preview'] },
  { code: 'xlsx-viewer', labelKey: 'app.xlsx-viewer', type: 'view', matcher: { ext: ['xlsx', 'xls'] }, actions: ['preview'] },
  // M4-UI：zip 在线解压浏览器——type=edit 诚实口径（解出会向会话目录写 `<zip名>/` 前缀对象）
  { code: 'zip-browser', labelKey: 'app.zip-browser', type: 'edit', matcher: { ext: ['zip'] }, actions: ['edit'], maxBytes: ZIP_BROWSER_MAX_BYTES },
]

/** 占位渲染器（M2 逐应用替换；保证注册表先通、渲染后行） */
function placeholderRenderer(code: string): AppDefinition['renderer'] {
  return (el) => {
    const tip = document.createElement('div')
    tip.textContent = `[${code}] renderer pending (M2)`
    tip.style.padding = '16px'
    tip.style.color = 'var(--app-text-secondary, #888)'
    el.appendChild(tip)
    return { dispose: () => tip.remove() }
  }
}

/**
 * 注册内置应用到 registry。
 * renderers: code → renderer（M2 渐进补齐；未提供的 code 用占位渲染器）。
 * 返回实际注册成功的 code 集（requiresSdk/id 冲突拒载会被过滤——正常应为全集）。
 */
export function registerBuiltins(
  registry: AppRegistry,
  renderers: Partial<Record<string, AppDefinition['renderer']>> = {},
): string[] {
  const registered: string[] = []
  for (const spec of BUILTIN_APP_SPECS) {
    const def: AppDefinition = {
      id: spec.code,
      matcher: spec.matcher,
      actions: spec.actions,
      label: spec.labelKey,
      version: '1.0.0',
      requiresSdk: 1,
      // R2-03：限额登记透传——预览闸读 def.maxBytes 收敛实际拒绝线（min(PREVIEW_REJECT, maxBytes)）
      ...(spec.maxBytes !== undefined ? { maxBytes: spec.maxBytes } : {}),
      renderer: renderers[spec.code] ?? placeholderRenderer(spec.code),
    }
    const result = registry.register(def)
    if (result.ok) registered.push(spec.code)
  }
  return registered
}
