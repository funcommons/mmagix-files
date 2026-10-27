/**
 * PDF 渲染器（两级降级）——M2-R2，Lane F6 增 pdf.js 二级
 * 契约：《docs/product/PRD.md》§一（pdf-viewer 行「iframe 原生 → 降级 pdf.js」）+
 *       《docs/design/plugin-system.md》V1.1 §二 ctx 能力面（凭证不出、字节流进出）。
 *
 * 降级判定（唯一口径）：navigator.pdfViewerEnabled——
 *  - true / undefined（老浏览器无此字段，内置查看器能力未知）→ 一级：原生 iframe
 *    （ctx.getObject→Blob→objectURL→<iframe src=blobUrl>，浏览器内置查看器接管滚动/缩放/打印）；
 *  - 显式 false（浏览器未启用内置 PDF 查看器，如部分 Firefox 配置）→ 二级：动态 import
 *    pdfjs-dist 自绘（worker 经 'pdfjs-dist/build/pdf.worker.min.mjs?url' 引入），
 *    最小可用面=首页渲染 + 上一页/下一页/页码（文案复用既有 app.csv-prev/app.csv-next「上一页/
 *    下一页」键，本波次不新增 locales；页码为纯数字 n / total，无需词条）。
 * 失败面：getObject 拿不到 / pdf.js import 或渲染失败 → 自捕获错误提示节点
 *    （ctx.t('app.pdf-load-fail')，不向调用侧抛出）；翻页渲染失败静默（保留当前画面）。
 * 生命周期：一级 dispose=remove iframe + revokeObjectURL；二级 dispose=loadingTask.destroy
 *    （释放 worker/文档堆）+ 摘监听 + 清容器；均可重入幂等。
 */
import type { AppCtx, AppDefinition, AppInstance } from '../../sdk/types'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'

/** i18n key：PDF 字节流加载/渲染失败提示（词典在 locales，主线收口） */
const PDF_LOAD_FAIL_KEY = 'app.pdf-load-fail'
/** i18n key：翻页按钮——复用既有「上一页/下一页」通用文案键（csv-table 同款，词典不新增） */
const PREV_KEY = 'app.csv-prev'
const NEXT_KEY = 'app.csv-next'
/** i18n key：首页渲染前的页码占位（common.loading 已有） */
const LOADING_KEY = 'common.loading'

/** pdf.js 自绘缩放：1.5 倍（清晰度与 canvas 面积折中；最小可用面不做 responsive） */
const RENDER_SCALE = 1.5

/** 错误提示节点（文案走宿主词典；样式对齐 media/docx 渲染器口径） */
function buildFailTip(ctx: AppCtx): HTMLDivElement {
  const tip = document.createElement('div')
  tip.textContent = ctx.t(PDF_LOAD_FAIL_KEY)
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  return tip
}

/** 一级降级：原生 iframe（blob URL；浏览器内置 PDF 查看器接管） */
function mountNativeFrame(el: HTMLElement, blob: Blob, fileName: string): AppInstance {
  const url = URL.createObjectURL(blob)
  const frame = document.createElement('iframe')
  frame.title = fileName
  frame.src = url
  // 占满容器（容器侧负责高度）；无边框避免与外层 tab 样式叠边
  frame.style.width = '100%'
  frame.style.height = '100%'
  frame.style.border = 'none'
  el.appendChild(frame)

  return {
    dispose: () => {
      frame.remove()
      URL.revokeObjectURL(url)
    },
  }
}

/**
 * 二级降级：pdf.js 自绘（首页 + 上一页/下一页/页码）。
 * import/getDocument/首页渲染任一失败 → 撤半成品换错误提示节点（不抛出）；
 * 翻页渲染失败仅静默（保留当前画面，不打断浏览）。
 */
async function mountPdfJs(el: HTMLElement, blob: Blob, ctx: AppCtx): Promise<AppInstance> {
  // 组件样式随实例注入/移除（渲染器无 SFC scope；色值全走 token，禁硬编码）
  const style = document.createElement('style')
  style.textContent = `
.mmagic-pdfjs{min-height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--app-bg-muted,#f5f5f5)}
.mmagic-pdfjs-bar{display:flex;align-items:center;justify-content:center;gap:12px;flex:none;
  padding:4px 12px;background:var(--app-bg-card,#fff);border-bottom:1px solid var(--app-separator,#e5e7eb)}
.mmagic-pdfjs-bar button{padding:2px 12px;font-size:12px;color:var(--app-text-secondary,#666);
  background:transparent;border:1px solid var(--app-separator,#e5e7eb);
  border-radius:var(--app-radius-button,6px);cursor:pointer;transition:background .15s,color .15s}
.mmagic-pdfjs-bar button:hover{background:var(--app-bg-muted,#f5f5f5);color:var(--app-text-primary,#111)}
.mmagic-pdfjs-bar button:disabled{opacity:.4;cursor:not-allowed}
.mmagic-pdfjs-page{font-size:12px;color:var(--app-text-secondary,#666);min-width:48px;text-align:center}
.mmagic-pdfjs-canvas{margin:16px auto;background:#fff;box-shadow:var(--app-shadow-sm,0 1px 4px rgba(0,0,0,.1))}
`
  const root = document.createElement('div')
  root.className = 'mmagic-pdfjs'
  const bar = document.createElement('div')
  bar.className = 'mmagic-pdfjs-bar'
  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.dataset.action = 'prev'
  prevBtn.textContent = ctx.t(PREV_KEY)
  const pageIndicator = document.createElement('span')
  pageIndicator.className = 'mmagic-pdfjs-page'
  pageIndicator.textContent = ctx.t(LOADING_KEY) // 首页渲染完成前占位
  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.dataset.action = 'next'
  nextBtn.textContent = ctx.t(NEXT_KEY)
  bar.append(prevBtn, pageIndicator, nextBtn)
  const canvas = document.createElement('canvas')
  canvas.className = 'mmagic-pdfjs-canvas'
  canvas.style.maxWidth = '100%'
  canvas.style.height = 'auto'
  root.append(bar, canvas)
  el.append(style, root)

  let task: PDFDocumentLoadingTask | null = null
  const ac = new AbortController()
  try {
    // 动态 import（库 + worker URL 双双惰性；pdfjs 体积大，绝不入主 bundle）
    const [{ getDocument, GlobalWorkerOptions }, { default: workerSrc }] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ])
    GlobalWorkerOptions.workerSrc = workerSrc
    // data 以 ArrayBuffer 传入（pdf.js 会 transfer 给 worker，Blob 读出后无需复用）
    task = getDocument({ data: await blob.arrayBuffer() })
    const doc = await task.promise

    let page = 1
    async function show(n: number): Promise<void> {
      const pdfPage = await doc.getPage(n)
      const viewport = pdfPage.getViewport({ scale: RENDER_SCALE })
      const c2d = canvas.getContext('2d')
      if (!c2d) throw new Error('canvas 2d context unavailable')
      canvas.width = viewport.width
      canvas.height = viewport.height
      // pdf.js v6：canvas 为必填（canvasContext 可选注入）；渲染入参按 v6 RenderParameters 口径
      await pdfPage.render({ canvas, canvasContext: c2d, viewport }).promise
      pageIndicator.textContent = `${n} / ${doc.numPages}`
    }

    prevBtn.addEventListener(
      'click',
      () => {
        if (page <= 1) return // 边界钳制：首页不前翻
        page -= 1
        void show(page).catch(() => {}) // 翻页失败静默：保留当前画面
      },
      { signal: ac.signal },
    )
    nextBtn.addEventListener(
      'click',
      () => {
        if (page >= doc.numPages) return // 末页不后翻
        page += 1
        void show(page).catch(() => {})
      },
      { signal: ac.signal },
    )

    await show(1) // 首页渲染属首帧：失败按整体失败降级（外层 catch）
    return {
      dispose: () => {
        ac.abort()
        style.remove()
        root.remove()
        // 释放文档/worker；失败（已销毁等）静默——dispose 不抛出
        void task?.destroy().catch(() => {})
        task = null
      },
    }
  } catch {
    // 半成品容器先撤（可能已挂出工具条/canvas），再落提示节点
    ac.abort()
    style.remove()
    root.remove()
    void task?.destroy().catch(() => {})
    task = null
    const tip = buildFailTip(ctx)
    el.appendChild(tip)
    return { dispose: () => tip.remove() }
  }
}

/** PDF 渲染器（内置应用 pdf-viewer：ext=pdf，两级降级链） */
export const pdfRenderer: AppDefinition['renderer'] = async (el, file, ctx): Promise<AppInstance> => {
  let blob: Blob
  try {
    blob = await ctx.getObject(file.key)
  } catch {
    // 字节流拿不到——提示节点 + 空 dispose，不抛出
    const tip = buildFailTip(ctx)
    el.appendChild(tip)
    return { dispose: () => tip.remove() }
  }

  // 降级判定：仅显式 false 进二级（undefined=字段不存在/老浏览器，从有内置查看器假设出发）
  if (navigator.pdfViewerEnabled !== false) {
    return mountNativeFrame(el, blob, file.name)
  }
  return mountPdfJs(el, blob, ctx)
}
