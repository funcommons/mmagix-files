# 文档治理报告（2026-10-31 批次）

> 范围：全仓 27 篇治理文档 + 11 个证据批次 + 根五件套 + 子项目 README ×4。
> 方法：四个并行审计线逐文档与代码比对（代码为唯一事实源）；批次基线 = v1.3.0（tag `ecb8a960`，单测 142 文件/1828 例全绿）。
> 前序批次：2026-10-26（a04905f1，见 git）；本批为 v1.2.0/v1.3.0 两个发版周期的欠账清偿。

## 一、审计表（逐文档结论与处置）

| 文档 | 审计判定 | 主要偏差 → 处置 |
|---|---|---|
| README.md（根） | ⚠️需修 | 13 类应用→**14**（zip-browser 漏计）；「发布物清单（v1.1.x）」过期标题；缺安全网/续传能力行 → 已更正 |
| CHANGELOG.md | ⏳过期最重 | 无 [1.2.0]/[1.3.0] 段，Unreleased 滞留 v1.1.0 时代内容（git 确权：全部提交在 v1.2.0 tag 前）→ 补两版全段，Unreleased 清零 |
| CONTRIBUTING.md | ✅ | 命令/分支/契约红线逐项核对一致，未动 |
| SECURITY.md | ⚠️需修 | 支持版本表停 1.1.x；2 处代码路径错（datasource、plugins/loader）→ 已更正 |
| LICENSE | ✅ | 不动 |
| docs/README.md | ⚠️需修 | 测试数字、releases 索引缺两版、diagram-roadmap「未实现」标注与头注矛盾 → 重写索引+治理日志 |
| docs/product/PRD.md | ⚠️需修 | 基线 v1.1.0；13 应用/17 命令过期；缺 v1.2/v1.3 八项已交付 FR → 补 FR-10~17、修订历史两行 |
| docs/design/architecture.md | ⚠️需修 | 13→14 应用；目录表 3 处路径错（loader/packages/editToolbar）；98/1436 过期；缺 D10–D13 → 已更正 |
| docs/design/solution-design.md | ⏳档案 | 正文为裁决档案保留；头部注记 5 处失效（17→19 命令、Home.vue 行号、ListMultipartUploads 已实现）→ 注记重写并增 v1.2/v1.3 终态条 |
| docs/design/jsdk-api.md | ⚠️需修 | getApps payload `{}`→`{name}`（4005）；缺 restore/purge；registerApp 装载语义=fetch+sha384 非标签注入 → 已更正（V1.2 修订头） |
| docs/design/plugin-system.md | ⚠️需修 | 注记/正文双轨：§一流程图与 §五仍是 SRI 标签口径；ctx 订阅/存储、deactivate、域白名单未实现未在正文标注 → 正文对齐 |
| docs/design/plugin-sample.md | ⚠️需修 | 头表「@mmagix-files/sdk」包不存在；版本行 SRI 标签口径 → 已更正 |
| docs/design/style-isolation.md | ⚠️需修 | §1.2 painter 行（渲染器已拆除）、csv「唯一」、xlsx「零样式」；4 处行号失效 → 已更正 |
| docs/design/flow-editor-design.md | ⚠️需修 | §六脑图「不进本期（候裁）」已实现；seed .mmd 全仓不存在 → 注记 4 终态+正文更正 |
| docs/design/diagram-roadmap.md | ⏳过期 | 头注「四方言全可编辑 ✅」与正文「三独立应用」规划互相矛盾 → §二/§四加终态标注（选型档案）、路由器/seed 条目更正 |
| docs/design/capabilities-design-v1.2.0.md | （迁移） | 原 documents/v1.2.0升级方案——四能力唯一设计记录（非冗余，solution-design 未覆盖），迁入+互引更新 |
| docs/design/capabilities-contract-v1.2.0.md | （迁移） | 原 documents/v1.2.0执行进度——14 处代码注释的**契约正本**锚点，不可删，迁入 |
| docs/operations/deployment.md | ⚠️需修 | 版本/pnpm·Node 要求与仓内 pin 矛盾；CORS 缺 DELETE（实发 DELETE）；「本地文件夹模式」写成既有边界（实为未实现）；端口口径缺 9330；根依赖未提 → 重写 |
| docs/operations/user-guide.md | ⏳过期 | 头表 V1.1；「工具栏上传」已被弹窗流推翻；分享/连接入口描述过时；v1.2/v1.3 功能面整段缺失 → 日常使用表重写+features 补 trash/restore/purge |
| docs/test/test-plan.md | ⏳过期 | 98/1436→142/1828；19 个目录未入映射；漏 lines≥80 真门禁；playwright 形态失实 → 重写 |
| docs/test/test-cases.md | ⏳过期最重 | 全部数字过期；§3 自相矛盾；批次表缺 3 批 → 重写 |
| docs/test/test-report-v1.1.0.md | ✅历史 | 自带时点头；补「历史基线」指引行 |
| docs/test/test-report-v1.2.0 / v1.3.0.md | （新增） | 补两版测试报告（事实取自发版提交+当日全量复跑） |
| docs/releases/delivery-checklist / acceptance-v1.1.0.md | ✅历史 | 「归 [Unreleased]」注记过期 → 更正为「已随 v1.2.0 发布」 |
| docs/releases/×4（v1.2.0/v1.3.0） | （新增） | 补两版交付清单+验收报告；v1.2.0 验收记录真实偏差：**ShareAccess 公开校验页未挂路由** |
| docs/releases/v1.0.0 / v1.1.0-plugin-sri.json | ✅有效 | sha384 实测 7/7 与当前产物逐字一致（v1.2/v1.3 未重建插件）；v1.1.0 清单仍为现行指针（重建后须重出） |
| frontend/packages/files-client/README.md | ⚠️需修 | 测试命令指向不存在的根 vitest；哨兵覆盖面夸大；4005 与宿主正本同名不同义；publish 未提醒重建 dist → 已更正 |
| frontend/examples/README.md | ⚠️需修 | dev 端口 5173→**9330**；npm→pnpm → 已更正 |
| mmagix-embed-demo/README.md | ⚠️需修 | 「冒烟见 documents/」死链；scripts/ 4 件只提 2 件 → 已更正 |
| frontend/src/components/sdk/README.md | ✅ | 48 组件名与目录/index.ts 完全一致，未动 |
| documents/同类项目对比与升级建议.md（TOP3 旧版） | 🗑️删除 | 已被 TOP5 版显式承接（新文头注声明），无独立参考价值 |
| documents/releases/、mmagix-embed-demo/documents/ | 🗑️删除 | 空目录 |
| test-report/（根 9 批次+frontend 2 批次） | ✅保留 | E2E 证据链：playwright config/fixtures/4 处代码注释功能性与决策性引用（DEF-1 红线等）；5+1 篇过程建议随批次封存（先例：PROGRESS-archived） |

## 二、目标目录树（治理后现状）

```
mmagix-files/
├── README.md / CHANGELOG.md / CONTRIBUTING.md / SECURITY.md / LICENSE   # 开源五件套
├── docs/
│   ├── README.md                       # 索引 + 治理日志
│   ├── product/    PRD.md · competitive-analysis-v1.3.0.md
│   ├── design/     architecture · solution-design(档案) · capabilities-{design,contract}-v1.2.0(档案)
│   │               · jsdk-api · plugin-system · plugin-sample · style-isolation
│   │               · flow-editor-design · diagram-roadmap
│   ├── plugins/    6 篇官方插件设计
│   ├── develop/    code-editor-upgrade.md · doc-governance-2026-10-31.md（本报告）
│   ├── operations/ deployment.md · user-guide.md
│   ├── test/       test-plan · test-cases · test-report-v{1.1.0,1.2.0,1.3.0}
│   └── releases/   delivery-checklist-v{1.1.0,1.2.0,1.3.0} · acceptance-v{1.1.0,1.2.0,1.3.0}
│                   · v{1.0.0,1.1.0}-plugin-sri.json
├── test-report/<日期-批次>/             # E2E 证据链（playwright --output 归档，CONTRIBUTING 约定）
├── frontend/examples/README.md · frontend/packages/files-client/README.md
└── mmagix-embed-demo/README.md
```

命名规范：docs/ 内一律英文蛇形；版本化文档带 `-v<major.minor.patch>` 后缀（SRI json 为 `v<ver>-` 前缀，沿既有惯例）；档案类在头注标「档案/历史基线」。中文文件名只允许出现在 test-report 证据批次内部（历史遗留，不再新增）。

## 三、关键文档模板（新版本交付时套用）

- 交付清单：`delivery-checklist-vX.Y.Z.md` —— 头行（日期/Tag/提交）→ 交付物表（SPA/插件/SRI/客户端包/文档集）→ 版本内容摘要（引 CHANGELOG）→ 质量证据（单测/覆盖/类型/ESLint/E2E）→ 已知边界。范本：v1.3.0。
- 验收报告：`acceptance-vX.Y.Z.md` —— 结论 → 逐项验收表（验收项×标准×方法×结果，逐条可复现）→ 记录偏差 → 遗留去向 → 签字。范本：v1.2.0（含偏差如实登记）。
- 测试报告：`test-report-vX.Y.Z.md` —— 时点头（当前版不标历史）→ 被测面→套件映射 → 结果总览 → 证据链接。范本：v1.3.0。
- 发版动作清单（CONTRIBUTING 可引）：三包 bump → `pnpm build` → CHANGELOG 段 → tag → **当版 delivery-checklist + acceptance + test-report 三件** → push（含 --tags）。

## 四、验证结果

| 闸 | 结果 |
|---|---|
| 全仓 md 相对链接 | 扫描 293 条，**0 死链** |
| 代码注释锚点 | 17 处 documents/ 引用全部改指新路径，grep 复查 0 残留 |
| `vue-tsc -b --noEmit` | 0 error |
| `pnpm vitest run` | **142 文件 / 1828 passed / 1 skipped / 0 failed**（与文档记载数字一致） |
| `pnpm run lint` | 0 error（20 条存量 warning，非本批引入） |
| `pnpm build` | 成功（27.6s；>1100kB chunk 警告为 vite.config 注记的懒加载观察位，非回归） |
| 新人跑通链 | deployment.md §2 命令逐条与仓内脚本/端口核对一致（9330/5199/5200）；dev server 以该命令实测运行中 |

## 五、发现但不在本批处置的代码缺口（移交）

- **ShareAccess 公开校验页未挂路由**：组件+单测齐备，router 无条目、无入口——带密码分享链接无站内解锁页（已记入 v1.2.0 验收偏差与交付边界）。
- univer-office / pdf-annotator 仍 0 单测（v1.1.0 起遗留，实机取证兜底）。
