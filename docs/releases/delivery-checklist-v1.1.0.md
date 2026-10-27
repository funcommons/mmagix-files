# 交付清单（v1.1.0）

- 发布日期：2026-10-26 · Tag：`v1.1.0` · 提交：`c984734a`（后续修复 `d8d516aa`、`949b8c3f`、`c1ecbc19` 归 [Unreleased]）
- Release Notes：https://github.com/funcommons/mmagix-files/releases/tag/v1.1.0

## 交付物

| # | 物 | 位置 | 说明 |
|---|---|---|---|
| 1 | SPA 构建产物 | `frontend/` → `pnpm build` → `dist/` | 静态托管；history 路由需 try_files 兜底 |
| 2 | 插件 bundle ×7 | `frontend/public/plugins/*.js` | markdown-editor / html-editor / univer-office / pdf-annotator（本版重建）+ artplayer / filerobot / pptx-viewer（未变） |
| 3 | SRI 清单 | [`v1.1.0-plugin-sri.json`](v1.1.0-plugin-sri.json) | 7 插件 sha384；4 包 hash 更新、3 包与 v1.0.0 一致（佐证仅触碰面重建） |
| 4 | 宿主客户端包 | `frontend/packages/files-client/` | `@mmagix/files-client`（ESM+d.ts；`npm publish` 待执行） |
| 5 | 文档集 | `docs/` | 索引 docs/README.md；PRD/概要设计/接口/插件/测试三件套/部署手册/用户手册 |

## 版本内容摘要（详见 CHANGELOG [1.1.0]）

- 统一编辑工具栏（十应用 `[保存｜撤销 重做 重置]` 簇 + dirty 红点，样式唯源 shared/editToolbar）
- 内置应用 html-viewer（净化沙箱预览 + 跳转代理）
- 修复 pdf-annotator TDZ 渲染崩溃
- 协议零破坏性变更（v1.0.0 接入方升级无感）

## 质量证据

- 单测 1436 通过 / 0 失败（98 文件）；vue-tsc / eslint 0 error
- E2E 12/12 + 十应用截图取证（`test-report/2026-10-26-01/`）
- 详见 [test-report-v1.1.0.md](../test/test-report-v1.1.0.md)

## 已知边界（随版交付）

- pptx 保真中上（SmartArt/艺术字有损）；旧 .doc/.ppt 不支持在线预览（有定向转存提示）
- Safari/Firefox 不支持 File System Access API
- filerobot 插件保持第三方内核自带工具栏（统一工具栏「尽量做到」口径的记录偏差）
