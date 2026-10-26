/**
 * 宿主客户端包桥（v1.1 起）：实现抽为独立包 @mmagix/files-client，本文件仅作兼容出口——
 * demo 内既有 `@/composables/useMmagixFilesClient` 导入零改动。
 * 真实接入方直接 `npm install @mmagix/files-client`（Vue 项目用 `@mmagix/files-client/vue`）。
 * 协议漂移由 frontend 套件内 clientProtocol.test.ts 哨兵拦截。
 */
export * from "@mmagix/files-client";
export * from "@mmagix/files-client/vue";
