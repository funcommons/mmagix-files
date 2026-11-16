/* 脑图原型公共脚本：同一棵示例树 × 不同布局/主题，真引擎渲染（simple-mind-map 0.14.0-fix.3，MIT） */
/* 契约见 ../plan.md §十；本目录仅为外观确认原型，非实现代码。 */

const CDN = 'https://cdn.jsdelivr.net/npm/simple-mind-map@0.14.0-fix.3/dist/simpleMindMap.umd.min.js'

/* 示例树：后续所有原型共用同一棵（新品发布计划，二~三级深度） */
const DATA = {
  data: { text: '新品发布计划' },
  children: [
    {
      data: { text: '市场调研' },
      children: [
        { data: { text: '用户访谈' }, children: [] },
        { data: { text: '竞品分析' }, children: [] },
        { data: { text: '定价策略' }, children: [] }
      ]
    },
    {
      data: { text: '产品设计' },
      children: [
        { data: { text: '原型评审' }, children: [] },
        { data: { text: '视觉规范' }, children: [] },
        { data: { text: '技术方案' }, children: [] }
      ]
    },
    {
      data: { text: '研发排期' },
      children: [
        { data: { text: '核心功能' }, children: [] },
        { data: { text: '联调测试' }, children: [] },
        { data: { text: '性能优化' }, children: [] }
      ]
    },
    {
      data: { text: '发布推广' },
      children: [
        { data: { text: '官网上线' }, children: [] },
        { data: { text: '媒体投放' }, children: [] },
        { data: { text: '数据复盘' }, children: [] }
      ]
    }
  ]
}

/** document.write 注入 CDN 脚本（file:// 下经典脚本无需 CORS） */
document.write('<script src="' + CDN + '"><\/script>')

/* XMind 风主题包：npm 包仅内置 default，其余主题须宿主 defineTheme（实装时随编辑器自带，见 plan.md §五） */
const XM_THEMES = {
  'xm-green': {
    backgroundColor: '#f7f8f7', lineColor: '#4f8a78', lineWidth: 2,
    lineStyle: 'curve', rootLineKeepSameInCurve: true,
    root: { fillColor: '#3d7d6d', color: '#fff', fontSize: 20, fontWeight: 'bold', borderRadius: 10, borderWidth: 0 },
    second: { fillColor: '#ffffff', color: '#2f5d52', fontSize: 15, borderColor: '#4f8a78', borderWidth: 1.5, borderRadius: 8, marginX: 90, marginY: 40 },
    third: { fillColor: 'transparent', color: '#3a4a45', fontSize: 14, borderColor: 'transparent', borderWidth: 0, marginX: 40, marginY: 12 }
  },
  'xm-blue': {
    backgroundColor: '#f5f8fc', lineColor: '#4a7db3', lineWidth: 2,
    lineStyle: 'curve', rootLineKeepSameInCurve: true,
    root: { fillColor: '#2d5f8f', color: '#fff', fontSize: 20, fontWeight: 'bold', borderRadius: 10, borderWidth: 0 },
    second: { fillColor: '#ffffff', color: '#2b4a63', fontSize: 15, borderColor: '#4a7db3', borderWidth: 1.5, borderRadius: 8, marginX: 90, marginY: 40 },
    third: { fillColor: 'transparent', color: '#39464e', fontSize: 14, borderColor: 'transparent', borderWidth: 0, marginX: 40, marginY: 12 }
  },
  'xm-slate': {
    backgroundColor: '#f8f9fa', lineColor: '#7a8699', lineWidth: 2,
    lineStyle: 'direct', rootLineKeepSameInCurve: true,
    root: { fillColor: '#4a5568', color: '#fff', fontSize: 20, fontWeight: 'bold', borderRadius: 6, borderWidth: 0 },
    second: { fillColor: '#ffffff', color: '#3d4654', fontSize: 15, borderColor: '#7a8699', borderWidth: 1.5, borderRadius: 6, marginX: 70, marginY: 36 },
    third: { fillColor: 'transparent', color: '#4a4f57', fontSize: 14, borderColor: 'transparent', borderWidth: 0, marginX: 36, marginY: 10 }
  },
  'xm-amber': {
    backgroundColor: '#faf7f2', lineColor: '#b3894a', lineWidth: 2,
    lineStyle: 'curve', rootLineKeepSameInCurve: true,
    root: { fillColor: '#a4703a', color: '#fff', fontSize: 20, fontWeight: 'bold', borderRadius: 10, borderWidth: 0 },
    second: { fillColor: '#ffffff', color: '#6b4e2c', fontSize: 15, borderColor: '#b3894a', borderWidth: 1.5, borderRadius: 8, marginX: 90, marginY: 40 },
    third: { fillColor: 'transparent', color: '#4d4438', fontSize: 14, borderColor: 'transparent', borderWidth: 0, marginX: 40, marginY: 12 }
  }
}

/** 挂载：layout 传 simple-mind-map 布局名，theme 传 XM_THEMES 键（缺省回落 default） */
function mountMindMap(layout, theme) {
  const M = window.simpleMindMap && (window.simpleMindMap.default || window.simpleMindMap)
  if (!M) return null
  if (typeof M.defineTheme === 'function') {
    for (const [name, cfg] of Object.entries(XM_THEMES)) {
      try {
        M.defineTheme(name, cfg)
      } catch (e) {
        console.warn('defineTheme 失败:', name, e)
      }
    }
  } else {
    theme = 'default'
  }
  const mm = new M({
    el: document.getElementById('canvas'),
    data: JSON.parse(JSON.stringify(DATA)),
    layout: layout,
    theme: theme
  })
  const doFit = () => {
    try {
      if (mm.view && typeof mm.view.fit === 'function') mm.view.fit()
      else if (typeof mm.fit === 'function') mm.fit()
    } catch (e) {
      /* fit 缺席时接受引擎缺省视口 */
    }
  }
  /* 首帧渲染完成后再适配画布（布局异步完成，构造期 fit 会落空） */
  mm.on('node_tree_render_end', doFit)
  setTimeout(doFit, 900)
  window.mm = mm
  return mm
}
