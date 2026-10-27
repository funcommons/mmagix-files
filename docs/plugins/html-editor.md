# HTML 编辑器插件方案（html-editor）

> **【实施状态注记 · 2026-10-26 审计】** v2「已实施」声明核实属实（三态/打开 pass/保存剥离/新 tab 代理全在）；偏差以代码为准：
> 1. savedState 仅 `{ mode }`（光标位置未实现）
> 2. 形态优先级：**initialMode > savedState/用户记忆 > 'source'**（`options.ts:40-42`；与 §一 相反）
> 3. 构建为 Vite lib 单文件（无 build.mjs）；文件另有 find.ts/options.ts/types.ts；i18n 全走宿主词典 `app.html-*`
> 4. 跳转怪值拒绝走 `ctx.notify('html-open-rejected')`→控制台 warn（无 toast）
> 5. wysiwyg/preview 离态销毁（preview 保活未实现）
> 6. 单测 24 例；产物 ≈1.36MiB


> 状态：v2 已实施（2026-10-20：P0+P1+P2 全量交付，产物 1.39MB/gzip 401KB，单测 15 例 + 全链 E2E ALL PASS）。对齐《../design/plugin-system.md》插件契约与 markdown-editor 插件先例（构建/注册/形态/appOptions 通道）。
> 目标：新增应用插件 `html-editor`——**三态：源码编辑 / 可视编辑（所见即所得）/ 页面预览**；图片全量 base64 内联（单体 HTML）；预览内一切跳转改为「确认后新标签页打开」。
> v2 修订：取消「左编辑右预览」分屏态（用户裁定）——三态即三个独立视图，无双窗同步复杂度。

---

## 一、定位与契约

| 项 | 值 |
|---|---|
| 插件 id（应用注册） | `html-editor` |
| 插件产物 | `frontend/plugins/html-editor/` → esbuild 单体 → `frontend/public/plugins/html-editor.js`（预估 600–900KB：CM6 源码编辑 + Tiptap WYSIWYG） |
| matcher | `ext: ['html', 'htm']`，`actions: ['edit']`（只读文件仍可打开查看，保存链自然被拒） |
| 注册 | 与五插件同构：`registerApp({ id, label: 'HTML 编辑', matcher, renderer })`；宿主白名单无需改（registerApp 既有通道） |
| 数据源 | 零特例：`ctx.getObject/putObject`（S3 / url / mem:// 三域通用），保存链与 md 编辑器同构（可写模式写回，Ctrl+S；只读提示） |
| savedState | 形态 + 编辑方式 + 光标位置回注（第 4 参），切 tab 回来状态保持 |

### 与 markdown-editor 的对齐点（复用其成熟模式）

- 三态按钮 + `appOptions.initialMode`（优先级 `savedState > openOptions > 注册缺省`）
- 首开渲染红线：先容器测量再建编辑器（防 0 高度塌陷——file 模式舞台已有 flex 实高链）
- demo 接入三件套：`PLUGIN_DEFS` 勾选项、`APP_CATALOG` 清单项、`plugins` 注入

---

## 二、交互模型：三态（source / wysiwyg / preview）

| 态 | 视图 | 内核 |
|---|---|---|
| `source` 源码编辑 | 单栏代码编辑器 | CodeMirror 6（html 高亮；与 md 插件同内核同体验） |
| `wysiwyg` 可视编辑 | 单栏所见即所得 + 格式工具栏 | Tiptap（ProseMirror 内核） |
| `preview` 页面预览 | 单栏沙箱预览（§四） | srcdoc 静态渲染 |

- 工具栏三态按钮组：`源码编辑｜可视编辑｜页面预览`（分段控件，同 md 的形态钮）。
- `appOptions.initialMode`: `source | wysiwyg | preview`（默认 `source`；优先级 `savedState > openOptions > 缺省`，沿 md 通道，值域不同）。
- **三态切换的内容交接**（单实例互斥驻留，HTML 字符串为交换介质）：
  - source → wysiwyg：解析为 ProseMirror 文档（未闭合标签容错规整）
  - wysiwyg → source：`getHTML()` 序列化——**非逐字还原**（属性顺序/空白规整化），首次切换弹一次性确认「切到源码将按标准格式重排」
  - `preview`：从当前 HTML 语义渲染（wysiwyg 态取 `getHTML()`）；离开预览回到离开前的编辑态
- 无双窗即无双实例同步——状态机复杂度显著低于 md 的 split（这是砍掉分屏的直接收益）。

---

## 二.5、编辑组件选型（建议）

| 槽位 | 推荐 | 体积（min） | 理由 |
|---|---|---|---|
| 源码编辑 | **CodeMirror 6**（`@codemirror/lang-html`） | ~350KB | 与 md 插件同内核——体验/打包口径一致；html 高亮+标签补全+折叠；esbuild 单体打包已被 md 插件验证 |
| 可视编辑 | **Tiptap**（starter-kit + Image/Link/Table/Underline） | ~220KB | ProseMirror 文档模型产出**干净 HTML**（不会像 execCommand 系产出垃圾标签）；无框架绑定可原生 TS 集成；`editorProps.handlePaste/drop` 钩子是 base64 图片管道的干净接入点；MIT |
| 预览 | 自研 srcdoc 沙箱（§四） | 0 | 净化+拦截脚本百来行，无第三方必要 |

**Tiptap 备选对比（为何不选）**：

- **Quill 2**：更小更简单，但内容模型是 Delta——与 HTML 互转有损（复杂嵌套表格/自定义属性弱）。本插件以 **HTML 为源本体**，来回转换重排用户代码不可接受；ProseMirror 的 schema 可精确控产
- **CKEditor 5**：功能最强但体积 ~700KB+，license 为 GPL/双商业——插件分发不合适
- **自研 contenteditable + execCommand**：零依赖但 execCommand 已废弃、跨浏览器行为漂移、脏 HTML 问题，维护坑深——功能天花板也不够（表格/图片对齐）

选型均为 MIT 协议；合计新增产物约 600–800KB（对比 md 插件 8.7MB 先例完全可接受）。若 Tiptap 需走「审核入册」流程，提前报备即可。

---

## 三、单体化：所有资源 base64 内联（不引用外部资源）

原则：**打开时内联、编辑中不新增外链、保存前强制单体化**——三道闸。

### 3.1 打开时（open pass）

1. `DOMParser` 解析 HTML
2. 遍历外链资源并内联：
   - `<img src>`（http/https/相对/blob）→ `fetch` → Blob → `FileReader.readAsDataURL` → 替换 `src`
   - `<source>`（picture/video/audio）、CSS 内 `url(...)`（`<style>` 与 `style` 属性）→ 同法
   - 相对路径：按源文件所在目录解析（url source=其 URL 目录；mem://=无基址，仅同文档锚点）
   - `<link rel=stylesheet href>` → fetch 文本 → 内联为 `<style>`
   - `<script src>` → 打开编辑用：内联为内联脚本保留源码语义（编辑的是源码本体，不执行）
3. **失败策略（CORS/404/超时 5s）**：不阻断打开——该资源替换为 1px 透明占位 dataURL + `data-mmx-inline-failed="原URL"` 属性，预览中显示占位框并 title 提示原 URL；状态栏汇总「N 项外部资源未能内联」

### 3.2 编辑中（input pass）

- WYSIWYG 粘贴/插入图片：`clipboardData.files` → 读 dataURL 直接内联（不产生外链）；拖拽同
- 源码模式手写外链：不阻断编辑（用户可能在写给别人看的 HTML），但**预览/保存闸**兜底（见下）；编辑器状态栏常驻徽标「外链 N」提示未单体化项数

### 3.3 保存前（save pass，强制）

- 复跑 3.1 的内联遍历（兜用户手写外链/漏网资源）；仍失败的项：**默认剥离该资源**并在返回的保存结果里带警告清单（toast「已保存，N 项外部资源被移除」）——保证落库 HTML 恒为单体
- 大小防护：内联后 > 渲染器 maxBytes（建议 20MB，登记进 builtins 限额表）→ 拒绝保存并提示（图片压缩建议，见 §七 P3）

---

## 四、预览沙箱：一切跳转 → 「提示后新标签页打开」

### 4.1 沙箱策略（预览 iframe）

```
<iframe sandbox="allow-scripts allow-same-origin? 否" srcdoc=…>
```

- **净化式静态预览（默认）**：进 srcdoc 前剥离 `<script>`、`on*` 内联事件、`javascript:` href、`<meta http-equiv=refresh>`——预览即「排版所见」，无脚本即无 location 跳转/弹窗副作用，残余攻击面为零
- sandbox 不给 `allow-top-navigation`/`allow-popups`：即使有漏网导航也被浏览器层拦截
- 沙箱内注入拦截脚本（唯一保留的脚本）：捕获 `click` 上 `a[href]`、表单 submit → `parent.postMessage({ ns:'mm-html-editor', type:'open-request', url })`
- 锚点跳转（`#fragment`）不放行出框：同文档滚动由拦截脚本内部处理（`scrollIntoView`）

### 4.2 新标签页打开代理（插件宿主侧）

1. 收到 `open-request` → 弹**确认条**（预览区顶部滑出，非浏览器 confirm）：「将在新标签页打开：<显示域名+路径截断>」+「打开 / 取消」+「本次会话不再询问该域名」
2. 确认 → `window.open(url, '_blank', 'noopener,noreferrer')`（插件页面上下文，天然具备顶层权限）
3. URL 白名单校验：仅 `http:`/`https:`；`data:`/`javascript:`/协议相对的怪值一律拒绝并 toast
4. 「不再询问」按域名记忆（会话级，内存 Map；不做持久化）

### 4.3 已知边界（明示不做）

- 预览内 CSS `@import` 外部样式：已被 3.1 内联/剥离，不构成跳转面
- 「预览执行原脚本」不做开关——原脚本可能含 `location.href=` 等导航语义，与「一切转向走确认」冲突；需要脚本调试的用户应直接开文件在新标签页（无源场景由浏览器原生承担）

---

## 五、实现结构

```
frontend/plugins/html-editor/
  src/
    index.ts      # registerApp 装配 + i18n 词典（zh/en）
    render.ts     # renderer：容器/工具栏/三态状态机/保存链/savedState
    source.ts     # CM6 源码编辑器封装（含 html 高亮配置）
    wysiwyg.ts    # Tiptap 封装 + 粘贴/拖拽图片 dataURL 管道 + getHTML
    inline.ts     # 单体化管道：open pass / save pass（img/source/style/url/link 内联、失败占位）
    sandbox.ts    # srcdoc 净化（script/on*/refresh/javascript: 剥离）+ 拦截脚本模板 + open 代理
  build.mjs       # esbuild 单体（沿用 markdown-editor 构建口径：bundle+minify，产物落 public/plugins）
```

- 三态**单实例互斥驻留**：同一时刻只存在一个活动视图；切换时旧实例销毁、内容以 HTML 字符串交接（避免双实例状态漂移）；preview 态编辑实例可保活隐藏（省重解析）。

---

## 六、接入清单（改动面）

| 文件 | 改动 |
|---|---|
| `frontend/plugins/html-editor/**`（新） | 插件本体 + 构建 |
| `frontend/public/plugins/html-editor.js`（新产物） | esbuild 产物 |
| demo `FilePlay.vue` | `PLUGIN_DEFS` + `{ key:'html', label:'HTML 编辑', url:'/plugins/html-editor.js' }`（勾选默认开）；`APP_CATALOG` + `{ id:'html-editor', label:'HTML 编辑', kind:'edit', exts:['html','htm'], pluginKey:'html' }` |
| `frontend/src/apps/builtins.ts` | 渲染器限额登记（html-editor maxBytes 20MB）——由插件自带 def.maxBytes 则免 |
| `../design/plugin-system.md` / `JSSDK 接口文档.md` | 插件清单补一行 |
| seed（可选） | 桶里放一个含外链图片的样例 `sample.html` 供演示单体化 |

契约零变更（registerApp/renderer/appOptions 既有通道全够用）。

---

## 七、分期与验收

**P0 核心编辑（骨架可跑）**
- 插件注册/打开 html；CM6 源码编辑 + 三态切换（preview 先行）；Ctrl+S 保存写回；savedState
- 验收：单文件页无源装载 → 传 html → 加载 → 三态切换、编辑保存重开一致

**P1 可视编辑**
- Tiptap 集成 + 态切换交接（含 wysiwyg→source 重排确认）；格式工具栏；粘贴图片内联
- 验收：可视编辑粘贴截图 → 源码态见 `data:image/...`；保存重开不丢

**P2 单体化 + 新 tab 代理**
- open/save 双 pass 内联；预览沙箱净化；open-request 确认条 + window.open 代理
- 验收：打开含外链图片的 html → 预览全内联（DevTools Network 零外部请求）；点链接 → 确认条 → 新 tab；CORS 失败资源显示占位

**P3 可选增强**（默认不做，按需下单）
- 粘贴大图 canvas 压缩（长边 1920/质量 0.85，可关）
- 「预览执行原脚本」开关（与 §4.3 取舍冲突，默认维持不做）
- HTML 格式化/美化按钮

## 八、风险与决策点

| 风险/决策 | 取舍 |
|---|---|
| 可视编辑序列化非逐字还原 | 切换确认 + 文档声明（行业通病，ProseMirror 已是最佳 effort） |
| 外链资源 CORS 拒绝 | 占位+警告，不阻断打开；保存时剥离——保证「单体」硬约束优先于资源完整性 |
| Tiptap/CM6 新依赖（审核入册流程） | 均 MIT；Tiptap 备选 Quill 2（更小但 Delta↔HTML 有损）或纯 contenteditable 自研（零依赖天花板低）；推荐 Tiptap，如需走入册评审提前报备 |
| 产物体积（CM6+Tiptap≈600–800KB） | 单体单文件可接受（md 插件 8.7MB 先例）；按需再做代码裁剪 |
| base64 +33% 体积 | 大图压缩为 P3；maxBytes 硬闸兜底 |
