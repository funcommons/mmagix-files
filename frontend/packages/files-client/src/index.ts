/**
 * @mmagix/files-client —— mmagix-files 宿主侧接入客户端（框架无关核心入口）。
 *
 * 零依赖：裸 window.postMessage 封装（iframe 双闸 origin 校验 + reply-by-id + 事件订阅）。
 * Vue 3 项目用 `@mmagix/files-client/vue` 的 useMmagixFilesClient 组合式层。
 *
 * 头号坑：#config 的 security.allowedOrigins 必须含宿主自身 origin——mount/createHost
 * 已自动注入（withHostOrigin），但请理解规则：换域名部署无需改代码，自动追加的永远是自己。
 *
 * 协议正本：../../../../docs/design/jsdk-api.md（本包常量/形状逐字段镜像 frontend/src/sdk，
 * 漂移由 frontend 套件内 clientProtocol.test.ts 拦截）。
 */
export * from "./constants";
export * from "./error";
export * from "./host";
export * from "./types";
export * from "./url";
