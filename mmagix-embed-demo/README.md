# mmagix-embed-demo — mmagix-files 官网（文档 + 在线演示）

mmagix-files（纯前端、S3/WebDAV 直连的文件工作台 SPA，本仓 `frontend/`）的官网项目：
**文档中心**（直接消费仓库 `docs/` 原始 markdown，marked + DOMPurify 渲染）+
**在线演示**（iframe + `#config` / `#file` fragment + postMessage JSSDK 嵌入形态）。
工程形态 copy 自 `opencut-embed-demo`（Vue 3 + Element Plus + Pinia + vue-router + Vite + SCSS 品牌
令牌），composable 实现抽为 npm 包 [`@mmagix/files-client`](../frontend/packages/files-client/)（本
demo 经 vite alias 消费同一份源码）。

## 路由

| 路由 | 页面 | 布局 |
| --- | --- | --- |
| `/` | 官网首页（hero / 指标 ledger / 能力 ledger / WebDAV 协议表 / 文档入口 / CTA） | `SiteLayout`（sticky 头部 + footer） |
| `/docs/:slug?` | 文档中心（`src/docs/manifest.ts` curated 清单 → 仓库 `docs/*.md`） | 同上 |
| `/play/overview` | 接入总览（#config 字段表 + 命令/事件/错误码表） | `AppLayout` |
| `/play/workspace` | 工作台嵌入（`#config` 装载 + ready 握手 + 命令按钮 + 事件日志） | 同上 |
| `/play/file` | 单文件嵌入（`#file` 只读/可编辑装载，`public/sample-data/` 样例） | 同上 |

旧路径重定向：`/overview → /play/overview`，`/embed/play → /play/workspace`，
`/embed/file → /play/file`，未知路径回 `/`。

## 快速开始

```bash
pnpm install
pnpm dev          # 官网 http://localhost:5200
```

| 服务 | 命令 | 端口 | 用途 |
| --- | --- | --- | --- |
| 官网（本 demo） | `pnpm dev` | 5200 | 官网 + 演示宿主页 |
| 被嵌 SPA | `cd ../frontend && pnpm exec vite --port 5199 --strictPort` | 5199 | iframe 里的 mmagix-files |
| 本地 S3 | `pnpm dev:s3` | 9000 | s3rver 本地桶（`s3:seed` 造种子数据） |
| 本地 WebDAV | `pnpm dev:webdav` | 5240 | WebDAV 联调数据源（数据目录 `s3-data/mmagic-demo/`，与 S3 共享数据池） |

WebDAV 数据目录缺省与本地 S3 共享（`s3-data/mmagic-demo/`，两边上传/建目录互相可见）；
设 `WEBDAV_ROOT` 可改用独立目录。

无真实凭据时：官网首页走「在线演示」连本地服务，或直接开 `http://localhost:5199/`
用内置连接向导；也可建 `.env.local` 填 `VITE_S3_*` 作为演示表单缺省（已 gitignore）。

## iframe 联调指向

演示的 iframe 基址读 `VITE_MMFILES_BASE`（缺省 `http://localhost:5199/`，见
`src/config/oem.ts`）。宿主 5200 ≠ iframe 5199 是刻意的跨源形态——逼出
`security.allowedOrigins` 白名单这条真实约束：白名单必须含宿主自身 origin，否则
`ready` 收得到、命令全部 4004 超时（5001 静默丢弃）。demo 的 `mount()` 已自动追加
`window.location.origin`。协议契约正本：`../docs/design/jsdk-api.md`。

## 验收

`pnpm typecheck`（0 错）· `pnpm build` · `pnpm test`（vitest）· `pnpm test:webdav`（scripts 单测）。
