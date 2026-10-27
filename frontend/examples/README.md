# mmagix-files 动态插件样例（examples/plugins/）

《../../docs/design/plugin-sample.md》三个样例的**可运行正本**——零构建依赖的纯 ES module，
`export function activate(sdk)` 为唯一约定入口（契约：《../../docs/design/plugin-system.md》V1.1 §二）。
本目录即「文档样例=可运行代码」的审计闭环证明：`src/plugins/__tests__/samples.test.ts`
直接 import 这三个文件跑注册/渲染/保存链，测试即规格。

## 样例清单

| 文件 | matcher | actions | 演示点 |
| --- | --- | --- | --- |
| `plugins/todo-viewer.js` | `ext:['todo']` | `['preview']` | 最小骨架：matcher/渲染/dispose 三件套；`.todo` 行格式 `[x] 已办` / `[ ] 待办` → 只读 checkbox 列表 |
| `plugins/ipynb-viewer.js` | `ext:['ipynb']` | `['preview']` | 取流渲染：JSON 解析、cell 分色（code/markdown）、outputs 归一；parse 失败 → `ctx.t('plugin.parse-fail')` 提示节点不抛 |
| `plugins/svg-painter.js` | `ext:['svg']` | `['edit']` | 可保存编辑：textarea 编辑+DOMParser 白名单消毒预览 → `ctx.putObject` 回写 → `ctx.notify('changed')`；`beforeDispose` 未保存 confirm（false=暂缓） |

三个样例均为 `requiresSdk: 1`（本批契约）。每个文件头注释含 manifest 摘要、推荐配置片段、
与文档样例的差异清单。

## 本地试用

### 方式一：dev server 直出（仅本地体验）

```bash
cd frontend && npm run dev
# 另开终端确认可直出模块源码（vite dev 以 frontend/ 为服务根，examples/ 按路径直出）：
curl -s http://localhost:5173/examples/plugins/todo-viewer.js | head -3
```

> 注意：**vite `publicDir` 未动**（仍是 `public/`）——`npm run build` 产物**不含** `examples/`。
> dev 直出仅用于本地体验；生产口径是下一种。

### 方式二：静态托管任意 CDN 路径（生产口径）

把三个 `.js` 上传到**你自己的可信 CDN / 任意静态托管路径**（插件域白名单+SRI 执法，见方案 §四），
消费方在 workspace config 里声明：

```json
{
  "features": { "plugins": true },
  "plugins": [
    { "url": "https://cdn.your.com/mmagic/todo-viewer.js",  "sri": "sha384-<hex>", "lazy": true },
    { "url": "https://cdn.your.com/mmagic/ipynb-viewer.js", "sri": "sha384-<hex>", "lazy": true },
    { "url": "https://cdn.your.com/mmagic/svg-painter.js",  "sri": "sha384-<hex>", "lazy": true }
  ]
}
```

- `features.plugins` 是总闸（`false`=动态插件整链不存在，见《../../docs/operations/user-guide.md》）
- `lazy` 默认开：首个 matcher 命中才加载；`"lazy": false` 改启动即载
- S3 常以 `application/octet-stream` 存上传物，样例 matcher **只用 ext**（契约 §一）

### SRI 计算命令（sri 钉住）

```bash
shasum -a 384 examples/plugins/todo-viewer.js | awk '{ print $1 }'
# 配置里写 "sha384-<上面输出的 hex>"；文件任何字节变更后必须重算，不符即拒载（4201）
```

（macOS 自带 `shasum`；Linux 可用 `openssl dgst -sha384 <file> | awk '{print $NF}'`。）

## 快速验证（测试即规格）

```bash
cd frontend && npx vitest run src/plugins/__tests__/samples.test.ts
```

覆盖：activate→registerApp 过真实 `AppRegistry` 校验、三样例渲染冒烟（jsdom）、
svg-painter 保存链（putObject/notify spy）与 beforeDispose true/false 双分支、
样例字节现算 sha384（hex 96 位——配置片段可真实生成的锚）。

## 安全与契约要点

- **凭证隔离**：插件永不接触 S3 凭证——`ctx.getObject()/putObject()` 字节流进出（§四 1）
- **消毒**：innerHTML/DOM 注入前必须消毒（DOMParser+元素白名单，`svg-painter.js` 内置 `sanitizeSvg` 可抄）；动态文本一律 `textContent`
- **未保存拦截**：编辑类插件自觉实现 `beforeDispose`（resolve `false`=暂缓；3 秒超时强制放行；expired/destroy 只通知不询问，§五）
- **写回权限**：`putObject` 走会话凭证 scope——scope 外 S3 直接拒绝，前端拦不住的不归前端管
- **文案 i18n**：样例经 `ctx.t('plugin.*')` 走宿主词典（`src/locales/*.ts` 已备 `plugin.parse-fail`/`plugin.save`/`plugin.unsaved-confirm`）；第三方宿主词典缺键时样例以 `tt()` 兜底自带文案，宿主补键即自动切换
