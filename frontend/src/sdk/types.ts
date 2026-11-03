/**
 * JSSDK 共享类型与领域契约
 * 契约正本：《docs/design/jsdk-api.md》V1.0 /《docs/design/solution-design.md》V1.2 §4.1b/§4.4
 * 本文件由主线持有，子 agent 只读。
 */
import type { NS } from './constants'

// ───────────────────────── 信封 ─────────────────────────

export interface Envelope<P = unknown> {
  ns: typeof NS
  v: number
  kind: 'cmd' | 'evt' | 'reply'
  /** cmd 唯一 id；reply 携带对应 cmd 的 id */
  id: string
  name: string
  payload: P
  /** 仅 reply 携带 */
  ok?: boolean
  /** 仅 reply 失败时携带（§七错误码） */
  code?: number
}

export type CommandName =
  | 'navigate' | 'openFile' | 'closeTab' | 'getTabs' | 'select'
  | 'createFolder' | 'uploadFiles' | 'download' | 'rename' | 'remove'
  | 'registerApp' | 'setTheme' | 'setLocale' | 'getInfo' | 'destroy'
  | 'setCredentials' | 'getApps'
  // v1.2 回收站命令（恢复/彻底删除；实现在 M1 overrides）
  | 'restore' | 'purge'

export type EventName =
  | 'ready' | 'pathChanged' | 'fileOpened' | 'tabClosed'
  | 'selectionChanged' | 'selectionConfirmed'
  | 'uploadProgress' | 'uploadDone' | 'uploadFailed'
  | 'downloadDone' | 'downloadFailed'
  | 'fileChanged' | 'expired' | 'error'

// ───────────────────────── 配置（§4.1 / §4.1b）─────────────────────────

export interface S3Credentials {
  accessKeyId: string
  accessKeySecret: string
  sessionToken: string
}

export interface BackendConfig {
  /**
   * 协议判别（WebDAV §W1 装配分流）：缺省/'s3'=S3 对象存储，向后兼容既有配置。
   * 收窄纪律：判别只用 `backend.type === 'webdav'` 单向判断——缺省形状不被收窄吃掉，
   * 既有 S3 消费点零改动。
   */
  type?: 's3'
  endpoint: string
  region: string
  bucket: string
  /** 会话目录域（文件树从此起；凭证 scope 钉在此 prefix） */
  prefix: string
  credentials: S3Credentials
  /** 前端自毁定时器时长（秒）；必须 ≤ STS 真实 TTL */
  ttlSeconds?: number
  /** 可选：对齐 STS 真实到期时刻（epoch ms） */
  expiresAt?: number
}

/**
 * WebDAV 数据源 backend（WebDAV 方案 §W1/W6）。与 BackendConfig 构成 workspace backend
 * 判别联合（`WorkspaceBackend`），按 `type === 'webdav'` 单向判别，缺省（无 type）=S3。
 * SECURITY 注记（§W6）：Basic 凭证明文于每个请求头，生产环境应强制 HTTPS；
 * ttlSeconds/expiresAt 对 WebDAV 的语义 = **前端主动遗忘**——自毁线到点前端清空凭证/会话，
 * 并非凭证真到期（服务器侧密码仍在、无过期保护），文档与 UI 不得暗示有过期保护。
 */
export interface WebDavBackend {
  type: 'webdav'
  endpoint: string
  /**
   * Basic 认证用户名。Authorization 头仅在与 password 均非空时携带（WebDavClient 半凭证
   * 口径：只有 username 无 password 不发认证、不支持——匿名请求的 401 会与「凭证无效」混淆）；
   * 合法空密码账号由连接向导显式校验兜住（M1-V1 裁决）。
   */
  username?: string
  /** Basic 认证密码。凭证不出前端：不进 URL/历史/摘要（buildConfigSummary 红线），仅走 Authorization 头 */
  password?: string
  /** 会话根路径（挂载点下的子目录域，如 '/dav'）；缺省 ''=端点根（WebDavClient 归一：去尾斜杠、'/' 开头、逐段编码） */
  rootPath?: string
  /**
   * 服务器家族开关（§W4①）：非标 `PUT Content-Range` 续写支持（Nextcloud chunked v2 同型）。
   * 缺省 false=安全降级整包（§W4②）——HTTP Range 语义只为 GET 定义（RFC 9110 §14.2），写侧
   * 续写无标准探测手段（HEAD Accept-Ranges 只证读可续、不证写可续），故不做自动探测，
   * known-good 清单随实机取证批次维护。
   */
  chunkedWrite?: boolean
  /**
   * 整包模式单文件上限（字节，§W4②）；缺省 1GB。仅 multipartStrategy='none'（chunkedWrite
   * 未开启）整包降级模式生效——超限文件入队即拒收（rejected reason='size'）。
   */
  maxUploadSize?: number
  /** 前端自毁定时器时长（秒）——WebDAV 语义=前端主动遗忘，非服务器侧凭证到期（§W6 SECURITY 注记） */
  ttlSeconds?: number
  /** 可选：前端遗忘死线（epoch ms）；语义同 ttlSeconds（前端主动遗忘，非凭证真到期） */
  expiresAt?: number
}

/** workspace backend 判别联合（WebDAV §W1）：S3 形状保持（type 缺省='s3'）｜WebDAV */
export type WorkspaceBackend = BackendConfig | WebDavBackend

export interface BrandConfig {
  name?: string
  logoUrl?: string
  primaryColor?: string
}

export interface AppearanceConfig {
  theme?: 'light' | 'dark' | 'auto'
  brand?: BrandConfig
  locale?: 'zh-CN' | 'en-US'
}

export interface PluginEntry {
  url: string
  /** sha384-<hex>（SRI 标签注入校验） */
  sri?: string
  lazy?: boolean
  /** 透传给 activate(sdk, options) 的插件参数（v1.1 增补，只增不改义；缺省不传） */
  options?: Record<string, unknown>
}

export interface WorkspaceConfig {
  mode: 'workspace'
  v: number
  /** 数据源 backend 判别联合（WebDAV §W1）：S3（type 缺省/'s3'）｜WebDAV（type==='webdav'） */
  backend: WorkspaceBackend
  security: { allowedOrigins: string[] }
  params?: { uploadMaxBytes?: number; uploadConcurrency?: number }
  appearance?: AppearanceConfig
  features?: Record<string, boolean>
  permissions?: { denyExts?: string[] }
  plugins?: PluginEntry[]
  ui?: {
    initialPath?: string
    defaultOpen?: string
    /** 文件树形态：sidebar=常驻侧栏（默认）/ drawer=左抽屉（预览区左上角图标唤起） */
    treeMode?: 'sidebar' | 'drawer'
    /** 文件树标题覆写（缺省=前缀末段；根=「根目录」） */
    treeTitle?: string
  }
}

export interface FileSource {
  url: string
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
}

export interface FileSave {
  method: 'PUT' | 'POST'
  url: string
  headers?: Record<string, string>
}

export interface SingleFileConfig {
  mode: 'file'
  v: number
  source: FileSource
  /** 只读=无 save 段；可写=有 save 段 */
  save?: FileSave
  name?: string
  /** 可选：指定打开应用（registry id）——缺省=按扩展名默认解析（注册序第一个命中）。
   *  一百四十二番宿主移植: 预览头「打开方式」切换器由宿主驱动, 经本位换装应用。 */
  appId?: string
  appearance?: AppearanceConfig
  features?: Record<string, boolean>
  /** 可选：宿主 origin 白名单；缺省时装配层从 document.referrer 推导（§4.1b origin 校验同工作台） */
  security?: { allowedOrigins: string[] }
  /** v1.2：单文件模式插件（语义同工作台——内存文件独立区「选应用/编辑模式」的命中来源） */
  plugins?: PluginEntry[]
}

export type AppConfig = WorkspaceConfig | SingleFileConfig
export type SessionMode = 'workspace' | 'file'

// ───────────────────────── S3 域（§4.4 API 子集）─────────────────────────

export interface S3ObjectSummary {
  key: string
  name: string
  size: number
  lastModified?: number
  isDir: boolean
  mime?: string
}

export interface S3ListResult {
  prefix: string
  dirs: S3ObjectSummary[]
  files: S3ObjectSummary[]
  continuationToken?: string
}

/** 对象版本行（ListVersionsResult 的 <Version> 子项；lastModified=epoch ms） */
export interface VersionRow {
  key: string
  versionId: string
  isLatest: boolean
  lastModified?: number
  size: number
}

/** 删除标记行（ListVersionsResult 的 <DeleteMarker> 子项——删掉标记版本即「恢复」） */
export interface DeleteMarkerRow {
  key: string
  versionId: string
  isLatest: boolean
  lastModified?: number
}

/** ListObjectVersions 响应（回收站/版本历史；分页标记仅 isTruncated 时透出） */
export interface VersionListResult {
  versions: VersionRow[]
  deleteMarkers: DeleteMarkerRow[]
  isTruncated: boolean
  nextKeyMarker?: string
  nextVersionIdMarker?: string
}

/**
 * S3 客户端接口（A3 实现 SigV4Client、A5/files 层消费；单文件模式另有 URL provider）
 * 错误映射：非 2xx → SdkError(S3_ERROR, detail=status)；403/凭证类 → CREDENTIAL_INVALID/CREDENTIAL_EXPIRED
 */
export interface S3Client {
  list(prefix: string, opts?: { continuationToken?: string; delimiter?: string }): Promise<S3ListResult>
  get(key: string, opts?: { rangeHeader?: string }): Promise<Response>
  put(key: string, body: Blob | ArrayBuffer, contentType?: string): Promise<{ etag: string }>
  head(key: string): Promise<{ exists: boolean; size?: number; contentType?: string; etag?: string }>
  copy(from: string, to: string, opts?: { fromVersionId?: string }): Promise<void>
  remove(keys: string[]): Promise<void>
  createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }>
  uploadPart(key: string, uploadId: string, partNumber: number, body: Blob): Promise<{ etag: string }>
  completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>
  abortMultipart(key: string, uploadId: string): Promise<void>
  /**
   * 预签名 GET URL（查询串 SigV4；媒体渲染器用 <video src> 拿浏览器原生 Range/渐进加载）。可选能力
   * extraQuery 追加进签名查询串的业务参数（versionId/partNumber/response-content-disposition 等场景），不传=行为逐字节不变；nowMs 仅测试注入。
   */
  getPresignedUrl?(key: string, expiresSec?: number, nowMs?: number, extraQuery?: Record<string, string>): string
  /**
   * 预签名 PUT URL（查询串 SigV4；分享对话框「上传链接」用——对方无需凭证即可向该 key 直传）。可选能力
   * extraQuery 追加进签名查询串的业务参数（uploadId/partNumber 等分片直传场景），不传=行为逐字节不变；nowMs 仅测试注入。
   */
  presignPutUrl?(key: string, expiresSec?: number, nowMs?: number, extraQuery?: Record<string, string>): string
  /** 桶版本控制状态（回收站前置检测；无 <Status>/未配置 = 'Disabled'）。可选能力 */
  getBucketVersioning?(): Promise<'Enabled' | 'Suspended' | 'Disabled'>
  /** 列举对象版本 + 删除标记（回收站/版本历史）。可选能力 */
  listObjectVersions?(opts?: { prefix?: string; keyMarker?: string; versionIdMarker?: string; maxKeys?: number }): Promise<VersionListResult>
  /** 删除指定版本（删 DeleteMarker=恢复可见性；带 versionId=彻底删除）。可选能力 */
  deleteVersion?(key: string, versionId: string): Promise<void>
  /** 列举进行中的分片上传（孤儿 uploadId 清理；initiated=ISO 字符串透传）。可选能力 */
  listMultipartUploads?(): Promise<{ key: string; uploadId: string; initiated?: string }[]>
  /**
   * 目录语义声明（WebDAV 方案 §W2 关键裁决）。可选门控惯例：缺省=既有 S3 行为（marker-object）。
   * 'marker-object'：S3 世界目录=前缀约定+零字节标记对象（mkdir=put 0 字节、目录删除=平铺展开逐对象删）；
   * 'collection'：WebDAV 世界目录=first-class collection（MKCOL 建、COPY/DELETE 递归作用于内部成员）——
   * tree-store 的 mkdir/目录 remove/renameDir 据此分流（判别=createDirectory 存在性 + 本声明）。
   */
  directorySemantics?: 'marker-object' | 'collection'
  /**
   * 逐级建目录并确保完整祖先链（§W2 collection 语义分流配套；可选能力）。key 以 '/' 结尾
   * （目录 key 归一约定）；实现方逐级建（父先于子），已存在容忍（幂等）。
   * 消费点：tree-store mkdir（替代 0 字节标记 put）/renameDir（COPY 前目标祖先链补建，防 409）。
   */
  createDirectory?(key: string): Promise<void>
  /**
   * 分片上传策略声明（WebDAV 方案 §W4 上传矩阵）。可选能力惯例：缺省='s3-multipart'
   * （既有 S3 行为逐字节不变）。上传队列据此分流：
   * 's3-multipart'：标准 S3 multipart（分片并发、partNumber 寻址、断点续传照旧）；
   * 'content-range'：非标 PUT Content-Range 旁路临时对象续写（§W4①，WebDavClient 在
   * chunkedWrite 开启时声明）——append 模型不可乱序，队列分片串行 + 续传前以
   * probeUploadProgress 实证服务端字节面；
   * 'none'：无分片能力（§W4②）——队列整包 PUT 降级（阈值视为 ∞）+ maxUploadSize 超限拒收，
   * 不写断点（诚实：无续传）。
   */
  multipartStrategy?: 's3-multipart' | 'content-range' | 'none'
  /**
   * 分片续传进度探测（§W4① content-range 策略配套可选能力）：旁路临时对象当前字节数；
   * 404（temp 不存在/已清理）→ -1。队列续传时按「返回值 === 已确认完整字节」裁决
   * 续传余片 vs 清残全量重传（append 无服务端截断能力，诚实降级口径）。
   */
  probeUploadProgress?(key: string, uploadId: string): Promise<number>
}

// ───────────────────────── 命令/事件 payload ─────────────────────────

export interface NavigatePayload { path: string }
export interface OpenFilePayload { path: string; appId?: string }
export interface TabInfo { tabId: string; path: string; appId: string }
export interface OpenFileReply { tabId: string }
export interface CloseTabPayload { tabId: string }
export interface GetTabsReply { tabs: TabInfo[] }
export interface SelectPayload { mode: 'file' | 'multi' | 'off'; filter?: { exts: string[] } }
export interface CreateFolderPayload { path: string }
export interface CreateFolderReply { key: string }
export interface UploadAccepted { id: string }
export interface UploadRejected {
  name: string
  reason: 'ext' | 'size'
  /** 拒收错误码（契约《docs/design/jsdk-api.md》§五：ext=4304 EXT_DENIED、size=4302 PAYLOAD_TOO_LARGE）；additive */
  code?: number
}
export interface UploadFilesReply { accepted: UploadAccepted[]; rejected: UploadRejected[] }
export interface DownloadPayload { paths: string[] }
export interface RenamePayload { from: string; to: string }
export interface RemovePayload { paths: string[] }
/** 宿主运行时注册=动态追加配置注入插件（传 {url,sri}，函数不可克隆；options 透传 activate 第二参） */
export interface RegisterAppPayload { url: string; sri?: string; lazy?: boolean; options?: Record<string, unknown> }
export interface RegisterAppReply {
  appId: string
  /** v1.1：本次调用是否处于该 url 的首次激活路径；false=同 url 幂等短路——本次传入的 options 不生效（宿主应改走重载/刷新） */
  applied?: boolean
}
export interface SetThemePayload { theme: 'light' | 'dark' | 'auto' }
/** v1.1：宿主重签通道——热替换会话凭证并（可选）重置自毁线（setCredentials 命令） */
export interface SetCredentialsPayload {
  credentials: S3Credentials
  /** 新自毁线（秒，自 now 起）；与 expiresAt 都缺省=保持现死线 */
  ttlSeconds?: number
  /** 新死线（epoch ms，优先于 ttlSeconds） */
  expiresAt?: number
}
export interface SetLocalePayload { locale: 'zh-CN' | 'en-US' }
export interface GetInfoReply {
  sdkVersion: string
  session: { expiresInSec: number }
  features: Record<string, boolean>
}

export interface ReadyPayload {
  sdkVersion: string
  protocolVersion: number
  configSummary: Record<string, unknown>
}
export interface PathChangedPayload { path: string }
export interface FileOpenedPayload { tabId: string; path: string; appId: string }
export interface TabClosedPayload { tabId: string }
export interface SelectionChangedPayload { paths: string[] }
export interface SelectionConfirmedPayload { paths: string[] }
export interface UploadProgressPayload { id: string; loaded: number; total: number }
export interface UploadDonePayload { id: string; key?: string }
export interface UploadFailedPayload { id: string; error?: { code: number; message: string } }
export interface DownloadDonePayload { id: string }
export interface DownloadFailedPayload { id: string; error?: { code: number; message: string } }
export interface FileChangedPayload { key: string; action: 'put' | 'delete' | 'rename'; from?: string }
export interface ExpiredPayload { reason: 'ttl' | 'destroyed' }
export interface ErrorPayload { code: number; message: string; detail?: unknown }

// ───────────────────────── 应用模型（§4.6 AppRegistry / 动态插件方案 V1.1 §二）─────────────────────────

export interface AppMatcher {
  /** 不带点扩展名（归一化：忽略大小写与前导点）；同字段内 OR */
  ext?: string[]
  /** string 或 string[]；忽略大小写与 '; parameters' 后缀；同字段内 OR */
  mime?: string | string[]
  /** 内容嗅探（magic bytes 等）；与 ext/mime 之间 AND */
  probe?: (file: { name: string; mime?: string; size?: number }) => boolean
}

/** beforeDispose 触发原因（v1.1 显式化：expired/destroy=通知式，实现应跳过用户询问直接放行） */
export type DisposeReason = 'close' | 'expired' | 'destroy'

/** 渲染实例：dispose 三路必调；getState 供切回 tab 重跑时注入 savedState */
export interface AppInstance {
  dispose(): void
  getState?(): unknown
  /** Promise<boolean>：false=暂缓关闭；3s 超时强制放行；expired/destroy 只通知不询问（reason 参数 v1.1 显式化——宿主 expire 路径已传 'expired'） */
  beforeDispose?(reason?: DisposeReason): boolean | Promise<boolean>
}

/** 插件能力面（白名单）：凭证不出，字节流进出 */
export interface AppCtx {
  /** 工作台=内层 SigV4；单文件=URL provider——装配层注入统一实现 */
  getObject(key: string): Promise<Blob>
  putObject(key: string, data: Blob, contentType?: string): Promise<void>
  /** i18n（强制走宿主词典；params=具名插值占位实参，如 {limit}——渲染器超限文案 R2-03/R2-05） */
  t(key: string, params?: Record<string, unknown>): string
  /** 事件上报 → 宿主 fileChanged（'saved'|'changed'→put；'deleted'→delete；'renamed'→rename） */
  /** html-open-rejected: html-viewer 外链代理拒绝面（净化沙箱——非法 scheme 等, payload.url=被拒 URL） */
  notify(type: 'saved' | 'changed' | 'deleted' | 'renamed' | 'html-open-rejected',
    payload: { key: string; from?: string } | { url: string }): void
  /** 主题 token（CSS 变量名集） */
  theme: Record<string, string>
  /** 可选能力：媒体直链（S3=预签名 URL / url source=原始 GET URL）——渲染器用 <video src> 拿浏览器原生 Range */
  getMediaUrl?(key: string): string
  /**
   * 可选能力：对象 Range 读（§W5 在线解压第二 RangeReader 实现——无直链源走 GET+Range 通道）。
   * [start, end) 半开区间（HTTP Range `bytes=start-(end-1)` 换算在装配层）；源支持 Range（206）=
   * 返回精确区间字节，源不支持（200）=返回整包字节（上层整包缓存后本地切片）。
   * mem:// 键域不提供该成员（undefined，上层走 Blob 兜底——内存 Blob 零成本整包，Range 无增益）。
   */
  getObjectRange?(key: string, start: number, end: number): Promise<Uint8Array>
  /** 可选能力：应用级故障上报 → 宿主 bus 'error' 事件（保存链失败/凭据拒等——渲染器静默吞错的可见化出口, 宿主据此 toast/换签重载） */
  notifyAppError?(err: { code: number; message: string }): void
}

export type AppAction = 'preview' | 'edit' | 'open-with'

export interface AppDefinition {
  /** 全局唯一（registry 键；openFile {appId} 引用） */
  id: string
  matcher: AppMatcher
  renderer: (el: HTMLElement, file: { key: string; name: string; size: number }, ctx: AppCtx, savedState?: unknown, appOptions?: Record<string, unknown>) => void | AppInstance | Promise<void | AppInstance>
  actions?: AppAction[]
  /** i18n key 或字面量 */
  label?: string
  version?: string
  /** 要求的协议主版本（=信封 v；缺省不校验；不匹配拒载） */
  requiresSdk?: number
  /** 渲染器字节限额（R2-03：预览闸据此取该类型实际拒绝线，避免「确认后仍拒」的双闸叠加；缺省=无渲染器级限额） */
  maxBytes?: number
}
