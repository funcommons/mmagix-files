/**
 * docx 渲染器（内置应用 docx-viewer 的 renderer，M2-R5——M4 内容提前）
 * 契约：《docs/product/PRD.md》§一（docx-viewer 行，docx-preview 还原度中上）+
 *       《docs/design/plugin-system.md》V1.1 §二 ctx 能力面（凭证不出、字节流进出）。
 * 链路：ctx.getObject(key) → Blob.arrayBuffer → 动态 import('docx-preview') →
 *       renderAsync(buffer, 容器, undefined, { inWrapper: true })。
 *       docx-preview 体积大，动态 import 不入主 bundle（R1 mermaid 同款口径）。
 * 生命周期：dispose=容器 remove；任何一步失败（getObject/读流/import/renderAsync）→
 *       撤半成品容器换错误提示节点（ctx.t('app.docx-load-fail')），不向调用侧抛出。
 */
import type { AppCtx, AppDefinition } from '../../sdk/types'

/** i18n key：docx 加载失败提示（键照用，文案待主线在 locales 词典补录） */
const DOCX_LOAD_FAIL_KEY = 'app.docx-load-fail'

/** 错误提示节点（文案走宿主词典；样式对齐 pdf/media 渲染器口径） */
function buildFailTip(ctx: AppCtx): HTMLDivElement {
  const tip = document.createElement('div')
  tip.className = 'docx-load-fail'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = ctx.t(DOCX_LOAD_FAIL_KEY)
  return tip
}

export const docxRenderer: AppDefinition['renderer'] = async (el, file, ctx) => {
  let view: HTMLDivElement | undefined
  try {
    const blob = await ctx.getObject(file.key)
    const buffer = await blob.arrayBuffer()
    // 动态 import（bundle 重量）；jsdom/弱网下 import 失败同样进 catch 降级
    const { renderAsync } = await import('docx-preview')

    // 白底 + padding：docx 版式自带页边距，容器只给纸面底色与内边距
    view = document.createElement('div')
    view.className = 'docx-view'
    view.style.background = '#fff'
    view.style.padding = '16px'
    el.appendChild(view)

    await renderAsync(buffer, view, undefined, { inWrapper: true })
    // 横向滚动修正：docxjs 的 .docx-wrapper 是 flex+align-items:center——页面比宿主宽时
    // 「不安全居中」两侧对称溢出（左缘不可达、scrollWidth 传播不稳）。改 max-content 包宽：
    // wrapper 与页面同宽→溢出精确传播到宿主滚动容器（宿主底缘出横向滚动条，左缘可达）
    const wrap = view.querySelector<HTMLElement>('.docx-wrapper')
    if (wrap) {
      wrap.style.width = 'max-content'
      wrap.style.minWidth = '100%'
    }
    return { dispose: () => view?.remove() }
  } catch {
    // 半成品容器先撤（renderAsync 中途失败可能已注入部分 DOM），再落提示节点
    view?.remove()
    const tip = buildFailTip(ctx)
    el.appendChild(tip)
    return { dispose: () => tip.remove() }
  }
}
