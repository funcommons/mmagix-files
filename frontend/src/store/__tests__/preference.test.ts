/**
 * preference / app / oem store 单测（pinia 活跃实例逐测重建；jsdom localStorage/sessionStorage 真库）。
 * preference 持久化链（persist→localStorage→hydrate）与 applyToRoot DOM 联动是主测点。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePreferenceStore } from '../preference'
import { useAppStore } from '../app'
import { useOemStore } from '../oem'

const KEY = 'ldx2-aigc:preference'

/** 内存 Storage 桩（Node ≥23 实验性全局 localStorage setItem 静默失效——无条件覆写） */
function installMemStorage(name: 'localStorage' | 'sessionStorage'): void {
  const mem = new Map<string, string>()
  const fake = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() {
      return mem.size
    },
  }
  Object.defineProperty(window, name, { value: fake, configurable: true })
  Object.defineProperty(globalThis, name, { value: fake, configurable: true })
}

beforeEach(() => {
  setActivePinia(createPinia())
  installMemStorage('localStorage')
  installMemStorage('sessionStorage')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-brand')
  document.documentElement.style.removeProperty('--app-sidebar-width')
  document.title = 'untitled'
})

describe('usePreferenceStore：缺省与持久化链', () => {
  it('缺省态：light/ldx2/zh-CN/侧栏展开 240；isDark getter', () => {
    const s = usePreferenceStore()
    expect(s.theme).toBe('light')
    expect(s.brand).toBe('ldx2')
    expect(s.locale).toBe('zh-CN')
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.sidebarWidth).toBe(240)
    expect(s.showAppearance).toBe(false)
    expect(s.isDark).toBe(false)
  })

  it('setTheme/setBrand：写 state + applyToRoot（DOM 属性）+ persist（localStorage）', () => {
    const s = usePreferenceStore()
    s.setTheme('dark')
    s.setBrand('apple')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-brand')).toBe('apple')
    const persisted = JSON.parse(window.localStorage.getItem(KEY)!)
    expect(persisted).toMatchObject({ theme: 'dark', brand: 'apple' })
    expect(s.isDark).toBe(true)
  })

  it('hydrate：localStorage 有值时启动即恢复（含侧栏状态）', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ theme: 'dark', sidebarCollapsed: true, sidebarWidth: 300 }))
    const s = usePreferenceStore()
    expect(s.theme).toBe('dark')
    expect(s.sidebarCollapsed).toBe(true)
    expect(s.sidebarWidth).toBe(300)
    expect(s.locale).toBe('zh-CN') // 未持久化字段落缺省
  })

  it('setLocale/toggleSidebar/setSidebarCollapsed/setShowAppearance：均落盘', () => {
    const s = usePreferenceStore()
    s.setLocale('en-US')
    s.toggleSidebar()
    s.setShowAppearance(true)
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({ locale: 'en-US', sidebarCollapsed: true })
    expect(s.showAppearance).toBe(true) // UI 临时态在内存，不进 localStorage
    s.setSidebarCollapsed(false)
    expect(s.sidebarCollapsed).toBe(false)
  })

  it('setSidebarWidth：同步 --app-sidebar-width CSS 变量 + 持久化', () => {
    const s = usePreferenceStore()
    s.setSidebarWidth(280)
    expect(document.documentElement.style.getPropertyValue('--app-sidebar-width')).toBe('280px')
    expect(JSON.parse(window.localStorage.getItem(KEY)!).sidebarWidth).toBe(280)
  })

  it('setFromEmbed：改 brand/theme/locale 即时生效但 **不 persist**', () => {
    const s = usePreferenceStore()
    s.setFromEmbed({ brand: 'google', theme: 'dark', locale: 'en-US' })
    expect(document.documentElement.getAttribute('data-brand')).toBe('google')
    expect(s.theme).toBe('dark')
    expect(window.localStorage.getItem(KEY)).toBeNull() // 嵌入参数不污染 localStorage
  })

  it('reset：清 localStorage + 回缺省（或 OEM overrides）+ 立即生效；UI 布局字段不动', () => {
    const s = usePreferenceStore()
    s.setTheme('dark')
    s.setSidebarWidth(300)
    s.reset()
    expect(s.theme).toBe('light')
    expect(s.sidebarWidth).toBe(300) // reset 不动 sidebar*
    expect(JSON.parse(window.localStorage.getItem(KEY)!).theme).toBe('light') // reset 后重新 persist
    s.reset({ theme: 'dark', brand: 'mchuan', locale: 'en-US' })
    expect(s.theme).toBe('dark')
    expect(s.brand).toBe('mchuan')
    expect(document.documentElement.getAttribute('data-brand')).toBe('mchuan')
  })

  it('init：applyToRoot 幂等重放', () => {
    const s = usePreferenceStore()
    s.setBrand('manyun')
    document.documentElement.removeAttribute('data-brand')
    s.init()
    expect(document.documentElement.getAttribute('data-brand')).toBe('manyun')
  })
})

describe('useAppStore：侧栏抽屉与全局 loading', () => {
  it('toggle/open/close 与 loading 开关', () => {
    const s = useAppStore()
    expect(s.sidebarDrawerVisible).toBe(false)
    s.toggleSidebar()
    expect(s.sidebarDrawerVisible).toBe(true)
    s.closeDrawer()
    expect(s.sidebarDrawerVisible).toBe(false)
    s.openDrawer()
    expect(s.sidebarDrawerVisible).toBe(true)
    s.setLoading(true)
    s.setGlobalLoading(true)
    expect(s.loading).toBe(true)
    expect(s.globalLoading).toBe(true)
  })
})

describe('useOemStore：配置就绪与 DOM 应用', () => {
  it('config 内置即就绪（loaded=true）；apply 写 title/favicon/EP 色变量', () => {
    const s = useOemStore()
    expect(s.loaded).toBe(true)
    expect(s.config).toBeTruthy()

    s.config = { ...s.config, title: 'MMagiX Files', faviconUrl: 'data:image/png,f', primaryColor: '#123456', dangerColor: '#654321' }
    s.apply()
    expect(document.title).toBe('MMagiX Files')
    const icon = document.head.querySelector('link[rel~="icon"]') as HTMLLinkElement
    expect(icon?.href).toContain('data:image/png')
    expect(document.documentElement.style.getPropertyValue('--el-color-primary')).toBe('#123456')
    expect(document.documentElement.style.getPropertyValue('--el-color-danger')).toBe('#654321')

    // 二次 apply 复用已存在 favicon link（不重复挂）
    s.config = { ...s.config, faviconUrl: 'data:image/png,g' }
    s.apply()
    expect(document.head.querySelectorAll('link[rel~="icon"]')).toHaveLength(1)
  })
})
