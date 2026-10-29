/**
 * date.ts 单测：格式化四件套（绝对/绝对 i18n/相对 i18n/日期时间/时间）+ getDateRange 快捷范围。
 * 相对时间与范围依赖 Date.now —— fake timers 锚定系统时间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatAbsoluteDate,
  formatAbsoluteDateI18n,
  formatDateTime,
  formatRelativeDateI18n,
  formatTimeString,
  getDateRange,
} from '../date'

const t = vi.fn((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key,
)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 22, 10, 30, 0)) // 2026-10-22 10:30
  t.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatAbsoluteDate：YYYY-MM-DD / 无效回退', () => {
  it('合法输入取日期部分；空/无效返回 -', () => {
    expect(formatAbsoluteDate('2026-10-05T14:23:00Z')).toBe('2026-10-05')
    expect(formatAbsoluteDate('2026-01-02 08:00:00')).toBe('2026-01-02')
    expect(formatAbsoluteDate(null)).toBe('-')
    expect(formatAbsoluteDate(undefined)).toBe('-')
    expect(formatAbsoluteDate('')).toBe('-')
    expect(formatAbsoluteDate('not-a-date')).toBe('-')
  })
})

describe('formatAbsoluteDateI18n：t(key, {year, month, day}) 占位填充', () => {
  it('合法/空/无效三分支', () => {
    expect(formatAbsoluteDateI18n('2026-03-04T00:00:00Z', t, 'ux.date')).toBe(
      'ux.date:{"year":2026,"month":"03","day":"04"}',
    )
    expect(formatAbsoluteDateI18n(null, t, 'ux.date')).toBe('-')
    expect(formatAbsoluteDateI18n('bad', t, 'ux.date')).toBe('-')
  })
})

describe('formatRelativeDateI18n：just-now/minutes/hours/yesterday/week/回退绝对', () => {
  const iso = (minutesAgo: number): string =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString()

  it('<1 分钟 → just-now', () => {
    expect(formatRelativeDateI18n(iso(0.2), t, 'a')).toBe('a.just-now')
  })
  it('1-59 分钟 → minutes-ago {n}', () => {
    expect(formatRelativeDateI18n(iso(5), t, 'a')).toBe('a.minutes-ago:{"n":5}')
  })
  it('1-23 小时 → hours-ago {n}', () => {
    expect(formatRelativeDateI18n(iso(60 * 3), t, 'a')).toBe('a.hours-ago:{"n":3}')
  })
  it('昨天 → time-yesterday；2-6 天 → days+time-week', () => {
    expect(formatRelativeDateI18n(iso(60 * 26), t, 'a')).toBe('a.time-yesterday')
    expect(formatRelativeDateI18n(iso(60 * 24 * 3), t, 'a')).toBe('3a.time-week')
  })
  it('≥7 天回退绝对日期（不走 i18n）', () => {
    expect(formatRelativeDateI18n(iso(60 * 24 * 8), t, 'a')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('formatDateTime / formatTimeString', () => {
  it('日期时间带分钟；HH:mm 补零', () => {
    expect(formatDateTime('2026-10-22T08:05:00')).toBe('2026-10-22 08:05')
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime('bad')).toBe('-')
    expect(formatTimeString(new Date(2026, 9, 22, 9, 7).getTime())).toBe('09:07')
  })
})

describe('getDateRange：快捷范围', () => {
  it('last-7-days：今天-6 → 今天', () => {
    expect(getDateRange('last-7-days')).toEqual({ start: '2026-10-16', end: '2026-10-22' })
  })
  it('last-30-days：今天-29 → 今天', () => {
    expect(getDateRange('last-30-days')).toEqual({ start: '2026-09-23', end: '2026-10-22' })
  })
  it('last-month：上月 1 日 → 上月末日（跨月/跨年自动）', () => {
    expect(getDateRange('last-month')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
  })
  it('month-yyyy-mm：指定单月（含闰月天数 2 月）', () => {
    expect(getDateRange('month-2026-2')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(getDateRange('month-2024-2')).toEqual({ start: '2024-02-01', end: '2024-02-29' }) // 闰年
  })
  it('非法 month 格式 / 越界月份 / 未知 option → 抛错', () => {
    expect(() => getDateRange('month-junk')).toThrow(/invalid month/)
    expect(() => getDateRange('month-2026-13')).toThrow(/out of range/)
    expect(() => getDateRange('unknown' as 'last-7-days')).toThrow(/unknown option/)
  })
})
