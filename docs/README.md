# mmagix-files 文档索引

> 文档与代码同源演化：**以代码为唯一事实源**，发现不一致视为 bug（欢迎 PR）。
> 契约类文档在代码中有「正本」注释互相锚定（如 `sdk/constants.ts` ↔ jsdk-api.md）。

## 产品

| 文档 | 内容 |
|---|---|
| [PRD](product/PRD.md) | 需求规格：产品定位、用户/场景、功能需求清单（含实现状态）、非功能需求、边界 |

## 设计

| 文档 | 内容 |
|---|---|
| [架构 · 概要设计](design/architecture.md) | 系统构成、目录职责、关键设计决策 D1–D9、质量属性 |
| [总体方案（裁决档案）](design/solution-design.md) | V1.2 总体方案全文+实施偏差注记（架构现状以 architecture.md 为准） |
| [JSSDK 接口设计](design/jsdk-api.md) | postMessage 协议正本：信封/握手/命令/事件/错误码（代码锚：`frontend/src/sdk/`） |
| [插件体系](design/plugin-system.md) | PluginEntry 契约、装载链（SRI/lazy）、生命周期 |
| [插件样例](design/plugin-sample.md) | 可运行样例（examples/plugins/*.js，有单测护航） |
| [样式隔离](design/style-isolation.md) | 应用打开防样式污染机制 |
| [流程图编辑器设计](design/flow-editor-design.md) | mermaid graph TD 子集 + X6（含 v2 适配 DEF 修复记录） |
| [图示类路线图](design/diagram-roadmap.md) | 脑图/时序图/架构图——**规划**（未实现，见文中状态标注） |

## 插件设计（frontend/plugins/*）

| 文档 | 插件 |
|---|---|
| [univer-office](design/plugin-system.md) | xlsx/xls/docx 编辑（并入插件体系文档） |
| [pdf-annotator](plugins/pdf-annotator.md) | PDF 标注/签批/签名/压平写回 |
| [markdown-editor](plugins/markdown-editor.md) | 三形态 Markdown 编辑 |
| [html-editor](plugins/html-editor.md) | 三态 HTML 编辑 + 单体化 |
| [artplayer](plugins/artplayer.md) | 媒体播放增强（断流重连） |
| [filerobot-image-editor](plugins/filerobot-image-editor.md) | 图片编辑 |

## 开发

| 文档 | 内容 |
|---|---|
| [贡献指南（根目录）](../CONTRIBUTING.md) | 流程/闸门/契约同步红线/已知地雷 |
| [code-editor 升级建议](develop/code-editor-upgrade.md) | P1 已落地/P1-2 已证伪关闭/P2·P3 待办（roadmap） |

## 测试

| 文档 | 内容 |
|---|---|
| [测试计划](test/test-plan.md) | 分层策略（单测/E2E/实机取证）、范围、通过标准、质量地雷 |
| [测试用例清单](test/test-cases.md) | 套件级映射（98 文件/1436 例 → 覆盖域） |
| [测试报告 v1.1.0](test/test-report-v1.1.0.md) | 结果/缺陷/遗留风险；原始证据 `test-report/`（8 批次） |

## 运维

| 文档 | 内容 |
|---|---|
| [安装部署手册](operations/deployment.md) | 拓扑、本地跑通、生产部署、S3 要求、健康检查 |
| [用户手册](operations/user-guide.md) | 界面操作：树/预览/上传下载/搜索/命令面板/快捷键/插件开关 |

## 发布

| 文档 | 内容 |
|---|---|
| [CHANGELOG（根目录）](../CHANGELOG.md) | 全版本变更（Keep a Changelog） |
| [交付清单 v1.1.0](releases/delivery-checklist-v1.1.0.md) | 交付物/质量证据/已知边界 |
| [验收报告 v1.1.0](releases/acceptance-v1.1.0.md) | 逐项验收（承诺×实际） |
| [SRI 清单](releases/) | v1.0.0 / v1.1.0 插件 sha384（已实测与 dist 一致） |

## 根目录

[README](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md) · [LICENSE](../LICENSE) · [CHANGELOG](../CHANGELOG.md)

## 文档治理变更清单（2026-10-26）

| 动作 | 文件 | 去向/理由 |
|---|---|---|
| 合并退役 | documents/产品顶层设计.md、documents/第一期文件类型支持计划.md | → [PRD](product/PRD.md)（两篇与代码双向漂移共 13 点，按 v1.1.0 现状收口；正本注释同步改指 PRD） |
| 改名迁移 | documents/JSSDK 接口文档.md 等 13 篇 | → docs/design|plugins|develop|operations（英文蛇形命名，GitHub 惯例） |
| 保留加注 | solution-design / plugin-system / plugin-sample / artplayer / filerobot / markdown-editor / html-editor / pdf-annotator / flow-editor-design / style-isolation / diagram-roadmap | 各篇头部增「实施状态注记」（审计偏差逐条落账，未实现项显式标注不删除） |
| 归档封存 | frontend/PROGRESS.md | → test-report/PROGRESS-2026-10-10-archived.md（/loop 过程锚点，任务已完结；3 处代码注释改指档案） |
| 新增 | product/PRD、design/architecture、test/test-plan·test-cases·test-report-v1.1.0、operations/deployment、releases/delivery-checklist·acceptance、docs/README（本索引） | 对齐开源项目文档结构 + CMMI 文档要素（需求/设计/测试/部署/发布交付验收） |
| 新增（根目录） | LICENSE（MIT）、SECURITY.md、CONTRIBUTING.md | GitHub 标准社区文档 |
| 全局 | 23 处代码注释/测试头注的 documents/ 引用改指新路径；267 条 md 链接全量扫描 0 死链 |
