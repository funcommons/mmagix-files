# 安装部署手册

> 适用版本：v1.1.x。全部命令均在本仓验证通过（Node ≥ 20 / pnpm ≥ 11）。

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
pnpm install                 # 仓库根（workspace 仅 frontend；demo/插件 standalone）
cd frontend && pnpm dev --port 5199 --strictPort   # 终端 1：mmagix-files SPA
cd mmagix-embed-demo && pnpm dev                   # 终端 2：宿主 demo（5200）
# 打开 http://localhost:5200/embed/play → 「装载 iframe（#config）」→「续期（setCredentials）」
```

- demo 是宿主侧参考实现（工作台嵌入 `embed/play`、单文件嵌入、插件开关）。
- 5200（宿主）≠ 5199（iframe）是刻意的跨源形态——逼出 origin 白名单这条真实约束。
- MinIO 联调：`localhost:9000`，bucket `mmagic-demo`（demo 内置连接向导可自填）。

### 本地构建插件（改动 plugins/* 后必须）

```bash
pnpm --dir frontend/plugins/<plugin-name> build   # 产物入 frontend/public/plugins/
```

### 宿主客户端包（可选）

```bash
cd frontend/packages/files-client
../../node_modules/.bin/tsc -p tsconfig.build.json   # 产 dist（ESM + d.ts）
npm publish                                          # 发布（需 npm 凭证）
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
接入方按需装载，建议配 SRI 校验——清单见 [`docs/releases/v1.1.0-plugin-sri.json`](../releases/v1.1.0-plugin-sri.json)。

### 3.3 宿主接入（三步）

1. `npm install @mmagix/files-client`（Vue 3 用 `@mmagix/files-client/vue`；非 Vue 用核心入口）
2. 构造 `MmxWorkspaceConfig` / `MmxSingleFileConfig`（**security.allowedOrigins 必须含宿主自身
   origin**——`mount`/`createMmagixFilesHost` 已自动追加）
3. `mount(config, "https://<files-app>/")` → 等 ready → `call()` / `on()`

完整协议与命令/事件/错误码：[`docs/design/jsdk-api.md`](../design/jsdk-api.md)。
可运行示例：`mmagix-embed-demo/`。

## 4. S3/MinIO 要求

- 侧配置 CORS：允许 files-app 源的 GET/PUT/POST/HEAD，暴露 ETag
- STS 临时凭证（推荐）：宿主后端签发，前端经 `setCredentials` 注入；`ttlSeconds` 设前端自毁线（≤ STS 真实 TTL）
- 预签名 URL 直传直取（凭证不出宿主的替代形态：单文件模式 `source.url`/`save.url` 直链）

## 5. 环境要求

| 项 | 要求 |
|---|---|
| Node | ≥ 20（开发/构建）；运行时为纯浏览器产物，无服务端 |
| pnpm | ≥ 11 |
| 浏览器 | Chrome/Edge 现代版（Monaco/Univer/X6 均需）；Safari/Firefox 不支持 File System Access API（本地文件夹模式） |

## 6. 健康检查

| 检查 | 方法 |
|---|---|
| SPA 存活 | `curl -s -o /dev/null -w "%{http_code}" https://<files-app>/` = 200 |
| 握手 | 宿主日志出现 `evt ready`（10s 内）；超时查 baseUrl 与 iframe 页启动 |
| 命令通 | ready 后 `call("getInfo")` 有回包；**全部 4004 超时 = allowedOrigins 白名单缺宿主 origin** |
| 插件装载 | demo「装载插件」开关 + 协议日志无 SRI 校验失败 |
