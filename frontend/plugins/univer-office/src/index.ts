/**
 * Univer 文档插件（mmagix-files 动态应用）：xlsx/xls → Univer Sheets 编辑；docx → Univer Docs 编辑。
 * 契约：`export activate(sdk)` + sdk.registerApp(AppDefinition)（loader.ts 契约 §二）；
 * 保存走 ctx.putObject + ctx.notify('saved')，与内置应用同口径（Ctrl+S / 工具栏钮）。
 * 保真边界：SheetJS/mammoth 桥保值+公式+段落（复杂样式/图表不在桥内；官方高保真 exchange 为 Univer Pro）。
 */
import type { HostCtx, HostFile, HostInstance, HostSdk } from './types'
// Univer 预设样式必须显式引入（官方用法）：blob 单文件通道无独立 CSS，靠 cssInjectedByJs 内联；
// 漏引 = 组件级 .univer-* 全缺，UI 裸 DOM（曾因只加 inlineDynamicImports 断了这条链而翻车）
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-docs-core/lib/index.css'
import { workbookSnapshotToXlsxBlob, xlsxToWorkbookSnapshot } from './xlsx'
import { docSnapshotToUniver, docxToDocSnapshot, univerDocToDocxBlob } from './docx'
import { createEditToolbar } from '../../../src/shared/editToolbar'

const MAX_BYTES = 20 * 1024 * 1024
let rootSeqCounter = 0 // 实例唯一类序号（模块级：多 tab 同时开 docx/xlsx 时样式作用域互不污染）

interface UniverHandle {
  getBodyForSave: () => Record<string, unknown>
  /** 撤销/重做（FUniver facade 命令；返回是否命中） */
  undo: () => Promise<boolean>
  redo: () => Promise<boolean>
  dispose: () => void
}

type OnMutation = () => void

/** 脏标记事件订阅：Univer 1.0 = addEvent(Event.CommandExecuted)；旧版兼容 onCommandExecuted */
function wireMutations(api: unknown, onMutation: OnMutation): void {
  const a = api as {
    addEvent?: (event: unknown, cb: (params: { payload?: { id?: string } }) => void) => void
    Event?: { CommandExecuted?: unknown }
    onCommandExecuted?: (cb: (cmd: { id?: string }) => void) => void
  }
  const isMutation = (id: string): boolean => id.includes('.mutation.') || id.includes('doc.mutation')
  if (typeof a.addEvent === 'function' && a.Event?.CommandExecuted) {
    a.addEvent(a.Event.CommandExecuted, (params) => {
      // 事件形状兼容：回调参数即命令信息（id 顶层）或包一层 payload（历史版本）
      const p = params as { id?: unknown; payload?: { id?: unknown } }
      const id = String(p?.id ?? p?.payload?.id ?? '')
      if (isMutation(id)) onMutation()
    })
  } else if (typeof a.onCommandExecuted === 'function') {
    a.onCommandExecuted((cmd) => {
      if (isMutation(String(cmd?.id ?? ''))) onMutation()
    })
  }
}

async function mountSheets(container: HTMLElement, snapshot: Record<string, unknown>, onMutation: OnMutation): Promise<UniverHandle> {
  const { createUniver, defaultTheme, LocaleType, mergeLocales } = await import('@univerjs/presets')
  const { UniverSheetsCorePreset } = await import('@univerjs/preset-sheets-core')
  const zh = (await import('@univerjs/preset-sheets-core/locales/zh-CN')).default
  const { univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: mergeLocales(zh) },
    presets: [UniverSheetsCorePreset({ container })],
  })
  univerAPI.createWorkbook(snapshot as never)
  wireMutations(univerAPI, onMutation)
  return {
    getBodyForSave: () => (univerAPI.getActiveWorkbook()?.save() ?? {}) as Record<string, unknown>,
    undo: () => univerAPI.undo(),
    redo: () => univerAPI.redo(),
    dispose: () => univerAPI.dispose(),
  }
}

async function mountDocs(container: HTMLElement, docSnapshot: Record<string, unknown>, onMutation: OnMutation): Promise<UniverHandle> {
  const { createUniver, defaultTheme, LocaleType, mergeLocales } = await import('@univerjs/presets')
  const { UniverDocsCorePreset } = await import('@univerjs/preset-docs-core')
  const zh = (await import('@univerjs/preset-docs-core/locales/zh-CN')).default
  const { univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: mergeLocales(zh) },
    presets: [UniverDocsCorePreset({ container })],
  })
  univerAPI.createDocument(docSnapshot as never)
  wireMutations(univerAPI, onMutation)
  return {
    getBodyForSave: () => {
      const doc = univerAPI.getActiveDocument()
      const snap = (doc?.save?.() ?? {}) as { body?: Record<string, unknown> }
      return snap.body ?? {}
    },
    undo: () => univerAPI.undo(),
    redo: () => univerAPI.redo(),
    dispose: () => univerAPI.dispose(),
  }
}

async function render(el: HTMLElement, file: HostFile, ctx: HostCtx): Promise<HostInstance> {
  const isDocx = /\.docx$/i.test(file.name)
  const bytes = await (await ctx.getObject(file.key)).arrayBuffer()

  // 骨架：Univer 容器铺满；保存/未保存徽标浮动在 ribbon 首行左侧空位（单行化，不占独立行）
  // 实例唯一类：样式按实例作用域（多 tab 开 docx+xlsx 时，docx 的灰底/透明规则不得命中 xlsx 实例）
  const rootSeq = (rootSeqCounter += 1)
  const root = document.createElement('div')
  root.classList.add('mmu-univer-root', `mmu-univer-root-${rootSeq}`)
  root.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:#fff;z-index:0'
  const bar = document.createElement('div')
  bar.style.cssText =
    'position:absolute;top:0;left:10px;z-index:30;display:flex;align-items:center;gap:8px;height:40px;font-size:12px;color:#666;pointer-events:none'
  // 统一编辑钮簇（一百四十三番：保存红点｜撤销 重做 重置——样式唯源 shared/editToolbar，构建期内联）。
  // undo/redo 走 FUniver facade 命令；重置=按打开时字节整体重挂（保真边界：Univer 无批量 revert 通道）。
  // 徽标通道取消：dirty 一律=保存钮红点，「未保存」文字废弃
  const toolbarCtl = createEditToolbar(
    { save: ctx.t('app.edt-save'), undo: ctx.t('app.edt-undo'), redo: ctx.t('app.edt-redo'), reset: ctx.t('app.edt-reset') },
    {
      onSave: () => void save(),
      onUndo: () => void univer.undo(),
      onRedo: () => void univer.redo(),
      onReset: () => void remountOriginal(),
    },
  )
  toolbarCtl.el.style.cssText = 'pointer-events:auto'
  bar.appendChild(toolbarCtl.el)
  const container = document.createElement('div')
  // 灰底（WPS/Word 观感）：Univer 画布纸外区域是透明的，灰底由容器透出——白纸浮于灰底，纸界清晰
  container.style.cssText = 'flex:1;min-height:0;position:relative;background:#d8d8d8'
  // docx：Univer 1.0.4 会画一根幻影水平滚动条（无可滚内容、拖拽无响应，见方案备注）——用灰底遮蔽条盖掉；
  // pointer-events:none 保持画布事件穿透；仅遮底部条带，不影响其余区域
  const hbarCover = document.createElement('div')
  hbarCover.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:16px;background:#d8d8d8;pointer-events:none;z-index:9'
  root.append(container, bar)
  if (isDocx) container.appendChild(hbarCover)
  el.style.position = 'relative'
  el.appendChild(root)

  // 单行化：Univer header（<header> 标签，无稳定类名）的页签条与工具条并排一行；左侧留出保存钮空间
  // 灰底（仅 docx）：文档画布纸外像素透明，给视口 section 灰底并覆盖引擎给 canvas 的内联白底；
  // sheets 不做此覆盖——表格空白格依赖 canvas 白底兜底，透明化会让灰底透进单元格区
  const compact = document.createElement('style')
  compact.textContent = `
.mmu-univer-root-${rootSeq} header { display:flex !important; flex-direction:row !important; align-items:center !important; padding-left:150px; }
.mmu-univer-root-${rootSeq} header > div:nth-child(1) { flex:none; }
.mmu-univer-root-${rootSeq} header > div:nth-child(2) { flex:1 1 auto; min-width:0; }
${isDocx ? `
.mmu-univer-root-${rootSeq} section.univer-overflow-hidden { background: #d8d8d8 !important; }
.mmu-univer-root-${rootSeq} section.univer-overflow-hidden canvas { background: transparent !important; }
` : ''}
`
  document.head.appendChild(compact)

  const markDirty = () => {
    dirty = true
    toolbarCtl.setDirty(true)
  }
  const clearDirty = () => {
    dirty = false
    toolbarCtl.setDirty(false)
  }
  let dirty = false
  let disposed = false
  let saving = false
  const onMutation = (): void => {
    if (!disposed) markDirty()
  }

  let univer = await (isDocx
    ? mountDocs(container, docSnapshotToUniver(await docxToDocSnapshot(bytes)), onMutation)
    : mountSheets(container, xlsxToWorkbookSnapshot(bytes), onMutation))

  // 布局稳定后通知一次 resize：单行化 CSS 合并 ribbon 行会改变容器宽度，
  // Univer 的纸张/网格定位在初始化时计算，不重排会残留旧偏移（纸右缘出界）
  setTimeout(() => window.dispatchEvent(new Event('resize')), 350)

  const save = async (): Promise<void> => {
    if (disposed || saving || !dirty) return
    saving = true
    toolbarCtl.setBusy(true)
    try {
      const blob = isDocx
        ? await univerDocToDocxBlob(univer.getBodyForSave() as never, file.name)
        : workbookSnapshotToXlsxBlob(univer.getBodyForSave())
      await ctx.putObject(file.key, blob)
      ctx.notify('saved', { key: file.key })
      clearDirty()
    } catch (err) {
      console.warn('UNIVER_SAVE_ERR', String(err)?.slice(0, 200))
    } finally {
      saving = false
      toolbarCtl.setBusy(false)
    }
  }

  /** 重置：按打开时字节整体重挂（丢弃全部未保存修改；Univer 无批量 revert 通道，重挂=唯一权威回滚） */
  let remounting = false
  async function remountOriginal(): Promise<void> {
    if (disposed || remounting || !dirty) return
    remounting = true
    toolbarCtl.setBusy(true)
    try {
      univer.dispose()
      container.textContent = ''
      if (isDocx) container.appendChild(hbarCover)
      univer = await (isDocx
        ? mountDocs(container, docSnapshotToUniver(await docxToDocSnapshot(bytes)), onMutation)
        : mountSheets(container, xlsxToWorkbookSnapshot(bytes), onMutation))
      clearDirty()
    } catch (err) {
      console.warn('UNIVER_REMOUNT_ERR', String(err)?.slice(0, 200))
    } finally {
      remounting = false
      toolbarCtl.setBusy(false)
    }
  }
  const onKey = (ev: KeyboardEvent): void => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void save()
    }
  }
  window.addEventListener('keydown', onKey)

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      window.removeEventListener('keydown', onKey)
      univer.dispose()
      root.remove()
    },
    beforeDispose: () => {
      if (!dirty) return true
      const ans = window.confirm(ctx.t('app.code-unsaved')) as boolean | Promise<boolean>
      return Promise.race([Promise.resolve(ans), new Promise<boolean>((r) => setTimeout(() => r(true), 3000))])
    },
  }
}

export function activate(sdk: HostSdk): void {
  sdk.registerApp({
    id: 'univer-office',
    matcher: { ext: ['xlsx', 'xls', 'docx'] },
    label: 'app.univer-office',
    actions: ['edit'],
    version: '1.0.0',
    requiresSdk: 1,
    maxBytes: MAX_BYTES,
    renderer: render,
  })
}
