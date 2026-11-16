/**
 * mind/decorations.ts 单测（装饰数据层：meta 通道 ↔ 引擎节点 data 六类装饰双向映射）
 * 契约正本：.claude/mind-loop-state.md「MC3 契约草案」MC3a 节（2026-11-10 锁定）
 *
 * 【测试先行】apps/mind/decorations.ts 由 MC3a-C 子代理实现——本文件初跑红=预期
 * （import '../decorations' 解析失败）。本文件为装饰层唯一测试所有者；
 * mindEditor.test.ts 与 e2e spec 归其它代理，不在此触及。
 *
 * 模块契约（两函数，纯函数零引擎 import）：
 *  - applyDecorations(tree, meta): EngineNode —— 不可变新树（不改入参）；从根 walking
 *    累积文本路径（每节点 key=buildNodeKey(祖先文本链)），把 nodeMeta[key] 注入 node.data：
 *    note→data.note；hyperlink→data.hyperlink+hyperlinkTitle；tags→data.tag(string[])；
 *    generalization→data.generalization（透传对象）；image→data.image（isSafeImageUrl 闸：
 *    非法丢 image 字段+console.warn）+data.imageTitle；outerFrame→data.outerFrame
 *    （透传，含 groupId）；meta 无对应键节点 data 零污染；非法值字段级丢弃+warn
 *    （对齐 MC0 P2-4 口径，非 string 的 note 等一律丢）。_assoc/schema/_mindview 不在
 *    处理范围（关联线 load 接线归 MC3b 装配面）——忽略不炸。
 *  - extractDecorations(tree): { nodeMeta: Record<string, Record<string, unknown>>,
 *    assoc: { lines: Array<{from,to,text?}> } } —— 编辑树反提：六类装饰字段
 *    （note/image/hyperlink/tag/generalization/outerFrame）→按 key 收进 nodeMeta
 *    （image 写回过 isSafeImageUrl）；data.associativeLineTargets（uid 数组）→解析
 *    uid→目标节点→lines.push({from: fromKey, to: toKey})；uid 不入 meta；
 *    无装饰→空对象+空 lines。
 *
 * 【解释口径（契约未钉处的测试侧裁量，实现侧需对齐或提裁决）】
 *  - 「apply(extract(apply(tree,meta)),meta) 再 extract == 首次 extract」按往返同一性实施：
 *    第二次 apply 喂 extract 所得 nodeMeta 重建的 MindMeta（字面上第二次重复喂同一 meta
 *    为恒真式，无断言力）
 *  - 非法 image 时 imageTitle 的去留、extract 对非法 image 记录是否残留 imageTitle——
 *    契约明示「丢或保留均可（对称实现）」→ 一律不钉
 *  - associativeLineText 提取路径契约明示 MC3a-C 实测 → 测试只钉 from/to 与无 text 缺省形态
 *  - apply 保留既有 data 字段（style/uid 等透传不丢）钉死：「注入 node.data」语义 +
 *    MC3b 关联线接线依赖 uid 在 apply 产物上存活
 *  - extract 多线行序不钉（walking 序为自然实现，但契约未锁）→ toContainEqual+长度；
 *    单线与无 text 缺省形态用 toEqual 钉死
 */
import { describe, expect, it, vi } from 'vitest'
import { parseMindmap } from '../../flow-model'
import { toEngineTree } from '../convert'
import type { EngineNode } from '../convert'
import { parseMindMeta } from '../meta'
import type { MindMeta } from '../meta'
import { applyDecorations, extractDecorations } from '../decorations'

// ───────────────────────── fixture（树形经 parseMindmap+toEngineTree 构建，防手写漂移） ─────────────────────────

/** 三级树：中心（circle 根）/ 预览 / 图片（叶）＋ 编辑 / 代码（叶）——文本链唯一 */
const FIXTURE = [
  'mindmap',
  '  root((中心))',
  '    预览',
  '      图片',
  '    编辑',
  '      代码',
].join('\n')

function buildTree(): EngineNode {
  return toEngineTree(parseMindmap(FIXTURE))
}

/** 按文本找引擎树节点（fixture 内文本唯一） */
function findByText(node: EngineNode, text: string): EngineNode | null {
  if (node.data.text === text) return node
  for (const c of node.children) {
    const hit = findByText(c, text)
    if (hit) return hit
  }
  return null
}

/** 手工 MindMeta（apply 单测用；schema/mindview/assoc 置空=不在本函数职责面） */
function metaOf(entries: Array<[string, Record<string, unknown>]>): MindMeta {
  return { schema: null, mindview: null, assoc: null, nodeMeta: new Map(entries) }
}

/** 按 walking 序给全树补 uid（关联线解析前提），返回 文本→uid 对照（fixture 文本唯一） */
function addWalkingUids(tree: EngineNode): Record<string, string> {
  const uidOf: Record<string, string> = {}
  let i = 0
  const walk = (n: EngineNode): void => {
    const uid = `u${++i}`
    n.data.uid = uid
    uidOf[n.data.text] = uid
    n.children.forEach(walk)
  }
  walk(tree)
  return uidOf
}

// ───────────────────────── applyDecorations（meta 通道 → 引擎 data 注入） ─────────────────────────

describe('applyDecorations（meta → data 注入）', () => {
  it('note 注入：string 备注进 data.note，同树无键节点不受影响', () => {
    const result = applyDecorations(buildTree(), metaOf([['中心/预览', { note: '预览的备注' }]]))
    expect(findByText(result, '预览')!.data.note).toBe('预览的备注')
    expect(findByText(result, '编辑')!.data.note).toBeUndefined()
  })

  it('image 合法注入：https URL 与相对路径均放行（isSafeImageUrl 正域）+imageTitle 进 data', () => {
    const result = applyDecorations(
      buildTree(),
      metaOf([
        ['中心/预览/图片', { image: 'https://example.com/a.png', imageTitle: '配图' }],
        ['中心/编辑', { image: 'assets/x.png' }],
      ]),
    )
    const img = findByText(result, '图片')!.data
    expect(img.image).toBe('https://example.com/a.png')
    expect(img.imageTitle).toBe('配图')
    expect(findByText(result, '编辑')!.data.image).toBe('assets/x.png')
  })

  it('image 非法 URL 丢字段+warn：javascript:/data: 协议相对 // 三形态均不进 data', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = applyDecorations(
      buildTree(),
      metaOf([
        ['中心/预览/图片', { image: 'javascript:alert(1)' }],
        ['中心/编辑/代码', { image: 'data:image/png;base64,AAAA' }],
        ['中心/编辑', { image: '//evil.com/x.png' }],
      ]),
    )
    expect(findByText(result, '图片')!.data.image).toBeUndefined()
    expect(findByText(result, '代码')!.data.image).toBeUndefined()
    expect(findByText(result, '编辑')!.data.image).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('hyperlink 注入：hyperlink+hyperlinkTitle 双键齐进 data', () => {
    const result = applyDecorations(
      buildTree(),
      metaOf([['中心/预览', { hyperlink: 'https://example.com/p', hyperlinkTitle: '预览链接' }]]),
    )
    const d = findByText(result, '预览')!.data
    expect(d.hyperlink).toBe('https://example.com/p')
    expect(d.hyperlinkTitle).toBe('预览链接')
  })

  it('tags 数组注入：meta.tags → data.tag（string[]）', () => {
    const result = applyDecorations(buildTree(), metaOf([['中心/编辑', { tags: ['重要', '待办'] }]]))
    expect(findByText(result, '编辑')!.data.tag).toEqual(['重要', '待办'])
  })

  it('generalization 注入：透传对象进 data.generalization', () => {
    const result = applyDecorations(buildTree(), metaOf([['中心', { generalization: { text: '中心概要' } }]]))
    expect(findByText(result, '中心')!.data.generalization).toEqual({ text: '中心概要' })
  })

  it('outerFrame 注入：透传（含 groupId）；同 groupId 双兄弟各自注入=外框共享形状', () => {
    const result = applyDecorations(
      buildTree(),
      metaOf([
        ['中心/预览', { outerFrame: { groupId: 'frame-1', stroke: '#333', fill: '#f5f5f5' } }],
        ['中心/编辑', { outerFrame: { groupId: 'frame-1', stroke: '#333', fill: '#f5f5f5' } }],
      ]),
    )
    expect(findByText(result, '预览')!.data.outerFrame).toEqual({ groupId: 'frame-1', stroke: '#333', fill: '#f5f5f5' })
    expect(findByText(result, '编辑')!.data.outerFrame).toEqual({ groupId: 'frame-1', stroke: '#333', fill: '#f5f5f5' })
  })

  it('多字段同节点齐注：八键（note/hyperlink 对/tags/image 对/generalization/outerFrame）一次全进', () => {
    const result = applyDecorations(
      buildTree(),
      metaOf([
        [
          '中心/编辑',
          {
            note: '备注',
            hyperlink: 'https://example.com',
            hyperlinkTitle: '链接',
            tags: ['甲'],
            image: 'https://example.com/i.png',
            imageTitle: '图题',
            generalization: { text: '概要' },
            outerFrame: { groupId: 'g9', fill: '#f0f0f0' },
          },
        ],
      ]),
    )
    const d = findByText(result, '编辑')!.data
    expect(d.note).toBe('备注')
    expect(d.hyperlink).toBe('https://example.com')
    expect(d.hyperlinkTitle).toBe('链接')
    expect(d.tag).toEqual(['甲'])
    expect(d.image).toBe('https://example.com/i.png')
    expect(d.imageTitle).toBe('图题')
    expect(d.generalization).toEqual({ text: '概要' })
    expect(d.outerFrame).toEqual({ groupId: 'g9', fill: '#f0f0f0' })
  })

  it('无 meta 键零污染：无对应键节点 data 原形（不增任何装饰字段）', () => {
    const result = applyDecorations(buildTree(), metaOf([['中心', { note: '仅根有注' }]]))
    expect(findByText(result, '图片')!.data).toEqual({ text: '图片' }) // bare 叶子 data 全等原形
    const d = findByText(result, '编辑')!.data
    for (const k of ['note', 'image', 'imageTitle', 'hyperlink', 'hyperlinkTitle', 'tag', 'generalization', 'outerFrame']) {
      expect(k in d).toBe(false)
    }
  })

  it('非法值字段级丢弃+warn：非 string note/tags 非数组丢字段，同记录合法字段不受牵连（P2-4 口径）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = applyDecorations(
      buildTree(),
      metaOf([['中心/预览', { note: 42, tags: '不是数组', hyperlink: 'https://example.com' }]]),
    )
    const d = findByText(result, '预览')!.data
    expect(d.note).toBeUndefined()
    expect(d.tag).toBeUndefined()
    expect(d.hyperlink).toBe('https://example.com') // 字段级粒度：非整记录丢弃
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('不可变：返回新树（节点引用不共享），入参树深等于调用前快照', () => {
    const tree = buildTree()
    const before = JSON.parse(JSON.stringify(tree)) as EngineNode
    const result = applyDecorations(
      tree,
      metaOf([
        ['中心/预览', { note: '注入' }],
        ['中心/编辑/代码', { tags: ['x'] }],
      ]),
    )
    expect(result).not.toBe(tree)
    expect(result.children[0]).not.toBe(tree.children[0])
    expect(result.children[0]!.children[0]).not.toBe(tree.children[0]!.children[0])
    expect(findByText(result, '预览')!.data.note).toBe('注入') // 注入真发生了（非空洞）
    expect(tree).toEqual(before) // 入参树毫发无伤
    expect(findByText(tree, '预览')!.data.note).toBeUndefined()
  })

  it('嵌套深层路径 key 正确：根/枝/叶三级各按祖先文本链命中，他枝不受影响', () => {
    const result = applyDecorations(
      buildTree(),
      metaOf([
        ['中心', { note: '根注' }],
        ['中心/预览', { note: '枝注' }],
        ['中心/预览/图片', { note: '叶注' }],
      ]),
    )
    expect(findByText(result, '中心')!.data.note).toBe('根注')
    expect(findByText(result, '预览')!.data.note).toBe('枝注')
    expect(findByText(result, '图片')!.data.note).toBe('叶注')
    expect(findByText(result, '编辑')!.data.note).toBeUndefined()
  })

  it('apply 保留既有 data 字段：style/uid 等既有键透传不丢（注入而非重建 data）', () => {
    const tree = buildTree()
    tree.data.uid = 'u-root'
    const result = applyDecorations(tree, metaOf([['中心', { note: 'n' }]]))
    const root = findByText(result, '中心')!
    expect(root.data.note).toBe('n')
    expect(root.data.style?.borderRadius).toBe('50%') // circle 根的视觉近似仍在
    expect(root.data.uid).toBe('u-root') // uid 存活（MC3b 关联线接线依赖）
  })

  it('parseMindMeta 联动：_assoc/schema/_mindview 不在处理范围——忽略不炸，节点装饰照常注入', () => {
    const meta = parseMindMeta(
      [
        '%% meta: schema=v1',
        '%% meta: _mindview {"layout":"logicalStructure","theme":"xm-green"}',
        '%% meta: _assoc {"lines":[{"from":"中心","to":"中心/预览","text":"相关"}]}',
        '%% meta: 中心 {"note":"根注"}',
      ].join('\n'),
    )
    expect(meta.assoc?.lines).toHaveLength(1) // 前置：parse 端确实收到 _assoc（非空洞）
    const result = applyDecorations(buildTree(), meta)
    expect(findByText(result, '中心')!.data.note).toBe('根注') // 节点装饰照常
    expect(findByText(result, '预览')!.data.associativeLineTargets).toBeUndefined() // 关联线接线归 MC3b 装配面
    expect(findByText(result, '预览')!.data.text).toBe('预览') // 树形原样不炸
  })
})

// ───────────────────────── extractDecorations（编辑树 → meta 反提 + 关联线解析） ─────────────────────────

describe('extractDecorations（data → meta 反提）', () => {
  it('六类字段反提回 meta 记录：键=文本路径、data.tag→meta.tags 名映射、记录恰为装饰字段', () => {
    const tree: EngineNode = {
      data: { text: '中心', note: '根备注', outerFrame: { groupId: 'frame-1', stroke: '#333' } },
      children: [
        {
          data: { text: '预览', hyperlink: 'https://example.com/p', hyperlinkTitle: '预览链接' },
          children: [{ data: { text: '图片', image: 'https://example.com/img.png', imageTitle: '图片说明' }, children: [] }],
        },
        {
          data: { text: '编辑', tag: ['甲', '乙'] },
          children: [{ data: { text: '代码', generalization: { text: '代码概要' } }, children: [] }],
        },
      ],
    }
    const ex = extractDecorations(tree)
    expect(ex.nodeMeta).toEqual({
      中心: { note: '根备注', outerFrame: { groupId: 'frame-1', stroke: '#333' } },
      '中心/预览': { hyperlink: 'https://example.com/p', hyperlinkTitle: '预览链接' },
      '中心/预览/图片': { image: 'https://example.com/img.png', imageTitle: '图片说明' },
      '中心/编辑': { tags: ['甲', '乙'] },
      '中心/编辑/代码': { generalization: { text: '代码概要' } },
    })
    expect(ex.assoc.lines).toEqual([])
  })

  it('image 写回过 isSafeImageUrl 闸：非法 URL 不回写记录，同节点合法字段不受牵连', () => {
    const tree: EngineNode = {
      data: { text: '中心' },
      children: [{ data: { text: '图片', note: '有备注', image: 'javascript:alert(1)' }, children: [] }],
    }
    const ex = extractDecorations(tree)
    expect(ex.nodeMeta['中心/图片']).toEqual({ note: '有备注' })
  })

  it('associativeLineTargets 单线解析：uid→目标节点→from/to 文本路径键；无 text 缺省形态；from 节点不入 nodeMeta', () => {
    const tree = buildTree()
    const uidOf = addWalkingUids(tree)
    findByText(tree, '预览')!.data.associativeLineTargets = [uidOf['图片']!]
    const ex = extractDecorations(tree)
    expect(ex.assoc.lines).toEqual([{ from: '中心/预览', to: '中心/预览/图片' }])
    expect(ex.nodeMeta['中心/预览']).toBeUndefined() // uid/targets 不属装饰记录
    expect(ex.nodeMeta).toEqual({}) // 全树无装饰 → nodeMeta 空
  })

  it('多线解析：同 from 双 target + 跨 from 各成一线（3 线；行序不钉）', () => {
    const tree = buildTree()
    const uidOf = addWalkingUids(tree)
    findByText(tree, '预览')!.data.associativeLineTargets = [uidOf['图片']!, uidOf['代码']!]
    findByText(tree, '代码')!.data.associativeLineTargets = [uidOf['中心']!]
    const lines = extractDecorations(tree).assoc.lines
    expect(lines).toHaveLength(3)
    expect(lines).toContainEqual({ from: '中心/预览', to: '中心/预览/图片' })
    expect(lines).toContainEqual({ from: '中心/预览', to: '中心/编辑/代码' })
    expect(lines).toContainEqual({ from: '中心/编辑/代码', to: '中心' })
  })

  it('uid 不入 meta：装饰记录恰为装饰字段（无 uid 键）；纯 targets 节点（无装饰）不入 nodeMeta', () => {
    const tree: EngineNode = {
      data: { text: '中心', uid: 'u-root', note: '根注' },
      children: [{ data: { text: '预览', uid: 'u-2', associativeLineTargets: ['u-root'] }, children: [] }],
    }
    const ex = extractDecorations(tree)
    expect(ex.nodeMeta['中心']).toEqual({ note: '根注' })
    expect(ex.nodeMeta['中心/预览']).toBeUndefined()
    expect(ex.assoc.lines).toEqual([{ from: '中心/预览', to: '中心' }])
  })

  it('无装饰空返回：干净树 → nodeMeta 空对象 + lines 空数组', () => {
    const ex = extractDecorations(buildTree())
    expect(ex.nodeMeta).toEqual({})
    expect(ex.assoc).toEqual({ lines: [] })
  })

  it('apply↔extract 往返同一性：apply→extract→重建 meta→再 apply→再 extract 与首次 extract 全等（非空洞护栏）', () => {
    const tree = buildTree()
    const meta = metaOf([
      ['中心', { note: '根备注', generalization: { text: '概要' } }],
      ['中心/预览', { hyperlink: 'https://example.com/p', hyperlinkTitle: '链接', outerFrame: { groupId: 'g1' } }],
      ['中心/预览/图片', { image: 'https://example.com/i.png', imageTitle: '图题' }],
      ['中心/编辑', { tags: ['甲', '乙'] }],
    ])
    const applied1 = applyDecorations(tree, meta)
    const ex1 = extractDecorations(applied1)
    // 非空洞护栏：首次 extract 确实收到全部 4 键与字段（防止两侧同空洞的假绿）
    expect(Object.keys(ex1.nodeMeta)).toHaveLength(4)
    expect(ex1.nodeMeta['中心/编辑']).toEqual({ tags: ['甲', '乙'] })
    // 往返：extract 所得 nodeMeta 重建 MindMeta 再 apply 到同一棵原树
    const meta2: MindMeta = {
      schema: null,
      mindview: null,
      assoc: null,
      nodeMeta: new Map(Object.entries(ex1.nodeMeta)),
    }
    const applied2 = applyDecorations(tree, meta2)
    const ex2 = extractDecorations(applied2)
    expect(ex2.nodeMeta).toEqual(ex1.nodeMeta)
    expect(ex2.assoc).toEqual(ex1.assoc)
  })
})
