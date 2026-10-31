# mmagix-files JSSDK 接口文档

## 〇、头表

| 项 | 值 |
| --- | --- |
| 版本 | **V1.2**（2026-10-31 修订：命令表补 `restore`/`purge`（19 条）、`getApps` payload 修正为 `{ name }`、registerApp 装载语义对齐实装；V1.1=2026-10-26（宿主 SDK 段改 `@mmagix/files-client`、命令表补 `getApps`、单文件子集扩）；V1.0=2026-10-08 评审版。协议版本仍从 1 起） |
| 读者 | 消费方宿主页面开发者 |
| 性质 | **协议文档即对外契约**（100% 开放承诺面）——M0 起按此实现，向后兼容纪律见 §九 |
| 配套 | [用户手册](../operations/user-guide.md)（接入/配置）/ [插件体系](plugin-system.md) · [插件样例](plugin-sample.md)（扩展应用——插件体系的 registerApp 契约依赖本文档） |

---

## 一、概述

- 通道：`window.postMessage` 双向（宿主页面 ⇄ iframe / window.open 独立窗——通道自动适配 parent/opener，安全规则同一套）
- 消息命名空间：`ns: "mmagix-files"`——非本命名空间消息一律忽略
- 方向一（宿主→文件服务）= **command**；方向二（文件服务→宿主）= **event**；对每条 command 有对应 **ack/reply**
- 安全规则（双向强制）：发送方精确 `targetOrigin`（禁 `*`）；接收方校验 `event.origin ∈ security.allowedOrigins`（或文件服务自身域）——不符即静默丢弃

## 二、消息信封（通用格式）

```ts
interface Envelope<P = unknown> {
  ns: 'mmagix-files'
  v: 1                      // 协议版本
  kind: 'cmd' | 'evt' | 'reply'
  id: string                // uuid；reply 携带对应 cmd 的 id
  name: string              // 命令/事件名（§三/§五/§六）
  payload: P
  ok: boolean               // 仅 reply 携带：成功=true / 失败=false（成功 payload 不变）
  code?: number             // 仅失败 reply：§七错误码
}
```

- 宿主侧持有 `host` 句柄：`@mmagix/files-client` 包（npm；Vue 项目用 `@mmagix/files-client/vue`）——内建信封/序号/超时/origin 双闸，下文 API 均为其方法。iframe 形态=`createMmagixFilesHost({ iframe, baseUrl, config, timeoutMs })`；宿主自身 origin 自动注入 `security.allowedOrigins`（`withHostOrigin`）。注入配置后 `host.call()/host.on()/host.ready`（Vue 组合式层 `useMmagixFilesClient`）
- 命令超时：默认 **10s**，SDK 构造可配 `timeoutMs`；超时 promise reject **4004 TIMEOUT**（`destroy` 等本地命令同规则，不豁免）

## 三、握手与生命周期

```
iframe 加载 ──► evt: ready {sdkVersion, protocolVersion, configSummary} ──► 宿主可下发 cmd
会话到期 ──► evt: expired ──► SDK 置 destroyed 态，后续 cmd 全部 reject(SESSION_EXPIRED)
宿主主动结束 ──► cmd: destroy ──► ack + evt: expired（自毁语义同 §用户手册·会话行为）
```

- `ready` 之前下发的 command 进入队列，`ready` 后按序回放（上限 50 条，超出拒=**4303 QUEUE_OVERFLOW**）
- `destroy` 时序：**先 reply(ack) 后 `evt: expired`**（`reason='destroyed'`）；iframe DOM 移除由宿主 SDK 负责
- 宿主侧 `host.ready` 以等待握手实现（iframe boot 完成即发 `ready`）；晚于就绪装载不存在错过问题。`ready` 等待超时（缺省 10s）reject `MmxError(4004)`——排查顺序：baseUrl 是否正确/iframe 页是否启动；**若 ready 收到但命令全超时，才是 allowedOrigins 白名单问题**
- 生命周期事件顺序保证：`ready` → 业务 events → `expired`（终态，之后零消息）

## 四、单文件模式（工作台模式的子集形态）

- 配置入口：URL fragment 用 **`#file={ v, source:{ url, method:'GET'|'POST', body?, headers? }, save?:{ method:'PUT'|'POST', url, headers? }, name, appearance?, features? }`**（与《solution-design.md》§4.1b 一致；**只读=无 `save` 段**；与 `#config` **互斥**，二者只取其一）
- 命令子集：`setTheme`/`setLocale`/`getInfo`/`destroy` + `uploadFiles`（走内存文件通道，不落桶）/`getApps`/`registerApp`（§五）；其余工作台命令一律 reject **4305 UNSUPPORTED_MODE**（§七）
- 事件子集：`ready`/`expired`/`error`/`fileChanged`（§六）——`fileChanged` 于 save 回写成功后触发（`action='put'`）

## 五、Command（宿主 → 文件服务；工作台全集，单文件模式子集见 §四）

| 方法 | payload | reply | 说明 |
| --- | --- | --- | --- |
| `navigate` | `{ path: '/' }` | `{ path }` | 文件树切目录 |
| `openFile` | `{ path, appId? }` | `{ tabId }` | 打开文件；`appId` 指定应用，缺省走默认应用（路径不存在=4102；matcher 不命中且无默认应用=4202） |
| `closeTab` | `{ tabId }` | `{}` | 关 tab（含 dispose；tabId 不存在=4102） |
| `getTabs` | `{}` | `{ tabs: [{ tabId, path, appId }] }` | 当前面板 tab 列表 |
| `createFolder` | `{ path }` | `{ key }` | 建目录 |
| `uploadFiles` | `{ files?: File[] }` | `{ accepted: [{ id }], rejected: [{ name, reason: 'ext'\|'size' }] }` | 缺省拉起选择器；带 files=宿主经 structured clone 直传 File 引用；**混批部分拒收**（rejected 逐个携原因，ext=4304/size=4302）；**完成态走 `uploadDone`/`uploadFailed` 事件**（全批异常仍走 `uploadFailed`，`error.code`=4302/4304） |
| `download` | `{ paths: string[] }` | `{ id }` | 打包/单文件下载；**完成态走 `downloadDone`/`downloadFailed` 事件**（与 upload 对称） |
| `rename` | `{ from, to }` | `{}` | copy+delete 语义 |
| `remove` | `{ paths: string[] }` | `{}` | 批量删除 |
| `restore` | `{ paths: string[] }` | `{}` | **v1.2**：回收站恢复（批量；删除 latest DeleteMarker 使对象重新可见）。需桶版本能力 + `features.restore`；paths=回收站条目键 |
| `purge` | `{ paths: string[] }` | `{}` | **v1.2**：回收站彻底删除（逐 key 复验 latestIsMarker，防陈旧条目清光活版本）。需桶版本能力 + `features.purge` |
| `select` | `{ mode: 'file' \| 'multi' \| 'off', filter?: { exts: ['todo'] } }` | `{}`（ack；`mode='off'`=退出选择模式） | 选择模式（宿主做「选文件」业务）；**用户确认后发 `selectionConfirmed` 事件** |
| `setTheme` | `{ theme: 'light'\|'dark'\|'auto' }` | `{}` | 运行时换主题 |
| `setCredentials` | `{ credentials: { accessKeyId, accessKeySecret, sessionToken }, ttlSeconds?, expiresAt? }` | `{}` | **v1.1**：宿主重签通道——热替换会话凭证（下一请求即用新值，在途请求不受影响）并重置自毁线（`expiresAt` 优先于 `ttlSeconds`；双缺省=保持现线）。工作台模式专用（单文件 4305）。信任前提：凭证经消息传输，以宿主已过 origin 白名单为界；STS 过期前宿主可反复重签实现「心跳」 |
| `setLocale` | `{ locale: 'zh-CN'\|'en-US' }` | `{}` | 运行时切语言 |
| `registerApp` | `{ url, sri, lazy?, options? }` | `{ appId, applied? }` | 运行时动态追加一条配置注入插件（语义见下注）；`options` 为对象时透传给 `activate(sdk, options)`（v1.1 增补，只增不改义）；`applied`=本次调用是否处于该 url 首次激活路径（false=同 url 幂等短路，**本次 options 不生效**，宿主应改走重载/刷新，v1.1） |
| `getApps` | `{ name: string }` | `{ apps: [{ id, label, actions }] }` | 按文件名枚举命中应用（内存文件独立区「选打开应用」下拉数据源；name 缺失/空 = 4005）。v1.1；单文件模式可用 |
| `getInfo` | `{}` | `{ sdkVersion, session: { expiresInSec }, features }` | 会话信息查询 |
| `destroy` | `{}` | `{}` | 立即自毁 |

- **payload 统一注记（全文同）**：① `key`/`paths` 等路径类字段=**相对配置 `backend.prefix` 的对象键**；② 扩展名一律**不带点**（如 `filter.exts: ['todo']`），匹配前归一化=**忽略大小写与前导点**；③ `getInfo` reply 的 `features` 形状=`{ [featureKey]: boolean }`（与配置 `features.*` 同键位）；④ 参数非法/格式错=reject **4005 BAD_PARAM**
- **registerApp 通道语义**：payload 与配置注入 `plugins[]` **同构**（url+sri+lazy，同一 registry，见 [插件体系](plugin-system.md)）——iframe ��到后 fetch 拉取字节 → sha384 自校验（与配置注入插件同一 loader 通路）→ Blob URL import，调用该模块 `activate(sdk, options?)`（options=v1.1 透传的插件参数，缺省不传）；完整 manifest（matcher/renderer/probe 等）内含于插件 js。设计理由：**函数体必须在插件 js 内、不可经消息传输，故运行时注册传 URL 而非 renderer**

## 六、Event（文件服务 → 宿主）

| 事件 | payload | 触发 |
| --- | --- | --- |
| `ready` | `{ sdkVersion, protocolVersion, configSummary }` | 初始化完成 |
| `pathChanged` | `{ path }` | 用户浏览切目录 |
| `fileOpened` | `{ tabId, path, appId }` | 用户打开文件 |
| `tabClosed` | `{ tabId }` | 用户关 tab |
| `selectionChanged` | `{ paths: string[] }` | 面板内勾选变化（浏览态） |
| `selectionConfirmed` | `{ paths: string[] }` | `select` 选择模式下用户确认 |
| `uploadProgress` | `{ id, loaded, total }` | 上传分块进度（节流 ~200ms） |
| `uploadDone` / `uploadFailed` | `{ id, key? , error? }` | 上传终态 |
| `downloadDone` / `downloadFailed` | `{ id, error? }` | 下载终态（与 upload 对称） |
| `fileChanged` | `{ key, action: 'put'\|'delete'\|'rename', from? }` | 面板内用户变更（宿主同步自身视图用；单文件模式 save 回写成功亦触发，见 §四） |
| `previewFullscreen` | `{ on: boolean }` | 预览区浏览器内全屏切换（iframe 应用发出，宿主应把承载 iframe 的容器铺满本页视口；Esc 退出时 `on=false`。宿主不处理也不影响 iframe 内布局） |
| `expired` | `{ reason: 'ttl' \| 'destroyed' }` | 会话终态（见 §三） |
| `error` | `{ code, message, detail? }` | 非命令类故障（插件加载失败 4201、宿主侧 registerApp 加载失败等） |

## 七、错误码

| code | 常量 | 含义 |
| --- | --- | --- |
| 4001 | BAD_CONFIG | 配置缺失/非法（#config 缺 backend、#file 缺 source、JSON 坏等） |
| 4002 | CREDENTIAL_INVALID | 凭证被 S3 拒（scope/policy 错） |
| 4003 | CREDENTIAL_EXPIRED | 凭证 TTL 到（等价会话终态前奏） |
| 4004 | TIMEOUT | 命令超时（默认 10s，见 §二） |
| 4005 | BAD_PARAM | 参数非法/格式错 |
| 4101 | S3_ERROR | S3 端点错误（detail 携 status） |
| 4102 | NOT_FOUND | 路径/tabId/appId 不存在 |
| 4201 | PLUGIN_LOAD_FAILED | 插件 import 失败/SRI 不符/版本不匹配 |
| 4202 | NO_APP | matcher 不命中且无默认应用 |
| 4301 | FEATURE_DISABLED | 功能开关关闭（如 delete=false 时 remove） |
| 4302 | LIMIT_EXCEEDED | 超 uploadMaxBytes 等限制 |
| 4303 | QUEUE_OVERFLOW | `ready` 前队列超 50 拒（见 §三） |
| 4304 | EXT_DENIED | 扩展名黑名单拒收（`permissions.denyExts` 命中） |
| 4305 | UNSUPPORTED_MODE | 当前模式不支持该命令（如单文件模式下调工作台命令，见 §四） |
| 5000 | SESSION_EXPIRED | 会话已终态后的任何 cmd |
| 5001 | ORIGIN_REJECTED | origin 不在白名单——按 §一静默丢弃，不送达调用方，仅日志使用 |

## 八、类型定义与最小接入示例

```ts
import { createMmagixFilesHost } from '@mmagix/files-client';

const host = createMmagixFilesHost({
  iframe: document.getElementById('mmf')!,
  baseUrl: 'https://files.example.com/',
  config: workspaceConfig, // 或单文件 config；宿主 origin 自动注入 allowedOrigins
  timeoutMs: 10_000,
});
await host.ready;
const tabs = await host.call<{ tabs: unknown[] }>('getTabs');
host.on('fileOpened', (p) => console.log(p));
```

类型随包发布（`dist/*.d.ts`：`MmxWorkspaceConfig`/`MmxSingleFileConfig`/`MmxEventName`/`MmxError`/`MmagixFilesHost` 等，协议文档与类型同仓同版）。Vue 组合式层见 `@mmagix/files-client/vue`（`useMmagixFilesClient`）。`PluginEntry`/`AppManifest` 规范字段见 [插件体系](plugin-system.md) §二（含 `requiresSdk` 版本协商；经 registerApp 通道时 manifest 内含于插件 js，不经消息传输）。

## 九、版本兼容纪律

- `protocolVersion` 主版本=破坏性变更（升版须双端协商，SDK 拒接不兼容 iframe）
- 既有字段**只增不删不改义**；新方法/新事件=minor 版本
- 废弃流程：标 `deprecated` → 保留 ≥2 个 minor → 移除于下一个主版本
- 本档变更纪律：字段级改动须评审并同步《../operations/user-guide.md》与类型包
- 本 V1.0 为**施工前契约定稿**（尚无消费方），字段级重构不构成破坏性变更
