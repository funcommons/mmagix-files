/**
 * features.ts 单测（Wave1-A8）：功能开关门控
 * 被测：src/sdk/features.ts——FEATURE_DEFAULTS / resolveFeatures / requireFeature
 * 契约：《docs/operations/user-guide.md》V1.0 §一 features 全集与命令映射；
 * 语义：default 全开，config.features 显式 false 优先，未知键保留（只增不删）；
 * 执法：UI 隐藏 + API 拒绝（SdkError 4301 FEATURE_DISABLED）双层
 */
import { describe, expect, it } from 'vitest'
import { FEATURE_DEFAULTS, pluginsEnabled, requireFeature, resolveFeatures } from '../features'
import { ERROR_CODES, SdkError } from '../errorCodes'

/** 手册 §一 features 全集键名 */
const ALL_KEYS = ['upload', 'delete', 'rename', 'mkdir', 'download', 'multiTab', 'openWithMenu', 'plugins'] as const

/** 取同步函数抛出的错误（不抛则测试失败） */
function catchSync(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e: unknown) {
    return e
  }
  throw new Error('应抛出异常，却正常返回')
}

// ───────────────────────── FEATURE_DEFAULTS ─────────────────────────

describe('FEATURE_DEFAULTS', () => {
  it('全集 8 键齐备（键集合一致）', () => {
    expect(Object.keys(FEATURE_DEFAULTS).sort()).toEqual([...ALL_KEYS].sort())
  })

  it('全集键全为 true（default 全开）', () => {
    for (const key of ALL_KEYS) {
      expect(FEATURE_DEFAULTS[key]).toBe(true)
    }
  })
})

// ───────────────────────── resolveFeatures ─────────────────────────

describe('resolveFeatures：合并', () => {
  it('config 缺省 → 全默认 true', () => {
    expect(resolveFeatures()).toEqual(FEATURE_DEFAULTS)
    for (const key of ALL_KEYS) {
      expect(resolveFeatures()[key]).toBe(true)
    }
  })

  it('config 显式 undefined → 全默认', () => {
    expect(resolveFeatures(undefined)).toEqual(FEATURE_DEFAULTS)
  })

  it('config 空对象 → 全默认', () => {
    expect(resolveFeatures({})).toEqual(FEATURE_DEFAULTS)
  })

  it('显式 false 优先：{delete:false} → 仅 delete=false，其余默认 true', () => {
    expect(resolveFeatures({ delete: false })).toEqual({ ...FEATURE_DEFAULTS, delete: false })
    expect(resolveFeatures({ delete: false }).delete).toBe(false)
    expect(resolveFeatures({ delete: false }).upload).toBe(true)
  })

  it('显式 true 与默认一致，合并后仍为 true', () => {
    expect(resolveFeatures({ upload: true })).toEqual(FEATURE_DEFAULTS)
  })

  it('多键同时覆盖互不串扰', () => {
    expect(resolveFeatures({ upload: false, multiTab: false, plugins: false })).toEqual({
      ...FEATURE_DEFAULTS,
      upload: false,
      multiTab: false,
      plugins: false,
    })
  })
})

describe('resolveFeatures：未知键（只增不删纪律）', () => {
  it('未知键原样保留，默认键不受影响', () => {
    const resolved = resolveFeatures({ customFlag: true, anotherOff: false })
    expect(resolved.customFlag).toBe(true)
    expect(resolved.anotherOff).toBe(false)
    expect(resolved).toEqual({ ...FEATURE_DEFAULTS, customFlag: true, anotherOff: false })
    expect(Object.keys(resolved).sort()).toEqual([...ALL_KEYS, 'anotherOff', 'customFlag'].sort())
  })
})

describe('resolveFeatures：纯函数性', () => {
  it('返回新对象：不与 FEATURE_DEFAULTS / 入参共享引用', () => {
    const config = { delete: false }
    const resolved = resolveFeatures(config)
    expect(resolved).not.toBe(FEATURE_DEFAULTS)
    expect(resolved).not.toBe(config)
  })

  it('不污染入参与默认表', () => {
    const config = { rename: false }
    resolveFeatures(config)
    expect(config).toEqual({ rename: false })
    expect(FEATURE_DEFAULTS.rename).toBe(true)
  })
})

// ───────────────────────── requireFeature ─────────────────────────

describe('requireFeature', () => {  it('键为 true → 不抛', () => {
    expect(() => requireFeature(FEATURE_DEFAULTS, 'upload')).not.toThrow()
  })

  it('键缺省（undefined）→ 不抛（未显式关闭=放行）', () => {
    expect(() => requireFeature({}, 'upload')).not.toThrow()
  })

  it('键为 false → 抛 SdkError 且 code=FEATURE_DISABLED(4301)', () => {
    const err = catchSync(() => requireFeature({ upload: false }, 'upload'))
    expect(err).toBeInstanceOf(SdkError)
    const sdkErr = err as SdkError
    expect(sdkErr.code).toBe(ERROR_CODES.FEATURE_DISABLED)
    expect(sdkErr.code).toBe(4301)
  })

  it('message 含 features.<key>（键名可定位）', () => {
    const err = catchSync(() => requireFeature({ multiTab: false }, 'multiTab')) as SdkError
    expect(err.message).toContain('features.multiTab')
  })

  it('全集键逐一门控：false 即拒、true 即放行', () => {
    for (const key of ALL_KEYS) {
      const off = catchSync(() => requireFeature({ [key]: false }, key))
      expect(off).toBeInstanceOf(SdkError)
      expect((off as SdkError).code).toBe(4301)
      expect((off as SdkError).message).toContain(`features.${key}`)
      expect(() => requireFeature({ [key]: true }, key)).not.toThrow()
    }
  })
})

// ───────────────────────── pluginsEnabled（features.plugins 总闸，动态插件方案 §一） ─────────────────────────

describe('pluginsEnabled', () => {
  it('缺省 / undefined / 空对象 → true（default 全开）', () => {
    expect(pluginsEnabled()).toBe(true)
    expect(pluginsEnabled(undefined)).toBe(true)
    expect(pluginsEnabled({})).toBe(true)
  })

  it('显式 true → true；显式 false → false（唯一关闭路径）', () => {
    expect(pluginsEnabled({ plugins: true })).toBe(true)
    expect(pluginsEnabled({ plugins: false })).toBe(false)
  })

  it('只看 plugins 键：其他键关闭不影响总闸', () => {
    expect(pluginsEnabled({ upload: false, delete: false, plugins: true })).toBe(true)
    expect(pluginsEnabled({ upload: true, plugins: false })).toBe(false)
  })

  it('未知键保留语义：未知键不影响判定', () => {
    expect(pluginsEnabled({ customFlag: false })).toBe(true)
  })

  it('纯函数：不污染入参', () => {
    const config = { plugins: false }
    expect(pluginsEnabled(config)).toBe(false)
    expect(config).toEqual({ plugins: false })
  })
})
