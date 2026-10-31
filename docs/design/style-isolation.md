# mmagix-files 应用打开防样式污染方案

> **【实施状态注记 · 2026-10-26 审计】** 核心裁决（同文档+约定式前缀为默认档、Shadow DOM/iframe 按需升级）与实现同向；本文 P0–P2 建议项**基本未执行**，现状盘点已过期：
> 1. 实际防污染机制=`mmagic-*`/`mm-*` 类名前缀执法 + 渲染器实例 `<style>` 注入随 dispose 移除（csv/mermaid/flow/code 均此模式）+ html-viewer 的 sandbox iframe（v1.1.0 抢先落地，文档未预见）
> 2. 未执行：孤儿 global.scss/_reset 清理、markdown 自排版（.mmagic-md）、index.scss @layer 分层、docx iframe 化
> 3. §1.2 盘点失效行：painter 渲染器已拆除；csv 非唯一自清理注入者；xlsx 已有完整样式（ExcelJS B 方案）


## 〇、头表

| 项 | 值 |
| --- | --- |
| 版本 | V1.0（2026-10-13 首版） |
| 状态 | **技术调研·建议案（候裁）**——本期只调研不改代码，文中代码均为目标样例 |
| 命题 | 「应用打开文件如何防样式污染？iframe 好不好？」 |
| 依据 | 《solution-design.md》V1.2 §4.6 应用模型；《plugin-system.md》V1.1 三信任档；《../product/PRD.md》§五验收（明暗双主题渲染无样式破损） |
| 定位 | 工作台预览区（`frontend/src/views/Home.vue` `.ws__preview-host`）内，渲染器与宿主**同文档同 DOM 树**现状的污染面盘点 + 隔离方案（同文档约定 / Shadow DOM / iframe）对比与分期路线 |

---

## 一、现状盘点（读码结论，2026-10-13 main）

### 1.1 挂载链——同文档是既定事实

```
Home.vue  <div ref="previewEl" class="ws__preview-host">      （workspace/file 两模式各一处，现 Home.vue:1304/1445）
  └─ createPreview({ container: previewEl, ... })             （frontend/src/files/preview.ts）
       └─ takeOver(): container.innerHTML='' → 新建 div.mmf-preview-stage
            └─ def.renderer(el, file, ctx, savedState)        （renderer 直接往 el 里塞 DOM）
```

- 渲染器产出的 DOM 与宿主共用同一个 `document`、同一棵 DOM 树、同一份 CSSOM——**任何一方的全局样式都会命中对方**。
- 渲染器拿到的 `el` 是每次 open 新建的 `div.mmf-preview-stage`，dispose 后随容器清空——DOM 生命周期是干净的，**脏的只有样式**。
- 注意：产品本身已是一次 iframe 隔离——《solution-design.md》§一嵌入形态=iframe/window.open，本命题是**第二层**（渲染器 vs 工作台）的隔离问题，不与第一层混淆。

### 1.2 渲染器 → 宿主方向的注入盘点（逐渲染器）

| 渲染器 | 注入全局样式/逃逸点 | 类名前缀纪律 | 宿主→它反向污染 | 风险 |
| --- | --- | --- | --- | --- |
| markdown（markdown-it） | mermaid 动态 import 后把样式写进生成 SVG 内部（SVG 内 `<style>` 带 id 作用域，外溢极小）；正文 HTML 由 `el.innerHTML = md.render(text)` **裸注入，自身零样式** | `markdown-too-large-tip`（无样式定义） | **最重**：排版完全由宿主决定——宿主 reset `*{margin:0;padding:0}` 抹平段落/标题间距，`h1~h6` 未被命中但 `a{color:var(--color-info)}` 全局链接色生效，`code/pre/table` 无任何排版 | 高（观感=宿主 reset 的隐式契约，宿主改一行 markdown 全变） |
| code（Monaco） | `import('monaco-editor')` ESM 链内 import `.css` → Vite 注入**全文档** `.monaco-*` 类系 + codicon 字体；`automaticLayout:true` 用 ResizeObserver 测量（依赖宿主 `.ws__preview-host` 的 min-height 链，见 Home.vue L1167-1181 注） | `.monaco-*` 命名空间良好 | 宿主 `*` reset 的 `box-sizing:border-box` 波及 monaco 内部（monaco 自设 box-sizing 兜底，历史上是踩坑区）；全局 `a` 色影响 tooltip 内链接 | 中（外溢低、被污染面真实存在） |
| csv（papaparse） | 单条 `<style>` 随 wrapper 注入：`.mmagic-csv-table tbody tr:hover > td`（:hover 无法内联）；dispose 随 wrapper.remove 一并清理（现 csv/mermaid/flow/code 渲染器均此模式，非唯一） | `mmagic-csv-*` 优秀 | 单元格内联 style 引用 `var(--app-section-border-color)`、`var(--brand-bg-muted,…)`、`var(--brand-sidebar-hover-bg,…)`——**主题 token 是显式契约**，落到哪一层变量随宿主品牌切换 | 低（双向都有纪律） |
| pdf | 一级=原生 `<iframe src=blobUrl>`（**本仓已上线的 iframe 隔离先例**，浏览器内置查看器接管）；二级=pdf.js 自绘 | `mmagic-pdfjs-*`（无任何样式定义，按钮是裸原生样式） | 极小（canvas/iframe 自绘） | 低 |
| docx（docx-preview 0.4） | `renderAsync(buffer, view, undefined, {inWrapper:true})`：`<style>` 节点默认插进 bodyContainer（`.docx-view` div 内），**但 `<style>` 插在 body 任何位置都是全文档生效**。默认规则有 `.docx-wrapper`/`.docx` 类作用域（含 `.docx-wrapper{background:gray}` 纸面灰底）；**文档自带样式（stylesPart）会生成未加前缀的全局类选择器**（如 `.Normal`、按文档样式名转义的类名，node_modules docx-preview.mjs L3384-3389）+ 全局 `@font-face` 注入（L3016） | `.docx-*` 是库的，**用户文档派生类名不可控** | 宿主 reset/全局 `a` 色直接进 docx 版式；EP 无裸元素规则（index.css 0 条 body/html/* 选择器）不影响 | **最高**（样式名由用户上传的 docx 决定，与宿主类名碰撞理论上可能） |
| xlsx（SheetJS） | 零注入：`sheet_to_html` → 剥属性 → 挂 class | `xlsx-*`（宿主侧零定义；渲染侧 v1.2.0 起走 ExcelJS 保真样式链 xlsxStyle） | 浏览器默认样式 + 宿主 `*` reset | 中（观感未收口，无污染但无设计） |
| media | 零注入：`<video>/<audio controls>` + 内联 style | 无 | 极小 | 低 |
| image（viewerjs 1.15） | **顶层静态 `import 'viewerjs/dist/viewer.css'`**（全局 `.viewer-*` 类系，无前缀冲突风险但常驻全局 CSSOM）；非内联模式全屏查看器挂 `document.body`——**UI 逃逸出预览舞台**（z-index≈2015 直接进宿主层叠上下文） | `mmagic-image-view`/`mmagic-image-fail` + 库的 `.viewer-*` | 宿主层叠上下文/EP 弹层 z-index 与 viewer 竞态 | 中 |
| heic（heic2any） | 复用 image 链路，无额外注入 | `mmagic-heic-fail` | 同 image | 低 |
| 预览骨架（preview.ts） | 无注入 | `mmf-preview-stage/error/fallback/rejected`（仅 stage 在 Home.vue 有样式；error/fallback 节点复用宿主 `fc-button`） | 同上，fc-button 契约 | 低 |

> 清单口径：`frontend/src/styles/` 与各 `.vue` `<style>` 已全量 grep（`xlsx-`/`mmagic-`/`docx`/`markdown` 零命中）；`index.scss` 全文已读、`global.scss` 余下部分未逐行核对，**本表为未尽完整清单**，后续改造前以一次 `grep -rnE '^(h1|…|a)\b' styles/` 复核为准。

### 1.3 宿主 → 渲染器方向的全局规则盘点（活样式入口=index.scss）

main.ts 全量引入：`element-plus/dist/index.css` + `remixicon` + `./styles/index.scss`。vite `additionalData` 只注入 `variables.scss`（纯 token）。**`global.scss` 与 `_reset.scss` 未被任何文件引用，是无主孤儿文件**（内含与 index.scss 平行的第二套 reset/`a` 规则）——建议顺手清理，防后人误接线造成双重 reset。

| 规则（index.scss） | 命中渲染器内容的方式 |
| --- | --- |
| `*,*::before,*::after { box-sizing:border-box; margin:0; padding:0 }`（L28-34） | **全部渲染器**。markdown 段落/列表/blockquote 间距被抹平（markdown 观感裸奔的直接原因）；docx/xlsx 表格默认 padding 归零 |
| `a { color: var(--color-info); hover… }`（L53-60） | markdown 链接、docx 超链接——链接色被宿主主题接管（可能是有意的产品决策，但现在是**隐式**的） |
| `::-webkit-scrollbar` 系 + `::selection` | 预览区滚动条/选中色——同被宿主统一（低风险，写进契约即可） |
| `html{font-size:16px}` / `body{font-family;font-size;line-height}` | 所有以 em/rem 计的第三方渲染内容（docx-preview 大量 pt/em 计算）继承宿主字族字号 |
| 工具类 `.text-*`/`.card`/`.fc-button*`（button-classes 带 `:not(.el-button)` 防 EP 冲突，2026-07 踩坑注） | 渲染器/预览骨架**主动消费**（painter、preview.ts）——这是依赖不是污染，但要求类名永远稳定 |
| `html[data-brand]/[data-theme]` 的 `--app-*/--el-*/--brand-*` 变量（_themes/_app-aliases/_ep-overrides） | **预期共享通道**：渲染器内联样式直接 `var(--app-…)` 取主题（csv 实证）。CSS 自定义属性沿 DOM 继承、**可穿透 Shadow DOM**，iframe 内则断供（见 §二） |

小结：**当前真正的定时炸弹只有两处——markdown 零自排版（观感=宿主 reset 的隐式契约）与 docx-preview 的用户文档派生全局类名（不可控选择器进全局 CSSOM）**；其余是纪律与观感收口问题。

---

## 二、方案对比矩阵

评估基准=本仓五大约束：
① 应用要 `ctx.t`（i18n）与 `ctx.theme`/CSS 变量（主题 token 经 `html[data-theme]` 驱动）；
② 保存链 `ctx.putObject` + `ctx.notify('saved')` + `beforeDispose` confirm（`window.confirm`）；
③ Monaco 靠 `automaticLayout`(ResizeObserver) 测量，依赖宿主 `min-height` 链；
④ 生命周期=切 tab 重跑 renderer + savedState 回注 + 10s 错误边界（preview.ts）；
⑤ e2e 直接查询 `.mmagic-csv-table`/`.monaco-editor`/`.xlsx-table`/`.mmf-preview-*` 等同文档选择器。

| 维度 | A. 同文档 + 约定式隔离（BEM/前缀/`@layer`/局部 reset） | B. Shadow DOM（`attachShadow`） | C. iframe（srcdoc/浏览器原生隔离） |
| --- | --- | --- | --- |
| 隔离彻底度 | 弱——只防「写得守规矩」，防不了第三方裸规则（docx 派生类名、T1 插件自带 CSS） | 强——选择器互不可达（宿主规则进不来、渲染器规则出不去） | **最强**——独立文档+独立 CSSOM，双向物理隔离 |
| 主题 token（约束①） | 天然共享 | **CSS 自定义属性可穿透 shadow 边界继承**，`html[data-theme]` 继续生效（实测口径需回归明暗双主题） | **断供**——需 postMessage/初始化参数把 token 灌进 srcdoc（或 `<link>` 共享一份 tokens.css），主题切换需同步广播 |
| i18n（约束①） | 天然（`ctx.t` 返回字符串） | 天然 | 字符串仍可传，无障碍 |
| 保存链/confirm/键盘（约束②） | 天然 | 天然（事件重定向后 `composed` 事件正常冒泡；focus 需管理） | **断链**——`window.confirm` 在 iframe 里弹原生框（可用但观感割裂）；快捷键要 iframe 内重新监听；`ctx.notify`/`putObject` 是 JS 闭包不受影响，但 iframe 内脚本要经 postMessage 桥才能调宿主闭包 |
| Monaco（约束③） | 现状可用 | **有已知坑**：hover tooltip 在 0.34.0+ shadow DOM 失效（microsoft/monaco-editor issue）、color picker shadow DOM 下秒关、context menu/focus 系列问题——**不建议** | 可行但重：worker 照常、`automaticLayout` 在 iframe 内自洽；但 worker 加载/`MonacoEnvironment`、与宿主 `beforeDispose` 的 confirm 交互都要过桥；收益≈0（monaco 类名本就有 `.monaco-*` 命名空间） |
| 生命周期/多 tab（约束④） | 不变 | 不变（dispose=remove host 元素） | 变重——每次 open 都是文档加载（解析/布局/字体重算），切 tab 重跑语义下成本×N；`revokeObjectURL`/卸载时序要新增纪律 |
| e2e/测试（约束⑤） | 不变 | 需 shadow-piercing 选择器（Playwright `locator('#x').locator('…')` 自动穿 shadow，改动可控） | 需 `frameLocator()` 改写全部渲染器断言 |
| 打印/无障碍 | 随宿主页 | 随宿主页 | 打印需 iframe 内触发或专门打印样式；a11y 尚可（iframe 有 title 即可）但读屏切换上下文 |
| 内存 | 基线 | 略增（每实例一个 shadow root） | 明显增加（每实例一个完整文档/BrowsingContext，多 tab 长会话累积） |
| 业界参照 | GitHub README 渲染（`.markdown-body` 命名空间）；Notion 编辑器（同文档+自家前缀类名） | 浏览器扩展/MFE 微前端（WordPress Gutenberg 已迁 shadow 容器） | **文档预览服务主流**：Google Drive/OneDrive 预览、Office Web Viewer 嵌入均 iframe；GitHub 对用户 HTML 用 `sandbox` iframe；浏览器级先例=本仓 pdf-viewer 一级方案。极端反例=Google Docs 2021-05 起弃 HTML 改 canvas 渲染（Workspace Updates 官宣）——说明「文档保真」的终极形态是彻底摆脱 CSSOM 互扰，但代价是 a11y 争议（WebAIM 批评），对本仓过度 |
| 结论口径 | **默认档**：所有内置渲染器 + T1 插件 | **特定场景**：T2 前如果确有自带完整 CSS 的轻量第三方查看器，可给 shadow 档做试点；当前内置清单无一需要 | **特定场景**：文档自声明式样式（docx 类）、不可信 T2 插件（已裁）、需要打印隔离的场景 |

补充——`@layer` + container queries 是 A 档的现代增强而非独立路线：宿主把 reset/EP 覆写/工具类收进 `@layer host.base, host.ep`，渲染器样式放 unlayered（优先级天然高于一切 layer）或 `@layer apps`（顺序声明在宿主之后即可赢）；`.mmf-preview-stage { container-type: inline-size }` 让渲染器响应自身宽度而非窗口。成本低，与 B/C 不冲突（iframe/shadow 内同样可用 layer 组织自身样式）。

---

## 三、分阶段推荐

| 阶段 | 内容 | 改动位 | 成本 | 风险 |
| --- | --- | --- | --- | --- |
| **P0 立即（建议下一个 lane 顺带）** | ①删孤儿 `styles/global.scss`、`styles/_reset.scss`（防误接线双 reset）；②给 markdown 落自排版：新建 `.mmagic-md` 作用域样式（标题/段落/列表/`pre code`/`table`/`blockquote`，token 用 `var(--app-*)` 带兜底），renderer 挂 `el.classList.add('mmagic-md')`；③xlsx 补 `.xlsx-*` 一套最小表格样式（对齐 csv 观感口径） | 新增 1 个 scss + 2 个渲染器各 1 行 | 半天 | 极低（纯增益，`@layer` 外普通规则即可） |
| **P1 收敛（P0 后任意时点）** | 宿主全局规则分层：index.scss 的 reset/工具类/EP 覆写收进 `@layer base, ep, utilities`；渲染器与插件样式置于 unlayered 或后序 `@layer apps`；`.mmf-preview-stage` 开 container；同步把「类名前缀 `mmagic-*`、禁裸元素选择器、禁 `!important`（EP 覆写白名单除外）」写进《plugin-system.md》§五工程细则（T1 插件当前与内置同树，**是本方案最大未设防面**） | index.scss + 文档 | 1 天 | 低（EP 覆写带 `!important` 的规则若在 `_ep-overrides`/`_component-overrides` 中存在，收进 layer 后 layer 间优先级变化需回归 Drawer/Overlay 弹层；`_reset.scss` 的同类规则已在 P0 随孤儿文件删除，不参与本轮） |
| **P2 定点升级 iframe（候裁，值得做的只有一个）** | **docx-viewer** 升 `srcdoc` iframe：docx-preview 的用户文档派生类名/`@font-face` 从此物理关进独立文档；主题 token 与文案在 srcdoc 生成时灌入 + `setTheme` 广播同步；保存链不涉及（docx 只读）。改造点：docx.ts 改产 HTML 串、preview.ts 增 iframe 挂载分支（renderer 契约不变，el 内挂 iframe 即可，可完全收在渲染器内）、e2e 改 `frameLocator` | docx.ts 为主 | 2-3 天（含双语双主题 e2e 回归） | 中：blob/srcdoc 内字体加载、打印行为变化；验收口径对齐《第一期…》§五 |
| **不做/候需求** | Monaco/code-editor、csv、image、media、painter 上 iframe 或 shadow——联动面（保存链/confirm/键盘/测量/e2e）远大于收益；T2 第三方市场插件按《plugin-system.md》既裁走 sandboxed iframe+能力桥，本方案不重复裁定 | — | — | — |

---

## 四、结论：iframe 好不好

**iframe 是好技术，但它是「边界」工具，不是「样式」工具——只有当隔离边界恰好是信任边界或文档边界时才值得付它的重挂载/桥接成本。**

- **何时好**：①内容自带不可控样式声明（docx 文档样式、未来 pptx/html 预览）——P2 的 docx 升级即此；②不可信代码——T2 市场插件已裁 sandboxed iframe，与本方案互为表里；③需要与宿主页面物理隔离的打印/滚动/事件语义。本仓 pdf-viewer 一级方案（原生 iframe + blob URL）证明这条线内 iframe 是零成本正解。
- **何时不值**：与宿主强联动的**编辑型**应用——Monaco（confirm/键盘/测量全要过桥，且 `.monaco-*` 本就有命名空间）、csv/painter（工具条消费宿主 `fc-button` 与主题变量是**特性**不是 bug）、媒体类（原生控件自带隔离度）。这些场景 iframe 把「函数调用」变成「协议」，保存链/i18n/主题/e2e 四条线全部重接，换来的隔离收益接近零。
- **默认答案**：同文档 + 约定式隔离（P0/P1）继续做默认档——它便宜、可审计、与 ctx 契约天然兼容；把 iframe 当作**按应用逐个审批的升级件**（当前清单里只有 docx 值得），Shadow DOM 留作 T2 前的轻量第三方试点选项（受 Monaco 前科约束，默认不碰）。

## 五、开放项

- `ctx.theme` 目前宿主传 `{}`（现 Home.vue:907/960）——主题实际只走 CSS 变量通道。若未来把 token 塞进 `ctx.theme`，iframe 档的 token 灌注应改为消费 ctx 而非另读 DOM，需在 P2 设计时定稿。
- T1 插件样式纪律（前缀/layer）写入《plugin-system.md》V1.2 的时机，建议与 P1 同 lane。
- docx iframe 档的打印语义（宿主打印按钮 vs iframe 内打印）候 P2 细化。
