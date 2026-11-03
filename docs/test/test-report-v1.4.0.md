# 测试报告（v1.4.0 · 当前基线）

- 测试日期：2026-11-03（v1.4.0 发版当日全量复跑）
- 被测版本：main @ v1.4.0（tag 由发版流程落，本报告不锚历史提交）
- 环境：macOS / pnpm / Vitest + jsdom / Node `--test`（演示服务）

## 1. 被测面

| 批次 | 能力 | 主套件 |
|---|---|---|
| WebDAV 协议层 | WebDavClient 六方法/207 multistatus 解析/Basic 认证/错误分流/multipart 四方法/probe 对账 | `sdk/webdav/__tests__/`（client / client-multipart / parse）+ `sdk/__tests__/config-webdav` |
| WebDAV 装配与浏览 | `backend.type` 分流/向导类型段/树目录语义/boot 配置链 | `files/__tests__/setup-webdav` + `tree-store-webdav`(+cjk) + `connect-wizard` + `__tests__/boot-webdav` |
| WebDAV 写路径与上传矩阵 | mkdir MKCOL 逐级/目录单发 DELETE/改名祖先链/三态矩阵/跨会话判活 | `files/__tests__/upload-queue-webdav`（含串行泵 settle/probeMismatched 漂移用例） |
| 门控与契约 | 分享入口双门分离/list() 全 key 契约/zip 第二 RangeReader/datasource 注入 | `files/__tests__/ui.test.ts`（门控 3 例）+ cjk-nested 三件（复现 9 例：`client-cjk-nested`/`parse-cjk-nested`/`tree-store-webdav-cjk`）+ `apps/__tests__/zip-renderer` + `datasource` |
| embed demo | 文档中心 manifest/渲染 sanitize/宿主表单 configBuilder（S3/WebDAV 分支/打码/校验） | `mmagix-embed-demo` vitest：`docs.test.ts` + `configBuilder.test.ts`（31 例） |
| WebDAV 演示服务 | RFC 4918 class 1 子集/非标 Content-Range 追加写/路径安全/契约对齐 | `scripts/dev-webdav.test.mjs`（Node `--test`，58 例/14 套件） |

## 2. 结果总览

| 层 | 结果 | 判定 |
|---|---|---|
| L1 单元测试（frontend） | **1984 passed / 0 failed / 1 既有跳过**（154 文件） | ✅ |
| 行覆盖门禁 | 全局 lines ≥80% | ✅（阈值见 `vitest.config.ts`） |
| 类型闸 vue-tsc / eslint | 0 error（eslint 存量 20 warning） | ✅ |
| embed demo vitest | 31 passed（2 文件） | ✅ |
| WebDAV 演示服务 | 58 passed / 0 failed（14 套件） | ✅ |
| 构建 | frontend vite 28.88s / demo 2.82s，均成功 | ✅ |

### 口径闭合表（1828 → 1984）

| 分项 | 文件 | 例 |
|---|---|---|
| v1.3.0 基线（2026-10-31） | 142 | 1828 |
| WebDAV 批次（M1–M4：协议层/装配/写路径/上传矩阵，2026-11-02 终闸） | +9 | +144 |
| list() 全 key 契约复现（cjk-nested 三件：client/parse/tree-store） | +3 | +9 |
| 分享入口门控（ui.test.ts 扩展） | ±0 | +3 |
| **v1.4.0 终闸（2026-11-03 实测）** | **154** | **1984 passed + 1 skipped 0 failed** |

## 3. 关键判定例（本批新增的质量地雷回归）

- **串行泵提前 settle（P0）**：content-range 暂停路径提前 settle 误判完成——泵闸对调修复，
  6 红用例转绿（upload-queue-webdav）
- **对账重入伪重置（P0）**：重置后 probe=-1 与 confirmed=0 判失配烧尽上限——`probeMismatched`
  谓词共用修复，漂移用例 4 探节奏实证（同上）
- **list() 全 key 契约**：相对 key 曾致嵌套文件打开 404 与树错位——cjk-nested 三件共 9 复现
  用例钉死（client-cjk-nested「打开回路 get 必须命中编码路径」为实机 404 复现点）
- **@vue/shared 断链**：全量收集期炸错根因（element-plus peer 缺失）——vite alias 桥 +
  `server.deps.inline` 修复，154 文件全量可收集

## 4. 证据

- 单测套件与代码同目录（见 §1 主套件列）；演示服务证据 `pnpm -C mmagix-embed-demo test:webdav`
- 实机 CORS 取证批次待真机（设计预期矩阵见部署手册 §5.4 占位，未回填=诚实口径）
- 交付口径见 [delivery-checklist-v1.4.0.md](../releases/delivery-checklist-v1.4.0.md)；
  逐项验收见 [acceptance-v1.4.0.md](../releases/acceptance-v1.4.0.md)
