/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MMagic-Files 动态插件样例① —— `.todo` 结构化预览（最小骨架：matcher/渲染/dispose 三件套）
 * 正本：docs/design/plugin-sample.md样例① V1.0（随docs/design/plugin-system.mdV1.1 契约）
 * 零构建依赖：纯 ES module，`export function activate(sdk)` 为唯一约定入口。
 *
 * manifest 摘要：
 *   { id: 'todo-viewer', matcher: { ext: ['todo'] }, label: '清单预览',
 *     actions: ['preview'], version: '1.0.0', requiresSdk: 1 }
 *
 * 推荐接入（消费方 workspace config.plugins 片段，features.plugins 总闸需开）：
 *   "plugins": [{
 *     "url": "https://cdn.your.com/mmagic/todo-viewer.js",
 *     "sri": "sha384-<hex>",
 *     "lazy": true
 *   }]
 *   sri 钉住：`shasum -a 384 todo-viewer.js | awk '{ print $1 }'` → 配置里写 "sha384-<hex>"
 *   （文件任何字节变更后必须重算；sri 不符宿主直接拒载，上报 4201）
 *
 * 与文档样例的差异（以「能跑」为准，语义不变）：
 *   1) 勾选态由 emoji 文本（✅/⬜ 拼进 textContent）改为真实 <input type="checkbox" disabled>
 *      ——对齐「逐行渲染 checkbox 列表（只读预览即可）」；勾选交互+回写属编辑类扩展（需 actions:['edit']），
 *      本样例保持 preview 纯读。
 *   2) 行格式仍按文档约定：`[x] 已办` / `[ ] 待办`（行首方括号，大小写 x 均计已办）；
 *      不命中行格式的行原文展示，空行跳过。
 *
 * 文案兜底惯例（第三方插件通用写法）：本样例无 ctx.t() 文案依赖，无需 tt 兜底；
 * 惯例正本见样例②③文件头注——宿主词典缺 'plugin.*' 键时 ctx.t 按约定原样返回 key，
 * 插件以 `s.startsWith('plugin.')` 判定并回退自带文案，宿主补键即自动切换。
 *
 * .todo 文件格式（样例自定义的极简清单格式）：
 *   [x] 已完成项
 *   [ ] 未完成项
 *   任意其他行（原样展示）
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function activate(sdk) {
  sdk.registerApp({
    id: 'todo-viewer',
    matcher: { ext: ['todo'] },
    label: '清单预览',
    actions: ['preview'],
    version: '1.0.0',
    requiresSdk: 1, // 本批契约=1（协商语义见docs/design/plugin-system.md§五）
    async renderer(el, file, ctx) {
      // getText 语义：ctx.getObject(key) → Blob（内层 SigV4，凭证不出）→ .text()
      const text = await (await ctx.getObject(file.key)).text()
      const ul = document.createElement('ul')
      ul.className = 'mmf-plugin-todo'
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        const li = document.createElement('li')
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.disabled = true // 只读预览；勾选回写属编辑类扩展（actions:['edit']）
        const span = document.createElement('span')
        const m = line.match(/^\[([ xX])\]\s*(.*)$/)
        if (m) {
          box.checked = m[1].toLowerCase() === 'x' // 命中：勾选态+去壳文本
          span.textContent = m[2]
        } else {
          span.textContent = line // 不命中行格式：原文展示
        }
        // 动态文本一律 textContent（发布清单：XSS 自查项）
        li.appendChild(box)
        li.appendChild(span)
        ul.appendChild(li)
      }
      el.appendChild(ul)
      return { dispose() { ul.remove() } } // 关 tab/切 tab/过期三路必调（§五）
    },
  })
}
