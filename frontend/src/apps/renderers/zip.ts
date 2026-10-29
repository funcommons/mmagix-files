/**
 * zip 在线解压浏览器渲染器（内置应用 zip-browser，M4-UI 波次）
 * 契约：documents/v1.2.0执行进度.md §UI 波次契约 M4-UI + 《docs/design/plugin-system.md》V1.1 §二
 * ctx 能力面（凭证不出、字节流进出）。UI 组件 frontend/src/apps/ui/ZipBrowser.vue（IO 回调注入、
 * 纯测可桩），本渲染器是唯一业务接线点：load/extract/download 三回调闭包注入 createApp 挂载。
 *
 * 链路：
 *  - load：getMediaUrl(key)（装配层透传 client.getPresignedUrl，即 sigv4.presignGet 直链；
 *    每次回调现取——预签名 TTL 有限，入口捕获一次过期后即死链）→
 *    fetchRangeReader（size=http(s) 直链免 HEAD 直取列表元数据 sizeHint——GET 签名 URL 配
 *    HEAD 必 403，blob:/未知源保留 HEAD 尝试后回落；read=fetch Range [start,end) 半开区间，
 *    200 整读回落本地切片并整包缓存于 reader 实例——兼容 blob: 直链与不支持 Range 的源）→
 *    parseCentralDirectory。无直链能力（单文件带鉴权头/无 presign）→ ctx.getObject 整包 Blob
 *    内存 RangeReader 兜底（预览闸全局线兜住内存面）。
 *  - extract：sanitizeEntryName（zip slip，null 拒）→ checkBomb 三闸（条目数/总量/压缩比，失败
 *    整批拒=reject，组件 notice 直出 reason）→ extractEntry 逐条解出（加密兜底/不支��方法/CRC
 *    失败按条计失败不拖垮整批）→ 逐条落盘（落盘单一规则，见下）→ 汇总 notify 口径不变。
 *    落盘单一规则：peekWorkspaceStores() 可得且 key 非 mem:// → 唯一队列链（files/setup.ts 装配
 *    单例，逐条 enqueue(File, '<zip名>/', { onConflict: 恒 'skip' })——与打包上传共用 head 重名
 *    探测+跳过语义（探测失败=不存在照传，同口径），multipart/任务中心/onDone 树强刷全量继承，
 *    ok=受理计数（受理后的传输失败由任务中心承载，与打包上传一致））；否则=当前会话无工作区
 *    写面（单文件面/独立渲染上下文，或 mem:// 键域）→ 降级纯本地下载：逐条解出 → <a download>
 *    锚点落盘（同 download 回调；条目名作文件名，'/' 折 '_' 防重名），toast 一句「已降级为本地
 *    下载」。不落 ctx.putObject：mem 键只有 datasource 分流面认得（queue 直落 S3 client 必丢内
 *    存域），url 源 putObject 忽略 key 逐条覆写源文件（数据毁灭面）——两条都是绝路，故降级。
 *    批内失败上报聚合：仅首个错误 notifyAppError 一次（message 附 ×count），其余静默计入跳过
 *    汇总——防系统性失败（凭据拒/网络断）N 连发 toast 灾。
 *  - download：同三闸 → extractEntry → Blob → <a download> 锚点逐条落盘（条目名含 '/' 时折 '_'
 *    防落盘重名；zip 内条目不是独立对象，宿主下载通道够不到——宿主级整包下载走
 *    files/download-queue 既有链，与本回调互不影响）。
 *
 * 限额（R2-03 同源单一事实源）：app 级 maxBytes=ZIP_BROWSER_MAX_BYTES（builtins.ts，512MB）——
 * 预览闸实际拒绝线=min(PREVIEW_REJECT, maxBytes)；渲染器内防线同源常量（size 缺失/0=单文件
 * 伪条目跳过本闸，与 preview.ts 口径一致）。
 * embed 可配 unzipMaxBytes（字节）：同 setup.ts uploadMaxBytes 的「可选参数覆盖缺省」法——透传
 * 通道=openFile 的 appOptions（渲染器第 5 参；config.params→渲染器的直连管道本波次未开，
 * appOptions 是契约内既有的渲染器参数口），非法/缺省=回落 512MB 默认值。
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import i18n from '../../locales'
import ZipBrowser from '../ui/ZipBrowser.vue'
import { ZIP_BROWSER_MAX_BYTES } from '../builtins'
import { formatBytes } from '../../files/format'
import { isMemKey } from '../../files/mem-store'
import { peekWorkspaceStores } from '../../files/setup'
import { toast } from '@/components/sdk'
import { checkBomb, extractEntry, parseCentralDirectory, sanitizeEntryName } from '../../files/zip-reader'
import type { RangeReader, ZipCentral, ZipEntryMeta } from '../../files/zip-reader'
import type { AppCtx, AppDefinition, AppInstance } from '../../sdk/types'

// ───────────────────────── RangeReader 组装 ─────────────────────────

/**
 * 直链 RangeReader（presignGet URL + fetch Range）：size=http(s) 源免 HEAD（GET 签名 URL 配
 * HEAD 必 403——签名 method 不符被 S3 拒）直取 sizeHint=列表元数据
 * size，blob:/未知源保留 HEAD content-length 尝试后回落 sizeHint；两者皆缺=抛错进错误态。
 * read 用 Range [start,end)（半开区间换算 bytes=start-(end-1)）。响应 206=精确区间；200=源
 * 不支持 Range（blob: 直链/兼容源）→ 整读后本地切片并整包缓存于 reader 实例（cached：首个
 * read 存下、后续切片复用免重 fetch；newReader 间不共享，最新鲜性归 load 重入），保 read
 * 语义恒为「恰好 [start,end) 片段」。
 */
function fetchRangeReader(url: string, sizeHint: number): RangeReader {
  // 200 整读缓存（reader 实例私有，newReader 间不共享——最新鲜性归 load 重入）
  let cached: Uint8Array | null = null
  return {
    async size(): Promise<number> {
      // GET 签名 URL 配 HEAD 必 403（签名 method 不符被 S3 拒）——http(s)=S3 预签名源不发
      // HEAD 死请求，直取 sizeHint；blob:/未知源保留原 HEAD 尝试分支。
      if (!/^https?:/i.test(url)) {
        try {
          const res = await fetch(url, { method: 'HEAD' })
          const len = Number(res.headers.get('content-length'))
          if (res.ok && Number.isFinite(len) && len > 0) return len
        } catch {
          // HEAD 不可用（blob: 直链只许 GET 等）→ 落 sizeHint
        }
      }
      if (sizeHint > 0) return sizeHint
      throw new Error('zip: 无法确定包大小（直链无长度信息且列表元数据缺失）')
    },
    async read(start: number, end: number): Promise<Uint8Array> {
      // 缓存命中（非 Range 源首个 read 已存整包）→ 后续切片本地取
      if (cached) return cached.subarray(start, Math.max(start, Math.min(end, cached.length)))
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } })
      if (!res.ok) throw new Error(`zip: Range 读失败（HTTP ${res.status}）`)
      const buf = new Uint8Array(await res.arrayBuffer())
      if (res.status === 206) return buf
      // 200 整读：取 [start, end)（buf 不足则截到实际长度，交由上层结构校验兜错）；整包存
      // 缓存，后续 read 不再逐次重 fetch
      cached = buf
      return buf.subarray(start, Math.max(start, Math.min(end, buf.length)))
    },
  }
}

/** Blob 内存 RangeReader（无直链兜底）：slice 即 Range，语义天然精确 */
function blobRangeReader(blob: Blob): RangeReader {
  return {
    size: async () => blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  }
}

/**
 * reader 供给器：直链优先（每次回调现取现用——预签名 TTL 3600s，入口捕获一次会在过期后永久
 * 403、zip-retry 复走死 URL，现取保证重试链拿到新鲜签名；零长持连接）；无直链则整包取 Blob
 * （惰性单飞并缓存——load/extract/download 多轮回调复用同一次取流；取流失败清缓存，重试可
 * 重来）。
 */
function makeReaderProvider(ctx: AppCtx, key: string, sizeHint: number): () => Promise<RangeReader> {
  let blobPromise: Promise<Blob> | null = null
  return async (): Promise<RangeReader> => {
    // 每次回调现取（勿提升到闭包外——见上注 TTL 过期死链）
    const directUrl = ctx.getMediaUrl?.(key)
    if (directUrl) return fetchRangeReader(directUrl, sizeHint)
    blobPromise ??= ctx.getObject(key)
    try {
      return blobRangeReader(await blobPromise)
    } catch (e) {
      blobPromise = null // 失败不缓存：重试链重新取流
      throw e
    }
  }
}

// ───────────────────────── 安全闸与落盘辅助 ─────────────────────────

/** 包名 → 解出前缀（'相册.zip' → '相册/'；去扩展、去路径段、折非法分隔符，空回落 'zip'） */
function zipBaseNameOf(name: string): string {
  const stem = name.replace(/\.zip$/i, '')
  const last = stem.split('/').pop() ?? ''
  const safe = last.replace(/[/\\]/g, '_').trim()
  return safe !== '' ? safe : 'zip'
}

/** Uint8Array → Blob（lib.dom 新版把 BufferSource 收窄到 ArrayBuffer-backed 视图，extractEntry
 *  返回的 Uint8Array<ArrayBufferLike> 运行时本就是合法视图——按 sigv4.ts 同款 as 口径收敛类型噪音） */
function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart])
}

/** 解出字节 → File（UploadQueue 入参面；as 口径同 toBlob）。name 保留 zip 内相对路径——队列按
 *  `prefix + name` 组 key（normalizePrefix 补尾 '/'），'/' 天然成桶内目录层；type 空 → 队列回落
 *  application/octet-stream */
function toEntryFile(bytes: Uint8Array, name: string): File {
  return new File([bytes as BlobPart], name)
}

/** 锚点落盘：条目名 '/' 折 '_'（<a download> 会剥路径段，折名顺带防重名覆盖） */
function triggerDownload(blob: Blob, entryName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = entryName.replace(/\//g, '_')
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** 超限/取流失败的提示节点收场（heic/pdf 渲染器同款口径，不向调用侧抛出） */
function failWith(el: HTMLElement, text: string): AppInstance {
  const tip = document.createElement('div')
  tip.className = 'mmagic-zip-fail'
  tip.style.padding = '16px'
  tip.style.color = 'var(--app-text-secondary, #888)'
  tip.textContent = text
  el.appendChild(tip)
  return { dispose: () => tip.remove() }
}

/** appOptions.unzipMaxBytes → 防线值（setup.ts uploadMaxBytes 同法：可选参数覆盖缺省；非法=null 回默认） */
function readUnzipMaxBytes(appOptions?: Record<string, unknown>): number | null {
  const v = (appOptions as { unzipMaxBytes?: unknown } | undefined)?.unzipMaxBytes
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

// ───────────────────────── 渲染器入口 ─────────────────────────

export const zipBrowserRenderer: AppDefinition['renderer'] = async (
  el,
  file,
  ctx,
  _savedState,
  appOptions,
): Promise<AppInstance> => {
  // 渲染器内防线（与 builtins.ts maxBytes 同源；size 0=单文件伪条目跳过本闸，preview.ts 口径）
  const maxBytes = readUnzipMaxBytes(appOptions) ?? ZIP_BROWSER_MAX_BYTES
  if (file.size > maxBytes) {
    return failWith(el, ctx.t('app.zip-too-large', { limit: formatBytes(maxBytes) }))
  }

  const newReader = makeReaderProvider(ctx, file.key, file.size)
  const base = zipBaseNameOf(file.name)

  // 落盘路径解析（渲染实例生命周期内 store 单例恒定，一次性取定）：null=当前会话无工作区写面 →
  // extract 降级纯本地下载（文件头「落盘单一规则」）。mem:// 键域强制降级——queue 直落 S3 client，
  // 内存键只有 datasource 分流面认得，绝不入队。
  const stores = peekWorkspaceStores()
  const uploadQueue = stores !== null && !isMemKey(file.key) ? stores.queue : null

  /** 操作汇总行（组件外 renderer 自持：成功路径的解出/跳过计数在此呈现） */
  const statusEl = document.createElement('div')
  statusEl.className = 'mmagic-zip-status'
  statusEl.style.display = 'none'
  statusEl.style.padding = '4px 8px'
  statusEl.style.fontSize = '12px'
  statusEl.style.color = 'var(--app-text-secondary, #888)'
  const showStatus = (text: string): void => {
    statusEl.style.display = 'block'
    statusEl.textContent = text
  }

  const load = (): Promise<ZipCentral> => newReader().then(parseCentralDirectory)

  /**
   * 安全闸公共前置（extract/download 共用）：sanitizeEntryName 过滤（zip slip 条目静默剔除并
   * 计数）+ checkBomb 三闸（失败整批拒=reject，组件 notice 直出 reason——契约「toast 直出」口径）。
   */
  async function gated(metas: ZipEntryMeta[]): Promise<{ list: { meta: ZipEntryMeta; name: string }[]; slip: number }> {
    const list: { meta: ZipEntryMeta; name: string }[] = []
    let slip = 0
    for (const meta of metas) {
      const name = sanitizeEntryName(meta.name)
      if (name === null) {
        slip += 1
        continue
      }
      list.push({ meta, name })
    }
    const bomb = checkBomb(list.map((s) => s.meta))
    if (!bomb.ok) throw new Error(bomb.reason ?? 'zip: 安全闸拦截')
    return { list, slip }
  }

  const extract = async (metas: ZipEntryMeta[]): Promise<void> => {
    const { list, slip } = await gated(metas)
    const reader = await newReader()
    if (uploadQueue === null && list.length > 0) {
      // 降级预告（每批至多一句，不逐条刷屏）：当前会话无工作区写面 → 本批逐条本地下载落盘
      toast.warning(ctx.t('zip.extract-local-fallback'))
    }
    let ok = 0
    let conflict = 0
    let failed = 0
    // 失败上报聚合（N3）：批内只记首个错误、批尾上报一次（message 附 ×count），其余静默计入
    // skipped/failed 汇总行——防系统性失败（凭据拒/网络断/整包取流失效）在 N 条上炸出 N 连发
    // toast 灾。errorCount 只数异常路径，队列分类拒收（ext/size，无异常）不混入 ×count。
    let firstError: { code: number; message: string } | null = null
    let errorCount = 0
    for (const { meta, name } of list) {
      try {
        const bytes = await extractEntry(reader, meta)
        if (uploadQueue) {
          // 唯一落盘路径（队列链）：逐条入队 store 队列单例（slip/bomb 闸不变；解出仍在渲染器
          // 侧，队列只管落盘）。onConflict 恒 'skip'=与既有「同名跳过并计数」同语义（不打扰用户
          // 裁决，复用队列 head 探测——探测点由解出前后移到解出后，冲突条目多付一次解出成本，
          // 计数语义不变）。
          const r = await uploadQueue.enqueue([toEntryFile(bytes, name)], base, {
            onConflict: async () => 'skip',
          })
          if (r.accepted.length > 0) ok += 1
          else if (r.rejected[0]?.reason === 'conflict') conflict += 1
          else failed += 1 // ext/size 队列分类拒收 → 并入跳过计数
        } else {
          // 降级（无工作区写面：单文件面/独立渲染上下文，或 mem:// 键域）：纯本地下载——锚点
          // 方式同 download 回调（条目名作文件名、'/' 折 '_' 防重名）。无写面即无同名冲突探测，
          // conflict 恒 0；浏览器对同名文件自带改名，无覆盖风险。
          triggerDownload(toBlob(bytes), name)
          ok += 1
        }
      } catch (err) {
        failed += 1 // 单条失败（加密兜底/不支持方法/CRC/下载失败/入队异常）计跳过，不拖垮整批
        errorCount += 1
        // 可见化出口（AppCtx.notifyAppError 即为此设）：系统性失败（凭据拒/网络断/整包取流失效
        // 等）不再坍缩成零诊断「跳过 N」——批尾统一上报宿主 bus 'error'（code.ts 保存链同款口径：
        // SDK 错误透传 code/message，其余 code=0）；仅首个入账，计数语义不变
        const sdkErr = err as { code?: unknown; message?: unknown } | null
        firstError ??= {
          code: typeof sdkErr?.code === 'number' ? sdkErr.code : 0,
          message: typeof sdkErr?.message === 'string' ? sdkErr.message : String(err),
        }
      }
    }
    if (firstError !== null) {
      // 批尾一次上报（附 ×count），与汇总行同批呈现——防 N 连发 toast 灾（见上聚合注）
      ctx.notifyAppError?.({
        code: firstError.code,
        message: errorCount > 1 ? `${firstError.message} (x${errorCount})` : firstError.message,
      })
    }
    showStatus(
      ctx.t('zip.extract-done', {
        ok,
        skipped: slip + failed,
        conflict,
      }),
    )
  }

  const download = async (metas: ZipEntryMeta[]): Promise<void> => {
    const { list } = await gated(metas)
    const reader = await newReader()
    for (const { meta, name } of list) {
      // 加密兜底/不支持方法/CRC 失败 → 抛错上抛（组件 notice 直出），本批终止
      const bytes = await extractEntry(reader, meta)
      triggerDownload(toBlob(bytes), name)
    }
  }

  // ── 挂载 ZipBrowser（复用宿主词典 i18n 实例：setLocale 切换即同步生效；ElementPlus 供 FcButton 底座）──
  const mountEl = document.createElement('div')
  mountEl.className = 'mmagic-zip-mount'
  const app = createApp(ZipBrowser, { load, extract, download })
  app.use(i18n)
  app.use(ElementPlus)
  app.mount(mountEl)
  el.replaceChildren(mountEl, statusEl)

  return {
    dispose: () => {
      app.unmount()
      mountEl.remove()
      statusEl.remove()
    },
  }
}
