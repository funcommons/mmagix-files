# 交付清单（v1.2.0）

- 发布日期：2026-10-29 · Tag：`v1.2.0` · 提交：`a935afa6`（四能力收官；版本段内含 `949b8c3f` 客户端包、`1da183ff`/`7cb00bd1` flow 四方言、`c1ecbc19` doc/ppt 兜底、`6b225b41` 覆盖率门禁）

## 交付物

| # | 物 | 位置 | 说明 |
|---|---|---|---|
| 1 | SPA 构建产物 | `frontend/` → `pnpm build` → `dist/` | 静态托管；history 路由需 try_files 兜底 |
| 2 | 插件 bundle ×7 | `frontend/public/plugins/*.js` | 本版**未重建**（最后重建 2026-10-26，v1.1.0 版哈希持续有效） |
| 3 | SRI 清单 | 沿用 [`v1.1.0-plugin-sri.json`](v1.1.0-plugin-sri.json) | 7/7 与本版产物实测一致（2026-10-31 复验） |
| 4 | 宿主客户端包 | `frontend/packages/files-client/` | `@mmagix/files-client`（ESM+d.ts；`npm publish` 待执行） |
| 5 | 文档集 | `docs/` | 设计档案新增 `design/capabilities-design-v1.2.0.md`（方案）与 `design/capabilities-contract-v1.2.0.md`（契约+执行账） |

## 版本内容摘要（详见 CHANGELOG [1.2.0]）

- 四能力：断点续传（跨会话 IDB checkpoint）· 回收站（DeleteMarker 恢复+purge 复验）· 在线解压（zip-reader+ZipBrowser）· 分享信封（PBKDF2+AES-GCM 包裹预签名 URL）
- 宿主侧 npm 包 `@mmagix/files-client` 抽出；flow-editor 四方言全可编辑（mindmap/sequence/architecture 并入 X6）
- doc/ppt 下载兜底定向提示；全局行覆盖门禁 80% 生效
- 协议零破坏性变更（命令 +restore/purge，纯增）

## 质量证据

- 单测 1814 通过 / 0 失败（+215 例）；全局行覆盖 81.06%（门禁 ≥80%）；vue-tsc / eslint 0 error
- 详见 [test-report-v1.2.0.md](../test/test-report-v1.2.0.md)

## 已知边界（随版交付）

- S3 子集无 ListParts（断点续传走 IDB checkpoint 路线，非服务端分片列举）
- ShareAccess 公开校验页组件已交付但**未挂路由**——带密码分享链接当前无站内解锁入口（见验收报告偏差项）
- 时序图/架构图 X6 呈现为图形态（非泳道/分组渲染），位置不持久化
