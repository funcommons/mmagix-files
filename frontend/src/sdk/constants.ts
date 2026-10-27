/**
 * JSSDK 协议常量
 * 契约正本：《docs/design/jsdk-api.md》V1.0
 * 本文件由主线持有，子 agent 只读。
 */

/** 消息命名空间——非本命名空间消息一律忽略 */
export const NS = 'mmagix-files' as const

/** 协议主版本（信封 v；插件 requiresSdk 比较对象） */
export const PROTOCOL_VERSION = 1 as const

/** 前端配置协议版本（#config/#file 的 v 字段，独立口径） */
export const CONFIG_VERSION = 1 as const

/** 命令默认超时（SDK 构造可配 timeoutMs 覆盖） */
export const DEFAULT_TIMEOUT_MS = 10_000

/** ready 前命令队列上限，超出拒（4303 QUEUE_OVERFLOW） */
export const READY_QUEUE_LIMIT = 50

/** 会话到期预警提前量（T-5min，UX 线） */
export const EXPIRE_WARN_BEFORE_MS = 5 * 60 * 1000

/** 建议凭证 TTL 上限档与硬帽（秒） */
export const TTL_RECOMMENDED_MAX_SEC = 3600
export const TTL_HARD_CAP_SEC = 24 * 3600

/** 渲染失败超时（预览策略建议默认） */
export const RENDER_TIMEOUT_MS = 10_000
