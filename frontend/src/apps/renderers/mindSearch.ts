/**
 * mindSearch.ts——脑图搜索浮条 DOM 工厂（MC3c；独立文件=MC3c-T 裁决——并入 mindPanel 与
 * 面板桩 mock 面冲突，已否决）
 * 契约正本：.claude/mind-loop-state.md「MC3c 契约（锁定）」节
 * （surface 侧接线钉面：src/apps/renderers/__tests__/mindEditor.test.ts MC3c 追加块——
 *  opts={el,t,onSearch,onNext,onPrev,onClose} 函数形态 + api={el,open,close,setCount,dispose}）
 *
 * 纯 DOM 工厂零引擎 import：createMindSearch({ el, t, onSearch, onNext?, onPrev?, onClose? })
 *   → { el, open(), close(), setCount(cur,total), dispose() }
 *  - 根 div.mmagic-mind-search，create 即挂入宿主 el；样式 scoped 归 mindEditor 注入的
 *    .mmagic-mind 容器域（本文件零 <style> 注入）；初始隐藏，open 显示（is-open）
 *  - 控件：input（placeholder/aria=i18n）+ prev/next 钮（data-act）+ 计数区
 *  - 交互：input Enter=onSearch(输入值)（同值再 Enter=引擎原生 next 语义，surface 直通实现）、
 *    Shift+Enter 或 prev 钮=onPrev、next 钮=onNext、Esc=onClose+close（隐藏）
 *  - 计数 setCount(cur,total)：引擎 search_info_change 的 0 基 currentIndex 原样透传（surface 裁决
 *    不换算，显示格式归本域）；total>0 → 渲染 'cur/total'（count 键含 {cur}/{total} 占位时
 *    模板替换、否则直拼——t 无插值能力，占位/拼接双法等价）；total 0 → 空态（空文案）
 *  - i18n 四键 app.mind-search.{placeholder,next,prev,count}；dispose 摘监听+摘 DOM 幂等
 */
export interface MindSearchOpts {
  /** 宿主容器（浮条根挂入其中，absolute 叠加形态） */
  el: HTMLElement
  /** i18n（四键 app.mind-search.*） */
  t: (key: string) => string
  /** 搜索上抛（输入值原文；surface 防护直通引擎 mm.search.search(text)） */
  onSearch: (text: string) => void
  /** 「下一个」（引擎同文本 search=原生 next，Search.js:76-78 实测） */
  onNext?: () => void
  /** 「上一个」（Shift+Enter / prev 钮） */
  onPrev?: () => void
  /** 关闭上抛（Esc；surface 防护直通引擎 mm.search.endSearch()） */
  onClose?: () => void
}

export interface MindSearchApi {
  el: HTMLElement
  open(): void
  close(): void
  setCount(cur: number, total: number): void
  dispose(): void
}

const I18N_PREFIX = 'app.mind-search.'

export function createMindSearch(opts: MindSearchOpts): MindSearchApi {
  const { el, t, onSearch, onNext, onPrev, onClose } = opts

  const root = document.createElement('div')
  root.className = 'mmagic-mind-search'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = t(`${I18N_PREFIX}placeholder`)
  input.setAttribute('aria-label', t(`${I18N_PREFIX}placeholder`))

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.setAttribute('data-act', 'prev')
  prevBtn.textContent = t(`${I18N_PREFIX}prev`)
  prevBtn.setAttribute('aria-label', t(`${I18N_PREFIX}prev`))

  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.setAttribute('data-act', 'next')
  nextBtn.textContent = t(`${I18N_PREFIX}next`)
  nextBtn.setAttribute('aria-label', t(`${I18N_PREFIX}next`))

  const countEl = document.createElement('span')
  countEl.className = 'mmagic-mind-search__count'
  countEl.setAttribute('aria-live', 'polite')

  root.append(input, prevBtn, nextBtn, countEl)

  /** 计数文案：count 键含 {cur}/{total} 占位 → 模板替换；否则直拼 `${cur}/${total}`
   *  （t 为纯 (k)=>string 无插值能力——占位/拼接双法按 t 能力自适应，显示值同形） */
  function formatCount(cur: number, total: number): string {
    const tpl = t(`${I18N_PREFIX}count`)
    if (tpl.includes('{cur}') && tpl.includes('{total}')) {
      return tpl.replace('{cur}', String(cur)).replace('{total}', String(total))
    }
    return `${cur}/${total}`
  }

  function handleInputKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      onClose?.()
      close()
      return
    }
    if (ev.key !== 'Enter') return
    ev.preventDefault()
    if (ev.shiftKey) onPrev?.()
    else onSearch(input.value)
  }
  /** 焦点在钮上时的 Esc 兜底（input 已处理过的冒泡事件因 is-open 已摘不再二次上抛） */
  function handleRootKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape' || !root.classList.contains('is-open')) return
    onClose?.()
    close()
  }
  function handlePrev(): void {
    onPrev?.()
  }
  function handleNext(): void {
    onNext?.()
  }

  input.addEventListener('keydown', handleInputKeydown)
  root.addEventListener('keydown', handleRootKeydown)
  prevBtn.addEventListener('click', handlePrev)
  nextBtn.addEventListener('click', handleNext)

  function open(): void {
    root.classList.add('is-open')
    input.focus()
  }

  function close(): void {
    root.classList.remove('is-open')
  }

  function setCount(cur: number, total: number): void {
    // total 0 = 无搜索结果态：空文案（计数区留白，不显示 0/x）
    countEl.textContent = total > 0 ? formatCount(cur, total) : ''
  }

  function dispose(): void {
    input.removeEventListener('keydown', handleInputKeydown)
    root.removeEventListener('keydown', handleRootKeydown)
    prevBtn.removeEventListener('click', handlePrev)
    nextBtn.removeEventListener('click', handleNext)
    root.remove() // remove 天然幂等（重复 dispose 不抛）
  }

  el.appendChild(root)
  return { el: root, open, close, setCount, dispose }
}
