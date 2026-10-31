# mmagixfiles-embed-demo — mmagix-files 宿主接入演示

演示如何把 [mmagix-files](../frontend/)（纯前端、S3 直连的文件工作台 SPA）通过
**iframe + `#config` / `#file` fragment + postMessage JSSDK** 嵌入第三方宿主页面。
工程形态 copy 自 `opencut-embed-demo`（Vue 3 + Element Plus + Pinia + vue-router +
Vite + SCSS 品牌令牌），**composable 实现抽为 npm 包 [`@mmagix/files-client`](../frontend/packages/files-client/)**（本 demo 经 vite alias 消费同一份源码，`src/composables/useMmagixFilesClient.ts` 仅为兼容出口）——接入方直接 `npm install @mmagix/files-client`。

## 快速开始（两个终端）

```bash
# 终端 1：被嵌 SPA（本仓 frontend/）——dev 端口固定 5199
cd ../frontend
pnpm exec vite --port 5199 --strictPort
#   （vite.config 默认 9330，5199 是本仓 e2e/联调口径；BROWSER=none 可免自动开窗）

# 终端 2：宿主 demo——固定 5200
pnpm install
pnpm dev          # http://localhost:5200
```

| 页面 | 内容 |
| --- | --- |
| 接入总览 `/overview` | 三步接入 + #config 字段表 + 命令/事件/错误码表 |
| 工作台嵌入 `/embed/play` | `#config` 装载 + ready 握手 + 全量命令按钮 + 14 事件日志 |
| 单文件嵌入 `/embed/file` | `#file` 只读/可编辑装载（demo 自带 `public/sample-data/` 样例） |

验收脚本：`pnpm typecheck` 0 错；`scripts/` 附带 s3rver 本地 S3（`dev-s3.mjs`）、桶管理（`s3-admin.mjs`）、种子数据（`s3:seed` / `seed-apps.mjs`）与单文件样例服务（`single-file-server.mjs`）。

## ⚠️ 头号坑：origin 白名单

`#config.security.allowedOrigins` **必须包含宿主自身 origin**（本 demo 即
`http://localhost:5200`）：

- iframe 侧收消息按 `event.origin ∈ security.allowedOrigins` 白名单校验，
  不在表内 → **静默丢弃**（协议码 5001，但不回包、无任何报错）；
- 症状极具迷惑性：`ready` 事件**收得到**（那个方向只看发送方 targetOrigin），
  而宿主发出的**每一条命令都石沉大海，全部 4004 超时**；
- 本 demo 的 `mount()` 已自动把 `window.location.origin` 追加进白名单
  （`withHostOrigin()`，见 useMmagixFilesClient.ts），换域部署无需改代码。

其他铁律：发送 targetOrigin 一律取 iframe 精确 origin（**禁 `*`**）；
配置只走 fragment（**禁 query**）；拼链接只用 `encodeURIComponent`，
解析端别用 `URLSearchParams`（会把 `+` 解成空格，破坏 JSON 字面 `+`）。

## #config 字段表（工作台模式）

```jsonc
{
  "mode": "workspace", "v": 1,
  "backend": {
    "endpoint": "https://oss-cn-shenzhen.aliyuncs.com",
    "region": "oss-cn-shenzhen",
    "bucket": "your-bucket",
    "prefix": "sessions/20261008-abc/",        // 会话目录域；''=bucket 根
    "credentials": { "accessKeyId": "STS…", "accessKeySecret": "…", "sessionToken": "…" },
    "ttlSeconds": 3600                          // 前端自毁定时器 ≤ STS 真实 TTL
  },
  "security": { "allowedOrigins": ["https://your-app.example.com"] },  // ← 必须含宿主自身
  "params": { "uploadMaxBytes": 104857600, "uploadConcurrency": 3 },
  "appearance": { "theme": "light", "locale": "zh-CN", "brand": { "name": "…" } },
  "features": { "upload": true, "mkdir": true, "rename": true, "delete": true,
                "download": true, "multiTab": true, "openWithMenu": true, "plugins": true },
  "permissions": { "denyExts": ["exe"] },
  "ui": { "initialPath": "/" }
}
```

`#file` 单文件模式（与 `#config` 互斥）：`{ v, source:{url,method?,body?,headers?},
save?, name?, appearance?, security? }` ——只读=无 `save` 段；命令子集仅
`setTheme / setLocale / getInfo / destroy`（工作台命令=4305）。

## 常见错误速查

| 症状 / code | 原因与处置 |
| --- | --- |
| `ready` 收到但**所有命令 4004 超时** | `security.allowedOrigins` 缺宿主 origin（5001 静默丢弃的外显）——本 demo 已自动追加 |
| 4001 BAD_CONFIG | 配置 JSON 坏 / 缺 `backend.*` / `v≠1` / `#config` 与 `#file` 同时存在 |
| 4004 单条超时 | iframe 页未起、baseUrl 错、或该命令在 iframe 侧真的卡住 |
| 4303 QUEUE_OVERFLOW | 未收到 ready 就发命令（宿主侧直接拒）；iframe 侧队列上限 50 |
| 4305 UNSUPPORTED_MODE | 单文件模式下调工作台命令 |
| 5000 SESSION_EXPIRED | 会话已 `expired`（ttl 到 / destroy 过）后继续发命令 |
| 4101 S3_ERROR | bucket CORS 未配（GET/PUT/POST/DELETE/HEAD + `ExposeHeaders: ETag` 缺不可） |
| iframe 白屏 | 5199 没起；或浏览器拦截了跨源 iframe（看 console） |

## 凭据与 .env.local

本机已配置可用的 S3 后端（`.env.local`，已 gitignore），打开「嵌入工作台」即一键装载：

| 项 | 值 | 说明 |
| --- | --- | --- |
| endpoint | `http://localhost:9000` | **本机现成 MinIO**（RAGFlow 技术栈自带容器 `ragflow-minio-1`，pgsty/silo 镜像） |
| Console | `http://localhost:9001` | 同一实例的管理台，账密同下 |
| 账密 | `rag_flow` / `infini_rag_flow` | 该 MinIO 的 root 凭据（演示用途；生产必须换 STS，见下） |
| bucket | `mmagic-demo` | 演示专用桶，已灌种子对象（hello.md / notes/meeting.md / demo.csv / logo.svg） |

桶的（重）建与灌种：

```bash
node scripts/s3-admin.mjs http://localhost:9000 rag_flow infini_rag_flow us-east-1 createBucket mmagic-demo
pnpm s3:seed   # 读 .env.local，灌入演示种子对象
```

离线/无 MinIO 替代路径（三选一）：

1. `pnpm dev:s3` —— 起 `s3rver`（npm S3 兼容服务，:9000 被占时改 scripts/dev-s3.mjs 端口），
   任意 AK/SK 皆可；再按上表改 `.env.local` 指向它；
2. 切「单文件嵌入」页，用 demo 自带样例（`public/sample-data/hello.md`、`demo.csv`）
   或任意 CORS GET URL 看渲染效果；
3. 浏览器直开 `http://localhost:5199/`，走 SPA 内置本地连接向导。

`.env.local` 模板见 `.env.example`：

> 生产提醒（手册§四）：接入必须用 STS scoped 临时凭证（prefix 限定 + 短 TTL +
> 最小动作集），配置 URL 在用户点击时由后端现拼现发——「URL 即凭证」。

## 与 opencut-embed-demo 的形态差异

| 项 | opencut-embed-demo | 本 demo |
| --- | --- | --- |
| 被嵌应用 | OpenCut 编辑器（同机反代 `/opencut`） | mmagix-files SPA（跨源直连 `http://localhost:5199/`） |
| SDK | `@opencut/embed-sdk`（vite alias 源码） | [`@mmagix/files-client`](../frontend/packages/files-client/)（vite alias 源码）；UI 层已接 fc-web-sdk（`src/components/sdk`，Fc* 组件 + FcThemeProvider/FcThemeSwitcher，符合《fc-web-sdk》规范） |
| 品牌 | 9 个 | 随宿主注入（demo 内置品牌表已退役，见 src/App.vue） |
| 页面 | Overview + EmbedPlay | Overview + EmbedPlay（工作台）+ FilePlay（单文件） |
| 端口 | 9340 | 5200（strictPort） |

契约正本：`../../docs/design/jsdk-api.md`（协议）/`../../docs/operations/user-guide.md`（接入）；
协议常量/形状镜像自 `../frontend/src/sdk/{constants,types}.ts`，改协议须两处同步。
