# 测试报告（v1.1.0）

- 测试日期：2026-10-19 ~ 2026-10-26（多批次）
- 被测版本：main @ v1.1.0（tag），含 c1ecbc19（doc/ppt 兜底提示）
- 环境：macOS / Node 26 / pnpm 11.24 / Chromium（Playwright）；MinIO localhost:9000 + bucket mmagic-demo

## 1. 结果总览

| 层 | 结果 | 判定 |
|---|---|---|
| L1 单元测试 | **1436 通过 / 0 失败 / 1 跳过**（98 文件） | ✅ |
| 类型闸 vue-tsc | 0 error（frontend 与 demo 双侧） | ✅ |
| eslint | 0 error（15 条存量 warning，`local/prefer-fc-button`，均为存量文件） | ✅ |
| L2 E2E（2026-10-26-01） | 统一工具栏 **12/12**（code+flow：红点/无「未保存」/重置自锁/保存链/历史联动） | ✅ |
| L3 实机截图取证 | **10 可编辑面全过**（code/flow/md/html 三态/univer docx+xlsx/pdf/filerobot 偏差存档）+ doc 兜底提示 | ✅ |

## 2. 本版主要验证项

| 验证项 | 手段 | 结果 |
|---|---|---|
| 统一编辑工具栏（十应用簇样式统一、dirty=保存钮红点、「未保存」文字全废） | 单测（editToolbar 7 + code 44 + flow 16 + md 46 + html 24）+ E2E 12/12 + 十应用截图 | ✅ |
| 重置语义（恢复打开时内容、可撤销、干净态自锁） | code/flow 单测 + E2E | ✅ |
| html-editor 三态（源码/可视/预览——预览态整簇隐藏） | 单测 + 截图（readonly=true 程序化断言） | ✅ |
| 客户端包 @mmagix/files-client | 单测 21 例（消息泵全链）+ 协议漂移哨兵 3 例 + demo 实机（装载→ready→getInfo ✓） | ✅ |
| doc/ppt 兜底定向提示 | preview 套件 49 例 + E2E 实拍（shot-doc-fallback.png） | ✅ |
| 回归抓获：pdf-annotator TDZ 渲染崩溃 | 十应用截图取证发现 → 声明前置修复 → 重建复测通过 | ✅（已修） |

## 3. 缺陷与处理

| # | 缺陷 | 严重度 | 状态 |
|---|---|---|---|
| 1 | pdf-annotator 打开即崩（统一钮簇接线 `saving` TDZ，minified `Cannot access 'Xe'`） | P0 | ✅ 已修（d8d516aa）；教训沉淀 CONTRIBUTING「已知地雷」 |
| 2 | eslint 15 条存量 warning（`local/prefer-fc-button`） | P3 | 开放（不在本版范围） |

## 4. 遗留风险

- univer-office / pdf-annotator 无单元测试（0 文件）——依赖 L3 实机取证兜底；补测试列入后续计划
- Safari/Firefox 未纳入 E2E 矩阵（File System Access API 不支持属已知边界）
- pptx 保真中上（SmartArt/艺术字有损；高保真路线 LibreOffice 转 PDF 未部署）

## 5. 证据归档

`test-report/`（8 批次）：2026-10-09-01/02、10-13-01、10-18-01、10-19-01、10-20-01、10-21-01、**10-26-01**（本版主战场：E2E 脚本 + 截图 + 断言输出）。
