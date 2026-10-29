/**
 * router 单测：路由表形状（history 模式铁律 / Home + 子路径兜底）/ dirtyFormRegistry 注册表 /
 * 路由守卫链（title 设置 + 脏表单 discard/cancel 分支——ElMessageBox mock）。
 * 注：vue-router 对同一路由重复 push 是 duplicated navigation（守卫不跑）——守卫用例各自
 * 导航到不同路径（catch-all 兜底路由承接，无 meta.title 不影响断言）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const elMessageBox = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('element-plus', () => ({
  ElMessageBox: elMessageBox,
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  ElNotification: vi.fn(),
}))

import { dirtyFormRegistry, default as router } from '../index'

beforeEach(() => {
  setActivePinia(createPinia())
  elMessageBox.confirm.mockReset()
  document.title = 'untitled'
})

describe('路由表形状', () => {
  it('history 模式（铁律禁 hash）：resolve href 不带 #', () => {
    expect(router.resolve('/some-path').href.startsWith('#')).toBe(false)
  })

  it('Home 在 / + catch-all 兜底渲染 Home（vendoring 子路径挂载，不重定向）', () => {
    const paths = router.options.routes.map((r) => r.path)
    expect(paths).toContain('/')
    expect(paths).toContain('/:pathMatch(.*)*')
    const fallback = router.options.routes.find((r) => r.name === 'EmbedFallback')
    expect(fallback?.redirect).toBeUndefined() // catch-all 不得 redirect（会破坏相对资源解析）
  })
})

describe('dirtyFormRegistry：脏表单注册表', () => {
  const mk = (dirty: boolean) => ({ isDirty: () => dirty, discard: vi.fn() })

  it('register/findDirty/unregister：返回首个脏表单；无脏返回 null', () => {
    const clean = mk(false)
    const dirty1 = mk(true)
    const dirty2 = mk(true)
    dirtyFormRegistry.register(clean)
    expect(dirtyFormRegistry.findDirty()).toBeNull()
    dirtyFormRegistry.register(dirty1)
    dirtyFormRegistry.register(dirty2)
    expect(dirtyFormRegistry.findDirty()).toBe(dirty1) // Set 插入序：首个脏者胜
    dirtyFormRegistry.unregister(dirty1)
    expect(dirtyFormRegistry.findDirty()).toBe(dirty2)
    dirtyFormRegistry.unregister(dirty2)
    dirtyFormRegistry.unregister(clean)
    expect(dirtyFormRegistry.findDirty()).toBeNull()
  })

  it('重复 unregister 幂等不抛', () => {
    const f = mk(false)
    dirtyFormRegistry.register(f)
    dirtyFormRegistry.unregister(f)
    expect(() => dirtyFormRegistry.unregister(f)).not.toThrow()
  })
})

describe('路由守卫：title 与脏表单兜底', () => {
  it('导航到 /：document.title = t(router.home) - t(app.name)', async () => {
    await router.push('/')
    expect(document.title).toBe('首页 - Magix Files')
  })

  it('无脏表单：直接放行不弹确认（catch-all 路由触发守卫链）', async () => {
    await router.push('/guard-clean-probe')
    expect(elMessageBox.confirm).not.toHaveBeenCalled()
  })

  it('有脏表单：弹确认→discard 放行', async () => {
    elMessageBox.confirm.mockResolvedValue('confirm')
    const dirty = { isDirty: () => true, discard: vi.fn() }
    dirtyFormRegistry.register(dirty)
    try {
      await router.push('/guard-dirty-accept')
      expect(elMessageBox.confirm).toHaveBeenCalledTimes(1)
      expect(dirty.discard).toHaveBeenCalledTimes(1)
    } finally {
      dirtyFormRegistry.unregister(dirty)
    }
  })

  it('有脏表单：确认取消 → 导航被拦（discard 不执行）', async () => {
    elMessageBox.confirm.mockRejectedValue('cancel')
    const dirty = { isDirty: () => true, discard: vi.fn() }
    dirtyFormRegistry.register(dirty)
    try {
      const failure = await router.push('/guard-dirty-cancel') // 守卫 false → push resolve 出 NavigationFailure
      expect(failure).toBeDefined()
      expect(dirty.discard).not.toHaveBeenCalled()
    } finally {
      dirtyFormRegistry.unregister(dirty)
    }
  })
})
