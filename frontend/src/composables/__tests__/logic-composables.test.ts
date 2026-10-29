/**
 * 逻辑 composables 单测：useUndoStack（快照撤销栈）/ parseExcelPaste（TSV 粘贴解析）/
 * useFormDraft（草稿防抖持久化+TTL+版本）/ useFocusTrap（焦点圈禁+Esc）/ useDirtyForm（脏表单注册）。
 * 注：useFormDraft/useFocusTrap/useDirtyForm 的 onBeforeUnmount 在组件外调用仅告警不生效——
 * 被测面是 watch/键盘/注册表行为本身。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'

import { useUndoStack } from '../useUndoStack'
import { parseExcelPaste } from '../useExcelPaste'
import { useFormDraft } from '../useFormDraft'
import { useFocusTrap } from '../useFocusTrap'
import { useDirtyForm } from '../useDirtyForm'
import { dirtyFormRegistry } from '@/router'

/** 内存 Storage 桩（window+globalThis 同源覆写） */
function installMemStorage(name: 'localStorage' | 'sessionStorage'): void {
  const mem = new Map<string, string>()
  const fake = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() {
      return mem.size
    },
  }
  Object.defineProperty(window, name, { value: fake, configurable: true })
  Object.defineProperty(globalThis, name, { value: fake, configurable: true })
}

beforeEach(() => {
  installMemStorage('localStorage')
  installMemStorage('sessionStorage')
})

// ───────────────────────── useUndoStack ─────────────────────────

describe('useUndoStack：快照撤销/重做', () => {
  it('commit=存档点：undo 回到最近存档、redo 重做；canUndo/canRedo 流转', () => {
    const items = ref<string[]>([])
    const stack = useUndoStack(items)
    expect(stack.canUndo.value).toBe(false)

    stack.commit() // 存档空态
    expect(stack.canUndo.value).toBe(true)
    items.value = ['a'] // 修改
    stack.undo()
    expect(items.value).toEqual([]) // 回到存档
    expect(stack.canRedo.value).toBe(true)
    stack.redo()
    expect(items.value).toEqual(['a'])
    expect(stack.canRedo.value).toBe(false)

    stack.commit() // 存档 ['a']
    items.value = ['a', 'b']
    stack.undo()
    expect(items.value).toEqual(['a'])
    stack.clear()
    expect(stack.canUndo.value).toBe(false)
    stack.undo() // 空栈静默
    stack.redo()
    expect(items.value).toEqual(['a']) // clear 后 redo 不可用，源保持
  })

  it('快照是深拷贝（存档后改源不影响栈内）；max 截断最旧', () => {
    const items = ref<{ tags: string[] }[]>([{ tags: ['x'] }])
    const stack = useUndoStack(items, { max: 2 })
    stack.commit() // 存档 [x]
    items.value[0]!.tags.push('y')
    stack.commit() // 存档 [x,y]
    items.value[0]!.tags.push('z') // 改源 → 栈内快照不受污染
    stack.undo() // 回最近存档 [x,y]
    expect(items.value[0]!.tags).toEqual(['x', 'y'])

    // max=2：栈里还有 [[x],[x,y]] 的历史；再存两档 → [x] 被挤出
    stack.commit() // 存 [x,y]（当前）
    items.value[0]!.tags.push('w')
    stack.commit() // 存 [x,y,w] → 栈满 2：[[x,y],[x,y,w]]，[x] 出栈
    items.value[0]!.tags.length = 0
    stack.undo()
    expect(items.value[0]!.tags).toEqual(['x', 'y', 'w']) // 回最近存档
    stack.undo()
    expect(items.value[0]!.tags).toEqual(['x', 'y']) // 再退一层（[x] 已被截断不可达）
  })
})

// ───────────────────────── parseExcelPaste ─────────────────────────

describe('parseExcelPaste：TSV/CSV 粘贴解析', () => {
  const FIELDS = ['name', 'desc', 'price'] as const

  it('tab 分隔多行解析 + 单元格 trim', () => {
    const r = parseExcelPaste('a\tb\t1\nc\td\t2', FIELDS)
    expect(r.errors).toEqual([])
    expect(r.data).toEqual([
      { name: 'a', desc: 'b', price: '1' },
      { name: 'c', desc: 'd', price: '2' },
    ])
  })

  it('逗号分隔、\\r\\n 行分隔、空行跳过', () => {
    const r = parseExcelPaste('x,y,1\r\n\r\nz,w,2\n', FIELDS, { delimiters: [','] })
    expect(r.data).toEqual([
      { name: 'x', desc: 'y', price: '1' },
      { name: 'z', desc: 'w', price: '2' },
    ])
  })

  it('hasHeader 跳过首行；列数不足记 error 不产数据', () => {
    const r = parseExcelPaste('姓名\t描述\t价格\na\tb', FIELDS, { hasHeader: true })
    expect(r.data).toEqual([])
    expect(r.errors).toEqual([{ row: 2, message: '列数不足, 期望 3 列, 实际 2 列' }])
  })

  it('空粘贴 → row 0 错误；超列截断到 fields 数', () => {
    expect(parseExcelPaste('  ', FIELDS).errors).toEqual([{ row: 0, message: '粘贴内容为空' }])
    const r = parseExcelPaste('a\tb\t1\textra\tmore', FIELDS)
    expect(r.data).toEqual([{ name: 'a', desc: 'b', price: '1' }]) // 多余列忽略
  })
})

// ───────────────────────── useFormDraft ─────────────────────────

describe('useFormDraft：草稿自动保存与恢复', () => {
  it('修改→防抖写入→hasDraft；restore 回填；discard 清除', async () => {
    vi.useFakeTimers()
    try {
      const form = reactive<{ name: string }>({ name: '' })
      const draft = useFormDraft(form, 'probe:draft', { debounceMs: 100 })
      expect(draft.hasDraft.value).toBe(false)

      form.name = ' drafted '
      await nextTick() // watch 触发
      vi.advanceTimersByTime(100) // 防抖到点 → write
      // hasDraft 只在初始化时判定（写入不翻转）——断言落库与 savedAt
      expect(window.localStorage.getItem('ux:draft:probe:draft')).toContain('drafted')
      expect(draft.savedAt.value).toBeGreaterThan(0)

      // 新实例 hydrate：hasDraft 初读即 true，restore 回填
      const form2 = reactive<{ name: string }>({ name: '' })
      const draft2 = useFormDraft(form2, 'probe:draft', { debounceMs: 100 })
      expect(draft2.hasDraft.value).toBe(true)
      expect(draft2.restore()).toBe(true)
      expect(form2.name).toBe(' drafted ')

      draft2.discard()
      expect(draft2.hasDraft.value).toBe(false)
      expect(draft2.savedAt.value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('TTL 过期草稿：初始化即清、hasDraft false、restore false', async () => {
    vi.useFakeTimers()
    try {
      const form = reactive<{ name: string }>({ name: '' })
      const draft = useFormDraft(form, 'probe:ttl', { debounceMs: 0, ttlMs: 1000 })
      form.name = 'stale'
      await nextTick()
      vi.advanceTimersByTime(10)
      vi.advanceTimersByTime(2000) // 越过 TTL
      expect(draft.restore()).toBe(false)
      expect(form.name).toBe('stale') // restore 失败不动 form

      // 新实例：过期草稿被顺手清掉
      useFormDraft(reactive<{ name: string }>({ name: '' }), 'probe:ttl', { debounceMs: 0, ttlMs: 1000 })
      expect(window.localStorage.getItem('ux:draft:probe:ttl')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush 主动写入；version 变更旧草稿失效', async () => {
    const form = reactive<{ name: string }>({ name: '' })
    const draft = useFormDraft(form, 'probe:ver', { version: 2, debounceMs: 10_000 })
    form.name = 'v2'
    await nextTick()
    draft.flush() // 跳过防抖立即写（hasDraft 不随写入翻转——仅初始化判定）
    expect(window.localStorage.getItem('ux:draft:probe:ver')).toContain('"version":2')
    expect(draft.savedAt.value).toBeGreaterThan(0)

    const stale = useFormDraft(reactive<{ name: string }>({ name: '' }), 'probe:ver', { version: 3 })
    expect(stale.hasDraft.value).toBe(false) // 版本不符 → 失效
  })
})

// ───────────────────────── useFocusTrap ─────────────────────────

describe('useFocusTrap：焦点圈禁', () => {
  /** 构建容器：两个 button（jsdom offsetParent 恒 null——打桩可聚焦） */
  function makeRoot(): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML = '<button id="f1">1</button><button id="f2">2</button>'
    document.body.appendChild(root)
    for (const el of root.querySelectorAll('button')) {
      Object.defineProperty(el, 'offsetParent', { get: () => root, configurable: true })
    }
    return root
  }

  it('激活：autofocus 首个可聚焦（rAF 帧内）；Tab 在首尾循环；Esc 回调', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { cb(0); return 0 })
    try {
      const rootRef = ref<HTMLElement | null>(makeRoot())
      const open = ref(false)
      let escaped = 0
      useFocusTrap(rootRef, open, { onEscape: () => { escaped += 1 } })

      const active = document.createElement('button')
      document.body.appendChild(active)
      active.focus()

      open.value = true
      await nextTick()
      expect(document.activeElement?.id).toBe('f1') // autoFocus 首元素

      const trapKey = (key: string, init: Partial<KeyboardEventInit> = {}): boolean =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init }))

      // Tab 循环：尾→首；Shift+Tab 首→尾（preventDefault → dispatchEvent 返回 false）
      ;(document.querySelector('#f2') as HTMLButtonElement).focus()
      expect(trapKey('Tab')).toBe(false) // 循环接管并 preventDefault
      expect(document.activeElement?.id).toBe('f1')
      ;(document.querySelector('#f1') as HTMLButtonElement).focus()
      expect(trapKey('Tab', { shiftKey: true })).toBe(false)
      expect(document.activeElement?.id).toBe('f2')

      expect(trapKey('Escape')).toBe(false)
      expect(escaped).toBe(1)
      expect(trapKey('x')).toBe(true) // 非功能键不拦
      rootRef.value!.remove()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('关闭/无容器/无可聚焦元素：静默不抛', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { cb(0); return 0 })
    try {
      const rootRef = ref<HTMLElement | null>(null)
      const open = ref(false)
      useFocusTrap(rootRef, open)
      open.value = true
      await nextTick()
      open.value = false
      await nextTick()

      const empty = ref<HTMLElement | null>(document.createElement('div'))
      const open2 = ref(false)
      useFocusTrap(empty, open2)
      open2.value = true // watch 无 immediate：翻转才注册监听
      await nextTick()
      // 无可聚焦元素：Tab 被 preventDefault 兜住（防焦点逃出）
      expect(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ───────────────────────── useDirtyForm ─────────────────────────

describe('useDirtyForm：脏表单跟踪与注册表联动', () => {
  it('改动→isDirty；markClean/markDirty/reset 全链；注册进全局 registry', async () => {
    const form = reactive<{ name: string }>({ name: 'init' })
    const dirty = useDirtyForm(form, () => ({ name: 'init' }))
    await nextTick()
    expect(dirty.isDirty.value).toBe(false)
    expect(dirtyFormRegistry.findDirty()).toBeNull()

    form.name = 'changed'
    await nextTick()
    expect(dirty.isDirty.value).toBe(true)
    expect(dirtyFormRegistry.findDirty()?.isDirty()).toBe(true) // 全局兜底可见

    dirty.markClean()
    expect(dirty.isDirty.value).toBe(false)
    dirty.markDirty()
    expect(dirty.isDirty.value).toBe(true)

    dirty.reset() // 回 pristine 工厂值 + 复位
    expect(form.name).toBe('init')
    expect(dirty.isDirty.value).toBe(false)
    expect(dirtyFormRegistry.findDirty()).toBeNull()
  })
})
