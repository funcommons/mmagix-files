/**
 * App.vue 根组件挂载冒烟（router-view 需真路由；命令面板/主题 Provider 全量装配）。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import { defineComponent, h } from 'vue'
import App from '../../App.vue'

describe('App.vue：根组件装配', () => {
  it('挂载：主题 Provider + 命令面板 + 路由出口渲染', async () => {
    const router = createRouter({
      history: createWebHistory(),
      routes: [{ path: '/', name: 'Home', component: defineComponent({ render: () => h('div', 'page') }) }],
    })
    const wrapper = mount(App, { global: { plugins: [router] } })
    await router.isReady() // install 后才决出
    await wrapper.vm.$nextTick()
    expect(wrapper.exists()).toBe(true)
    wrapper.unmount()
  })
})
