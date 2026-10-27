# mmagix-files 开发进度（/loop 无人值守锚点）

> **【已封存 · 2026-10-26】** 本文件为 2026-10-10 前后 /loop 无人值守开发期的过程锚点（任务已完结），
> 状态行/基线数字均已过期，仅作历史档案保留。决策与变更的现行正本：[CHANGELOG](../CHANGELOG.md) 与 [docs/design/](../docs/design/)。


> 本文件是跨上下文压缩的任务锚点：每次推进后更新状态与计数器。
> 契约正本 = `documents/`（JSSDK 接口文档 V1.0 / 动态插件方案 V1.1 / 第一期文件类型支持计划 V1.0）。

## 执行纪律（用户令）

- 分步 ≤1000 行；每步流程：写测试→写业务→测试→修复，≤4 轮或无 P0~P2 建议即收
- 测试编写与执行由子 agent 负责；不阻塞其他写码
- 全量测试触发：变更 >10% 或 >1000 行或 >10 个任务（子 agent 执行）
- 无人值守：技术决策自裁并记录于「决策记录」

## 决策记录

- SDK 代码 = `frontend/src/sdk/`；管理面 = `frontend/src/files/`；UI 组件用 Fc* 组件库
- 共享契约文件（`constants.ts` / `errorCodes.ts` / `types.ts`）由主线持有，子 agent **只读**
- jsdom 无 `crypto.randomUUID` → bus 内置 fallback uuid
- **tsconfig 开 `erasableSyntaxOnly`：禁构造器参数属性（`constructor(private x)` ✗）——一律显式字段赋值**（A6 发现）
- `S3Client` 接口定义在 `types.ts`：A3 实现、A5 消费（测试用 mock 实现，不依赖 A3 完成度）
- 应用 code（registry id）=《第一期文件类型支持计划.md》表列值
- 会话执法=凭证 TTL；前端定时器=UX 线（T-5min 预警），非安全线

## Wave 1（进行中）——5 agent 分工

| Agent | 谱 | 独占写文件 | 状态 |
| --- | --- | --- | --- |
| A1 通道 | postMessage 双向（origin 校验/ready 队列/超时/reply 匹配） | `src/sdk/bus.ts` + `src/sdk/__tests__/bus.test.ts` | ✅ 44+1skip |
| A2 配置凭证 | `#config`/`#file` 解析校验+`fetchCredentials()` 接缝 | `src/sdk/config.ts` `src/sdk/credentials.ts` + `__tests__/config.test.ts` `__tests__/credentials.test.ts` | ✅ 43 |
| A3 S3 面 | SigV4（时钟偏移补偿）+ API 子集客户端 | `src/sdk/s3/sigv4.ts` `src/sdk/s3/client.ts` + `src/sdk/s3/__tests__/*.test.ts` | ✅ 37 |
| A4 会话命令 | 自毁定时器+15 命令 handler+barrel | `src/sdk/session.ts` `src/sdk/handlers.ts` `src/sdk/index.ts` + 2 测试 | ✅ 21 |
| A5 管理 store | 文件树/上传队列/操作状态（pinia，mock S3Client） | `src/files/tree-store.ts` `src/files/upload-queue.ts` `src/files/index.ts` + `src/files/__tests__/*.test.ts` | ✅ 18 |
| A6 单文件数据源 | `#file` URL provider（get/put/只读拒） | `src/sdk/url-source.ts`（主线写）+ `__tests__/url-source.test.ts`（A6 agent） | ✅ 27 |
| A7 应用注册表 | AppRegistry（matcher AND-OR/id 去重/requiresSdk/默认应用） | `src/apps/registry.ts`（主线写）+ `src/apps/__tests__/registry.test.ts`（A7 agent） | ✅ 43 |
| A8 门控+Ctx | features 门控 + AppCtx 工厂（notify 映射） | `src/sdk/features.ts` `src/apps/ctx.ts`（主线写）+ 两个测试（A8 agent） | ✅ 29 |

## 任务台账

- [~] W1-A1 bus ——✅ 44+1skip 绿（938 行，3 轮收敛）；决策：排队命令不计超时（flush 后起算）、首 reply 优先、origin 拒绝仅 console.warn、jsdom 真实 postMessage 全安全路径 skip 留注记
- [~] W1-A2 config/credentials ——✅ 43/43 绿（config 187 + credentials 42 + 测试 435 = 664 行）；
  决策：mode 与 URL 键冲突→4001；save.url 必校验；detail 收集式；fetchCredentials=独立函数+接口（增强期换 provider 零改动）
- [ ] W2 装配注意：ttlSeconds 上限截断（TTL_HARD_CAP_SEC）在装配层做（A2 建议，A4 不感知）——✅ 已在 boot.ts 落实
- [~] W2-A9 boot 测试 ——✅ 12 用例一次全过 + bus 回归 44+1skip 与基线一致（boot.ts 零 bug 未改动）；
  缝隙已补：BootOptions.overrides（回调形态，config 就绪后构造 M1 overrides）；boot 的 emit 缝由 no-op 改为 bus.emit（M1 业务事件出站）
- [ ] M1 overrides 集成：main.ts 在 overrides 回调里接 createM1Overrides——待 W2-T2 的 setup.ts 落地（需要 client/tree/queue 构造）
- [~] W1-A3 sigv4/s3client ——✅ 37/37 绿（920 行，3 轮收敛）；签名对齐 AWS 官方金样本（独立推算非循环论证）；
  决策：x-amz-content-sha256 仅 s3 域、host 只签不回传、get 404 不抛、DeleteObjects 用 checksum-crc32、completeMultipart 查 200-with-Error、目录 key 保留尾 `/` 可直接作 prefix
- [ ] W2 注意：list 单页语义（A5 已负责聚合翻页）；超大文件直传可启用预留的 unsignedPayload 选项
- [~] W1-A4 session/handlers ——✅ 21/21 绿（688 行，1 轮收敛）；
  决策：expiresInSec 无 TTL 时用 -1 哨兵（Infinity 破坏 JSON）；终态先到先得；overrides 在终态/模式门之后
- [~] W1-A5 tree-store/upload-queue ——✅ 18/18 绿（恰 1000 行）；决策：取消专码 4901（≥4900 识别取消）、
  目录 rename 平铺+断点续跑（detail 携 done/total）、loadDir 过滤目录标记而 rename/remove 保留、force 失败保留旧缓存
- ✅ **Wave 1 全落（8/8，262 用例+1skip）** → 已触发第一次全量测试（W2-T3 子 agent，排除在途 boot.test.ts）
- [~] W1-A6 url-source ——✅ 27/27 绿；顺手修主线 errorCodes.ts 的 erasableSyntaxOnly 违例（SdkError 参数属性→显式字段）
- [~] W1-A7 registry ——✅ 43/43 绿；测试先行抓出 P1：裸名（无扩展名）被 ext 误认领→改为点分隔命中；TS2532 修复
- [~] W1-A8 features/ctx ——✅ 29/29 绿；抓出主线 P1 并修：requireFeature 缺省键误禁→仅显式 false 关闭
- [ ] W2 蓝图（Wave1 全落+全量测试后执行）：
  - **W2-T1 装配层 `src/boot.ts` ——✅ 已落（主线，约 190 行）**，A9 测试在跑；接线决策：
    - bus 加性 API `ctx.replyError(code,payload)`（HandlerContext 扩展）：异步 handler 失败回 ok:false+code（bus 同步 catch 只兜同步抛错）——A9 同时负责 bus 45 用例回归
    - destroy 时序：onExpire 的 emit('expired')+bus.destroy 延迟宏任务，保证 ack（微任务）先行（契约 §三）
    - origin：workspace=security.allowedOrigins；file=security?.allowedOrigins ?? referrer 推导（types.ts SingleFileConfig 已加 security?）
    - targetOrigin=referrer origin，兜底 allowedOrigins[0]；无 host origin → remote 禁用（通道静默，UI 仍可渲染）
    - ttlSeconds 装配层截断 TTL_HARD_CAP_SEC（A2 建议采纳）
  - **W2-T2 工作台 UI ——✅**：setup.ts/TreePanel/Toolbar/SessionBanner/Home 四分支（实现 800+测试 314）；
    src/files 58/58 绿、全量 690 passed+1skip（**计为全量回归 #2**）、typecheck 0、lint 0 错 5 warn
  - [x] **M1 overrides 集成 ✅**：setup.ts 抽 setupStores(cfg,emit) 纯构造（解 handle 时序）；
    main.ts overrides 回调接 createM1Overrides（懒 busRef——命令执行晚于 bootApp 返回，时序安全）；
    集成后 typecheck 0 错、src/files 58/58 绿。**M1 管理面全链路完成**
  - **W2-T3 全量测试（子 agent）**：✅ **第一次全量绿（零修复）**——603 passed/1 有意 skip，typecheck 0 错，lint 0 错 5 warn，两轮复跑稳定
  - [ ] 全量测试 P2 backlog：①lint 未覆盖 .ts→建议 `eslint "src/**/*.{ts,vue}"`；②jsdom localStorage 警告噪音→setup.ts stub；③boot '*-disabled-' 占位 targetOrigin 行为待 A9 显式覆盖；④bus iframe 双窗用例待 happy-dom/真浏览器
  - [~] W2-A10 commands.ts ——✅ 25/25 一次全绿、实现零改动；nit 挂账：download 不 revokeObjectURL（保守正确）、createFolder 不 trim（契约未定）
  - [~] W2-A11 builtins.ts ——✅ 11/11 一次全绿、实现零改动（与计划表口径核对通过）
  - [~] W2-A12 plugins/loader.ts ——✅ 18/18 一次全绿；修正 loader 构造器 erasableSyntaxOnly 违例；失败模式/幂等/SRI 现算对照全覆盖
  - [~] W2-A13 datasource.ts ——✅ 6/6 绿、实现零改动（fake blob 避免预读 Response 的策略值得沿用）
  - ⚠️ **契约实现口径修正**（主线发现）：script 标签拿不到模块导出，`export activate(sdk)` 无人调用——
    加载机制改为 fetch 字节+crypto.subtle 自算 sha384（等价 SRI、失败可控）→ Blob URL import()；《动态插件方案.md》§一已同步修订（V1.1a 口径）
- [x] M0 boot 接线：main.ts bootApp→BOOT_KEY provide；Home.vue 错误态/会话信息；双语 key（boot.*）——纯装配 glue，测试由全量+E2E 覆盖
- [ ] M2：预览/编辑应用（AppRegistry + 图片/md/文本代码/CSV…，见文件类型计划）
- [ ] M3：registerApp 插件加载（SRI 标签注入）+ OEM/i18n 收口
- [ ] M4：docx/xlsx 预览、pptx 降级判定

## 计数器（全量测试触发：>10 任务 或 >1000 行 或 >10%）

## 修复波次 W-F（2026-10-09：文档实现度审计 → 用户令「A」=修代码）

> 审计：4 子 agent 覆盖 6 份文档，约 40 处缺口/偏差。范围=A（P0/P1/P2 修代码）；
> **不在本期**：多 tab 系统（openFile/closeTab/select 桩维持 4301）、宿主侧 SDK 交付物、文档回写（候「B」令）。
> 主线预置：locales 新增键（app.* 11 labelKey / plugin.* / files.menu.* / files.upload.* / preview-error / open-with / delete-multi-confirm / toolbar.download）；
> pnpm add fflate heic2any pdfjs-dist；types.ts UploadRejected+code?。

### 决策记录（W-F）

- Range 拖动 = S3 presigned GET URL 交 `<video src>`（浏览器原生 Range+渐进），非 MSE 分片；url source 用原始 URL
- scrub 补偿 = sessionStorage 备份原始 fragment（同源、带 exp、expired/destroy 即清）——兑现手册「刷新重建」；scrub 初衷（防 URL/历史外泄）不受影响
- beforeDispose 链：false=取消本次切换/关闭（保留当前实例）；3s 超时强制放行；expired=通知式（不等结果）——契约《动态插件方案》§五
- 错误边界在 preview.ts（stage 容器属主）：renderer try/catch+10s 超时 → 错误节点（重试=重跑 open；下载钮受 canDownload=features.download 门控）
- open(entry,{appId})：指定应用打开（「打开方式」菜单基础）；未命中走 registry 既有 not-found 语义 → 错误节点
- savedState：per-key Map（LRU 截断）缓存 getState()，重开第 4 参回注
- registerApp in-flight 竞态：loader 按 url memoize load Promise（短路返回同一在途 Promise）

### Lane 台账

| Lane | 独占写文件 | 内容 | 状态 |
| --- | --- | --- | --- |
| F1 预览核心 | files/preview.ts(+tests) | beforeDispose/savedState/错误边界/open appId/expire() | ✅ 23 用例绿 |
| F2 装配协议 | main.ts boot.ts sdk/config.ts sdk/features.ts plugins/loader.ts(+tests) | scrub 补偿/plugins 总闸/appearance+setTheme-setLocale 生效/loader 竞态+blob revoke | ✅ 35 用例、既有断言零改 |
| F3 工作台消费 | views/Home.vue files/ui/Toolbar.vue files/setup.ts files/tree-store.ts(+tests) | notifyFileChanged 真接线/file 模式 fileChanged/download 门控/Toolbar 下载钮/expired 清理/ui.defaultOpen/calibrateClock(经包装 fetcher) | ✅ 14 用例、89/89 |
| F4 命令语义 | files/commands.ts(+tests) | uploadProgress 200ms 节流/全批拒收→uploadFailed(error.code)/rejected.code/缺省选择器 | ✅ 15 用例、40/40 |
| F5 交互面 | files/ui/TreePanel.vue files/ui/UploadPanel.vue(新) files/ui/workspace-ops.ts(新) views/Home.vue files/zip.ts(新) e2e/* | 右键菜单/双击+回车打开/多选+批量删除/拖拽上传/上传面板(取消)/zip 打包(256MB 帽) | ✅ +17 vitest；e2e 38/38 |
| F6 渲染器 | apps/renderers/* apps/datasource.ts sdk/s3/*(+tests) | heic2any/pdf.js 二级降级(pdfViewerEnabled!==false 判定)/Range=presign(零依赖同步 SHA-256 金样本)/painter 原格式导出 | ✅ 41 用例、241 绿、typecheck 0 |
| 主线收口 | types.ts ctx.ts preview.ts locales Home 注释 | getMediaUrl 贯通(AppCtx 可选能力→ctx→preview)；app.heic-* 专用键；files.msg.zip-too-large 补键 | ✅ 渲染器 111/111 复绿 |
| 收尾 | — | **全量回归五门禁一次全绿、零修复**：typecheck 0 / lint 0 错 5 警(与基线逐条同) / vitest 929+1skip(66 文件) / e2e 38 / build 25.3s(heic2any 1.35MB+pdf 438KB+worker 1.2MB 均独立切分)；三项核对：preview API 契约一致、fileChanged 单源无双发、动态切分达标 | ✅ |
| 复审 | — | 4 路复审完成：原 ~42 项缺口=23 闭合/8 B 范围/5 按预期开放/6 小项；新发现 6 条均低危（download 注释矛盾/def.label 未消费/heic loading 提示/theme 空 token + 2 文档回写项） | ✅ |

### A-mini 收口（2026-10-09，用户令「a」）

- ✅ ①download 命令层失败不中断其余（`failed ??=` 续跑，终态首个失败汇总）②打开方式菜单显示名三档优先级：`te(def.label)?t(label):def.label`→回退 `t('app.<id>')`（修正：内置 label=词典 key，曾致 wb-01 红，已修）③ui.initialPath 接通（tree-store `initialPath` 选项 + setup joinKey）④头部 1s 心跳倒计时（`formatRemaining` Hh Mm/N min/M:SS）+ T-5min 预览区顶部细条提示（`session-top-warn`）
- 门禁：typecheck 0 / vitest **936+1skip**（67 文件，+7 用例）/ e2e **38/38** / build ✓
- 竞品二期调研完成：《test-report/2026-10-09-01/优化建议二期-技术竞品深调研.md》（Quantum/Filestash/Amplify/OpenVSCode，P0×6≈17~24 人日 + P1×7 + P2）

### 复审结论速记（2026-10-09）

- JSSDK：承诺面内除 B（tab/宿主 SDK）全闭合，payload 零漂移
- 插件方案 V1.1a：生命周期三件套+总闸全闭合；剩 SRI 缺省执法一个待裁决策
- 文件类型计划：血肉 半→约八成；剩 50MP 降采样/插件样例工程
- 方案设计+手册：75%→约九成；剩 ListParts 续传（大）、单文件 ttl、ui.initialPath（F3 漏项）、T-5min 顶部提示+头部倒计时（3 小）

- W-F 后基线（替代 779/34 旧基线）：**vitest 929+1skip、e2e 38、typecheck 0、lint 0 错 5 警、build 成功**
- F5 偏差备忘：①动过 Toolbar.vue（多选语义所需，最小面）②UploadPanel 进度用 queue.status() 250ms 轮询（bus 单向、hooks 构造期只读）③mac ctrl+click 合成 contextmenu→TreePanel 忽略携 ctrlKey 的右键 ④render-07 断言随 per-tab 错误边界契约更新
- 遗留（候令）：close() 句柄无 UI 入口（无「关闭预览」钮）；uploadFailed 批级无 id 字段（设计取舍已注释）；chunk>1100kB 警告（主入口 4MB/elk/heic2any，manualChunks 待做）
- 完成任务数：15（Wave1 8 + W2-T1 boot + A9~A13 测试 + W2-T2 UI + M1 集成）；全量测试次数：2（#1 603 绿、#2 690 绿）
- ✅ **执行完成（2026-10-08 收官）**：全量回归 #4 = **779 passed / 1 有意 skip**，typecheck 0 错，lint 0 错，build 18.9s 产出 dist；
  回归 #4 修复 P1×1（registerApp 并发回错 appId → appIdByUrl 按 url 映射 + onRegister 仅成功注册触发）；
  P2 backlog 新增：preview.open 重入闸、beforeDispose 待 tab 系统消费、painter savedState 笔画重建、
  ensureApps 未命中全量载（一期可接受）、Home sessionInfo 不走秒
- 循环已停（任务完成）。候用户令提交。
  渲染器 Wave R（并行，测试先行）：R1 markdown ✅7 / R2 media+pdf ✅8 / R3 csv+image ✅20 / R4 monaco ✅19 / R5 docx+xlsx ✅15（M4 内容完成）/ R6 painter 跑；
  barrel index.ts + main.ts registerBuiltins 真渲染器注入 ✅（9 应用）；preview.ts 打开链 + Home 右栏 ✅；
  ✅ **全量回归 #3（零修复）**：759 passed/1 有意 skip，typecheck 0 错，lint 0 错 5 warn（90s）
  - [x] P2-1 lint 盲区已修：lint glob → `src/**/*.{ts,vue}`（0 err 5 warn 与基线一致）
  - [ ] P2 backlog 剩余：jsdom localStorage 噪音（NODE_OPTIONS=--disable-warning 或 setup stub）；vitest setup 偏重（可选优化）；AppLayout 5×prefer-fc-button warn（存量）
  - [x] **M3 插件通道接 boot ✅**：loader.onRegister 钩子 → boot.setupPlugins(registry, config) 缝（可返回 ensureApps）→
    main.ts 接 registerApp override（requireFeature plugins→loader.load→回 appId）+ 非 lazy 启动即载 +
    preview.ensureApps（registry 未命中先加载配置插件再重解析=「lazy 首命中触发」）；
    验证：typecheck 0 错 + boot/loader/apps/files 161 用例全绿
  - [x] **构建门禁 ✅**：pnpm build 18.9s 产出 dist（修复 TreePanel.vue SCSS 非法 `button&:hover`——vitest 不编译 SCSS 的盲区，build 才暴露）；chunk>1100kB 警告记 P2（monaco/mermaid 体积，可 manualChunks 优化）
  - [ ] 终局：全量回归 #4（在跑）→ 提交（候用户令）
  locales：app.* 词典收口（合并 scaffold 原 app 块修 TS1117 + csv 3 key，双语齐）；R5 若新增 key 由主线补录；
  待做：registerBuiltins renderers 注入 + boot 集成、image-painter、全量回归 #3

## P0/P1 优化攻坚（2026-10-09 开工，用户令「提交推送； P0 P1 开工」）

> 蓝本：《test-report/2026-10-09-01/优化建议二期-技术竞品深调研.md》。纪律沿用（≤1000 行/步、测试先行、lane 文件独占、>10 任务全量回归）。

### Wave G（P0×6，并行 lane）

| Lane | 内容 | 独占写文件 | 状态 |
| --- | --- | --- | --- |
| G1 上传体验包+传输中心 | 单文件暂停/恢复/重试+冲突 HEAD 探测（覆盖/跳过/全部）+粘贴上传+下载队列→统一任务视图 | files/upload-queue.ts(+test) files/download-queue.ts(新+test) files/ui/UploadPanel.vue views/Home.vue | 在跑 |
| G2 全局搜索 | IndexedDB 元数据索引（名/大小/时间/ETag）+高级搜索面板（Glob/过滤/排序）；Toolbar/Home 集成由主线收口 | files/search-index.ts(新+test) files/ui/SearchDialog.vue(新+test) | 在跑 |
| G3 状态栏+只读降级 | StatusBar（TTL 倒计时/bucket·prefix/传输数/只读徽章）+只读黄条幅；集成由主线收口 | files/ui/StatusBar.vue(新+test) | 在跑 |
| G4 大文件分级打开 | preview 尺寸闸（<20MB 直开/20~50MB 确认/>50MB 拒+下载引导；confirmLargeFile 依赖注入） | files/preview.ts(+test) | 在跑 |
| G5 连接向导+多 Profile | profiles(localStorage)+连接表单+测试连接（写入 mmagic.config.raw 备份→reload 走既有恢复链，不暴露 URL）；入口由主线收口 | files/profiles.ts(新+test) files/ui/ConnectWizard.vue(新+test) | 在跑 |
| 主线收口 | SearchDialog/StatusBar/向导入口挂 Toolbar+Home；定向回归 | Toolbar.vue Home.vue | ✅ ①t(key,params) 透传（G4 {limit}）②confirmLargeFile=ElMessageBox ③Toolbar 搜索钮+SearchDialog 挂载（open/locate 两路）④StatusBar 挂载（activeTransfers/isReadonly/bucket/remainingMs 数据源）⑤!ok 卡片挂 ConnectWizard（wizard.title 入口） |
| **回归 #5** | — | typecheck 0 / vitest **1029+1skip**（73 文件）/ e2e **40/40** / build ✓ / lint 0 错 7 警（+G3 有意 2） | ✅ 零修复 |
| 收口候改（挂账） | — | ①config.ts 垫片收敛：sessionToken/prefix 非空强校验→放开后 G5 的 LOCAL_SESSION_TOKEN/LOCAL_ROOT_PREFIX 改 ''（需 JSSDK/手册文档同步=B 批）②commands.ts JSSDK download 可选接 DownloadQueue ③词典 download.active 缺「下载中」键 | 候令 |

### Wave H（P1×7，G 收口后）

| Lane | 内容 | 独占写文件 | 状态 |
| --- | --- | --- | --- |
| H1 预览 tab 化+钉住 | tab 条（斜体=预览、双击钉住、LRU 上限；JSSDK tab 命令仍留 M2） | files/preview.ts files/ui/PreviewTabs.vue(新) views/Home.vue | 候 G |
| H2 键盘流 | 快捷键服务（Alt+↑/↓ 进出目录/字母跳转/Esc/Enter/双击空白全选） | files/ui/shortcuts.ts(新+test) TreePanel.vue Home.vue | 候 H1 |
| H3 分页跳页 | continuationToken 页码语义暴露+跳页控件 | files/tree-store.ts(+test) TreePanel.vue | 候 G |
| H4 分享生成器 | 预签名 GET/PUT 分享链接+过期选择+批量清单 | files/ui/ShareDialog.vue(新+test) TreePanel.vue Home.vue | 候 H1 |
| H5 命令面板升级 | 最近使用置顶+快捷键提示列+命令/文件双模式 | 脚手架 palette 相关文件（开工前探查） | 候 G |
| H6 插件样例工程 | examples/ 三样例（todo/ipynb/svg-painter）可运行+loader 集成测试（闭环审计「样例零落地」） | examples/**(+test) | 候 G |

- G 收口即全量回归 #5；H 收口全量回归 #6（终局候令提交）

### R2 修复波次（2026-10-10，用户令「修复 p0~p3」：第二轮回归 14 条全修）

| Lane | 修复 | 状态 |
| --- | --- | --- |
| X1 面板/弹窗/传输 | R2-01 ⌘K 上移 App.vue+「打开传输面板」命令+wb-08；R2-02 改判=遮罩淡入截图假象（仍加 FcDialog zIndex=2500+boot-04 永久断言）；R2-04 冲突框第三态提示行（死键复活）；R2-07 冷启动空态引导；R2-10 暂停钮收敛；R2-14 时间本地化；R2-05 Home 侧 formatBytes 接线 | ✅ |
| X2 渲染器/闸/格式 | R2-03 registry maxBytes→拒绝线=min(50MB,def.maxBytes)（csv/md 确认带清空，决策表留档）；R2-05 format.ts 统一口径（'25.1 MB'）；R2-08 painter svg→PNG 保存前确认；R2-12 工具条套类；R2-13 csv 网格线/表头/hover/数字右对齐；AppCtx.t 加宽 params（向后兼容） | ✅ +28 用例 |
| X3 构建与样式 | R2-06 **改判**：4MB chunk=懒加载 monaco 误名，真入口 294kB（manualChunks 令其自证命名）；R2-09 lint 8 警→**0 错 0 警**；R2-11 真凶=index.scss 硬编码 #007AFF 压过变量→改 var(--el-color-primary) 全变量链 | ✅ |
| **合流门禁** | typecheck 0 / vitest **1166+1skip**（80 文件）/ e2e **44/44**（+boot-04+wb-08）/ build ✓ / lint **0 错 0 警** | ✅ |

### Wave H（P1×7，H-1 四路并行 + H-2 合并 lane）

| Lane | 内容 | 独占写文件 | 状态 |
| --- | --- | --- | --- |
| H1 预览 tab 化+钉住 | 同左（淘汰保护集含新开 tab；tab 记忆 appId；rename/expire 同步清 tab） | 同左 | ✅ +22 vitest；e2e 41/41（wb-06） |
| H3 分页跳页 | 客户端切片分页（tree-store 未动，聚合缓存上切片，ws-03 兼容） | files/ui/TreePanel.vue(仅分页区) | ✅ +4 vitest、ui 32/32 |
| H5 命令面板升级 | 双模式/最近置顶/keys 列/registerCommandsProvider+registerFileSearchProvider seam | App.vue FcCommandPalette.vue useCommandPaletteState.ts(+36 用例) | ✅ 主线收口：Home 接 SearchIndex 适配器+4 真实动作 |
| H6 插件样例工程 | examples/ 三样例正本（817 行）+15 集成用例（registry 校验/渲染冒烟/SRI 可钉） | examples/** | ✅ 15/15 |
| H-2 键盘流+分享 | ✅ +29 vitest（1135 总）+wb-07；presignPut≡presignGet(PUT) 同构对称；键盘流全收 TreePanel；分享 TTL 钳制=凭证寿命（e2e 已钉） | 同左 | ✅ |
| **回归 #6** | — | **五门禁全绿**：typecheck 0 / lint 0 错 8 警（+PreviewTabs 1 条风格项）/ vitest **1135+1skip（79 文件）**/ e2e **42**（wb-07 红灯判为测试前提错误——同秒重签确定性 HMAC，跨秒修复）/ build ✓（G/H 全组件入 Home 懒加载 chunk 88.6kB，未进主包）；四核对：share 单实例/键盘零冲突/TTL 钳制同源/Home 零重复挂载 | ✅ 零产品代码改动 |
| 三审 | — | 4 路完成：42 项旧结论全维持（零回退）；H6 样例正式判「已闭合」；H1/H5 两处 P2 + G5 向导两处 P1 均已主线修复；手册欠「搜索/分享/键盘/传输中心/向导」一章（回写候选清单已列） | ✅ |
| 三审修复 | sdk/config.ts profiles.ts(+config/profiles/wizard tests) views/Home.vue | ①关激活 tab 换邻位先过 gate 再移除（零半更新恢复）②palette 打开走 openEntry 收口（陈旧 appId 不再污染 tab）③config.ts 放开空 prefix/sessionToken（本地 AK/SK 形态；手册口径回写候 B）④profiles 垫片收敛 ''+'/'→'' 归一化 | ✅ typecheck 0 / vitest **1136+1skip** / e2e **42/42** |
| 终局挂账（候令） | — | 🔵B 文档回写清单（JSSDK 分期/script 口径/4901/-1/lazy/注册序；手册新章+本地模式例外+pathStyle 字段）；待裁=SRI 缺省执法；功能欠账=ListParts 续传/单文件 ttl/>50MP/csv>20MB 截断化/宿主 SDK 包；微瑕=5MB 单位统一/transfer.conflict-abort 死键/命令入口传输面板可见性（产品口径） | 候令 |
