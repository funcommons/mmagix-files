# mmagix-files PDF 标注签批插件设计方案（pdf.js 覆盖层 + pdf-lib 写回）

> **【实施状态注记 · 2026-10-26 审计】** P1+P2+P3 已全部落地（sidecar 导出/导入/P3 归并、AcroForm+XFA 禁用、压平写回；插件 version=1.1.0）；**未实现/口径漂移**以代码为准：
> 1. 图形仅矩形（椭圆/直线未实现）；文字框=input 一次性录入（无再编辑/字号）
> 2. 选中操作仅 click 选中 + Delete 删除（无拖动/等比缩放）；图章落位无光标跟随
> 3. i18n 未走宿主词典（硬编码中文 ~15 处）；样式全 inline cssText（无 mmagic-pdfann-* 类名/样式节点——等效无外溢，§十 A-12 验收口径按此理解）
> 4. 渲染=全页连续滚动（scale=min(2, 宽适配)；无挡位/翻页条）；签名 sessionStorage 持久（跨会话，非仅内存）；签名产物整幅 toDataURL（无 800ms 裁切/文字签名）
> 5. 加密件直接拒绝（无口令输入预览路径）；扫描件检测未实现；savedState 不消费
> 6. ink 写回逐段 drawLine（非 drawSvgPath，功能等效）；保存后 sidecar 自动重写为空（烙印一次性出口，演进自「不做自动双写」）


## 〇、头表

| 项 | 值 |
| --- | --- |
| 版本 | V1.0（2026-10-15 首版） |
| 性质 | 设计草案（候裁）——**T1 宿主自管插件**（特权运行=宿主信任域），动态应用形态、非内置 |
| 依赖正本 | 《../design/plugin-system.md》V1.1（加载机制/插件契约/安全红线）；《../design/jsdk-api.md》V1.0（`fileChanged` put/delete/rename 映射）；《../design/style-isolation.md》（`mmagic-*` 隔离约定）；《../design/plugin-sample.md》样例③（beforeDispose/消毒先例）；《../design/flow-editor-design.md》（双应用并存与「打开方式」先例） |
| 范围 | PDF 覆盖层标注 / 签批 / 手写签名 / AcroForm 填写（P2）与压平写回；不含原内容流改写、不含 PDF 生成 |
| 定位 | 插件应用 `pdf-annotator`（`actions:['edit']`），与内置 `pdf-viewer` 并存，经「打开方式」进入 |
| 一句话 | pdf.js 画布渲染 + 每页覆盖层标注 + pdf-lib 压平写回——**原内容流字节不动**，注释作为追加绘制段合并进各页对象层 |

---

## 一、定位与能力边界

### 1.1 能力矩阵

| 能力 | 期 | 说明 |
| --- | --- | --- |
| 图形标注（矩形/椭圆/直线/自由手绘笔迹） | P1 | 覆盖层绘制，写回为页面内容流追加段 |
| 文字框批注 | P1 | 覆盖层文字框；中文压平走图章化（§8.3） |
| 手写签名（签名板 → 透明 PNG 图章） | P1 | 拖放/缩放到任意页（§七） |
| 图章（预置印章样式：对勾/日期/关键字） | P1 | 同签名产物路径（PNG 图章） |
| 压平写回（flatten merge） | P1 | 注释逐条画进对应页对象层，保存覆盖原 key |
| AcroForm 表单填写 | P2 | `getForm()` 字段定位 + setValue + flatten |
| sidecar JSON（可撤销标注层导出/导入） | P2 | `<key>.annotations.json`（§五） |
| 多人批注合并（sidecar 归并） | P3 | 依赖 sidecar 通道与作者标识 |

### 1.2 不做的事（红线，拒绝口径对外明示）

| 不做 | 理由 |
| --- | --- |
| 改原文字排版/内容流（增删改原文） | 超出「签批」语义；内容流改写需全文档重排引擎（=另一个 OnlyOffice），一期不背这个复杂度 |
| OCR（扫描件文字化） | 重模型依赖，与「浏览器内自足、文件不出浏览器」口径冲突；候独立需求立项 |
| 加密 PDF 破解/移除口令 | 安全线：有口令走口令输入解锁（pdf.js 支持已知口令），**无口令硬破解绝不做** |
| XFA 表单 | pdf-lib/pdf.js 均不支持 XFA 生命周期；检测即禁用表单功能（§8.4） |
| 多人实时协同标注 | 非签批场景刚需；P3 的「合并」是异步归并，非 OT/CRDT |

### 1.3 核心不变式：不改原内容流

- **读**：原 PDF 字节经 pdf.js 渲染 + pdf-lib 双路解析，两库均只读原文档对象
- **写**：压平 = 对每个注释，在**其所在页的内容流末尾追加绘制操作符**（文字 `Tj`/图形 path/图像 XObject）——视觉上位于原内容之上，原文档既有对象（内容流/字体/资源字典条目）不修改、不删除
- 理由：① 原文可验证性——签批场景（合同/审阅）要求「批注前原文」与「批注后原文」逐字节可对照；② 复杂度收敛——增量追加只需 pdf-lib 的绘制 API，不碰内容流解析重写；③ 降级安全——注释画错只污染追加段，原文档结构损坏风险为零

---

## 二、技术选型

### 2.1 选型表

| 层 | 选型 | 许可 | 理由 |
| --- | --- | --- | --- |
| 渲染层 | **pdf.js**（`pdfjs-dist` v6，宿主已有 `^6.4.299`） | Apache-2.0 | Mozilla 出品=事实标准；canvas 逐页自绘、viewport 坐标换算 API 齐全；宿主 pdf-viewer 二级降级已趟平 worker 引入/v6 RenderParameters 口径（`frontend/src/apps/renderers/pdf.ts`） |
| 写回层 | **pdf-lib** | MIT | 纯 JS、零原生依赖、浏览器内运行；`drawText/drawSvgPath/drawImage/getForm().flatten()` 与 §4.4 写回映射一一对应；许可干净可随插件分发 |

### 2.2 否决项

| 候选 | 否决理由 |
| --- | --- |
| MuPDF（wasm） | **AGPL**——传染性许可，随 T1 插件分发即要求消费方开源整链，商用形态直接出局；且 wasm 体积（数 MB 起）数倍于 pdf.js |
| PDFBox | Java 后端库——引入即违背「文件不出浏览器、零后端转换服务」的产品口径（隐私是本产品卖点，见《产品顶层设计.md》）；签批的个人/小团队场景，浏览器算力足够 |
| 自研写回 | PDF 对象层手写成本极高（交叉引用表/对象流/压缩流），pdf-lib 已收敛，不自造 |

### 2.3 与现有 pdf-viewer 的复用关系

| 项 | 口径 |
| --- | --- |
| 复用（经验与约定） | worker 经 `?url`/inline 方式惰性引入、`RENDER_SCALE=1.5` 基准、翻页「上一页/下一页 + n / total」交互、`mmagic-*` 类名前缀、样式随实例注入随 dispose 移除、dispose=`loadingTask.destroy()` 语义——全部沿用 pdf.ts 已验证口径 |
| 不复用（字节） | 插件为**单文件 ESM 自含**（blob import 下 bare specifier 不可用，univer-office 先例），pdf.js/pdf-lib 内联进插件产物——宿主侧 pdfjs-dist 不经模块共享。代价：双份 pdf.js（插件包 gzip 约 1MB 量级，估算值）；接受理由：插件形态的隔离性优先于体积，且宿主侧那份仅在 `pdfViewerEnabled=false` 降级路径才真正加载 |
| 降级链差异 | 插件**固定走 pdf.js 自绘**，不走原生 iframe 一级——原生查看器是黑盒，无法在其上叠加覆盖层，这是形态差异不是能力退化 |

---

## 三、应用契约

### 3.1 插件 manifest（完整定义，契约见《../design/plugin-system.md》§二）

```js
// pdf-annotator.js — 单文件 ESM（vite lib + inlineDynamicImports，全依赖内联）
export function activate(sdk) {
  sdk.registerApp({
    id: 'pdf-annotator',
    matcher: { ext: ['pdf'] },          // 仅 ext：S3 常以 octet-stream 存储，mime 不可靠（契约 §一）
    renderer(el, file, ctx, savedState) { /* §四 分层实现；返回 AppInstance */ },
    actions: ['edit'],                   // 进「打开方式」菜单，与内置 pdf-viewer（preview）并列
    label: 'PDF 标注签批',
    version: '1.0.0',
    requiresSdk: 1,                      // 本批契约=1
    maxBytes: 50 * 1024 * 1024,          // §3.3 决策
  })
}
```

配置接入：`"plugins": [{ "url": "https://cdn.消费方.com/mmagic/pdf-annotator.js", "sri": "sha384-...", "lazy": false }]`

### 3.2 形态决策

| 项 | 决策 | 理由 |
| --- | --- | --- |
| `lazy: false`（启动即载） | **是** | lazy 语义=首个 matcher 命中才拉取——而 pdf 的首次打开大概率是**只读预览**（viewer 命中即触发插件拉取但菜单缺项），用户在「打开方式」里看不到 pdf-annotator，**第二次打开才齐**；签批是核心场景，菜单完备性优先，故启动即载。带宽敏感的消费方可自改 `lazy:true`（降级=首开菜单缺项，可接受） |
| 工程位置 | `frontend/plugins/pdf-annotator/`，产物 `public/plugins/pdf-annotator.js` | 对齐 univer-office 先例：vite lib mode + `inlineDynamicImports` + `vite-plugin-css-injected-by-js`（样式无独立通道，随 JS 注入）；生产由消费方托管自有 CDN + SRI（红线 2） |
| i18n | 文案全走 `ctx.t('plugin.pdf-annot.*')` 宿主词典 | 契约：i18n 通道强制走宿主词典；超限/拒绝类文案用具名插值 `{limit}`（对齐 R2-03 口径）；词典条目随宿主 locales 一并收口 |
| 发布清单 | 按《../design/plugin-sample.md》附表自检 | SRI 生成、消毒自查、dispose 全路径、端到端闭环 |

### 3.3 `maxBytes: 50MB` 与并存

- **50MB = 全局预览闸 `PREVIEW_REJECT_BYTES` 同线**（`files/preview.ts`）：预览闸实际拒绝线=`min(50MB, maxBytes)`，两闸同线即无「确认后仍拒」的双闸错位——R2-03 事故的直接教训。>50MB 在闸上拒绝并给下载引导，不入渲染器
- **并存**：内置 `pdf-viewer` 注册在先（注册序=默认优先级），双击 pdf 默认仍进只读预览；`pdf-annotator` `actions:['edit']` 经「打开方式」进入——与 csv-table/code-editor、mermaid-viewer/flow-editor 完全同构，**registry 零特判、JSSDK 协议零改动**

---

## 四、架构分层

```
PDF 字节（ctx.getObject → Blob）
   │
   ├─① 预检层：加密/XFA/maxBytes 判定（§八）→ 拒绝即提示，不进编辑态
   │
   ├─② 渲染层：pdf.js canvas 单页渲染（缩放/翻页与 pdf-viewer 同口径）
   │      viewport = 坐标换算唯一出口（screen ⇄ PDF 用户空间，含 rotation）
   ├─③ 覆盖层：每页一个绝对定位 SVG/DOM 层（仅当前页实例化）
   │      文字框 / 手绘笔迹 / 矩形·椭圆·直线 / 签名图章 / AcroForm 字段控件
   ├─④ 模型层：内存 annotation 模型（页码/类型/几何/样式/作者/时间）+ undo 栈
   │      ← 唯一可变状态源；覆盖层是它的投影
   └─⑤ 写回层：pdf-lib 逐注释画到对应页（§4.4 映射表）→ putObject 覆盖原 key
```

### 4.1 渲染层（pdf.js）

- 单页 canvas 渲染，`RENDER_SCALE=1.5` 基准 + 缩放挡位（0.75/1/1.5/2），翻页复用「上一页/下一页 + `n / total`」口径；worker 经 `?worker&inline` 内联（vite 产物自含）+ `GlobalWorkerOptions.workerPort` 注入
- **坐标系决策**：模型存 **PDF 用户空间坐标（pt，原点左下）**，屏幕坐标经 `viewport.convertToViewportPoint/convertToPdfPoint` 换算。理由：① 与写回 1:1（pdf-lib 同为用户空间）；② 与缩放无关（缩放只重投影不改模型）；③ 页面 rotation 由 viewport 单一函数对吸收，不散落换算逻辑

### 4.2 覆盖层（SVG/DOM）

| 注释类型 | 覆盖层形态 | 交互 |
| --- | --- | --- |
| 矩形/椭圆/直线 | SVG `rect/ellipse/line`（createElementNS，不走 innerHTML） | 拖拽绘制、选中、删除 |
| 手绘笔迹 | SVG `path`（点列→二次贝塞尔平滑） | pointer 采集、笔画宽度挡位 |
| 文字框 | 绝对定位 `<div contenteditable>`，文字经 textContent 注入 | 双击编辑、字号/颜色 |
| 签名图章 | 绝对定位 `<img>`（PNG dataURL） | 拖放、等比缩放 |
| AcroForm 字段（P2） | 按 fieldType 映射 input/select/checkbox，锚定字段 rect | 聚焦填写、Tab 序 |

- **隔离**：`mmagic-pdfann-*` 类名前缀；`<style>` 随实例注入、dispose 移除（《../design/style-isolation.md》）；色值全走 `ctx.theme` token，禁硬编码
- 覆盖层仅当前页实例化——翻页即按模型重建该页投影（注释多时无 DOM 积累）

### 4.3 模型层（内存 annotation 模型）

```ts
interface Annotation {
  id: string                 // nanoid
  page: number               // 1-based
  type: 'rect' | 'ellipse' | 'line' | 'ink' | 'text' | 'stamp'
  rect?: Rect                // 用户空间 {x,y,w,h}（y=左下）
  points?: Pt[]              // ink 专用，用户空间点列
  text?: string              // text/stamp 附加文本
  style: { color: string; strokeWidth?: number; fontSize?: number }
  author: string             // 会话身份（P3 合并的去重键）
  createdAt: string          // ISO
  formField?: string         // P2：AcroForm 字段名
}
```

- **唯一可变状态源**：覆盖层/写回层都是模型的投影——渲染、undo、sidecar 导出（P2）共享同一份模型，无第二真相
- undo 栈=模型操作逆命令（会话内存）；**保存即压平，压平后撤销不可达**（写回的是原文档新字节，undo 栈只管未保存会话）——不可逆性在保存按钮文案明示（「保存（压平合并）」）
- `getState()` 返回 `{ dirty, count }` 供宿主查询；`savedState` 恢复仅作 dirty 提示口径，不恢复标注（标注属未保存易失态，见 §六）

### 4.4 写回层（pdf-lib 逐注释映射）

| 模型类型 | pdf-lib API | 注记 |
| --- | --- | --- |
| text（Latin-1 内） | `page.drawText(text, { x, y, size, font, color })` | 标准字体 14 态（§8.3）；行盒→基线换算收敛在单一函数，与 DOM 渲染共用行高常量 |
| text（含 CJK） | canvas 光栅化 → `embedPng` → `drawImage`（图章化） | 标准 14 字体无 CJK 字形；图章化视觉无损、体积可控（§8.3） |
| rect/ellipse/line | `page.drawRectangle/drawEllipse/drawLine` | 描边色宽、填充色直传 |
| ink | `page.drawSvgPath(path, { x, y, borderColor, borderWidth, scale })` | pdf-lib 的 SVG path 采用 **y 向下**约定——写回换算以 `page.getHeight()` 为基准翻转，换算函数唯一出口 |
| stamp（PNG） | `doc.embedPng(bytes)` → `page.drawImage(img, { x, y, width, height })` | 签名/图章/中文文字框同产物路径 |
| AcroForm（P2） | `doc.getForm().getTextField(name).setText(v)` 等按 fieldType 分派 → `form.flatten()` | 字段值对象变更 + 字段外观压平进页面；XFA 检出则整链禁用 |

- 写回输入=**原始字节**（getObject 时留存），非渲染态快照——pdf.js 与 pdf-lib 各自解析同一字节流，互不耦合
- 保存产物为**全量重写**（pdf-lib 非增量保存）：交叉引用表重建，原对象内容不变仅编号重排——与 §1.3「不改内容流」不矛盾（对象内容不变，物理布局重建）

---

## 五、数据双通道（决策：默认压平单通道，sidecar 作可选导出）

| 通道 | 形态 | 优点 | 代价 |
| --- | --- | --- | --- |
| **a. 仅存 PDF 内（压平）**【默认】 | 注释压进 PDF 本体，覆盖原 key | 正本唯一；外发即自带批注（合同/审批闭环的硬需求）；零派生键 | 不可撤销（写回后）；不可机器再编辑 |
| b. sidecar JSON（`<key>.annotations.json`）【P2 可选】 | 标注层独立存 JSON，原 PDF 恒不变 | 可撤销、可再编辑、P3 多人归并的基础 | 派生键一致性负担：rename/delete 不级联（与《流程图应用设计》§八.3 旁路键同一开放问题）；外发文件不带批注，需「先压平再导出」两步 |

**取舍建议**：签批场景的正本就是「带批注的 PDF」本身——默认 a；sidecar 仅作为**显式导出动作**（「导出可撤销标注层」）与 P2/P3 的进阶能力，不做自动双写。理由：① 双写引入「PDF 与 sidecar 谁是真相」的同步问题，一期不背；② 派生键生命周期（对象删除/重命名后的孤儿 sidecar）尚无通用机制，先不欠债；③ sidecar schema 直接复用 §4.3 模型 JSON（`schema=v1` 版本字段开头，对齐 mermaid meta 惯例），P2 落地无迁移成本。

---

## 六、保存链与生命周期

| 项 | 口径 |
| --- | --- |
| 保存链 | 组装 pdf 字节 → `ctx.putObject(file.key, new Blob([bytes], {type:'application/pdf'}))` → `ctx.notify('saved', { key: file.key })` → 宿主 `fileChanged { action:'put' }`（《../design/jsdk-api.md》§六映射）→ 树/面板刷新 |
| 不自动保存 | **决策：仅显式保存（按钮/Ctrl+S）**。压平是不可逆合并，auto-save 会随时间推移吞掉撤销窗口——与 code-editor 的脏态自治同构，但这里不可逆性更强，更不能自动 |
| 关闭确认 | `beforeDispose(): Promise<boolean>`——dirty 时 `confirm` 保存/放弃/取消；resolve `false`=暂缓关闭，**3 秒竞速**宿主强制放行；`expired/destroy` 路径宿主只通知不询问（仍调用但忽略返回值，保存窗口期=凭证 TTL 内）。契约原文见《../design/plugin-system.md》§五 |
| 只读/无权限 | `putObject` 被 S3 侧拒（scope 外）或会话只读闩锁（4305）→ 保存失败提示 + dirty 保持，不丢标注（对齐 code-editor 口径） |
| 大文件策略 | **>20MB 进编辑态时提示**（「标注与保存耗时可能较长」）——内存放大系数约 3–4×（pdf.js 字节副本 + canvas + pdf-lib 重建副本）；50MB 硬闸在预览闸（§3.3），提示与硬闸分层各管一段 |
| 逃生通道 | 「下载副本」=本地导出压平 PDF，**不落桶不改原文件**——对外发前的预览/比对场景零风险 |
| 会话恢复 | renderer 第 4 参 `savedState`（上次 `getState()` 返回）仅用于「上次有未保存标注」的提示口径；标注本体不跨 dispose 存活（无 sidecar 时），理由=易失态明示优于假持久 |

---

## 七、手写签名交互

1. **签名板**：工具条「签名」→ 模态浮层 canvas（`pointerdown/move/up` 采集，touch/pen/mouse 统一 pointer events；点列→二次贝塞尔平滑，笔画宽度挡位）
2. **产物**：停止输入 800ms 或点「完成」→ 离屏 canvas 按笔迹包围盒裁切 → **透明底 PNG**（dataURL）→ 归一为 `type:'stamp'` 注释进入模型
3. **文字签名**：同浮层提供「输入文字 + 手写体字体 canvas 渲染」路径，产物同为 PNG 图章（避开字体嵌入问题，§8.3）
4. **落位**：图章挂光标跟随，点击任意页落位；选中后等比缩放/拖动/删除
5. **留存决策**：签名 PNG 仅**会话内存留存**（tab 存续期内重复使用零成本）；跨会话留存候 P2——依赖 ctx 轻量存储能力（《../design/plugin-system.md》§二提及 sessionStorage 隔离命名空间，`types.ts` AppCtx 尚未落该字段，不假设能力存在）
6. **安全**：PNG dataURL 只进 `<img src>` 与 `embedPng` 字节通道；签名板 DOM 全程序化创建，无 innerHTML 面（样例③消毒注记同源）

---

## 八、风险与边界

| # | 风险 | 判定 | 处置 |
| --- | --- | --- | --- |
| 8.1 | 加密 PDF | pdf.js `getDocument` 抛 `PasswordException`；pdf-lib `ignoreEncryption` 只能「读」不能正确「写」 | 预检层拒绝进编辑态：已知口令可走 pdf.js 口令输入后**仅预览**，写回一律拒绝并 `ctx.t` 提示（红线：不破解） |
| 8.2 | 扫描件（无文字层） | pdf.js `page.getTextContent()` 为空即判定 | 不阻断——文字框/图形/签章照常（新增覆盖层不依赖原文文字）；仅「按原文文字锚定」类能力天然缺失，提示但不拦截 |
| 8.3 | 字体嵌入 | pdf-lib 标准 14 字体无 CJK 字形，`drawText` 中文即乱码 | **写回固定标准 14 态**（零字体依赖、零体积膨胀、跨阅读器兼容最好）；含 CJK 的文字框压平走**图章化**（canvas 光栅化→PNG→drawImage，§4.4），Latin-1 内走 `drawText`；真字体子集嵌入（fontkit + NotoSansSC）候 P2，代价=插件包再增数 MB |
| 8.4 | XFA 表单 | AcroForm 字典含 XFA 键即判定 | 表单填写整链禁用 + 提示；覆盖层标注/签章不受影响（画在页面上，不碰表单对象） |
| 8.5 | 损坏/非线性化 PDF | pdf-lib `PDFDocument.load` 抛错 | 捕获 → 提示节点（`ctx.t`），不向宿主抛出（错误边界兜底同 pdf.ts 口径） |
| 8.6 | 大文件内存放大 | §六：>20MB 提示、>50MB 预览闸拒绝 | 分层闸，不重复建闸（R2-03） |
| 8.7 | 供应链 | 插件 js 被篡改 | 配置 SRI sha384 + 消费方插件域白名单（红线 2/3，宿主已执法，插件侧零额外动作） |

---

## 九、分期

| 期 | 交付 | 验收锚点 |
| --- | --- | --- |
| **P1 覆盖层签批 + 压平写回** | 预检层 / pdf.js 渲染 / 图形+文字+签名+图章 / 压平写回 / 保存链与关闭确认 | §十 A-01～A-12 |
| **P2 表单填写 + sidecar** | AcroForm 定位填写 + flatten；sidecar 导出/导入（`schema=v1`）；签名跨会话留存（候 ctx 轻量存储落地） | 表单字段值回读一致；sidecar 往返无损 |
| **P3 多人批注合并** | sidecar 归并（按 author 去重、按 createdAt 定序、冲突保留双份人工裁）+ 一次性压平出口 | 双人 sidecar 合并后压平，PDF 打开可见双方标注 |

> P1 即形成「打开 → 标注 → 保存 → 外发自带批注」完整闭环；P2 起才有可撤销层与表单面。

---

## 十、验收清单（playwright 可断言）

| # | 场景 | 步骤 → 断言 |
| --- | --- | --- |
| A-01 | 打开 | seed 放 pdf → 「打开方式」含「PDF 标注签批」→ 进入后 canvas 出首页、工具条渲染、页码 `1 / N` |
| A-02 | 画框 | 拖拽画矩形 → 覆盖层出现 SVG 节点、dirty=true |
| A-03 | 未保存关闭 | dirty 状态关 tab → 确认弹窗出现；取消=tab 不关（beforeDispose=false 生效） |
| A-04 | 保存链 | Ctrl+S → PUT 请求 `content-type: application/pdf` 落原 key → 宿主 `fileChanged action='put'`、树刷新 |
| A-05 | **重开可见压平结果** | 保存后分别经 pdf-viewer 与 pdf-annotator 重开 → 矩形可见。**用内置 viewer 验证是硬标准**：证明标注已进 PDF 内容层而非插件回放 |
| A-06 | 翻页跟随 | 画框后翻页再翻回 → 注释几何不漂移；翻至无注释页覆盖层为空 |
| A-07 | 中文文字框 | 输入中文 → 保存回读 → 页面上文字可见（图章化位图），无乱码方块 |
| A-08 | 签名 | 签名板画笔迹 → 完成落章到第 2 页 → 保存重开可见 |
| A-09 | 加密拒绝 | 口令加密 pdf 进编辑态 → 拒绝提示文案出现，工具条不可用 |
| A-10 | 大文件 | >20MB：进编辑态出耗时提示；>50MB：预览闸拒绝 + 下载引导（不入渲染器） |
| A-11 | 只读会话 | 只读凭证保存 → 失败提示 + dirty 保持、标注未丢 |
| A-12 | 隔离与清理 | 关 tab 后 `mmagic-pdfann-*` 样式节点移除；宿主工作台样式无污染 |

---

## 附、参考

- pdf.js（渲染层，Apache-2.0）：https://github.com/mozilla/pdf.js ；v6 RenderParameters/viewport API
- pdf-lib（写回层，MIT）：https://github.com/Hopding/pdf-lib ；`drawSvgPath` y 向下约定、`PDFForm.flatten()`
- 标准 14 字体与 CJK 限制：PDF Reference 1.7 附录 D；@pdf-lib/fontkit 子集嵌入（P2 候选）
- 本仓：`frontend/src/plugins/loader.ts`（加载契约实现）；`frontend/src/sdk/types.ts` §应用模型（AppDefinition/AppCtx/AppInstance）；`frontend/src/apps/renderers/pdf.ts`（pdf.js 渲染口径正本）；`frontend/plugins/univer-office/`（单文件 ESM 插件工程先例）
