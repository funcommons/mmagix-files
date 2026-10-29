/**
 * SDK 子目录 barrel 导入冒烟：re-export 行执行即覆盖（防 barrel 断链无人发现）。
 */
import { describe, expect, it } from 'vitest'
import * as feedback from '../feedback'
import * as section from '../section'
import * as data from '../data'

describe('SDK barrel 导入冒烟', () => {
  it('feedback/section/data 三 barrel 导出非空', () => {
    expect(Object.keys(feedback).length).toBeGreaterThan(0) // FcToast/toast/FcHelpTip
    expect(Object.keys(section).length).toBeGreaterThan(0)
    expect(Object.keys(data).length).toBeGreaterThan(0)
    expect(typeof feedback.toast).toBe('object')
  })
})
