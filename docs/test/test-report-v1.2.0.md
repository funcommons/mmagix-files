# 测试报告（v1.2.0）

> 历史报告（v1.2.0 时点）；当前基线见 [test-report-v1.3.0.md](test-report-v1.3.0.md)

- 测试日期：2026-10-27 ~ 2026-10-29（随四能力 TDD 流水收口）
- 被测版本：main @ v1.2.0（tag，提交 `a935afa6`）
- 环境：macOS / pnpm / Vitest + jsdom；覆盖门禁 `vitest run --coverage.enabled`

## 1. 被测面（四大能力 + 底座）

| 能力 | 主套件（src/files/__tests__ 等） |
|---|---|
| 断点续传 | upload-queue-checkpoint / checkpoint-store / orphan-sweeper |
| 回收站 | commands-trash / tree-store-trash / trash-panel |
| 在线解压 | zip-reader / zip / zip-browser（apps） |
| 分享信封 | share-crypto / share-dialog / share-dialog-v2 / share-access（views） |
| 底座 | sdk/s3：client-versioning、sigv4-extraquery 等版本/分片方法 |

## 2. 结果总览

| 层 | 结果 | 判定 |
|---|---|---|
| L1 单元测试 | **1814 通过 / 0 失败**（+215 例） | ✅ |
| 行覆盖门禁 | **全局 lines ≥80% 达标（实测 81.06%）** | ✅ |
| 类型闸 vue-tsc / eslint | 0 error | ✅ |

## 3. 过程质量记录（发版提交 `a935afa6` 全程账）

- 全程 TDD 红先绿后（69 任务单一职责子代理流水）
- 评审轮前置消灭 3 个 P0 级隐患：zip 炸弹闸伪造 CD 绕过 / KDF 无下限 / zip 兜底覆写源文件
- 7 处测试自身缺陷实证后退回作者修正

## 4. 证据

- 单测套件即证据（与代码同目录）；E2E 本版无新增批次（能力面以单测收口，最近批次 2026-10-27-01 为 flow-editor 方言取证）
- 交付口径见 [delivery-checklist-v1.2.0.md](../releases/delivery-checklist-v1.2.0.md)
