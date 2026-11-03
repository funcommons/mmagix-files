/**
 * EmbedPlay 表单 → #config 纯逻辑抽出（configBuilder）：零 Vue 依赖，可单测。
 *
 * 导出三件 + 一常量：
 * - buildWorkspaceConfig：表单 → MmxWorkspaceConfig。S3 分支输出与抽离前逐字节一致
 *   （不带 type 字段=向后兼容既有 #config 消费点）；WebDAV 分支按 MmxBackendConfig
 *   判别联合（type:'webdav' 必填）装配。features/plugins/ui/security/appearance 段两态共用。
 * - validateForm：onMount 前置校验，返回 i18n key 或 null（EmbedPlay 里 t() 消费）。
 * - maskConfigForPreview：#config 预览打码（S3=credentials 三键；WebDAV=password）。
 * - FEATURE_KEYS：features 键集（EmbedPlay 模板勾选组与 features 段共用单一来源）。
 *
 * WebDAV 半凭证纪律（与 frontend 连接向导 M1-V1 同口径）：username 与 password
 * 成对且非空才带，只填其一时按都不带处理——iframe 侧 WebDavClient 半凭证不发
 * Authorization（避免匿名 401 与「凭证无效」混淆），宿主侧配置装配同样不产半凭证形状。
 */
import {
  CONFIG_VERSION,
  type MmxBackendConfig,
  type MmxS3BackendConfig,
  type MmxWebDavBackendConfig,
  type MmxWorkspaceConfig,
} from "@/composables/useMmagixFilesClient";
import { OEM_CONFIG } from "@/config/oem";

/**
 * WebDAV 演示端点缺省值（dev-webdav.mjs 的缺省端口，见 scripts/dev-webdav.mjs）。
 * EmbedPlay 的 backendType 联动 watch 用它做「对称缺省值」搬移（S3 缺省 ↔ WebDAV 缺省）。
 */
export const WEBDAV_DEFAULT_ENDPOINT = "http://localhost:5240";

/** features 键集（features[key]=false 表示关闭；缺省=全集开启） */
export const FEATURE_KEYS = [
  "upload",
  "mkdir",
  "rename",
  "delete",
  "download",
  "multiTab",
  "openWithMenu",
  "plugins",
] as const;

/** EmbedPlay 连接表单完整形状（S3 与 WebDAV 共用一个 reactive，按 backendType 分流装配） */
export interface DemoFormFields {
  /** 数据源类型段（backend 判别）：s3=对象存储（缺省）/ webdav=WebDAV 服务器 */
  backendType: "s3" | "webdav";
  /** 两态共用输入框：S3=S3 端点 / WebDAV=http(s) 端点 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  sessionToken: string;
  prefix: string;
  /** WebDAV Basic 认证用户名（与 password 成对填写才进配置——半凭证纪律） */
  webdavUsername: string;
  /** WebDAV Basic 认证密码（凭证不出前端：仅进配置，预览打码） */
  webdavPassword: string;
  /** WebDAV 会话根路径（如 '/dav'；空=端点根） */
  webdavRootPath: string;
  /** WebDAV 非标 PUT Content-Range 分块续写（缺省关=大文件整包，服务端需支持才开） */
  webdavChunkedWrite: boolean;
  ttl: number;
  theme: "light" | "dark";
  locale: "zh-CN" | "en-US";
  initialPath: string;
  /** 文件树形态：sidebar=常驻侧栏（默认）/ drawer=左抽屉（预览区左上角图标唤起） */
  treeMode: "sidebar" | "drawer";
  /** 文件树标题覆写（ui.treeTitle；空=缺省「根目录」/前缀末段） */
  treeTitle: string;
  /** 勾选=关闭该功能（features[key]=false）；不勾=缺省全开 */
  disabledFeatures: string[];
  /** Univer 文档插件（xlsx/xls/docx 编辑）：注入 plugins 配置，启动即载 */
  univerPlugin: boolean;
  /** PDF 标注签批插件（覆盖层标注/签批/签名，压平写回） */
  pdfAnnotator: boolean;
  /** Markdown 编辑插件（md/markdown 编辑 × mermaid × 三形态）；空串=不传该参数走缺省链 */
  mdPlugin: boolean;
  /** Artplayer 媒体播放器插件（视频/音频打开方式增强） */
  artplayerPlugin: boolean;
  /** Filerobot 图片编辑器插件（png/jpg/webp 等编辑增强） */
  filerobotPlugin: boolean;
  /** HTML 编辑器插件（html/htm 三态：源码/可视/预览，单体化+新 tab 代理） */
  htmlPlugin: boolean;
  /** PPTX 预览插件（pptx-preview 纯前端渲染，办公三件套补位） */
  pptxPlugin: boolean;
  mdInitialMode: "" | "source" | "split" | "preview";
  mdDefaultMode: "" | "source" | "split" | "preview";
}

/**
 * S3 backend（输出与抽离前逐字节一致：不含 type 字段，保持向后兼容；
 * region 缺省 'us-east-1'、ttlSeconds 条件原样保留）。
 */
function buildS3Backend(form: DemoFormFields): MmxS3BackendConfig {
  return {
    endpoint: form.endpoint.trim(),
    region: form.region.trim() || "us-east-1",
    bucket: form.bucket.trim(),
    prefix: form.prefix,
    credentials: {
      accessKeyId: form.accessKeyId.trim(),
      accessKeySecret: form.accessKeySecret.trim(),
      sessionToken: form.sessionToken.trim(),
    },
    ttlSeconds: form.ttl > 0 ? form.ttl : undefined,
  };
}

/** WebDAV backend（MmxWebDavBackendConfig：type 必填判别；可选项全部「非空才带」） */
function buildWebDavBackend(form: DemoFormFields): MmxWebDavBackendConfig {
  const username = form.webdavUsername.trim();
  const password = form.webdavPassword;
  return {
    type: "webdav",
    endpoint: form.endpoint.trim(),
    // 半凭证纪律（向导 M1-V1 同口径）：username 与 password 成对且非空才带，只填其一=按匿名处理
    ...(username !== "" && password !== "" ? { username, password } : {}),
    ...(form.webdavRootPath.trim() !== "" ? { rootPath: form.webdavRootPath.trim() } : {}),
    ...(form.webdavChunkedWrite ? { chunkedWrite: true } : {}),
    ...(form.ttl > 0 ? { ttlSeconds: form.ttl } : {}),
  };
}

/** 表单 → 工作台 #config（backend 按类型段分流；其余段两态共用） */
export function buildWorkspaceConfig(form: DemoFormFields): MmxWorkspaceConfig {
  const cfg: MmxWorkspaceConfig = {
    mode: "workspace",
    v: CONFIG_VERSION,
    backend: form.backendType === "webdav" ? buildWebDavBackend(form) : buildS3Backend(form),
    // security.allowedOrigins 留空数组即可：mount() 内 withHostOrigin 会自动把
    // window.location.origin（本页= http://localhost:5200）追加进去——这是协议
    // 硬要求（缺=宿主方向消息被 iframe 白名单静默丢弃，命令全 4004）。
    security: { allowedOrigins: [] },
    appearance: { theme: form.theme, locale: form.locale },
  };
  if (form.disabledFeatures.length > 0) {
    const features: Record<string, boolean> = {};
    for (const key of FEATURE_KEYS) features[key] = !form.disabledFeatures.includes(key);
    cfg.features = features;
  }
  if (form.univerPlugin || form.pdfAnnotator || form.mdPlugin || form.htmlPlugin || form.pptxPlugin || form.artplayerPlugin || form.filerobotPlugin) {
    // lazy 必须 false：md/xlsx/docx/pdf/媒体都有内置默认应用，lazy 插件在打开链「未命中才触发」永远轮不到
    const base = new URL(OEM_CONFIG.filesBase).origin;
    // markdown-editor 参数（PluginEntry.options → activate(sdk, options)，v1.1）；空串=不传走缺省链
    const mdOptions: Record<string, unknown> = {
      ...(form.mdInitialMode ? { initialMode: form.mdInitialMode } : {}),
      ...(form.mdDefaultMode ? { defaultMode: form.mdDefaultMode } : {}),
    };
    cfg.plugins = [
      ...(form.univerPlugin ? [{ url: `${base}/plugins/univer-office.js`, lazy: false as const }] : []),
      ...(form.pdfAnnotator ? [{ url: `${base}/plugins/pdf-annotator.js`, lazy: false as const }] : []),
      ...(form.mdPlugin
        ? [{ url: `${base}/plugins/markdown-editor.js`, lazy: false as const, ...(Object.keys(mdOptions).length ? { options: mdOptions } : {}) }]
        : []),
      ...(form.artplayerPlugin ? [{ url: `${base}/plugins/artplayer-player.js`, lazy: false as const }] : []),
      ...(form.htmlPlugin ? [{ url: `${base}/plugins/html-editor.js`, lazy: false as const }] : []),
      ...(form.pptxPlugin ? [{ url: `${base}/plugins/pptx-viewer.js`, lazy: false as const }] : []),
      ...(form.filerobotPlugin ? [{ url: `${base}/plugins/filerobot-image-editor.js`, lazy: false as const }] : []),
    ];
  }
  if (form.initialPath.trim() || form.treeMode !== "sidebar" || form.treeTitle.trim()) {
    cfg.ui = {
      treeMode: form.treeMode,
      ...(form.initialPath.trim() ? { initialPath: form.initialPath.trim() } : {}),
      ...(form.treeTitle.trim() ? { treeTitle: form.treeTitle.trim() } : {}),
    };
  }
  return cfg;
}

/**
 * onMount 前置校验：返回 i18n key（EmbedPlay 里 t() 消费）或 null=通过。
 * - 通用（两态）：endpoint 必填。
 * - S3：bucket 必填（复用 needEndpoint——既有文案本就覆盖 endpoint+bucket 语义）。
 * - WebDAV：endpoint 须为合法 http(s) URL（new URL 解析成功且 protocol ∈ http:/https:；
 *   与 frontend 连接向导 M2-V1 对 profiles.ts S3 endpoint 的既有口径一致）。
 */
export function validateForm(form: DemoFormFields): string | null {
  if (!form.endpoint.trim()) return "demo.embed.validate.endpointRequired";
  if (form.backendType === "webdav") {
    let url: URL;
    try {
      url = new URL(form.endpoint.trim());
    } catch {
      return "demo.embed.validate.endpointInvalid"; // URL 解析失败先行返回（向导同构）
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "demo.embed.validate.endpointInvalid";
    }
    return null;
  }
  if (!form.bucket.trim()) return "demo.embed.msg.needEndpoint";
  return null;
}

/**
 * #config 预览打码：S3=credentials 三键各 `非空 ? "***" : ""`（空串键也打成 ''——
 * 保持抽离前的既有预览行为）；WebDAV=password 打码为 "***"（空/缺省=''），
 * username 非秘密不打码。
 */
export function maskConfigForPreview(cfg: MmxWorkspaceConfig): string {
  let maskedBackend: MmxBackendConfig;
  if (cfg.backend.type === "webdav") {
    maskedBackend = { ...cfg.backend, password: cfg.backend.password ? "***" : "" };
  } else {
    maskedBackend = {
      ...cfg.backend,
      credentials: {
        accessKeyId: cfg.backend.credentials.accessKeyId ? "***" : "",
        accessKeySecret: cfg.backend.credentials.accessKeySecret ? "***" : "",
        sessionToken: cfg.backend.credentials.sessionToken ? "***" : "",
      },
    };
  }
  return JSON.stringify({ ...cfg, backend: maskedBackend }, null, 2);
}
