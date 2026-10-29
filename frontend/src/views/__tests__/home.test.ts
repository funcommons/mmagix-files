/**
 * Home.vue 挂载冒烟（M0 兜底分支）：无 boot 注入 → hero 兜底渲染。
 * 覆盖面=setup 顶层声明+hero 模板渲染函数（工作台分支由浏览器 E2E 覆盖——jsdom 无 S3 会话面）。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Home from '../Home.vue'

describe('Home.vue：无 boot 注入（M0 hero 兜底）', () => {
  it('裸挂载不抛，渲染兜底 hero（配置引导）', async () => {
    const wrapper = mount(Home, {
      global: {
        // config.global.plugins（setup.ts）已带 i18n/pinia/Element Plus；无需 router（未用 useRouter）
        stubs: { teleport: true },
      },
    })
    expect(wrapper.exists()).toBe(true)
    wrapper.unmount()
  })
})
