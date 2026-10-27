/**
 * 媒体渲染器（video/audio）——M2-R2，Lane F6 增媒体直链优先
 * 契约：《docs/product/PRD.md》§一（video-player/audio-player 行「Range 请求拖动进度」）+
 *       《docs/design/plugin-system.md》V1.1 §二 ctx 能力面（凭证不出、字节流进出）。
 * 链路（两级）：
 *  1) ctx 带 getMediaUrl 能力（装配层透传 datasource.getMediaUrl，预签名 URL）→ 直接作
 *     <video|audio src>——「Range 拖动」的实现口径：src 为 HTTP(S) 直链时，浏览器对媒体资源
 *     自动按需发 Range 请求（S3 原生支持），进度条拖动边下边播、不整文件入内存；
 *  2) 无直链能力 → ctx.getObject(key) → Blob → URL.createObjectURL 兜底（blob: 无 Range 语义，
 *     须整读字节流；单文件带鉴权头/POST 的源本就拿不到直链）。
 * dispose = remove 元素（+ 直链路径无 objectURL 可回收；Blob 路径 revokeObjectURL）。
 * 失败面：getObject 拿不到字节流 → el 内错误提示节点（ctx.t('app.media-load-fail')），
 *         不向调用侧抛出，且仍返回 {dispose}（调用侧可无脑 dispose）。
 * 注：video 与 audio 共同逻辑抽在本文件私有函数（授权文件清单受限，不新增 _util.ts）。
 */
import type { AppCtx, AppDefinition, AppInstance } from '../../sdk/types'

/** i18n key：媒体字节流加载失败提示（词典在 locales，主线收口） */
const MEDIA_LOAD_FAIL_KEY = 'app.media-load-fail'

/** 错误提示节点（文案走宿主词典；样式对齐 builtins 占位渲染器口径） */
function buildFailTip(ctx: AppCtx): HTMLDivElement {
  const tip = document.createElement('div')
  tip.textContent = ctx.t(MEDIA_LOAD_FAIL_KEY)
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  return tip
}

/** 携带可选媒体直链能力的 ctx（AppCtx 契约未含此键，能力探测式读取——装配层透传即生效） */
type DirectMediaCtx = AppCtx & { getMediaUrl?: (key: string) => string }

/** 建媒体元素并挂 el（直链/Blob 两路径共用；样式口径一致） */
function appendMedia(el: HTMLElement, tag: 'video' | 'audio', src: string): HTMLMediaElement {
  const media: HTMLMediaElement = document.createElement(tag)
  media.controls = true
  media.src = src
  // 占满容器宽度（audio 高度自适应原生控件；video 保持宽高比）
  media.style.maxWidth = '100%'
  if (tag === 'video') media.style.width = '100%'
  el.appendChild(media)
  return media
}

/** 先暂停再移除：元素出 DOM 不必然停止播放（音频可能继续出声） */
function pauseAndRemove(media: HTMLMediaElement): void {
  if (!media.paused) media.pause()
  media.remove()
}

/**
 * video/audio 共同装载。任何路径都 resolve 出 AppInstance（成功=媒体元素实例；失败=提示节点实例），
 * 不抛出。直链优先（先于字节流判定——有直链就不该整读 Blob）。
 */
async function mountMedia(
  el: HTMLElement,
  key: string,
  ctx: AppCtx,
  tag: 'video' | 'audio',
): Promise<AppInstance> {
  // 「Range 拖动」路径：预签名直链（空串视为无直链，回落 Blob）
  const directUrl = (ctx as DirectMediaCtx).getMediaUrl?.(key)
  if (directUrl) {
    const media = appendMedia(el, tag, directUrl)
    return { dispose: () => pauseAndRemove(media) }
  }

  let blob: Blob
  try {
    blob = await ctx.getObject(key)
  } catch {
    // 字节流拿不到（凭证过期/404/网络）——提示节点 + 空 dispose，不抛出
    const tip = buildFailTip(ctx)
    el.appendChild(tip)
    return { dispose: () => tip.remove() }
  }

  const url = URL.createObjectURL(blob)
  const media = appendMedia(el, tag, url)

  return {
    dispose: () => {
      pauseAndRemove(media)
      URL.revokeObjectURL(url)
    },
  }
}

/** 视频渲染器（内置应用 video-player：mp4/webm/mov，原生 <video controls>） */
export const videoRenderer: AppDefinition['renderer'] = (el, file, ctx) =>
  mountMedia(el, file.key, ctx, 'video')

/** 音频渲染器（内置应用 audio-player：mp3/wav/ogg/flac/m4a，原生 <audio controls>） */
export const audioRenderer: AppDefinition['renderer'] = (el, file, ctx) =>
  mountMedia(el, file.key, ctx, 'audio')
