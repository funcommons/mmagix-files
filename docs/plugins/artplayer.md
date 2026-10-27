# 动态插件方案：artplayer-player（Artplayer 媒体播放器）

> **【实施状态注记 · 2026-10-26 审计】** 方案已全部落地；超方案实现补记：
> 1. **断流重连终态判定**：artplayer 自带自动重连（上限 5）+ 监听原始 `video:error` 计次，达 RECONNECT_MAX=5 才降级错误节点（`render.ts:16-17,84-98,176-182`）
> 2. 插件 id=`artplayer-media`；音频形态隐藏居中大播放钮（样式注入）
> 其余（体积 173KB<500KB 目标、options、白名单、savedState{time}、宿主触点）与代码一致。


| 项 | 值 |
| --- | --- |
| 版本 | V1.0（2026-10-16） |
| 性质 | 动态应用插件施工方案（对齐《../design/plugin-system.md》+《../design/jsdk-api.md》v1.1 options 通道） |
| 交付物 | `public/plugins/artplayer-player.js` 单文件 ESM 插件（目标 ≤500KB，预计 ~250KB） |

## 一、目标与非目标

**目标**
1. `mp4/webm/mov`（视频）与 `mp3/wav/ogg/flac/m4a`（音频）的 **Artplayer 播放器**应用：右键「打开方式 → Artplayer 播放器」（不抢内置 video-player/audio-player 的默认 view 位，`actions:['preview']` 菜单入口）
2. **直链优先**（对齐内置 media 渲染器口径）：`ctx.getMediaUrl` 预签名 URL 直接作播放源——浏览器原生 Range 拖动，不整文件入内存；无直链回落 `getObject` → Blob URL
3. **参数**（v1.1 options 通道）：`autoplay`（默认 false——浏览器有声自动播放策略）、`theme`（强调色；默认取宿主 `--app-primary`，取不到回落 Artplayer 默认蓝）
4. `savedState = { time }`：切 tab 回来恢复播放进度；`getState` 上报 currentTime
5. 语言自适应：`document.documentElement.lang` 前缀 zh → Artplayer `lang:'zh-cn'`，否则 `'en'`

**非目标**
- 不做 HLS/DASH/FLV（纯 视频/图片/音频 口径——图片不归播放器，走现有 image-viewer）
- 不做弹幕/倍速记忆/播放列表

## 二、功能规格

### 2.1 布局与形态

- 视频：播放器容器 absolute inset:0 居中、黑底，保持宽高比
- 音频：同 Artplayer 实例（原生可播音频），容器高度压至 ~120px 音乐条形态，文件名显示在标题层
- 工具栏能力开关：设置面板/倍速/画中画/截图（仅视频）/网页全屏/迷你进度条全部开启；`hotkey:true`（播放器聚焦时快捷键）；`mutex:true`（多实例互斥暂停）

### 2.2 保存链/生命周期

- 无未保存概念：**无 beforeDispose 确认**；dispose = `artplayer.destroy()`（移除 DOM + 事件）
- 渲染失败（getObject 不可达）：内置 media 同款错误提示节点（`app.media-load-fail`），不向调用侧抛出

### 2.3 参数语义（options.ts 纯逻辑）

| 参数 | 类型 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `autoplay` | boolean | false | 浏览器策略下有声自动播放常被拦，交宿主决定 |
| `theme` | string（CSS 颜色） | 宿主 `--app-primary` → `#23ade5` | Artplayer 强调色 |

非法值丢弃走缺省（不抛错）；归一化/映射全部纯函数可单测。

## 三、技术选型

| 件 | 选择 | 理由 |
| --- | --- | --- |
| 播放器 | `artplayer@^5`（MIT，~150KB min） | 体积 ≪500KB；功能全；中文文档；包装原生 media 元素，Range 语义不变 |
| 构建 | vite lib 单文件 ESM（同 markdown-editor 先例） | blob import 无 chunk；inlineDynamicImports + process 桩 |

## 四、文件结构

```
frontend/plugins/artplayer-player/
├─ package.json / vite.config.ts / tsconfig.json
└─ src/
   ├─ index.ts      # activate(sdk, options)：normalize → registerApp
   ├─ types.ts      # 宿主契约本地镜像（含 getMediaUrl 可选能力）
   ├─ options.ts    # 纯逻辑：参数归一化 + 主题缺省
   ├─ media-type.ts # 纯逻辑：ext → 'video'|'audio' 映射（白名单对齐内置两张 matcher 表）
   └─ render.ts     # Artplayer 装配：直链/Blob 两路径、音频形态、savedState、错误面
```

宿主侧触点：`locales/{zh-CN,en-US}.ts` 增 `app.artplayer` 词目；演示端 `EmbedPlay.vue` 增插件开关。

## 五、施工步骤（每步 ≤1000 行，测试先行，测试用子代理执行）

| # | 内容 | 验收 |
| --- | --- | --- |
| S1 | 方案 + 骨架 + options/media-type 纯逻辑 + 单测（子代理） | vitest 绿；首建出 js |
| S2 | render.ts 全量（直链/Blob/音频形态/savedState/错误面）+ 词表 + build | build 过；含 activate 导出 |
| S3 | demo 开关 + E2E 证据（视频打开出 Artplayer UI/打开方式入口/音频形态/进度恢复）+ 复审轮（≤4 或至无 P0~P2） | 证据截图 + 全绿 |

## 六、风险与对策

| 风险 | 对策 |
| --- | --- |
| Artplayer 对纯音频的黑屏体验 | 音频容器压至音乐条形态 + 标题层显示文件名 |
| mov 的浏览器兼容（H.264/MP4 容器多数可播） | 与内置 video-player 同口径（原生能力边界，不额外引解码器） |
| 预签名 URL 过期导致播放中段失败 | 与内置 media 同风险面（自毁线内有效）；不额外处理，v1.1 setCredentials 重签后新链接需重开文件 |
| 插件抢默认 view 位 | actions=['preview'] 仅入「打开方式」；registry 默认解析仍按注册序落内置 |
