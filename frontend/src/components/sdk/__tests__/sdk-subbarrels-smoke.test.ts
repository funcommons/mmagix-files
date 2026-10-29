/**
 * SDK 其余子目录 barrel 导入冒烟（theme/navigation/display/utils/form/data/section）。
 */
import { describe, expect, it } from 'vitest'
import * as theme from '../theme'
import * as navigation from '../navigation'
import * as display from '../display'
import * as utils from '../utils'
import * as form from '../form'

describe('SDK 子 barrel 导入冒烟', () => {
  it('五 barrel 导出非空', () => {
    for (const barrel of [theme, navigation, display, utils, form]) {
      expect(Object.keys(barrel).length).toBeGreaterThan(0)
    }
    expect(Object.keys(utils).some((k) => typeof (utils as Record<string, unknown>)[k] === 'function')).toBe(true)
  })
})
