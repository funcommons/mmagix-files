# mmagix-files 文档索引

> 文档与代码同源演化：**以代码为唯一事实源**，发现不一致视为 bug（欢迎 PR）。
> 契约类文档在代码中有「正本」注释互相锚定（如 `sdk/constants.ts` ↔ jsdk-api.md）。

## 产品

| 文档 | 内容 |
|---|---|
| [PRD](product/PRD.md) | 需求规格：产品定位、用户/场景、功能需求清单 FR-1~17（含实现状态与代码锚）、非功能需求、边界（基线 v1.3.0） |
| [竞品对标 v1.3.0](product/competitive-analysis-v1.3.0.md) | TOP5 Star 同类项目功能大表 + 差异化结论 + 下一波升级建议（2026-10-31 调研） |

## 设计

| 文档 | 内容 |
|---|---|
| [架构 · 概要设计](design/architecture.md) | 系统构成、目录职责、关键设计决策 D1–D13、质量属性（v1.3.x） |
| [总体方案（裁决档案）](design/solution-design.md) | V1.2 时代总体方案全文+实施状态注记（架构现状以 architecture.md 为准） |
| [v1.2.0 四能力方案（档案）](design/capabilities-design-v1.2.0.md) | 断点续传/回收站/在线解压/信封分享的设计方案正本（代码注释「方案」锚点） |
| [v1.2.0 四能力契约（档案）](design/capabilities-contract-v1.2.0.md) | 同版 M1–M5 契约节+执行账（代码注释「契约」锚点） |
| [JSSDK 接口设计](design/jsdk-api.md) | postMessage 协议正本：信封/握手/命令 19 条/事件/错误码（代码锚：`frontend/src/sdk/`） |
| [插件体系](design/plugin-system.md) | PluginEntry 契约、装载链（fetch+sha384/lazy）、生命周期 |
| [插件样例](design/plugin-sample.md) | 可运行样例（examples/plugins/*.js，有单测护航） |
| [样式隔离](design/style-isolation.md) | 应用打开防样式污染机制（含 v1.3 现状盘点注记） |
| [流程图编辑器设计](design/flow-editor-design.md) | mermaid graph TD 子集 + X6（含 v2 适配 DEF 修复记录；四方言终态见注记 4） |
| [图示类路线图](design/diagram-roadmap.md) | 脑图/时序图/架构图——**四方言已全部落地 flow-editor**（头注=终态；独立应用规划节保留为选型档案） |

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
| [文档治理报告 2026-10-31](develop/doc-governance-2026-10-31.md) | 全仓逐文档审计表/目录树/文档模板/验证结果 |

## 测试

| 文档 | 内容 |
|---|---|
| [测试计划](test/test-plan.md) | 分层策略、范围（142 文件映射）、覆盖率门禁 ≥80%、通过标准、质量地雷 |
| [测试用例清单](test/test-cases.md) | 套件级映射（2026-10-31：142 文件/1828 例）+ E2E 批次索引 |
| [测试报告 v1.3.0（当前）](test/test-report-v1.3.0.md) | 当前基线：1828/0 + 门禁 + 集成例证据 |
| [测试报告 v1.2.0](test/test-report-v1.2.0.md) | 四能力 TDD 收口账（1814/0，lines 81.06%） |
| [测试报告 v1.1.0](test/test-report-v1.1.0.md) | 历史基线（1436/0）；原始证据 `test-report/`（11 批次） |

## 运维

| 文档 | 内容 |
|---|---|
| [安装部署手册](operations/deployment.md) | 拓扑、本地跑通、生产部署、S3 要求（含 Versioning 可选能力）、健康检查 |
| [用户手册](operations/user-guide.md) | 界面操作：树/上传弹窗/传输中心/回收站/历史版本/解压/分享信封/搜索/命令面板/快捷键 |

## 发布

| 文档 | 内容 |
|---|---|
| [CHANGELOG（根目录）](../CHANGELOG.md) | 全版本变更（Keep a Changelog） |
| [交付清单 v1.3.0](releases/delivery-checklist-v1.3.0.md) / [验收报告 v1.3.0](releases/acceptance-v1.3.0.md) | 当前版交付物/质量证据/验收结论 |
| [交付清单 v1.2.0](releases/delivery-checklist-v1.2.0.md) / [验收报告 v1.2.0](releases/acceptance-v1.2.0.md) | 四能力版（含 ShareAccess 未挂路由偏差记录） |
| [交付清单 v1.1.0](releases/delivery-checklist-v1.1.0.md) / [验收报告 v1.1.0](releases/acceptance-v1.1.0.md) | 历史版 |
| [SRI 清单](releases/v1.1.0-plugin-sri.json) | 7 插件 sha384（2026-10-31 实测与产物一致；重建插件后重出） |

## 根目录

[README](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md) · [LICENSE](../LICENSE) · [CHANGELOG](../CHANGELOG.md)

## 文档治理变更清单（2026-10-31）

| 动作 | 文件 | 去向/理由 |
|---|---|---|
| 迁移归档 | documents/v1.2.0升级方案 → [design/capabilities-design-v1.2.0.md](design/capabilities-design-v1.2.0.md)；documents/v1.2.0执行进度 → [design/capabilities-contract-v1.2.0.md](design/capabilities-contract-v1.2.0.md) | 四能力唯一设计/契约记录（17 处代码注释锚点同步改指新路径），不删；documents/ 目录退役 |
| 迁移 | documents/同类项目对比 v1.3.0 TOP5 → [product/competitive-analysis-v1.3.0.md](product/competitive-analysis-v1.3.0.md) | 产品/规划类文档归位 docs/product，英文蛇形命名 |
| 删除 | documents/同类项目对比与升级建议.md（2026-10-29 TOP3 版） | 已被 TOP5 版承接（承接声明见新文头注），内容不 再有独立参考价值 |
| 删除 | documents/releases/、mmagix-embed-demo/documents/（均空目录） | 空壳 |
| 补齐 | CHANGELOG [1.2.0]/[1.3.0] 段（原 Unreleased 内容确权入 v1.2.0）；测试报告 v1.2.0/v1.3.0；交付清单/验收报告 v1.2.0/v1.3.0 | v1.2.0/v1.3.0 发版未回写文档的欠账 |
| 更正 | architecture/jsdk-api/solution-design/plugin-system/plugin-sample/style-isolation/flow-editor-design/diagram-roadmap、PRD、部署/用户手册、test 计划/用例、SECURITY、根与子项目 README | 逐篇与代码比对修正（14 内置应用/命令 19 条/getApps payload/装载机制口径/行号与数字刷新等） |
| 全局 | 17 处代码注释 documents/ 死锚改指新路径（含 3 处 v1.1.0 治理漏改的 examples/plugins 锚） | 链接一致性 |

<!-- 治理史：2026-10-26 批次（合并退役两篇顶层设计、13 篇改名迁入 docs/、新增 LICENSE/SECURITY/CONTRIBUTING 等）见 git a04905f1 -->
