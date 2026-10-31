/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MMagic-Files 动态插件样例③ —— `.svg` 画板（可保存编辑 + 同类型多应用）
 * 正本：docs/design/plugin-sample.md样例③ V1.0（随docs/design/plugin-system.mdV1.1 契约）
 * 零构建依赖：纯 ES module，`export function activate(sdk)` 为唯一约定入口。
 *
 * manifest 摘要：
 *   { id: 'svg-painter', matcher: { ext: ['svg'] }, label: 'SVG 画板',
 *     actions: ['edit'], version: '1.0.0', requiresSdk: 1 }
 *   actions:['edit'] → 进「打开方式」菜单与内置「图片浏览」并列（同类型多应用）
 *
 * 推荐接入（消费方 workspace config.plugins 片段，features.plugins 总闸需开）：
 *   "plugins": [{
 *     "url": "https://cdn.your.com/mmagic/svg-painter.js",
 *     "sri": "sha384-<hex>",
 *     "lazy": true
 *   }]
 *   sri 钉住：`shasum -a 384 svg-painter.js | awk '{ print $1 }'` → 配置里写 "sha384-<hex>"
 *   （文件任何字节变更后必须重算；sri 不符宿主直接拒载，上报 4201）
 *
 * 与文档样例的差异（以「能跑」为准，语义不变）：
 *   1) 编辑面：文档版=渲染后的 SVG 上双击换色（示意交互）+ 保存时序列化 stage.innerHTML（已消毒 DOM）；
 *      落盘版=textarea 直接编辑 SVG 源文本 + 实时消毒预览（stage 只读），保存序列化编辑器文本
 *      ——对齐「getText→contenteditable/textarea 编辑→保存」口径。写回的是用户自己的源文本
 *      （不放大攻击面）；展示面（DOM 注入）始终经 DOMParser+白名单消毒，双职责不混。
 *   2) 新增文案兜底 helper tt()（见下注）——文档版直呼 ctx.t()，宿主词典缺 'plugin.*' 键时
 *      会原文显示 key。
 *
 * 文案兜底惯例（第三方插件通用写法）：ctx.t() 强制走宿主词典；宿主词典缺键时 ctx.t 按约定
 * 原样返回 key（返回值仍以 'plugin.' 开头）——此时回退样例自带文案；宿主词典补键后
 * ctx.t 返回译文（不以 'plugin.' 开头）即自动切换，插件零改动。
 *
 * 契约注记（§五/权限）：
 *   - beforeDispose 契约：Promise<boolean>，resolve false=暂缓关闭；3 秒超时宿主强制放行；
 *     expired/destroy 路径宿主只通知不询问（仍调用但忽略返回值）。
 *   - putObject 走会话凭证 policy——scope 内可写、scope 外 S3 直接拒绝（前端拦不住的不归前端管）。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 文案兜底：宿主词典缺键（返回值仍以 'plugin.' 开头）→ 用样例自带 fallback；否则信宿主译文 */
const tt = (s, fallback) => (s.startsWith('plugin.') ? fallback : s)

export function activate(sdk) {
  sdk.registerApp({
    id: 'svg-painter',
    matcher: { ext: ['svg'] }, // 与内置「图片浏览」同类型；S3 常以 application/octet-stream 存储上传物，mime 匹配不可靠故仅用 ext（§一）
    label: 'SVG 画板', // →「打开方式」菜单出现两项
    actions: ['edit'],
    version: '1.0.0',
    requiresSdk: 1, // 本批契约=1
    async renderer(el, file, ctx) {
      // getText 语义：ctx.getObject(key) → Blob → .text()
      const svgText = await (await ctx.getObject(file.key)).text()

      const editor = document.createElement('textarea') // 编辑面：SVG 源文本（真画板此处为笔画画布）
      editor.className = 'mmf-plugin-svg-editor'
      editor.value = svgText
      editor.setAttribute('spellcheck', 'false')
      editor.style.cssText = 'width:100%;min-height:120px;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:12px'

      const stage = document.createElement('div') // 预览面：消毒后 DOM，与编辑面分离
      stage.className = 'mmf-plugin-svg-stage'
      stage.style.cssText = 'margin-top:8px;padding:8px;border:1px dashed #bbb'

      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'mmf-plugin-svg-save'
      save.textContent = tt(ctx.t('plugin.save'), 'Save')

      let dirty = false // 未保存态标志（input 置 true，保存成功清零）
      const renderPreview = () => {
        stage.innerHTML = ''
        // 注记：innerHTML/DOM 注入的 SVG 内联事件（onbegin/onerror 等）会执行，属 XSS 向量；
        // 桶内容=用户上传物，必须消毒——DOMParser+元素白名单重建后再 appendChild（发布清单自查项）
        const clean = sanitizeSvg(editor.value)
        if (clean) stage.appendChild(clean)
        else stage.textContent = tt(ctx.t('plugin.parse-fail'), '无法解析 SVG（XML 语法错误？）')
      }
      editor.addEventListener('input', () => {
        dirty = true
        renderPreview() // 样例级同步重建；大文件请自行加 debounce
      })
      renderPreview()

      save.onclick = async () => {
        await ctx.putObject(file.key, new Blob([editor.value], { type: 'image/svg+xml' })) // 写回=编辑器文本
        dirty = false
        ctx.notify('changed', { key: file.key }) // → 宿主 fileChanged（action='put'，映射见 §二）
      }

      el.appendChild(editor)
      el.appendChild(stage)
      el.appendChild(save)

      return {
        dispose() { el.innerHTML = ''; save.onclick = null },
        beforeDispose: async () => { // 契约：Promise<boolean>，resolve false=暂缓关闭（3 秒超时宿主强制放行）
          if (!dirty) return true
          return confirm(tt(ctx.t('plugin.unsaved-confirm'), '有未保存的修改，确定关闭吗？')) // expired/destroy 路径宿主只通知不询问
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
        child.textContent = el.textContent // 文本经 textContent 注入，惰性
      }
      to.appendChild(child)
    }
  }
  walk(root, out)
  return out
}
