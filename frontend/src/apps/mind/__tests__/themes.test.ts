/**
 * mind/themes.ts 单测（XMind 风主题包：四套主题数据契约钉死，逐 hex 防漂移）
 * 数据正本：docs/design/mind-editor-redesign/prototypes/proto-common.js 的 XM_THEMES
 * （四套主题已在原型真引擎渲染实测验证——本文件所有 hex 逐字抄正本，不许自行调色）
 * 引擎 schema：simple-mind-map 主题——顶层 backgroundColor/lineColor/lineWidth/lineStyle
 * + 分级节点对象；引擎 0.14 按 layerIndex 消费 root/second/node（Style.js merge，≥2 层读
 * themeConfig.node），third 键从不被引擎读取——third 数据保留=对正本的忠实抄写义务
 * （叶子视觉由引擎 default 兜底，D-THEME 裁决见 .claude/mind-loop-state.md）
 *
 * 契约锁死：
 * - MindThemeName = 'xm-green' | 'xm-blue' | 'xm-slate' | 'xm-amber'（恰好四键）
 * - MIND_THEMES: Record<MindThemeName, MindTheme>
 * - 三级节点字段口径：root/second 含 fillColor/color/fontSize/fontWeight/borderColor/
 *   borderWidth/borderRadius；third 沿正本（叶子无框口径）不含 fontWeight/borderRadius
 * - lineStyle 分派：green/blue/amber='curve'、slate='direct'；lineWidth 全部 2
 * - rootLineKeepSameInCurve：四套全部 true（曲线派下根线与子线同走曲线的正本口径）
 *
 * 【测试先行】apps/mind/themes.ts 由 MC2-C 子代理实现——本文件初跑红=预期。
 */
import { describe, expect, it } from 'vitest'
import { MIND_THEMES } from '../themes'
import type { MindTheme, MindThemeName } from '../themes'

/** proto-common.js XM_THEMES 逐字快照（防漂移基准）：正本字段全量入快照—— */
/** marginX/marginY（second/third）与 rootLineKeepSameInCurve 均已钉死，快照内不存在 */
/** 「允许缺席」的正本字段；仍用 toMatchObject 而非 toEqual，只为放行实现侧正本外的 */
/** 额外字段（引擎 schema 宽）。允许缺席的仅剩 third（叶子）的 fontWeight/borderRadius */
/** （引擎不消费的叶子口径自由度）；两处补字段（root.borderColor / second.fontWeight） */
/** 正本没有、不入快照，其「值」由「三级节点共用口径」专例钉死。 */
const PROTO: Record<MindThemeName, object> = {
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
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#2f5d52',
      fontSize: 15,
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
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#2b4a63',
      fontSize: 15,
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
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#3d4654',
      fontSize: 15,
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
      borderWidth: 0,
    },
    second: {
      fillColor: '#ffffff',
      color: '#6b4e2c',
      fontSize: 15,
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

const NAMES: MindThemeName[] = ['xm-green', 'xm-blue', 'xm-slate', 'xm-amber']

describe('主题包形状与键集', () => {
  it('恰好四键：键集精确等于 xm-green/xm-blue/xm-slate/xm-amber', () => {
    expect(Object.keys(MIND_THEMES).sort()).toEqual([
      'xm-amber',
      'xm-blue',
      'xm-green',
      'xm-slate',
    ])
  })

  it('类型通道：MindThemeName 四值可枚举且每键取到主题对象（编译期即锁导出形状）', () => {
    const table: Record<MindThemeName, MindTheme> = MIND_THEMES
    for (const name of NAMES) {
      const theme: MindTheme = table[name]
      expect(theme).toBeTypeOf('object')
      expect(theme).not.toBeNull()
    }
  })

  it('四套 backgroundColor 各不相同（一眼可辨的主题差异）', () => {
    const bgs = NAMES.map((name) => MIND_THEMES[name].backgroundColor)
    expect(new Set(bgs).size).toBe(4)
  })

  it('必备字段在场：顶层四字段 + root/second 七字段 + third 叶子口径五字段', () => {
    for (const name of NAMES) {
      const t = MIND_THEMES[name]
      for (const k of ['backgroundColor', 'lineColor', 'lineWidth', 'lineStyle', 'root', 'second', 'third']) {
        expect(t).toHaveProperty(k)
      }
      for (const k of ['fillColor', 'color', 'fontSize', 'fontWeight', 'borderColor', 'borderWidth', 'borderRadius']) {
        expect(t.root).toHaveProperty(k)
        expect(t.second).toHaveProperty(k)
      }
      // third（叶子）沿正本：无 fontWeight/borderRadius，但五项必备字段须在场
      for (const k of ['fillColor', 'color', 'fontSize', 'borderColor', 'borderWidth']) {
        expect(t.third).toHaveProperty(k)
      }
    }
  })
})

describe('hex 钉死（防漂移，逐字抄正本）', () => {
  it('xm-green 关键 hex：root.fillColor=#3d7d6d、lineColor=#4f8a78、second.borderColor=#4f8a78、third.fillColor=transparent', () => {
    const g = MIND_THEMES['xm-green']
    expect(g.root.fillColor).toBe('#3d7d6d')
    expect(g.lineColor).toBe('#4f8a78')
    expect(g.second.borderColor).toBe('#4f8a78')
    expect(g.third.fillColor).toBe('transparent')
  })

  it('xm-blue root.fillColor=#2d5f8f', () => {
    expect(MIND_THEMES['xm-blue'].root.fillColor).toBe('#2d5f8f')
  })

  it('xm-slate root.fillColor=#4a5568', () => {
    expect(MIND_THEMES['xm-slate'].root.fillColor).toBe('#4a5568')
  })

  it('xm-amber root.fillColor=#a4703a', () => {
    expect(MIND_THEMES['xm-amber'].root.fillColor).toBe('#a4703a')
  })

  it('全主题逐字段与原型正本快照一致（toMatchObject：正本字段全等、额外字段放行）', () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name]).toMatchObject(PROTO[name])
    }
  })
})

describe('线型与线宽分派', () => {
  it("lineStyle 分派：xm-green/xm-blue/xm-amber='curve'", () => {
    expect(MIND_THEMES['xm-green'].lineStyle).toBe('curve')
    expect(MIND_THEMES['xm-blue'].lineStyle).toBe('curve')
    expect(MIND_THEMES['xm-amber'].lineStyle).toBe('curve')
  })

  it("lineStyle 分派：xm-slate='direct'（唯一直线派）", () => {
    expect(MIND_THEMES['xm-slate'].lineStyle).toBe('direct')
  })

  it('lineWidth 全部 = 2', () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name].lineWidth).toBe(2)
    }
  })

  it('rootLineKeepSameInCurve 四套全部 true（PROTO 已并入同值；此独立例专防「字段整体被删」漂移，失败信息直读）', () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name].rootLineKeepSameInCurve).toBe(true)
    }
  })
})

describe('三级节点共用口径', () => {
  it("每套主题 root.fontSize=20 且 fontWeight='bold'", () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name].root.fontSize).toBe(20)
      expect(MIND_THEMES[name].root.fontWeight).toBe('bold')
    }
  })

  it('每套主题 second.borderWidth=1.5', () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name].second.borderWidth).toBe(1.5)
    }
  })

  it('每套主题 third.borderWidth=0 且 borderColor=transparent（无框叶子口径）', () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name].third.borderWidth).toBe(0)
      expect(MIND_THEMES[name].third.borderColor).toBe('transparent')
    }
  })

  it('（加赛）叶子无框口径四套全查：third.fillColor=transparent 且 borderWidth=0', () => {
    for (const name of NAMES) {
      const third = MIND_THEMES[name].third
      expect(third.fillColor).toBe('transparent')
      expect(third.borderWidth).toBe(0)
    }
  })

  it("每套主题 root.borderColor='transparent'（补字段值钉死：正本 root 无框，宽度 0 配 transparent 与 third 同口径）", () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name].root.borderColor).toBe('transparent')
    }
  })

  it("每套主题 second.fontWeight='normal'（补字段值钉死，终态契约：normal 非 bold）", () => {
    for (const name of NAMES) {
      expect(MIND_THEMES[name].second.fontWeight).toBe('normal')
    }
  })
})
