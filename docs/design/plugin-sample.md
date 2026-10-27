# mmagix-files 动态插件样例

> **【实施状态注记 · 2026-10-26 审计】** 契约层可跑且有集成测试（`frontend/src/plugins/__tests__/samples.test.ts` 动态 import 正本过真实 AppRegistry）；**本文内嵌代码非被测正本**，正本=`frontend/examples/plugins/*.js`（文件头自述差异）。主要差异：
> 1. todo-viewer：真实 checkbox（非 emoji 拼文本）
> 2. ipynb-viewer：markdown cell 分色类 + 非对象守卫；tt() 词典兜底 helper
> 3. svg-painter：textarea 编辑源文本+消毒预览+保存序列化编辑器文本（非 innerHTML 直改）
> 4. 加载机制为 fetch+sha384 自校验（非 SRI 标签注入）；类型在 `src/sdk/types.ts`（无 `@mmagix-files/sdk` 包）


## 〇、头表

| 项 | 值 |
| --- | --- |
| 版本 | V1.0（2026-10-08 评审修订版：样例①②③修复、加载机制改 SRI 标签注入、恢复/beforeDispose 契约落位）——随《plugin-system.md》V1.1 契约 |
| 性质 | 三个可跑样例，由浅入深：最小骨架 → 取流渲染 → 可保存编辑 + 同类型多应用 |
| 约定 | `sdk`=`activate(sdk)` 注入句柄；类型见 `@mmagix-files/sdk`；全部样例为 ES module |

---

## 样例① 最小骨架——`.todo` 结构化预览

演示：matcher/渲染/dispose 三件套。新文件类型支持=这一个文件+配置一行。

```js
// todo-viewer.js
export function activate(sdk) {
  sdk.registerApp({
    id: 'todo-viewer',
    matcher: { ext: ['todo'] },
    label: '清单预览',
    actions: ['preview'],
    version: '1.0.0',
    requiresSdk: 1,                        // 本批契约=1（协商语义见《plugin-system.md》§五）
    async renderer(el, file, ctx) {
      const text = await (await ctx.getObject(file.key)).text()
      const ul = document.createElement('ul')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        const li = document.createElement('li')
        const m = line.match(/^\[([ xX])\]\s*(.*)$/)
        li.textContent = m
          ? (m[1].toLowerCase() === 'x' ? '✅ ' : '⬜ ') + m[2]   // 命中：勾选态+去壳文本
          : '⬜ ' + line                                            // 不命中：原文展示
        ul.appendChild(li)
      }
      el.appendChild(ul)
      return { dispose() { ul.remove() } }   // 关 tab/切 tab/过期三路必调
    },
  })
}
```

```json
配置接入： "plugins": [{ "url": "https://cdn.your.com/mmagic/todo-viewer.js", "sri": "sha384-...", "lazy": true }]
```

## 样例② 取流渲染——`.ipynb` Notebook 预览

演示：二进制取流+JSON 解析+错误边界配合+大文件截断（ctx 能力面）。

```js
// ipynb-viewer.js
export function activate(sdk) {
  sdk.registerApp({
    id: 'ipynb-viewer',
    matcher: { ext: ['ipynb'] },           // S3 常以 application/octet-stream 存储 .ipynb，mime 匹配不可靠故仅用 ext（契约见《plugin-system.md》§一）
    label: 'Notebook 预览',
    actions: ['preview'],
    version: '1.0.0',
    requiresSdk: 1,                        // 本批契约=1（协商语义见《plugin-system.md》§五）
    async renderer(el, file, ctx) {
      const wrap = document.createElement('div')
      wrap.className = 'mmf-plugin-ipynb'
      el.appendChild(wrap)
      let nb
      try {
        nb = JSON.parse(await (await ctx.getObject(file.key)).text())
      } catch (e) {
        wrap.textContent = ctx.t('plugin.parse-fail')   // i18n 通道强制走宿主词典
        return { dispose() { wrap.remove() } }
      }
      for (const cell of nb.cells ?? []) {
        const pre = document.createElement('pre')
        const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '')   // source 数组/字符串双态归一
        pre.textContent = src
        if (cell.cell_type === 'code') pre.className = 'mmf-code'
        wrap.appendChild(pre)
        const outs = (cell.outputs ?? []).flatMap(o => {
          const t = o.text ?? o.data?.['text/plain']       // stream 文本或 data 分支（execute_result 等）
          return t == null ? [] : (Array.isArray(t) ? t : [String(t)])   // 数组/字符串均归一为文本后再渲染
        })
        if (outs.length) {
          const out = document.createElement('blockquote')
          out.textContent = outs.join('')
          wrap.appendChild(out)
        }
      }
      return {
        dispose() { wrap.remove() },
        // 可选：宿主/工作台查询插件态
        getState() { return { cells: nb.cells?.length ?? 0 } },
      }
    },
  })
}
```

要点：渲染慢/解析炸都只影响本 tab（宿主错误边界兜底降级），不崩工作台。

## 样例③ 可保存编辑 + 同类型多应用——`.svg` 画板

演示：`actions:['edit']` 进「打开方式」菜单与内置浏览并列；`ctx.putObject` 保存回写；DOMParser+白名单消毒与 `beforeDispose` 未保存拦截。

```js
// svg-painter.js
export function activate(sdk) {
  sdk.registerApp({
    id: 'svg-painter',
    matcher: { ext: ['svg'] },                          // 与内置「图片浏览」同类型；S3 常以 application/octet-stream 存储上传物，
    // mime 匹配不可靠故仅用 ext（契约见《plugin-system.md》§一）
    label: 'SVG 画板',                                   // →「打开方式」菜单出现两项
    actions: ['edit'],
    version: '1.0.0',
    requiresSdk: 1,                                     // 本批契约=1
    async renderer(el, file, ctx) {
      const svgText = await (await ctx.getObject(file.key)).text()
      const stage = document.createElement('div')       // ① SVG 渲染进独立子容器，与工具栏分离
      el.appendChild(stage)
      // 注记：innerHTML 插入的 SVG 内联事件（onbegin/onerror 等）会执行，属 XSS 向量；
      //   桶内容=用户上传物，必须消毒——经 DOMParser+元素白名单重建后再 appendChild（清单有消毒自查项）
      const clean = sanitizeSvg(svgText)
      if (clean) stage.appendChild(clean)
      else stage.textContent = ctx.t('plugin.parse-fail')
      const save = document.createElement('button')
      save.textContent = ctx.t('plugin.save')
      let dirty = false                                 // 未保存态标志（真实画板在笔画/拖拽处置 true）
      stage.addEventListener('dblclick', (e) => {       // 示意编辑：双击换色，跑通 dirty→beforeDispose→保存链路
        const t = e.target
        if (clean && t instanceof Element && t !== clean) {
          t.setAttribute('fill', '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'))
          dirty = true
        }
      })
      save.onclick = async () => {
        await ctx.putObject(file.key, new Blob([stage.innerHTML], { type: 'image/svg+xml' }))  // ② 序列化 stage——不含按钮
        dirty = false
        ctx.notify('changed', { key: file.key })        // → 宿主 fileChanged（action='put'，映射见《plugin-system.md》§二）
      }
      el.appendChild(save)
      return {
        dispose() { el.innerHTML = ''; save.onclick = null },
        beforeDispose: async () => {                    // ③ 契约：Promise<boolean>，resolve false=暂缓关闭（3 秒超时宿主强制放行）
          if (!dirty) return true
          return confirm(ctx.t('plugin.unsaved-confirm'))   // expired/destroy 路径宿主只通知不询问，放心提示
        },
      }
    },
  })
}

// 最小消毒：DOMParser 解析 + 元素/属性白名单重建（丢 script/foreignObject/use/href 与全部内联事件属性）
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'defs', 'title', 'desc'])
const SVG_ATTRS = new Set(['d', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'fill', 'stroke', 'stroke-width', 'transform',
  'viewBox', 'xmlns', 'class', 'id'])
function sanitizeSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement?.nodeName !== 'svg') return null
  const root = doc.documentElement
  const out = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const { name, value } of root.attributes) {
    if (SVG_ATTRS.has(name) && !/^\s*javascript:/i.test(value)) out.setAttribute(name, value)
  }
  const walk = (from, to) => {
    for (const el of from.children) {
      if (!SVG_TAGS.has(el.nodeName)) continue
      const child = document.createElementNS('http://www.w3.org/2000/svg', el.nodeName)
      for (const { name, value } of el.attributes) {
        if (SVG_ATTRS.has(name) && !/^\s*javascript:/i.test(value)) child.setAttribute(name, value)
      }
      walk(el, child)
      if (!child.firstChild && ['text', 'tspan', 'title', 'desc'].includes(el.nodeName)) {
        child.textContent = el.textContent              // 文本经 textContent 注入，惰性
      }
      to.appendChild(child)
    }
  }
  walk(root, out)
  return out
}
```

- 权限注记：`putObject` 走会话凭证 policy——scope 内可写、scope 外 S3 直接拒绝（前端拦不住的不归前端管）
- 「编辑」类插件自觉在 `beforeDispose` 处理未保存态（契约：resolve `false`=暂缓关闭、3 秒超时强制放行、expired/destroy 路径宿主忽略返回值，见《plugin-system.md》§五）；宿主会话到期自毁时 dispose 链照样走（保存窗口期=凭证 TTL 内）

---

## 附：发布清单（每个插件上线前）

- [ ] 用任意 shasum 工具生成 sha384 integrity 值（如 `shasum -a 384 xxx.js | awk '{ print $1 }'`，配置里写 `sha384-<hex>`）
- [ ] 托管在**你自己的可信 CDN**（插件域白名单+运行时校验；CSP 口径见《plugin-system.md》§四）
- [ ] `requiresSdk` 标注（本批契约=`1`）
- [ ] 渲染入口消毒自查：innerHTML 喂入前必消毒（DOMParser+元素白名单，见样例③）；动态文本一律 `textContent`
- [ ] dispose/beforeDispose 全路径自查（关 tab/切 tab/会话过期/错误降级）
- [ ] 真实端点跑通「打开→渲染→保存→刷新回读」闭环
