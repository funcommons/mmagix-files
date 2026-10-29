/**
 * config 单测：features 功能开关 / oem 配置缺省面。
 */
import { describe, expect, it } from 'vitest'
import { FEATURES, isFeatureEnabled } from '../features'
import { OEM_CONFIG } from '../oem'

describe('features：功能开关', () => {
  it('isFeatureEnabled 直读注册表；两 flag 均布尔', () => {
    expect(isFeatureEnabled('dev')).toBe(FEATURES.dev)
    expect(isFeatureEnabled('imageToolbar')).toBe(FEATURES.imageToolbar)
    expect(typeof FEATURES.dev).toBe('boolean')
    expect(typeof FEATURES.imageToolbar).toBe('boolean')
  })
})

describe('oem：内置配置缺省面', () => {
  it('OEM_CONFIG 结构完整（title 为字符串、色值可缺省）', () => {
    expect(typeof OEM_CONFIG.title).toBe('string')
    expect(OEM_CONFIG).toBeTruthy()
  })
})
