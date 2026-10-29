/**
 * useEventListener 单测：Ref 目标自动 unref / null 目标 no-op / 卸载自动解绑 / options 透传。
 */
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useEventListener } from '../useEventListener'

describe('useEventListener：自动清理事件绑定', () => {
  it('Ref 目标绑定生效；组件卸载自动解绑', async () => {
    const handler = vi.fn()
    const target = ref<HTMLElement | null>(document.createElement('button'))
    document.body.appendChild(target.value!)

    const wrapper = mount(defineComponent({
      setup() {
        useEventListener(target, 'click', handler)
        return () => h('div')
      },
    }))

    target.value!.click()
    expect(handler).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    target.value!.click()
    expect(handler).toHaveBeenCalledTimes(1) // 卸载后静默
  })

  it('非 Ref 目标（window）与 options 透传', () => {
    const handler = vi.fn()
    const wrapper = mount(defineComponent({
      setup() {
        useEventListener(window, 'resize', handler, { passive: true })
        return () => h('div')
      },
    }))
    window.dispatchEvent(new Event('resize'))
    expect(handler).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    window.dispatchEvent(new Event('resize'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('null 目标：no-op 不抛', () => {
    const wrapper = mount(defineComponent({
      setup() {
        useEventListener(null, 'click', vi.fn())
        return () => h('div')
      },
    }))
    expect(() => wrapper.unmount()).not.toThrow()
  })
})
