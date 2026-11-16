/**
 * mindOutline.ts——脑图大纲视图 DOM 工厂（MC3c）
 * 契约正本：.claude/mind-loop-state.md「MC3c 契约（锁定）」节
 * （测试=可执行规格：src/apps/renderers/__tests__/mindOutline.test.ts createMindOutline 8 例）
 *
 * 纯 DOM 工厂零引擎 import：createMindOutline({ el, t, onLocate })
 *   → 恰五成员 { el, render(rows), show(), hide(), dispose() }
 *  - 根 div.mmagic-mind-outline，create 即挂入宿主 el（mindPanel 同形态）；样式 scoped 归
 *    mindEditor 注入的 .mmagic-mind 容器域（本文件零 <style> 注入，全 token 化）
 *  - 可见性：is-open 在场=显示、缺席=隐藏；初始隐藏
 *  - i18n 恰一键：app.mind-outline.label（根 aria-label 承载，mindOutline.test.ts 钉死）
 *  - 行 DOM：[data-key] + data-depth + 行内缩进 style（padding-left，depth0=0 严格递增——
 *    jsdom 不验算 class 样式，缩进机器面=行内 style）；行文本=textContent；行 click→onLocate(key)
 *  - render 替换式重渲染（replaceChildren，幂等不叠加）；dispose 摘 DOM（幂等，重复不抛）
 *
 * P1 首轮只读：大纲行点击只上抛 onLocate（定位），行内编辑=P2。
 */
import type { OutlineRow } from '../mind/outline'

export interface MindOutlineOpts {
  /** 宿主容器（大纲根挂入其中，absolute 叠加形态盖画布） */
  el: HTMLElement
  /** i18n（恰一键 app.mind-outline.label） */
  t: (key: string) => string
  /** 行点击上抛（key=OutlineRow.key=buildNodeKey 文本路径键） */
  onLocate: (key: string) => void
}

export interface MindOutlineApi {
  el: HTMLElement
  render(rows: OutlineRow[]): void
  show(): void
  hide(): void
  dispose(): void
}

/** 每层缩进步长 px（depth0=0，随 depth 线性递增） */
const INDENT_STEP_PX = 16

export function createMindOutline(opts: MindOutlineOpts): MindOutlineApi {
  const { el, t, onLocate } = opts

  const root = document.createElement('div')
  root.className = 'mmagic-mind-outline'
  root.setAttribute('aria-label', t('app.mind-outline.label'))

  /** 替换式重渲染：清空后按行序重建（幂等不叠加，无幽灵行） */
  function render(rows: OutlineRow[]): void {
    root.replaceChildren()
    for (const row of rows) {
      const rowEl = document.createElement('div')
      rowEl.className = 'row'
      rowEl.setAttribute('data-key', row.key)
      rowEl.setAttribute('data-depth', String(row.depth))
      // 缩进机器面=行内 style（jsdom 不验算 scoped class 样式）；depth0='0px'
      rowEl.style.paddingLeft = `${row.depth * INDENT_STEP_PX}px`
      rowEl.textContent = row.text
      rowEl.addEventListener('click', () => onLocate(row.key))
      root.appendChild(rowEl)
    }
  }

  function show(): void {
    root.classList.add('is-open')
  }

  function hide(): void {
    root.classList.remove('is-open')
  }

  function dispose(): void {
    root.remove() // 行监听随节点摘除被 GC；remove 天然幂等（重复 dispose 不抛）
  }

  el.appendChild(root)
  return { el: root, render, show, hide, dispose }
}
