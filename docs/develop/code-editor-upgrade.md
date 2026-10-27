# code-editor 升级建议（内置 Monaco 编辑器应用演进线）

> **【现状追记 · 2026-10-26（v1.1.0 后）】** 统一编辑工具栏落地（`src/shared/editToolbar.ts` 十应用簇）：
> 保存钮红点替代「未保存」徽标、新增重置（恢复打开时内容，入 undo 栈）、撤销/重做接 `model.canUndo/canRedo`、
> 保存失败经 `ctx.notifyAppError` 上报宿主、36px 工具栏。P2-1 Diff / P2-2 model 复用 / P3-1 py 格式化仍为待办。

> 状态：v1.1（2026-10-21）。独立 `monaco-editor` 动态插件计划已取消——增强全部并入内置 code-editor 演进线，原《Monaco编辑器插件方案》已删除；本建议承接其有效设计（OpenSumi MIT 增强思路佐证 + 主题适配设计）。
> 基线：Monaco 0.57 · `frontend/src/apps/renderers/code.ts` · 工具栏 36px 插件风格 · worker 五入口分发 + 格式化双链（2026-10-20 落地，memory/monaco-worker-dispatch + test-report/2026-10-20-01）。
> **进度：P1-1 已实施（2026-10-21）；P1-2 查证后关闭（无需实施，假设证伪）。**

---

## 〇、现状盘点（已具备，勿重复建设）

| 能力 | 状态 |
|---|---|
| 语法高亮（90+ 语言） | ✓ basic-languages（主线程 tokenizer） |
| 语言服务：校验/补全/悬停/折叠/格式化（json、css/scss/less、html、js/ts） | ✓ worker 五入口按 label 分发（0.57 的 getWorker workerId 恒为 `workerMain.js`，语言在 label——详见 memory） |
| 格式化 | ✓ 双链：worker 原生 formatter 优先（2500ms 超时 + 前后文本比对双护栏）→ 自研回退（json=JSON.stringify / 其余 js-beautify）；白名单外置灰 + toast |
| **主题随宿主 light/dark** | ✓ **2026-10-21（P1-1）**：`code-theme.ts`——宿主 `--app-*` 变量 → defineTheme 双主题（8 类核心 token，长尾 inherit 兜底），MutationObserver 监听 `data-theme`/`data-brand` 联动；data-theme 非 light（dark/orange-black）一律暗基线 |
| **行注释/括号配置（84 语言）** | ✓ **自带无需建设**：0.57 basic-languages 语言模块自带完整 language configuration（64 语言带 lineComment，yaml/shell/python 均含 `#` + brackets + autoClosingPairs），随语言 lazy load 注册 |
| 全中文右键菜单 | ✓ 自绘（ESM 无汉化通道；aria-disabled 置灰口径） |
| 编辑功能全开 | ✓ 折叠常显 / minimap / 括号配色 / 粘滞滚动 / 多光标 / linkedEditing / formatOnPaste |
| 视图状态持久化 | ✓ `saveViewState`/`restoreViewState` 全量（光标/选区/滚动/折叠态，切 tab 回注） |
| 大文件防护 | ✓ 5MiB 只读降级（file.size 先判不拉字节流） |
| 保存链 / 只读闩锁 | ✓ putObject 拒 4305 → readOnly 闩锁 + dirty 复位 |
| 懒加载 | ✓ monaco 动态 import（不占首屏主包；worker `?worker` 独立分块按需实例化） |

---

## 一、升级建议清单（按优先级）

### P1-1 主题随宿主 light/dark —— ✅ 已实施（2026-10-21）

- 实施：`frontend/src/apps/renderers/code-theme.ts`（`normalizeHexColor` CSS 色值归一 / `readHostThemeVars` 读 `--app-*` 计算值 / `buildMonacoTheme` 8 类 token 映射+兜底 / `observeHostTheme` MutationObserver 双属性监听）；`code.ts` 创建 editor 后 `applyHostTheme` + dispose 摘除。
- 验证：单测 12 例（code-theme.test.ts，含「data-theme 缺省误判暗色」实现 bug 拦截）；E2E ALL PASS（test-report/2026-10-21-01/theme-e2e.mjs）：light `#ffffff`/`#1d1d1f` → dark `rgb(31,41,55)`/`rgb(243,244,246)`（**宿主真实变量值**，非硬编码）→ 切回 light 恢复。
- 设计要点存档：brand 切换同样触发（`--app-*` 随 `data-brand` 变）；rules 前景只认 `#RRGGBB`（带 alpha 截断）；`data-theme` 缺省=light（provider 默认）。

### P1-2 语言配置增强 —— ⛔ 已关闭（查证后无需实施）

- 原假设「basic-languages 只有 tokenizer、Ctrl+/ 不工作、缺括号配置」**证伪**：0.57 语言模块（`languages/definitions/*/[lang].js`）自带完整 `conf`（comments/brackets/autoClosingPairs/surroundingPairs），lazy loader 注册 tokenizer 时一并生效——84 语言中 64 个带 lineComment（其余为 plaintext 等本无行注释语法的语言）。
- 实测（E2E 同上）：yml 首行 `CtrlCmd+K, C` → 插入 `#` ✓、tokenizer 高亮（mtk26）✓。
- 教训：升级建议 v1 中该条基于旧认知未查证源码——已从清单移除，不重复建设。

### P2-1 Diff 对比视图（.diff / .patch 文件原生体验）

- **现状**：diff/patch 落 plaintext 高亮，读补丁全靠脑补。
- **设计**：`.patch` 解析 hunk → 原文/改文双栏 `monaco.editor.createDiffEditor`（红绿行内对比，readOnly）；`.diff` 同口径。渲染器按扩展名分流（同文件太大型走只读降级链不变）。
- **延伸（P3，另立项）**：与桶内旧版本对比——需要对象版本链支撑，不在本期。
- **成本**：1-2 天。

### P2-2 model 复用（同文件 tab 重开不重建）

- **现状**：每次打开文件 `createModel` 新实例，重开同文件 tokenizer/语言服务全量重算（大文件可感知）。
- **设计**（OpenSumi EditorCollection 思路简化版）：打开前 `monaco.editor.getModel(uri)` 命中则复用（`setValue` 同步差异）；savedState 回注链不变。
- **成本**：~半天。**风险**：model 生命周期——复用后 tab 关闭不能立即 dispose，需引用计数或 LRU 上限（防多文件长会话内存爬升）。

### P3-1 Python 格式化（可选，视用户反馈决策）

- **现状**：置灰 + 「当前语言没有可用的格式化程序」提示（**准确行为**：monaco 纯浏览器生态无官方 python worker/formatter——是「没有」不是「没开放」）。
- **路线**：
  - **A. 维持置灰（推荐默认）**——零成本，提示文案已明确；
  - **B. pyodide + black 懒加载**——~10MB 按需（仅 py 文件格式化时拉取），black 语义级质量，首次初始化数秒。
- **决策点**：py 编辑频率。低频选 A；高频刚需再上 B。

### 远期备选（不建议本期）

- `monaco.lsp`（0.57 新增 LSP client 通道）：接外部 language server——突破纯前端边界，收益需要服务端配套。
- OpenSumi 式多 worker 实例管理 / per-URI 选项合并：单编辑器场景收益低。

---

## 二、实施顺序建议（v1.1 更新）

```
✅ P1-1 主题适配（2026-10-21 完成）→ ⛔ P1-2（已关闭，无需实施）→（按需）P2-2 model 复用 → P2-1 Diff 视图 →（视反馈）P3-1 py 格式化
```

## 三、参考

- OpenSumi 源码佐证（opensumi/core `packages/editor/src/browser`，MIT）：theme 服务 / EditorCollection / feature registry（provideEditorOptionsForUri per-URI 合并——本项目未采用，单编辑器收益低）。
- worker 分发定案 + 格式化双链：memory/monaco-worker-dispatch.md、test-report/2026-10-20-01/artifacts/format-worker-e2e.mjs。
- 主题适配 + 语言配置查证：test-report/2026-10-21-01/artifacts/theme-e2e.mjs。
- 演进纪律：所有增强直接落在内置 `code.ts`（不再走独立插件——计划已取消，避免双实现漂移）。
