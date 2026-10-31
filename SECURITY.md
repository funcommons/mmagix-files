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
