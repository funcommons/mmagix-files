/**
 * mind/meta.ts 单测（脑图 meta 注释通道：解析 / 身份键 / 块重建 / 图片 URL 安全闸）
 * 契约正本：.claude/mind-loop-state.md MC0 契约节 + docs/design/mind-editor-redesign/plan.md §四
 * 纪律（沿用 flow-editor-design.md §三，零新造）：META_RE 行匹配、非法 JSON 忽略不抛、
 * 单行 JSON 护栏（8KB 超限拒收）、图片只收 URL 不收 base64（data: 禁入）
 *
 * 【测试先行】apps/mind/meta.ts 由 MC0-C 子代理实现——本文件初跑红=预期。
 * 【MC0-T-fix】MC0-V 评审轮 1 修复裁决钉值（转义域扩展/保留键隔离/payload 字段校验/
 *  META_RE 单一来源）见文件尾四个 describe——新用例对修复前实现预期红，唯一例外
 *  「保留键 parse 面」按裁决「parse 侧零改动」钉当前行为（回归护栏）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_META_LINE_BYTES,
  buildNodeKey,
  isSafeImageUrl,
  parseMindMeta,
  writeMetaBlock,
} from '../meta'
import type { MindMeta } from '../meta'

/** plan.md §四 全通道综合样例（schema/_mindview/_assoc/节点行 混排正文） */
const PLAN_SRC = [
  'mindmap',
  '%% meta: schema=v1',
  '%% meta: _mindview {"layout":"fishbone","theme":"xm-green"}',
  '%% meta: _assoc {"lines":[{"from":"研发排期/联调测试","to":"发布推广/数据复盘","text":"阻塞"}]}',
  '  新品发布计划',
  '    研发排期',
  '      联调测试',
  '%% meta: 新品发布计划/联调测试 {"note":"每周五封版"}',
  '    发布推广',
].join('\n')

describe('parseMindMeta', () => {
  it('无 meta 行 / 空文本 → 全空缺省（schema/mindview/assoc=null，nodeMeta 空 Map）', () => {
    for (const src of ['', 'mindmap', 'mindmap\n  root((MM))\n    子']) {
      const m = parseMindMeta(src)
      expect(m.schema).toBeNull()
      expect(m.mindview).toBeNull()
      expect(m.assoc).toBeNull()
      expect(m.nodeMeta).toBeInstanceOf(Map)
      expect(m.nodeMeta.size).toBe(0)
    }
  })

  it('schema 行解析：schema=v1 → 字符串 v1；正文中间出现同样识别', () => {
    expect(parseMindMeta('%% meta: schema=v1').schema).toBe('v1')
    expect(parseMindMeta('mindmap\n  %% meta: schema=v2\n  root').schema).toBe('v2')
  })

  it('_mindview 解析：layout+theme 全量，其余通道不受污染', () => {
    const m = parseMindMeta('%% meta: _mindview {"layout":"fishbone","theme":"xm-green"}')
    expect(m.mindview).toEqual({ layout: 'fishbone', theme: 'xm-green' })
    expect(m.schema).toBeNull()
    expect(m.nodeMeta.size).toBe(0)
  })

  it('_mindview 部分字段 / 空对象：缺的键不虚造', () => {
    expect(parseMindMeta('%% meta: _mindview {"layout":"mindMap"}').mindview).toEqual({ layout: 'mindMap' })
    expect(parseMindMeta('%% meta: _mindview {}').mindview).toEqual({})
  })

  it('_assoc 解析：lines 数组（text 可缺省）', () => {
    const m = parseMindMeta(
      '%% meta: _assoc {"lines":[{"from":"研发排期/联调测试","to":"发布推广/数据复盘","text":"阻塞"},{"from":"x","to":"y"}]}',
    )
    expect(m.assoc).toEqual({
      lines: [
        { from: '研发排期/联调测试', to: '发布推广/数据复盘', text: '阻塞' },
        { from: 'x', to: 'y' },
      ],
    })
  })

  it('节点行入 nodeMeta：多 key 各自成条，其余通道不受污染', () => {
    const m = parseMindMeta(
      [
        '%% meta: 新品发布计划 {"note":"根"}',
        '%% meta: 研发排期/联调测试 {"note":"每周五封版","tags":["P0"]}',
      ].join('\n'),
    )
    expect(m.nodeMeta.size).toBe(2)
    expect(m.nodeMeta.get('新品发布计划')).toEqual({ note: '根' })
    expect(m.nodeMeta.get('研发排期/联调测试')).toEqual({ note: '每周五封版', tags: ['P0'] })
    expect(m.schema).toBeNull()
    expect(m.mindview).toBeNull()
    expect(m.assoc).toBeNull()
  })

  it('节点行无 JSON 体：按空对象 {} 收编（META_RE body 可选口径，同 flow-model）', () => {
    expect(parseMindMeta('%% meta: 裸键').nodeMeta.get('裸键')).toEqual({})
  })

  it('非法 JSON 行忽略不抛：该行丢弃，其余行不受影响', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = parseMindMeta(
      [
        '%% meta: bad {oops',
        '%% meta: _mindview {bad',
        '%% meta: _assoc {"lines":',
        '%% meta: ok {"a":1}',
      ].join('\n'),
    )
    expect(m.nodeMeta.size).toBe(1)
    expect(m.nodeMeta.get('ok')).toEqual({ a: 1 })
    expect(m.mindview).toBeNull()
    expect(m.assoc).toBeNull()
    warn.mockRestore()
  })

  it('META_RE 行匹配语义对齐 flow-model：行首缩进 / %% 与 meta: 间多空格 / body 前空白', () => {
    expect(parseMindMeta('  %%  meta:   key  {"a":1}').nodeMeta.get('key')).toEqual({ a: 1 })
  })

  it('综合：plan §四 样例全通道一次解析，正文行不进任何通道', () => {
    const m = parseMindMeta(PLAN_SRC)
    expect(m.schema).toBe('v1')
    expect(m.mindview).toEqual({ layout: 'fishbone', theme: 'xm-green' })
    expect(m.assoc?.lines).toHaveLength(1)
    expect(m.assoc?.lines[0]).toEqual({ from: '研发排期/联调测试', to: '发布推广/数据复盘', text: '阻塞' })
    expect(m.nodeMeta.size).toBe(1)
    expect(m.nodeMeta.get('新品发布计划/联调测试')).toEqual({ note: '每周五封版' })
  })
})

describe('buildNodeKey（身份键=文本+路径）', () => {
  it('普通路径：各段以 / join', () => {
    expect(buildNodeKey(['新品发布计划', '研发排期', '联调测试'])).toBe('新品发布计划/研发排期/联调测试')
    expect(buildNodeKey(['root'])).toBe('root')
  })

  it('段内 / 转义为 \\/：与多段路径可区分（身份键无歧义）', () => {
    expect(buildNodeKey(['a/b', 'c'])).toBe('a\\/b/c')
    expect(buildNodeKey(['a', 'b', 'c'])).toBe('a/b/c')
    expect(buildNodeKey(['a/b', 'c'])).not.toBe(buildNodeKey(['a', 'b', 'c']))
  })

  it('边界：空数组=空键；单段含 / 照常转义', () => {
    expect(buildNodeKey([])).toBe('')
    expect(buildNodeKey(['含/斜杠'])).toBe('含\\/斜杠')
  })
})

describe('writeMetaBlock', () => {
  /** 全通道 meta fixture */
  const FULL: MindMeta = {
    schema: 'v1',
    mindview: { layout: 'fishbone', theme: 'xm-green' },
    assoc: { lines: [{ from: '研发排期/联调测试', to: '发布推广/数据复盘', text: '阻塞' }] },
    nodeMeta: new Map([
      ['新品发布计划', { note: '根节点备注' }],
      ['研发排期/联调测试', { note: '每周五封版', tags: ['P0'] }],
    ]),
  }

  it('顺序：schema → _mindview → _assoc → 节点行（节点行按 Map 插入序）；全单行 JSON', () => {
    const lines = writeMetaBlock(FULL)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('%% meta: schema=v1')
    expect(lines[1]!.startsWith('%% meta: _mindview ')).toBe(true)
    expect(JSON.parse(lines[1]!.slice('%% meta: _mindview '.length))).toEqual({ layout: 'fishbone', theme: 'xm-green' })
    expect(lines[2]!.startsWith('%% meta: _assoc ')).toBe(true)
    expect(JSON.parse(lines[2]!.slice('%% meta: _assoc '.length))).toEqual(FULL.assoc)
    expect(lines[3]).toBe(`%% meta: 新品发布计划 ${JSON.stringify({ note: '根节点备注' })}`)
    expect(lines[4]).toBe(`%% meta: 研发排期/联调测试 ${JSON.stringify({ note: '每周五封版', tags: ['P0'] })}`)
    for (const l of lines) expect(l.includes('\n')).toBe(false)
  })

  it('单行性：note 含真实换行时 JSON 转义为字面 \\n 序列，源行不破', () => {
    const meta: MindMeta = {
      schema: null,
      mindview: null,
      assoc: null,
      nodeMeta: new Map([['k', { note: '第一行\n第二行' }]]),
    }
    const lines = writeMetaBlock(meta)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.includes('\n')).toBe(false)
    expect(lines[0]).toContain('第一行\\n第二行')
  })

  it('空缺省字段不出行：全空 → []；部分字段 → 只出对应行', () => {
    expect(writeMetaBlock({ schema: null, mindview: null, assoc: null, nodeMeta: new Map() })).toEqual([])
    const partial = writeMetaBlock({ schema: null, mindview: { layout: 'mindMap' }, assoc: null, nodeMeta: new Map() })
    expect(partial).toHaveLength(1)
    expect(partial[0]).toContain('_mindview')
    expect(partial[0]).not.toContain('schema=')
  })

  it('往返等价：write → parse 还原同一 MindMeta（含 nodeMeta 键序）', () => {
    const text = writeMetaBlock(FULL).join('\n')
    expect(parseMindMeta(text)).toEqual(FULL)
    expect([...parseMindMeta(text).nodeMeta.keys()]).toEqual([...FULL.nodeMeta.keys()])
  })

  it('单行护栏：任一行 UTF-8 字节 > 8192 抛 RangeError（ASCII 与 CJK 字节陷阱各一）；临界内不抛', () => {
    const mk = (note: string): MindMeta => ({
      schema: null,
      mindview: null,
      assoc: null,
      nodeMeta: new Map([['k', { note }]]),
    })
    expect(() => writeMetaBlock(mk('x'.repeat(9000)))).toThrow(RangeError)
    // CJK 每字 3 字节：3000 字=9000 字节——按字符数计会漏放行，按字节数计必拦
    expect(() => writeMetaBlock(mk('中'.repeat(3000)))).toThrow(RangeError)
    expect(() => writeMetaBlock(mk('x'.repeat(8100)))).not.toThrow()
  })
})

describe('isSafeImageUrl（图片只收 URL，不收 base64/脚本）', () => {
  it('正例：http(s) 绝对地址与相对路径', () => {
    expect(isSafeImageUrl('https://example.com/a.png')).toBe(true)
    expect(isSafeImageUrl('http://example.com/a.png')).toBe(true)
    expect(isSafeImageUrl('img/a.png')).toBe(true)
    expect(isSafeImageUrl('./img/a.png')).toBe(true)
    expect(isSafeImageUrl('a.png')).toBe(true)
    expect(isSafeImageUrl('图片.png')).toBe(true)
  })

  it('负例：data:/blob:/javascript:/协议相对 // 与其它协议一律拒绝', () => {
    expect(isSafeImageUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isSafeImageUrl('blob:https://example.com/uuid')).toBe(false)
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeImageUrl('//evil.com/a.png')).toBe(false)
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('MAX_META_LINE_BYTES', () => {
  it('单行护栏常量 = 8192（8KB）', () => {
    expect(MAX_META_LINE_BYTES).toBe(8192)
  })
})

// ───────────────────────── MC0-T-fix（MC0-V 评审轮 1 修复裁决钉值，测试先行预期红） ─────────────────────────

describe('buildNodeKey 转义域（MC0-V P1-1：键空白安全 + 双射，方案 a 转义域扩展）', () => {
  it('P1-1 空格段 → \\s 两字符转义：键无裸空格（\\S+ 可整键回收）', () => {
    const k = buildNodeKey(['Q3 Plan'])
    expect(k).toBe('Q3\\sPlan')
    expect(k).not.toContain(' ')
    expect(k).toMatch(/^\S+$/)
    expect(buildNodeKey(['a b', 'c d'])).toBe('a\\sb/c\\sd')
  })

  it('P1-1 Tab/换行/CR 段各自转义 \\t / \\n / \\r', () => {
    expect(buildNodeKey(['a\tb'])).toBe('a\\tb')
    expect(buildNodeKey(['a\nb'])).toBe('a\\nb')
    expect(buildNodeKey(['a\rb'])).toBe('a\\rb')
    // 转义后均无裸空白：META_RE 的 \S+ 天然收编整键（parse 侧零改动的根据）
    for (const k of [buildNodeKey(['a\tb']), buildNodeKey(['a\nb']), buildNodeKey(['a\rb'])]) {
      expect(k).toMatch(/^\S+$/)
    }
  })

  it('P1-1 双射性：文本字面 \\s（反斜杠+s）→ \\\\s，与空格转义产物 \\s 可区分', () => {
    const literal = buildNodeKey(['a\\sb']) // 原文= a、\、s、b（反斜杠备份转义在前）
    const spaced = buildNodeKey(['a b']) // 原文= a、空格、b——空格转义产物恰为 `\s` 两字符
    expect(literal).toBe('a\\\\sb') // 备份转义在前：字面反斜杠 → 双反斜杠
    expect(spaced).toBe('a\\sb')
    expect(literal).not.toBe(spaced) // 双射：两种原文映射不同键（无备份转义则此处撞键）
  })

  it('P1-1 往返：含空白键 writeMetaBlock → parseMindMeta 逐字段还原（write 行无裸空白，META_RE 可完整回收）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const meta: MindMeta = {
      schema: 'v1',
      mindview: { layout: 'fishbone' },
      assoc: null,
      nodeMeta: new Map([
        [buildNodeKey(['Q3 Plan']), { note: '有空格' }],
        [buildNodeKey(['a\tb']), { note: '有Tab' }],
        [buildNodeKey(['a\nb']), { note: '有换行' }],
      ]),
    }
    const lines = writeMetaBlock(meta)
    for (const [key] of meta.nodeMeta) {
      const line = lines.find((l) => l.startsWith(`%% meta: ${key} `))
      expect(line).toBeDefined()
      // '%%' / 'meta:' / 转义键 / JSON 体 恰四段：键内不得有裸空白（裸空白会截断 \S+ 键捕获）
      expect(line!.split(' ')).toHaveLength(4)
      expect(line!.includes('\n')).toBe(false)
      expect(line!.includes('\t')).toBe(false)
    }
    expect(parseMindMeta(lines.join('\n'))).toEqual(meta)
    warn.mockRestore()
  })
})

describe('保留键隔离（MC0-V P1-1/P2-1：节点文本恰为保留名不被通道劫持）', () => {
  it('buildNodeKey 首段 _/schema 前缀 → 首字符前加 \\（\\_mindview / \\schema=v1）；非首段不隔离', () => {
    expect(buildNodeKey(['_mindview'])).toBe('\\_mindview')
    expect(buildNodeKey(['_mindview']).startsWith('\\')).toBe(true)
    expect(buildNodeKey(['schema=v1'])).toBe('\\schema=v1')
    // 隔离只看首段：后续段的保留名前缀是普通路径文本（路径身份键语义不动）
    expect(buildNodeKey(['root', '_mindview'])).toBe('root/_mindview')
    expect(buildNodeKey(['root', 'schema=v1'])).toBe('root/schema=v1')
  })

  it('parse 面：\\_mindview / \\schema=v1 行收进 nodeMeta，不进 mindview/schema 通道（裁决「parse 侧零改动」，钉回归）', () => {
    const m = parseMindMeta(
      ['%% meta: \\_mindview {"note":"节点备注"}', '%% meta: \\schema=v1 {"note":"另一个节点"}'].join('\n'),
    )
    expect(m.mindview).toBeNull()
    expect(m.schema).toBeNull()
    expect(m.nodeMeta.get('\\_mindview')).toEqual({ note: '节点备注' })
    expect(m.nodeMeta.get('\\schema=v1')).toEqual({ note: '另一个节点' })
    expect(m.nodeMeta.size).toBe(2)
  })

  it('往返：文本恰为 _mindview 的节点身份键 write→parse 原样回环（不被通道劫持）', () => {
    const key = buildNodeKey(['_mindview'])
    const meta: MindMeta = { schema: null, mindview: null, assoc: null, nodeMeta: new Map([[key, { note: 'x' }]]) }
    const text = writeMetaBlock(meta).join('\n')
    const m = parseMindMeta(text)
    expect(m.mindview).toBeNull()
    expect(m.nodeMeta.get(key)).toEqual({ note: 'x' })
    expect(parseMindMeta(text)).toEqual(meta)
  })
})

describe('payload 字段校验（MC0-V P2-4：非法字段/元素丢弃 + 告警，不抛）', () => {
  it('mindview.layout 非 string → 该字段被丢（合法 theme 保留，字段级粒度）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = parseMindMeta('%% meta: _mindview {"layout":123}')
    expect(m.mindview?.layout).toBeUndefined() // 「丢字段」口径：mindview 整体缺席或 layout 键缺席均合规
    const mixed = parseMindMeta('%% meta: _mindview {"layout":123,"theme":"xm-green"}')
    expect(mixed.mindview?.layout).toBeUndefined()
    expect(mixed.mindview?.theme).toBe('xm-green')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('assoc.lines 元素校验：非 {from:string,to:string,text?:string} 形态丢该元素，合法元素保留', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = parseMindMeta('%% meta: _assoc {"lines":[{"from":"a"},{"from":"x","to":"y"}]}')
    expect(m.assoc).toEqual({ lines: [{ from: 'x', to: 'y' }] })
    // from/to 非 string 同属形态非法；text 缺省可、string 可
    const m2 = parseMindMeta('%% meta: _assoc {"lines":[{"from":1,"to":"y"},{"from":"p","to":"q","text":"t"}]}')
    expect(m2.assoc).toEqual({ lines: [{ from: 'p', to: 'q', text: 't' }] })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('schema 值校验：非法值 → schema=null（不抛，按非法行口径告警）——META_RE \\S+ 捕获恒为 string，\n  「非 string」分支为类型防御钉；可观测非法面=空值 `schema=`（无版本语义同非法，MC0-F 落地口径）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseMindMeta('%% meta: schema=').schema).toBeNull()
    expect(parseMindMeta('%% meta: schema=v1').schema).toBe('v1') // 合法值不受校验影响
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('META_RE 单一正则来源（MC0-V P2-3：禁字面双处维护）', () => {
  it('meta.ts import flow-model 的 META_RE（import 面断言），flow-model 侧 export 在场', async () => {
    // jsdom 环境下 import.meta.url 非 file: scheme → 以 vitest 工作目录（frontend/）为锚
    const metaSrc = readFileSync('src/apps/mind/meta.ts', 'utf8')
    // meta.ts 与 flow-model.ts 同目录树兄弟（apps/mind → apps/），相对路径为 ../flow-model
    expect(metaSrc).toMatch(/import\s*\{[^}]*\bMETA_RE\b[^}]*\}\s*from\s*['"]\.\.\/flow-model['"]/)
    // 本文件不得再自带 META_RE 字面重抄（单一来源）
    expect(metaSrc).not.toMatch(/const META_RE\b/)
    const fm = (await import('../../flow-model')) as unknown as Record<string, unknown>
    expect(fm.META_RE).toBeInstanceOf(RegExp)
  })
})
