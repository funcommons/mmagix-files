# 概要设计说明书

> 项目：mmagix-files v1.1.x · 纯前端 S3 文件管理器（iframe 嵌入式）
> 本文与代码同源演化：结构以 `frontend/src/` 实际目录为准，改动架构必须同步本文。

## 1. 系统构成

```
┌─ 宿主页面（任意源，业务前端）───────────────────────────┐
│  @mmagix/files-client（postMessage 客户端，零依赖）      │
│  凭证持有者：setCredentials 注入 STS/TTL                 │
└──────────────┬──────────────────────────────────────────┘
               │ iframe + postMessage（ns=mmagix-files, v=1）
┌──────────────▼──────────────────────────────────────────┐
│  mmagix-files SPA（frontend/，静态托管）                  │
│  boot 装配 → MessageBus → CommandHandlers → Session      │
│  files 管理面（树/多tab/预览/上传/下载/搜索）             │
│  apps 应用层（registry 13 内置 + 统一工具栏）             │
│  动态插件 loader（SRI/lazy，7 官方插件）                  │
└──────────────┬──────────────────────────────────────────┘
               │ S3 API（前端直连；预签名 URL 直传直取）
        ┌──────▼──────┐
        │  S3 / MinIO │
        └─────────────┘
```

## 2. 目录结构（frontend/src）

| 目录 | 职责 |
|---|---|
| `boot.ts` | 装配层：config 解析 → bus → session → handlers → registry 接成可运行 iframe 应用（握手时序：destroy=先 ack 后 evt expired） |
| `sdk/` | 协议与基础设施：`bus.ts`（postMessage 双闸）、`config.ts`（#config/#file fragment 解析）、`constants.ts`、`errorCodes.ts`、`credentials.ts`、`session.ts`（TTL 自毁/单实例闩锁）、`features.ts`、`handlers.ts`（命令处理）、`s3/`、`url-source.ts`、`plugins/loader.ts`（动态插件装载） |
| `files/` | 文件管理面：`tree-store`（树）、`preview`+`preview-tabs`（预览生命周期）、`upload-queue`/`download-queue`、`search-index`、`commands`（命令面板）、`mem-store`（mem:// 内存通路）、`profiles`/`connect-wizard`（连接配置）、`zip`、`ui/`（TreePanel/PreviewTabs/Toolbar/UploadPanel/StatusBar/SearchDialog/SessionBanner/ShareDialog/ConnectWizard + shortcuts/workspace-ops） |
| `apps/` | 应用层：`registry.ts`（注册表+解析链）、`builtins.ts`（13 内置应用表+字节限额单一事实源）、`renderers/`（14 渲染器）、`shared/editToolbar.ts`（统一编辑工具栏，内置+插件共用源码）、`flow-model.ts` |
| `components/sdk/` | Fc* UI 组件库（display/form/layout/navigation/overlay/data + 主题 token） |
| `store/` | pinia：app/preference/oem |
| `locales/` | zh-CN / en-US 全量词典 |
| `packages/files-client/` | 宿主侧客户端 npm 包（核心+Vue 层双入口） |
| `plugins/` | 7 官方动态插件（standalone 构建，单文件 ESM 入 public/plugins） |
| `shared/`（demo 侧） | demo 的客户端包兼容出口与 vite alias |

## 3. 关键设计决策

| # | 决策 | 理由/约束 |
|---|---|---|
| D1 | iframe 嵌入 + postMessage（origin 双闸：入站白名单 + 出站禁 `*`） | 宿主任意源可接；凭证不出宿主 |
| D2 | 配置走 URL fragment（#config/#file + encodeURIComponent） | fragment 不到服务端/代理日志；禁 URLSearchParams（'+' 陷阱） |
| D3 | 应用注册表解析链：matcher(ext) 命中 → 注册序即默认优先级；无命中 → fallback 下载提示（doc/ppt 定向文案） | 渲染类应用先于 code-editor 注册（csv/html 默认进预览态） |
| D4 | 渲染器字节限额单一事实源：`builtins.ts` 导出常量，预览闸与渲染器共用 | 杜绝「闸 50MB × 渲染器 20MB」双字面量漂移（R2-03） |
| D5 | 统一编辑工具栏唯一样式源：`shared/editToolbar`，宿主编译入 bundle、插件构建期内联 | 十应用视觉一致 + 插件零运行时依赖 |
| D6 | 插件 standalone 单文件 ESM（inlineDynamicImports），可选 sha384 SRI + lazy | 任意静态托管；按需装载 |
| D7 | 主题随宿主：`data-theme`/`data-brand` 属性驱动 CSS token（--app-*），Monaco 经 defineTheme 映射 | 嵌入式 OEM 形态 |
| D8 | mem:// 键域 DataSource 分流 | 凭证不出/字节不落盘场景，渲染器零改动 |
| D9 | 会话治理：TTL 自毁线（destroy=先 ack 后 expired）、单实例闩锁 | STS 过期安全态 |

## 4. 应用清单（内置 13 + 插件 7）

内置（注册序，见 `apps/builtins.ts` BUILTIN_APP_SPECS）：
image-viewer / video-player / audio-player / pdf-viewer / markdown-renderer / flow-editor / mermaid-viewer / csv-table / html-viewer / code-editor / heic-viewer / docx-viewer / xlsx-viewer；fallback-download 不入表（解析链显式处理）。

插件（frontend/plugins）：univer-office（xlsx/xls/docx 编辑）、pdf-annotator（标注签批压平）、markdown-editor（三形态）、html-editor（三态+单体化）、artplayer-player（媒体增强）、filerobot-image-editor（图片编辑）、pptx-viewer（PPTX 预览）。

可编辑面统一工具栏能力矩阵见 [PRD](../product/PRD.md) §4。

## 5. 质量属性

| 属性 | 手段 |
|---|---|
| 安全 | 凭证不出宿主；origin 双闸；HTML 净化沙箱；SRI 可选校验（见 SECURITY.md） |
| 可测试 | 单测与代码同目录（98 文件/1436 例）；插件无单测者以实机取证兜底（见 docs/test/） |
| 可扩展 | 插件契约（activate(sdk)→registerApp）；渲染器注册制；漂移哨兵护协议 |
| i18n | 全量词典 zh-CN/en-US，t() 单通道（插件 label 也走词典键） |
| 主题 | 明暗 + 多品牌（token 化，禁硬编码色值） |

## 6. 已知边界

- 旧 .doc/.ppt 二进制不可在线预览（定向转存提示）；pptx 保真中上
- Safari/Firefox 不支持 File System Access API（本地文件夹模式未实现）
- 插件与宿主同窗（非 iframe 隔离）——只应装载可信来源插件
