# 验收报告（v1.4.0）

- 验收日期：2026-11-03（发版当日） · 被验物：[交付清单](delivery-checklist-v1.4.0.md) 全部条目
- 验收依据：CHANGELOG [1.4.0] 承诺项 × 实际代码/行为（以代码运行为准，逐条可复现）

## 一、验收结论

**通过。** 承诺项全部兑现；记录偏差一项（演示服务非标扩展口径，设计正本 §W4 已声明，非缺陷）；
遗留如实登记（见 §四）。上一版遗留（ShareAccess 未挂路由）如实沿袭。

## 二、逐项验收

| # | 验收项 | 验收标准 | 方法 | 结果 |
|---|---|---|---|---|
| 1 | 多数据源接入 | `WebDavClient implements S3Client`；`backend.type` 缺省 `'s3'` 存量零感知；WebDAV 会话树/列表/搜索/下载/预览/解压全复用 | `pnpm -C frontend exec vitest run`（154 文件/1984 passed+1 skip/0 failed）：`setup-webdav` + `boot-webdav` + `apps/__tests__/datasource` + `config-webdav` | ✅ |
| 2 | 连接向导类型段 | S3｜WebDAV 分段切换；用户名/密码成对校验；测试连接三分流（成功含空根警示/401/网络不通）；endpoint URL 闸；WebDAV 档案独立键、summary password 整键缺席 | `connect-wizard` + `config-webdav`（type 分流校验/脱敏断言） | ✅ |
| 3 | 上传矩阵三态 | `s3-multipart` 照旧；`content-range`=旁路 temp 追加+MOVE 覆盖+probe 对账（暂停/重置两 P0 已修）；`none`=整包 PUT+1GB 上限拒收+不写断点 | `upload-queue-webdav` + `client-multipart`（串行泵 6 红转绿/probeMismatched 漂移 4 探节奏用例在内） | ✅ |
| 4 | 门控隐藏面 | WebDAV 六可选能力缺席→回收站/历史版本/分享/直链/孤儿清理整入口隐藏而非报错；分享入口双门分离（Toolbar `v-if`+`disabled`、TreePanel 菜单守卫）；S3 行为逐字节不变 | `ui.test.ts` 门控 3 例（shareEnabled=false 菜单/Toolbar）+ `setup-webdav` 缺席面断言 + `tree-store-webdav` 回归 | ✅ |
| 5 | 官网三路由 | `/` 落地页 + `/docs/:slug?` 文档中心 + `/play/*` 演示区；旧 `/overview`、`/embed/*` 重定向保留；未匹配回首页 | `mmagix-embed-demo` 路由表（`src/router/index.ts`）+ `pnpm -C mmagix-embed-demo exec vitest run`（2 文件/31 passed）+ build 通过 | ✅ |
| 6 | 文档中心 | curated 10 篇 markdown（入门/产品/设计/运维/发布分组）；渲染 sanitize 铁律 | demo vitest `docs.test.ts`（DOC_MANIFEST/renderMarkdown/loadDoc） | ✅ |
| 7 | WebDAV 演示服务 | 零依赖 Node ESM；RFC 4918 class 1 子集方法集；非标 `PUT Content-Range: bytes=-N` 追加写（size!==N→409）；与 dev-s3 共享数据池、`WEBDAV_ROOT` 可独立；207/单次解码/probe HEAD 契约与客户端对齐 | `pnpm -C mmagix-embed-demo test:webdav`（58 passed/14 套件，Node `--test`） | ✅ |
| 8 | 契约修复三项 | WebDAV `list()` 全 key（嵌套打开 404 复现点转绿）；vitest `@vue/shared` 断链修复全量可收集；vue 双副本 Ref 伪错守卫重述 | cjk-nested 三件 9 复现用例 + 154 文件全量收集成功 + `config-webdav` setCredentials 守卫断言 | ✅ |
| 9 | 协议兼容 | 零变更（宿主命令层 19 条不变） | 漂移哨兵绿（`clientProtocol.test.ts` 挂 frontend 套件；files-client 包 core+vue 21 例全绿） | ✅ |
| 10 | 质量闸 | frontend 154 文件/1984 passed+1 skip/0 failed；vue-tsc 0；eslint 0 error；demo typecheck 0/vitest 31/webdav 58；双 build 成功 | 五闸全量复跑（2026-11-03，原文见 [test-report-v1.4.0.md](../test/test-report-v1.4.0.md) §2） | ✅ |

## 三、记录偏差与例外

- **dev-webdav 的 `PUT Content-Range: bytes=-N` 为非标扩展，仅限演示服务**：HTTP 写侧续写无
  RFC 标准（Range 只为 GET 定义）；该实现是演示分块续写链的存在理由，与 Nextcloud 同型，
  **不代表通用 WebDAV 服务器能力**——生产开启 `chunkedWrite` 须按部署手册 §5.4 known-good
  清单实测（现为占位）。设计正本 §W4 已声明，验收口径如实记录，不作缺陷。

## 四、遗留与后续

| 项 | 去向 |
|---|---|
| 实机 CORS known-good 清单 | 待真机环境另开取证批次（Nextcloud/Synology/坚果云/alist 设计预期矩阵见部署手册 §5.4，实证后回填） |
| content-range 残留 temp 清扫 | `sdk/webdav/client.ts` 残留 temp 诚实注记（M4-V1 P2）：候补=PROPFIND 扫目标目录 `*.mmagix-part` 实现 `listMultipartUploads`；现行无自动清扫面 |
| ShareAccess 路由接线 | 沿袭 v1.2.0 遗留 |
| WebDAV MOVE/P1 候补（Digest/LOCK 展示/alist 预设） | 方案正本 §七 P1 候补行 |

## 五、签字

| 角色 | 状态 |
|---|---|
| 开发自验 | ✅ 2026-11-03（五闸原文与口径闭合表见 test-report-v1.4.0.md） |
| 验收复核 | ✅ 本报告逐项可复现（方法列=命令+套件名） |
