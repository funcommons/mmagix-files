/**
 * FcDropZone 单测：accept/max-size/multiple 校验分流（drop/reject）、URL 文本拖入、
 * 拖拽计数（dragenter/leave 抖动）、点击选文件、disabled/clickable 门控。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import FcDropZone from '../FcDropZone.vue'

const mkFile = (name: string, size: number, type = 'image/png'): File =>
  new File([new Uint8Array(Math.max(1, size))], name, { type })

/** DataTransfer 桩（jsdom 无构造器） */
function dt(payload: { files?: File[]; text?: string }): DataTransfer {
  return {
    files: payload.files ?? [],
    items: [] as unknown as DataTransferItemList,
    getData: () => payload.text ?? '',
  } as unknown as DataTransfer
}

const drag = (wrapper: ReturnType<typeof mount>, type: string, transfer: DataTransfer): void => {
  wrapper.find('.fc-drop-zone').trigger(type, { dataTransfer: transfer })
}

describe('FcDropZone：校验与事件分流', () => {
  it('合法文件 → emit drop；超 size → reject(size)；类型不符 → reject(type)', async () => {
    const wrapper = mount(FcDropZone, { props: { accept: 'image/*,.txt', maxSize: 100 } })
    drag(wrapper, 'drop', dt({ files: [mkFile('a.png', 50), mkFile('b.txt', 30, 'text/plain')] }))
    await wrapper.vm.$nextTick()
    const dropEv = wrapper.emitted('drop')
    expect(dropEv).toHaveLength(1)
    expect((dropEv![0]![0] as File[]).map((f) => f.name)).toEqual(['a.png', 'b.txt'])

    drag(wrapper, 'drop', dt({ files: [mkFile('big.png', 200)] }))
    await wrapper.vm.$nextTick()
    const rej = wrapper.emitted('reject')!
    expect(rej[0]![0]).toMatchObject({ reason: 'size' })

    drag(wrapper, 'drop', dt({ files: [mkFile('evil.exe', 10, 'application/x-exe')] }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reject')![1]![0]).toMatchObject({ reason: 'type' })
  })

  it('multiple=false：多文件拒收（count）', async () => {
    const wrapper = mount(FcDropZone, { props: { multiple: false } })
    drag(wrapper, 'drop', dt({ files: [mkFile('a.png', 1), mkFile('b.png', 1)] }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('reject')![0]![0]).toMatchObject({ reason: 'count' })
    expect(wrapper.emitted('drop')).toBeUndefined()
  })

  it('URL 文本拖入（无 files 且 getData 有 http 串）→ drop-url', async () => {
    const wrapper = mount(FcDropZone)
    drag(wrapper, 'drop', dt({ text: 'https://example.com/a.jpg' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('drop-url')![0]![0]).toBe('https://example.com/a.jpg')
  })

  it('拖拽计数：enter→over→leave 抖动不闪 isDragOver；drop 后复位', async () => {
    const wrapper = mount(FcDropZone)
    const root = wrapper.find('.fc-drop-zone')
    root.trigger('dragenter', { dataTransfer: dt({}) })
    await wrapper.vm.$nextTick()
    root.trigger('dragenter', { dataTransfer: dt({}) }) // 嵌套元素二次 enter
    await wrapper.vm.$nextTick()
    expect(root.classes().join(' ')).toContain('is-drag-over')

    root.trigger('dragleave', { dataTransfer: dt({}) }) // 一次 leave：计数未归零不闪
    await wrapper.vm.$nextTick()
    root.trigger('dragleave', { dataTransfer: dt({}) })
    await wrapper.vm.$nextTick()
    expect(root.classes().join(' ')).not.toContain('is-drag-over')

    root.trigger('dragenter', { dataTransfer: dt({}) })
    await wrapper.vm.$nextTick()
    drag(wrapper, 'drop', dt({ files: [mkFile('a.png', 1)] }))
    await wrapper.vm.$nextTick()
    expect(root.classes().join(' ')).not.toContain('is-drag-over') // drop 复位
  })

  it('点击触发隐藏 input；disabled 拖放与点击全静默；clickable=false 不出 input 点击', async () => {
    const onClick = vi.fn()
    const wrapper = mount(FcDropZone, { props: { onClick } })
    const input = wrapper.find('input[type="file"]')
    expect(input.exists()).toBe(true)
    const clickSpy = vi.fn()
    Object.defineProperty(input.element, 'click', { value: clickSpy, configurable: true })
    await wrapper.find('.fc-drop-zone').trigger('click')
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('click')).toHaveLength(1)

    const off = mount(FcDropZone, { props: { disabled: true, onClick } })
    drag(off, 'drop', dt({ files: [mkFile('a.png', 1)] }))
    await off.vm.$nextTick()
    expect(off.emitted('drop')).toBeUndefined()
    await off.find('.fc-drop-zone').trigger('click')
    expect(off.emitted('click')).toBeUndefined()

    // clickable=false：input 仍渲染（模板恒有），但根点击不触发 input.click
    const noclick = mount(FcDropZone, { props: { clickable: false } })
    const ncInput = noclick.find('input[type="file"]')
    const ncSpy = vi.fn()
    Object.defineProperty(ncInput.element, 'click', { value: ncSpy, configurable: true })
    await noclick.find('.fc-drop-zone').trigger('click')
    expect(ncSpy).not.toHaveBeenCalled()
  })

  it('input change：选中文件走校验链', async () => {
    const wrapper = mount(FcDropZone, { props: { accept: 'image/*' } })
    const input = wrapper.find('input[type="file"]').element as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [mkFile('sel.png', 5)],
      configurable: true,
    })
    await wrapper.find('input[type="file"]').trigger('change')
    await wrapper.vm.$nextTick()
    expect((wrapper.emitted('drop')![0]![0] as File[])[0]!.name).toBe('sel.png')
  })
})
