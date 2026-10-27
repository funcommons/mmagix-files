# mmagix-files 用户手册（消费方接入指南）

## 〇、头表

| 项 | 值 |
| --- | --- |
| 版本 | **V1.1（2026-10-26 修订：SDK 接入改 npm 包 `@mmagix/files-client`、会话续期口径、ui.treeMode/treeTitle、日常使用面扩全；V1.0=2026-10-08 评审版）** |
| 读者 | 消费方接入开发者（把 mmagix-files iframe 嵌进自己产品的人） |
| 配套 | [JSSDK 接口文档](../design/jsdk-api.md)（消息协议契约）/ [插件体系](../design/plugin-system.md)（扩展文件类型）/ [概要设计](../design/solution-design.md)（嵌入形态/单文件模式正本） |

---

## 一、快速接入（四步）

### 第 1 步：准备 S3 与 scoped 凭证（接入硬义务）

- 一个 S3 兼容端点（OSS/MinIO/AWS 均可），bucket 开启 **CORS**（四要素缺一不可）：
  - `AllowedOrigins`: 你嵌入 mmagix-files 的页面域（或 `*` 仅限试联调）
  - `AllowedMethods`: GET/PUT/POST/DELETE/HEAD
  - `AllowedHeaders`: `*`（SigV4 需要 content-type 等头）
  - `ExposeHeaders`: `ETag`——multipart 分块直传必须能读到各分块 ETag 才能完成 CompleteMultipartUpload，缺此条大文件上传必失败（OSS/MinIO/AWS 通用坑）
- 为**每次会话**签发 **scoped 临时凭证**（STS），三要素缺一不可：
  - **prefix 限定**：policy 锁死到本次会话目录（如 `sessions/20261008-abc/`）——凭证泄漏=只泄漏这一个目录
  - **短 TTL**：≤1h 建议（硬帽 24h）——这也是会话有效期（§会话行为）
  - **最小动作集**：按需 get/put/delete/list

### 第 2 步：拼配置 JSON

```json
{
  "v": 1,
  "backend": {
    "endpoint": "https://oss-cn-shenzhen.aliyuncs.com",
    "region": "oss-cn-shenzhen",
    "bucket": "your-bucket",
    "prefix": "sessions/20261008-abc/",
    "credentials": { "accessKeyId": "STS.xxx", "accessKeySecret": "xxx", "sessionToken": "xxx" },
    "ttlSeconds": 3600
  },
  "security": { "allowedOrigins": ["https://your-app.example.com"] },
  "params": { "uploadMaxBytes": 104857600, "uploadConcurrency": 3 },
  "appearance": {
    "theme": "light",
    "brand": { "name": "你的产品名", "logoUrl": "https://.../logo.svg", "primaryColor": "#4f6ef2" },
    "locale": "zh-CN"
  },
  "features": { "upload": true, "delete": true, "rename": true, "mkdir": true,
                "download": true, "multiTab": true, "openWithMenu": true, "plugins": true },
  "permissions": { "denyExts": ["exe"] },
  "plugins": [{ "url": "https://cdn.your.com/plugins/ipynb-viewer.js", "sri": "sha384-...", "lazy": true, "options": {} }],
  "ui": { "initialPath": "/", "defaultOpen": "reports/summary.md" }
}
```

字段速查：

| 段 | 必填 | 说明 |
| --- | --- | --- |
| `v` | ✅ | 配置协议版本，当前 `1` |
| `backend.*` | ✅ | S3 端点+scoped 凭证；`prefix`=会话目录域（文件树从此起） |
| `backend.ttlSeconds` | - | =前端自毁定时器时长；必须 ≤（建议略短于）STS 凭证真实 TTL——若配置值大于真实 TTL，会出现「前端还显示剩余时间、S3 已全部拒绝」；可选 `expiresAt` 可直接对齐 STS 到期时刻 |
| `security.allowedOrigins` | ✅ | 宿主页域白名单——文件服务→宿主方向按此白名单收发；宿主→文件服务方向由客户端包自动钉死 iframe origin（`createMmagixFilesHost` 的 `baseUrl`） |
| `params.uploadMaxBytes` | - | 单文件上传上限（字节），超限前端拒收 |
| `params.uploadConcurrency` | - | 并发上传数，默认 3 |
| `appearance.*` | - | 主题 light/dark/auto、品牌（OEM）、语言 zh-CN/en-US |
| `features.*` | - | 功能开关，false=对应操作整链禁用（UI 隐藏+API 拒绝）；全集与命令映射见下表 |
| `permissions.denyExts` | - | 拒收扩展名黑名单，统一**不带点**（如 `["exe"]`）；匹配前忽略大小写与前导点；命中拒收走 JSSDK `4304 EXT_DENIED`（`uploadFiles` reply 的 `rejected` 列表） |
| `plugins[]` | - | 动态插件（url+sri 完整性哈希+lazy+options 透传 activate 第二参，v1.1）——详见 [插件体系](../design/plugin-system.md) |
| `ui.*` | - | `initialPath` 初始目录 / `defaultOpen` 默认打开文件 / `treeMode` 文件树形态（sidebar=常驻侧栏〔默认〕/ drawer=左抽屉）/ `treeTitle` 文件树标题覆写（缺省=前缀末段，根=「根目录」） |

features 全集与命令映射：

| 开关 | 映射 |
| --- | --- |
| `upload` | cmd `uploadFiles` |
| `delete` | cmd `remove` |
| `rename` | cmd `rename` |
| `mkdir` | cmd `createFolder` |
| `download` | cmd `download` |
| `multiTab` / `openWithMenu` | 纯 UI 开关（无对应命令） |
| `plugins` | 总闸：`registerApp` 命令与配置注入插件（`plugins[]`）加载，false=全禁 |

### 第 3 步：iframe 嵌入

```html
<iframe id="mmf" src="https://files.mmagic.app/#config=URLencodeURIComponent(配置JSON)"
        allow="clipboard-write" style="width:100%;height:100%;border:0"></iframe>
```

- 拼接防歧义，照抄：

```js
const url = 'https://files.mmagic.app/' + '#config=' + encodeURIComponent(JSON.stringify(cfg))
```

  花括号属于 JSON 本身；整个编码结果接在 `#config=` 之后，**不要再包一层 `{}`**
- 配置 JSON **必须放 fragment（`#`）并 encodeURIComponent**——禁走 query（`?`），详见 [概要设计](../design/solution-design.md) §4.1
- 配置 JSON 建议 **≤8KB**（fragment 实用上限）；logo 等大内容走 URL 引用不内联

### 第 4 步：接入宿主客户端包

```bash
npm install @mmagix/files-client
```

Vue 3 项目用组合式层（`@mmagix/files-client/vue` 的 `useMmagixFilesClient`——状态机/日志/卸载自动销毁）；
非 Vue 用核心入口 `createMmagixFilesHost`。最小示例见 [JSSDK 接口文档](../design/jsdk-api.md) §八。

> 会话凭据注入：宿主经 `setCredentials` 命令热替换 STS 凭证并重置自毁线（可反复调用实现「心跳续期」，
> 见 `call("setCredentials", { credentials, ttlSeconds })`）。

### 形态 A：window.open 独立窗（等效 iframe）

- `window.open(第 3 步拼出的 url)` 打开独立窗——与 iframe 等效，通道适配 parent/opener（[概要设计](../design/solution-design.md) §4.1）
- 客户端包当前提供 iframe 形态（`createMmagixFilesHost({ iframe })`）；独立窗形态可自行监听 `message` 并按同套 origin 双闸过滤（iframe origin 收包 + 白名单发包）

### 形态 B：单文件模式（`#file=`，不开工作台）

URL 也可以只开一个文件——fragment 改放 `#file=`，结构与《../design/solution-design.md》§4.1b 一致：

```json
{
  "v": 1,
  "source": { "url": "https://api.your.com/docs/42", "method": "GET",
              "headers": { "Authorization": "Bearer 短时token" } },
  "save": { "method": "PUT", "url": "https://api.your.com/docs/42" },
  "name": "doc.md"
}
```

- `source`: `{ url, method: 'GET'|'POST', body?, headers? }`；`save`: `{ method: 'PUT'|'POST', url, headers? }`；外层另有 `name`、`appearance?`、`features?`
- **只读=无 `save` 段**（预览应用渲染，零写链）；**可写=有 `save` 段**（编辑类应用可用，按 `save.method` 回写）
- 与 `#config` **互斥、二选一**；不接 S3、常无凭证
- **源站 CORS 自理**：`source.headers` 可带宿主签发的短时 token
- 命令子集：`setTheme`/`setLocale`/`getInfo`/`destroy`/`uploadFiles`（内存通道）/`getApps`/`registerApp`；事件子集：`ready`/`expired`/`error`/`fileChanged`——详见 [JSSDK 接口文档](../design/jsdk-api.md) 单文件小节

---

## 二、日常使用

| 操作 | 方式 |
| --- | --- |
| 浏览目录 | 左侧文件树点击（sidebar 常驻/`ui.treeMode=drawer` 抽屉两种形态）；懒加载子目录 |
| 打开文件 | 双击/回车——按类型走默认应用；右键「打开方式」选其他应用（同类型多应用） |
| 多 tab | 打开的文件各占一个 tab；可钉住，超量 LRU 淘汰（上限 8）；树/预览宽度可拖分隔条 |
| 上传 | 工具栏/拖拽入面板/直接粘贴（剪贴板图片即传）；大文件直传+并发 3 |
| 下载 | 右键/工具栏；多选可打包 zip |
| 重命名/删除/新建目录 | 右键菜单；重命名=copy+delete 语义 |
| 搜索 | 全局搜索对话框（文件名索引） |
| 命令面板 | `Ctrl/⌘+K`——工作台全部动作快捷入口 |
| 分享 | 右键「分享」生成链接（ShareDialog） |
| 编辑与保存 | 可编辑应用（代码/流程图/Markdown/HTML/Office/图片/PDF）统一左上角 `[保存｜撤销 重做 重置]` 工具栏；Ctrl/⌘+S 保存直传；**未保存=保存钮右上角红点**，关闭前会确认 |
| 预览全屏 | 预览工具栏「全屏」按钮（浏览器内全屏，发 `previewFullscreen` 事件给宿主） |
| Office | docx/xlsx 预览 + **univer-office 插件在线编辑**；旧 .doc/.ppt 出定向转存提示（另存新格式再上传） |
| 连接配置 | 右上角连接向导（ConnectWizard）：支持 STS 与本地长期 AK/SK（sessionToken 留空）两种模式，多 Profile 记忆 |
| 新文件类型 | 接入方写插件 js+配置一行——见 [插件体系](../design/plugin-system.md) |

## 三、会话行为（必读）

- **会话有效期=凭证 TTL**，到期前端自毁（清态+`expired` 事件）且 S3 全部拒绝；**支持续期**：宿主 `setCredentials` 重签热替换凭证并重置自毁线（可反复调用实现「心跳」）
- 页面刷新：嵌入配置经 sessionStorage 备份链重建（凭证仍有效期内则无缝恢复；URL fragment 已抹除，「URL 即凭证」的暴露窗口仅限首次签发链接）
- **「URL 即凭证」**：嵌入链接在凭证 TTL 内可重放——不要把带配置的 URL 发给不该有权限的人；渠道建议走「点击时后端现拼现发」
- 审计：中台无服务端会话记录，合规审计请启用 bucket access log（S3 原生）

## 四、安全须知（接入方义务清单）

> 文件服务**无租户概念**（2026-10 裁决⑥）：不做按消费方嵌入钉域/CSP 差异化——无配置/凭证的嵌入实例=空壳，无物可泄；真实边界=本清单+JSSDK origin 双向校验。

- [ ] 凭证首选 **STS scoped 临时凭证**（prefix+TTL+最小动作集）；本地/内网模式可用长期 AK/SK（连接向导 sessionToken 留空）——公网宿主不推荐
- [ ] bucket CORS 已按§一配置
- [ ] 配置只在 fragment、经用户点击时现签现发
- [ ] 宿主侧校验 JSSDK 消息 `event.origin`（SDK 已内建，勿绕过）
- [ ] iframe 未授予 `allow-top-navigation`（如加 sandbox，必须含 `allow-same-origin`，否则 origin 变 null、SigV4 全挂）
- [ ] 插件 js 托管在你自己的可信 CDN，SRI 哈希入配置
- [ ] 知悉：插件供应链执法=`plugins[]` 清单本身+SRI 校验（文件服务页不做 CSP script-src 差异化，已裁⑥无租户）
- [ ] 已启用 bucket access log（如需审计）

## 五、FAQ

**Q：会话能续期吗？** 能——宿主 `call("setCredentials", { credentials, ttlSeconds })` 重签热替换凭证并重置自毁线（STS 过期前反复调用即「心跳」）。需要超长会话也可签发时放大 TTL（上限 24h）。

**Q：凭证过期前用户还在编辑怎么办？** 到期前 5 分钟（T-5min）起**面板横幅+编辑器顶部提示**；`expired` 事件后宿主可引导重新签发新 URL。

**Q：支持哪些 S3 供应商？** 一切兼容下列**最小清单**的端点（OSS/MinIO/AWS 已列适配目标），上线前请照单对目标端点实测：ListObjectsV2（Delimiter=/）、GetObject/PutObject、CopyObject、DeleteObjects、multipart 全族（Create/UploadPart/Complete/Abort）、**ETag 经 CORS ExposeHeaders 可读**（§一第 1 步）、HeadObject。

**Q：能隐藏某些功能（如禁止删除）？** `features.delete=false`——UI 隐藏+JSSDK/内部操作整链拒绝。

**Q：上传大小限制？** `params.uploadMaxBytes`（宿主配置）+凭证 policy 动作集双闸。
