# 官网重构方案 v2（site-redesign-v2）

> 状态：**方案正本——未实现、未动工**。动工前置条件 = `prototypes/` 12 屏原型中 **≥10 屏经用户确认**（当前 0/12，确认状态登记见 [prototypes/README.md](prototypes/README.md) §八）。**2026-11-04 范围裁决：仅 demo（mmagix-embed-demo），files SPA 零改动（用户指令）**。原型执行契约（给原型代理的画图口径）见 [prototypes/README.md](prototypes/README.md)。
> 基线：v1.4.0（tag `v1.4.0`，提交 `b832cf95`）。现状站点 = mmagix-embed-demo（dev 端口 5200）：`/` 落地页 + `/docs/:slug` 文档中心 + `/play/*` 在线演示（iframe 嵌 frontend SPA，postMessage 协议正本 [jsdk-api.md](../../design/jsdk-api.md)）。
> 证据：现状四张截图在本目录 [current-state/](current-state/)（before 状态，之后不再更新；改版后如需对比另建 after 目录）。
> 红线不破：**纯前端零后端**（[architecture.md](../../design/architecture.md) D 系裁决）——本方案是纯前端站点与应用的视觉/信息架构重构，不引入任何后端依赖。

## 一、背景与问题

### 1.1 用户判定

官网含在线 demo「**不人性化、看不懂、不可视化、理解困难**」。要求：分析 5+ 同类可视化产品设计 → 重构方案（前端重写，**原来的不删除**）→ **10+ 原型图确认后动工**。

### 1.2 before 证据（截图 + 代码锚）

| 截图 | 现象 | 代码锚 |
|---|---|---|
| [site-before-01-home-landing.png](current-state/site-before-01-home-landing.png) | 落地页 hero 视觉主体是**深色 JSON 代码面板**（mode/backend/allowedOrigins 配置片段），产品体验一帧未露 | `mmagix-embed-demo/src/views/Home.vue`（hero 签名注释 `config-in workspace-out twin panes`） |
| [site-before-02-home-mid.png](current-state/site-before-02-home-mid.png) | 首页中段能力区延续代码/表格叙事，无可视化资产 | 同上 |
| [site-before-03-docs.png](current-state/site-before-03-docs.png) | 文档中心=markdown 渲染单栏，与操作流无互链 | `mmagix-embed-demo/src/views/Docs.vue` + `src/docs/manifest.ts`（10 条 curated 清单） |
| [site-before-04-playground.png](current-state/site-before-04-playground.png) | 演示页=**14+ 配置字段表单墙**（backend.type/endpoint/region/bucket/prefix/accessKeyId/accessKeySecret/sessionToken/ttl… 术语怼脸）+ 橙色命令行说明块（brand-orange `#ff7d00`，`variables.scss:13`）+ 右侧 iframe「未装载」空态 | `mmagix-embed-demo/src/views/embed/EmbedPlay.vue`（763 行）+ `src/views/embed/configBuilder.ts` |

### 1.3 诊断五条（重构的对症对象）

| # | 诊断 | 一句话 |
|---|---|---|
| P1 | hero 卖配置不卖体验 | 视觉主体是给开发者的 `#config` JSON，不是产品能做什么 |
| P2 | 演示无引导路径、术语无翻译 | 14+ 字段一次性怼脸；backend.type/endpoint/ttl 无一句人话定义 |
| P3 | 全站无可视化 | 无产品截图、无流程图、无图标叙事、无场景插画 |
| P4 | 连接失败=红字无诊断 | 失败只有一句红字，CORS/凭证/地址错混在一起没有分诊 |
| P5 | 文档与操作流脱节 | 文档中心单栏阅读，读到哪一步都跳不回演示去试 |

## 二、竞品借鉴（7 产品，URL 已逐一验证可访问，2026-11-04）

| # | 产品 | 已验证来源 | 借鉴点 | 落到哪屏 |
|---|---|---|---|---|
| 1 | Nextcloud | [Files 网页界面](https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webgui.html) · [分享](https://docs.nextcloud.com/server/stable/user_manual/en/files/sharing.html) | 网格/列表切换钮置于列表上方；缩略图叠印 Shared badge+链条图标；左侧虚拟视图（最近/收藏/分享/回收站）；详情侧栏三 tab（活动/分享/版本）；分享四具名预设（只读/可编辑/投递箱/隐藏下载）+密码/过期/备注 | S06 S07 S09 S10 |
| 2 | Alist（最同类） | [存储通用配置](https://alistgo.com/guide/drivers/common.html) | 驱动按用途分组；「Mount Path=对外显示的名称」一句话定义；下拉选项内联权衡提示（流量/兼容性）；目录 README 渲染 | S04 S05 S11 |
| 3 | MinIO | [Versioning & Rewind](https://www.min.io/blog/continuous-data-protection-versioning-rewind) · [Console 对象管理](https://docs.min.io/aistor/administration/console/managing-objects) | 右上传输状态按钮「有活动才出现」（实机观察）；Rewind/View deleted 作为浏览器一级操作——**版本/回收站=浏览器的两种时间状态**；指标时间窗选择 | S06 S08 S09 |
| 4 | Cloudflare R2 | [Get started（按意图选路径表）](https://developers.cloudflare.com/r2/get-started/) · [API tokens](https://developers.cloudflare.com/r2/api/tokens/) · [S3 API](https://developers.cloudflare.com/r2/api/s3/api/) | 按意图选路径的 onboarding（Workers API/S3/CLI/Dashboard 四行表）；凭证三件套同屏（AK+Secret「You will not be able to access your Secret Access Key again」+endpoint URL）；Next steps 渐进披露；region=`auto` 厂商直说「这是 S3 API 兼容层的值，不是我们的概念」 | S01 S04 S05 |
| 5 | Synology | [File Station · File Request](https://kb.synology.com/en-global/DSM/help/FileStation/file_request?version=7) | 底部停靠传输队列（实机观察）；File Request=「向这个文件夹收文件」具名化。**反例：拖拽静默失败**——我们改为拖入即显确认条 | S02 S08 S10 |
| 6 | Dropbox / OneDrive / Drive | [OneDrive 图标释义](https://support.microsoft.com/en-us/onedrive/what-do-the-onedrive-icons-mean) · [Dropbox 同步图标](https://help.dropbox.com/sync/sync-icons-windows) | 图标官方释义封闭集（每态一枚固定图标+固定含义，页面可查）；hovercard 零点击上下文；两层状态模型（聚合徽章+单项图标） | S03 S06 S12 |
| 7 | Cyberduck / Mountain Duck | [S3 协议页](https://docs.cyberduck.io/protocols/s3) · [打开连接](https://docs.duck.sh/cyberduck/connection) | 连接=书签卡片+状态灯三态（未连/空闲/忙碌）；协议驱动字段渐进披露（选 S3 不出现 FTP 字段）；诊断入口内联失败态 | S05 S11 |

> 反例（规避项，与借鉴同权重）：Nextcloud 分块上传进度停顿（实机观察）→ 我们的传输中心每条目必须显示分块粒度进度（S08）；Synology 拖拽静默失败 → 拖拽必须有即时确认（S08）；Alist「出售风波信任崩塌」（[competitive-analysis-v1.3.0.md](../../product/competitive-analysis-v1.3.0.md)）→ 官网叙事强调形态自洽「无可死后端」。

## 三、设计原则（P1–P5 对症）

| 原则 | 对症 | 含义 |
|---|---|---|
| 可视化优先 | P1 P3 | 产品实景（自绘界面板）做 hero 主视觉；SVG 图标叙事；场景插画 CSS/SVG 自绘；**不引外网图床/字体 CDN** |
| 先引导后表单 | P2 | 演示入口从「裸配置表单」改为四步引导（`/guide`）；每步只暴露当步字段，其余渐进披露 |
| 术语翻译 | P2 | 下表八条为**全站强制口径**（含原型与实施）；代码标识符在 help text 保留原文对应，不删（开发者仍可对照） |
| 诊断内联 | P4 | 失败态必须带分诊（CORS/凭证/地址三类）与修复动作，红字裸奔视为 bug |
| 文档贴操作流 | P5 | 文档壳换成与 S07 同款「内容+信息面板」双栏；文档内嵌「试一手」链到 `/guide` 对应步骤 |

### 术语翻译表（强制口径）

| 术语（代码标识符） | 界面文案（人话） | 备注 |
|---|---|---|
| `backend.type` | 存储类型（连到哪里） | 二选一卡：S3 对象存储 / WebDAV 服务器 |
| `endpoint` | 服务器地址 | |
| `region` | 区域标识 | 按厂商文档填；多数 S3 兼容实现 `us-east-1`/`auto` 可用（R2 文档原文：the region for an R2 bucket is `auto`） |
| `accessKeyId`/`accessKeySecret` | 访问密钥 ID / 访问密钥（仅显示一次） | 沿 R2 措辞：关掉这页就再也看不到 |
| `sessionToken` | 会话密钥（临时凭证，本地 AK/SK 模式可留空） | |
| `prefix` | 文件夹 | |
| `ttl` | 缓存有效期（列表多久自动刷新） | |
| `chunkedWrite` | 大文件自动分段、断点续传 | 说收益不说机制 |
| mount path | 挂载路径 = 你将看到的名字 | 沿 Alist「对外显示的名称」一句话定义 |
| 权限矩阵 | 具名预设（只读 / 可编辑 / 投递箱 / 隐藏下载） | 沿 Nextcloud 分享预设；投递箱沿 Synology File Request「向这个文件夹收文件」 |

## 四、目标与非目标

**目标**：新站四路由（`/`、`/guide`、`/sources`、`/docs` 新壳）+ 12 屏原型资产 + 术语翻译口径落地；Phase A 交付「连得上、看得懂、可视化的演示引导」。

**非目标**（本方案明确不做）：

- 不删除、不改写旧站任何一行（旧站整体迁 `/legacy/*`，零改动保留）；
- 不做 Phase B 的实施——S06–S10 是 frontend SPA 的**未来态提案**（2026-11-04 裁决后为**提案存档**，不入任何实施期，见下「files SPA 零改动」条），本方案只负责把「长什么样」画清楚；
- 不动 postMessage 协议（[jsdk-api.md](../../design/jsdk-api.md) 19 条命令零变更）、不动 frontend SPA 现有交互逻辑（「Phase B 前」时限随 2026-11-04 裁决取消，零改动无时限）；
- 不引外网图床/图标库/字体 CDN，插画全部 CSS/SVG 自绘；
- 不新增后端（5240 WebDAV 演示服务是既有 demo 脚本，`pnpm dev:webdav`，红线内）；
- **files SPA（frontend/）零改动**（2026-11-04 用户范围裁决）：S06/S08/S09/S10/S12 为应用未来态**提案存档**，不入任何实施期；
- **demo 功能 parity 红线**：新 demo 现有全部能力必须保留（8 个 act 命令 / uploadFiles 含 memory 目标 / setCredentials 续期 / 协议日志 / 主题语言 / 7 插件开关 / 过期自毁重载 / config 打码预览），配置语义复用既有 `configBuilder.ts` 纯函数。

## 五、重构架构（关键裁决）

### R1 并行重写，旧站保留

新站代码落 `mmagix-embed-demo/src/site2/`（组件）+ `src/views/site2/`（页面）——旧 `SiteLayout.vue`/`Home.vue`/`Docs.vue`/`EmbedPlay.vue` 零改动。旧站整体迁 `/legacy/*`，`/play/*` 原样保留（它是 iframe 宿主，被 `/guide` 复用构建配置）。

### R2 路由映射

| 路由 | 现状 | 改版后 | 说明 |
|---|---|---|---|
| `/` | 旧落地页（SiteLayout+Home） | **新落地页**（S01–S03） | |
| `/guide` | 无 | **新演示引导**（S04–S05） | Step4「打开文件管理器」→ 复用 `/play/workspace` iframe |
| `/sources` | 无 | **数据源管理**（S11） | Phase A 静态管理面（连S3/WebDAV 已支持的双协议） |
| `/docs/:slug?` | 旧文档中心 | **新文档壳**（S07 预览驱动双栏复用） | `src/docs/manifest.ts` curated 清单与 slug 零变更 |
| `/legacy` | — | 旧落地页（原 `/`） | |
| `/legacy/docs/:slug?` | — | 旧文档中心（原 `/docs`） | |
| `/play/overview｜workspace｜file` | 原样 | **原样保留** | 既有 `/overview`、`/embed/*` 重定向继续生效 |
| 未匹配 | 回 `/?` | 兜底重定向保留 | 沿现有 `pathMatch` 兜底 |

### R3 设计语言

延续 Cobalt 方向（现站 Hallmark 契约：Long Document · corridor · cobalt 映射项目 Fc token，见 `Home.vue:196` shape 注释），**视觉资产升级**：产品实景自绘界面板取代代码面板做 hero 主视觉；SVG 线性图标叙事（24px，stroke 1.5）；场景插画 CSS/SVG 自绘。原型期 token 见 [prototypes/README.md](prototypes/README.md) §三（落地时以 `src/styles/variables.scss` 项目 token 为唯一事实源）。

### R4 分期

| Phase | 范围 | 落点 | 风险 |
|---|---|---|---|
| **A** | S01–S05 + S11 + S07（仅文档壳用法）+ `/docs` 新壳 | mmagix-embed-demo（site2 纯增量） | 低——旧站与 frontend SPA 均零改动，新路由并行。S11 边界：最近连接存 localStorage，纯 UI 增量，无协议变化 |
| **B** | S06/S08/S09/S10 + S12（应用未来态：浏览/传输/版本/分享/移动端） | frontend SPA（**零改动**） | **提案存档（不排期）**——2026-11-04 用户裁决，不入任何实施期；原型仅作参考 |

## 六、12 屏原型清单

文件落 `prototypes/`，命名 `sNN-<英文蛇形>.html`。逐屏规格（尺寸/假数据/布局/借鉴/交互点）**全部在 [prototypes/README.md](prototypes/README.md) §六**，此处只列索引：

| 屏 | 文件 | 尺寸 | 内容 | 路由/落点 | Phase |
|---|---|---|---|---|---|
| S01 | s01-home-hero.html | 1440×900 | 新落地页首屏（实景界面板 hero） | `/` | A |
| S02 | s02-scenarios.html | 1440×900 | 场景三卡（NAS/团队分发/收文件） | `/` 第二屏 | A |
| S03 | s03-feature-map.html | 1440×900 | 能力地图（六组图标叙事+文档互链） | `/` 第三屏 | A |
| S04 | s04-guide-steps.html | 1440×900 | 演示引导四步 | `/guide` | A |
| S05 | s05-connect-diagnostics.html | 1440×900 | 极简连接表单+失败诊断分诊 | `/guide` step2 | A |
| S06 | s06-browse-grid.html | 1440×900 | 文件浏览网格未来态（虚拟视图/叠印徽章/详情侧栏） | frontend SPA 提案 | 提案存档（SPA 不改裁决） |
| S07 | s07-preview-split.html | 1440×900 | 预览双栏（渲染+信息面板；文档壳同款复用） | `/docs` + SPA 提案 | 文档壳入 Phase A，文件管理双用途=存档 |
| S08 | s08-transfer-center.html | 1440×900 | 传输中心（底部停靠/分块进度/拖拽确认） | SPA 提案 | 提案存档（SPA 不改裁决） |
| S09 | s09-versions-timeline.html | 1440×900 | 历史版本时间线 | SPA 提案 | 提案存档（SPA 不改裁决） |
| S10 | s10-share-wizard.html | 1440×900 | 分享向导（四具名预设三步） | SPA 提案 | 提案存档（SPA 不改裁决） |
| S11 | s11-sources-panel.html | 1440×900 | 数据源管理（书签卡+状态灯三态） | `/sources` | A |
| S12 | s12-mobile.html | 390×844×2 并排 | 移动端双视图（列表/预览） | 全站响应式基线 | 提案存档（SPA 不改裁决） |

## 七、原型工作流

1. 原型代理按 [prototypes/README.md](prototypes/README.md) 契约执行：先落 `tokens.css`，再逐屏产出 12 个自包含 HTML；
2. 用户逐屏确认，状态登记在 [prototypes/README.md](prototypes/README.md) §八状态表（待画/待确认/已确认/返工+返工点）；
3. **≥10 屏「已确认」即达动工门槛**——更新本文件状态行为「原型已确认（日期），Phase A 动工」，Phase A 按 §五 R2/R4 实施；
4. 未达 10 屏不得动工；返工只改 HTML 原型，契约变更须先改 [prototypes/README.md](prototypes/README.md) 再改图（契约先行）。

## 八、实施风险

| 风险 | 处置 |
|---|---|
| 旧站迁 `/legacy/*` 断外链 | README/CHANGELOG/docs 中的站内锚（如首页「能力一览」hash）在 `scrollBehavior` 中保留同名锚点；`/overview`、`/embed/*` 既有重定向不动 |
| `/guide` 复用 iframe 影响演示 E2E | `/play/*` 路由与 postMessage 协议零改动；embed 相关既有测试（`src/views/embed/__tests__`）不迁移不改写 |
| 新站 i18n 键冲突 | 新键一律 `site2.*` 命名空间，旧 `site.*` 原样保留给 `/legacy` |
| 文档 slug 断链 | `src/docs/manifest.ts` 的 slug 与分组键零变更，只换壳 |
| Phase B 被误当已排期 | 本文件与原型图头部均标注「提案存档（不排期）」——2026-11-04 裁决后不入任何实施期（若未来裁决翻转，仍沿 v1.2.0 双档案惯例另立契约） |

## 九、验收标准（本方案层级）

1. `prototypes/` 下 `tokens.css` + 12 个 HTML 齐备；逐屏可双击浏览器打开；`grep -l '<script' prototypes/*.html` 零命中；外链资源零引用；文案全中文真实（无 lorem、无 emoji）。
2. [prototypes/README.md](prototypes/README.md) §八状态表登记用户确认结果，**≥10 屏「已确认」**。
3. 本文件状态行更新（§七.3），Phase A 才允许开第一行代码。
4. Phase A 交付时的验收（旧站可回访、路由映射逐条 200、E2E 不回归）属于届时另立的交付清单/验收报告，**不在本文件承诺范围**。
