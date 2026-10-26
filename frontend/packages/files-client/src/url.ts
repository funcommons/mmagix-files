/**
 * fragment 链接构造（协议 §一/§四）：
 * 配置只走 URL fragment（#config= / #file= + encodeURIComponent），禁 query——
 * fragment 不到服务端/代理日志；解析端用 decodeURIComponent 还原，不可用
 * URLSearchParams（会把 '+' 解成空格，破坏 JSON 里的字面 '+'）。
 */
import { DEFAULT_FILES_BASE } from "./constants";
import type { MmxAppConfig, MmxSingleFileConfig, MmxWorkspaceConfig } from "./types";

/** 规整 base：保证以 / 结尾（SPA 路由基线），缺省 http://localhost:5199/ */
export function normalizeBase(baseUrl: string = DEFAULT_FILES_BASE): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

/** iframe 的精确 origin（发送 targetOrigin / 接收 event.origin 校验都用它） */
export function originOf(baseUrl: string): string {
  return new URL(normalizeBase(baseUrl)).origin;
}

/**
 * 工作台模式链接：`${base}#config=${encodeURIComponent(JSON.stringify(config))}`。
 * 禁 query（?config=…）——fragment 不到服务端/代理日志。
 */
export function buildConfigUrl(baseUrl: string, config: MmxWorkspaceConfig): string {
  return `${normalizeBase(baseUrl)}#config=${encodeURIComponent(JSON.stringify(config))}`;
}

/** 单文件模式链接：`${base}#file=…`（与 #config 互斥，二选一） */
export function buildFileUrl(baseUrl: string, config: MmxSingleFileConfig): string {
  return `${normalizeBase(baseUrl)}#file=${encodeURIComponent(JSON.stringify(config))}`;
}

/**
 * ⚠️ 自动把宿主自身 origin 追加进 security.allowedOrigins（去重、保序）。
 * 不加的后果：iframe 侧 bus 按「event.origin ∈ security.allowedOrigins」白名单校验，
 * 宿主→iframe 方向全被静默丢弃（等价 5001 ORIGIN_REJECTED），命令全部 4004 超时。
 * workspace 模式必填 allowedOrigins；file 模式可选（缺省 iframe 侧从 document.referrer
 * 推导）——但显式写上更稳（某些 referrer 策略下 referrer 可能为空）。
 */
export function withHostOrigin<C extends MmxAppConfig>(config: C): C {
  const host = window.location.origin;
  if (config.mode === "workspace") {
    const list = config.security.allowedOrigins;
    if (!list.includes(host)) config.security.allowedOrigins = [...list, host];
  } else {
    const list = config.security?.allowedOrigins ?? [];
    if (!list.includes(host)) {
      config.security = { allowedOrigins: [...list, host] };
    }
  }
  return config;
}
