# 贡献指南（Contributing）

> 环境搭建与常用命令见 [docs/operations/deployment.md](docs/operations/deployment.md)；
> 架构与契约正本见 [docs/README.md](docs/README.md) 文档索引。

## 开发流程

1. 从 `main` 切特性分支（`feat/xxx`、`fix/xxx`、`docs/xxx`）
2. 开发：**以代码为唯一事实源**——改协议/契约必须同步文档（见下「契约同步红线」）
3. 提交前本地闸门：

```bash
cd frontend
pnpm exec vue-tsc -b --noEmit   # 类型 0 error
pnpm vitest run                  # 全量单测 0 失败
pnpm run lint                    # eslint 0 error
```

4. PR 到 `main`；提交信息用约定式前缀（`feat:`/`fix:`/`docs:`/`refactor:`/`test:`/`chore:`）

## 契约同步红线（改一处必须同步的另一处）

| 改动 | 必须同步 |
|---|---|
| `frontend/src/sdk/constants.ts`（NS/协议版本） | `frontend/packages/files-client/src/constants.ts` + `docs/design/jsdk-api.md`（漂移哨兵 `clientProtocol.test.ts` 会红） |
| `frontend/src/apps/builtins.ts`（BUILTIN_APP_SPECS 内置应用表） | `docs/product/PRD.md` 能力清单 + `frontend/src/apps/__tests__/builtins.test.ts` |
| 插件 `frontend/plugins/*/src` 改动 | 重建该插件 bundle（`pnpm --dir frontend/plugins/<name> build`）+ 重出 SRI（`docs/releases/`） |
| locale 新增键 | `zh-CN.ts` 与 `en-US.ts` **同时**加（缺一侧 → intlify 警告） |
| 渲染器字节限额 | 只改 `frontend/src/apps/builtins.ts` 的导出常量（渲染器 import 同一常量，R2-03 单一事实源） |

## 已知地雷（历史事故沉淀，动手前先读）

- **pnpm lockfile**：插件目录是 standalone 安装——在 `frontend/plugins/*` 里跑 `pnpm add` 会向上重写根
  `pnpm-lock.yaml`（瘦身断链）。恢复：`git checkout -- pnpm-lock.yaml`。给 frontend 加依赖从 `frontend/` 目录跑。
- **Monaco worker 分发**：`getWorker(workerId, label)` 的 workerId 恒为 `workerMain.js`，按 **label**（languageId）分发。
- **插件渲染器 TDZ**：状态同步函数引用的 `let` 状态必须先于首次调用声明（`Cannot access 'Xe'` 事故）。
- **确认类 E2E**：Playwright 默认 dismiss `window.confirm`/自定义确认条——脚本需显式应答。

## 测试

- 单测与代码同目录 `__tests__/`；跑法与覆盖面见 `docs/test/test-plan.md`
- E2E（Playwright）脚本与截图证据归档 `test-report/<日期-批次>/`
- 测试执行：提交前全量；连续变更 >1000 行建议过程跑

## 文档

- 文档树与索引：`docs/README.md`；文档与代码不一致视为 bug（欢迎 PR 修文档）
- CHANGELOG 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 SemVer
