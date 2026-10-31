# mmagix-files 方案设计（web 文件中台）

> **【实施状态注记 · 2026-10-31 复审】** 本文为总体方案裁决档案（概要设计现状见 [architecture.md](architecture.md)；v1.2.0 四能力的升级方案档案见 [v1.2.0-capabilities-design.md](capabilities-design-v1.2.0.md)）。以下与代码已分叉，以代码为准（锚点见各条）：
> 1. §4.7 命令实为 **19 条**（+v1.1 `setCredentials`/`getApps`、+v1.2 `restore`/`purge`）；事件 **15 条**（+`previewFullscreen`，现发于 `views/Home.vue:872`；iframe 侧类型暂未收编）
> 2. §4.5 布局为**自研** TreePanel+PreviewTabs+拖拽分隔条（无 dockview/allotment）；「轻量文本降级 CodeMirror 6」未实现
> 3. §4.4 断点续传已实现且路线与本文不同：**IDB checkpoint**（非 ListParts 轮询；`files/checkpoint-store.ts`）；ListMultipartUploads 已实现（`sdk/s3/client.ts`），ListParts 仍无
> 4. §4.2/§八 会话已支持**续期**：setCredentials 重签热替换+extend 重置自毁线（`session.ts:124`）
> 5. §4.1b 单文件 shape 另有 `appId`/`security`/`plugins`，v1.2 支持 `source.url=''` 无源装载（`config.ts:139-165`）
> 6. §4.6/§4.8 image-painter 未实现（renderers/index.ts 注释「M2+ 排期」）；pptx 已由插件可预览（非「降级下载」）
> 7. §4.2「刷新=从 fragment 重建」→ 实际解析后 `scrubFragment()` 抹除 fragment，刷新经 sessionStorage 备份链重建（`config.ts:188-211`）
> 8. 交付物已扩：dist + `@mmagix/files-client` 宿主包 + 7 个动态插件
> 9. **v1.2.0/v1.3.0 已交付**（本文写作时为规划态，现均为现实）：断点续传/回收站/在线解压/分享信封、上传确认弹窗+传输中心双 Tab、版本能力门控+历史版本恢复——设计记录见 v1.2.0-capabilities-design.md 与 CHANGELOG


## 〇、头表

| 项 | 值 |
| --- | --- |
| 版本 | **V1.2（2026-10-08 评审修订版**：JSSDK 清单对齐契约正本（15 cmd/14 evt）、单文件模式入需求与里程碑、术语统一「S3 端点与 scoped 临时凭证」、会话执法线澄清+config 增 `expiresAt`、时钟偏移自校、S3 API 子集补全（HeadObject/ListParts/AbortMultipartUpload）、插件红线与沙箱表述修正、交付模型已裁⑥（无租户概念、零按消费方差异化）；V1.1=0 后端定案翻版——redis 会话剔除、凭证 TTL 定长、presign 降级可选增强件；V1.0 首版=五轮选型讨论收敛后立项落档） |
| 状态 | **已裁收官（五裁决全落）——用户令不开工，候开工令**；v1 范围=预览全谱+文本/代码编辑，office 编辑不进 v1（③） |
| 定位 | 独立可嵌入的 web 文件中台产品：无用户体系、即开即用、S3 数据面、JSSDK 全开放 |
| 技术路线 | **纯自研·纯前端（0 后端）**——Vue3 SPA（CDN 静态托管）+ S3 直连；**零自有服务、零 redis，交付物=一个 dist** |
| 参考代码 | Amplify UI Storage Browser / FileBrowser Quantum（Apache-2.0 可抄码）；filestash（AGPL **只参考产品语义，零代码抄用**） |

---

## 一、需求（v2 定稿，含 V1.1 裁决翻版注记）

### 1.1 嵌入与配置

- 嵌入形态双支持：**iframe** 内嵌 / **window.open** 独立窗（等效，JSSDK 通道自动适配 parent/opener）
- **URL 参数控制行为与外观**，参数以 **JSON 格式数据**经 URL 传递：
  - 参数配置：上传文件大小限制、…
  - 外观配置：主题、样式、OEM 信息、语言（中/英）
  - 功能配置：功能开关、权限配置
  - 后端配置：**S3 端点与 scoped 临时凭证（AK/SK/SessionToken 三元组 + prefix policy）**

### 1.2 文件操作能力

- Windows 目录式：浏览、查看、打开、重命名、上传、下载、… 目录和文件

### 1.3 UI 形态

- 左文件树；右文件打开面板；**多文件多 tab**；代码编写 **IDE 布局**
- 文件打开支持**多种应用**；同一类型支持**多应用打开**（如图片→浏览/画图）
- 应用分**内置**与**扩展**；扩展通过**注册插件**实现

### 1.4 会话与身份

- 会话不持久化：前端退出或超时结束——原始设想 redis TTL+心跳延期 10min，**V1.1 裁决翻版：0 后端定案，会话=凭证 TTL 定长**（§4.2：执法线=凭证 TTL，前端线=UX 自毁）
- **没有用户体系，即开即用**

### 1.5 开放性

- **100% 开放前端 JSSDK API**，消费方可操控 iframe 内的前端

### 1.6 单文件模式（#file）

- URL 可只开**一个文件**：只读预览或可写编辑；源=普通 HTTP（GET/POST，可带回写 `save`）——**无目录无 S3 也可接**（§4.1b）

---

## 二、选型结论（讨论收敛史）

| 候选 | 判定 | 要点 |
| --- | --- | --- |
| filestash（AGPL） | 否（基座）/参考（语义） | 存储驱动+office 预览成熟，但三大支柱（无会话/URL 配置/JSSDK）全在其逆配置面；vanilla JS 封闭内核；无 Release+单维护者；AGPL 传染修改版 |
| FileBrowser Quantum（Apache-2.0） | 否（基座）/参考（交互） | license 干净+Vue 栈，但仅本地盘（S3 ❌）、无插件系统（#1758 提案未实现）、预览/编辑薄 |
| OpenList（AGPL） | 否 | 多存储最全但用户/权限模型更重，逆改面更大 |
| OpenSumi / Theia | 否 | IDE 平台框架解决「布局需求」是杀鸡牛刀；fs 层假设自带 Node RPC 后端，S3 要重写其服务契约；React 分叉 |
| 协作编辑器 | 候裁（§八③） | office 编辑纯前端不可行；Collabora CODE（MPL-2.0 可白标）> OnlyOffice CE（AGPL+logo 锁）> Univer（Apache-2.0，xlsx 强但 0.x） |
| 自建后端形态（会话服务+presign 控制面） | **否（V1.1 裁决）** | 降级为**未来可选增强件**——挂前端凭证获取接缝，架构不为它分叉 |
| **纯自研·纯前端** | **✅ 定案** | 五支柱全顺建；零 license 尾巴；零上游漂移面；**零自有部署面（交付物=dist）**；代价 6-8 周自付 |

**S3 协议判定**（否决 FTP 提案）：「无用户体系」要求每次会话现签 scope 凭证——S3 临时凭证/前缀限定是原生表达，FTP 单组可重放 USER/PASS 是反表达；且 S3 面向元数据/分块/直链，FTP 无 content-type/无 ACL/passive 模式运维灾区（filestash 尚有 FTPS 跳过 TLS 验证 CVE-2024-41255 在案）。

---

## 三、总体架构（纯前端，唯一组件）

```
消费方宿主页面
   │ iframe（frame-ancestors 白名单）
   ▼
mmagix-files 前端（Vue3 SPA——CDN 静态托管，唯一交付物）
   │ ①配置：URL fragment 全量 JSON（#config={...}，禁走 query「?」）
   │ ②会话：执法线=凭证 TTL（服务侧硬线）+ 前端 UX 自毁（非安全线，无服务端会话）
   │ ③签名：浏览器内 SigV4（scoped 凭证）+ 大对象 presigned 语义按需
   ▼
S3 兼容端点（S3 端点与 scoped 临时凭证：AK/SK/SessionToken 三元组 + prefix policy；OSS/MinIO/AWS 通吃）
   · 前置要求：bucket CORS 配置（消费方接入义务）
```

**组件清单**：①前端 SPA（唯一交付物）②CDN/静态托管（运营面）。

> ✅ 已裁⑥（2026-10-08）：**无租户概念**——fragment 配置只对当前浏览器会话生效，个性化全部由前端读配置实现；交付层零按消费方差异化。frame-ancestors 由托管运营面统一设定或省略（非接入义务——无配置/凭证的嵌入实例=空壳）；插件供应链执法=配置 `plugins[]` 清单本身+SRI 标签注入（§五.1、《plugin-system.md》§四）。

**可选增强件（非本期，接缝预留）**：会话服务（ticket 一次性+心跳延期+控制面审计/presign）——接缝=前端凭证获取接口 `fetchCredentials()`：fragment 形态从配置直取，服务形态 RPC 获取；架构不因它分叉，v2 增强不返工。

---

## 四、关键设计

### 4.1 URL 配置传递（0 后端定案：fragment 全量 JSON；嵌入双形态 iframe/window.open）

- 配置 JSON 走 **fragment（`#config={...}`）**：不到服务端/代理日志、referrer 规范剥离；但仍随完整 URL 进浏览器历史/地址栏——**配置解析完成后建议 `history.replaceState` 抹除 fragment**；实用上限 ~8KB，OEM logo 等走 URL 引用不内联
- **Token 禁走 query（`?`）**——query 进浏览器历史/referrer/访问日志
- **失去一次性属性（0 后端固有代价）**：URL 在凭证 TTL 内可无限重放——以「凭证短 TTL+scope 限定」为唯一缓释，写入消费方接入契约
- 未来可选增强件形态：URL 只带一次性 ticket，首用即焚换配置（§三接缝）
- **嵌入形态双支持**：iframe 与 window.open 独立窗等效——JSSDK 通道自动适配 parent/opener，安全规则同一套（origin 白名单）

### 4.1b 单文件模式（URL 也可以只开一个文件）

- **形态**：`#file={ v, source:{ url, method:'GET'|'POST', body?, headers? }, save?:{ method:'PUT'|'POST', url, headers? }, name, appearance?, features? }`
- **只读**：无 `save` 段 → 预览应用渲染，零写链；**可写**：有 `save` 段 → 编辑类应用可用，保存按 save.method 回写
- **POST 支持**：源 URL 拉取支持 POST（body/headers 可配）——适配 API 型文档源（渲染端点/带门禁的内容服务）
- **数据源抽象**：AppRegistry ctx 统一 `getObject/putObject` 语义——S3 provider（工作台模式）与 URL provider（单文件模式）双实现，内置应用与插件零感知
- **安全**：单文件模式常无凭证（普通 HTTP 源）——CORS 由源站配置；`headers` 可带宿主签发的短时 token；其余 frame-ancestors/origin 校验同工作台
- **会话执法主体**：单文件模式无 S3 凭证线——会话执法=宿主签发的 source/save token 自身 TTL + 前端定时器

### 4.2 会话（V1.1 定案：凭证 TTL 定长）

- **会话有效期=凭证 TTL，签发时定死、不延期**——原始「redis TTL+心跳延期」随 0 后端裁决废止；心跳延期语义由「会话服务增强件」承接（非本期）
- **执法线=凭证 TTL（服务侧硬线，刷新/塞栓均不可续命）**：TTL 到 → S3 全部拒绝；**前端线=UX 自毁+T-5min 预警（刷新即从 fragment 重建，非安全线）**：定时器到期 → 清态+`onExpire` postMessage 通知宿主
- 前端持态：**sessionStorage/内存，禁 localStorage**；刷新=从 fragment 重建（幂等）
- config 增可选字段 **`expiresAt`**：前端定时器与 STS 真实到期对齐用（页面加载时刻≠凭证签发时刻）；**`ttlSeconds` 必须 ≤（建议略短于）STS 凭证真实 TTL**——前端定时器只是 UX，真实死线在 STS 侧
- 建议凭证 TTL 档：≤1h（OEM 可配上限，硬帽 24h）
- **到期预警**：T-5min 起面板横幅提示（用户手册 Q&A 承诺面的设计落位）

### 4.3 凭证模型（0 后端定案：scoped 凭证进浏览器）

- **定案=a 案**：前端持 scoped 凭证直签 SigV4。**XSS 一次=凭证失守——唯一防线=凭证 scope**，故升格为**接入硬义务**：消费方必须提供 **prefix 限定+短 TTL 临时凭证**（OSS STS / S3 temp creds / MinIO STS）；拿不出 scoped 凭证的消费方不得接入
- 备选 b 案（presign 控制面，Token 永不进浏览器）随会话服务降级为**可选增强件**能力（§三接缝），非本期
- 凭证获取抽象为接口 `fetchCredentials()`：本期=fragment 直取；增强期=RPC 换发
- **时钟偏移补偿**：客户端时钟偏移以 S3 响应 `Date` 头自校，SigV4 签名时按偏移量校正（防 RequestTimeTooSkewed 全拒）

### 4.4 S3 协议面（API 子集）

| 操作 | S3 API | 说明 |
| --- | --- | --- |
| 目录树/列表 | ListObjectsV2 + Delimiter=/ | 前缀即目录域（凭证 scope 钉在 prefix） |
| 下载/预览 | GetObject（浏览器 SigV4 直取或自签 presigned GET） | 预览与应用共用 |
| 上传 | PutObject / multipart（CreateMultipartUpload 族） | 大文件分块直传 |
| 存在性/元信息探测 | HeadObject | mime 探测、存在性检查、重命名冲突检测 |
| 分块续传 | ListParts / ListMultipartUploads | 断点续传（列未完成分块 / 列进行中的 multipart 上传） |
| 分块清理 | AbortMultipartUpload | 孤儿分片清理——上传失败/取消路径必调 |
| 重命名/移动 | CopyObject + DeleteObject | S3 无 rename 的标准映射；**CopyObject 单次源对象 ≤5GB（超限需 UploadPartCopy）**；目录级 rename=逐对象 Copy+Delete 循环，中途失败留半态，**须支持续跑** |
| 删除 | DeleteObjects（批量） | |
| 建目录 | PutObject 空对象约定（`dir/` 零字节键） | S3 目录模拟惯例 |
| 兼容域 | OSS/MinIO/AWS 全支持上列子集 | 上线前对目标端点做兼容实测（ETag/multipart 语义） |

- **时钟偏移**（签名横切关注点）：客户端时钟偏移以 S3 响应 `Date` 头自校，SigV4 签名时间按偏移量校正（详见 §4.3）——偏移超限=端点全量拒绝

### 4.5 UI：IDE 布局

- 布局：**dockview**（或 allotment）——左文件树 + 右多 tab 编辑/预览区 + 可拖分屏
- 编辑器：**Monaco**（MIT，70+ 语言高亮/IDE 手感；Vue wrapper 现成）；轻量文本档可降级 CodeMirror 6
- 主题：CSS 变量体系，主题/OEM 全变量化（换皮=换变量集）

### 4.6 应用模型（内置/扩展/多应用打开）

```
AppRegistry: registerApp({ id, matcher: {mime|ext|probe}, renderer, actions })
```

- **内置应用**：图片浏览（viewerjs 级）、图片画图、文本/代码编辑（Monaco）、Markdown 渲染（markdown-it，含 mermaid）、PDF（iframe 原生/pdf.js）、音视频（`<video>/<audio>`）、CSV（文本+表格化）
- **同类型多应用**：同 matcher 多 app →「打开方式」菜单（图片→浏览/画图）
- **扩展插件**：与内置走同一 registry——**T1 宿主自管插件=配置注入 ES module（`activate(sdk)`→`registerApp`，特权运行）一期定案**；T2 第三方市场插件（sandboxed 渲染）候需求——契约/安全红线/工程细则见《plugin-system.md》
- **office**：预览=docx-preview/SheetJS **进 v1**；编辑**不进 v1**（纯前端不可行，Collabora 预选备档，候真实需求+商务裁决）

### 4.7 JSSDK（postMessage 双向协议）

- 方向一（宿主→文件服务，15 条 command）：`navigate/openFile/closeTab/getTabs/select（mode 含 'off'=退出选择模式）/createFolder/uploadFiles/download/rename/remove/registerApp/setTheme/setLocale/getInfo/destroy`
- 方向二（文件服务→宿主，14 条 event）：`ready/pathChanged/fileOpened/tabClosed/selectionChanged/selectionConfirmed/uploadProgress/uploadDone/uploadFailed/downloadDone/downloadFailed/fileChanged/expired/error`
- 契约纪律：协议带版本号+TS 类型定义；**协议文档即对外契约**（100% 开放的承诺面）；`targetOrigin` 精确匹配禁 `*`，接收端强校验 `event.origin`

### 4.8 预览/编辑能力矩阵

| 类型 | 预览 | 编辑 | 库 |
| --- | --- | --- | --- |
| 图片（JPEG/PNG/GIF/WebP/SVG） | ✅ 原生 | 画图应用（内置） | `<img>`+viewerjs |
| HEIC | ⚠️ heic2any 转 | ❌ | libheif wasm |
| 视频/音频 | ✅ 原生 | ❌ | `<video>/<audio>` |
| PDF | ✅ | ❌ | iframe 原生 / pdf.js |
| Markdown | ✅ 渲染态 | ✅ 源码态 | markdown-it（MIT） |
| 文本/代码 | ✅ 高亮 | ✅ | Monaco/CodeMirror 6 |
| CSV | ✅ 表格化 | ✅ 文本态 | papaparse |
| docx | ⚠️ docx-preview（还原度中上） | ❌ | 候 Collabora 外挂 |
| xlsx | ⚠️ SheetJS | ⚠️ Univer（Apache-2.0，后档·非 v1） | 轻编辑档 |
| pptx | ❌ 降级下载 | ❌ | — |

### 4.9 OEM / 主题 / 语言

- OEM：logo/品牌名/主色经配置下发，CSS 变量注入
- 语言：vue-i18n，中/英双包；插件应用强制走同一 i18n 通道

---

## 五、安全设计

1. **嵌入控制（已裁⑥：无租户概念）**：不做按消费方 frame-ancestors 钉域——「谁能嵌」不是交付层边界：无配置/凭证的嵌入实例=空壳、无物可泄；真实边界=JSSDK `event.origin` 双向校验（本节 6）+凭证 scope（本节 3）；托管运营面可统一设定全局 frame-ancestors（非接入义务）；宿主侧禁 `allow-top-navigation`（接入指引见《../operations/user-guide.md》§四）

2. **URL 泄漏面**：Token/配置禁 query；fragment 在凭证 TTL 内可重放——「URL 即凭证，泄漏=会话泄漏（至 TTL 止）」写入消费方接入契约第一行
3. **凭证**：scoped 短 TTL 临时凭证为**接入硬义务**（prefix 限定+TTL ≤1h 建议/24h 硬帽）；XSS 失守的唯一缓释=scope——**T1 特权档的强制红线=插件域白名单+SRI 完整性校验+宿主自担信任承诺**（宿主本就把凭证托付给同信任级的自家 js）；**沙箱隔离=T2 市场插件期义务**
4. **会话过期**：执法线=凭证 TTL（服务侧硬线），前端自毁=UX 线；0 后端下无服务端会话可审计——审计需求由消费方启用 **bucket access log** 承接（S3 原生能力）
5. **插件沙箱**（裁决点②，T2 期义务）：扩展代码与宿主 iframe 隔离（sandboxed iframe/worker 档），能力经 registry 白名单暴露
6. **JSSDK origin 校验**：双向消息精确 targetOrigin/origin 校验；消费方域白名单随配置下发

---

## 六、参考实现与 license 纪律

| 参考件 | License | 取材 |
| --- | --- | --- |
| Amplify UI Storage Browser | Apache-2.0 | **头号参考**：ListObjectsV2 目录模拟/分页、上传校验、service worker 流式 zip、fileTypeResolver/rendererResolver 预览架构、custom actions、**浏览器内凭证直签的生产先例**——可抄码 |
| FileBrowser Quantum | Apache-2.0 | 文件管理交互语义（批量 rename/move/copy、冲突处理、排序搜索体验）——可抄码 |
| filestash | **AGPL-3.0** | **只取产品语义**（应用注册模型 xdg-open、mime→查看器、skeleton app 壳）；**一行代码不可抄**——抄用即整前端传染 |
| Collabora CODE | MPL-2.0 | office 编辑**预选备档**（可白标，WOPI/iframe 先例域）——v1 不做 |
| Univer | Apache-2.0 | xlsx 轻编辑候选（0.x，保真度预期管理） |

---

## 七、里程碑（1-2 全栈口径）

| 切片 | 内容 | 量级 |
| --- | --- | --- |
| M0 骨架 | iframe 嵌入+fragment 配置解析+凭证获取接口 `fetchCredentials()`+会话自毁定时器+JSSDK 通道（postMessage 双向+版本化） | **1 周** |
| M1 管理面 | S3 直连：树/上传(multipart)/下载/重命名(CopyObject)/删除/建目录+消费方接入文档（scoped 凭证/CORS 双义务）**+单文件模式 URL provider 只读** | 2 周 |
| M2 预览+编辑 | 多 tab+dockview IDE 布局+app registry 内置件（img/pdf/av/text/md+Monaco 编辑）**+单文件 save 回写** | 2.5 周 |
| M3 扩展 | registerApp 插件 API+沙箱档+OEM 主题/i18n 收口 | 2 周 |
| M4 office 预览 | docx/xlsx 预览（docx-preview/SheetJS）；**编辑不进 v1**（Collabora 预选备档候需求） | 1 周 |

**总口径：分项相加=8.5 人周（单全栈串行）；M1/M3 与 M2/M4 并行时日历周可压至 6-8 周。交付物=一个 dist。**

---

## 八、裁决台账

| # | 项 | 裁决 | 状态 |
| --- | --- | --- | --- |
| ① | 凭证模型 | **a. scoped 凭证进浏览器（直签 SigV4）**；presign 控制面降级可选增强件 | ✅ 已裁（V1.1，随 0 后端定案） |
| ② | 插件沙箱档 | **T1 宿主自管插件（配置注入 ES module，特权运行）一期；T2 第三方市场（sandboxed iframe/worker）候需求** | ✅ 已裁（翻案正本=《plugin-system.md》） |
| ③ | office 编辑进 v1? | **预览进 v1（M4），编辑不进 v1**——Collabora 预选备档，候真实需求再议 | ✅ 已裁（用户裁 2026-10-08） |
| ④ | URL 配置形态 | **fragment 全量 JSON**；ticket 形态随会话服务降级为增强件能力 | ✅ 已裁（V1.1，随 0 后端定案） |
| ⑤ | 后端形态 | **0 后端纯前端定案**；会话服务（ticket/心跳/审计）为未来可选增强件，接缝=`fetchCredentials()` | ✅ 已裁（V1.1） |
| ⑥ | 交付模型/租户 | **无租户概念**——fragment 配置仅对当前浏览器会话生效，个性化=前端读配置实现；交付层零按消费方差异化（CSP/frame-ancestors 不作租户机制，插件供应链=plugins[] 清单+SRI） | ✅ 已裁（用户裁 2026-10-08，消解评审 P0#2/P1#6） |

