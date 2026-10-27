# 测试用例清单

> 粒度=测试文件（套件）级；套件内用例名见各 `__tests__/*.test.ts` 文件头注释（与代码同源，此处不复制）。
> 用例数标注为 2026-10-26 实测（`pnpm vitest run`，总计 98 文件 / 1436 通过 + 1 跳过）。

## 1. SDK 协议层（frontend/src/sdk/__tests__，7 文件）

| 套件 | 覆盖 |
|---|---|
| bus.test.ts | 信封 ns/v 校验、origin 白名单静默丢弃、reply-by-id、targetOrigin 禁 *、ready 握手（契约正本 jsdk-api.md §一/二/三/七） |
| s3/__tests__（2 文件） | S3 datasource（列/取/传/删）、预签名/凭证通路 |
| 其余 4 文件 | 命令面板、错误码、协议工具、config 解析（fragment + encodeURIComponent 口径） |

## 2. 文件管理面（frontend/src/files/__tests__，19 文件）

| 套件（代表） | 覆盖 |
|---|---|
| preview.test.ts（49 例） | 预览生命周期全链：命中应用渲染、fallback（doc/ppt 定向提示+下载钮）、错误边界（重试/下载门）、大文件拒绝、appId 直开、dispose/beforeDispose |
| preview-tabs.test.ts | 多 tab：打开/切换/关闭/复用（viewState 恢复契约） |
| download-queue.test.ts | 下载队列/失败透出 |
| commands.test.ts | 工作台命令面板 |
| search-dialog / search-index | 全局搜索 |
| mem-store.test.ts | mem:// 内存文件通路（凭证不出/字节不落盘） |
| profiles / connect-wizard / format | 连接配置、向导、字节格式化口径 |

## 3. 内置应用（frontend/src/apps，10 文件）

| 套件 | 覆盖 |
|---|---|
| builtins.test.ts（13 应用注册表） | 表完整性/注册序=默认优先级/占位渲染器/二次注册拒载/字节限额单一事实源（R2-03） |
| renderers/code.test.ts（44 例） | 语言映射、保存链（Ctrl+S）、格式化双链（worker 优先+自研回退+双护栏）、统一工具栏（红点/重置/历史联动）、只读闩锁 4305、beforeDispose 3s 竞速、主题联动、viewState |
| renderers/flow-editor.test.ts（16 例） | 解析/添加节点连线/Ctrl+S/撤销栈/重置（恢复原文）/位置持久化/4305 只读 |
| renderers/code-theme.test.ts | 宿主变量→Monaco 主题映射（明暗/data-brand） |
| 其余渲染器（csv/docx/heic/image/markdown/media/mermaid/pdf/xlsx/xlsxStyle/html）（14 文件） | 各渲染器装配与解析面 |

## 4. 统一编辑工具栏（src/shared/__tests__/editToolbar.test.ts，7 例）

四钮 DOM 契约（data-act 顺序/aria/SVG）、回调接线、状态机（busy/dirty 红点/history/readonly 隐藏）、dispose。

## 5. 客户端包（packages/files-client/src/__tests__，21 例；哨兵 src/shared/__tests__/clientProtocol.test.ts，3 例）

| 套件 | 覆盖 |
|---|---|
| core.test.ts（14 例） | URL 构造（fragment+encodeURIComponent，'+' 不损）、withHostOrigin 注入、装载 src/握手/4303 拒绝/call-reply 信封与 targetOrigin/4004 超时+迟到 reply 忽略/origin 双闸/事件订阅/expired 终态拆除/destroy 幂等 |
| vue.test.ts（7 例） | 状态机流转、未装载 4005、run 包装日志、destroy 复位、日志上限、uploadProgress 500ms 节流、重装 about:blank 归位坑 |
| clientProtocol.test.ts（3 例） | 协议常量 ↔ sdk 正本漂移哨兵 |

## 6. 动态插件（frontend/plugins/*/src/__tests__，11 文件）

| 插件 | 套件 | 覆盖 |
|---|---|---|
| markdown-editor（3 文件） | render/editor/md | 三形态机/options 通道/保存链（幂等双闸+快照防增量丢失）/beforeDispose/统一工具栏（undo/redo/重置） |
| html-editor（4 文件） | render 之外四件 | 沙箱净化/查找替换/资源内联/参数 |
| artplayer-player（2 文件） | 重连/计次 | error=重连中陷阱、video:error 计次 |
| filerobot-image-editor（1 文件） | 保存二段流 | base64 前缀校验（防 fetch('') 写坏对象） |
| pptx-viewer（1 文件） | 渲染桩 | init/resize 防抖 |

## 7. UI 组件库（src/components/sdk/**，30 文件）

Fc* 组件（display 8 / overlay 6 / layout 6 / navigation 5 / form 4 / data 等）——主题 token、空态、骨架屏等。

## 8. E2E 用例（Playwright，归档 test-report/）

| 批次 | 覆盖 |
|---|---|
| 2026-10-09-01/02、10-13-01 | 早期装配回归、X6 v2 适配 DEF 修复取证 |
| 2026-10-18-01 | dispose 顺序红线（DEF-1：editor→model） |
| 2026-10-19-01 / 10-20-01 | worker 五入口分发、格式化双链（via worker 实证）、内存文件通路 |
| 2026-10-21-01 | 主题联动、pptx 三页、xlsx 样式、一键直达 |
| 2026-10-26-01 | 统一工具栏 12/12（code+flow 红点/重置/保存链）、十应用截图取证（含 html 三态、doc/ppt 兜底提示、pdf TDZ 回归抓获）、客户端包实机链路 |

结果汇总见 [test-report-v1.1.0.md](test-report-v1.1.0.md)。
