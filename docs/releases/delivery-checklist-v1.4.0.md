# 交付清单（v1.4.0）

- 发布日期：2026-11-03 · Tag：`v1.4.0` · 提交：见 tag（本清单随版定稿，tag 由发版流程落）

## 交付物

| # | 物 | 位置 | 说明 |
|---|---|---|---|
| 1 | SPA 构建产物 | `frontend/` → `pnpm build` → `dist/` | 静态托管；history 路由需 try_files 兜底 |
| 2 | 插件 bundle ×7 | `frontend/public/plugins/*.js` | 本版未重建（与 v1.1.0/v1.2.0/v1.3.0 同批产物） |
| 3 | SRI 清单 | 沿用 [`v1.1.0-plugin-sri.json`](v1.1.0-plugin-sri.json) | 7/7 与本版产物实测一致（2026-10-31 实测口径沿袭） |
| 4 | 宿主客户端包 | `frontend/packages/files-client/` | 三包版本同步 1.4.0（根/ frontend / files-client） |
| 5 | 官网（mmagix-embed-demo） | `mmagix-embed-demo/` → `pnpm build` → `dist/` | 三路由：`/` 落地页 + `/docs` 文档中心（curated 10 篇 markdown）+ `/play` 演示区（overview/workspace/file）；旧 `/overview`、`/embed/*` 重定向保留 |
| 6 | WebDAV 演示服务 | `mmagix-embed-demo/scripts/dev-webdav.mjs` | 零依赖 Node ESM（RFC 4918 class 1 子集 + 非标 Content-Range 追加写）；`pnpm test:webdav` 58 例护航；**演示件非生产件** |
| 7 | 文档集 | `docs/` | release 三件（本清单/测试报告/验收报告）+ PRD FR-18 + 架构 D14–D17 + 部署 §5 CORS/known-good + 用户手册 WebDAV 节 + SECURITY WebDAV 凭证通道注记 + 测试计划/用例 154 文件刷新 |

## 版本内容摘要（详见 CHANGELOG [1.4.0]）

- **多数据源（S3｜WebDAV）全链**：`WebDavClient implements S3Client` 第二实现，`backend.type`
  单向分流——UI/树/搜索/上传下载队列全部复用；向导类型段（成对凭证/连接测试三分流/URL 闸）；
  目录 collection 语义分流（MKCOL 逐级/单发 DELETE/改名祖先链）；上传三态矩阵
  （s3-multipart｜content-range 非标分块续写+MOVE 完成+probe 对账｜none 整包降级+1GB 上限拒收）；
  zip 解压 objectRangeReader 第二档；六可选能力门控自动隐藏；Basic 认证与错误语义分流
- **分享入口能力门控隐藏**：Toolbar `v-if` 能力门 + `disabled` 选择门双门分离，TreePanel 菜单
  同判据守卫；S3 行为逐字节不变
- **embed demo 官网化**：三路由 + 文档中心 + 宿主表单 WebDAV 数据源（类型段联动缺省 endpoint、
  configBuilder 抽取、半凭证纪律、setCredentials 按能力禁用）
- **协议零破坏性变更**：`backend.type` 缺省 `'s3'`，存量接入零感知；宿主命令层 19 条不变

## 质量证据

- frontend 单测 **1984 passed + 1 skipped 0 failed（154 文件）**（2026-11-03 发版终闸实测；
  口径=v1.3.0 基线 1828 例 + WebDAV 批次 144 + list() 契约复现 9 + 分享门控 3）
- vue-tsc 0 error；eslint 0 error / 20 存量 warning；files-client 协议漂移哨兵 21 绿
- build 通过（vite 28.88s）
- embed demo：typecheck 0 / vitest 31 passed（2 文件）/ webdav 演示服务 58 passed（14 套件）/
  build 通过（2.82s）
- 详见 [test-report-v1.4.0.md](../test/test-report-v1.4.0.md)

## 已知边界（随版交付）

- **WebDAV 分享/直链/版本能力门控隐藏属设计非缺陷**：FR-18 非目标（WebDAV 无桶版本与预签名
  概念）——回收站/历史版本/信封分享/上传直链入口自动隐藏而非报错
- **dev-webdav 为演示服务非生产件**：非标 `PUT Content-Range: bytes=-N` 追加写仅演示链存在
  （HTTP 写侧续写无 RFC 标准）；生产开启分块续写须服务器实测支持，known-good 清单见部署手册
  §5.4（占位，随实机取证回填）
- **实机 CORS 取证批次仍待真机**：服务器支持矩阵（Nextcloud/Synology/坚果云等）为设计预期，
  实证批次留待有真机环境时另开（见验收报告遗留去向）
- v1.2.0 遗留沿袭：ShareAccess 未挂路由；ListParts 不实现
