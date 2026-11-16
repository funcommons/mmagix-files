/**
 * mindPanel.ts——脑图属性面板 DOM 工厂（MC3b）
 * 契约正本：.claude/mind-loop-state.md「MC3b 契约（锁定）」节
 * （测试=可执行规格：src/apps/renderers/__tests__/mindPanel.test.ts 17 例）
 *
 * 纯 DOM 工厂零引擎 import：createMindPanel({ el, t, onEdit, onClose? })
 *   → { el, setNode(decos), clear(), dispose() }
 *  - 面板根 div.mmagic-mind-panel，create 即挂入宿主 el（absolute 浮层，同工具栏叠加形态）；
 *    样式 scoped 归 mindEditor 注入的 .mmagic-mind 容器域（本文件零 <style> 注入，全 token 化）
 *  - 可见性：is-open 在场=显示（节点激活）、缺席=隐藏；初始隐藏（无激活缺省）
 *  - 五字段控件 data-field 钉位：note=textarea、image/hyperlink/tags/generalization=input；
 *    关闭钮 button[data-act='close']
 *  - i18n 恰六键 app.mind-panel.{note,image,hyperlink,tags,generalization,close} 经 t
 *    （无标题栏文本键；close 键=按钮文案与 aria-label 共用）
 *
 * 行为契约（对齐 mindPanel.test.ts 钉面）：
 *  - setNode(decos)：clear-then-edit——先全清后回填，未提及字段不残留上一节点值；
 *    tags（string[]）→逗号串；generalization（{text} 信封，与 nodeMeta/引擎 data 同形）→拆 .text；
 *    image 的 is-invalid 态随节点切换重置（新节点=新校验态，非法残留不带走）
 *  - 控件 change（冒泡）→ onEdit(单字段 patch)：空串/全空段→键在场值 undefined（清除语义）；
 *    tags 拆数组（trim+滤空）；image 过 isSafeImageUrl 闸——空串=清除非非法（守卫只拦非空非法），
 *    非空非法→is-invalid+onEdit 零调，改合法/清空即摘除
 *  - clear()：五字段全空 + is-open 移除（程序性，不触发 onEdit）；
 *    关闭钮→onClose?.()（可选缺省不抛）+clear()；dispose 摘监听+摘 DOM 幂等
 */
import { isSafeImageUrl } from '../mind/meta'

// ───────────────────────── 契约类型 ─────────────────────────

export interface MindPanelOpts {
  /** 宿主容器（面板根挂入其中，absolute 叠加形态） */
  el: HTMLElement
  /** i18n（恰六键 app.mind-panel.*） */
  t: (key: string) => string
  /** 字段编辑上抛（单字段 patch，值为 undefined=清除该装饰） */
  onEdit: (patch: Record<string, unknown>) => void
  /** 关闭钮回调（可选缺省不抛） */
  onClose?: () => void
}

export interface MindPanelApi {
  el: HTMLElement
  setNode(decos: Record<string, unknown>): void
  clear(): void
  dispose(): void
}

/** 字段钉位序（note=textarea 余为 input）；i18n 键后缀与 data-field 同名 */
const FIELDS = ['note', 'image', 'hyperlink', 'tags', 'generalization'] as const
type FieldName = (typeof FIELDS)[number]

const PANEL_I18N_PREFIX = 'app.mind-panel.'

// ───────────────────────── 工厂 ─────────────────────────

export function createMindPanel(opts: MindPanelOpts): MindPanelApi {
  const { el, t, onEdit, onClose } = opts

  const root = document.createElement('div')
  root.className = 'mmagic-mind-panel'
  const controls = new Map<FieldName, HTMLInputElement | HTMLTextAreaElement>()

  /** 字段行：label + 控件（flow-editor 属性面板同构形态） */
  function appendField(field: FieldName): void {
    const control =
      field === 'note' ? document.createElement('textarea') : document.createElement('input')
    control.setAttribute('data-field', field)
    if (field !== 'note') (control as HTMLInputElement).type = 'text'
    controls.set(field, control)
    const row = document.createElement('div')
    row.className = 'row'
    const label = document.createElement('label')
    label.textContent = t(`${PANEL_I18N_PREFIX}${field}`)
    row.append(label, control)
    root.appendChild(row)
  }

  for (const field of FIELDS) appendField(field)

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.setAttribute('data-act', 'close')
  closeBtn.textContent = t(`${PANEL_I18N_PREFIX}close`)
  closeBtn.setAttribute('aria-label', t(`${PANEL_I18N_PREFIX}close`))
  const foot = document.createElement('div')
  foot.className = 'row mmagic-mind-panel__foot'
  foot.appendChild(closeBtn)
  root.appendChild(foot)
  el.appendChild(root)

  // ── 编辑交互：change（冒泡）→ 单字段 patch ──
  function handleChange(ev: Event): void {
    const target = ev.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return
    const field = target.getAttribute('data-field')
    if (field === null || !FIELDS.includes(field as FieldName)) return
    const raw = target.value
    if (field === 'note') {
      onEdit({ note: raw === '' ? undefined : raw })
    } else if (field === 'hyperlink') {
      onEdit({ hyperlink: raw === '' ? undefined : raw })
    } else if (field === 'tags') {
      // 逗号拆数组（trim+滤空）；全空段=清除语义（键在场值 undefined，非空数组空串）
      const list = raw
        .split(',')
        .map((seg) => seg.trim())
        .filter((seg) => seg !== '')
      onEdit({ tags: list.length === 0 ? undefined : list })
    } else if (field === 'image') {
      if (raw === '') {
        // 清除语义：空串=清除非非法（守卫只拦非空非法值），顺带摘错误态
        target.classList.remove('is-invalid')
        onEdit({ image: undefined })
      } else if (isSafeImageUrl(raw)) {
        target.classList.remove('is-invalid')
        onEdit({ image: raw })
      } else {
        // 非空非法：is-invalid 错误态 + onEdit 零调（禁存）
        target.classList.add('is-invalid')
      }
    } else if (field === 'generalization') {
      // {text} 信封双端同形（setNode 拆 .text 显示、change 收 {text} 包装）
      onEdit({ generalization: raw === '' ? undefined : { text: raw } })
    }
  }

  // ── 关闭钮：onClose（可选）+ clear（关闭后隐藏） ──
  function handleClose(): void {
    onClose?.()
    clear()
  }

  root.addEventListener('change', handleChange)
  closeBtn.addEventListener('click', handleClose)

  // ── 回填 / 清除 / 销毁 ──
  function setNode(decos: Record<string, unknown>): void {
    const d = decos ?? {}
    const note = controls.get('note') as HTMLTextAreaElement
    note.value = typeof d.note === 'string' ? d.note : ''
    const image = controls.get('image') as HTMLInputElement
    image.value = typeof d.image === 'string' ? d.image : ''
    image.classList.remove('is-invalid') // 节点切换=校验态重置
    const hyperlink = controls.get('hyperlink') as HTMLInputElement
    hyperlink.value = typeof d.hyperlink === 'string' ? d.hyperlink : ''
    const tags = controls.get('tags') as HTMLInputElement
    tags.value = Array.isArray(d.tags) ? d.tags.map((s) => String(s)).join(',') : ''
    const gen = d.generalization
    const genText = gen !== null && typeof gen === 'object' ? (gen as { text?: unknown }).text : undefined
    const generalization = controls.get('generalization') as HTMLInputElement
    generalization.value = typeof genText === 'string' ? genText : ''
    root.classList.add('is-open')
  }

  function clear(): void {
    for (const control of controls.values()) control.value = ''
    ;(controls.get('image') as HTMLInputElement).classList.remove('is-invalid')
    root.classList.remove('is-open')
  }

  function dispose(): void {
    root.removeEventListener('change', handleChange)
    closeBtn.removeEventListener('click', handleClose)
    root.remove()
  }

  return { el: root, setNode, clear, dispose }
}
