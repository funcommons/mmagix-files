# 安全策略（Security Policy）

## 安全模型（以代码为唯一事实源）

mmagix-files 是**纯前端** S3 文件管理器，以 iframe 嵌入宿主页面。安全边界如下：

| 边界 | 机制 | 代码位置 |
|---|---|---|
| 凭证不出宿主 | S3 密钥仅宿主持有（`setCredentials` 热替换 + TTL 自毁线），前端直传直取预签名 URL | `frontend/src/sdk/`、`frontend/src/apps/datasource.ts` |
| 宿主↔iframe 通道 | postMessage 双闸：`event.origin ∈ allowedOrigins` 白名单 + 发送 `targetOrigin` 禁 `*`；异源静默丢弃 | `frontend/src/sdk/bus.ts` |
| HTML 预览 | `sandbox="allow-scripts"` + srcdoc 净化（剥 script/on*/javascript: URI/meta refresh/base/object），跳转代理确认后新 tab | `frontend/src/apps/renderers/htmlSandbox.ts`、`html.ts` |
| 插件装载 | 可选 sha384 SRI 自校验（清单：`docs/releases/`） | `frontend/src/plugins/loader.ts` |
| 插件沙箱边界 | 插件与宿主同源同窗（非 iframe 隔离）——**只装载可信来源的插件脚本** | `frontend/src/sdk/plugins/` |
| WebDAV 凭证通道 | Basic 认证（`user:pass`）明文于每个请求 `Authorization` 头——仅建议 HTTPS；凭证不出前端（不进 URL/历史/摘要） | `frontend/src/sdk/webdav/client.ts`、`frontend/src/sdk/config.ts`（`buildConfigSummary`） |

## WebDAV 凭证通道注记

- **Basic 明文头**：每个 WebDAV 请求都携带 `Authorization: Basic base64(user:pass)`——走 HTTP 时等同口令明文传输，**生产环境仅建议 HTTPS**（方案正本 `docs/design/webdav-support-design.md` §W6）。
- **TTL 自毁线语义**：`ttlSeconds`/`expiresAt` 到点=**前端主动遗忘**（清态+`expired` 事件，不再携带 Authorization 头），**并非凭证真到期**——服务器侧密码仍然有效、无任何过期保护。文档与 UI 不得暗示 WebDAV 凭证存在过期保护（`sdk/types.ts` `WebDavBackend` 注记口径）。
- **连接档案明文存储**：WebDAV 档案落独立键 `mmagic.profiles.webdav`（localStorage），与 S3 AK/SK 档案同一明文形态，ConnectWizard 的常驻明文警示条对两库一体覆盖——仅建议个人设备使用。
- **摘要不透出密码**：`buildConfigSummary`（`frontend/src/sdk/config.ts`）对 webdav backend **整键缺省** `password`（不脱敏垫 `***`，键名也不透出），与既有 S3「credentials 整段不进摘要」同一红线（断言见 `frontend/src/sdk/__tests__/config-webdav.test.ts`）。

## 支持的版本

| 版本 | 支持状态 |
|---|---|
| 1.3.x | ✅ 支持 |
| 1.2.x | ✅ 安全修复 |
| 1.1.x 及更早 | ⚠️ 仅重大安全修复 |
| < 1.0 | ❌ 不支持 |

## 报告漏洞

**请勿公开 issue 披露。** 通过 GitHub Security Advisories（仓库页 → Security → Report a vulnerability）
私密报告。响应目标：48 小时内确认、7 天内给出评估与修复计划。

报告中请包含：影响版本、复现步骤、影响面评估（数据泄露/越权写/注入类）、可能的修复思路。
