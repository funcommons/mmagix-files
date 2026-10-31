# 测试报告（v1.3.0 · 当前基线）

- 测试日期：2026-10-31（v1.3.0 发版当日全量复跑）
- 被测版本：main @ v1.3.0（tag，提交 `ecb8a960`）
- 环境：macOS / pnpm / Vitest + jsdom / Chromium（Playwright）

## 1. 被测面

| 能力 | 主套件 |
|---|---|
| 上传确认弹窗（三入口统一/拖放点选多文件/确认即关窗编排） | ui/upload-dialog + views/home-upload-dialog（集成） |
| 传输中心并入弹窗（上传｜传输双 Tab） | 同上（集成例覆盖确认→关窗→重开落传输页签时间轴） |
| 回收站/历史版本能力门控 | detectVersionCapable 探测（setup/tree-store 套件） |
| 历史版本恢复/指定版本下载 | version-panel + sdk/s3 client-versioning（copy-source `?versionId`） |

## 2. 结果总览

| 层 | 结果 | 判定 |
|---|---|---|
| L1 单元测试 | **1828 通过 / 0 失败 / 1 既有跳过**（142 文件） | ✅ |
| 行覆盖门禁 | 全局 lines ≥80% | ✅（阈值见 `vitest.config.ts`） |
| 类型闸 vue-tsc / eslint | 0 error | ✅ |
| E2E | 弹窗流两轮共 12 处适配（wb-02/04/05/08、up-04 等：先开弹窗/传输页签再断言）；既有 12 spec 全通过 | ✅ |

## 3. 关键集成例（home-upload-dialog.test.ts）

- 确认 → 先关窗（el-dialog 过渡真实时钟 380ms 可观察）→ enqueue(files, 当前目录) → 成功开始（accepted>0）→ 重开弹窗落「传输」页签
- 全部被拒（accepted=0）→ 弹窗保持关门（destroy-on-close 已卸内容，不空开传输页）

## 4. 证据

- 单测套件与代码同目录；E2E 既有批次（最近 2026-10-27-01）
- 交付口径见 [delivery-checklist-v1.3.0.md](../releases/delivery-checklist-v1.3.0.md)
