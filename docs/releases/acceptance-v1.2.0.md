# 验收报告（v1.2.0）

- 验收日期：2026-10-31（发版后复验） · 被验物：[交付清单](delivery-checklist-v1.2.0.md) 全部条目
- 验收依据：CHANGELOG [1.2.0] 承诺项 × 实际代码/行为（以代码运行为准，逐条可复现）

## 一、验收结论

**通过（1 项记录偏差）。** 四能力与底座全部落地；ShareAccess 公开校验页存在未挂路由的交付缺口，记为偏差并列入遗留。

## 二、逐项验收

| # | 验收项 | 验收标准 | 方法 | 结果 |
|---|---|---|---|---|
| 1 | 断点续传 | createMultipart 后 checkpoint 落 IDB；指纹+partSize 双校验；单片间隔制退避；孤儿 uploadId 7 天清理 | 单测（upload-queue-checkpoint/checkpoint-store/orphan-sweeper） | ✅ |
| 2 | 回收站 | 恢复=删 latest DeleteMarker；purge 逐 key 复验 latestIsMarker；TrashPanel 抽屉 + restore/purge 命令 | 单测（tree-store-trash/commands-trash/trash-panel） | ✅ |
| 3 | 在线解压 | zip-reader 纯函数解析（EOCD/zip64/GBK/zip slip/炸弹三闸）；ZipBrowser 解出接 multipart 队列 | 单测（zip-reader/zip/zip-browser） | ✅ |
| 4 | 分享信封 | AES-GCM(PBKDF2(密码)) 包裹预签名 URL；零手写密码学；ShareDialog 密码/四档有效期/管理台 | 单测（share-crypto/share-dialog/share-dialog-v2） | ✅ |
| 5 | ShareAccess 公开校验页 | 组件+防暴破锁+回灌守卫（单测过） | 路由/入口核查：**未挂载**（router 无条目，仅测试引用） | ⚠️ 偏差（组件过、入口缺） |
| 6 | 宿主客户端包 | 独立包+漂移哨兵双侧比对 | 单测 21 例 + clientProtocol 哨兵 | ✅ |
| 7 | flow 四方言 | mindmap/sequence/architecture 进 X6 编辑；raw 优先序列化 | 单测（flow-editor 19 声明）+ E2E 取证（2026-10-27-01） | ✅ |
| 8 | 覆盖率门禁 | 全局 lines ≥80 | vitest thresholds + 实测 81.06% | ✅ |
| 9 | 协议兼容 | 纯增量（+restore/purge），v1.1 接入方无感 | 协议常量零变更（哨兵绿） | ✅ |
| 10 | 质量闸 | 单测 0 失败；vue-tsc/eslint 0 error | 全量执行（1814/0，发版时点） | ✅ |

## 三、记录偏差与例外

1. **ShareAccess 公开校验页未挂路由**：组件与单测齐备，但 `router/` 无条目、无入口——带密码分享链接暂无站内解锁页（消费方需宿主侧自行解锁或待后续版本接线）。

## 四、遗留与后续

| 项 | 去向 |
|---|---|
| ShareAccess 路由接线 | 后续版本 P0 候选 |
| ListParts（服务端分片列举） | 路线裁决：IDB checkpoint 已覆盖续传面，维持不实现 |
| univer/pdf-annotator 补单测 | 沿袭 v1.1.0 遗留（实机取证兜底） |

## 五、签字

| 角色 | 状态 |
|---|---|
| 开发自验 | ✅ 2026-10-29（TDD 全程账见 capabilities-contract-v1.2.0.md） |
| 验收复核 | ✅ 2026-10-31 本报告逐项可复现 |
