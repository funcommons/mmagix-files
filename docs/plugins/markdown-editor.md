# 动态插件方案：markdown-editor（Markdown 编辑器 × Mermaid × 三形态）

> **【实施状态注记 · 2026-10-26 审计】** 三形态/options 通道/保存链/20MB 闸全部落地；细节漂移以代码为准：
> 1. **形态优先级**：savedState > initialMode > 用户记忆 > defaultMode > 'split'（`render.ts:109-112`）
> 2. mermaid 单块失败**静默降级普通代码块**（无错误框 UI；`mermaid.ts:44-52`——§一.2/§五 过期，以 §3.2 为准）
> 3. 链接加固实为统一 target/rel（scheme 白名单靠 markdown-it 缺省 validateLink）
> 4. dirty=统一工具栏保存钮红点（「未保存」文字徽标已废；v1.1.0 统一编辑工具栏接入，`render.ts` 经 `src/shared/editToolbar`）
> 5. 演示接入 lazy:false（EmbedPlay 注释存档：lazy 对有内置默认应用扩展名永不触发）


| 项 | 值 |
| --- | --- |
| 版本 | V1.0（2026-10-16） |
| 性质 | 动态应用插件施工方案（对齐《../design/plugin-system.md》契约 + 《../design/jsdk-api.md》V1.0） |
| 交付物 | `public/plugins/markdown-editor.js` 单文件 ESM 插件 + 参数通道契约微扩展 |

---

## 一、目标与非目标

**目标**
1. `.md`/`.markdown` 的**编辑**应用插件：右键「打开方式 → Markdown 编辑」（不抢 `markdown-renderer` 的默认 view 位）
2. **内置 mermaid**：围栏 ` ```mermaid ` 块渲染为 SVG；渲染失败保留错误框与源码，不炸整篇
3. **三种形态**：源码 / 预览 / 左源码右预览双窗（双窗实时联动，编辑防抖后刷新预览）
4. **支持参数**（宿主注入）：`initialMode`（打开时形态）、`defaultMode`（默认形态，无记忆时兜底）
5. 保存链与内置应用同口径：dirty 徽标 / Ctrl+Cmd+S / 关 tab 前未保存确认 / `ctx.putObject` + `ctx.notify('saved')`

**非目标**
- 不做所见即所得（WYSIWYG）混合编辑
- 不做协同/锁；不做导出 PDF
- 不替代内置 `markdown-renderer` 预览应用

## 二、参数通道（契约微扩展，只增不改义）

现状：`PluginEntry {url,sri,lazy}` → `PluginLoader.load()` → `activate(sdk)` 单参，插件无参数入口。

扩展（minor 版本语义，向后兼容）：

```ts
// sdk/types.ts
export interface PluginEntry {
  url: string
  sri?: string
  lazy?: boolean
  /** 透传给 activate(sdk, options) 的插件参数（v1.1 起） */
  options?: Record<string, unknown>
}
// loader.ts
export interface PluginEntryInput { url: string; sri?: string; options?: Record<string, unknown> }
// 激活：(mod.activate as (sdk, options?) => void)(handle, entry.options)
// RegisterAppPayload（运行时 registerApp 命令）同增 options 透传
```

**markdown-editor 参数语义**：

| 参数 | 类型 | 缺省 | 语义 |
| --- | --- | --- | --- |
| `initialMode` | `'source'\|'preview'\|'split'` | 无 | 打开时形态（硬指定，压过用户上次记忆） |
| `defaultMode` | `'source'\|'preview'\|'split'` | `'split'` | 兜底默认（无 initialMode 且无用户记忆时） |

形态解析优先级（纯函数，单测覆盖）：
`initialMode`（合法值）→ 用户上次选择（localStorage `mm-md-mode`）→ `defaultMode` → `'split'`。
非法值一律丢弃走下一级（不抛错、不 reject 渲染）。用户在插件内切换形态即写 `mm-md-mode`。

## 三、功能规格

### 3.1 三形态布局

```
root（absolute inset:0，flex column；防 stage 尺寸塌陷同 code.ts 口径）
├─ toolbar（h=36，flex row）：[源码|双窗|预览 分段] · [脏徽标] [保存]
└─ body（flex:1，flex row，min-height:0）
   ├─ 编辑窗（CodeMirror 6，markdown 语法；source/双窗可见）
   ├─ 1px 分隔线（仅双窗）
   └─ 预览窗（overflow auto；preview/双窗可见）
```

- 形态切换纯 display 控制（不重建 CodeMirror/不丢光标）；切换写入 savedState
- `savedState = { mode, scrollTop }`：切 tab 回来恢复形态+编辑滚动（AppInstance.getState 口径）
- 双窗联动：编辑防抖 400ms → markdown 重渲染 → 仅替换预览窗 innerHTML + mermaid 增量（SVG 按 code 哈希缓存，避免闪烁）

### 3.2 mermaid 管线

- markdown-it fence 渲染钩子：`lang=mermaid` 的围栏不输出 `<pre><code>`，改输出占位 `<div class="mm-md-mermaid" data-mmid="n">`，源码收集进数组（纯字符串管线，可单测）
- 预览窗挂载后逐块 `mermaid.render(id, code)` → 注入 SVG；失败→**静默降级普通代码块**（无错误 UI；mermaid 12 须 `suppressErrorRendering:true` 关其内置炸弹图），不中断其余块
- `mermaid.initialize({ startOnLoad:false, securityLevel:'strict' })`；实例级缓存 `Map<code-hash, svg>`

### 3.3 安全口径（对齐内置 markdown-renderer）

- markdown-it `html:false`（原文 HTML 转义显示）；链接加固（仅 http/https/锚点，`rel="noopener noreferrer"` + 新窗打开）
- mermaid `securityLevel:'strict'`（禁点击标签/绕行 HTML）

### 3.4 保存链

- 保存：全文文本 → `new Blob([text], {type:'text/markdown'})` → `ctx.putObject(file.key)` → `ctx.notify('saved',{key})`；幂等（非 dirty 直接返回）
- Ctrl/Cmd+S 拦截、脏徽标（`app.code-dirty`）、关 tab 前确认（`app.code-unsaved` + 3s 强制放行竞态）——全部复用 univer-office 同款实现
- 20MB `maxBytes` 渲染闸（编辑器场景放宽于 5MB 预览闸，对齐 code 渲染器 5MB 上限的 4 倍余量）

## 四、技术选型

| 件 | 选择 | 理由 |
| --- | --- | --- |
| markdown 引擎 | `markdown-it@^15`（与主应用同版本） | html:false 安全默认；fence 钩子可编程；单测友好 |
| mermaid | `mermaid@^12`（与主应用同版本） | 内置要求；`render()` 编程式 API |
| 编辑器 | CodeMirror 6（`codemirror` + `@codemirror/lang-markdown`） | 单文件内联可行（无 worker）；体积 ~0.5MB vs Monaco 5MB+；markdown 语法高亮/折叠/undo 开箱 |
| 构建 | vite lib 单文件 ESM（inlineDynamicImports + process 桩 + cssInjectedByJs 不需要——CodeMirror 主题走 JS 注入样式） | 对齐 pdf-annotator/univer-office 先例 |

## 五、文件结构

```
frontend/plugins/markdown-editor/
├─ package.json / vite.config.ts / tsconfig.json
└─ src/
   ├─ index.ts      # activate(sdk, options)：normalize → registerApp
   ├─ types.ts      # HostSdk/HostCtx/HostFile/HostInstance/MdEditorOptions
   ├─ options.ts    # 纯逻辑：参数归一化 + 形态解析优先级
   ├─ md.ts         # 纯逻辑：markdown-it 管线（fence 钩子 + 链接加固 + mermaid 收集）
   ├─ mermaid.ts    # mermaid 懒初始化 + 渲染 + 缓存 + 错误框
   ├─ editor.ts     # CodeMirror 装配（创建/取文/聚焦/滚动/视图态）
   └─ render.ts     # DOM 组装：工具栏/双窗/形态机/防抖联动/保存链/savedState
```

宿主侧触点（契约扩展）：`sdk/types.ts`、`plugins/loader.ts`、`main.ts`（3 处透传）、`sdk/handlers.ts`（registerApp payload）、`locales/{zh-CN,en-US}.ts`（新增 mode/label 词表）、演示端 `useMmagixFilesClient.ts` 类型。

## 六、施工步骤（每步 ≤1000 行，测试先行）

| # | 内容 | 验收 |
| --- | --- | --- |
| S1 | 契约扩展：options 通道全链路 + loader 单测（options 送达 activate） | vitest 绿；`t(接口文档/动态插件方案)` 同步 |
| S2 | 插件骨架 + options.ts 纯逻辑 + 单测；首次构建出 js | build 产物含 activate 导出 |
| S3 | md.ts + mermaid.ts + 单测（fence/链接/归一化/转义） | vitest 绿 |
| S4 | editor.ts + render.ts 全量 UI（三形态/保存链/savedState）+ 词表 | build 过；单测绿 |
| S5 | 演示接入：seed 增 mermaid 样例 md；demo 配置带 options；E2E 证据（三形态切换/mermaid SVG/保存回写字节校验/savedState 恢复/参数生效） | 证据截图+字节校验 |
| S6 | 复审轮（≤4 轮或至无 P0~P2）：每条建议→执行→回归 | 清账 |

## 七、风险与对策

| 风险 | 对策 |
| --- | --- |
| mermaid 12 内联体积（~2.5MB） | 与 univer 同量级先例可容；插件 lazy 加载，首开 .md 才拉 |
| CodeMirror 内联与 Vite lib 兼容 | 纯 JS 无 worker，S2 首建即验证；失败回退 textarea 方案（形态机不变） |
| 与内置 markdown-renderer 渲染漂移 | 同引擎同版本同安全口径；E2E 用同一样例比对两者 DOM 结构 |
| 契约扩展破坏旧插件 | options 可选、缺省不传——旧插件 activate(sdk) 签名不受影响（JS 忽略多余实参） |
