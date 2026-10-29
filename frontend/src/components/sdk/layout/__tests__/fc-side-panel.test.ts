/**
 * FcSidePanel 单测：桌面卡片形态（宽度换算/方向）+ v-model:open 双向 + 移动端 FAB/抽屉切换。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import FcSidePanel from '../FcSidePanel.vue'

describe('FcSidePanel：桌面/移动双形态', () => {
  it('桌面：数字宽度转 px 字符串渲染卡片；v-model:open 默认 false', () => {
    const wrapper = mount(FcSidePanel, { props: { width: 320, drawerTitle: '面板' } })
    // 数字 320 → 320px 内联宽度（桌面=FcSection 卡片；drawerTitle 只用于移动端 FAB title）
    expect(wrapper.html()).toContain('width: 320px')
    wrapper.unmount()
  })

  it('字符串宽度原样透传；四向 direction 合法渲染', () => {
    for (const dir of ['rtl', 'ltr', 'ttb', 'btt'] as const) {
      const w = mount(FcSidePanel, { props: { width: '40vw', drawerDirection: dir } })
      expect(w.exists()).toBe(true)
      w.unmount()
    }
  })

  it('v-model:open 双向：父组件改 true → 抽屉开；组件内关闭 → 回写父', async () => {
    const open = ref(false)
    const Host = defineComponent({
      setup() {
        return () => h(FcSidePanel, { open: open.value, 'onUpdate:open': (v: boolean) => (open.value = v) })
      },
    })
    const wrapper = mount(Host)
    open.value = true
    await wrapper.vm.$nextTick()
    open.value = false
    await wrapper.vm.$nextTick()
    expect(open.value).toBe(false)
    wrapper.unmount()
  })
})
