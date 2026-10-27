/**
 * 图片查看渲染器（内置应用 image-viewer 的 renderer，M2-R3）
 * 契约：《docs/product/PRD.md》§一——<img> + viewerjs（缩放/旋转）。
 *
 * 数据流：ctx.getObject(key) → Blob → URL.createObjectURL → <img>（max-width:100%）挂 el；
 * 图片 load 成功后建 Viewer（navbar 关、toolbar 开，全屏查看走 viewerjs 自己的容器）；
 * 加载失败（error 事件）→ 撤图换提示节点 ctx.t('app.image-load-fail')。
 * 生命周期：dispose=abort 监听 + viewer.destroy + revokeObjectURL + 还原 el（可重入幂等）。
 * viewerjs 轻小，顶层静态 import（CSS 由打包器承接；测试环境 vitest 对 CSS 侧影响零）。
 *
 * Lane F6：展示路径抽为 mountImageViewer 导出——heic-viewer 转码后的 JPEG 复用同一链路
 * （objectURL/Viewer/失败降级/dispose 口径一致，不再复制一份）。
 */
import Viewer from 'viewerjs'
import 'viewerjs/dist/viewer.css'
import type { AppCtx, AppDefinition, AppInstance } from '../../sdk/types'

export interface MountImageViewOptions {
  /** <img alt>（可访问性，用文件名） */
  alt: string
  /** 加载失败提示文案（宿主词典译文，由调用方 ctx.t 产出） */
  failText: string
}

/**
 * Blob → objectURL → <img> + viewerjs 展示路径（image-viewer / heic-viewer 共用）。
 * 同步装载（Blob 已在手）；objectURL 归属本实例：仅 dispose 时回收（失败路径不提前 revoke，
 * 保引用一致）。返回完整 AppInstance。
 */
export function mountImageViewer(el: HTMLElement, blob: Blob, opts: MountImageViewOptions): AppInstance {
  // objectURL 归属本实例：仅 dispose 时回收（失败路径不提前 revoke，保引用一致）
  const url = URL.createObjectURL(blob)

  const wrapper = document.createElement('div')
  wrapper.className = 'mmagic-image-view'
  const img = document.createElement('img')
  img.alt = opts.alt
  img.style.maxWidth = '100%'
  img.src = url
  wrapper.appendChild(img)
  el.appendChild(wrapper)

  let viewer: Viewer | null = null
  let disposed = false

  // load/error 监听统一走 AbortController：dispose 后自动失效，且 disposed 守卫双保险
  const ac = new AbortController()
  img.addEventListener(
    'load',
    () => {
      if (disposed) return
      // Viewer 挂在图片容器上：viewerjs 自行扫描容器内 <img> 并接管全屏查看
      viewer = new Viewer(wrapper, { navbar: false, toolbar: true })
    },
    { signal: ac.signal },
  )
  img.addEventListener(
    'error',
    () => {
      if (disposed) return
      // 失败降级：撤 <img> 换提示节点（URL 仍由 dispose 统一回收）
      wrapper.replaceChildren()
      const tip = document.createElement('div')
      tip.className = 'mmagic-image-fail'
      tip.textContent = opts.failText
      wrapper.appendChild(tip)
    },
    { signal: ac.signal },
  )

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      ac.abort()
      viewer?.destroy()
      viewer = null
      wrapper.remove()
      URL.revokeObjectURL(url)
    },
  }
}

/** 图片查看渲染器（内置应用 image-viewer） */
export const imageViewRenderer: AppDefinition['renderer'] = async (el, file, ctx: AppCtx) => {
  const blob = await ctx.getObject(file.key)
  return mountImageViewer(el, blob, { alt: file.name, failText: ctx.t('app.image-load-fail') })
}
