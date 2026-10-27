# 验收报告（v1.1.0）

- 验收日期：2026-10-26 · 被验物：[交付清单](delivery-checklist-v1.1.0.md) 全部条目
- 验收依据：CHANGELOG [1.1.0] 承诺项 × 实际行为（以代码运行为准，逐条可复现）

## 一、验收结论

**通过。** 承诺项全部兑现，1 项记录偏差（filerobot，事先声明的「尽量做到」口径），1 项 P0 缺陷在验收期内发现并修复复验。

## 二、逐项验收

| # | 验收项 | 验收标准 | 方法 | 结果 |
|---|---|---|---|---|
| 1 | 统一编辑工具栏 | 十个可编辑面左上角同款 `[保存｜撤销 重做 重置]` 簇；dirty=保存钮红点；无「未保存」文字 | 单测（editToolbar/code/flow/md/html 137 例）+ E2E 12/12 + 截图取证 shot-{code,flow,md,html-source,html-wysiwyg,univer,univer-xlsx,pdf}-bar.png | ✅ |
| 2 | 重置语义 | 恢复打开时内容；入 undo 栈可反悔；干净态禁用；保存后基线翻空（pdf） | code/flow/pdf 实现审查 + 单测 + E2E | ✅ |
| 3 | html-editor 预览态簇隐藏 | preview 态 readonly=true（簇不可见） | 截图取证程序化断言 | ✅ |
| 4 | univer-office 簇 | FUniver undo/redo 可用；重置=原字节重挂；saving/dirty 双闸 | docx+xlsx 双档截图 + dirty 断言 | ✅ |
| 5 | pdf-annotator | 重做（栈对偶）+基线重置；**无渲染崩溃**（验收期发现 TDZ P0 → 修复复验） | E2E 画矩形→红点断言（复测通过） | ✅（修复后） |
| 6 | html-viewer 内置应用 | html/htm 默认净化预览；跳转代理确认后新 tab | E2E（2026-10-22 批次，popup 实证） | ✅ |
| 7 | 协议兼容 | v1.0.0 接入方无感升级 | 协议常量零变更（漂移哨兵绿） | ✅ |
| 8 | 客户端包 | demo 经包源码实机跑通（装载→ready→getInfo） | 实机 smoke + 单测 21 例 + 漂移哨兵 | ✅ |
| 9 | doc/ppt 兜底提示 | 文件名+原因+转存建议+下载钮；未知类型保持泛化 | preview 套件 49 例 + E2E 实拍 | ✅ |
| 10 | 质量闸 | 单测 0 失败；vue-tsc/eslint 0 error | 全量执行（1436/0） | ✅ |

## 三、记录偏差与例外

1. **filerobot-image-editor** 不叠加自建簇（第三方内核自带同款四钮且已居左）——任务口径「尽量做到」内的事先声明偏差，截图存档（shot-filerobot-full.png）。
2. eslint 15 条存量 warning（`local/prefer-fc-button`）不在本版整改范围。

## 四、遗留与后续

| 项 | 去向 |
|---|---|
| univer/pdf-annotator 补单测 | 后续版本（当前以实机取证兜底） |
| pptx 高保真路线（LibreOffice 转 PDF） | 未部署，见 PRD 边界 |
| demo 站外网部署 | 待运维目标确定 |

## 五、签字

| 角色 | 状态 |
|---|---|
| 开发自验 | ✅ 2026-10-26（证据见 test-report/2026-10-26-01） |
| 验收复核 | ✅ 本报告逐项可复现 |
