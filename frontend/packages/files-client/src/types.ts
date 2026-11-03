/**
 * 宿主侧配置/载荷类型（镜像 frontend/src/sdk/types.ts 宿主关心的子集）。
 * 正本语义见 ../../../../docs/design/jsdk-api.md §二/§六。
 * WebDAV backend 形状镜像自 frontend/src/sdk/types.ts `WebDavBackend`（WebDAV 方案 §W1），漂移由 frontend 套件 clientProtocol 哨兵拦截。
 */

export interface MmxCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  sessionToken: string;
}

export interface MmxS3BackendConfig {
  /**
   * 协议判别（WebDAV §W1 装配分流）：缺省/'s3'=S3 对象存储，向后兼容既有配置。
   * 收窄纪律：判别只用 `backend.type === 'webdav'` 单向判断——缺省形状不被收窄吃掉，
   * 既有 S3 消费点零改动。
   */
  type?: "s3";
  endpoint: string;
  region: string;
  bucket: string;
  /** 会话目录域（文件树从此起；凭证 scope 钉在此 prefix） */
  prefix: string;
  credentials: MmxCredentials;
  /** 前端自毁定时器时长（秒）；必须 ≤ STS 真实 TTL */
  ttlSeconds?: number;
  /** 可选：对齐 STS 真实到期时刻（epoch ms） */
  expiresAt?: number;
}

/**
 * WebDAV 数据源 backend（WebDAV 方案 §W1/W6）。与 MmxS3BackendConfig 构成判别联合，
 * 按 `type === 'webdav'` 单向判别，缺省（无 type）=S3。
 * SECURITY 注记（§W6）：Basic 凭证明文于每个请求头，生产环境应强制 HTTPS；
 * ttlSeconds/expiresAt 对 WebDAV 的语义 = **前端主动遗忘**——自毁线到点前端清空凭证/会话，
 * 并非凭证真到期（服务器侧密码仍在、无过期保护），文档与 UI 不得暗示有过期保护。
 */
export interface MmxWebDavBackendConfig {
  type: "webdav";
  endpoint: string;
  /**
   * Basic 认证用户名。Authorization 头仅在与 password 均非空时携带（WebDavClient 半凭证
   * 口径：只有 username 无 password 不发认证、不支持——匿名请求的 401 会与「凭证无效」混淆）；
   * 合法空密码账号由连接向导显式校验兜住（M1-V1 裁决）。
   */
  username?: string;
  /** Basic 认证密码。凭证不出前端：不进 URL/历史/摘要（buildConfigSummary 红线），仅走 Authorization 头 */
  password?: string;
  /** 会话根路径（挂载点下的子目录域，如 '/dav'）；缺省 ''=端点根（WebDavClient 归一：去尾斜杠、'/' 开头、逐段编码） */
  rootPath?: string;
  /**
   * 服务器家族开关（§W4①）：非标 `PUT Content-Range` 续写支持（Nextcloud chunked v2 同型）。
   * 缺省 false=安全降级整包（§W4②）——HTTP Range 语义只为 GET 定义（RFC 9110 §14.2），写侧
   * 续写无标准探测手段（HEAD Accept-Ranges 只证读可续、不证写可续），故不做自动探测，
   * known-good 清单随实机取证批次维护。
   */
  chunkedWrite?: boolean;
  /**
   * 整包模式单文件上限（字节，§W4②）；缺省 1GB。仅整包降级模式（chunkedWrite 未开启）生效——
   * 超限文件入队即拒收（rejected reason='size'）。
   */
  maxUploadSize?: number;
  /** 前端自毁定时器时长（秒）——WebDAV 语义=前端主动遗忘，非服务器侧凭证到期（§W6 SECURITY 注记） */
  ttlSeconds?: number;
  /** 可选：前端遗忘死线（epoch ms）；语义同 ttlSeconds（前端主动遗忘，非凭证真到期） */
  expiresAt?: number;
}

/** workspace backend 判别联合（WebDAV §W1）：S3 形状保持（type 缺省='s3'）｜WebDAV。原名保留为联合别名，demo 与既有代码 import 零改动 */
export type MmxBackendConfig = MmxS3BackendConfig | MmxWebDavBackendConfig;

export interface MmxWorkspaceConfig {
  mode: "workspace";
  v: number;
  /** 数据源 backend 判别联合（WebDAV §W1）：S3（type 缺省/'s3'）｜WebDAV（type==='webdav'） */
  backend: MmxBackendConfig;
  security: { allowedOrigins: string[] };
  params?: { uploadMaxBytes?: number; uploadConcurrency?: number };
  appearance?: {
    theme?: "light" | "dark" | "auto";
    locale?: "zh-CN" | "en-US";
    brand?: { name?: string; logoUrl?: string; primaryColor?: string };
  };
  /** 功能开关；缺省=全集开启。键集见 README「#config 字段表」 */
  features?: Record<string, boolean>;
  permissions?: { denyExts?: string[] };
  /** 动态插件（JSSDK 契约同 sdk/types PluginEntry）：url + 可选 sha384 SRI + lazy + options（透传 activate 第二参） */
  plugins?: Array<{ url: string; sri?: string; lazy?: boolean; options?: Record<string, unknown> }>;
  ui?: {
    initialPath?: string;
    defaultOpen?: string;
    /** 文件树形态：sidebar=常驻侧栏（默认）/ drawer=左抽屉（预览区左上角图标唤起） */
    treeMode?: "sidebar" | "drawer";
    /** 文件树标题覆写（缺省=前缀末段；根=「根目录」） */
    treeTitle?: string;
  };
}

export interface MmxSingleFileConfig {
  mode: "file";
  v: number;
  source: {
    url: string;
    method?: "GET" | "POST";
    body?: string;
    headers?: Record<string, string>;
  };
  /** 只读=无 save 段；可写=有 save 段（按 method 回写源 URL） */
  save?: { method: "PUT" | "POST"; url: string; headers?: Record<string, string> };
  name?: string;
  appearance?: { theme?: "light" | "dark" | "auto"; locale?: "zh-CN" | "en-US" };
  security?: { allowedOrigins: string[] };
  /** 单文件模式插件（内存文件独立区的应用命中来源） */
  plugins?: Array<{ url: string; sri?: string; lazy?: boolean; options?: Record<string, unknown> }>;
}

export type MmxAppConfig = MmxWorkspaceConfig | MmxSingleFileConfig;

/** evt ready 载荷（§六） */
export interface MmxReadyPayload {
  sdkVersion: string;
  protocolVersion: number;
  configSummary: Record<string, unknown>;
}

/** 全部协议事件名（§三/§六） */
export type MmxEventName =
  | "ready"
  | "pathChanged"
  | "fileOpened"
  | "tabClosed"
  | "selectionChanged"
  | "selectionConfirmed"
  | "uploadProgress"
  | "uploadDone"
  | "uploadFailed"
  | "downloadDone"
  | "downloadFailed"
  | "fileChanged"
  | "expired"
  | "error"
  | "previewFullscreen";

export type MmxEventHandler = (payload: unknown) => void;
