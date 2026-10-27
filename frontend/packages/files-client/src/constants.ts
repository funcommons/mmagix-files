/**
 * 协议常量（镜像 frontend/src/sdk/constants.ts——漂移由 frontend 套件内 clientProtocol.test.ts 拦截）。
 * 正本语义见 ../../../../docs/design/jsdk-api.md。
 */

/** postMessage 命名空间（信封 ns 字段；异 ns 消息双向静默丢弃） */
export const NS = "mmagix-files" as const;

/** 协议主版本（信封 v 字段；双侧不一致忽略） */
export const PROTOCOL_VERSION = 1 as const;

/** #config fragment 配置版本 */
export const CONFIG_VERSION = 1 as const;

/** 命令/握手缺省超时（ms） */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** iframe（mmagix-files SPA）缺省地址：本仓 frontend/ 以 5199 端口起 dev */
export const DEFAULT_FILES_BASE = "http://localhost:5199/";
