# mmagix-files

**纯前端 S3 文件管理器**——以 iframe 嵌入任意业务前端：对象存储桶的浏览/上传/下载/多应用预览与编辑，
一套 postMessage 协议接入。凭证不出宿主，服务端零侵入（S3/MinIO 直连）。

- 内置 14 类文件应用（代码/Monaco、xlsx 样式表、docx、PDF、Markdown、流程图/脑图/时序图/架构图编辑、CSV、HTML 沙箱预览、HEIC、音视频、zip 在线解压…）
- 7 个官方动态插件（Univer 办公编辑 · PDF 标注签批 · Markdown/HTML 编辑器 · 媒体增强 · 图片编辑 · PPTX 预览），SRI 自校验、按需装载
- 安全网三件套：回收站（DeleteMarker 恢复）· 历史版本（copy-source 恢复，桶能力门控）· 信封分享（密码 PBKDF2+AES-GCM）
- 断点续传（>16MB 分片，跨会话恢复）+ 传输中心（暂停/继续/重试）
- 可编辑应用统一 `[保存｜撤销 重做 重置]` 工具栏，dirty=保存钮红点
- 宿主接入：npm 包 [`@mmagix/files-client`](frontend/packages/files-client/)（核心 + Vue 双入口，零依赖）
- 明暗/多品牌主题随宿主 · 中英双语 · 明暗下统一编辑体验

## 三步接入

```bash
npm install @mmagix/files-client
```

```ts
import { useMmagixFilesClient } from "@mmagix/files-client/vue"; // Vue 3；非 Vue 用核心入口

const { iframeRef, mount, call, on } = useMmagixFilesClient();
await mount(workspaceConfig, "https://your-files-app/"); // 等 evt ready（宿主 origin 自动入白名单）
await call("navigate", { path: "/reports" });
on("fileOpened", (p) => console.log(p));
```

可运行示例：`mmagix-embed-demo/`（`pnpm dev` → http://localhost:5200）。

## 快速开发

```bash
pnpm install
cd frontend && pnpm dev --port 5199 --strictPort   # SPA（iframe 侧）
cd mmagix-embed-demo && pnpm dev                    # 宿主 demo（5200，跨源联调形态）
```

构建/测试/部署细节见 [docs/operations/deployment.md](docs/operations/deployment.md)。

## 文档

| 类 | 入口 |
|---|---|
| 文档索引 | [docs/README.md](docs/README.md) |
| 需求（PRD） | [docs/product/PRD.md](docs/product/PRD.md) |
| 架构（概要设计） | [docs/design/architecture.md](docs/design/architecture.md) |
| 接口（JSSDK 协议） | [docs/design/jsdk-api.md](docs/design/jsdk-api.md) |
| 测试（计划/用例/报告） | [docs/test/](docs/test/) |
| 部署手册 | [docs/operations/deployment.md](docs/operations/deployment.md) |
| 用户手册 | [docs/operations/user-guide.md](docs/operations/user-guide.md) |
| 发布与交付 | [docs/releases/](docs/releases/) |

## 参与

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)（含契约同步红线与已知地雷）
- 安全披露：[SECURITY.md](SECURITY.md)（请勿公开 issue 报漏洞）
- 变更历史：[CHANGELOG.md](CHANGELOG.md) · 许可：[LICENSE](LICENSE)（MIT；pptx-preview 组件例外见内注）

## 发布物清单

| 物 | 位置 | 说明 |
|---|---|---|
| 整站构建 | `frontend/` → `pnpm build` | 部署到任意静态托管 |
| 插件 bundle | `frontend/public/plugins/*.js`（7 个） | 懒加载，SRI 清单见 [docs/releases/v1.1.0-plugin-sri.json](docs/releases/v1.1.0-plugin-sri.json)（7/7 与当前产物一致；重建插件后重出） |
| 宿主侧客户端 | npm 包 [@mmagix/files-client](frontend/packages/files-client/)（Vue 入口 `/vue`） | 零依赖 postMessage 封装；demo 经 vite alias 消费同一份源码 |
