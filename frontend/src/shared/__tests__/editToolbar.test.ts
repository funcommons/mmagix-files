/**
 * 统一编辑工具栏单测：图标钮簇 DOM 契约（save/undo/redo/reset 顺序、data-act/aria 定位口径）、
 * 回调接线、状态机（busy/dirty/history/readonly）、dispose 收口。
 * 消费方=内置应用（code/flow 渲染器）+ 可编辑插件（构建期内联），视觉统一红线：本模块是唯一样式源。
 */
import { describe, expect, it, vi } from 'vitest'
import { createEditToolbar } from '../editToolbar'

const LABELS = { save: 'S', undo: 'U', redo: 'R', reset: 'X' }

function make() {
  const cb = { onSave: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), onReset: vi.fn() }
  const tb = createEditToolbar(LABELS, cb)
  const el = tb.el
  document.body.appendChild(el)
  return { tb, el, cb }
}

function btns(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('[data-act]')]
}
function btn(el: HTMLElement, act: string): HTMLButtonElement {
  const b = el.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)
  if (!b) throw new Error(`missing button ${act}`)
  return b
}

describe('createEditToolbar：DOM 契约', () => {
  it('四钮顺序 save/undo/redo/reset，data-act + title/aria-label=labels，图标为内联 SVG（零字体依赖）', () => {
    const { el } = make()
    expect(btns(el).map((b) => b.dataset.act)).toEqual(['save', 'undo', 'redo', 'reset'])
    for (const b of btns(el)) {
      const act = b.dataset.act as keyof typeof LABELS
      expect(b.title).toBe(LABELS[act])
      expect(b.getAttribute('aria-label')).toBe(LABELS[act])
      expect(b.querySelector('svg')).not.toBeNull()
    }
  })

  it('回调接线：click → 对应回调；dispose 后 listener 随 DOM 移除失效', () => {
    const { tb, el, cb } = make()
    btn(el, 'save').click()
    btn(el, 'undo').click()
    btn(el, 'redo').click()
    tb.setDirty(true) // 干净态重置禁用（初始态契约）：对禁用钮探测接线无效，先置脏解锁
    btn(el, 'reset').click()
    expect(cb.onSave).toHaveBeenCalledTimes(1)
    expect(cb.onUndo).toHaveBeenCalledTimes(1)
    expect(cb.onRedo).toHaveBeenCalledTimes(1)
    expect(cb.onReset).toHaveBeenCalledTimes(1)
    tb.dispose()
    expect(el.childElementCount).toBe(0)
    btns(el).forEach((b) => b.click())
    expect(cb.onSave).toHaveBeenCalledTimes(1)
  })
})

describe('createEditToolbar：状态机', () => {
  it('初始：保存可用、无红点、重置禁用（干净态无可重置）、撤回/重做可用（未调 setHistory 视为恒可用）', () => {
    const { el } = make()
    expect(btn(el, 'save').disabled).toBe(false)
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(false)
    expect(btn(el, 'reset').disabled).toBe(true)
    expect(btn(el, 'undo').disabled).toBe(false)
    expect(btn(el, 'redo').disabled).toBe(false)
  })

  it('setDirty：true → 保存钮红点（is-dirty）+ 重置钮可用；false → 双复位', () => {
    const { tb, el } = make()
    tb.setDirty(true)
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(true)
    expect(btn(el, 'reset').disabled).toBe(false)
    tb.setDirty(false)
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(false)
    expect(btn(el, 'reset').disabled).toBe(true)
  })

  it('setBusy：true → 保存钮禁用（防重入）且 dirty 红点保持；false → 恢复', () => {
    const { tb, el } = make()
    tb.setDirty(true)
    tb.setBusy(true)
    expect(btn(el, 'save').disabled).toBe(true)
    expect(btn(el, 'save').classList.contains('is-dirty')).toBe(true)
    tb.setBusy(false)
    expect(btn(el, 'save').disabled).toBe(false)
  })

  it('setHistory：(false,true) → 撤回禁用重做可用；(true,false) 反之', () => {
    const { tb, el } = make()
    tb.setHistory(false, true)
    expect(btn(el, 'undo').disabled).toBe(true)
    expect(btn(el, 'redo').disabled).toBe(false)
    tb.setHistory(true, false)
    expect(btn(el, 'undo').disabled).toBe(false)
    expect(btn(el, 'redo').disabled).toBe(true)
  })

  it('setReadonly：true → 整簇 is-readonly（CSS 隐藏 data-edit 钮）；false → 恢复', () => {
    const { tb, el } = make()
    tb.setReadonly(true)
    expect(el.className).toContain('is-readonly')
    for (const b of btns(el)) expect(b.dataset.edit).toBe('true')
    tb.setReadonly(false)
    expect(el.className).not.toContain('is-readonly')
  })
})
