# 测试用例清单

> 粒度=测试文件（套件）级；套件内用例名见各 `__tests__/*.test.ts` 文件头注释（与代码同源，此处不复制）。
> 用例文件数标注为 2026-10-31 实测（v1.3.0，`pnpm vitest run`，总计 142 文件 / 1828 通过 + 1 既有跳过）。
> 本文只列套件→覆盖域映射；数字随版本演进，改测试时顺手更新头注总数与本表。

## 1. SDK 协议层（frontend/src/sdk，11 文件）

| 套件 | 覆盖 |
|---|---|
| bus.test.ts | 信封 ns/v 校验、origin 白名单静默丢弃、reply-by-id、targetOrigin 禁 *、ready 握手（契约正本 jsdk-api.md §一/二/三/七） |
| s3/__tests__（4 文件） | S3 datasource（列/取/传/删）、预签名/凭证通路、版本管理（listObjectVersions/getBucketVersioning）、SigV4 签名、presign extraQuery（versionId/partNumber 等） |
| 其余 6 文件 | 命令面板、错误码、协议工具、config 解析（fragment + encodeURIComponent 口径）等 |

## 2. 文件管理面（frontend/src/files/__tests__，30 文件）

| 套件（分组） | 覆盖 |
|---|---|
| preview.test.ts（49 例） | 预览生命周期全链：命中应用渲染、fallback（doc/ppt 定向提示+下载钮）、错误边界（重试/下载门）、大文件拒绝、appId 直开、dispose/beforeDispose |
| preview-tabs.test.ts | 多 tab：打开/切换/关闭/复用（viewState 恢复契约） |
| download-queue.test.ts | 下载队列/失败透出 |
| commands.test.ts / commands-trash | 工作台命令面板；回收站 restore/purge 命令 |
| search-dialog / search-index | 全局搜索（IDB 索引） |
| mem-store.test.ts | mem:// 内存文件通路（凭证不出/字节不落盘） |
| upload-queue.test.ts / upload-queue-checkpoint | 上传队列/失败原因/门控；断点续传跨会话 checkpoint（IDB 落行、指纹+partSize 双校验、孤儿 uploadId 清理） |
| checkpoint-store / orphan-sweeper | checkpoint 存储层；孤儿 uploadId 7 天清扫 |
| upload-dialog.test.ts | 上传确认弹窗（拖放/点选/多文件/确认/移除/双 Tab 切换） |
| tree-store.test.ts / tree-store-trash | 树存储（懒展开/路径）；回收站列表/恢复/彻底删除（DeleteMarker 语义） |
| version-panel.test.ts | 历史版本抽屉（列表/恢复/下载指定版本） |
| share-crypto / share-dialog / share-dialog-v2 | 分享信封加密（PBKDF2+AES-GCM）、ShareDialog 两代对话框 |
| zip.test.ts / zip-reader | 在线解压浏览器应用；zip 纯函数解析（EOCD/zip64/GBK/zip slip/炸弹闸） |
| trash-panel.test.ts | 回收站抽屉 |
| shortcuts / status-bar / session-format / setup / ui / profiles / connect-wizard / format | 快捷键、状态栏、会话格式、工作台装配、界面工具、连接配置/向导、字节格式化 |

## 3. 内置应用（frontend/src/apps，22 文件）

| 套件 | 覆盖 |
|---|---|
| apps/__tests__（8 文件） | builtins 注册表（应用数/注册序/字节限额单一事实源 R2-03）、zip-browser 等应用装配 |
| renderers/code.test.ts（44 例） | 语言映射、保存链（Ctrl+S）、格式化双链（worker 优先+自研回退+双护栏）、统一工具栏（红点/重置/历史联动）、只读闩锁 4305、beforeDispose 3s 竞速、主题联动、viewState |
| renderers/flow-editor.test.ts | 解析/添加节点连线/Ctrl+S/撤销栈/重置/位置持久化/4305 只读；四方言（graph TD/mindmap/sequence/architecture）parse/serialize |
| renderers/code-theme.test.ts | 宿主变量→Monaco 主题映射（明暗/data-brand） |
| 其余渲染器（csv/docx/heic/image/markdown/media/mermaid/pdf/xlsx/xlsxStyle/html 等，14 文件） | 各渲染器装配与解析面 |

## 4. 统一编辑工具栏（src/shared/__tests__/editToolbar.test.ts，7 例）

四钮 DOM 契约（data-act 顺序/aria/SVG）、回调接线、状态机（busy/dirty 红点/history/readonly 隐藏）、dispose。
（同目录 clientProtocol.test.ts 3 例 = 协议常量 ↔ sdk 正本漂移哨兵，见 §7。）

## 5. 工作台/页面（src/views，5 文件）

| 套件 | 覆盖 |
|---|---|
| home-upload-dialog.test.ts | Home × UploadDialog 集成：树头上传→弹窗→确认即关窗→enqueue→accepted>0 重开落传输页签；全拒保持关门 |
| views/share/__tests__ | ShareAccess 公开校验页（信封解密/防暴破锁/回灌守卫） |
| 其余 3 文件 | 页面装配 |

## 6. 动态插件（frontend/plugins/*/src/__tests__，11 文件）

| 插件 | 套件 | 覆盖 |
|---|---|---|
| markdown-editor（3 文件） | render/editor/md | 三形态机/options 通道/保存链（幂等双闸+快照防增量丢失）/beforeDispose/统一工具栏（undo/redo/重置） |
| html-editor（4 文件） | render 之外四件 | 沙箱净化/查找替换/资源内联/参数 |
| artplayer-player（2 文件） | 重连/计次 | error=重连中陷阱、video:error 计次 |
| filerobot-image-editor（1 文件） | 保存二段流 | base64 前缀校验（防 fetch('') 写坏对象） |
| pptx-viewer（1 文件） | 渲染桩 | init/resize 防抖 |

## 7. 平台杂项（src/api 2 / composables 4 / config 1 / router 1 / store 1 / utils 4 / __tests__ 1 / plugins 2 / shared 2 / packages/files-client 2 = 20 文件）

| 域 | 覆盖 |
|---|---|
| api/utils | 统一错误处理/notify/errorMessages/幂等提交 |
| composables | 组合式函数 |
| config / router / store / 启动 | 特性开关、路由、全局 store、boot |
| src/plugins/__tests__（2 文件） | examples 插件按样例契约可装载 |
| files-client core.test.ts（14 例） | URL 构造（fragment+encodeURIComponent，'+' 不损）、withHostOrigin 注入、装载 src/握手/4303 拒绝/call-reply 信封与 targetOrigin/4004 超时+迟到 reply 忽略/origin 双闸/事件订阅/expired 终态拆除/destroy 幂等 |
| files-client vue.test.ts（7 例） | 状态机流转、未装载 4005、run 包装日志、destroy 复位、日志上限、uploadProgress 500ms 节流、重装 about:blank 归位坑 |
| clientProtocol.test.ts（3 例） | 协议常量 ↔ sdk 正本漂移哨兵 |

## 8. UI 组件库（src/components/sdk/**，43 文件）

Fc* 组件（display 8 / overlay 6 / layout 8 / navigation 5 / form 5 / section 2 / theme 2 / utils 3 / 根 smoke+barrels 4）——主题 token、空态、骨架屏等。

## 9. E2E 用例（Playwright，归档 test-report/）

Spec：`e2e/00-warmup` + `line1-boot-error` ~ `line11-workbench` 共 12 个（浏览/渲染器/工具栏/上传/会话过期/特性/单文件/办公/插件/工作台各一线）。

| 批次 | 覆盖 |
|---|---|
| 2026-10-09-01/02、10-13-01 | 早期装配回归、X6 v2 适配 DEF 修复取证 |
| 2026-10-18-01 | dispose 顺序红线（DEF-1：editor→model） |
| 2026-10-19-01 / 10-20-01 | worker 五入口分发、格式化双链（via worker 实证）、内存文件通路 |
| 2026-10-21-01（根）+ frontend/10-21-01 | 主题联动、pptx 三页、xlsx 样式、一键直达 |
| frontend/2026-10-22-01 | html-viewer 净化预览+跳转代理（popup 实证） |
| 2026-10-26-01 | 统一工具栏 12/12、十应用截图取证、客户端包实机链路 |
| 2026-10-27-01 | flow-editor 脑图/时序图/架构图方言编辑取证 |

结果汇总见 [test-report-v1.3.0.md](test-report-v1.3.0.md)。
