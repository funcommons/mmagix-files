/**
 * 统一编辑工具栏（内置应用 + 可编辑插件共用源码；宿主编译入 bundle，插件构建期内联各自的拷贝）
 *
 * 用户口径（一百四十三番）：
 *  - 所有可编辑应用左上角统一 [保存｜撤销 重做 重置] 图标钮簇
 *  - dirty 状态一律=保存钮右上角小红点，废除「未保存」文字徽标
 *  - 各应用样式统一：本模块是唯一样式源（ghost 图标钮 + token 取色 + 内联 SVG 零字体依赖，
 *    宿主/插件/任意宿主页面渲染一致）
 *
 * 契约：
 *  - 按钮 data-act=save|undo|redo|reset（单测/E2E 定位口径）；title/aria-label 同文案
 *  - setDirty：保存钮红点（is-dirty）+ 重置钮可用性联动（干净态无重置意义）
 *  - setBusy：保存钮禁用防重入（红点保持——在途修改并未消失）
 *  - setHistory(canUndo, canRedo)：历史可用性（无历史跟踪能力的应用不调=恒可用）
 *  - setReadonly：整簇 is-readonly（CSS 隐藏 data-edit 钮；对齐 code-editor editOnly 语义）
 *  - dispose：DOM 全量移除（listener 随节点丢弃，无需逐个解绑）
 *
 * 图标：Material Symbols 路径数据（Apache 2.0），24 viewBox fill=currentColor——
 * 与宿主 remixicon 视觉同族；插件包内无字体/CSS 依赖。
 */

/** 图标路径数据（导出仅供单测断言非空；勿在模块外拼接用户数据） */
export const EDIT_TOOLBAR_ICONS = {
  save: 'M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z',
  undo: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
  redo: 'M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.06-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z',
  reset: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
} as const

/** 钮簇样式（每实例一份 <style> 随 el 生命周期；取色全 token+兜底，禁硬编码主题色） */
const EDIT_TOOLBAR_CSS = `
.mmx-edt { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.mmx-edt__btn { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; background: var(--app-bg-card, #fff); border-radius: var(--app-radius-button, 6px); color: var(--app-text-secondary, #57606a); cursor: pointer; font-size: 0; line-height: 1; transition: background 0.15s, color 0.15s, border-color 0.15s; }
.mmx-edt__btn:hover:not(:disabled) { background: var(--app-bg-muted, #eaeef2); color: var(--app-text-primary, #1f2328); border-color: var(--app-separator, rgba(127, 127, 127, 0.25)); }
.mmx-edt__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mmx-edt__btn svg { width: 16px; height: 16px; fill: currentColor; display: block; }
.mmx-edt__btn[data-act='save'].is-dirty { color: var(--app-text-primary, #1f2328); }
.mmx-edt__btn[data-act='save'].is-dirty::after { content: ''; position: absolute; top: 1px; right: 1px; width: 6px; height: 6px; border-radius: 50%; background: var(--app-color-danger, var(--el-color-danger, #ff3b30)); }
.mmx-edt.is-readonly [data-edit] { display: none; }
`

export interface EditToolbarLabels {
  save: string
  undo: string
  redo: string
  reset: string
}

export interface EditToolbarCallbacks {
  onSave: () => void
  onUndo?: () => void
  onRedo?: () => void
  onReset?: () => void
}

export interface EditToolbarHandle {
  /** 钮簇根节点（调用方 append 到自己的工具栏左端） */
  el: HTMLElement
  /** 保存中防重入：保存钮禁用（dirty 红点保持） */
  setBusy(busy: boolean): void
  /** dirty 翻转：保存钮红点 + 重置钮可用性（干净态禁用重置） */
  setDirty(dirty: boolean): void
  /** 撤销/重做可用性（历史栈空则禁用；无跟踪能力的应用不必调） */
  setHistory(canUndo: boolean, canRedo: boolean): void
  /** 只读：整簇隐藏（editOnly 语义，对齐 code-editor 契约 R5-4） */
  setReadonly(readonly: boolean): void
  dispose(): void
}

/**
 * 构建统一编辑钮簇。labels 由调用方经各自词典解析（宿主 app.edt-* 键 / 插件同名键），
 * 本模块不做 i18n——键值解析权在消费方，词典缺失时 t() 回退键名即可见可修。
 */
export function createEditToolbar(labels: EditToolbarLabels, callbacks: EditToolbarCallbacks): EditToolbarHandle {
  const el = document.createElement('div')
  el.className = 'mmx-edt'

  const style = document.createElement('style')
  style.textContent = EDIT_TOOLBAR_CSS
  el.appendChild(style)

  const ACTS = [
    { act: 'save', label: labels.save, icon: EDIT_TOOLBAR_ICONS.save, cb: callbacks.onSave },
    { act: 'undo', label: labels.undo, icon: EDIT_TOOLBAR_ICONS.undo, cb: callbacks.onUndo },
    { act: 'redo', label: labels.redo, icon: EDIT_TOOLBAR_ICONS.redo, cb: callbacks.onRedo },
    { act: 'reset', label: labels.reset, icon: EDIT_TOOLBAR_ICONS.reset, cb: callbacks.onReset },
  ] as const

  const btnMap = new Map<string, HTMLButtonElement>()
  for (const { act, label, icon, cb } of ACTS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'mmx-edt__btn'
    b.dataset.act = act
    b.dataset.edit = 'true'
    b.title = label
    b.setAttribute('aria-label', label)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', icon)
    svg.appendChild(path)
    b.appendChild(svg)
    b.addEventListener('click', () => cb?.())
    btnMap.set(act, b)
    el.appendChild(b)
  }

  const saveBtn = btnMap.get('save')!
  const undoBtn = btnMap.get('undo')!
  const redoBtn = btnMap.get('redo')!
  const resetBtn = btnMap.get('reset')!
  resetBtn.disabled = true // 初始干净态：无可重置（对齐 setDirty(false) 复位口径）

  let busy = false
  let dirty = false
  const syncSave = (): void => {
    saveBtn.disabled = busy
    saveBtn.classList.toggle('is-dirty', dirty)
  }

  return {
    el,
    setBusy(v) {
      busy = v
      syncSave()
    },
    setDirty(v) {
      dirty = v
      resetBtn.disabled = !v
      syncSave()
    },
    setHistory(canUndo, canRedo) {
      undoBtn.disabled = !canUndo
      redoBtn.disabled = !canRedo
    },
    setReadonly(ro) {
      el.classList.toggle('is-readonly', ro)
    },
    dispose() {
      el.replaceChildren()
    },
  }
}
