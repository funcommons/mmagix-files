/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MMagic-Files 动态插件样例② —— `.ipynb` Notebook 预览（取流渲染：JSON 解析+错误边界配合）
 * 正本：docs/design/plugin-sample.md样例② V1.0（随docs/design/plugin-system.mdV1.1 契约）
 * 零构建依赖：纯 ES module，`export function activate(sdk)` 为唯一约定入口。
 *
 * manifest 摘要：
 *   { id: 'ipynb-viewer', matcher: { ext: ['ipynb'] }, label: 'Notebook 预览',
 *     actions: ['preview'], version: '1.0.0', requiresSdk: 1 }
 *   matcher 仅用 ext：S3 常以 application/octet-stream 存储 .ipynb，mime 匹配不可靠（§一）
 *
 * 推荐接入（消费方 workspace config.plugins 片段，features.plugins 总闸需开）：
 *   "plugins": [{
 *     "url": "https://cdn.your.com/mmagic/ipynb-viewer.js",
 *     "sri": "sha384-<hex>",
 *     "lazy": true
 *   }]
 *   sri 钉住：`shasum -a 384 ipynb-viewer.js | awk '{ print $1 }'` → 配置里写 "sha384-<hex>"
 *   （文件任何字节变更后必须重算；sri 不符宿主直接拒载，上报 4201）
 *
 * 与文档样例的差异（以「能跑」为准，语义不变）：
 *   1) markdown cell 补上 mmf-markdown 分色类+最小示意样式——文档版只给 code 上色，
 *      「code/markdown 分色渲染」落盘补齐（类名供宿主主题覆写，内联色仅为无宿主 CSS 时的示意）。
 *   2) 解析结果非对象（如文件内容恰为字面量 `null`/数字）也走 parse-fail 提示节点：
 *      文档版会在 `nb.cells` 处抛错（由宿主 per-tab 错误边界兜底），样例自身不抛更稳（对齐「不抛」口径）。
 *   3) 新增文案兜底 helper tt()（见下注）——文档版直呼 ctx.t()，宿主词典缺 'plugin.*' 键时
 *      会原文显示 key。
 *
 * 文案兜底惯例（第三方插件通用写法）：ctx.t() 强制走宿主词典；宿主词典缺键时 ctx.t 按约定
 * 原样返回 key（返回值仍以 'plugin.' 开头）——此时回退样例自带文案；宿主词典补键后
 * ctx.t 返回译文（不以 'plugin.' 开头）即自动切换，插件零改动。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 文案兜底：宿主词典缺键（返回值仍以 'plugin.' 开头）→ 用样例自带 fallback；否则信宿主译文 */
const tt = (s, fallback) => (s.startsWith('plugin.') ? fallback : s)

export function activate(sdk) {
  sdk.registerApp({
    id: 'ipynb-viewer',
    matcher: { ext: ['ipynb'] }, // S3 常以 application/octet-stream 存储 .ipynb，mime 匹配不可靠故仅用 ext（§一）
    label: 'Notebook 预览',
    actions: ['preview'],
    version: '1.0.0',
    requiresSdk: 1, // 本批契约=1（协商语义见docs/design/plugin-system.md§五）
    async renderer(el, file, ctx) {
      const wrap = document.createElement('div')
      wrap.className = 'mmf-plugin-ipynb'
      el.appendChild(wrap)
      let nb
      try {
        nb = JSON.parse(await (await ctx.getObject(file.key)).text())
      } catch (e) {
        wrap.textContent = tt(ctx.t('plugin.parse-fail'), '无法解析 Notebook JSON') // i18n 通道优先走宿主词典
        return { dispose() { wrap.remove() } } // parse 失败不抛：本 tab 降级为提示节点
      }
      if (nb == null || typeof nb !== 'object') {
        wrap.textContent = tt(ctx.t('plugin.parse-fail'), '无法解析 Notebook JSON') // `null`/标量等退化输入
        return { dispose() { wrap.remove() } }
      }
      for (const cell of nb.cells ?? []) {
        const pre = document.createElement('pre')
        // source 数组/字符串双态归一（nbformat 里 source 常为带换行尾的行数组）
        const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '')
        pre.textContent = src
        if (cell.cell_type === 'code') {
          pre.className = 'mmf-code' // 分色：code=等宽+蓝边（示意色，宿主可按类名覆写）
          pre.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace'
          pre.style.borderLeft = '3px solid #3b82f6'
          pre.style.paddingLeft = '8px'
        } else if (cell.cell_type === 'markdown') {
          pre.className = 'mmf-markdown' // 分色：markdown=灰斜体（同上，示意）
          pre.style.borderLeft = '3px solid #94a3b8'
          pre.style.fontStyle = 'italic'
          pre.style.paddingLeft = '8px'
        }
        wrap.appendChild(pre)
        const outs = (cell.outputs ?? []).flatMap((o) => {
          const t = o.text ?? o.data?.['text/plain'] // stream 文本或 data 分支（execute_result 等）
          return t == null ? [] : (Array.isArray(t) ? t : [String(t)]) // 数组/字符串均归一为文本后再渲染
        })
        if (outs.length) {
          const out = document.createElement('blockquote')
          out.textContent = outs.join('')
          wrap.appendChild(out)
        }
      }
      return {
        dispose() { wrap.remove() },
        // 可选：宿主/工作台查询插件态（切回 tab 重跑时经 savedState 注回）
        getState() { return { cells: nb.cells?.length ?? 0 } },
      }
    },
  })
}
