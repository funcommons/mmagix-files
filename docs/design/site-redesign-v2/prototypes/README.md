# 原型设计契约（site-redesign-v2 · 12 屏）

> 读者：**执行画图的原型代理**。本文是唯一画图口径——规格具体到假数据与布局结构，照画即可，不猜。
> 输入：[../plan.md](../plan.md)（重构方案正本：诊断五条 P1–P5、七产品借鉴、术语翻译表、路由映射）+ [../current-state/](../current-state/) 四张 before 截图（只看不改）。
> 产出：本目录下 `tokens.css` + 12 个自包含 HTML 原型。**不写任何 Vue/TS 代码，不碰仓库其他文件。**
> 状态门槛：≥10 屏「已确认」（§八状态表）才允许 Phase A 动工（plan.md §七）。

## 一、交付物与目录

```
prototypes/
├── README.md            # 本文（契约 + §八确认状态表）
├── tokens.css           # 第一个产出：全 12 屏共享的设计 token
├── s01-home-hero.html
├── s02-scenarios.html
├── s03-feature-map.html
├── s04-guide-steps.html
├── s05-connect-diagnostics.html
├── s06-browse-grid.html
├── s07-preview-split.html
├── s08-transfer-center.html
├── s09-versions-timeline.html
├── s10-share-wizard.html
├── s11-sources-panel.html
└── s12-mobile.html
```

## 二、技术约定（硬性，逐条可 grep 验证）

1. **纯 HTML + 内联 CSS**：无框架、无构建、无 `<script>`（交互一律静态呈现：当前态直接画出来；展开态用 `<details>/<summary>` 或 CSS `:hover`/`:focus-within`）；单个 `<style>` 块放 `<head>`。
2. **每屏自包含**：双击即可浏览器打开；唯一外部引用是 `<link rel="stylesheet" href="tokens.css">`；**零外网资源**（无图床、无图标库 CDN、无 webfont）。
3. **画框**：桌面屏统一 1440×900 固定画框（`body` 用 `--paper-deep` 灰底居中，画框顶部加一条 28px 标签条：屏号/名称/对应路由/Phase/借鉴来源，字用 `--ink-faint`）；S12 例外，见 §六 S12。
4. **字体**：系统字体栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`；代码片段用 `ui-monospace, "SF Mono", Menlo, Consolas, monospace`。
5. **图标**：内联 SVG（线性，24px 视框、stroke 1.5、`stroke="currentColor"`，禁 emoji、禁位图、禁外链）。同类图标在整个原型集里**同一含义只用同一种画法**（封闭集，沿 OneDrive/Dropbox 官方释义口径）。
6. **文案**：全中文真实文案，禁 lorem/占位符；假数据只准用 §四 的种子集；代码标识符（如 `accessKeyId`）可出现在 help text 小字里作对照，不得作为主标签。
7. **颜色**：一律引用 tokens.css 变量；SVG 内允许 `currentColor`；硬编码 hex 仅允许出现在 tokens.css 本身。
8. **截图**：不使用任何真实截图文件。所谓「产品实景」一律自绘界面板（HTML/CSS 拼出文件树、列表、预览——种子数据见 §四）。

## 三、tokens.css 契约

原型代理的第一个产出。变量名固定如下；值沿 Cobalt 方向映射（信号蓝取原型代表值 `#2563eb`，与现站主按钮视觉一致；**site2 落地时以 `src/styles/variables.scss` 的项目 token 为唯一事实源，本表不是落地值**）：

```css
:root {
  /* 面 */
  --paper: #f7f8fa;          /* 纸面（页面底） */
  --paper-raised: #ffffff;   /* 浮起面（面板/卡） */
  --paper-deep: #eef0f3;     /* 更深一档（画框外围、井底） */
  /* 墨 */
  --ink: #1f1f1f;            /* 主文本 */
  --ink-soft: #5e5e5e;       /* 次文本 */
  --ink-faint: #909399;      /* 弱文本/标签条 */
  /* 钴蓝信号（唯一强调色） */
  --signal: #2563eb;
  --signal-deep: #1d4ed8;    /* hover/按下 */
  --signal-wash: rgba(37, 99, 235, 0.08);  /* 一行 wash / 选中底 */
  /* 状态（仅这三处允许语义色） */
  --ok: #15803d;
  --warn: #ff7d00;           /* = 现站 brand-orange，仅用于传输进行态/警示 */
  --danger: #dc2626;
  /* 线与形 */
  --hairline: #dcdfe6;       /* 发丝线 */
  --radius: 10px;
  --radius-sm: 6px;
  --shadow-card: 0 1px 2px rgba(31, 31, 31, 0.06), 0 8px 24px rgba(31, 31, 31, 0.08);
  /* 距离 */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 40px;
}
```

另附两条公共规则（写进 tokens.css 底部）：`*:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }`；一切过渡动画包在 `@media (prefers-reduced-motion: no-preference)` 里。

## 四、统一假数据（全 12 屏共用，与演示种子一一对应）

**种子文件**（真实存在于 `mmagix-embed-demo/webdav-data/` 与 `s3-data/mmagic-demo/`，原型按此画名称/类型/时间）：

| 名称 | 类型 | 大小 | 修改时刻 | 状态徽章 |
|---|---|---|---|---|
| hello.md | Markdown | 287 B | 2026-11-04 09:12 | — |
| notes/meeting.md | Markdown | 3.4 KB | 2026-11-03 18:40 | 已分享（链条图标） |
| notes/草稿 v2.md | Markdown | 2.1 KB | 2026-11-04 08:05 | 3 个版本（角标） |
| demo.csv | 表格 | 18 KB | 2026-10-28 10:05 | — |
| logo.svg | 图片 | 6.8 KB | 2026-10-28 10:05 | — |
| reports/2026q4.md | Markdown | 1.9 KB | 2026-11-02 14:30 | —（仅 S06 虚拟视图用） |

**连接参数**（两组真实演示值，术语翻译后呈现）：

| 项 | S3 对象存储 | WebDAV 服务器 |
|---|---|---|
| 服务器地址（endpoint） | `http://localhost:9000` | `http://localhost:5240` |
| 区域标识（region） | `us-east-1` | — |
| 存储空间（bucket） | `mmagic-demo` | — |
| 文件夹（prefix） | `sessions/demo/` | `/`（rootPath） |
| 访问密钥 ID | `rag_flow` | 用户名 `dav-user` |
| 挂载路径 | `/demo` | `/nas` |

**传输与分享**：上传中 `demo-upload.mp4` 67%（分块 3/5，已保存进度）；等待中 `presentation.pptx`；已完成 `archive.zip` 12.4 MB · 4 秒；失败 `photo-2026.tif` 网络中断。分享链接 `https://demo.mmagix.app/?share=8f3k`，密码 4 位「仅显示一次」，有效期至 2026-11-11。

**端口事实**（文案可引用）：5199=frontend SPA dev；5200=embed demo 官网；5240=WebDAV 演示服务（`pnpm dev:webdav`）；9330=examples dev。

## 五、sloplint 反 slop 铁律（违反任一条即返工）

1. 无紫蓝渐变、无发光标题、无装饰性大色块渐晕；背景只用 `--paper` 系。
2. **一处一个主按钮**：整屏实心 `--signal` 按钮至多一枚，其余为描边/文字按钮。
3. 无卡中卡：嵌套圆角容器至多一层；`--shadow-card` 只给最外层面板。
4. `focus-visible` 必须可见（token 已内置）；一切动画受 `prefers-reduced-motion` 门控。
5. 无 emoji、无 lorem、无「示例文字」占位——空位必须画出真实内容。
6. 无存活感装饰（无自动轮播/闪烁/漂浮）；hover 抬升 ≤2px。
7. 图标封闭集：同一含义一种画法；不混线性/面性。
8. 信号色克制：`--signal` 只用于主按钮、当前态、链接与状态灯；`--warn`/`--danger` 只用于传输与诊断。

## 六、12 屏规格

### S01 home-hero（1440×900 · `/` · Phase A）

**目的**：根治 P1——hero 视觉主体从 JSON 代码面板换成产品实景。

**布局**（banner 导航 + corridor hero + 信任条）：

- **Banner 导航（高 64，发丝线夹底）**：左=文件夹 SVG mark + 「MMagiX Files」；中=导航「首页 / 功能 / 文档 / 在线演示」；右=「EN」「外观」文字钮。
- **Hero（左右 5:7 corridor）**：左列——h1 沿用现站主标题「纯前端文件工作台，接你自己的桶」；lede「S3 与 WebDAV 直连，凭证即配置，无需业务后端。」；新增一行小字「下面就是它的真实界面——不是概念图。」；按钮两枚：主=「5 分钟连上你自己的桶」（→/guide），次=「直接打开在线演示」（→/play/workspace）。右列——**自绘浏览器框**（圆角+顶部红黄绿三点+地址栏 `mmagix.demo/files`）：框内三分栏=左侧目录树（`reports/`、`notes/`、`hello.md`、`demo.csv`、`logo.svg`）+中间文件列表（§四种子 4 行，demo.csv 行叠印链条徽章）+右侧 `hello.md` 渲染预览（标题「你好，MMagiX」+ 3 行正文 + 一条列表）；框底叠一枚胶囊条「真实界面 · iframe 嵌入 · 零后端」。
- **信任条（三枚横排，图标+短句，发丝线分隔）**：「零后端——浏览器直连 S3/WebDAV」「可嵌入——postMessage 协议 19 条命令」「可扩展——6 个官方插件」。

**借鉴**：Cloudflare R2 按意图先行的 CTA（[get-started](https://developers.cloudflare.com/r2/get-started/)）；Nextcloud 实景界面叙事（[access_webgui](https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webgui.html)）。

**关键交互点**：主按钮唯一；hero 界面板第二行 hover 出现 focus 描边（示意活界面）；信任条图标线性 SVG 三枚（云/插头/拼图）。

### S02 scenarios（1440×900 · `/` 第二屏 · Phase A）

**目的**：按意图叙事（P2）——用户先认场景，再见表单。

**布局**：页头（标题「它适合谁？」+ 副句「三种最常见的打开方式」+ 右侧一枚主按钮「打开在线演示」）；下方三等分卡栅格：

1. **家庭 NAS 照片库**——插画=房子+硬盘+照片堆 SVG 线稿；文案「Synology / 坚果云开 WebDAV，浏览器直接管家里的文件」；「你会用到」两行：服务器地址 `http://localhost:5240` · 挂载路径 `/nas`；入口链「试试这个场景 →」（→/guide）。
2. **团队只读分发**——插画=书架+两个人；「对象存储当官网附件库，发一个只读链接」；两行：存储空间 `mmagic-demo` · 具名预设「只读」；入口链同上。
3. **向客户收文件**——插画=托盘+上传箭头；「发一个投递箱链接，对方只进不出」；两行：具名预设「投递箱」· 有效期至 2026-11-11；入口链同上。

**借鉴**：R2 按意图选路径表（[get-started](https://developers.cloudflare.com/r2/get-started/)）；Synology File Request 具名化（[file_request](https://kb.synology.com/en-global/DSM/help/FileStation/file_request?version=7)）。

**关键交互点**：卡 hover 抬升 2px（reduced-motion 降级为无动画）；三张卡入口均为次级链，全屏唯一主按钮在页头。

### S03 feature-map（1440×900 · `/` 第三屏 · Phase A）

**目的**：可视化能力总览（P3）+ 文档互链（P5）。

**布局**：标题「它能做什么」；2×3 六组能力区（发丝线分隔，无卡片阴影，避免卡中卡）：

| 组 | 图标 | 条目（每条一句人话） | 「深入了解」锚 |
|---|---|---|---|
| 浏览与预览 | 网格 | 网格/列表双视图；md/图片/CSV/PDF 直接看 | /docs/user-guide |
| 上传与传输 | 上箭头 | 拖拽上传；大文件自动分段、断点续传 | /docs/user-guide |
| 分享 | 链条 | 四具名预设（只读/可编辑/投递箱/隐藏下载）+密码/过期 | /docs/user-guide |
| 版本与回收站 | 时钟 | 历史版本一键恢复；删除先进回收站 | /docs/changelog（能力入史见 v1.2.0 段） |
| 插件 | 拼图 | 6 官方插件：表格/PDF 标注/Markdown/HTML/播放器/图片编辑 | /docs/plugin-system |
| 嵌入 | 插头 | iframe + postMessage，19 条命令，SRI 校验 | /docs/jsdk-api |

**借鉴**：OneDrive/Dropbox 图标官方释义封闭集（[OneDrive](https://support.microsoft.com/en-us/onedrive/what-do-the-onedrive-icons-mean)、[Dropbox](https://help.dropbox.com/sync/sync-icons-windows)）；R2 Next steps 渐进披露。

**关键交互点**：每条目 hover 显示内联提示（CSS tooltip），至少「断点续传——关掉浏览器再打开，从 67% 继续」一条要画出来。

### S04 guide-steps（1440×900 · `/guide` · Phase A）

**目的**：演示从「裸表单」改四步引导（P2）。

**布局**：页头（标题「五分钟连上你自己的桶」+ 四段进度条，当前=第 1 步）；主体左右 4:8——左侧竖步骤条（1 选存储类型 → 2 填三件套 → 3 起名字 → 4 试一手，当前步高亮 `--signal` 竖线），右侧当前步详情面板：

- **步骤 1 画出**（本屏主内容）：二选一存储类型卡两张——「S3 对象存储：连到哪里——AWS / 阿里云 OSS / MinIO / Cloudflare R2」「WebDAV 服务器：连到哪里——Synology NAS / 坚果云 / alist 网关」；S3 卡为选中态（`--signal-wash` 底+描边）；卡底小字对照 `backend.type`。
- **步骤 2–4 各画一条缩略行**（右侧面板下方发丝线之下，收起态）：「2 填三件套——服务器地址+访问密钥 ID+访问密钥（仅显示一次）」「3 起名字——挂载路径=你将看到的名字」「4 试一手——点一下，绿了就进文件管理器」。

**借鉴**：R2 凭证三件套同屏+「仅显示一次」（[api/tokens](https://developers.cloudflare.com/r2/api/tokens/)）；Alist「Mount Path=对外显示的名称」（[common](https://alistgo.com/guide/drivers/common.html)）。

**关键交互点**：进度条当前段填充；右下唯一主按钮「下一步」。

### S05 connect-diagnostics（1440×900 · `/guide` step2 · Phase A）

**目的**：根治 P4——失败=红字裸奔改为分诊+修复动作；同时演示字段渐进披露（14+ 字段墙 → 5 字段+折叠）。

**布局**（左右 5:7）：

- **左=连接表单**：5 个字段——存储类型（WebDAV 选中）/ 服务器地址 `http://localhost:9000` / 访问密钥 ID `rag_flow` / 访问密钥（密码框，占位「仅显示一次」）/ 挂载路径 `/demo`；每字段标签下有一行 help text（术语翻译口径，如挂载路径「=你将看到的名字」）；下方折叠 `<details>`「高级（可选）」：区域标识 `us-east-1`、文件夹 `sessions/demo/`、会话密钥（可留空）、缓存有效期 3600 秒（列表多久自动刷新）。
- **右=结果面板（失败态为本屏主角）**：诊断卡——红点+标题「连不上 `http://localhost:9000`」；三条分诊 `<details>`，每条=可能原因+展开修复步骤：
  1. 「浏览器被 CORS 挡住（最常见）」→ 修复四要素清单：`AllowedOrigins` 加 `http://localhost:5200` / `AllowedMethods` GET·PUT·POST·DELETE·HEAD / `AllowedHeaders` `*` / `ExposeHeaders` 加 `ETag`（缺这条大文件上传必败）；
  2. 「凭证被拒」→ 检查密钥成对；「密钥仅显示一次，丢了就重新签发」；
  3. 「服务器没开或地址打错」→ 「演示服务没起？跑 `pnpm dev:webdav`（端口 5240）」。

**借鉴**：Cyberduck 诊断内联失败态（[protocols/s3](https://docs.cyberduck.io/protocols/s3)）；Alist 选项内联权衡提示（[common](https://alistgo.com/guide/drivers/common.html)）；R2 region 口径（[s3/api](https://developers.cloudflare.com/r2/api/s3/api/)）。

**关键交互点**：`<details>` 展开修复步骤；诊断卡底部唯一主按钮「重新连接」；成功态不画（本屏专讲失败）。

### S06 browse-grid（1440×900 · frontend SPA 提案 · Phase B）

**目的**：文件浏览的未来态提案（P3 在应用内的落法）。

**布局**（应用壳三栏）：

- **左侧虚拟视图栏（220px）**：全部文件 / 最近 / 收藏 / 共享 / 回收站（五项，图标+计数徽章，当前=全部文件）。
- **主区**：工具条（上传 · 新建文件夹 · 搜索框 · **网格⿻列表切换钮置于列表右上方**，网格为当前态）；面包屑 `sessions/demo/`；网格视图 5 张缩略卡：`logo.svg`=自绘小图、`hello.md`=文本行缩略、`demo.csv`=迷你表格、`notes/meeting.md`=文档图标+**叠印链条图标**、`notes/草稿 v2.md`=文档图标+「3 个版本」角标。
- **右侧详情侧栏（320px）**：三 tab「活动 / 分享 / 版本」（当前=分享），内容=demo.csv 的分享记录一行（链条图标+「只读 · 至 2026-11-11」）。
- **底部聚合徽章条**（双层状态模型上层）：「2 项传输中 · 查看传输」——只在有活动时出现；画布右下角附无活动对照小图（角落虚线框注记「无活动时不出现」）。

**借鉴**：Nextcloud 网格切换钮位置/虚拟视图/叠印徽章/详情侧栏三 tab（[access_webgui](https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webgui.html)）；MinIO「有活动才出现」（[managing-objects](https://docs.min.io/aistor/administration/console/managing-objects)）；Dropbox 两层状态模型（[sync-icons](https://help.dropbox.com/sync/sync-icons-windows)）。

**关键交互点**：切换钮两态可辨；详情侧栏 tab 当前态；列表视图不另画整屏（同数据，S12 左机含列表形态）。

### S07 preview-split（1440×900 · `/docs` 新壳 + SPA 提案复用 · Phase A/B）

**目的**：预览双栏样板——文档中心新壳与文件预览**一套两用**（P5：文档贴操作流）。

**布局**（左右 7:5）：

- **左=内容栏**：`hello.md` 渲染成排版（H1「你好，MMagiX」+ 两段正文 + 一条 3 项列表 + 一段行内代码 `putObject`）；顶部条=文件名+关闭钮+「用 Markdown 编辑器打开」入口（插件叙事）。
- **右=信息面板**：元信息（大小 1.2 KB / 修改 2026-11-04 09:12 / 位置 `sessions/demo/`）；操作列四条（下载 / 分享 / 历史版本 / 重命名，图标+文字，hover 提示）；「最近打开」两条（今天 09:12 · 昨天 18:40）。

**借鉴**：Nextcloud 详情侧栏（[access_webgui](https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webgui.html)）；hovercard 零点击上下文（[OneDrive](https://support.microsoft.com/en-us/onedrive/what-do-the-onedrive-icons-mean) 同口径）。

**关键交互点**：「历史版本」行 hover 显示「→ 见 S09」注记；文档壳复用注记画在标签条（左内容右目录，slug 沿 manifest 十条）。

### S08 transfer-center（1440×900 · SPA 提案 · Phase B）

**目的**：传输可视化（P3）+ 修两个竞品反例。

**布局**：主区=文件列表做虚化背景（不抢戏）；**底部停靠传输队列面板**（展开态高 320，右上角收起钮；对照小图画 56px 收起态）。队列四行：

1. `demo-upload.mp4` 上传 67%——进度条+「分块 3/5 · 已保存进度」（断点续传可视化，规避 Nextcloud 进度停顿反例）；
2. `presentation.pptx` 等待中（`--warn` 圆点）；
3. `archive.zip` 已完成 ✓ 12.4 MB · 4 秒（`--ok`）；
4. `photo-2026.tif` 失败「网络中断」+ **重试按钮**（`--danger` 文字钮）。

**拖拽确认层**：列表上方画半透明虚线覆盖框「松手即上传 3 个文件」（修 Synology 拖拽静默失败反例）。右上角入口按钮「传输 2」+圆点徽章（有活动才出现）。

**借鉴**：Synology 底部停靠传输队列（[file_request](https://kb.synology.com/en-global/DSM/help/FileStation/file_request?version=7) 同族实机观察）；MinIO「有活动才出现」（[managing-objects](https://docs.min.io/aistor/administration/console/managing-objects)）。

**关键交互点**：进度条必须画到分块粒度（3/5 刻度）；失败行重试可点态；全屏唯一主按钮=「继续全部」。

### S09 versions-timeline（1440×900 · SPA 提案 · Phase B）

**目的**：版本=浏览器的第一种时间状态（MinIO Rewind 口径），可视化恢复（P3）。

**布局**（中央 7:5）：

- **左=竖向时间线**（`notes/草稿 v2.md`，三节点）：v3 今天 2026-11-04 09:12（当前，`--signal` 竖线）备注「补充了行动项」/ v2 昨天 2026-11-03 18:40「改了预算数字」/ v1 2026-10-28 10:05「初稿」；每节点=时刻+大小+备注+三操作（预览/恢复/下载）。文件名叫「草稿 v2」而版本到 v3 不矛盾——标签条加一行注记「文件名是名字，版本是历史」。
- **右=对比预览**：v2 vs v3 两栏 diff 摘要（2 处增 `--signal-wash` 底、1 处删删除线）+ 摘要行「净增 340 字节」。

**借鉴**：MinIO Rewind（[versioning-rewind](https://www.min.io/blog/continuous-data-protection-versioning-rewind)）；Nextcloud 版本 tab（[access_webgui](https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webgui.html)）。

**关键交互点**：「恢复到 v2」全屏唯一主按钮；hover 节点显示 diff 摘要 tooltip。

### S10 share-wizard（1440×900 · SPA 提案 · Phase B）

**目的**：权限矩阵→具名预设（P2）。

**布局**（居中 560px 弹层，三步指示点「1 选预设 · 2 加固 · 3 完成」，当前=第 1 步为主，2/3 画在下层弱化）：

- **第一步=四具名预设卡 2×2**：只读「只能看和下载」/ 可编辑「能改能传」/ 投递箱「只进不出——向这个文件夹收文件」/ 隐藏下载「看得见，下载按钮藏起来」；当前选中=只读（`--signal-wash` 底）。对象=`notes/meeting.md`。
- **第二步=加固选项（弱化呈现）**：密码 4 位「仅显示一次」/ 有效期至 2026-11-11 / 备注给对方「会议纪要，看完可删」。
- **第三步=结果态（弱化呈现）**：链接 `https://demo.mmagix.app/?share=8f3k` + 复制钮 + 警示条「密码只显示这一次」（`--warn`）。

**借鉴**：Nextcloud 分享四预设+密码/过期/备注（[sharing](https://docs.nextcloud.com/server/stable/user_manual/en/files/sharing.html)）；Synology File Request 具名化（[file_request](https://kb.synology.com/en-global/DSM/help/FileStation/file_request?version=7)）。

**关键交互点**：预设卡单选态；「创建分享链接」唯一主按钮；四卡文案=术语翻译表强制口径逐字。

### S11 sources-panel（1440×900 · `/sources` · Phase A）

**目的**：连接=书签卡片+状态灯（Cyberduck 口径）；驱动按用途分组（Alist 口径）。

**布局**：页头（标题「数据源」+ 唯一主按钮「添加数据源」）；数据源卡列表三枚：

1. **S3 · mmagic-demo**——状态灯绿「已连接」；两行：服务器地址 `http://localhost:9000` · 挂载路径 `/demo`（+一句小字「=你在文件树里看到的名字」）；
2. **WebDAV · dav-server**——状态灯黄「空闲」；`http://localhost:5240` · `/nas`；
3. **失败例卡**——状态灯红「连不上 · 查看诊断」（内联诊断链 →S05，P4）。

下方「添加数据源」按用途分两列：**「对象存储（S3 / R2 / OSS / MinIO）」** 与 **「NAS 与网关（WebDAV：Synology / 坚果云 / alist）」**——选型即分组，不出现协议术语墙。

**借鉴**：Cyberduck 书签卡片+状态灯三态（[connection](https://docs.duck.sh/cyberduck/connection)）；Alist 驱动按用途分组+Mount Path 一句话定义（[common](https://alistgo.com/guide/drivers/common.html)）。

**关键交互点**：状态灯三态全画出（绿/黄/红）；失败卡内联诊断链；卡片无嵌套阴影。

### S12 mobile（390×844 双机并排画在同一 1440×900 画布 · 全站响应式基线 · Phase A/B）

**目的**：移动端双视图——Phase A 全站响应式的验收基准。

**布局**：1440×900 画布横向并排两台 390×844 手机框（圆角 40、留 60px 间距）：

- **左机=列表视图**：顶栏（logo+搜索图标）；面包屑 `sessions/demo/`；5 行文件列表（图标+名称+一行元信息「1.2 KB · 今天 09:12」，`demo.csv` 行叠印链条徽章）；底部 tab 栏「文件 / 传输 / 设置」（传输 tab 带圆点徽章 2）。
- **右机=预览视图**：顶栏（返回+文件名 `hello.md`+更多）；正文=同文件渲染（与 S07 同排版）；底部操作条三钮（分享 / 下载 / 更多）。

**借鉴**：Dropbox 两层状态模型（列表行图标态+tab 聚合徽章，[sync-icons](https://help.dropbox.com/sync/sync-icons-windows)）。

**关键交互点**：触控目标 ≥44px（在标签条注明）；两机数据一致（同一份 §四 种子）；底部 tab 栏=移动端唯一导航，无 hover 依赖。

## 七、逐屏验收（原型代理自检清单）

- [ ] 双击打开无控制台错误；无 `<script>`；`tokens.css` 外零资源引用（`grep -E 'https?://' *.html` 仅允许命中文案里的示例 URL）。
- [ ] 画框尺寸正确（S01–S11=1440×900；S12=双 390×844 同画布）；标签条五要素齐（屏号/名称/路由/Phase/借鉴）。
- [ ] 假数据与 §四 完全一致；文案全中文、无 lorem、无 emoji；术语翻译表口径逐字执行。
- [ ] sloplint 八条逐条过（§五）；每屏主按钮 ≤1。
- [ ] 屏内「关键交互点」全部以静态可见方式呈现（不是只写在注释里）。

## 八、确认状态表（动工门槛：≥10 屏「已确认」）

| 屏 | 文件 | 状态 | 确认人/日期 | 返工点 |
|---|---|---|---|---|
| S01 | s01-home-hero.html | 待画 | — | — |
| S02 | s02-scenarios.html | 待画 | — | — |
| S03 | s03-feature-map.html | 待画 | — | — |
| S04 | s04-guide-steps.html | 待画 | — | — |
| S05 | s05-connect-diagnostics.html | 待画 | — | — |
| S06 | s06-browse-grid.html | 待画 | — | — |
| S07 | s07-preview-split.html | 待画 | — | — |
| S08 | s08-transfer-center.html | 待画 | — | — |
| S09 | s09-versions-timeline.html | 待画 | — | — |
| S10 | s10-share-wizard.html | 待画 | — | — |
| S11 | s11-sources-panel.html | 待画 | — | — |
| S12 | s12-mobile.html | 待画 | — | — |

> 状态取值：待画 / 待确认 / 已确认 / 返工（返工须写明返工点并保留上一轮结论）。契约变更先改本文再改图；本文与 [../plan.md](../plan.md) 冲突时以 plan.md 为准。
