# 产品需求规格说明书（PRD）

> 项目：mmagix-files · 现状基线：v1.1.0（2026-10-26）· **以代码为唯一事实源**（能力清单逐项锚定代码）
> 本文档合并并退役《产品顶层设计.md》与《第一期文件类型支持计划.md》（漂移审计后收口；退役理由见 docs/README.md 变更清单）

## 1. 产品定位

纯前端 S3 文件管理器，以 iframe 嵌入任意业务前端：对象存储桶的浏览/上传/下载、多应用预览与编辑，
一套 postMessage 协议接入。**服务端零侵入**（S3/MinIO 直连，凭证不出宿主）。

五支柱：
1. 双形态嵌入：workspace（桶工作台）/ 单文件（source 直链，可选 save 段写回；支持无源 `mem://` 装载）
2. 多应用文件面：13 内置应用 + 7 动态插件，注册表解析（注册序=默认优先级，「打开方式」可切换）
3. 协议接入：postMessage 双向（origin 双闸）、npm 客户端包 `@mmagix/files-client`
4. 安全默认：凭证不出宿主、HTML 净化沙箱、SRI 可选校验、TTL 自毁
5. 嵌入式体验：主题/品牌/语言随宿主、单实例闩锁、命令面板

## 2. 用户与场景

| 用户 | 场景 |
|---|---|
| 业务前端开发者 | 数小时内把文件管理能力嵌入自有系统（三步接入，见部署手册 §3.3） |
| 最终用户 | 在嵌入面板内完成文件浏览/上传/下载/预览/编辑/分享，无需跳出业务系统 |
| 插件开发者 | 按 PluginEntry 契约扩展新文件应用（样例+单测护航） |

## 3. 功能需求（FR）——逐项锚定代码

### 3.1 工作台（mode=workspace）

| FR | 需求 | 状态 | 代码锚 |
|---|---|---|---|
| FR-1 | 对象树浏览（目录展开、重命名=copy+delete、删除、新建目录、右键菜单） | ✅ | `files/tree-store.ts`、`files/ui/TreePanel.vue` |
| FR-2 | 多 tab 预览（钉住/LRU 8 淘汰、切 tab 恢复视口 savedState、关闭确认） | ✅ | `files/ui/PreviewTabs.vue`、`files/preview.ts` |
| FR-3 | 上传（队列/并发 3/失败原因透出/粘贴上传/File 失效免疫） | ✅ | `files/upload-queue.ts`、`views/Home.vue` |
| FR-4 | 下载（队列/zip 打包/分享链接 ShareDialog） | ✅ | `files/download-queue.ts`、`zip.ts`、`ui/ShareDialog.vue` |
| FR-5 | 全局搜索 + 命令面板（Ctrl/⌘+K） | ✅ | `files/search-index.ts`、`files/commands.ts`、`App.vue` |
| FR-6 | 大文件分级闸（≤20MB 直开 / ~拒绝线 确认带 / 超线 拒绝+下载） | ✅ | `files/preview.ts`（R2-03 实际拒绝线=min(REJECT, maxBytes)） |
| FR-7 | 连接配置（配置向导 ConnectWizard；支持长期 AK/SK 本地模式——sessionToken 可空） | ✅ | `files/profiles.ts`、`ui/ConnectWizard.vue` |
| FR-8 | 内存文件通路（mem:// 键域；宿主 uploadFiles target=memory） | ✅ | `files/mem-store.ts`、`files/commands.ts` |
| FR-9 | 会话治理（TTL 自毁 T-5min 提醒、expired 终态、setCredentials 续期重签） | ✅ | `sdk/session.ts`、`sdk/handlers.ts` |

### 3.2 内置应用（13，注册序=默认优先级）

| 应用 | 扩展名 | 形态 | 关键策略 |
|---|---|---|---|
| image-viewer | jpg/jpeg/png/gif/webp/svg/bmp | 预览 | viewerjs 缩放/旋转 |
| video-player | mp4/webm/mov | 预览 | Range 拖动进度 |
| audio-player | mp3/wav/ogg/flac/m4a | 预览 | 同上 |
| pdf-viewer | pdf | 预览 | pdf.js（直链 Range） |
| markdown-renderer | md/markdown | 预览 | 5MiB 限额 |
| flow-editor | mmd/mermaid | 编辑 | graph TD 子集可视化编辑（X6），位置持久化 meta 通道 |
| mermaid-viewer | mmd/mermaid | 预览 | 全 mermaid 语法只读 |
| csv-table | csv/tsv | 预览 | papaparse 表格化；20MiB 限额（超线拒绝+下载提示） |
| html-viewer | html/htm | 预览 | 净化沙箱（srcdoc 剥脚本面）+ 跳转代理确认新 tab；20MiB |
| code-editor | 60+ 文本扩展名 | 编辑 | Monaco：worker 五入口/格式化双链/统一工具栏/主题随宿主/5MiB 只读降级/4305 闩锁 |
| heic-viewer | heic | 预览 | heic2any 转码；32MiB |
| docx-viewer | docx | 预览 | docx-preview |
| xlsx-viewer | xlsx/xls | 预览 | ExcelJS 样式渲染（2000 行截断）；xls 走 SheetJS |

> 未排期：image-painter（Canvas 画板，曾列入早期计划，当前不在注册表）。
> 未知类型：fallback-download（不入 registry，解析链显式处理）——doc/ppt 出定向转存提示。

### 3.3 动态插件（7，frontend/plugins/*）

| 插件 | 能力 | 形态 |
|---|---|---|
| univer-office | xlsx/xls/docx 在线编辑 | Univer；浮动保存钮 |
| pdf-annotator | PDF 标注（矩形/文字/画笔/签名）+ AcroForm 值 + 压平写回 + sidecar 导出/导入 | pdf.js 覆盖层 + pdf-lib |
| markdown-editor | 源码/双窗/预览三形态 | CM6 + markdown-it + mermaid |
| html-editor | 源码/可视/预览三态 + 资产单体化（base64 内联）+ 跳转代理 | CM6 + Tiptap + 沙箱 iframe |
| artplayer-player | 视频播放增强（断流重连） | artplayer |
| filerobot-image-editor | 图片编辑（裁剪/标注/调色） | react 内核（自带工具栏） |
| pptx-viewer | PPTX 预览（保真中上） | pptx-preview（锁 1.0.7，闭源例外见 LICENSE） |

### 3.4 接入协议（JSSDK）

- 命令 17 条 / 事件 15 条 / 错误码 16 条——正本清单见 [接口设计](../design/jsdk-api.md)
- 宿主客户端：`@mmagix/files-client`（核心入口 + `/vue`）；零运行时依赖
- 单文件模式命令子集：setTheme / setLocale / getInfo / destroy / uploadFiles（内存通道）/ getApps / registerApp

## 4. 非功能需求（NFR）

| NFR | 需求 | 现状 |
|---|---|---|
| 安全 | 凭证不出宿主；origin 双闸；HTML 净化；SRI 可选；TTL 自毁 | ✅（模型见 SECURITY.md） |
| i18n | 全量中英双语，t() 单通道（含插件 label） | ✅ |
| 主题 | 明暗 + 多品牌 token 化（禁硬编码色值）；Monaco/编辑器随宿主 | ✅ |
| 性能线 | 文本 5MiB、CSV 20MiB、HEIC 32MiB、HTML 20MiB、大文件确认带 20MB、渲染超时 10s | ✅（单一事实源 builtins.ts） |
| 兼容 | Chrome/Edge 现代版；Safari/Firefox 不支持 File System Access API | ✅ 已知边界 |

## 5. 范围外与已知边界

- 旧 .doc/.ppt 二进制不可在线预览（提供定向转存提示）；pptx 保真中上（SmartArt/艺术字有损；高保真 LibreOffice 路线未部署）
- 脑图/时序图/架构图编辑器为规划项（当前以 mermaid-viewer 只读覆盖，见 diagram-roadmap.md）
- probe（magic bytes 嗅探）未实现（matcher 仅 ext 维度）；图片 >50MP 降采样未实现
- 本地文件夹模式（File System Access API）未实现（Safari/Firefox 兼容边界）
- 服务端会话/存储、redis 等一律不做（纯前端定位）

## 6. 修订历史

| 版本 | 说明 |
|---|---|
| v1.1.0（2026-10-26） | 本文合并《产品顶层设计.md》《第一期文件类型支持计划.md》并按 v1.1.0 代码收口：会话支持续期（setCredentials）、office 编辑由 univer-office 插件可达、pptx 插件预览、交付物扩为 dist+客户端包+7 插件、应用清单对齐 BUILTIN_APP_SPECS（13）、fallback 不入 registry、probe/降采样标注未实现 |
