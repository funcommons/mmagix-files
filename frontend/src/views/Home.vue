<script setup lang="ts">
/**
 * Home.vue — 工作台根页（Wave2-T2；Lane F3 消费层接线；Lane F5 交互面改版；Lane H1 预览 Tab 条；
 * Lane H-2 分享生成器接线：Toolbar/右键菜单两入口 → 单实例 ShareDialog；
 * M2/M3 接线：resume 断点续传面包条（指纹/partSize 校验 → 续传/放弃）+ 回收站视图
 * （TrashPanel 抽屉挂载，restore/purge 走 workspace-ops 收口，刷新链 applyChange+loadDir(force)+重拉闭环））。
 * !ok → 配置错误卡（保留 M0）；ok+workspace → SessionBanner+TreePanel+UploadPanel
 * （左树可拖宽/可隐藏，预览卡头=PreviewTabs|Toolbar 同一行——Toolbar 挂预览区头右侧（2026-10），
 * 旧顶部工具条已解散）；ok+file → 单文件预览（urlDataSource+registry 按 name 解析默认
 * 应用，F2；不挂 tab 条）；boot 未注入 → M0 hero 兜底。
 * Lane F3：① notifyFileChanged 真接线（renderer 保存 → tree.applyChange + bus 'fileChanged'，
 * 审计 P0）；② features.download 门控；③ bus 'expired' → preview.expire()；④ ui.defaultOpen 挂载后直开。
 * Lane F5（交互模型，对齐手册「双击/回车打开」）：
 *  - 选中不再自动开预览：单击=仅选中（多选由 TreePanel 内聚：ctrl/cmd 切换、shift 范围）；
 *    双击文件/回车/菜单「打开」→ @open → preview.open；「打开方式」→ @open-with → preview.open({appId})；
 *  - 右键菜单动作与 Toolbar 共用操作链（workspace-ops 收口，零复制）；
 *  - 多选：selected 为数组（Toolbar 删除按全集/重命名按首项）；
 *  - 多选打包下载：>1 文件 → zip.ts（store 模式，累计 256MB 上限 toast）→ triggerDownload；
 *  - 拖拽上传：TreePanel @drop-files → trackedEnqueue（任务登记）→ 拒收 toast；
 *  - 粘贴上传（Lane G1）：window 'paste'（features.upload 门控）→ clipboardData.files →
 *    trackedEnqueue 入当前目录；
 *  - 冲突确认（Lane G1）：trackedEnqueue 显式 onConflict → ElMessageBox 三按钮（覆盖/跳过/
 *    关闭=整批取消 4901 语义）；
 *  - UploadPanel=传输任务中心（Lane G1 上传+下载统一）：上传任务登记在 trackedEnqueue（状态经
 *    queue.status 轮询同步——bus.emit 仅外发宿主、本地 handler 不触发，故 upload* 事件不能作
 *    面板数据源）；下载任务来自 DownloadQueue（reactive 列表直读）。
 */
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { inject } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FcButton, FcDrawer, FcEmpty, FcPopover, FcSectionCard, FcSegmented, toast } from '@/components/sdk'
import { usePreferenceStore } from '@/store/preference'
import { BOOT_KEY } from '@/boot'
import { SdkError, ERROR_CODES } from '@/sdk/errorCodes'
import { setupWorkspace } from '@/files/setup'
import { createPreview } from '@/files/preview'
import { isMemKey, memDelete, setMemFileOpener } from '@/files/mem-store'
import { formatBytes } from '@/files/format' // R2-05：大小口径统一正本（数值+空格+单位）
import { normalizePrefix } from '@/files/tree-store'
import { s3DataSource, urlDataSource } from '@/apps/datasource'
import { UrlSourceProvider } from '@/sdk/url-source'
import { resolveFeatures } from '@/sdk/features'
import { triggerDownload } from '@/utils/download'
import { ZIP_SIZE_LIMIT, zipStore } from '@/files/zip'
import { DownloadQueue } from '@/files/download-queue'
import { createWorkspaceOps } from '@/files/ui/workspace-ops'
import SessionBanner from '@/files/ui/SessionBanner.vue'
import { formatRemaining } from '@/files/session-format'
import { EXPIRE_WARN_BEFORE_MS } from '@/sdk/constants'
import SearchDialog from '@/files/ui/SearchDialog.vue'
import ShareDialog from '@/files/ui/ShareDialog.vue'
import ConnectWizard from '@/files/ui/ConnectWizard.vue'
import { SearchIndex, createIdbMetaStore } from '@/files/search-index'
import type { MetaRow } from '@/files/search-index'
import { registerCommandsProvider, registerFileSearchProvider } from '@/composables/useCommandPaletteState'
import Toolbar from '@/files/ui/Toolbar.vue'
import TreePanel from '@/files/ui/TreePanel.vue'
import UploadDialog from '@/files/ui/UploadDialog.vue'
import UploadPanel from '@/files/ui/UploadPanel.vue'
import VersionPanel from '@/files/ui/VersionPanel.vue'
import type { UploadTaskView } from '@/files/ui/UploadPanel.vue'
import PreviewTabs, { applyOpenedTab, findTab, pickNeighbor, pinToggle } from '@/files/ui/PreviewTabs.vue'
import type { PreviewTab } from '@/files/ui/PreviewTabs.vue'
import type { PreviewHandle } from '@/files/preview'
import { UPLOAD_ABORTED_CODE } from '@/files/upload-queue'
import type { ConflictEnqueueResult, ResumeCandidate } from '@/files/upload-queue'
import { sha256HexSync } from '@/sdk/s3/sigv4'
import type { S3ObjectSummary, VersionRow } from '@/sdk/types'
import type { TrashEntry } from '@/files/tree-store'
import TrashPanel from '@/files/ui/TrashPanel.vue'

const { t } = useI18n()
const preference = usePreferenceStore()
const boot = inject(BOOT_KEY)

/** workspace 装配（setup.ts 模块级单例；file 模式在其内部返回 null） */
function resolveWorkspace() {
  if (!boot || !boot.ok || boot.handle.config.mode !== 'workspace') return null
  const stores = setupWorkspace(boot.handle)
  if (!stores) return null
  return {
    stores,
    session: boot.handle.session,
    rootPrefix: boot.handle.config.backend.prefix,
    mode: boot.handle.config.mode,
  }
}
const ws = resolveWorkspace()

/** file 模式单文件配置（F2：接渲染器） */
function resolveFile() {
  if (!boot || !boot.ok || boot.handle.config.mode !== 'file') return null
  return boot.handle.config
}
const fileConfig = resolveFile()

function basenameOf(url: string): string {
  try {
    const path = new URL(url).pathname
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url
  } catch {
    return url
  }
}
const fileName = fileConfig ? (fileConfig.name ?? basenameOf(fileConfig.source.url)) : ''
/** 嵌入态判定（一百四十二番终形: 宿主同源自动高度——iframe 内 self!==top 时文件页自然流,
 *  不锁 100vh/不内部滚动, 内容撑高文档由宿主量高; 独立窗（self===top）维持视口滚动形态 */
const isEmbeddedFile = fileConfig ? window.self !== window.top : false

/** 单文件模式：无壳（无 header/卡片包裹）——文件名与编辑态由应用自渲染（Univer/md 工具栏等）。
 *  无源装载（source.url=''，v1.2 容器模式）：boot 不自动打开，舞台留白等 uploadFiles */
const fileSourceUrl = fileConfig ? fileConfig.source.url.trim() : ''

// R2-05：大文件确认框 {size} 改用全仓统一 formatBytes 口径（「数值+空格+单位」，与树列/拒绝文案同源）
// （原本地 formatMb 的「25.1MB」无空格口径已废；largefile.rejected 的 {limit} 由 preview.ts 传，X2 lane 负责）

/** features 门控（F1）：resolveFeatures(config.features) 传 Toolbar/TreePanel，false 隐藏对应操作入口 */
const features = computed<Record<string, boolean>>(() =>
  boot && boot.ok ? resolveFeatures(boot.handle.config.features) : {},
)
const registry = computed(() => (boot && boot.ok ? boot.handle.registry : null))

/** 树形态（config.ui.treeMode，workspace 模式专属）：sidebar=常驻侧栏（默认）/ drawer=左抽屉 */
const treeMode = computed<'sidebar' | 'drawer'>(() => {
  if (!(boot && boot.ok) || boot.handle.config.mode !== 'workspace') return 'sidebar'
  return boot.handle.config.ui?.treeMode ?? 'sidebar'
})
const isDrawerTree = computed(() => treeMode.value === 'drawer')
/** 左抽屉开关（drawer 模式；预览区左上角文件图标唤起） */
const treeDrawerOpen = ref(false)
/** 树标题覆写（ui.treeTitle；缺省走 TreePanel 内 rootPrefix 口径） */
const treeTitle = computed(() =>
  boot && boot.ok && boot.handle.config.mode === 'workspace' ? boot.handle.config.ui?.treeTitle : undefined,
)

/** 选中集（Lane F5 多选数组）：单击=替换、ctrl/cmd=切换、shift=范围（切换逻辑在 TreePanel 内聚） */
const selected = ref<S3ObjectSummary[]>([])
function onSelect(entries: S3ObjectSummary[]): void {
  selected.value = entries
}
/** changed(key)（删除/重命名的旧 key）：从选中集剔除；tab 历史同步剔除（残留只会 404）；
 *  mem:// 键随 tab 移除释放内存条目（内存文件生命周期绑 tab，防泄漏） */
function onChanged(key: string): void {
  selected.value = selected.value.filter((s) => s.key !== key)
  if (isMemKey(key)) memDelete(key)
  const before = previewTabs.value.length
  previewTabs.value = previewTabs.value.filter((t) => t.entry.key !== key)
  if (previewTabs.value.length !== before && activeTabKey.value === key) {
    activeTabKey.value = preview?.current()?.key ?? null
  }
}

/** 操作链（mkdir/rename/remove/上传拒收）：Toolbar 与右键菜单共用（workspace-ops 收口） */
const ops = ws ? createWorkspaceOps({ tree: ws.stores.tree, t }) : null

// ── 传输任务中心（Lane F5 上传面板 + Lane G1 下载队列/暂停恢复/冲突/粘贴） ──

const uploadTasks = ref<UploadTaskView[]>([])
/** 任务状态轮询器句柄（onBeforeUnmount 用） */
let uploadPoller: ReturnType<typeof setInterval> | null = null
/** 轮询周期：UploadQueue 无进度/状态出站口（bus.emit 仅外发宿主），状态以轮询 status() 同步 */
const UPLOAD_POLL_MS = 250

/** 终态映射：queued/uploading 视为上传中，paused → 已暂停，done/failed/aborted → 面板终态 */
function pollUploadStatuses(): void {
  const queue = ws?.stores.queue
  if (!queue) return
  for (const task of uploadTasks.value) {
    if (task.status !== 'uploading') continue
    const s = queue.status(task.id)
    if (s === 'done') {
      task.status = 'done'
      task.loaded = task.total
    } else if (s === 'paused') {
      task.status = 'paused'
    } else if (s === 'failed') {
      task.status = 'failed'
      task.error = ws?.stores.queue.errorOf(task.id) // 失败原因（面板行展示，不再只给「失败」两字）
    } else if (s === 'aborted') {
      task.status = 'cancelled'
    }
  }
}

function stopUploadPoller(): void {
  if (uploadPoller !== null) {
    clearInterval(uploadPoller)
    uploadPoller = null
  }
}

/** 全部任务到终态后自停（无上传中任务时空转无意义；暂停/恢复/重试入口各自 ensure 唤醒） */
function ensureUploadPoller(): void {
  if (uploadPoller !== null) return
  uploadPoller = setInterval(() => {
    pollUploadStatuses()
    if (!uploadTasks.value.some((x) => x.status === 'uploading')) stopUploadPoller()
  }, UPLOAD_POLL_MS)
}

/**
 * 冲突确认对话框（Lane G1，transfer.* 预置词典）：三按钮口径——
 * 「覆盖」=confirm → 'overwrite'；「跳过」=cancel → 'skip'；关闭/X/Esc=整批取消 →
 * 抛 4901（UPLOAD_ABORTED_CODE）语义，enqueue 整批不入队（trackedEnqueue 静默收场）。
 * R2-04：ElMessageBox 放不下第三个按钮——第三态原本只由无文字的 X 承担（conflict-abort
 * 词典键成死键），message 体补一行弱化提示「取消上传：关闭」让该语义用户可知。
 */
async function confirmConflict(names: string[]): Promise<'overwrite' | 'skip'> {
  try {
    await ElMessageBox.confirm(
      h('div', null, [
        `${t('transfer.conflict-msg', { n: names.length })} ${names.join('、')}`,
        h(
          'p',
          {
            class: 'conflict-abort-hint',
            style: { margin: '8px 0 0', fontSize: '12px', color: 'var(--app-text-tertiary, #999)' },
          },
          `${t('transfer.conflict-abort')}：${t('common.close')}`,
        ),
      ]),
      t('transfer.conflict-title'),
      {
        type: 'warning',
        distinguishCancelAndClose: true,
        confirmButtonText: t('transfer.conflict-overwrite'),
        cancelButtonText: t('transfer.conflict-skip'),
      },
    )
    return 'overwrite'
  } catch (action) {
    if (action === 'cancel') return 'skip'
    throw new SdkError(UPLOAD_ABORTED_CODE, '用户取消上传', { names })
  }
}

/**
 * 带任务登记的 enqueue 包装（树头上传（hidden input→@drop-files）/树拖拽/粘贴共用上传口；
 * Lane G1 起为异步链：
 * 显式 onConflict → 队列 head 探测重名 → 冲突对话框裁决后落池）。
 * UploadQueue 不枚举任务且 hooks 构造期只读——id↔name 映射只能在入队点登记：
 * accepted 按文件序排列，逐个剔除 rejected 命中后对齐取 id。
 * 拒收 toast 收口说明：ext/size 拒收统一在此 resolve 后汇总提示（conflict 跳过经对话框自明，
 * 不计入 toast）；旧 Toolbar 内部 ingestFiles 同步回包链随 props.queue 删除一并退场（2026-10）。
 */
async function trackedEnqueue(files: File[], prefix?: string): Promise<ConflictEnqueueResult> {
  const queue = ws?.stores.queue
  if (!queue || files.length === 0) return { accepted: [], rejected: [] }
  let result: ConflictEnqueueResult
  try {
    result = await queue.enqueue(files, prefix, { onConflict: confirmConflict })
  } catch (e) {
    if (e instanceof SdkError && e.code === UPLOAD_ABORTED_CODE) {
      return { accepted: [], rejected: [] } // 用户取消整批：静默
    }
    toast.error(e instanceof Error && e.message ? e.message : t('files.msg.op-failed'))
    return { accepted: [], rejected: [] }
  }
  const hardRejected = result.rejected.filter((r) => r.reason !== 'conflict')
  if (hardRejected.length > 0) {
    toast.warning(t('files.msg.upload-rejected', { n: hardRejected.length }))
  }
  const rejectedNames = result.rejected.map((r) => r.name)
  let ai = 0
  for (const f of files) {
    const ri = rejectedNames.indexOf(f.name)
    if (ri >= 0) {
      rejectedNames.splice(ri, 1)
      continue
    }
    const id = result.accepted[ai++]?.id
    if (id) uploadTasks.value.push({ id, name: f.name, loaded: 0, total: f.size, status: 'uploading' })
  }
  if (result.accepted.length > 0) ensureUploadPoller()
  return result
}

/** 下载队列（Lane G1 传输任务中心下载侧）：reactive 任务列表直供面板；file 模式无下载 */
const downloads = ws ? new DownloadQueue({ client: ws.stores.client }) : null

function onCancelUpload(id: string): void {
  if (!ws) return
  if (ws.stores.queue.abort(id)) {
    const task = uploadTasks.value.find((x) => x.id === id)
    // 直传（put）不可中断：本地先置取消态，终态 uploadFailed(≥4900) 稍后幂等覆盖
    if (task && task.status === 'uploading') task.status = 'cancelled'
  }
}

/** 暂停（multipart 当前分片落定后停调度；直传在途不可中断，见 upload-queue 诚实口径） */
function onPauseUpload(id: string): void {
  void ws?.stores.queue.pause(id)
}

/** 继续：paused → 重新入池（multipart 复用 uploadId 断点续传） */
function onResumeUpload(id: string): void {
  if (ws?.stores.queue.resume(id)) {
    const task = uploadTasks.value.find((x) => x.id === id)
    if (task) task.status = 'uploading'
    ensureUploadPoller()
  }
}

/** 重试：failed → 复用 uploadId 续传（直传整重传） */
function onRetryUpload(id: string): void {
  if (ws?.stores.queue.retry(id)) {
    const task = uploadTasks.value.find((x) => x.id === id)
    if (task) task.status = 'uploading'
    ensureUploadPoller()
  }
}

function onClearUploads(): void {
  uploadTasks.value = uploadTasks.value.filter((x) => x.status === 'uploading' || x.status === 'paused')
}

function onCancelDownload(id: string): void {
  void downloads?.cancel(id)
}
function onRetryDownload(id: string): void {
  void downloads?.retry(id)
}
function onClearDownloads(): void {
  downloads?.clearTerminal()
}

// ── M2 接线：resume 断点续传面包条（resumeCheckpoints 探活 → 重选文件 → 校验 → 续传/放弃） ──

/** 指纹复算编码器（与 upload-queue taskFingerprint 同构：sha256(`${key}:${size}:${lastModified}`)） */
const FP_TE = new TextEncoder()

/** 续传候选（onMounted 探活一次；横幅关闭=保留断点下次再提示，不删库内断点行） */
const resumeCandidates = ref<ResumeCandidate[]>([])
const resumeBannerClosed = ref(false)
const showResumeBanner = computed(() => !resumeBannerClosed.value && resumeCandidates.value.length > 0)
/** 「重选文件续传」的挂起候选：file input change 时对齐（input 常驻 template，与横幅显隐解耦） */
const pendingResume = ref<ResumeCandidate | null>(null)
const resumeFileInput = ref<HTMLInputElement | null>(null)

function removeResumeCandidate(fingerprint: string): void {
  resumeCandidates.value = resumeCandidates.value.filter((c) => c.fingerprint !== fingerprint)
}

/** 挂载后探活断点（resumeCheckpoints 内部已保守：探活接口失败不动断点；此处再防网络级异常静默） */
onMounted(() => {
  const queue = ws?.stores.queue
  if (!queue) return
  queue
    .resumeCheckpoints()
    .then((candidates) => {
      resumeCandidates.value = candidates
    })
    .catch(() => { /* 探活失败不弹横幅：断点保留在库，下次进入再试 */ })
})

/** 「重选文件续传」：触发常驻 file input（multipart 断点无法凭空取回 File 句柄，必须用户重选） */
function pickResumeFile(c: ResumeCandidate): void {
  pendingResume.value = c
  resumeFileInput.value?.click()
}

/**
 * 用户选完文件后的三路径校验（M2 接线硬性要求）：
 * ① 指纹校验：fingerprint=sha256(`${path}:${size}:${lastModified}`)，与 upload-queue taskFingerprint
 *    同构（File.lastModified 跨会话稳定可复算）——不一致 toast 提示并保留断点（可能只是选错文件）；
 * ② partSize 硬性校验（UI 波次契约/评审 P2-3）：候选 partSize 是构造期冻结值，partSize/maxParts
 *    配置变更后跨会话必漂移；分片号↔字节区间错位会把新旧分片拼成坏对象——必须弃旧断点 +
 *    abort 旧 uploadId 整件重传（discardCheckpoint 双清后走 trackedEnqueue 正常入队）；
 * ③ 匹配：以 checkpoint 续传入队（enqueueResume 复用 uploadId+已传分片，只补缺失分片），
 *    任务登记对齐 trackedEnqueue 口径（进度从断点字节继续而非归零）。
 */
async function onResumeFilePicked(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  const candidate = pendingResume.value
  input.value = '' // 复位以允许再次选择同一文件（change 依赖值变化）
  pendingResume.value = null
  const queue = ws?.stores.queue
  if (!queue || !file || !candidate) return
  // ① 指纹校验（path+size+lastModified 一致性）
  const fingerprint = sha256HexSync(FP_TE.encode(`${candidate.path}:${file.size}:${file.lastModified}`))
  if (fingerprint !== candidate.fingerprint) {
    toast.warning(t('transfer.resume-mismatch')) // 文件不一致无法续传：断点保留
    return
  }
  // ② partSize 硬性校验：不一致=旧分片字节区间全部作废，弃断点整件重传
  if (candidate.partSize !== queue.partSizeFor(file.size)) {
    await queue.discardCheckpoint(candidate) // abortMultipart 销毁服务端会话 + remove 移除断点行（双清）
    removeResumeCandidate(candidate.fingerprint)
    toast.info(t('transfer.resume-restart'))
    void trackedEnqueue([file], parentPrefixOf(candidate.path)) // 整件重传（带任务登记/冲突探测/拒收 toast）
    return
  }
  // ③ 匹配：以 checkpoint 续传入队（队列侧指纹复核兜底，返回 null=不一致，理论不可达）
  const resumed = queue.enqueueResume(file, candidate)
  if (!resumed) {
    toast.warning(t('transfer.resume-mismatch'))
    return
  }
  removeResumeCandidate(candidate.fingerprint)
  const loaded = candidate.parts.reduce((sum, p) => {
    const start = (p.number - 1) * candidate.partSize
    return sum + (Math.min(start + candidate.partSize, file.size) - start)
  }, 0)
  uploadTasks.value.push({ id: resumed.id, name: file.name, loaded, total: file.size, status: 'uploading' })
  ensureUploadPoller()
}

/** 「放弃」断点候选：abortMultipart+checkpointStore.remove（queue.discardCheckpoint 双清收口） */
async function onDiscardResume(c: ResumeCandidate): Promise<void> {
  const queue = ws?.stores.queue
  if (!queue) return
  await queue.discardCheckpoint(c)
  removeResumeCandidate(c.fingerprint)
  toast.info(t('transfer.resume-discarded'))
}

/** key 所属父目录前缀（partSize 漂移整件重传时 trackedEnqueue 的 prefix 入参） */
function parentPrefixOf(key: string): string {
  const i = key.lastIndexOf('/')
  return i < 0 ? '' : key.slice(0, i + 1)
}

/** 上传确认弹窗（2026-10 订单）：树头钮/空白/行右键「上传」三入口统一先弹窗——
 *  上半目标目录、下半拖放/点选区 + 已选清单，确认（confirm）才 trackedEnqueue 入队；
 *  拖拽落树/粘贴上传为显式手势不走弹窗（目标即当前目录，保持直入）。 */
const uploadDialogOpen = ref(false)
const uploadDialogDir = ref('')
const uploadDialogTab = ref<'upload' | 'transfer'>('upload')
function openUploadDialog(dir: string): void {
  if (features.value.upload === false) return
  uploadDialogDir.value = dir
  uploadDialogTab.value = 'upload'
  uploadDialogOpen.value = true
}
/** 树头「上传」（TreePanel upload-request）：目标=当前目录 */
function onTreeUploadRequest(): void {
  if (!ws) return
  openUploadDialog(ws.stores.tree.currentPath)
}
/** 弹窗确认（订单 2026-10 流程：确认即关窗）：
 *  关窗 → trackedEnqueue（重名冲突提示此时不再被弹窗遮挡，与旧直传链同观感）→
 *  「成功开始入队」（accepted>0）才重开弹窗落在传输页签；全部被拒/用户取消 → 保持关门（toast 自收敛） */
function onUploadDialogConfirm(files: File[]): void {
  uploadDialogOpen.value = false
  void trackedEnqueue(files, uploadDialogDir.value).then((r) => {
    if (r.accepted.length > 0) {
      uploadDialogTab.value = 'transfer'
      uploadDialogOpen.value = true
    }
  })
}
/** 传输任务中心（2026-10 并入上传弹窗「传输」页签；底部悬浮面板退役） */
function openTransferPanel(): void {
  uploadDialogTab.value = 'transfer'
  uploadDialogOpen.value = true
}
/** 进行中传输数（上传 uploading/paused + 下载 active）——传输入口钮角标 */
const activeTransferCount = computed(() => {
  const up = uploadTasks.value.filter((x) => x.status === 'uploading' || x.status === 'paused').length
  const down = (downloads?.tasks ?? []).filter((x) => x.status === 'active').length
  return up + down
})
const transferEmpty = computed(
  () => uploadTasks.value.length === 0 && (downloads?.tasks ?? []).length === 0,
)

// ── M3 接线：回收站视图（TrashPanel 抽屉挂载；restore/purge 走 workspace-ops 收口） ──

const trashOpen = ref(false)
const trashEntries = ref<TrashEntry[]>([])
const trashBusy = ref(false)

// ── 版本能力探测（订单 2026-10：桶未开 Versioning / client 不支持 → 回收站入口与右键「历史版本」直接隐藏） ──
// client 缺 listObjectVersions/getBucketVersioning、探测抛错（如 501）、状态 Disabled（未配置）→ 一律视为无能力。
const versionCapable = ref(false)
async function detectVersionCapable(): Promise<void> {
  if (!ws) return
  const client = ws.stores.client
  if (!client.listObjectVersions || !client.getBucketVersioning) return
  try {
    const status = await client.getBucketVersioning()
    versionCapable.value = status === 'Enabled' || status === 'Suspended'
  } catch {
    versionCapable.value = false
  }
}
void detectVersionCapable()

/** 进入回收站即拉取（listTrash({}) 全量；每次打开重拉，busy 全程禁面板三钮） */
watch(trashOpen, (open) => {
  if (open) void reloadTrash()
})

// ── M3-F8 收口：版本历史（TreePanel open-history → VersionPanel 抽屉；list/restore/download 在此注入） ──

const versionKey = ref<string | null>(null)
const versionBusy = ref(false)
const versionOpen = computed({
  get: () => versionKey.value !== null,
  set: (o: boolean) => {
    if (!o) versionKey.value = null
  },
})

/** 列指定 key 的全部版本（翻页聚合到尽 + lastModified 倒序；共享 prefix 的其它 key 行滤除） */
async function listVersionsOf(key: string): Promise<VersionRow[]> {
  const client = ws?.stores.client
  if (!client?.listObjectVersions) {
    throw new SdkError(ERROR_CODES.UNSUPPORTED_MODE, '当前连接不支持版本列表（需要桶版本控制）')
  }
  const out: VersionRow[] = []
  let keyMarker: string | undefined
  let vidMarker: string | undefined
  do {
    const page = await client.listObjectVersions({ prefix: key, keyMarker, versionIdMarker: vidMarker })
    for (const r of page.versions) if (r.key === key) out.push(r)
    if (!page.isTruncated) break
    keyMarker = page.nextKeyMarker
    vidMarker = page.nextVersionIdMarker
  } while (keyMarker)
  return out.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
}

/** 恢复到指定版本：服务端 copy（copy-source 带 ?versionId）→ 生成新 latest，不破坏任何历史 */
async function restoreVersionOf(key: string, versionId: string): Promise<void> {
  versionBusy.value = true
  try {
    await ws!.stores.client.copy(key, key, { fromVersionId: versionId })
    toast.success(t('files.history.restored'))
    onChanged(key) // 树缓存回流（恢复=put 语义）
  } catch (e) {
    toast.error(e instanceof Error && e.message ? e.message : t('files.msg.op-failed'))
  } finally {
    versionBusy.value = false
  }
}

/** 下载指定版本：预签名 GET + versionId（response-content-disposition 定名）→ 浏览器保存 */
async function downloadVersionOf(key: string, versionId: string): Promise<void> {
  const client = ws?.stores.client
  if (!client?.getPresignedUrl) return
  const name = key.split('/').filter(Boolean).pop() ?? key
  triggerDownload(
    client.getPresignedUrl(key, undefined, undefined, {
      versionId,
      'response-content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
    }),
    name,
  )
}

async function reloadTrash(): Promise<void> {
  const tree = ws?.stores.tree
  if (!tree) return
  trashBusy.value = true
  try {
    trashEntries.value = await tree.listTrash({})
  } catch (e) {
    toast.error(e instanceof Error && e.message ? e.message : t('files.msg.op-failed'))
  } finally {
    trashBusy.value = false
  }
}

/**
 * restore/purge/empty 后的刷新链闭环（reviewer-C P2-2 归口：restore/purge 后节点回流）：
 * ① 树缓存最小维护走 applyChange（tree 现有通道；put=恢复回流、delete=清除；对未缓存父目录是
 *    空操作，懒加载打开即最新）——已知边界：purge 复验跳过的活 key 若在其他已缓存目录存在陈旧
 *    缺失窗口（跳过仅发生在 listTrash 后该 key 被恢复/重传的并发场景，cmd:refresh 可兜底）；
 * ② 当前目录 loadDir(force) 兜底权威数据（恢复回流 size=0 最小条目由此校正）；
 * ③ 恢复方向补 bus 'fileChanged'(put)：宿主此前经树删除链收到过 delete，恢复后同步回流
 *    （purge 方向 key 本就不可见，不重复外发）；
 * ④ 回收站列表重拉（reloadTrash 收口）。
 */
async function afterTrashChanged(keys: string[], action: 'put' | 'delete', emitHost: boolean): Promise<void> {
  const tree = ws?.stores.tree
  if (tree) {
    for (const key of keys) tree.applyChange({ key, action })
    void tree.loadDir(tree.currentPath, { force: true })
  }
  if (emitHost) {
    const bootHandle = boot && boot.ok ? boot.handle : null
    for (const key of keys) {
      try {
        bootHandle?.bus.emit('fileChanged', { key, action })
      } catch {
        // 事件通道不可用不影响本地刷新链
      }
    }
  }
  await reloadTrash()
}

/**
 * @restore → workspace-ops.restoreEntries。
 * 接线对齐点（并行 agent 正实现 workspace-ops，缺导出为中间态红）：契约签名
 * restoreEntries(entries: TrashEntry[]): Promise<…>，取消/失败返回 null/抛错沿用
 * removeEntries 惯例（null 不得回流树缓存——防幽灵节点），故成功与否按非 null 判定。
 */
async function onTrashRestore(sel: TrashEntry[]): Promise<void> {
  if (!ops || sel.length === 0) return
  trashBusy.value = true
  let done = false
  try {
    const r: unknown = await ops.restoreEntries(sel)
    done = r !== null && r !== undefined
  } catch {
    done = false // 聚合错（TrashBatchError 部分成功）由 ops 层 toast；列表下方重拉对齐真实状态
  }
  if (done) await afterTrashChanged(sel.map((e) => e.key), 'put', true)
  else await reloadTrash()
  trashBusy.value = false
}

/** @purge → workspace-ops.purgeEntries（内部含确认框；接线对齐点同 onTrashRestore） */
async function onTrashPurge(sel: TrashEntry[]): Promise<void> {
  if (!ops || sel.length === 0) return
  trashBusy.value = true
  let done = false
  try {
    const r: unknown = await ops.purgeEntries(sel)
    done = r !== null && r !== undefined
  } catch {
    done = false
  }
  if (done) await afterTrashChanged(sel.map((e) => e.key), 'delete', false)
  else await reloadTrash()
  trashBusy.value = false
}

/**
 * @empty → 确认框（TrashPanel 纯展示不做确认，文案硬性要求「清空回收站不可恢复」）→
 * tree.emptyTrash() → 刷新链（applyChange delete + loadDir force + 列表重拉）。
 */
async function onTrashEmpty(): Promise<void> {
  const tree = ws?.stores.tree
  if (!tree) return
  try {
    await toast.confirm({
      title: t('files.trash.empty'),
      message: t('files.trash.empty-confirm'),
      type: 'warning',
    })
  } catch {
    return // 取消
  }
  trashBusy.value = true
  try {
    const keys = trashEntries.value.map((e) => e.key)
    const { purged } = await tree.emptyTrash({})
    toast.success(t('files.trash.empty-done', { n: purged }))
    await afterTrashChanged(keys, 'delete', false)
  } catch (e) {
    toast.error(e instanceof Error && e.message ? e.message : t('files.msg.op-failed'))
    await reloadTrash() // 失败可能是部分清空（TrashBatchError 聚合）：重拉对齐
  } finally {
    trashBusy.value = false
  }
}

/**
 * R2-01：命令面板「打开传输面板」（cmd:transfers）——滚动定位 + 短暂高亮；
 * 面板未渲染（无任何任务）时以 toast 兜底告知当前无传输任务。
 */
/** 粘贴上传（Lane G1）：clipboardData.files>0 → 入队当前目录（features.upload 门控，卸载解绑） */
function onPaste(e: ClipboardEvent): void {
  if (!ws || features.value.upload === false) return
  const files = Array.from(e.clipboardData?.files ?? [])
  if (files.length === 0) return
  e.preventDefault() // 文件粘贴由上传链接管（文本粘贴不受影响）
  void trackedEnqueue(files, ws.stores.tree.currentPath)
}

// ── 预览打开链（M2 + F5 @open/@open-with + Lane H1 预览 Tab 条：预览态/钉住/LRU） ──

const previewEl = ref<HTMLElement | null>(null)
let preview: PreviewHandle | null = null
/** bus 'expired' 监听解绑（onBeforeUnmount 用） */
let offExpired: (() => void) | null = null

/**
 * Lane H1：tab 状态由 Home 持有（PreviewTabs 纯受控，语义函数收口在组件内导出）。
 * tab=打开历史条目（单内容区不并存多渲染器；切回=preview.open 重跑+savedState 回注）。
 */
const previewTabs = ref<PreviewTab[]>([])
const activeTabKey = ref<string | null>(null)
/** onOpened 归位时关联的「打开方式」应用（最近一次 openEntry 透传；被接管的旧链不触发 onOpened，链序自洽） */
let pendingOpenAppId: string | undefined
/** 三审修复①：挂起的「关激活 tab→换邻位」——open 链 gate 放行（onOpened）后才移除被关 tab；
 *  被暂缓/取消时零 tab 变更（被关 tab 保留，与「零半更新」口径一致）。 */
let pendingCloseKey: string | null = null

/** onOpened（open 链接管容器=成功信号）：tab 归位（预览态替换/追加+LRU 淘汰）→ activeKey 同步。
 *  被暂缓/取消的 open 不触发本回调——tab 状态零变更，与预览区严格一致。 */
function onPreviewOpened(entry: S3ObjectSummary): void {
  if (pendingCloseKey !== null) {
    const i = previewTabs.value.findIndex((t) => t.entry.key === pendingCloseKey)
    if (i >= 0) previewTabs.value.splice(i, 1)
    pendingCloseKey = null
  }
  applyOpenedTab(previewTabs.value, entry, activeTabKey.value, pendingOpenAppId, features.value.multiTab !== false)
  activeTabKey.value = entry.key
}

/** 统一打开链收口：树双击/菜单「打开」/「打开方式」/搜索打开/ui.defaultOpen 全走此口（file 模式不经此） */
function openEntry(entry: S3ObjectSummary, appId?: string): void {
  if (!preview) return
  pendingOpenAppId = appId
  void preview.open(entry, appId !== undefined ? { appId } : undefined)
}

function onOpen(entry: S3ObjectSummary): void {
  openEntry(entry)
}

function onOpenWith(payload: { entry: S3ObjectSummary; appId: string }): void {
  openEntry(payload.entry, payload.appId)
}

/** 抽屉模式专属：打开/打开方式后收起抽屉（用户订单：打开文件即关抽屉，内容区全宽展示） */
function onDrawerOpen(entry: S3ObjectSummary): void {
  onOpen(entry)
  treeDrawerOpen.value = false
}

function onDrawerOpenWith(payload: { entry: S3ObjectSummary; appId: string }): void {
  onOpenWith(payload)
  treeDrawerOpen.value = false
}

/** 单击 tab=切回：preview.open（savedState 回注），复用该 tab 最近一次的应用（无则默认应用）；已激活=无操作 */
function onTabActivate(entry: S3ObjectSummary): void {
  if (!preview || entry.key === activeTabKey.value) return
  openEntry(entry, findTab(previewTabs.value, entry.key)?.appId)
}

/** 当前预览应用信息（用户口径：工具栏徽标显示应用名，多应用可切换）——激活 tab 的命中应用集 + 当前项 */
const previewAppInfo = computed(() => {
  const reg = registry.value
  const tab = activeTabKey.value ? findTab(previewTabs.value, activeTabKey.value) : null
  if (!reg || !tab || tab.entry.isDir) return null
  const matches = reg.listMatches(tab.entry)
  if (matches.length === 0) return null
  const currentId = tab.appId ?? reg.resolveDefault(tab.entry)?.id ?? matches[0]!.id
  return { currentId, options: matches.map((d) => ({ id: d.id, label: t(d.label ?? d.id) })) }
})

/** 徽标切应用：openEntry 复用「打开方式」链（preview.open({appId}) + tab.appId 记忆） */
function onSwitchPreviewApp(appId: string): void {
  const tab = activeTabKey.value ? findTab(previewTabs.value, activeTabKey.value) : null
  if (!tab) return
  openEntry(tab.entry, appId)
}

/** 双击 tab=钉住/取消钉（纯 tab 状态，不触预览链）；钉满 PIN 上限被拒 → 轻提示 */
function onTabPinToggle(key: string): void {
  if (!pinToggle(previewTabs.value, key)) ElMessage.warning(t('files.tabs.pin-limit'))
}

/** 关闭钮=关该 tab。非激活直接移除；激活中→清预览（走 gate，被暂缓则保留 tab=零半更新）并激活相邻 tab
 *  （右邻优先，pickNeighbor 口径）；最后一个 tab 关闭后 tab 条随之隐藏（仅 tabs.length>0 渲染）。 */
async function onTabClose(entry: S3ObjectSummary): Promise<void> {
  const idx = previewTabs.value.findIndex((t) => t.entry.key === entry.key)
  if (idx < 0) return
  if (entry.key !== activeTabKey.value) {
    previewTabs.value.splice(idx, 1)
    return
  }
  const neighbor = pickNeighbor(previewTabs.value, entry.key)
  if (!neighbor) {
    const closed = preview ? await preview.close() : true
    if (closed) {
      previewTabs.value.splice(idx, 1)
      activeTabKey.value = null
    }
    return
  }
  // 有邻位：先走 open 链（gate 裁决），成功（onOpened）后才移除被关 tab——
  // 三审修复①：原实现先 splice 后 open，gate 暂缓时 tab 条与预览区分裂。
  // 若此期间用户又触发其他 open（seq 接管），onOpened 消费 pendingCloseKey 仍移除被关 tab（语义不变）。
  pendingCloseKey = entry.key
  openEntry(neighbor.entry, neighbor.appId)
}

/** 右键菜单动作 → workspace-ops 收口（与 Toolbar 同链）；结果维护选中集。
 *  2026-10：TreePanel menu-action 的 entry 变可选（mkdir 无 entry）；其余动作缺失 entry 静默忽略。 */
async function onMenuAction(payload: {
  action: 'upload' | 'rename' | 'delete' | 'download' | 'share' | 'mkdir'
  entry?: S3ObjectSummary
}): Promise<void> {
  if (!ops) return
  if (payload.action === 'mkdir') {
    // 右键目录=其内建（文件=其所在目录，与上传同口径）；entry 缺失（异常路径）=当前目录
    await ops.createDir(payload.entry)
    return
  }
  const { entry } = payload
  if (!entry) return
  if (payload.action === 'upload') {
    // 上传到该目录（目录=其内；文件=其所在目录）——行右键菜单入口，统一走上传确认弹窗
    openUploadDialog(entry.isDir ? entry.key : parentPrefixOf(entry.key))
    return
  }
  if (payload.action === 'rename') {
    const r = await ops.renameEntry(entry)
    if (r) onChanged(r.from)
  } else if (payload.action === 'delete') {
    const keys = await ops.removeEntries([entry])
    if (keys) for (const k of keys) onChanged(k)
  } else if (payload.action === 'download') {
    void downloadEntries([entry])
  } else if (payload.action === 'share') {
    openShare(entry)
  }
}

/** 拖拽落文件 → 带登记入队 + 拒收 toast（features.upload 门控：false 整链禁用，静默忽略）。
 *  Lane G1：trackedEnqueue 自收敛拒收 toast（异步链），不再经 ops.ingestFiles 转发。 */
function onDropFiles(payload: { files: File[]; path: string }): void {
  if (!ws || !ops || payload.files.length === 0) return
  if (features.value.upload === false) return
  void trackedEnqueue(payload.files, payload.path)
}

/**
 * 下载执行链（Lane F5 收口）：单文件 client.get → blob → triggerDownload（目录禁用）；
 * 多选（均非目录）→ 预算护栏（累计 256MB）→ 全量取流 → zip.ts store 打包 → triggerDownload。
 * Toolbar 批量下载、右键菜单下载、preview fallback/错误节点下载钮共用。
 */
async function downloadEntries(entries: S3ObjectSummary[]): Promise<void> {
  if (!ws) return
  const files = entries.filter((e) => !e.isDir)
  if (files.length === 0) return
  if (files.length === 1) {
    const entry = files[0]!
    // Lane G1：单文件下载入传输队列（get→blob→triggerDownload + 任务中心可视/取消/重试）；
    // 多选 zip 打包仍直连（打包管线不在 DownloadQueue 职责内，见下）
    downloads?.enqueue([entry.key])
    return
  }
  const total = files.reduce((sum, f) => sum + f.size, 0)
  if (total > ZIP_SIZE_LIMIT) {
    toast.warning(t('files.msg.zip-too-large', { limit: '256MB' }))
    return
  }
  const items: { name: string; data: Uint8Array }[] = []
  for (const f of files) {
    const buf = await ws.stores.client.get(f.key).then((res) => res.arrayBuffer())
    items.push({ name: f.name, data: new Uint8Array(buf) })
  }
  const zipped = zipStore(items)
  triggerDownload(
    URL.createObjectURL(new Blob([zipped as BlobPart], { type: 'application/zip' })),
    zipFileName(),
  )
}

function zipFileName(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `files-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`
}

/** 浏览器内全屏预览卡：.is-page-fs 用 position:fixed 铺满视口（非系统 Fullscreen API）；Esc/再点退出。
 *  嵌入态同步发 previewFullscreen 事件给宿主（顶级文档），由宿主决定如何铺满（如舞台最大化） */
const previewFullscreen = ref(false)
const emitFsState = (): void => {
  const bootHandle = boot && boot.ok ? boot.handle : null
  try {
    bootHandle?.bus.emit('previewFullscreen', { on: previewFullscreen.value })
  } catch {
    // 事件通道不可用（直连态等）不影响本页全屏
  }
}
const togglePreviewFullscreen = (): void => {
  previewFullscreen.value = !previewFullscreen.value
  emitFsState()
}
const onFsKeydown = (ev: KeyboardEvent): void => {
  if (ev.key === 'Escape' && previewFullscreen.value) {
    previewFullscreen.value = false
    emitFsState()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onFsKeydown)
  // Lane G1：粘贴上传（workspace 且 features.upload 开启时生效；onPaste 内部二次门控）
  if (ws) window.addEventListener('paste', onPaste)
  if (!previewEl.value) return
  const bootHandle = boot && boot.ok ? boot.handle : null
  if (!bootHandle) return
  // Lane F3：会话过期联动——通知式清空预览舞台 + tab 历史归零（workspace 的 SessionBanner 整屏蒙层已自带）
  offExpired = bootHandle.bus.on('expired', () => {
    preview?.expire()
    previewTabs.value = []
    activeTabKey.value = null
  })
  if (ws) {
    preview = createPreview({
      container: previewEl.value,
      registry: bootHandle.registry,
      datasource: s3DataSource(ws.stores.client),
      t: (key, params) => t(key, params ?? {}), // Lane G4：params 透传（largefile.rejected {limit} 插值）
      theme: {},
      // Lane F3（审计 P0）：renderer 保存 → 树缓存最小维护（applyChange）+ bus 'fileChanged' 外发宿主。
      // 树自身动作（mkdir/rename/remove）的 fileChanged 仍走 setupStores 的 onFileChanged，两链不重复。
      notifyFileChanged: (payload) => {
        ws.stores.tree.applyChange(payload)
        bootHandle.bus.emit('fileChanged', payload)
      },
      // 应用级故障出口（渲染失败/保存链失败——宿主 toast/换签; 契约 §六 error 事件第二源）
      notifyAppError: (err) => {
        bootHandle.bus.emit('error', err)
      },
      ensureApps: bootHandle.ensureApps,
      canDownload: features.value.download !== false,
      // Lane H1：open 链接管容器 → tab 归位 + activeKey 同步（预览 tab 条数据源）
      onOpened: onPreviewOpened,
      // Lane G4 确认档接线：CONFIRM(20MB)~REJECT(50MB) 询问（关闭/取消=false=取消本次打开）
      confirmLargeFile: async (entry, sizeBytes) => {
        try {
          await ElMessageBox.confirm(t('largefile.confirm', { size: formatBytes(sizeBytes) }), entry.name, {
            confirmButtonText: t('common.confirm'),
            cancelButtonText: t('common.cancel'),
            type: 'warning',
          })
          return true
        } catch {
          return false
        }
      },
      onDownload: (entry) => void downloadEntries([entry]),
    })
    // Lane F3：ui.defaultOpen——口径：相对 backend.prefix 的路径，非绝对 bucket key
    // （JSSDK §五 payload 注记①「路径类字段=相对 backend.prefix 的对象键」；手册 §一示例
    // prefix='sessions/…/' + defaultOpen='reports/summary.md'），'/' 即 prefix 根。
    // 挂载后构造伪条目走统一打开链（Lane H1：经 tab 链，不经树选中）；配置为空/纯 '/' 则跳过。
    if (bootHandle.config.mode === 'workspace') {
      const rel = (bootHandle.config.ui?.defaultOpen ?? '').replace(/^\/+/, '')
      if (rel) {
        const key = `${normalizePrefix(ws.rootPrefix)}${rel}`
        openEntry({ key, name: rel.slice(rel.lastIndexOf('/') + 1) || rel, size: 0, isDir: false })
      }
    }
    return
  }
  if (fileConfig) {
    // F2 单文件模式：UrlSourceProvider→urlDataSource→复用 createPreview；
    // 伪条目只有 name 有语义（urlDataSource 忽略 key），registry 按扩展名解析默认应用；
    // 可编辑性由 config.save 决定（UrlSourceProvider.put 无 save 段即 4305，编辑链自然被拒）。
    const provider = new UrlSourceProvider({ source: fileConfig.source, save: fileConfig.save })
    preview = createPreview({
      container: previewEl.value,
      registry: bootHandle.registry,
      datasource: urlDataSource(provider),
      t: (key, params) => t(key, params ?? {}), // Lane G4：params 透传（largefile.rejected {limit} 插值）
      theme: {},
      // Lane F3（JSSDK §四）：file 模式 save 回写成功 → fileChanged(put) 外发宿主（无树可维护）。
      notifyFileChanged: (payload) => {
        bootHandle.bus.emit('fileChanged', payload)
      },
      // 应用级故障出口（渲染失败/保存链失败——宿主 toast/换签重载; 契约 §六 error 事件第二源）
      notifyAppError: (err) => {
        bootHandle.bus.emit('error', err)
      },
      ensureApps: bootHandle.ensureApps,
      canDownload: features.value.download !== false,
    })
    // 无源装载（url=''）不自动打开——boot 后舞台留白等 uploadFiles（防内存文件加载时源文件闪现）
    if (fileSourceUrl) {
      void preview.open({ key: fileName, name: fileName, size: 0, isDir: false },
        fileConfig.appId ? { appId: fileConfig.appId } : undefined)
    }
  }
})
onBeforeUnmount(() => {
  offExpired?.()
  offExpired = null
  window.removeEventListener('paste', onPaste) // Lane G1：粘贴上传解绑
  stopUploadPoller()
  if (tickTimer !== null) clearInterval(tickTimer)
  window.removeEventListener('keydown', onFsKeydown)
  preview?.clear()
})

// 换目录后选中项不在视野内：清选（防"看不见的删除"）
watch(
  () => ws?.stores.tree.currentPath,
  () => {
    selected.value = []
  },
)

/** 会话剩余（复审 #10：静态快照 → 1s 心跳实时倒计时；格式化纯函数见 session-format.ts） */
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})

// 内存文件 opener（uploadFiles target='memory' → mem-store 落库后回调打开预览；mem:// 由
// DataSource 分支供数，preview.open 对来源无感）。闭包引用 let preview——回调执行晚于挂载。
onMounted(() => {
  setMemFileOpener((entry, hint) => {
    void preview?.open(
      { key: entry.key, name: entry.name, size: entry.size, isDir: false },
      { appId: hint?.appId, appOptions: hint?.appOptions },
    )
  })
})
onBeforeUnmount(() => setMemFileOpener(null))

const remainingMs = computed<number | null>(() => {
  if (!boot || !boot.ok) return null
  void nowTick.value // 建立心跳依赖：每秒重算
  const ms = boot.handle.session.remainingMs()
  return Number.isFinite(ms) ? Math.max(0, ms) : null
})
const sessionInfo = computed(() => {
  const ms = remainingMs.value
  return ms === null ? null : formatRemaining(ms)
})
/** T-5min 预览区顶部提示（手册「编辑器顶部提示」条目；与 SessionBanner 面板横幅并存=手册的两处提示口径） */
const showExpireHint = computed(() => remainingMs.value !== null && remainingMs.value <= EXPIRE_WARN_BEFORE_MS)

/** 信息窗语言行（2026-10 自头部迁入）：FcSegmented 直连 preference（即时生效+持久化） */
const localeModel = computed<'zh-CN' | 'en-US'>({
  get: () => preference.locale as 'zh-CN' | 'en-US',
  set: (v) => preference.setLocale(v),
})
const localeOptions = [
  { label: '中', value: 'zh-CN' },
  { label: 'EN', value: 'en-US' },
]

// ── 2026-10 布局改版：左侧文件树可拖动调宽（200~480px）、可隐藏（分隔条折叠钮/双击） ──

const treeWidth = ref(280)
const treeHidden = ref(false)
function onSplitterDown(e: PointerEvent): void {
  if (treeHidden.value) return
  e.preventDefault()
  const startX = e.clientX
  const startW = treeWidth.value
  const move = (ev: PointerEvent) => {
    treeWidth.value = Math.min(480, Math.max(120, startW + (ev.clientX - startX))) // 下限 120：文件名省略号兜底，再窄可折叠
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// ── Wave G 集成：全局搜索面板（G2）/ 状态栏（G3）/ 本地连接向导（G5） ──

const searchOpen = ref(false)
const wizardOpen = ref(false)

// ── Lane H-2 分享生成器：单实例对话框，Toolbar 与右键菜单两个入口共用 ──

const shareOpen = ref(false)
const shareEntry = ref<S3ObjectSummary | null>(null)

/** 打开分享对话框（入口：Toolbar 分享钮 / TreePanel 右键菜单 share 项，均仅文件可达） */
function openShare(entry: S3ObjectSummary): void {
  shareEntry.value = entry
  shareOpen.value = true
}

/** G2：搜索结果「打开」——构造伪条目走统一打开链（Lane H1 经 tab 链；size 0 跳过大文件闸，下游渲染器自有限额兜底） */
function onSearchOpen(payload: { key: string }): void {
  const key = payload.key
  openEntry({ key, name: key.slice(key.lastIndexOf('/') + 1) || key, size: 0, isDir: false })
}

/** G2：搜索结果「定位目录」——进入其父目录（树缓存懒加载自然覆盖） */
function onSearchLocate(payload: { key: string }): void {
  const parent = payload.key.slice(0, payload.key.lastIndexOf('/') + 1)
  if (parent) void ws?.stores.tree.loadDir(parent)
}

/** G3 状态栏数据源：传输中任务数（上传 uploading/paused + 下载 active） */
/** G3 只读语义：workspace=写类 features 全显式关闭；file=无 save 段（降级可见，非报错形态） */
const isReadonly = computed(() => {
  if (ws) return ['upload', 'mkdir', 'rename', 'delete'].every((k) => features.value[k] === false)
  if (fileConfig) return !fileConfig.save
  return false
})
const bucketName = computed(() =>
  boot && boot.ok && boot.handle.config.mode === 'workspace' ? boot.handle.config.backend.bucket : '',
)

// ── Lane H5 收口：命令面板双模式数据源（仅 workspace 注册；seam=useCommandPaletteState）──
if (ws) {
  // 文件模式：SearchIndex 元数据检索（索引起点=SearchDialog「扫描当前前缀」）
  const searchIndex = new SearchIndex(createIdbMetaStore())
  registerFileSearchProvider(async (query) => {
    const q = query.trim()
    if (q === '') return []
    const rows = await searchIndex.search({ glob: q, rootPrefix: ws.rootPrefix, limit: 20 })
    // R2-07：冷启动空结果引导——索引 0 条（从未扫描/空桶）时不再裸「无匹配」回退，
    // 返回一条引导行（label=search.index-hint、动作=打开搜索面板去「扫描当前前缀」）。
    if (rows.length === 0 && (await searchIndex.stats()).count === 0) {
      return [
        {
          id: 'hint:scan-index',
          labelKey: 'search.index-hint',
          description: t('search.scan'),
          group: 'file',
          icon: 'ri-scan-2-line',
          handler: () => { searchOpen.value = true },
        },
      ]
    }
    return rows.map((r: MetaRow) => ({
      id: `file:${r.key}`,
      label: r.name,
      description: r.key,
      group: 'file',
      // 三审修复②：走统一打开链收口（直连 preview?.open 会残留 pendingOpenAppId，陈旧 appId 污染新 tab）
      handler: () => openEntry({ key: r.key, name: r.name, size: r.size, isDir: false }),
    }))
  })
  // 命令模式：工作台真实动作（新动作在此追加，自动进「最近使用」排序）
  registerCommandsProvider(() => [
    { id: 'cmd:search', labelKey: 'search.title', icon: 'ri-search-line', handler: () => { searchOpen.value = true } },
    {
      id: 'cmd:refresh',
      labelKey: 'files.toolbar.refresh',
      icon: 'ri-refresh-line',
      handler: () => void ws.stores.tree.loadDir(ws.stores.tree.currentPath, { force: true }),
    },
    { id: 'cmd:goto-root', labelKey: 'files.tree.root', icon: 'ri-home-4-line', handler: () => void ws.stores.tree.loadDir(ws.rootPrefix) },
    { id: 'cmd:toggle-locale', labelKey: 'home.toggle-locale', icon: 'ri-translate-2', handler: () => { localeModel.value = localeModel.value === 'zh-CN' ? 'en-US' : 'zh-CN' } },
    // R2-01 顺带：传输面板入口（此前唯一入口是底部常驻面板条本身）
    { id: 'cmd:transfers', labelKey: 'statusbar.transfers', icon: 'ri-arrow-left-right-line', handler: () => openTransferPanel() },
    // M3：回收站入口（预览头回收站钮之外的第二入口）
    { id: 'cmd:trash', labelKey: 'files.trash.title', icon: 'ri-delete-bin-line', handler: () => { trashOpen.value = true } },
  ])
}
</script>

<template>
  <div class="home-page" :class="{ 'is-workspace': ws, 'is-file': fileConfig, 'is-embed': isEmbeddedFile }">
    <!-- ① boot 失败：配置错误卡（保留 M0） -->
    <FcSectionCard v-if="boot && !boot.ok" class="home-hero" padding="lg">
      <h1 class="home-hero__title">{{ t('boot.config-error') }}</h1>
      <p class="home-hero__subtitle">code={{ boot.error.code }} · {{ boot.error.message }}</p>
      <!-- Lane G5：无 #config 时可走本地连接向导（凭据不进 URL/历史，经 sessionStorage 备份链重载） -->
      <FcButton variant="secondary" data-testid="wizard-open" @click="wizardOpen = true">
        {{ t('wizard.title') }}
      </FcButton>
      <ConnectWizard v-model:open="wizardOpen" />
    </FcSectionCard>

    <!-- ② workspace：会话横幅 + 左树（可拖宽/可隐藏）右预览（M2 换多 tab；Toolbar 挂预览头右侧）+ 上传任务面板（F5） -->
    <div v-else-if="ws" class="ws">
      <!-- 2026-10：信息头移除——模式/存储桶/会话/语言全量收进 ⓘ 信息窗（预览头右侧） -->
      <SessionBanner :session="ws.session" />
      <!-- 复审 #10：T-5min 顶部细条提示（SessionBanner 面板横幅之外的第二处提示位，手册口径） -->
      <div v-if="showExpireHint" class="ws__expire-hint" data-testid="session-top-warn">
        {{ t('files.session.warn') }}
      </div>
      <div class="ws__body">
        <!-- 2026-10：树宽走 inline style（分隔条拖拽调 200~480px），flex:none 防 flex 拉伸；
             drawer 模式（ui.treeMode=drawer）不渲染常驻侧栏/分隔条，树由左抽屉承载 -->
        <TreePanel
          v-if="!isDrawerTree"
          v-show="!treeHidden"
          class="ws__tree"
          :style="{ width: treeWidth + 'px', flex: 'none' }"
          :controller="ws.stores.tree"
          :root-prefix="ws.rootPrefix"
          :tree-title="treeTitle"
          :selected="selected"
          :features="features"
          :versioning="versionCapable"
          :registry="registry"
          @select="onSelect"
          @open="onOpen"
          @open-with="onOpenWith"
          @menu-action="onMenuAction"
          @drop-files="onDropFiles"
          @upload-request="onTreeUploadRequest"
          @open-history="versionKey = $event"
          @search="searchOpen = true"
          @trash="trashOpen = true"
        />
        <div
          v-if="!isDrawerTree"
          class="ws__splitter"
          data-testid="tree-splitter"
          @pointerdown="onSplitterDown"
          @dblclick="treeHidden = !treeHidden"
        >
          <button
            type="button"
            class="ws__splitter-toggle"
            data-testid="tree-toggle"
            :title="treeHidden ? t('files.tree.expand') : t('files.tree.collapse')"
            @click.stop="treeHidden = !treeHidden"
          >
            <i :class="treeHidden ? 'ri-arrow-right-s-line' : 'ri-arrow-left-s-line'" />
          </button>
        </div>
        <FcSectionCard class="ws__preview" :class="{ 'is-page-fs': previewFullscreen }" padding="none">
          <!-- 预览区头 = [抽屉唤起钮（仅 drawer 模式）| PreviewTabs（左，自适应）| Toolbar 选中簇（右）]（2026-10 布局改版） -->
          <div class="ws__preview-head">
            <!-- 左抽屉模式：文件区左上角文件图标 → 唤起文件树抽屉 -->
            <button
              v-if="isDrawerTree"
              type="button"
              class="ws__drawer-btn"
              data-testid="tree-drawer-open"
              :title="t('files.tree.drawer-open')"
              :aria-label="t('files.tree.drawer-open')"
              @click="treeDrawerOpen = true"
            >
              <i class="ri-file-list-line" />
            </button>
            <!-- Lane H1：预览 Tab 条（预览态/钉住/LRU；纯受控，状态在 Home；file 模式不挂） -->
            <PreviewTabs
              :tabs="previewTabs"
              :active-key="activeTabKey"
              @activate="onTabActivate"
              @close="onTabClose"
              @pin-toggle="onTabPinToggle"
            />
            <!-- 2026-10：无文件（无 tab）时不显示选中簇 -->
            <Toolbar
              v-show="previewTabs.length > 0"
              :controller="ws.stores.tree"
              :selected="selected"
              :features="features"
              :preview-app="previewAppInfo"
              @changed="onChanged"
              @download="downloadEntries"
              @share="openShare"
              @switch-app="onSwitchPreviewApp"
            />
            <!-- M3：回收站入口 2026-10 迁入树头动作簇（TreePanel trash-open，ri-recycle-line）；
                 抽屉仍在此承载 TrashPanel -->
            <!-- 全屏预览卡（2026-10：整卡放大；浏览器内全屏，Esc/再点退出；无文件也常驻，与 [i] 同列最右） -->
            <button
              type="button"
              class="ws__fs-btn"
              data-testid="preview-fullscreen"
              :title="previewFullscreen ? t('files.exit-fullscreen') : t('files.fullscreen')"
              :aria-label="previewFullscreen ? t('files.exit-fullscreen') : t('files.fullscreen')"
              @click="togglePreviewFullscreen"
            >
              <i :class="previewFullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'" />
            </button>
            <!-- 传输任务中心入口（2026-10 并入上传弹窗「传输」页签；角标=进行中任务数） -->
            <button
              type="button"
              class="ws__transfer-btn"
              data-testid="transfers-open"
              :title="t('transfer.title')"
              :aria-label="t('transfer.title')"
              @click="openTransferPanel"
            >
              <i class="ri-arrow-left-right-line" />
              <span v-if="activeTransferCount > 0" class="ws__transfer-badge" data-testid="transfers-badge">
                {{ activeTransferCount > 99 ? '99+' : activeTransferCount }}
              </span>
            </button>
            <!-- ⓘ 状态弹窗（2026-10 迁入文件工具栏最右侧；无文件时常显） -->
            <span class="ws__info-wrap">
              <FcPopover trigger="click" placement="bottom-end" :width="264">
                <!-- trigger=click 默认自带 toggle（组件内 el-popover 包裹 reference），无需手接开关 -->
                <template #trigger>
                  <button
                    type="button"
                    class="ws__info-btn"
                    data-testid="session-info"
                    :title="t('statusbar.session')"
                    :aria-label="t('statusbar.session')"
                  >
                    <i class="ri-information-line" />
                  </button>
                </template>
                <div class="ws__info-pop">
                  <p><span>{{ t('statusbar.mode') }}</span><b>{{ ws.mode }}</b></p>
                  <p><span>{{ t('statusbar.bucket') }}</span><b>{{ bucketName || '-' }}</b></p>
                  <p><span>{{ t('statusbar.session') }}</span><b>{{ sessionInfo || '-' }}</b></p>
                  <p v-if="isReadonly"><span>{{ t('statusbar.readonly') }}</span><b>{{ t('statusbar.readonly-hint') }}</b></p>
                  <!-- 2026-10：语言切换自头部迁入信息窗（即时生效，持久化在 preference store） -->
                  <div class="ws__info-pop__lang">
                    <span>{{ t('home.toggle-locale') }}</span>
                    <FcSegmented v-model="localeModel" :options="localeOptions" size="sm" />
                  </div>
                </div>
              </FcPopover>
            </span>
          </div>
          <div ref="previewEl" class="ws__preview-host" />
        </FcSectionCard>
        <!-- 左抽屉模式：文件树面板（与侧栏同组件同 props，仅容器不同；TreePanel 单实例逻辑零复制）；
             无标题栏（with-header=false），全高树体 -->
        <FcDrawer
          v-if="isDrawerTree"
          v-model:open="treeDrawerOpen"
          direction="ltr"
          size="300px"
          :with-header="false"
        >
          <div class="ws__drawer-tree">
            <TreePanel
              :controller="ws.stores.tree"
              :root-prefix="ws.rootPrefix"
              :tree-title="treeTitle"
              :selected="selected"
              :features="features"
              :versioning="versionCapable"
              :registry="registry"
              @select="onSelect"
              @open="onDrawerOpen"
              @open-with="onDrawerOpenWith"
              @menu-action="onMenuAction"
              @drop-files="onDropFiles"
              @upload-request="onTreeUploadRequest"
              @open-history="versionKey = $event"
              @search="searchOpen = true"
              @trash="trashOpen = true"
            />
          </div>
        </FcDrawer>
      </div>
      <!-- M2 接线：resume 断点续传面包条（候选列表 path/size + 重选文件续传/放弃；关闭=保留断点） -->
      <div v-if="showResumeBanner" class="ws__resume" data-testid="resume-banner">
        <div class="ws__resume-head">
          <i class="ri-upload-cloud-line ws__resume-icon" />
          <span class="ws__resume-title">{{ t('transfer.resume-title', { n: resumeCandidates.length }) }}</span>
          <span class="ws__resume-spacer" />
          <button
            type="button"
            class="ws__resume-close"
            data-testid="resume-dismiss"
            :title="t('transfer.resume-dismiss')"
            :aria-label="t('transfer.resume-dismiss')"
            @click="resumeBannerClosed = true"
          >
            <i class="ri-close-line" />
          </button>
        </div>
        <ul class="ws__resume-list">
          <li v-for="c in resumeCandidates" :key="c.fingerprint" class="ws__resume-item" data-testid="resume-item">
            <span class="ws__resume-path" :title="c.path">{{ c.path }}</span>
            <span class="ws__resume-size">{{ formatBytes(c.size) }}</span>
            <FcButton variant="text" size="sm" data-testid="resume-resume" @click="pickResumeFile(c)">
              {{ t('transfer.resume-pick') }}
            </FcButton>
            <FcButton variant="text" size="sm" data-testid="resume-discard" @click="onDiscardResume(c)">
              {{ t('transfer.resume-discard') }}
            </FcButton>
          </li>
        </ul>
        <p class="ws__resume-hint">{{ t('transfer.resume-hint') }}</p>
      </div>
      <!-- 「重选文件续传」的常驻隐藏 input（与横幅显隐解耦；change → onResumeFilePicked 三路径校验） -->
      <input
        ref="resumeFileInput"
        type="file"
        class="ws__resume-input"
        aria-hidden="true"
        tabindex="-1"
        @change="onResumeFilePicked"
      />
      <!-- Lane G1：传输任务中心 2026-10 并入上传弹窗「传输」页签（底部悬浮面板退役）；
           入口=预览头传输钮（角标=进行中数）/⌘K「传输任务」/上传弹窗切页签 -->
      <UploadDialog
        v-model:open="uploadDialogOpen"
        :dir="uploadDialogDir"
        :tab="uploadDialogTab"
        @confirm="onUploadDialogConfirm"
      >
        <template #transfer>
          <UploadPanel
            embedded
            :tasks="uploadTasks"
            :downloads="downloads?.tasks ?? []"
            @pause="onPauseUpload"
            @resume="onResumeUpload"
            @retry="onRetryUpload"
            @cancel="onCancelUpload"
            @clear="onClearUploads"
            @download-cancel="onCancelDownload"
            @download-retry="onRetryDownload"
            @download-clear="onClearDownloads"
          />
          <FcEmpty
            v-if="transferEmpty"
            type="no-data"
            :title="t('transfer.empty')"
            data-testid="transfer-empty"
          />
        </template>
      </UploadDialog>
      <!-- Lane G2：全局搜索面板（扫描/过滤/打开/定位） -->
      <SearchDialog
        v-model:open="searchOpen"
        :client="ws.stores.client"
        :root-prefix="ws.rootPrefix"
        @open="onSearchOpen"
        @locate="onSearchLocate"
      />
      <!-- Lane H-2：分享链接生成器（GET/PUT 预签名；client 缺能力/目录条目=禁用态） -->
      <ShareDialog v-model:open="shareOpen" :client="ws.stores.client" :entry="shareEntry" />
      <!-- M3：回收站抽屉（TrashPanel 纯展示：restore/purge/empty 三路 emit 全接，业务执行在 Home/workspace-ops 收口） -->
      <FcDrawer v-model:open="trashOpen" :title="t('files.trash.title')" direction="rtl" size="480px">
        <TrashPanel
          :entries="trashEntries"
          :busy="trashBusy"
          @restore="onTrashRestore"
          @purge="onTrashPurge"
          @empty="onTrashEmpty"
        />
      </FcDrawer>
      <!-- M3-F8：版本历史抽屉（右键「历史版本」；入口显隐由 versionCapable 门控在 TreePanel 层） -->
      <FcDrawer v-model:open="versionOpen" :title="t('files.history.title')" direction="rtl" size="480px">
        <VersionPanel
          v-if="versionKey"
          :object-key="versionKey"
          :list="listVersionsOf"
          :restore="restoreVersionOf"
          :download="downloadVersionOf"
          :busy="versionBusy"
          @close="versionKey = null"
        />
      </FcDrawer>
      <!-- 2026-10：底部状态栏已并入头部（存储桶 chip + ⓘ 弹窗），StatusBar 组件下线 -->
    </div>

    <!-- ③ file：单文件预览（F2：registry 按 name 解析默认应用渲染）。
         v1.2 无壳：无 header/无卡片包裹——4px 内边距铺满视口，文件名/编辑态由应用自渲染 -->
    <div v-else-if="fileConfig" class="file-view-host">
      <div ref="previewEl" class="ws__preview-host" />
    </div>

    <!-- ④ 兜底：BOOT 未注入（异常装配）保留 M0 hero -->
    <FcSectionCard v-else class="home-hero" padding="lg">
      <h1 class="home-hero__title">{{ t('home.title') }}</h1>
      <p class="home-hero__subtitle">{{ t('home.subtitle') }}</p>
      <FcButton variant="secondary" @click="localeModel = localeModel === 'zh-CN' ? 'en-US' : 'zh-CN'">{{ t('home.toggle-locale') }}</FcButton>
    </FcSectionCard>
  </div>
</template>

<style lang="scss" scoped>
.home-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;

  /* 单文件模式（用户订单：无 header/无包裹层）：同全高拉伸，外层只留 4px 内边距；
     高度 100vh 同时最小 768px——矮视口（<768）下保持可用高度，溢出由页面滚动承接 */
  &.is-file {
    align-items: stretch;
    justify-content: stretch;
    height: 100vh;
    min-height: 768px;
    padding: 4px;
  }

  /* 嵌入态自然流（宿主同源自动高度, 滚动权交宿主面板单滚动——双滚条拆除）:
     不锁视口高/不内部滚动, 文档随内容撑高, 宿主量 scrollHeight 撑 iframe。
     舞台 70vh 实高底座: 编辑器（Monaco 需确定实高测量, C1 口径）与 srcdoc 净化框
     （absolute 根不贡献高度）在自然流下塌缩防御——块流应用（md 渲染）照常撑高。 */
  &.is-file.is-embed {
    height: auto;
    min-height: 0;
    overflow: visible;

    .file-view-host .ws__preview-host {
      overflow: visible;

      /* 舞台确定实高 calc(100vh - 12px)（用户令「都要 100vh」拍板为 -12px 变体:
         编辑器满幅近乎无空白; Monaco 创建测量/html 净化框 absolute 根依赖实高）。
         -12px 兼拆 vh 反馈环——舞台恒比 iframe 视口矮 12px, scrollHeight≤视口-12,
         宿主量高=舞台 scrollHeight+12 收敛于定值（生长方向不存在）; overflow visible
         → 块流应用（md 渲染）超界内容照常绘制并计入舞台 scrollHeight */
      :deep(.mmf-preview-stage) {
        height: calc(100vh - 12px);
        overflow: visible;
      }
    }
  }

  &.is-workspace {
    align-items: stretch;
    justify-content: stretch;
    /* 2026-10 全高布局：工作台占满视口（用户订单：树侧栏/内容区 100vh 自动高度），
       高度沿 .ws(flex 列) → .ws__body(flex:1) → 预览卡/树 拉伸链下放 */
    height: 100vh;
    min-height: 0;
  }
}

.home-hero {
  max-width: 560px;
  text-align: center;
}

.home-hero__title {
  margin: 0 0 12px;
  font-size: 28px;
  font-weight: 700;
  color: var(--app-text-primary);
  word-break: break-all;

  &--file {
    font-size: 22px;
  }
}

.home-hero__subtitle {
  margin: 0 0 20px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--app-text-secondary);
}

.home-hero__session {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin: 0 0 20px;
}

.ws {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-height: 0; /* flex 项允许内部收缩——全高布局链一环 */
}

/* ⓘ 状态弹窗入口（ghost 图标钮，同树头/选中簇口径） */
.ws__info-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--app-radius-button, 6px);
  color: var(--app-text-secondary);
  cursor: pointer;
  font-size: 16px;
  transition: background 0.15s, color 0.15s;

  &:hover {
    background: var(--app-bg-muted);
    color: var(--app-primary);
  }
}

.ws__info-pop__lang {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--app-separator);
  font-size: 13px;

  span {
    color: var(--app-text-tertiary);
  }
}

.ws__info-pop {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;

  p {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    font-size: 13px;
    color: var(--app-text-secondary);

    span {
      color: var(--app-text-tertiary);
      flex: none;
    }
    b {
      color: var(--app-text-primary);
      font-weight: 600;
      text-align: right;
      overflow-wrap: anywhere;
    }
  }
}

.ws__expire-hint {
  padding: 6px 12px;
  border: 1px solid var(--el-color-warning-light-5, #f3d19e);
  border-radius: var(--app-radius-md, 8px);
  background: var(--el-color-warning-light-9, #fdf6ec);
  color: var(--el-color-warning-dark-2, #b88230);
  font-size: 13px;
}

/* M2：resume 断点续传面包条（警示色调对齐 expire-hint；候选行 path/size + 双动作） */
.ws__resume {
  padding: 8px 12px;
  border: 1px solid var(--el-color-warning-light-5, #f3d19e);
  border-radius: var(--app-radius-md, 8px);
  background: var(--el-color-warning-light-9, #fdf6ec);
  color: var(--el-color-warning-dark-2, #b88230);
  font-size: 13px;
}

.ws__resume-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ws__resume-title {
  font-weight: 600;
}

.ws__resume-spacer {
  flex: 1;
}

.ws__resume-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: var(--app-radius-button, 6px);
  color: inherit;
  cursor: pointer;
  font-size: 14px;

  &:hover {
    background: color-mix(in srgb, var(--el-color-warning-dark-2, #b88230) 12%, transparent);
  }
}

.ws__resume-list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.ws__resume-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.ws__resume-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--app-text-primary);
}

.ws__resume-size {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.ws__resume-hint {
  margin: 4px 0 0;
  font-size: 12px;
  opacity: 0.85;
}

/* 「重选文件续传」常驻隐藏 input（视觉隐藏即可，click() 派发依赖其不在 display:none 之外的
   特殊处理——原生 file input 在 display:none 下 click() 仍可弹窗，故直接隐藏） */
.ws__resume-input {
  display: none;
}

/* 2026-10：grid → flex（树宽 inline style 可拖 + 分隔条；预览侧 min-width:0 承接旧 minmax(0,1fr)） */
.ws__body {
  display: flex;
  flex: 1; /* 全高布局：吃掉横幅以下的全部剩余高度 */
  gap: 2px; /* 用户口径：树|分隔条|预览 间紧凑 2px（2026-10 由 8px 收紧） */
  align-items: stretch;
  min-height: 0;
}

/* 树宽由 inline style 控制（treeWidth，拖拽 200~480px；flex:none），此处不再定宽；
   高度随 .ws__body 拉伸（stretch），无 68vh 上限（2026-10 全高布局） */
.ws__tree {
  padding: 8px;
  background: var(--app-section-bg);
  border: 1px solid var(--app-section-border-color);
  border-radius: var(--app-section-radius);
}

/* 左抽屉模式：预览区左上角唤起钮（ghost 图标钮，复用 ws-toolbar__act 口径） */
.ws__drawer-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--app-radius-button, 6px);
  color: var(--app-text-secondary);
  cursor: pointer;
  font-size: 15px;
  transition: background 0.15s, color 0.15s;

  &:hover {
    background: var(--app-bg-muted);
    color: var(--app-text-primary);
  }
}

/* 抽屉内文件树撑满（el-drawer body 非 flex，由包裹层接管高度） */
.ws__drawer-tree {
  height: 100%;

  :deep(.tree-panel) {
    height: 100%;
  }
}

/* 块级布局：flex 居中会把 .fc-section__body 压到 min-content 宽（Monaco 曾塌陷 5×5 的宽度向根因）；
   flex:1 + min-width:0 允许预览卡收缩吃剩余宽（同旧 grid minmax(0,1fr) 口径） */
.ws__preview {
  flex: 1;
  display: flex; /* 全高布局：卡内纵向 flex——head(40px) 定高 + host 撑满剩余 */
  flex-direction: column;
  min-width: 0;
  min-height: 320px;

  /* FcSection 的 __body 默认只有 flex 列、无拉伸——不撑开它，preview-host 的 flex:1 永远停在 min-height */
  :deep(.fc-section__body) {
    flex: 1;
    min-height: 0;
  }

  /* 浏览器内全屏：fixed 铺满视口（非系统 Fullscreen API）；z-index 低于 EP 弹层（2000+），宿主弹窗仍可盖入 */
  &.is-page-fs {
    position: fixed;
    inset: 0;
    z-index: 1500;
    width: 100%;
    height: 100%;
    min-height: 0;
    border-radius: 0;
  }
}

/* 预览区头 = [PreviewTabs（左，自适应）| 全屏钮 | Toolbar 选中簇（右）]（2026-10 布局改版） */
.ws__preview-head {
  display: flex;
  align-items: center;
  height: 40px;
  gap: 8px;

  /* 全屏预览卡：ghost 图标钮（口径同 ws-toolbar__act）；margin-left:auto 由它承担推右
    （[i] 的 auto 已移除——双 auto 会平分空隙导致按钮悬在中间） */
  .ws__fs-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: none;
    margin-left: auto;
    border: none;
    border-radius: var(--app-radius-sm);
    background: transparent;
    color: var(--app-text-secondary);
    cursor: pointer;
    font-size: 16px;

    &:hover {
      background: color-mix(in srgb, var(--app-primary) 10%, transparent);
      color: var(--app-text);
    }
  }

  /* 传输任务中心入口：ghost 图标钮（口径同 fs-btn）+ 右上角进行中数角标 */
  .ws__transfer-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: none;
    border: none;
    border-radius: var(--app-radius-sm);
    background: transparent;
    color: var(--app-text-secondary);
    cursor: pointer;
    font-size: 16px;

    &:hover {
      background: color-mix(in srgb, var(--app-primary) 10%, transparent);
      color: var(--app-text);
    }
  }

  .ws__transfer-badge {
    position: absolute;
    top: -3px;
    right: -4px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--app-primary);
    color: var(--app-on-primary, #fff);
    font-size: 10px;
    line-height: 14px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* ⓘ 恒居最右（tabs flex:1 占满时自然靠右；无 tab 时由 auto 推右） */
  .ws__info-wrap {
    display: inline-flex;
    align-items: center;
  }
}

/* 树/预览分隔条：拖拽调树宽；中点折叠钮（双击空白处同效） */
.ws__splitter {
  position: relative;
  flex: none;
  width: 6px;
  border-radius: 3px;
  background: transparent;
  cursor: col-resize;

  &:hover {
    background: var(--app-bg-muted);
  }
}

.ws__splitter-toggle {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--app-separator);
  border-radius: 9px;
  background: var(--app-bg-card);
  color: var(--app-text-tertiary);
  cursor: pointer;
  transform: translate(-50%, -50%);

  &:hover {
    color: var(--app-primary);
  }
}

/* F5（优化建议 C1）：预览舞台恒定尺寸——不再随内容/父级 flex 塌陷（曾致 Monaco 5×5px 不可视）。
   min-height 链：stage（渲染器容器）至少撑满舞台，保证 Monaco create 时测量到非零高度。 */
.ws__preview-host {
  position: relative;
  width: 100%;
  flex: 1; /* 全高布局：撑满预览卡剩余高度（min-height 链保底防 Monaco 零测量塌陷，C1 口径不变） */
  min-height: 320px;
  overflow: auto;
  padding: 2px;
  border-top: 1px solid var(--app-separator);

  :deep(.mmf-preview-stage) {
    min-height: 100%;
  }
}

/* 单文件预览容器（v1.2 无壳）：铺满 .is-file 剩余空间（外层已给 4px 内边距），
   纵向 flex 让舞台分到确定高度（fill 型插件 absolute 根节点依赖） */
.file-view-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  .ws__preview-host {
    min-height: 0; /* 全高链下不需要 320px 兜底 */
    padding: 0; /* 4px 由外层 .is-file 统一给 */
    border-top: none; /* 无卡片壳即无分隔线 */
    /* 纵向 flex：舞台从 host 分确定实高（fill 型插件 absolute 根节点依赖实高；
       flow 渲染器 basis:auto 随内容长高、host overflow:auto 滚动） */
    display: flex;
    flex-direction: column;

    :deep(.mmf-preview-stage) {
      flex: 1 1 auto;
      min-height: 0;
    }
  }
}

@media (max-width: 720px) {
  .ws {
    height: auto; /* 窄屏回落自然流：树/预览上下堆叠不锁视口 */
  }

  .ws__body {
    flex-direction: column;
  }

  .ws__tree {
    width: auto !important; /* 覆盖 inline style：窄屏回落为上下堆叠满宽 */
  }

  .ws__splitter {
    display: none;
  }
}
</style>
