# 测试计划

> 项目：mmagix-files（纯前端 S3 文件管理器）· 现行计划（2026-10-31 随 v1.3.0 刷新）· 以代码为唯一事实源（测试与代码同仓库同目录）
> 历史版本计划不单独存档——本文档始终描述当前基线；版本时点结果见 `test-report-v*.md`。

## 1. 测试策略与分层

| 层 | 载体 | 规模（v1.3.0 实测，2026-10-31） | 触发 |
|---|---|---|---|
| L1 单元测试 | Vitest + jsdom；测试与被测同目录 `__tests__/` | 142 文件 / 1828 例通过 + 1 既有跳过 | 每次提交前全量 |
| L2 端到端（E2E） | Playwright（Chromium 单 project，workers=1），脚本+截图证据归档 `test-report/<日期-批次>/` | 12 个 spec（`e2e/00-warmup` + `line1`~`line11`）+ 1 个探针脚本（monaco-probe.mjs）；累计 11 个证据批次 | 功能交付/回归 |
| L3 实机截图取证 | Playwright 截图 + 程序化断言（无单测插件的补位回归面） | 十应用全量（2026-10-26-01） | UI 交付 |

类型闸与静态检查（提交闸门，与测试同级）：`vue-tsc -b --noEmit`（0 error）、`eslint`（0 error）。

E2E 运行形态（以 `frontend/playwright.config.ts` 为准）：`baseURL` 指向本地 dev server `http://localhost:5199`；每轮归档目录由运行时 `--output` 指定（config 默认 outputDir 为历史批次的固定路径，仅作兜底）。

## 2. 范围（测什么）

### 2.1 宿主 SPA（frontend/src，131 文件）

| 域 | 目录 | 用例文件数 | 覆盖重点 |
|---|---|---|---|
| SDK 协议 | `src/sdk/__tests__` + `src/sdk/s3/__tests__` | 11 | bus 双闸/信封/reply-by-id/错误码、命令面板、S3 datasource、版本管理/分片列表、SigV4 签名与 extraQuery |
| 文件管理面 | `src/files/__tests__` | 30 | 预览生命周期、多 tab、下载队列、搜索、mem 通路、上传队列+断点续传 checkpoint、回收站命令、历史版本面板、分享信封加密/对话框、在线解压 zip/zip-reader、树存储（含回收站）、快捷键、状态栏 |
| 内置应用 | `src/apps/__tests__` + `src/apps/renderers/__tests__` | 22 | 内置应用注册表、各渲染器（code/flow/xlsx/pdf/csv/docx/media/heic/mermaid/html/zip 浏览器…）、统一编辑工具栏接线 |
| UI 组件库 | `src/components/sdk/**` | 43 | Fc* 组件（display 8 / overlay 6 / layout 8 / navigation 5 / form 5 / section 2 / theme 2 / utils 3 / 根 smoke+barrels 4） |
| 工作台/路由/壳 | `src/views`（含 `views/share`）、`src/router`、`src/store`、`src/__tests__` | 8 | Home 工作台编排（上传弹窗确认/关窗/重开链路）、分享公开校验页、路由、全局 store、启动 |
| 平台杂项 | `src/api`、`src/composables`、`src/config`、`src/utils`、`src/plugins`（样例契约）、`src/shared` | 15 | 错误处理/notify/幂等提交、组合式函数、特性开关、工具函数、examples 插件按样例契约可装载、统一编辑工具栏 + 协议漂移哨兵 |
| 客户端包 | `packages/files-client/src/__tests__` | 2 | postMessage 宿主核心全链（core）、Vue 组合式层（vue） |

### 2.2 动态插件（frontend/plugins/*，11 文件）

| 插件 | 用例文件数 | 覆盖重点 | 无单测补位手段 |
|---|---|---|---|
| markdown-editor | 3 | 三形态/options 通道/保存链/统一工具栏 | — |
| html-editor | 4 | 沙箱净化/find/inline/options | — |
| artplayer-player | 2 | 断流重连/video:error 计次 | — |
| filerobot-image-editor | 1 | 保存二段流 | — |
| pptx-viewer | 1 | 渲染桩 | — |
| univer-office / pdf-annotator | 0 | — | **实机截图取证**（E2E 脚本断言） |

## 3. 覆盖率门禁

- 全局行覆盖 **≥80%**（`frontend/vitest.config.ts` coverage.thresholds，v1.2.0 起生效；v1.3.0 时点实测 81%+）
- 口径：`include` src/** 的 .ts/.vue；`exclude` 测试文件、`*.d.ts`、`types.ts`、`src/layout/**`（已归档 scaffold 死代码）
- `pnpm test:coverage` 出报告；阈值不达即测试失败

## 4. 不测什么（边界）

- S3/MinIO 服务端行为（外部依赖；联调环境见部署手册）
- 真实 STS 签发链路（宿主后端职责）
- 跨浏览器矩阵（仅 Chromium；Safari/Firefox 已知不支持 File System Access API）

## 5. 通过标准

- L1：0 失败（1 条既有 skip）；行覆盖 ≥80%；vue-tsc/eslint 0 error
- L2：断言全过 + 零 pageerror；截图与断言归档批次目录
- 回归红线：单测覆盖不到的插件（univer/pdf-annotator）UI 交付必须过 L3 实机取证

## 6. 已知质量地雷（测试设计输入）

- pnpm lockfile 重写慢性病（插件 standalone 安装向上重写根锁）
- Monaco worker 按 label 分发（workerId 恒 workerMain.js）
- 插件无单测者（univer/pdf-annotator）改 UI 必须实机验证
- Playwright 默认 dismiss confirm；html-editor 离态有自定义确认条需显式应答
- E2E 树行定位须锚 `.tree-panel [data-testid="row"]`（防命中已开 tab 同名标题）
- el-dialog 开合过渡 ~300ms 且 jsdom 需真实时钟（fake timers 不可用）；默认关闭=v-show 隐藏，断言用 `isVisible()`

详细用例清单见 [test-cases.md](test-cases.md)；最近一轮结果见 [test-report-v1.3.0.md](test-report-v1.3.0.md)。
