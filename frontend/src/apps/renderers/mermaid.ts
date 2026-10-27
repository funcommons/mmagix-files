/**
 * Mermaid 图示渲染器（mermaid-viewer）——graph TD / mindmap / sequenceDiagram /
 * architecture-beta 等四类图（及 mermaid 支持的其余语法）的只读渲染。
 * 设计正本：《docs/design/flow-editor-design.md》《docs/design/diagram-roadmap.md》
 * 管线：ctx.getObject → Blob.text() → 动态 import('mermaid') → mermaid.render → SVG 注入。
 * 安全：securityLevel:'strict'（源文本中的 HTML/事件一律不执行）；SVG 产物为 mermaid 生成，非源 HTML。
 * 超限：与 spec.maxBytes（MERMAID_MAX_BYTES）同源防御纵深（R2-03 口径）。
 * 失败：语法/环境渲染失败 → 错误提示节点不抛出（AI 生成文本可能非法——失败即兜底，不崩工作台）。
 */
import { MERMAID_MAX_BYTES } from '../builtins'
import { formatBytes } from '../../files/format'
import type { AppCtx, AppDefinition, AppInstance } from '../../sdk/types'

const TOO_LARGE_KEY = 'app.mermaid-too-large'
const LOAD_FAIL_KEY = 'app.mermaid-load-fail'

/** 超限只读提示（markdown.ts showTooLargeTip 同款口径） */
function showTooLargeTip(el: HTMLElement, ctx: AppCtx): AppInstance {
  const tip = document.createElement('div')
  tip.className = 'mermaid-too-large-tip'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = ctx.t(TOO_LARGE_KEY, { limit: formatBytes(MERMAID_MAX_BYTES) })
  el.replaceChildren(tip)
  return { dispose: () => void (el.innerHTML = '') }
}

/** 渲染失败提示节点（不抛出——图挂了不能带崩预览区） */
function buildFailTip(el: HTMLElement, ctx: AppCtx): AppInstance {
  const tip = document.createElement('div')
  tip.className = 'mmagic-mermaid-fail'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = ctx.t(LOAD_FAIL_KEY)
  el.replaceChildren(tip)
  return { dispose: () => void (el.innerHTML = '') }
}

/** 组件样式随实例注入/移除（渲染器无 SFC scope；色值走 token） */
function buildStyle(): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = `
.mmagic-mermaid{min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;
  align-items:center;padding:16px;background:var(--app-bg-card,#fff);overflow:auto}
.mmagic-mermaid svg{max-width:100%;height:auto}
`
  return style
}

/** mermaid.render 需要 DOM 内唯一 id（多 tab/重渲染防撞） */
let renderSeq = 0

export const mermaidViewerRenderer: AppDefinition['renderer'] = async (el, file, ctx) => {
  const blob = await ctx.getObject(file.key)

  if (blob.size > MERMAID_MAX_BYTES) {
    return showTooLargeTip(el, ctx)
  }

  const text = await blob.text()
  const style = buildStyle()
  const view = document.createElement('div')
  view.className = 'mmagic-mermaid'
  el.replaceChildren(style, view)

  try {
    // 动态 import：mermaid 体积大，绝不入主 bundle（markdown.ts enhanceMermaid 同口径）
    const mermaid = (await import('mermaid')).default
    // suppressErrorRendering：mermaid 12 render() 失败会自行向 DOM 注入全幅错误图——关闭，
    // 失败呈现统一走下方 buildFailTip（紧凑提示节点）
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true })
    const { svg } = await mermaid.render(`mmf-mmd-${++renderSeq}`, text)
    view.innerHTML = svg
    return {
      dispose: () => {
        style.remove()
        view.remove()
      },
    }
  } catch {
    // 半成品容器先撤，再落提示节点
    style.remove()
    view.remove()
    return buildFailTip(el, ctx)
  }
}
