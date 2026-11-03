# WebDAV 协议支持方案

> 状态：**方案正本（已实现并随 v1.4.0 定版发布：M1–M4 全部落地，2026-11-03；发版终闸全量 154 文件/1984 passed+1 skipped 0 失败；release 三件=[delivery-checklist-v1.4.0](../releases/delivery-checklist-v1.4.0.md)/[test-report-v1.4.0](../test/test-report-v1.4.0.md)/[acceptance-v1.4.0](../releases/acceptance-v1.4.0.md)）**——本文是「连接 WebDAV 服务器作为数据源」的唯一设计记录。
> 实现启动时沿 v1.2.0 双档案惯例另立契约/执行账（代码注释「方案/契约」锚点指向本文）；落地版并入 `architecture.md` D 系并补 PRD FR、CHANGELOG。
> 基线：v1.3.0（tag `ecb8a960`）+ 文档治理批次（`a7cefeb2`）；单测 142 文件/1828 例，行覆盖门禁 ≥80%。
> 竞品对标（competitive-analysis-v1.3.0 表 F）中本项目「WebDAV ✗（红线）」指**服务端**；本文做的是**客户端**数据源，红线判定见 §二。

## 一、背景与动机

| 用户已有资产 | 经由 | 覆盖场景 |
|---|---|---|
| Synology / QNAP NAS | 自带 WebDAV Server 套件 | 家庭/工作组 NAS 文件管理 |
| Nextcloud / ownCloud | 原生 WebDAV（dav 端点） | 私有云文件面（不依赖其客户端） |
| 坚果云 | 官方 WebDAV 接入 | 国内网盘（其网页端之外的管理面） |
| FTP / SMB / 几十种网盘 | **alist / OpenList 网关统一挂成 WebDAV** | 协议网关聚合——一次接入等于接入其身后全部协议 |

**一句话**：连上一个 WebDAV = 吃下上面整个生态，而无需逐个实现 FTP/SMB/各家网盘 API。网关由用户自建（与自建 MinIO 同信任域），零后端红线不破。

**战略一致性**：本项目差异化的根基是「纯前端零后端、无可死后端」（竞品对标 §一生态警讯）。WebDAV 是纯 HTTP 协议，浏览器 `fetch` 直连可行——协议扩展同样不引入任何后端依赖，与形态自洽。

## 二、边界判定（先于一切设计）

两条判据：① 浏览器无裸 TCP（fetch/WebSocket 均非原始套接字）；② 凭证不出前端（协议认证必须可由用户填表、前端直接携带）。

| 协议 | 判定 | 理由 |
|---|---|---|
| FTP / FTPS | ❌ 不做 | Chrome 88 / Firefox 90 已移除 FTP；控制+数据双通道模型 fetch 模拟不了，必须代理后端=破红线 |
| SFTP / SSH | ❌ 不做 | 需裸 TCP |
| SMB / NFS / AFP | ❌ 不做 | 内核级协议，浏览器层面无解 |
| **WebDAV（客户端）** | ✅ **唯一候选** | 纯 HTTP 动词（RFC 4918），认证走 Authorization 头，与 S3 同信任域；约束同 S3——服务端开 CORS |
| WebDAV（服务端） | ❌ 不做 | 沿袭竞品对标「明确不做」清单：本应用始终是存储的消费端 |

## 三、目标与非目标

**目标（v1 面）**：连接向导接入 / 目录树+列表浏览 / 搜索（IDB 名字索引复用）/ 上传（小文件直传；大文件按 §W4 矩阵）/ 下载（含打包下载）/ 预览（全渲染器）/ 在线解压 / mkdir/rename/remove 基础操作。

**非目标（v1 明确缺省，能力门控隐藏而非报错）**：

- 回收站 / 历史版本（WebDAV 无桶版本概念）
- 信封分享与上传直链（无预签名概念；安全模型差异见 §W5 特例）
- 断点续传的服务端无关承诺（视 Content-Range 支持而定，§W4）
- Digest 认证（P1）；LOCK/UNLOCK 写锁（P1，且仅作探测展示不强制）；quota 探测

## 四、总体设计

### W1 接入层：WebDavClient implements S3Client（零破坏性变更）

**事实**：协议层已抽象——`S3Client` 接口（`frontend/src/sdk/types.ts:183`）必选 11 方法 + 可选 6 能力方法；可选成员即既有能力门控机制（版本三方法缺省 → 回收站/历史版本入口自动隐藏，v1.3 已验证的范式）。装配点唯一：`frontend/src/files/setup.ts:40` `new S3SigV4Client(backend, fetcher)`。

**裁决 W1**：不改 `S3Client` 接口签名，新增第二实现 `WebDavClient`；`setupStores` 按 `backend.type`（新增 `'s3' | 'webdav'`，缺省 `'s3'` 向后兼容）分流构造。宿主 JSSDK 命令层（19 条）、UI、tree-store、上传/下载队列全部复用，无感切换。

必选方法映射：

| S3Client 方法 | WebDAV 实现 | 注记 |
|---|---|---|
| `list(prefix)` | `PROPFIND Depth:1` | 解析 207 multistatus XML（§W3）；目录=collection、文件=response |
| `get(key, {rangeHeader})` | `GET`（透传 Range） | 预览渲染器与打包下载零改动 |
| `put(key, body, contentType)` | `PUT` | |
| `head(key)` | `HEAD` | 读 Content-Length/ETag/Last-Modified |
| `copy(from, to)` | `COPY` | `Destination` 头 + `Overwrite: T` |
| `remove(keys)` | `DELETE` ×N | 沿既有批删语义（tree-store.ts:313 分批） |
| `createMultipart/uploadPart/completeMultipart/abortMultipart` | **无标准协议** | §W4 分流矩阵，接口层面语义保真（实现可以是探测通过的 Content-Range 分块，或降级抛「不支持」由队列降级） |

**缺省的可选方法**（WebDavClient 全不实现）：`getPresignedUrl` / `presignPutUrl` / `getBucketVersioning` / `listObjectVersions` / `deleteVersion` / `listMultipartUploads`。对应 UI 面门控隐藏**全部既有，零新增门控工作项**：分享双能力探测（`ShareDialog.vue:79` 两者皆为 function 才开）、版本下载（`Home.vue:543` 处于版本门控面内）、回收站/历史版本（版本三方法既有门控）、孤儿清理（无 `listMultipartUploads` 不启用）、媒体直链走既有 Blob 兜底（`apps/datasource.ts:59`「可选能力缺位→不提供直链」，见矩阵 ✓* 注记）。

### W2 目录语义分流（关键裁决——S3 目录标记 ≠ WebDAV collection）

**事实**：S3 世界目录是前缀约定——`tree-store.ts:264` mkdir = `put(0 字节对象)` 目录标记。WebDAV 目录是 first-class collection（`MKCOL`）；对 collection 路径按 S3 语义 PUT 尾斜杠 0 字节「标记」，多数服务器返回 409/502，或干脆生成一个名为 `dir/` 的真实脏文件。

**裁决 W2**：client 暴露目录语义声明（新增可选接口成员，如 `directorySemantics?: 'marker-object' | 'collection'`），tree-store 的 mkdir 与目录树拼装按声明分流：

- `marker-object`（现状，S3）：零改动；
- `collection`（WebDAV）：mkdir → `MKCOL`（含逐级 409 前置补建）；PROPFIND 返回的 collection 在树模型中归一为现有「前缀」概念，**不落 0 字节标记对象**。

rename 既有实现 = `copy` + `remove`（`tree-store.ts:280-281`），**文件**对 WebDAV 语义正确（COPY+DELETE）；**目录** rename 走 `renameDir` 逐对象 copy（`tree-store.ts:294`）——S3 前缀无需实体存在，WebDAV 目标祖先 collection 不存在则 COPY 409，须逐级 `MKCOL` 幂等补建（已存在=409 容忍）。**目录删除同理分流**：`remove` 现按 S3 平铺展开逐对象批删（`tree-store.ts:320-322`），collection 不是 key、平铺删完子对象后**本体永远删不掉（空目录残留）**→ collection 语义下目录删除=单发 `DELETE`（RFC 4918 递归删内部成员），比 S3 平铺更高效，删除面无续跑诉求可接受。`MOVE`（单次往返+保留属性+目录整体改名一步到位）为 P1 优化，非必需。

### W3 协议细节与解析

- **multistatus XML**：`DOMParser` 解析 207 响应，`DAV:` 命名空间；`resourcetype` 含 `collection` 判目录；`getcontentlength`/`getlastmodified`/`getetag` 透出树与列表所需字段；`href` 须 URL-decode 且做百分号编码陷阱处理（服务器可能双重编码）。
- **错误映射**：401 → `CREDENTIAL_INVALID`；**403 → 资源级权限拒绝（ACL），不得映射为凭证失效**——S3 正本（`sdk/types.ts:181`）以 403 表凭证无效，WebDAV 世界 401/403 语义相反，照搬会把「无权限删某文件」误报成需要重新连接；404 → 存在性判断；409 → 父目录缺失（MKCOL 逐级补建场景）；423 Locked → 明确文案（v1 无写锁，只读冲突提示）；507 → 容量满。非 2xx → `SdkError(S3_ERROR, detail=status)`——错误码体系与 S3 同构，状态码语义按协议差异分流。
- **编码**：规范按 UTF-8；历史服务器非 UTF-8（GBK 类）文件名**不承诺正确**，实机取证批次如实记录（对照 zip-reader 已有的 GBK 处理经验，但 WebDAV 无「声明编码」字段，不做过届自动猜测）。
- **认证**：v1 仅 **Basic**（WebCrypto 无 MD5，Digest 的 MD5 变体需引入纯 JS 实现；RFC 7616 SHA-256 变体可 WebCrypto → P1）。401 + `WWW-Authenticate` challenge 处理：v1 遇 401 即判凭证无效，不做协商重试。
- **遍历深度**：不依赖 `Depth: infinity`（服务器普遍禁用）——树懒展开本就逐层 `Depth:1`，搜索走 IDB 名字索引不受影响。

### W4 上传管线分流（诚实降级面）

**事实**：`>16MB` 走 multipart（`upload-queue.ts:196` 阈值、`:195` 单片 8MB、单片间隔退避）；checkpoint 按 fingerprint+partSize 双校验落 IDB（`checkpoint-store.ts:19`）；≤阈值单 PUT 全程不写断点（`:412`）；进度口径 = **分片确认累计**（`:35`，每片必调，非字节级 onprogress——故纯 fetch 可满足，无需 XHR 分支）。

WebDAV 无标准 multipart，v1 矩阵：

| 服务端能力 | 行为 | checkpoint |
|---|---|---|
| ① 支持 `PUT Content-Range` 续写（**非标扩展**——HTTP Range 语义只为 GET 定义（RFC 9110 §14.2），支持此扩展的服务器属少数且行为各异） | 四个 multipart 方法以「**旁路临时对象分块续写 + 完成时 `MOVE` 覆盖目标**」实现（Nextcloud chunked v2 同型）：分块写 `.<name>.mmagix-part` 类临时键；completeMultipart=`MOVE` 到目标；abortMultipart=删临时对象（**不得直写目标路径**——中断残缺文件会直接对用户可见，且无服务器会话可 abort）；uploadId=客户端合成 ID，part etag 口径（响应 ETag 或客户端校验值）在契约档案固化；队列/并发/退避照常 | 照常落 IDB，断点续传成立（续写对象为临时键） |
| ② 不支持 | 队列降级**整包 PUT**（阈值对该数据源视为 ∞）；>上限（默认 1GB，可配）明确拒收报错 | 不写断点（诚实：无续传） |

- 探测裁决：**无标准化探测方法**——`HEAD Accept-Ranges` 只证明读可续、不证明写可续。故不写「自动探测」，改走**服务器家族配置表**（连接档案可选「支持分块续写」开关，缺省关=安全降级），known-good 清单由实机取证批次维护。
- 单 PUT 路径的进度：保持既有粒度（开始 0 → 完成 total），不承诺字节级——与 S3 ≤16MB 路径口径一致。

### W5 能力探测与门控矩阵

连接测试阶段一次探测（结果进连接档案，沿 sessionStorage 备份链，`boot.ts`）：

1. `OPTIONS /` → 读 `DAV:` 头（class 1/2/3 判定，仅展示不承诺）；
2. `HEAD` 试读 → `Accept-Ranges`；
3. `MKCOL` 临时目录 + `DELETE` 清理 → 写权限实证（失败=只读提示，沿用 denyExts 拒收 toast 的 UX；DELETE 失败残留空目录时 best-effort 复删，容忍失败）。

门控矩阵（功能 × 数据源）：

| 功能面 | S3 | WebDAV v1 |
|---|---|---|
| 树/列表/多选/⌘K/搜索/下载/打包下载 | ✓ | ✓ |
| 预览 | ✓ | ✓* 渲染器无直链时走**既有 Blob 兜底**（`apps/datasource.ts:59`、`renderers/media.ts:9`「blob: 无 Range 语义」）——媒体类全量拉取后播放、流式 seek 退化；文档/图片 fetch 流不受影响。零新增工作，体验代价如实标注 |
| 在线解压（zip-reader） | ✓ | ✓——`RangeReader`（`zip-reader.ts:52`）本就是抽象，新增 GET+Range 第二实现；EOCD 尾读/逐条目读全兼容 |
| 上传小文件（≤16MB） | ✓ | ✓ |
| 上传大文件 | ✓ multipart+断点 | 视 §W4 ①/② |
| 回收站 / 历史版本 | ✓（能力探测门控） | ✗ 隐藏 |
| 信封分享 / 上传直链 | ✓ | ✗ 隐藏（需新增 presigned 门控，见 W1） |
| 孤儿 uploadId 清理 | ✓ | ✗ 隐藏（无 listMultipartUploads） |

**分享特例（设计警示）**：信封加密包裹的是**预签名 URL**（自含凭证、短 TTL、无凭据暴露）。WebDAV 无预签名概念——若未来做，包的是 Basic 凭证本身：**长期有效、无 TTL 语义、泄露即根凭证**，安全模型完全不同，**不能照搬信封**。v1 不做，留待独立方案评估（含「服务端一次性 token」类方案——但那需要后端，大概率永远不做）。

### W6 连接向导与凭证通道

- `ConnectWizard.vue` 增「类型」段（S3 ｜ WebDAV；缺省 S3）。WebDAV 分支字段：服务器地址 / 根路径 / 用户名 / 密码 / 连接名称。既有 profiles（保存/连接/删除/测试）机制直接复用。
- 凭证生命周期不变：不进 URL/历史，sessionStorage 备份链重载；`setCredentials` 热替换通道（`sdk/types.ts:245`）语义照用（宿主可换 WebDAV 密码）。
- **SECURITY 注记**：Basic 凭证明文于每个请求头，生产强制 HTTPS 建议；TTL 自毁线对 WebDAV 密码的语义 = **前端主动遗忘**，非凭证真到期（服务器侧密码仍在）——文档如实标注差异，避免用户误以为有过期保护。

## 五、CORS：真正的第一道闸

浏览器直连 WebDAV 与直连 S3 受同一约束：**服务端必须回 CORS 头**，否则连接测试阶段即失败（连接向导的失败卡片按钮已兜住此场景）。

- 需允许的方法集：`OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE`；
- 需允许的请求头：`Authorization, Depth, Overwrite, Destination, If, Content-Type`；
- 需暴露的响应头：`ETag, Content-Length, Last-Modified, DAV`；
- **预检（preflight）是第一道断言**：PROPFIND/MKCOL/COPY/MOVE 均非简单请求，浏览器必先发 `OPTIONS + Access-Control-Request-Method`，服务器须 2xx 应答且方法在白名单内——预检失败=整个数据源不可用（连接测试首个检查项即此）。

**服务器支持矩阵（设计预期，落地以实机取证为准——诚实口径）**：

| 服务器 | CORS 预期 | 兜底 |
|---|---|---|
| Nextcloud | ⚠️ dav 端点默认不带 CORS 头，需服务器配置 | 反代加头 |
| Synology WebDAV Server | ⚠️ 须实测 | 反代加头 |
| 坚果云 | ⚠️ 须实测 | 不可自控则无解（诚实标注） |
| alist / OpenList | ⚠️ 须实测 | 反代加头 |
| 自建 Apache / nginx / Caddy WebDAV | ✓ 可配置 | 直接配 |

**兜底方案（不破红线）**：用户自有反向代理追加 CORS 头——nginx/Caddy 各一段现成配置入 `deployment.md`。代理是用户部署拓扑的一部分，与「自建 MinIO」同信任域，不是我们的后端。

## 六、测试策略

| 层 | 方法 |
|---|---|
| 协议层纯函数单测 | multistatus XML 解析（嵌套 collection/特殊字符/双重编码/缺字段容错）、错误映射表逐条、Destination/Copy 头构造、Range 分块算术 |
| fake WebDAV server | fetch 注入桩（沿 `client-versioning` 测试法；注意 jsdom realm 分裂坑——字节断言走 `Buffer.equals`） |
| 门控矩阵例 | §W5 每个「✗」断言对应入口不可达（回收站/历史版本/分享/直链/孤儿清理），复用能力门控测试范式 |
| 上传矩阵例 | ①路径：Content-Range 分块+checkpoint 往返；②路径：降级整包 PUT+超限拒收 |
| E2E 实机取证 | `test-report/` 证据链惯例，按服务器家族开批次（Nextcloud/Synology/alist 至少一批）；CI 无真机 → 单测门禁与实机批次互补，实机结论回填 §五 known-good 清单 |
| 质量闸 | vitest 覆盖率门禁 ≥80% 适用；vue-tsc / eslint 0 error |

## 七、里程碑（TDD，每步 ≤1000 行；测试先行沿既有节奏）

| 里程碑 | 内容 | 出口判据 |
|---|---|---|
| M1 协议层 ✅ 已落地（2026-11-02） | WebDavClient 骨架（list/get/put/head/copy/remove）+ XML 解析 + 错误映射 + fake server 单测 | 出口证据：parse+client 406 行、专项 45 例全绿；评审 2 轮（P0 单次解码等全修+复评通过）；门控缺省面（六可选方法缺席）断言齐 |
| M2 装配与浏览 ✅ 已落地（2026-11-02） | setup `backend.type` 分流 + 向导 WebDAV 分支 + 树/列表/搜索/下载打通 | 出口证据：全量首证 147 文件/1897 例 0 失败（五闸全绿）；向导类型段+endpoint URL 闸+i18n 17 键×2；评审 2 轮（setCredentials instanceof 守卫等全修+复评零新引入） |
| M3 写路径 ✅ 已落地（2026-11-02） | mkdir collection 语义分流（W2）/ rename / remove / 小文件上传 PUT / 解压 RangeReader 第二实现 | 出口证据：MKCOL 逐级补建/目录单发 DELETE/renameDir 祖先链+zip objectRangeReader 第二档（S3 路径逐字节零变更）；新增 24 例全绿；评审 P1 夹短误判修复已验 |
| M4 上传矩阵收口 ✅ 已落地（2026-11-02） | Content-Range 分块（①）+ 降级整包（②）+ 超限拒收 + 实机取证批次 + 文档联动 | 出口证据：三态矩阵+跨会话判活+完成前 probe 对账落地；终闸全量 151 文件/1972 passed+1 skipped 0 failed（vue-tsc 0/lint 0 error/哨兵 21 绿/build 26.35s）；评审 2 轮含 P0×2（串行泵提前 settle、对账重入伪重置）均修复实证；§八文档联动完成（实机取证批次留待有真机环境时另开） |
| P1 候选 | Digest(SHA-256) / MOVE 优化 / LOCK 探测展示 / 分享模型独立评估 / alist 网关连接预设 | 另立小方案 |

## 八、落地时文档联动清单（缺一不可，发版闸）

`architecture.md`（W 系并入 D 系+目录表 WebDavClient）· `deployment.md`（CORS 节+反代配置）· `user-guide.md`（向导 WebDAV 分支+门控可见面）· `SECURITY.md`（Basic/HTTPS/自毁线语义注记）· `PRD.md`（FR-18+：多数据源）· `jsdk-api.md`（命令层零变更则只加修订注记）· `CHANGELOG` + 当版测试报告/交付清单/验收报告三件。

## 九、风险与开放问题

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **CORS 支持面**（最大不确定项）——不少 WebDAV 服务器默认无 CORS 头 | M2 前置实机 spike；反代加头兜底；向导失败文案直接给解法指引 |
| 2 | `PUT Content-Range` 为非标扩展、支持碎片化，且无标准探测手段 | 家族配置开关（缺省关=安全降级）；known-good 清单随实机批次滚动 |
| 3 | 大目录性能（PROPFIND 逐层） | 沿树懒展开；不做 Depth:infinity 依赖；后续可选并发预热 |
| 4 | 非规范服务器行为（双重编码/缺 getetag/虚拟路径/**Destination 绝对与相对 URI 差异**——部分服务器旧版只认绝对 URI） | 解析容错 + 实机批次逐家记录；不承诺历史编码；Destination 采绝对 URI 构造（兼容面最大） |
| 5 | 并发写冲突（无 LOCK 时） | v1 只读提示（423 映射）；LOCK 为 P1 展示项 |
| 开放 | quota 探测、目录 mtime 展示口径、alist 预设是否入官方 profiles | 实现期裁决，记入契约档案 |
