# 安装部署手册

> 适用版本：v1.3.x。全部命令均在本仓验证通过（Node ≥ 18 / pnpm，仓内 pin 见下表）。

## 1. 组件拓扑

```
宿主页面（你的业务前端，任意源）
  └── <iframe src="https://<files-app>/#config=…">
        └── mmagix-files SPA（本仓 frontend/ 构建产物，静态托管）
              └── 动态插件 *.js（与 SPA 同源随发，可选 SRI 校验）
宿主 ↔ iframe 通信：postMessage（协议见 docs/design/jsdk-api.md）
S3/MinIO：前端直连（凭证仅宿主持有，经 setCredentials 注入）
```

## 2. 本地开发（跑通最短路径）

```bash
pnpm install                 # 仓库根（frontend 为 workspace 成员；demo/插件 standalone）
cd frontend && pnpm dev      # 终端 1：mmagix-files SPA（vite 默认端口 9330）
cd mmagix-embed-demo && pnpm dev   # 终端 2：宿主 demo（5200，strictPort）
# 打开 http://localhost:5200/embed/play → 「装载 iframe（#config）」→「续期（setCredentials）」
```

- demo 是宿主侧参考实现（工作台嵌入 `embed/play`、单文件嵌入、插件开关）。
- 5200（宿主）≠ 9330（iframe）是刻意的跨源形态——逼出 origin 白名单这条真实约束。
- 跑 E2E（Playwright）时 SPA 需起在 **5199**：`cd frontend && pnpm exec vite --port 5199 --strictPort`（E2E baseURL 固定指向它）。
- MinIO 联调：`localhost:9000`，bucket `mmagic-demo`（demo 内置连接向导可自填；demo 另备 `pnpm dev:s3` / `s3:seed` 脚本，见 `mmagix-embed-demo/README.md`）。
- 仓库根 `package.json` 的依赖（exceljs、@univerjs/*）属于构建链一部分：exceljs 供 frontend 渲染器类型闸引用，univer 供 univer-office 插件构建——勿删。

### 本地构建插件（改动 plugins/* 后必须）

```bash
pnpm --dir frontend/plugins/<plugin-name> build   # 产物入 frontend/public/plugins/
```

重建任一插件后须同步重出 SRI 清单（见 `docs/releases/`，流程见 CONTRIBUTING 契约同步红线）。

### 宿主客户端包（可选）

```bash
cd frontend/packages/files-client
../../node_modules/.bin/tsc -p tsconfig.build.json   # 产 dist（ESM + d.ts）
npm publish                                          # 发布（需 npm 凭证；发布前确认 dist 为最新构建）
```

## 3. 生产部署

### 3.1 构建 SPA

```bash
cd frontend && pnpm build        # vue-tsc 类型闸 + vite build → dist/
```

把 `frontend/dist/` 部署到任意静态托管（Nginx/CDN/OSS）。SPA 使用 history 路由：
Nginx 需配 `try_files $uri $uri/ /index.html`。

### 3.2 插件 bundle

`frontend/public/plugins/*.js`（7 个）随 `pnpm build` 一并进 dist（public 目录直拷）。
接入方按需装载，建议配 SRI 校验——现行清单见 [`docs/releases/v1.1.0-plugin-sri.json`](../releases/v1.1.0-plugin-sri.json)（7/7 与当前产物逐字一致；插件重建后须重出）。

### 3.3 宿主接入（三步）

1. `npm install @mmagix/files-client`（Vue 3 用 `@mmagix/files-client/vue`；非 Vue 用核心入口）
2. 构造 `MmxWorkspaceConfig` / `MmxSingleFileConfig`（**security.allowedOrigins 必须含宿主自身
   origin**——`mount`/`createMmagixFilesHost` 已自动追加）
3. `mount(config, "https://<files-app>/")` → 等 ready → `call()` / `on()`

完整协议与命令/事件/错误码：[`docs/design/jsdk-api.md`](../design/jsdk-api.md)。
可运行示例：`mmagix-embed-demo/`。

## 4. S3/MinIO 要求

- 桶 CORS：允许 files-app 源的 **GET/PUT/POST/HEAD/DELETE**，暴露 ETag
  （DELETE 必需：删除对象 / abortMultipartUpload / 版本删除都走 DELETE）
- STS 临时凭证（推荐）：宿主后端签发，前端经 `setCredentials` 注入；`ttlSeconds` 设前端自毁线（≤ STS 真实 TTL）
- 预签名 URL 直传直取（凭证不出宿主的替代形态：单文件模式 `source.url`/`save.url` 直链）
- **桶版本控制（可选能力）**：开启 Versioning 后，回收站（DeleteMarker 恢复/彻底删除）与右键「历史版本」可用；
  未开启时这两个入口自动隐藏（能力门控），其余功能不受影响
- 分享信封：开启分享密码后会在桶内写 `shares/<shareId>.json` 元数据对象（同桶同前缀）
- 断点续传：>16MB 分片上传的进度 checkpoint 存浏览器 IndexedDB（纯客户端，无服务端要求）

## 5. 环境要求

| 项 | 要求 |
|---|---|
| Node | ≥ 18（开发/构建；唯一 engines 声明在 files-client 包）；运行时为纯浏览器产物，无服务端 |
| pnpm | 仓内 pin `pnpm@9.12.0`（packageManager 字段）；更新版本可用，但勿在 `frontend/plugins/*` 内跑 `pnpm add`（锁文件地雷，见 CONTRIBUTING） |
| 浏览器 | Chrome/Edge 现代版（Monaco/Univer/X6 均需）；Safari/Firefox 可用（本地文件夹模式未实现，无 File System Access API 依赖） |

## 6. 健康检查

| 检查 | 方法 |
|---|---|
| SPA 存活 | `curl -s -o /dev/null -w "%{http_code}" https://<files-app>/` = 200 |
| 握手 | 宿主日志出现 `evt ready`（10s 内）；超时查 baseUrl 与 iframe 页启动 |
| 命令通 | ready 后 `call("getInfo")` 有回包；**全部 4004 超时 = allowedOrigins 白名单缺宿主 origin** |
| 插件装载 | demo「装载插件」开关 + 协议日志无 SRI 校验失败 |
