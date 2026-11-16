/**
 * locales 结构守卫：intlify 解析口径回归。
 *
 * 事故记录（2026-11-11 裸键）：43 个 mind 键曾写成「app 块内带点扁平键」
 * （`app: { 'mind-outline.toggle': '大纲' }`），而代码查键是 `t('app.mind-outline.toggle')`。
 * intlify 解析器只有两条命中路径——①根级全路径字面命中（`messages['app.flow-label']`），
 * ②按点拆开嵌套行走（`messages.app['mind-outline'].toggle`）——块内带点扁平键两头够不着，
 * 任何浏览器新加载都必然渲染裸键，且单测因 mock t 全绿（绿未归因正确路径）。
 *
 * 四层防线：
 * ① mind 全 43 键经真 vue-i18n 实例可解析（裸键=失败）；
 * ② 双职键 `app.mind-view.layout`/`theme` 既作叶（控件标签）又作前缀（枚举）——
 *    这正是键必须保持根级扁平、不能改嵌套对象的原因；
 * ③ 结构不变量：depth≥1 的键名禁止含点（点键只允许根级）；
 * ④ zh-CN 与 en-US 叶键集合一致（语言切换不裸键）。
 */
import { describe, it, expect } from 'vitest'
import { createI18n } from 'vue-i18n'
import zhCN from '../zh-CN'
import enUS from '../en-US'

// 代码侧真实查键全集（mindEditor.ts 字面量 + mindPanel.ts/mindSearch.ts I18N_PREFIX 拼接的展开式）
const MIND_KEYS = [
  // mind-panel（mindPanel.ts PANEL_I18N_PREFIX 六后缀）
  'app.mind-panel.note',
  'app.mind-panel.image',
  'app.mind-panel.hyperlink',
  'app.mind-panel.tags',
  'app.mind-panel.generalization',
  'app.mind-panel.close',
  // mind-outline（mindEditor.ts 大纲钮）+ mind-search（mindSearch.ts I18N_PREFIX 四后缀）
  'app.mind-outline.toggle',
  'app.mind-outline.label',
  'app.mind-search.placeholder',
  'app.mind-search.next',
  'app.mind-search.prev',
  'app.mind-search.count',
  // mind-view（MP1：两控件标签 + 7 布局枚举 + 4 主题枚举）
  'app.mind-view.layout',
  'app.mind-view.layout.logicalStructure',
  'app.mind-view.layout.mindMap',
  'app.mind-view.layout.organizationStructure',
  'app.mind-view.layout.fishbone',
  'app.mind-view.layout.timeline',
  'app.mind-view.layout.verticalTimeline',
  'app.mind-view.layout.catalogOrganization',
  'app.mind-view.theme',
  'app.mind-view.theme.xm-green',
  'app.mind-view.theme.xm-blue',
  'app.mind-view.theme.xm-slate',
  'app.mind-view.theme.xm-amber',
  // mind-export / mind-import / mind-templates / mind-theme-panel（MP2 四批）
  'app.mind-export.do',
  'app.mind-export.png',
  'app.mind-export.svg',
  'app.mind-export.json',
  'app.mind-export.opml',
  'app.mind-import.do',
  'app.mind-templates.do',
  'app.mind-templates.placeholder',
  'app.mind-templates.items.project',
  'app.mind-templates.items.brainstorm',
  'app.mind-templates.items.release',
  'app.mind-theme-panel.do',
  'app.mind-theme-panel.fill',
  'app.mind-theme-panel.line',
  'app.mind-theme-panel.lineStyle',
  'app.mind-theme-panel.lineStyle.solid',
  'app.mind-theme-panel.lineStyle.dashed',
  'app.mind-theme-panel.apply',
]

function makeT(messages: Record<string, unknown>, locale: 'zh-CN' | 'en-US') {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en-US',
    messages: { [locale]: messages } as never,
    // 本文件专测解析命中，禁掉缺失/回退告警避免控制台噪音
    missingWarn: false,
    fallbackWarn: false,
  }).global.t
}

describe('locales 结构守卫（intlify 解析口径）', () => {
  it.each([
    ['zh-CN', zhCN],
    ['en-US', enUS],
  ])('%s：mind 全 43 键经真 i18n 实例可解析（裸键=失败）', (locale, messages) => {
    const t = makeT(messages as Record<string, unknown>, locale as 'zh-CN' | 'en-US')
    const raw = MIND_KEYS.filter((key) => t(key) === key)
    expect(raw).toEqual([])
  })

  it('双职键：mind-view.layout/theme 既作叶（控件标签）又作前缀（枚举）', () => {
    const t = makeT(zhCN as Record<string, unknown>, 'zh-CN')
    expect(t('app.mind-view.layout')).toBe('布局')
    expect(t('app.mind-view.layout.logicalStructure')).toBe('逻辑结构')
    expect(t('app.mind-view.theme')).toBe('主题')
    expect(t('app.mind-view.theme.xm-green')).toBe('青绿')
    const tEn = makeT(enUS as Record<string, unknown>, 'en-US')
    expect(tEn('app.mind-view.layout')).toBe('Layout')
    expect(tEn('app.mind-view.layout.fishbone')).toBe('Fishbone')
  })

  it('结构不变量：depth≥1 的键名禁止含点（点键只允许根级全路径）', () => {
    const walk = (obj: unknown, depth: number, path: string): void => {
      if (!obj || typeof obj !== 'object') return
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (depth >= 1) expect(k, `${path} → 块内点键 "${k}" 查询不可达`).not.toContain('.')
        walk(v, depth + 1, `${path}.${k}`)
      }
    }
    walk(zhCN, 0, 'zh-CN')
    walk(enUS, 0, 'en-US')
  })

  it('zh-CN 与 en-US 叶键集合一致（语言切换不裸键）', () => {
    const leaves = (obj: unknown, prefix = ''): string[] =>
      Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        v && typeof v === 'object' ? leaves(v, `${prefix}.${k}`) : [`${prefix}.${k}`],
      )
    expect(leaves(zhCN).sort()).toEqual(leaves(enUS).sort())
  })
})
