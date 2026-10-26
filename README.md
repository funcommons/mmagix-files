# mmagix-files

纯前端 S3 文件管理器 · iframe 嵌入式 JS SDK · 可扩展动态应用插件。

凭证不出宿主、字节流直进直出——把对象存储桶变成一个可嵌入的文件工作台（预览/编辑/签批/媒体全家桶）。

## 特性

| 域 | 能力 |
|---|---|
| 双形态 | workspace（S3 桶树浏览/多 tab/上传下载/重命名/删除）· 单文件（直链/预签名 URL 读写） |
| SDK | postMessage 协议（origin 白名单/超时/信封错误码），iframe 与 window.open 双构造 |
| 内置应用 | 代码编辑（Monaco 全功能+worker 语言服务+格式化双链）· xlsx 样式渲染 · docx · PDF · Markdown · Mermaid · CSV · HEIC · 音视频 |
| 动态插件 | Univer 办公编辑 · PDF 标注签批 · Markdown/HTML 编辑器 · 媒体增强 · 图片编辑 · PPTX 预览（SRI 自校验，按需装载） |
| 安全 | S3 密钥仅宿主持有（TTL 自毁/热替换）· 预签名直传 · iframe 沙箱 · 敌意文件免疫 |
| 工程 | 中英 i18n · 明暗主题随宿主 · 1391 单测 · Playwright E2E 基线 |

## 快速接入（三步）

宿主页装载文件管理器（iframe）+ 调用 SDK：

```ts
import { useMmagixFilesClient } from "@/composables/useMmagixFilesClient"; // 参考实现随 demo 提供

const { iframeRef, mount, call, on, destroy } = useMmagixFilesClient();

// ① 模板里放 <iframe ref="iframeRef" />
// ② 装载（凭证留在宿主，S3 预签名在浏览器直连）
await mount({
  mode: "workspace",
  bucket: "my-bucket",
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  credentials: { accessKeyId, secretAccessKey, sessionToken },
  ttlSeconds: 1800,
}, "https://cdn.example.com/mmagix-files/"); // filesBase=部署好的本产品整站

// ③ 命令与事件
await call("uploadFiles", { files, targetPrefix: "docs/" });
on("fileChanged", (p) => console.log(p.key));
```

完整命令/事件/错误码契约见 [`documents/JSSDK 接口文档.md`](documents/JSSDK%20接口文档.md)；可运行示例见 `mmagix-embed-demo/`（`pnpm dev` → http://localhost:5200）。

## 发布物清单（v1.1.0）

| 物 | 位置 | 说明 |
|---|---|---|
| 整站构建 | `frontend/` → `pnpm build` | 部署到任意静态托管（filesBase） |
| 插件 bundle | `frontend/public/plugins/*.js`（7 个） | 懒加载，SRI 清单见 [`documents/releases/v1.1.0-plugin-sri.json`](documents/releases/v1.1.0-plugin-sri.json) |
| 宿主侧客户端 | demo 内 `useMmagixFilesClient` 参考实现 | v1.1 起抽独立 npm 包 |

## 文档

- [JSSDK 接口文档](documents/JSSDK%20接口文档.md)——协议契约正本
- [用户手册](documents/用户手册.md)——接入/配置指南
- [动态插件方案](documents/动态插件方案.md) / [动态插件样例](documents/动态插件样例.md)——扩展应用开发
- [CHANGELOG](CHANGELOG.md)

## 开发

```bash
cd frontend && pnpm install && pnpm dev --port 5199   # 文件管理器
cd mmagix-embed-demo && pnpm install && pnpm dev    # 演示站 5200（需 MinIO 9000）
pnpm verify   # typecheck + lint + 1391 单测
pnpm e2e      # Playwright 全量
```
