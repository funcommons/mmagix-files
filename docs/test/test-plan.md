# 测试计划

> 项目：mmagix-files（纯前端 S3 文件管理器）· 适用 v1.1.x · 以代码为唯一事实源（测试与代码同仓库同目录）

## 1. 测试策略与分层

| 层 | 载体 | 规模（v1.1.0 实测） | 触发 |
|---|---|---|---|
| L1 单元测试 | Vitest + jsdom；测试与被测同目录 `__tests__/` | 98 文件 / 1436 通过 + 1 跳过 | 每次提交前全量 |
| L2 端到端（E2E） | Playwright（Chromium），脚本+截图证据归档 `test-report/<日期-批次>/` | 8 个历史批次 | 功能交付/回归 |
| L3 实机截图取证 | Playwright 截图 + 程序化断言（无单测插件的补位回归面） | 十应用全量（2026-10-26-01） | UI 交付 |

类型闸与静态检查（提交闸门，与测试同级）：`vue-tsc -b --noEmit`（0 error）、`eslint`（0 error）。

## 2. 范围（测什么）

### 2.1 宿主 SPA（frontend/src）

| 域 | 目录 | 用例文件数 | 覆盖重点 |
|---|---|---|---|
| SDK 协议 | `src/sdk/__tests__` | 7 | bus 双闸/信封/reply-by-id/错误码、S3 datasource、命令面板 |
| 文件管理面 | `src/files/__tests__` | 19 | 预览生命周期（dispose/beforeDispose/错误边界）、下载队列、搜索、mem 通路、格式化 |
| 内置应用 | `src/apps/__tests__` + `src/apps/renderers/__tests__` | 19 | 内置应用注册表（13 应用）、各渲染器（code/flow/xlsx/pdf/csv/docx/media/heic/mermaid/html…）、统一编辑工具栏 |
| UI 组件库 | `src/components/sdk/**` | 30 | Fc* 组件（display/overlay/layout/navigation/form） |
| 客户端包 | `packages/files-client/src/__tests__` + `src/shared/__tests__` | 5 | postMessage 宿主核心全链、Vue 组合式层、协议漂移哨兵 |
| 插件样例 | `src/plugins/__tests__` | 2 | examples 插件按样例契约可装载 |

### 2.2 动态插件（frontend/plugins/*）

| 插件 | 用例文件数 | 覆盖重点 | 无单测补位手段 |
|---|---|---|---|
| markdown-editor | 3 | 三形态/options 通道/保存链/统一工具栏 | — |
| html-editor | 4 | 沙箱净化/find/inline/options | — |
| artplayer-player | 2 | 断流重连/video:error 计次 | — |
| filerobot-image-editor | 1 | 保存二段流 | — |
| pptx-viewer | 1 | 渲染桩 | — |
| univer-office / pdf-annotator | 0 | — | **实机截图取证**（E2E 脚本断言） |

## 3. 不测什么（边界）

- S3/MinIO 服务端行为（外部依赖；联调环境为 localhost:9000 + bucket mmagic-demo）
- 真实 STS 签发链路（宿主后端职责）
- 跨浏览器矩阵（仅 Chromium；Safari/Firefox 已知不支持 File System Access API）

## 4. 通过标准

- L1：0 失败（1 条既有 skip）；vue-tsc/eslint 0 error
- L2：断言全过 + 零 pageerror；截图与断言归档
- 回归红线：单测覆盖不到的插件（univer/pdf-annotator）UI 交付必须过 L3 实机取证

## 5. 已知质量地雷（测试设计输入）

- pnpm lockfile 重写慢性病（插件 standalone 安装向上重写根锁）
- Monaco worker 按 label 分发（workerId 恒 workerMain.js）
- 插件无单测者（univer/pdf-annotator）改 UI 必须实机验证
- Playwright 默认 dismiss confirm；html-editor 离态有自定义确认条需显式应答
- E2E 树行定位须锚 `.tree-panel [data-testid="row"]`（防命中已开 tab 同名标题）

详细用例清单见 [test-cases.md](test-cases.md)；最近一轮结果见 [test-report-v1.1.0.md](test-report-v1.1.0.md)。
