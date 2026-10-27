# mmagix-files 动态插件方案

> **【实施状态注记 · 2026-10-26 审计】** 契约骨架（url/sri/lazy/options、activate/registerApp、requiresSdk、beforeDispose 3s）与代码一致；以下偏差以代码为准：
> 1. **装载机制**：非 `<script type="module" src integrity>` 标签注入——实际为 fetch 字节 → `crypto.subtle` sha384 自校验 → Blob URL import → activate（`frontend/src/plugins/loader.ts:91-133`；§一 V1.1a 修正段与此一致，§一流程图与 §五 未同步）
> 2. **未实现（保留声明）**：ctx 事件订阅、sessionStorage 轻量存储（`apps/ctx.ts` 无）；`deactivate()` 未接线；插件域白名单/运行时校验未实现（执法仅=plugins[] 清单+SRI）
> 3. **API 面增补未回写**：renderer 第 5 参 `appOptions`、`AppDefinition.maxBytes`、ctx 可选 `getMediaUrl`/`notifyAppError`、notify 多 `html-open-rejected`
> 4. **lazy 单文件口径**：单文件模式全量预载；lazy 让位「打开方式」全量命中面（`main.ts:112-119`）
> 5. 错误面文案实为「应用渲染失败」+重试钮（`preview.ts:216-236`）


## 〇、头表

| 项 | 值 |
| --- | --- |
| 版本 | V1.1（2026-10-08 评审修订版：加载机制 SRI 重构、matcher/版本协商/notify 映射契约补齐） |
| 状态 | **已裁定案**——T1 宿主自管插件（特权运行）一期落地；T2 第三方市场插件（沙箱隔离）候需求 |
| 归属 | 《solution-design.md》§4.6 应用模型之扩展篇、裁决台账②之翻案正本 |
| 一句话 | 配置注入 xxx.js（ES module）→ `activate(sdk)` → `registerApp` → 新文件类型即上「打开方式」菜单，与内置应用零特判 |

---

## 一、加载机制（三层，全现成浏览器能力）

```
配置: "plugins": [{ "url": "https://cdn.消费方.com/mmagic/ipynb-viewer.js", "sri": "sha384-...", "lazy": true, "options": { "initialMode": "split" } }]
  ↓ 前端启动扫描 plugins 数组（lazy 默认开：首个 matcher 命中才插入标签）
动态注入 <script type="module" src integrity crossorigin>   ← 浏览器原生 ES module + SRI 校验
  ↓ module 顶层 export activate(sdk, options?)   ← options=PluginEntry.options 透传（v1.1 增补，可缺省）
activate(sdk, options?) → sdk.registerApp({...})    ← 与内置应用走同一 AppRegistry
  ↓
新类型进文件树/「打开方式」菜单——同 matcher 多 app 天然成「多应用打开」
```

- 加载原语=**fetch 字节 → crypto.subtle 自算 sha384 校验 → Blob URL `import()` → `activate(sdk, options?)`**（V1.1a 实现口径修正：script 标签只执行模块顶层、拿不到导出——`export activate(sdk)` 将无人调用；fetch+自校验达到并超过 SRI 标签强度，失败路径可控；裁决⑥后 SPA 不设 script-src，`blob:` 加载无 CSP 顾虑）；lazy 语义不变；**options（v1.1 增补）**=`PluginEntry.options` 对象原样作 activate 第二参，插件自解（未知字段忽略、非法值丢弃），缺省不传
- 注入形态=**配置声明式**（消费方在 config 里列 URL），非运行时 eval——**框架自身零 eval/零动态拼 HTML**（createElement+setAttribute 非 HTML 拼接）；插件 renderer 自管 DOM（含 innerHTML），消毒责任随数据源（样例③注记）
- matcher 契约：**字段间 AND、同字段内 OR**（如 `{ ext: ['ipynb','md'] }`=任一扩展名命中）；mime 无把握时（S3 常以 `application/octet-stream` 存储）**只用 ext**
- 插件加载受配置 `features.plugins` 总闸控制（见《../operations/user-guide.md》）
- `targetOrigin`：JSSDK 双向 origin 校验不变。**不做 CSP 差异化**（已裁⑥无租户概念）：文件服务 SPA 不设 `script-src` 白名单（设了即与任意消费方插件域冲突）；插件供应链执法=配置 `plugins[]` 清单本身+SRI（见 §四红线 2/3）

## 二、插件契约（完整 API 面就这么大）

```js
// ipynb-viewer.js — ES module，唯一约定入口（options=配置注入参数，v1.1；缺省 undefined）
export function activate(sdk, options) {
  sdk.registerApp({
    id: 'ipynb-viewer',                    // 全局唯一
    matcher: { ext: ['ipynb'] },           // 或 { mime: '...' } / { probe: fn }
    renderer(el, file, ctx, savedState?) { // el=tab 容器; file={key,name,size}; savedState=上次 getState() 返回值（切回 tab 重跑时注入，缺省 undefined）
      // ctx.getObject() → 字节流（内层 SigV4，凭证不出）
      // 返回 { dispose, getState?, beforeDispose? }——beforeDispose 可返回 Promise<boolean>：resolve false=暂缓关闭
      //   （未保存态由插件自行提示）；3 秒超时强制放行；expired/destroy 路径只通知不询问（仍调用但忽略返回值；
      //   v1.1：调用带 reason 参数（'close'|'expired'|'destroy'），实现应据非 'close' 跳过用户询问直接放行）
    },
    actions: ['preview'],                  // preview|edit|open-with 菜单位
    label: 'Notebook 预览',                // i18n key 或字面量
    version: '1.0.0',
    requiresSdk: 1,                         // 要求的协议主版本（=信封 v；缺省=不校验；不匹配拒载）
  })
}
export function deactivate() { /* 可选：清理全局副作用 */ }
```

- `ctx` 能力面（白名单）：`getObject()/putObject()`（字节流进出，**不含凭证**）、主题 token、i18n（`ctx.t(key)`）、事件订阅、**事件上报 `ctx.notify(type, payload)` → 宿主 `fileChanged` 事件：`'saved'|'changed'`→action `'put'`；`'deleted'`→`'delete'`；`'renamed'`→`'rename'`（payload `{ key, from? }`）**、轻量存储（sessionStorage 隔离命名空间）
- 与 JSSDK 关系：`registerApp` 即 JSSDK command 之一——但宿主运行时注册经 postMessage 传 **`{ url, sri, lazy?, options? }`**（函数不可克隆，manifest 随 module 自描述；options 对象可克隆、随通道透传 activate 第二参，v1.1），宿主侧复用本档同一加载机制拉起；与配置注入双通道、同一 registry（见《jsdk-api.md》V1.0 §四）

## 三、信任两级（裁决台账②之翻案）

| 档 | 形态 | 信任模型 | 期 |
| --- | --- | --- | --- |
| **T1 宿主自管插件**（本档 xxx.js 形态） | 配置声明的 ES module | **特权运行=宿主信任域**——宿主本就把 scoped 凭证托付给文件服务，自己的 js 同信任级 | **一期** |
| T2 第三方市场插件 | sandboxed iframe/worker 隔离渲染+能力桥（postMessage 白名单 RPC） | 零信任——插件烂/恶意不越渲染沙箱 | 候需求（市场形态立项时） |

## 四、安全红线（T1 也必守）

1. **凭证隔离**：插件永不接触 S3 凭证——`ctx.getObject()` 返回字节流，SK 封在内层 SigV4 模块；插件能读数据、不能读钥匙
2. **供应链**：配置项带 SRI 完整性哈希（`"plugins": [{"url": "...", "sri": "sha384-..."}]`）+插件域白名单——js 源被篡改=加载拒绝
3. **供应链执法（已裁⑥：无 CSP 差异化）**：不做 CSP `script-src` 按消费方放开——执法=配置 `plugins[]` 清单本身（清单外 URL 一律不加载）+SRI 完整性校验+插件域运行时校验；文件服务 SPA 自身不设 script-src 白名单（设了即与任意消费方插件域冲突）；消费方如需 CSP，在**宿主页**自行设定
4. **数据面越权由凭证 scope 兜底**：插件再野也只能在凭证 prefix 内活动（S3 侧执法，前端拦不住的不归前端管）

## 五、工程细则

- **lazy load 默认开**：首个 matcher 命中才插入 `<script type="module">` 标签；`"lazy": false` 可改启动即载
- **per-tab 错误边界**：renderer 抛错只炸自己 tab（降级「插件应用出错」+重载钮），不崩工作台
- **dispose/恢复**：切 tab/关 tab/会话过期三路必调 `dispose()`（维持，防泄漏防后台请求）；切回 tab=renderer 重跑，第 4 参注入上次 `getState()` 返回值：`renderer(el, file, ctx, savedState?)`——插件未声明 getState 时为 undefined，恢复策略插件自定
- **beforeDispose 契约**：可返回 `Promise<boolean>`——resolve `false`=暂缓关闭（未保存态由插件自行提示）；3 秒超时强制放行；expired/destroy 路径只通知不询问（仍调用但忽略返回值）
- **版本与兼容**：`requiresSdk` 协商——缺省=不校验；比较对象=协议主版本（信封 `v`）；不匹配则拒载+`onError` 上报宿主
- **去重**：同 id 重复注册=后者拒载并 warn

## 六、先例与定位

| 先例 | 取什么 |
| --- | --- |
| VS Code web `customEditors`（manifest 贡献式） | 编辑器贡献语义的黄金标准——本方案取**编程注册式**（registerApp），比 manifest 轻，够一期 |
| filestash xdg-open（mime→查看器注册） | 只看产品语义（AGPL 零抄码） |
| OnlyOffice plugin system | 插件隔离与能力桥的形态参照（T2 期再深读） |

## 七、开放项

- T2 市场形态（发现/分发/签名链/评分）——候「第三方插件」真实需求立项，一期不做
- 插件间通信（registry 内 app 互调）——一期不做，候场景
