/**
 * 脑图 XMind 风主题包（纯数据，四套：xm-green / xm-blue / xm-slate / xm-amber）。
 *
 * 数据正本：docs/design/mind-editor-redesign/prototypes/proto-common.js 的 XM_THEMES
 * ——本文件逐 hex 逐字段抄写（含 marginX/marginY/rootLineKeepSameInCurve 全部字段），
 * 四套主题已在原型真引擎（simple-mind-map）渲染实测验证，不许自行调色/增删。
 *
 * 背景（plan.md §五）：simple-mind-map npm 包仅内置 default 主题，其余主题须宿主
 * 在实例化前调 defineTheme 注册——本模块即随编辑器自带的注册数据源。
 *
 * 引擎 schema：simple-mind-map 主题（顶层 backgroundColor/lineColor/lineWidth/lineStyle
 * + 节点对象按 layerIndex 取 root/second/node——引擎 0.14.0-fix.3 Style.js merge，
 * ≥2 层读 themeConfig.node，third 键不被引擎消费）。本文件 third 块为正本
 * （proto-common.js XM_THEMES）忠实抄写：引擎不消费，保留=抄写义务，叶子视觉由
 * 引擎 default 兜底（=用户确认的原型实况，裁决 D-THEME 见 .claude/mind-loop-state.md）；
 * third 字段沿正本无框口径，不含 fontWeight/borderRadius。
 *
 * 对正本的两处补字段（均为测试契约钉死「在场」，值取最不发明口径——root 同文件
 * 既有口径、second 同引擎 default）：
 * - root 补 borderColor:'transparent'（测试要求 root 七字段含 borderColor 在场；
 *   正本 root borderWidth=0 无框，与 third 的「宽度 0 配 transparent」口径一致）
 * - second 补 fontWeight:'normal'（测试要求 second 七字段含 fontWeight 在场；正本
 *   second 无此字段，值 normal = 引擎 default second.fontWeight('normal')，零漂移）
 * （测试侧裁决权威须对齐；防漂移 toMatchObject 放行额外字段，故不破防漂移例）
 *
 * 纯数据零引擎 import（defineTheme 调用方在 mindEditor 装配面）。
 */

export type MindThemeName = 'xm-green' | 'xm-blue' | 'xm-slate' | 'xm-amber'

/** 引擎主题对象：宽松形状（引擎 schema 宽，宿主可直接透传 defineTheme） */
export type MindTheme = Record<string, unknown>

export const MIND_THEMES: Record<MindThemeName, MindTheme> = {
  'xm-green': {
    backgroundColor: '#f7f8f7',
    lineColor: '#4f8a78',
    lineWidth: 2,
    lineStyle: 'curve',
    rootLineKeepSameInCurve: true,
    root: {
      fillColor: '#3d7d6d',
      color: '#fff',
      fontSize: 20,
      fontWeight: 'bold',
      borderRadius: 10,
      borderColor: 'transparent',
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#2f5d52',
      fontSize: 15,
      fontWeight: 'normal',
      borderColor: '#4f8a78',
      borderWidth: 1.5,
      borderRadius: 8,
      marginX: 90,
      marginY: 40,
    },
    third: {
      fillColor: 'transparent',
      color: '#3a4a45',
      fontSize: 14,
      borderColor: 'transparent',
      borderWidth: 0,
      marginX: 40,
      marginY: 12,
    },
  },
  'xm-blue': {
    backgroundColor: '#f5f8fc',
    lineColor: '#4a7db3',
    lineWidth: 2,
    lineStyle: 'curve',
    rootLineKeepSameInCurve: true,
    root: {
      fillColor: '#2d5f8f',
      color: '#fff',
      fontSize: 20,
      fontWeight: 'bold',
      borderRadius: 10,
      borderColor: 'transparent',
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#2b4a63',
      fontSize: 15,
      fontWeight: 'normal',
      borderColor: '#4a7db3',
      borderWidth: 1.5,
      borderRadius: 8,
      marginX: 90,
      marginY: 40,
    },
    third: {
      fillColor: 'transparent',
      color: '#39464e',
      fontSize: 14,
      borderColor: 'transparent',
      borderWidth: 0,
      marginX: 40,
      marginY: 12,
    },
  },
  'xm-slate': {
    backgroundColor: '#f8f9fa',
    lineColor: '#7a8699',
    lineWidth: 2,
    lineStyle: 'direct',
    rootLineKeepSameInCurve: true,
    root: {
      fillColor: '#4a5568',
      color: '#fff',
      fontSize: 20,
      fontWeight: 'bold',
      borderRadius: 6,
      borderColor: 'transparent',
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#3d4654',
      fontSize: 15,
      fontWeight: 'normal',
      borderColor: '#7a8699',
      borderWidth: 1.5,
      borderRadius: 6,
      marginX: 70,
      marginY: 36,
    },
    third: {
      fillColor: 'transparent',
      color: '#4a4f57',
      fontSize: 14,
      borderColor: 'transparent',
      borderWidth: 0,
      marginX: 36,
      marginY: 10,
    },
  },
  'xm-amber': {
    backgroundColor: '#faf7f2',
    lineColor: '#b3894a',
    lineWidth: 2,
    lineStyle: 'curve',
    rootLineKeepSameInCurve: true,
    root: {
      fillColor: '#a4703a',
      color: '#fff',
      fontSize: 20,
      fontWeight: 'bold',
      borderRadius: 10,
      borderColor: 'transparent',
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#6b4e2c',
      fontSize: 15,
      fontWeight: 'normal',
      borderColor: '#b3894a',
      borderWidth: 1.5,
      borderRadius: 8,
      marginX: 90,
      marginY: 40,
    },
    third: {
      fillColor: 'transparent',
      color: '#4d4438',
      fontSize: 14,
      borderColor: 'transparent',
      borderWidth: 0,
      marginX: 40,
      marginY: 12,
    },
  },
}
