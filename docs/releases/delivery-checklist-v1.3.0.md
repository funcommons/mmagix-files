# 交付清单（v1.3.0）

- 发布日期：2026-10-31 · Tag：`v1.3.0` · 提交：`ecb8a960`（版本 bump+构建链修复；功能段 `61a64536`/`ef3cd902`/`9da1ca28`）

## 交付物

| # | 物 | 位置 | 说明 |
|---|---|---|---|
| 1 | SPA 构建产物 | `frontend/` → `pnpm build` → `dist/` | 静态托管；history 路由需 try_files 兜底 |
| 2 | 插件 bundle ×7 | `frontend/public/plugins/*.js` | 本版未重建（与 v1.1.0/v1.2.0 同批产物） |
| 3 | SRI 清单 | 沿用 [`v1.1.0-plugin-sri.json`](v1.1.0-plugin-sri.json) | 7/7 与本版产物实测一致（2026-10-31） |
| 4 | 宿主客户端包 | `frontend/packages/files-client/` | 三包版本同步 1.3.0 |
| 5 | 文档集 | `docs/` | 测试报告 v1.2.0/v1.3.0、交付清单/验收报告 ×2 新增 |

## 版本内容摘要（详见 CHANGELOG [1.3.0]）

- 上传确认弹窗（三入口统一：树头钮/行右键/空白右键；目标目录+拖放点选多文件+确认才入队）
- 传输中心并入弹窗（上传｜传输双 Tab）；底部悬浮传输面板退役；确认即关窗→成功入队重开落传输页签
- 历史版本管理（右键→VersionPanel 抽屉：恢复=copy-source `?versionId`、指定版本下载）
- 版本能力门控（无 listObjectVersions 能力时回收站/历史版本整入口隐藏）
- 传输面板 ✕=整面板关闭+顶缘拖高；mkdir 完整路径实时预览
- 协议零破坏性变更

## 质量证据

- 单测 1828 通过 / 0 失败（142 文件）；行覆盖门禁达标；vue-tsc / eslint 0 error
- E2E 弹窗流 12 处适配；详见 [test-report-v1.3.0.md](../test/test-report-v1.3.0.md)

## 已知边界（随版交付）

- v1.2.0 遗留沿袭：ShareAccess 未挂路由；ListParts 不实现
- el-dialog 弹窗在 jsdom 测试需真实时钟（工程侧已知项，不影响产品）
