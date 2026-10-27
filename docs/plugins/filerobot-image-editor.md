# 动态插件方案：filerobot-image-editor（图片编辑器）

> **【实施状态注记 · 2026-10-26 审计】** 两处方向性声明被实现推翻，以代码为准：
> 1. **源一律 Blob**——getMediaUrl 预签名直链路径未实现（内核强制 crossOrigin 匿名读像素，直链无 CORS 即失败；`types.ts:9` 为死声明）
> 2. **未保存确认已实现**（onModify 置脏 + beforeDispose confirm 3s 竞态）——非目标声明作废
> 3. Tab=内核 4.9 仅 6 个（Adjust/Finetune/Filters/Annotate/Resize/Watermark；无独立 Crop Tab、无 Stickers/Frame）
> 4. 保存格式以弹层用户选择优先（'image/jpg'→'image/jpeg' 归一；bmp/gif 回落 png）
> 5. 超方案实现：无修改不可保存、保存成败徽标、图标化重排、useBackendTranslations:false 断网防卡死（`render.ts`）


| 项 | 值 |
| --- | --- |
| 版本 | V1.0（2026-10-18） |
| 性质 | 动态应用插件施工方案（对齐《../design/plugin-system.md》+《../design/jsdk-api.md》v1.1 options 通道） |
| 交付物 | `public/plugins/filerobot-image-editor.js` 单文件 ESM 插件（**实测全量 ~1.3MB / gzip ~390KB**，参考在产 univer-office 8.7MB 先例，可接受；插件 lazy/打开方式触发） |

## 一、目标与非目标

**目标**
1. `png/jpg/jpeg/webp/bmp/gif` 的**图片编辑**应用：右键「打开方式 → 图片编辑（Filerobot）」（`actions:['edit']`，不抢 image-viewer 默认位）；heic 不入编辑白名单（canvas 原生不可解码）
2. Filerobot 8 大 Tab 全量：Crop（裁剪/翻转/旋转）· Fine-Tune（微调）· Filters（滤镜）· Annotate（文字/气泡/箭头/路径/矩形/多边形/椭圆/画笔/高亮）· Resize · Watermark · Stickers · Frame
3. **保存链与内置应用同口径**：编辑器 Save → `onSave` → 导出 Blob（默认 png；jpg/jpeg/webp 按原扩展）→ `ctx.putObject` + `ctx.notify('saved')`
4. **源两级**（对齐 media/painter 口径）：`ctx.getMediaUrl` 预签名直链作 `source`；无直链回落 `getObject` → Blob
5. **参数**（v1.1 options）：`defaultTab`（打开时定位的 Tab）

**非目标**
- 不做 heic 编辑；不做图层合成（miniPaint/PS 级）
- 编辑器中文化只覆盖核心词条（translations 深合并覆盖 Tabs/常用按钮；全量翻译后续补）
- 关 tab 不做未保存确认（Filerobot 无可靠的 dirty 查询 API；方案注明）

## 二、功能规格

- 布局：root absolute inset:0，编辑器满容器（styled-components 自注入样式，无 CSS 引入）
- `closeOnSave:false`：Save 后编辑器保持打开（画布所见即所存）
- `source`：直链优先；无直链 `getObject` → Blob（导出不依赖源形态）
- 错误面：字节流不可达 → 容器内错误提示节点（`app.media-load-fail` 同款口径），不向调用侧抛出

## 三、技术选型

| 件 | 选择 | 理由 |
| --- | --- | --- |
| 编辑器 | `filerobot-image-editor@5.0.0-beta.159`（latest 标签，vanilla 桥接版；MIT） | 功能最全的活跃开源图编辑器；**实测 bundle 1290KB/gzip 387KB**（react19+react-konva+styled-components 全家桶，不可 tree-shake，见《体积实测》记录） |
| 构建 | vite lib 单文件 ESM（同 artplayer 先例） | inlineDynamicImports + process 桩 |

## 四、文件结构

```
frontend/plugins/filerobot-image-editor/
├─ package.json / vite.config.ts / tsconfig.json / pnpm-workspace.yaml
└─ src/
   ├─ index.ts      # activate(sdk, options)：normalize → registerApp（含 8 Tab 白名单外的防御缺省）
   ├─ types.ts      # 宿主契约本地镜像 + EditorOptions
   ├─ options.ts    # 纯逻辑：参数归一化（defaultTab 合法值白名单）
   ├─ i18n-zh.ts    # 纯数据：核心词条 zh 覆盖层（translations 深合并）
   └─ render.ts     # 装配：直链/Blob 源、onSave 保存链、错误面、dispose
```

宿主侧触点：`locales/{zh-CN,en-US}.ts` 增 `app.filerobot-editor`；演示端 `EmbedPlay.vue` 增插件开关。

## 五、施工步骤（每步 ≤1000 行，测试先行，测试用子代理执行）

| # | 内容 | 验收 |
| --- | --- | --- |
| S1 | 方案 + 骨架 + options.ts 纯逻辑 + 单测（子代理）；安装依赖 | vitest 绿；首建出 js |
| S2 | render.ts 全量（源两路径/保存链/zh 覆盖层/错误面）+ 词表 + build + 体积复核 | build 过；activate 导出；~1.3MB 记录在案 |
| S3 | demo 开关 + 专用测试夹具 + E2E 证据（编辑器 UI 挂载/Tab 存在/保存→桶字节变化→夹具还原）+ 复审轮（≤4 或至无 P0~P2） | 证据 + 全绿 |

## 六、风险与对策

| 风险 | 对策 |
| --- | --- |
| 1.3MB 体积 | univer 8.7MB 在产先例可容；打开方式触发按需加载 |
| beta 版本线（latest=5.0.0-beta.159） | 锁定精确版本；上线前回归保存链 |
| 中文覆盖不全（官方 en） | translations 深合并核心词条；缺口留英文不破功能 |
| 大图内存（canvas 解码） | 编辑白名单排除 heic；大图受全局预览闸约束（同内置 painter） |
