/**
 * 宿主侧配置/载荷类型（镜像 frontend/src/sdk/types.ts 宿主关心的子集）。
 * 正本语义见 ../../../../docs/design/jsdk-api.md §二/§六。
 */

export interface MmxCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  sessionToken: string;
}

export interface MmxBackendConfig {
  endpoint: string;
  region: string;
  bucket: string;
  /** 会话目录域（文件树从此起）；''=bucket 根 */
  prefix: string;
  credentials: MmxCredentials;
  /** 前端自毁定时器（秒），须 ≤ STS 真实 TTL */
  ttlSeconds?: number;
}

export interface MmxWorkspaceConfig {
  mode: "workspace";
  v: number;
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
