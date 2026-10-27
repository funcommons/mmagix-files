/**
 * HEIC 转码预览渲染器（内置应用 heic-viewer 的 renderer，Lane F6）
 * 契约：《docs/product/PRD.md》§一（heic-viewer 行，heic2any 转码预览）+
 *       《docs/design/plugin-system.md》V1.1 §二 ctx 能力面（凭证不出、字节流进出）。
 *
 * 链路：ctx.getObject(key) → >32MB 拒转（提示下载，防 heic2any/wasm 解码整图入内存爆掉移动端）
 *       → 动态 import('heic2any')（libheif wasm 体积大，不入主 bundle，docx/mermaid 同款口径）
 *       → HEIC Blob 转 JPEG（quality 0.92）→ 复用 image.ts 的 mountImageViewer 展示路径
 *       （objectURL→<img>→viewerjs；抽公共而非复制，见 image.ts Lane F6 注记）。
 * 失败面：getObject 拿不到 / 转码失败 / import 失败 → 自捕获错误提示节点
 *       （ctx.t('app.heic-load-fail')，不向调用侧抛出，对齐 media.ts 失败节点口径）；
 *       超限 → ctx.t('app.heic-too-large')（专用下载引导键，F6 复盘后补）。
 * 生命周期：转码产物 objectURL 归 mountImageViewer 实例（dispose 统一 revoke）；本层无额外资源。
 */
import type { AppCtx, AppDefinition, AppInstance } from '../../sdk/types'
import { mountImageViewer } from './image'

/** i18n key：转码/取流失败提示 */
const IMAGE_LOAD_FAIL_KEY = 'app.heic-load-fail'
/** i18n key：超限拒转的下载引导 */
const DOWNLOAD_HINT_KEY = 'app.heic-too-large'

/** 转码上限：>32MB 拒绝（heic2any 需整图解码进 wasm 堆，超限易 OOM——提示下载兜底） */
const MAX_HEIC_BYTES = 32 * 1024 * 1024

/** 转码输出：JPEG 质量 0.92（兼容面最广、体积友好；透明图层 HEIC 本就少见） */
const CONVERT_TO_TYPE = 'image/jpeg'
const CONVERT_QUALITY = 0.92

/** 错误提示节点（样式对齐 media/pdf 渲染器口径） */
function buildTip(text: string): HTMLDivElement {
  const tip = document.createElement('div')
  tip.className = 'mmagic-heic-fail'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = text
  return tip
}

/** 失败收场：提示节点挂 el + 自捕获实例（不抛出，调用侧可无脑 dispose） */
function failWith(el: HTMLElement, text: string): AppInstance {
  const tip = buildTip(text)
  el.appendChild(tip)
  return { dispose: () => tip.remove() }
}

/** HEIC 渲染器（内置应用 heic-viewer：ext=heic/heif → 转码 JPEG → image 展示路径） */
export const heicViewerRenderer: AppDefinition['renderer'] = async (
  el,
  file,
  ctx: AppCtx,
): Promise<AppInstance> => {
  let blob: Blob
  try {
    blob = await ctx.getObject(file.key)
  } catch {
    // 字节流拿不到——提示节点，不抛出
    return failWith(el, ctx.t(IMAGE_LOAD_FAIL_KEY))
  }

  // 防内存爆：超限不转码，提示下载（既有下载引导键）
  if (blob.size > MAX_HEIC_BYTES) {
    return failWith(el, ctx.t(DOWNLOAD_HINT_KEY))
  }

  let converted: Blob
  try {
    const { default: heic2any } = await import('heic2any')
    const out = await heic2any({ blob, toType: CONVERT_TO_TYPE, quality: CONVERT_QUALITY })
    // multiple 未开 → 单 Blob；类型守卫兜多帧返回（取首帧）
    converted = Array.isArray(out) ? out[0]! : out
  } catch {
    // 坏 HEIC / 弱网 import 失败——提示节点，不抛出（docx 同款 try/catch 降级口径）
    return failWith(el, ctx.t(IMAGE_LOAD_FAIL_KEY))
  }

  return mountImageViewer(el, converted, { alt: file.name, failText: ctx.t(IMAGE_LOAD_FAIL_KEY) })
}
