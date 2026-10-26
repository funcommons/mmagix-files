# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### 新增

- **宿主侧客户端 npm 包 `@mmagix/files-client`**：`useMmagixFilesClient` 从 demo 抽出为独立包
  （零运行时依赖；核心 `createMmagixFilesHost` 框架无关 + Vue 组合式层 `/vue` 双入口，ESM+d.ts，
  vue 为可选 peer）。demo 经 vite alias 消费同一份源码（零安装验证）；协议漂移哨兵
  `clientProtocol.test.ts` 双侧比对（挂 frontend 套件）。单测 21 例（消息泵 harness：
  握手/call-reply/超时/终态/节流/重装坑全链）。

### 变更

- **doc/ppt 下载兜底定向提示**：旧版 Office 二进制（.doc/.ppt）打开时由泛化「暂无应用」升级为
  文件名 + 原因 + 转存建议定向文案（另存 .docx/.pptx 再上传即可在线查看）；其余未知类型保持泛化
  文案。词典 `files.preview-fallback-doc/ppt`（中/英）。

## [1.1.0] — 2026-10-26

主题：**统一编辑工具栏 + html-viewer**。协议无破坏性变更，v1.0.0 接入方升级无感（纯应用层增强）。

### 新增

- **统一编辑工具栏（内置+可编辑插件全量）**：所有可编辑应用左上角统一 `[保存｜撤销 重做 重置]`
  图标钮簇（新共享源码 `src/shared/editToolbar.ts`——唯一样式源：ghost 图标钮 + CSS token 取色 +
  内联 SVG 零字体依赖；宿主编译入 bundle、插件构建期各自内联拷贝）。**dirty 状态一律=保存钮右上角
  小红点，「未保存」文字徽标全量废除**。新增词典段 `app.edt-save/undo/redo/reset`（中/英）。
- 各应用钮簇能力面：
  - code-editor：重置=恢复打开时内容（executeEdits 入 undo 栈可反悔）；撤销/重做可用性接 monaco
    `model.canUndo/canRedo`；保存防重入闸可视化（busy 禁用）；只读闩锁整簇隐藏（editOnly 口径不变）
  - flow-editor：重置=按打开时原文重解析重建（快照入撤销栈可反悔）；保存链补 `saving` 防重入闸；
    dirty 红点替代「未保存」徽标；testid 透传保留 `flow-save/undo/redo` + 新增 `flow-reset`
  - markdown-editor 插件：新增撤销/重做（CM6 `@codemirror/commands` 直调）+ 重置；测试 id
    保留 `[data-mm-save]` + 新增 `[data-mm-undo/redo/reset]`
  - html-editor 插件：撤销/重做按活动形态分流（source=CM6 / wysiwyg=Tiptap）+ 重置（source 权威
    载体写回，可视态按 body 片段重建）；预览态只读→整簇隐藏；徽标保留错误/警告文案通道
  - univer-office 插件：文字「保存」钮升级为钮簇；撤销/重做接 FUniver facade `undo()/redo()`；
    重置=按打开时字节整体重挂（Univer 无批量 revert 通道）；保存链补 saving/dirty 双闸
  - pdf-annotator 插件：钮簇居工具栏最左；新增重做（快照栈对偶）与重置（回打开时标注/表单态基线，
    压平保存后基线翻空防回滚烙印内容）；保存钮「（压平合并）」语义保留在 title
- **内置应用 html-viewer**：html/htm 默认打开应用（注册序先于 code-editor）——净化式沙箱预览
  （sandbox="allow-scripts" + srcdoc，剥脚本面），一切跳转/打开统一代理为「提示确认后新标签页打开」
  （会话级「不再询问该站点」信任表；非法 scheme 拒绝并上报）；code-editor 源码态与 html-editor
  插件三态编辑经「打开方式」可达。与 html-editor 插件预览态同口径（消息命名空间独立互不串台）。

### 修复

- pdf-annotator：统一钮簇接线将 `saving` 声明留在首次 `renderBadge()` 之后——打开即 TDZ 崩溃
  （「Cannot access 'Xe' before initialization」）。声明前置修复；该插件无单测，
  实机截图取证（十应用全量）补位回归面（test-report/2026-10-26-01）。

### 变更

- 插件产物重建：markdown-editor / html-editor / univer-office / pdf-annotator 四包（`public/plugins/*.js`）；
  SRI 清单重出为 [`documents/releases/v1.1.0-plugin-sri.json`](documents/releases/v1.1.0-plugin-sri.json)
- markdown-editor / html-editor 新增依赖 `@codemirror/commands`
- 已知偏差（尽力而为口径）：filerobot-image-editor 保持第三方内核自带 UI（undo/redo/reset/save
  内核原生已有且已居左），不强行叠加自建钮簇

### 质量基线

- 单元测试 1412 通过（98 文件）；vue-tsc/eslint 零错误
- E2E：统一工具栏 12/12（code+flow 双应用链路）+ 十应用截图取证（内置 2+插件 5+三态+偏差存档）

## [1.0.0] — 2026-10-22

首个正式版。项目由 MMagic-Files 更名 **mmagix-files**（协议命名空间 `ns` 由 `mmagic-files` 同步更名 `mmagix-files`——首版无兼容包袱）。

### 核心：文件管理器（iframe 嵌入式，纯前端）

- **双形态**：workspace（S3 桶浏览：树/多 tab/上传/下载/重命名/删除/新建）+ 单文件模式（source 直链/预签名 URL，可选 save 段写回；v1.2 无源装载）
- **JS SDK**：postMessage 双向协议（cmd/evt/reply 信封、origin 白名单、10s 超时）；双形态构造（iframe / window.open）
- **内存文件通路**：`mem://` 键域 DataSource 分流（凭证不出/字节不落盘场景），全部渲染器零改动
- **凭证红线**：S3 密钥仅宿主持有（setCredentials 热替换 + TTL 自毁线），预签名 URL 直传直取
- **会话治理**：expired 自毁、单实例闩锁、命令面板、全量 i18n（中/英）、明暗主题随宿主（data-theme/data-brand）

### 内置应用（文件类型支持）

- 代码编辑器（Monaco 0.57）：worker 五入口按 label 分发（json/css/html/ts 语言服务真 worker）、格式化双链（worker 原生优先+自研回退）、主题随宿主（8 类核心 token 映射）、全中文右键菜单、viewState 持久化、5MiB 只读降级、4305 只读闩锁
- xlsx/xls 表格：ExcelJS 样式渲染（底色/字色/边框/合并/列宽/行高；2000 行截断护栏）；xls 保留 SheetJS 链
- docx（mammoth）/ PDF（pdfjs + 直链 Range）/ Markdown / Mermaid 流程图 / CSV-TSV / HEIC / 音视频 / 图片
- 上传：队列/失败原因透出/File 失效免疫（选时缓冲）

### 动态插件（v1.0.0 全家桶，SRI 自校验装载）

| 插件 | 能力 |
|---|---|
| univer-office | xlsx/xls/docx 编辑（Univer） |
| pdf-annotator | PDF 标注/签批/签名/压平写回 |
| markdown-editor | 三形态（源码/分屏/预览）编辑 |
| html-editor | 三态（源码 CM6/可视 Tiptap/沙箱预览）+ 单体化（图片 base64 内联）+ 新 tab 代理 |
| artplayer-player | 媒体播放增强（断流重连） |
| filerobot-image-editor | 图片编辑（裁剪/标注/调色） |
| pptx-viewer | PPTX 纯前端预览（pptx-preview，中上保真） |

### 质量基线

- 单元测试 1391 通过（96 文件）；vue-tsc/eslint 零错误
- 多轮 Playwright E2E 回归（test-report/2026-10-19~21）：worker 分发/格式化双链/主题联动/pptx 三页/xlsx 样式/内存文件/一键直达

### 已知边界

- pptx 保真度中上（SmartArt/艺术字/复杂动画有损；高保真路线=LibreOffice 转 PDF，未部署）
- 旧 .doc/.ppt 二进制不支持在线预览（纯前端无成熟解析）
- Safari/Firefox 不支持 File System Access API（本地文件夹模式未含在本版）
