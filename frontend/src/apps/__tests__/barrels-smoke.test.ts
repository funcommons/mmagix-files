/**
 * barrel 导入冒烟：renderers / store 两入口 re-export 行执行即覆盖（防断链无人发现）。
 */
import { describe, expect, it } from 'vitest'
import * as renderers from '../renderers'
import * as store from '../../store'

describe('renderers / store barrel 导入冒烟', () => {
  it('两 barrel 导出非空（renderer 注册表 + files store 入口）', () => {
    expect(Object.keys(renderers).length).toBeGreaterThan(0)
    expect(Object.keys(store).length).toBeGreaterThan(0)
  })
})
