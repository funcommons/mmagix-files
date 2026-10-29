/**
 * SDK 侧栏导航纯逻辑单测：filterRoutes（四维过滤）/ buildNavItems（分组组装）/
 * useRouteAccess + useSidebarNavItems（composable 组合——挂宿主编译上下文）。
 */
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createRouter, createWebHistory, type RouteRecordNormalized } from 'vue-router'

import { filterRoutes, useRouteAccess } from '../useRouteAccess'
import { buildNavItems } from '../buildNavItems'
import { useSidebarNavItems } from '../useSidebarNavItems'

/** 造路由记录（仅用断言面字段） */
const mkRoute = (
  name: string,
  path: string,
  meta: Record<string, unknown> = {},
): RouteRecordNormalized =>
  ({
    name,
    path,
    meta,
    props: {},
    components: {},
    children: [],
    aliases: [],
    instances: {},
    enterCbs: [],
    leaveCbs: [],
    redirect: undefined,
    beforeEnter: undefined,
    propsOf: undefined,
  }) as unknown as RouteRecordNormalized

const ROUTES: RouteRecordNormalized[] = [
  mkRoute('Home', '/', { title: 'router.home', icon: 'Files' }),
  mkRoute('CreateImage', '/create/image', { title: 'create.image', feature: 'dev' }),
  mkRoute('AdminUsers', '/admin/users', { title: 'admin.users', roles: ['admin'] }),
  mkRoute('NoTitle', '/no-title', {}),
  mkRoute('Hidden', '/hidden', { title: 'hidden', feature: 'gone' }),
]

const t = (key: string): string => `T:${key}`
const iconResolver = (name: string): string | null => (name ? `icon:${name}` : null)

describe('filterRoutes：四维访问过滤', () => {
  it('requireTitle（默认开）：无 title 路由剔除', () => {
    const out = filterRoutes(ROUTES)
    expect(out.map((r) => String(r.name))).toEqual(['Home', 'CreateImage', 'AdminUsers', 'Hidden'])
    expect(filterRoutes(ROUTES, { requireTitle: false }).map((r) => String(r.name))).toContain('NoTitle')
  })

  it('features 钩子：feature 声明且校验 false → 剔除；无 feature 声明不校验', () => {
    const out = filterRoutes(ROUTES, { features: (key: string) => key !== 'gone' })
    expect(out.map((r) => String(r.name))).not.toContain('Hidden')
    expect(out.map((r) => String(r.name))).toContain('CreateImage') // feature=dev 通过
  })

  it('roles 钩子：仅当路由声明 roles 时才校验（userRole 取 meta.__userRole）', () => {
    const adminView = (route: RouteRecordNormalized, role: string | null): boolean =>
      !(route.meta?.roles as string[])?.includes('admin') || role === 'admin'
    const guest = filterRoutes(ROUTES, { roles: adminView })
    expect(guest.map((r) => String(r.name))).not.toContain('AdminUsers')

    const withRole = ROUTES.map((r) => ({ ...r, meta: { ...r.meta, __userRole: 'admin' } }))
    expect(filterRoutes(withRole, { roles: adminView }).map((r) => String(r.name))).toContain('AdminUsers')
  })

  it('customFilter：完全自定义兜底', () => {
    const out = filterRoutes(ROUTES, { customFilter: (r) => !String(r.name).startsWith('Admin') })
    expect(out.map((r) => String(r.name))).not.toContain('AdminUsers')
  })
})

describe('buildNavItems：菜单数据工厂', () => {
  it('topLevels 按 routeNames 显式顺序出叶子；icon 经 resolver', () => {
    const items = buildNavItems({
      routes: ROUTES.filter((r) => r.meta?.title),
      t,
      iconResolver,
      topLevels: [{ routeNames: ['CreateImage', 'Home'] }],
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ index: '/create/image', label: 'T:create.image' })
    expect(items[1]).toMatchObject({ index: '/', label: 'T:router.home' })
    // meta.icon 缺省 → icon undefined；有 icon 走 resolver
    expect((items[0] as { icon?: unknown }).icon).toBeUndefined()
    expect((items[1] as { icon?: unknown }).icon).toBe('icon:Files')
  })

  it('groups：routeNamePrefix 前缀匹配入组（iconName 解析/可见性开关）', () => {
    const items = buildNavItems({
      routes: ROUTES.filter((r) => r.meta?.title),
      t,
      iconResolver,
      groups: [
        { id: 'g-create', labelKey: 'sidebar.create', iconName: 'MagicStick', routeNamePrefix: 'Create' },
        { id: 'g-off', labelKey: 'sidebar.off', routeNamePrefix: 'Admin', visible: false },
        { id: 'g-fn', labelKey: 'sidebar.fn', routeNames: ['Hidden'], visible: () => false },
      ],
    })
    expect(items).toHaveLength(1)
    const group = items[0] as { type: string; index: string; label: string; children: unknown[]; popperClass: string }
    expect(group).toMatchObject({ type: 'group', index: 'g-create', label: 'T:sidebar.create', popperClass: 'fc-sidebar-popper' })
    expect(group.children).toHaveLength(1)
  })

  it('leafFilter 组内过滤 + 无 title 叶子丢弃 + 空 matches 组不产出', () => {
    const items = buildNavItems({
      routes: ROUTES,
      t,
      iconResolver,
      groups: [
        { id: 'g', labelKey: 'g', routeNames: ['Home', 'NoTitle', 'Missing'], leafFilter: (r) => String(r.name) !== 'Home' },
        { id: 'empty', labelKey: 'empty', routeNames: ['Zzz'] },
      ],
      topLevels: [],
    })
    expect(items).toHaveLength(0) // Home 被 leafFilter 剔、NoTitle 无 title 丢、Missing 不存在、empty 组空
  })
})

describe('useRouteAccess / useSidebarNavItems：composable 组合', () => {
  it('响应式过滤 + 一行组装（挂宿主提供 router/i18n 上下文）', async () => {
    const router = createRouter({
      history: createWebHistory(),
      routes: [
        { path: '/', name: 'Home', component: defineComponent({ render: () => h('div') }), meta: { title: 'router.home', icon: 'Files' } },
        { path: '/dev', name: 'DevOnly', component: defineComponent({ render: () => h('div') }), meta: { title: 'dev.only', feature: 'dev' } },
      ],
    })
    // 注：isReady 在 install（mount）前调用永不决出——初始导航由插件安装触发
    let items!: ReturnType<typeof useSidebarNavItems>
    const Host = defineComponent({
      setup() {
        items = useSidebarNavItems({
          iconResolver: (n) => (n ? `i:${n}` : null),
          features: (key: string) => key === 'dev',
          groups: [{ id: 'g', labelKey: 'sidebar.g', routeNamePrefix: 'Dev' }],
          topLevels: [{ routeNames: ['Home'] }],
        })
        return () => h('div')
      },
    })
    mount(Host, { global: { plugins: [router] } })
    expect(items.value).toHaveLength(2) // Home 叶子 + Dev 组
    expect(String(items.value[0]?.index)).toBe('/')
    const group = items.value[1] as { index?: string; children?: unknown[] }
    expect(group.index).toBe('g')
    expect(group.children).toHaveLength(1)
  })
})
