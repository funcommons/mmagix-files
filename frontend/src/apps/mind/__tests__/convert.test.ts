/**
 * mind/convert.ts 单测（FlowModel 树 ↔ 引擎树双向转换 + 身份键 best-effort 合并）
 * 契约正本：.claude/mind-loop-state.md MC0 契约节 + docs/design/mind-editor-redesign/plan.md §四/D4
 * 口径：
 *  - toEngineTree：形状→style 仅视觉近似（circle→borderRadius:'50%'、square→'0px'、
 *    rounded/缺省不写 borderRadius）；bare 纯文本=「无框叶子」口径 → 不写 borderRadius；
 *    数据保真靠 base 模型 shape 字段（回序列化用 base 形状 token，视觉近似不回写）
 *  - fromEngineTree：身份键（文本+路径）best-effort 对位——键全对复用 base 节点（装饰保留）；
 *    对不上按引擎树重建（文本取引擎、形状缺省、装饰丢失）；树结构以引擎树为准；
 *    返回新 FlowModel（不可变，不改 base）
 *
 * 【测试先行】apps/mind/convert.ts 由 MC0-C 子代理实现——本文件初跑红=预期。
 * fixture 全部经 parseMindmap 构建（避免手写 FlowModel 内部结构）。
 * 【MC0-T-fix】MC0-V 评审轮 1 修复裁决钉值：同名兄弟消费式对位（P1-2，废 last-wins）
 * 与 treeShape 环防御（P2-2，seen 截断口径对齐 serializeMindmap）见文件尾两个 describe
 * ——新用例对修复前实现预期红。
 */
import { describe, expect, it } from 'vitest'
import { parseMindmap, serializeMindmap } from '../../flow-model'
import { fromEngineTree, toEngineTree } from '../convert'
import type { EngineNode } from '../convert'

const FIXTURE = [
  'mindmap',
  '  root((MMagic-Files))', // circle + mmId 前缀（往返保真）
  '    预览', // bare 纯文本（无框叶子）
  '      图片',
  '      文档',
  '    编辑',
  '      id1[代码]', // square（rect 装饰）
  '      id3(圆角)', // rounded
  '    id2((发布))', // circle 叶子（供改文案降级用例）
].join('\n')

/** 按文本找引擎树节点（测试辅助；fixture 内文本唯一） */
function findByText(node: EngineNode, text: string): EngineNode | null {
  if (node.data.text === text) return node
  for (const c of node.children) {
    const hit = findByText(c, text)
    if (hit) return hit
  }
  return null
}

describe('toEngineTree（模型树 → 引擎树）', () => {
  it('文本与层级一一对应：根/两分支/孙辈顺序与深度全对', () => {
    const tree = toEngineTree(parseMindmap(FIXTURE))
    expect(tree.data.text).toBe('MMagic-Files')
    expect(tree.children.map((c) => c.data.text)).toEqual(['预览', '编辑', '发布'])
    expect(tree.children[0]!.children.map((c) => c.data.text)).toEqual(['图片', '文档'])
    expect(tree.children[1]!.children.map((c) => c.data.text)).toEqual(['代码', '圆角'])
    expect(tree.children[2]!.children).toHaveLength(0)
    const count = (n: EngineNode): number => 1 + n.children.reduce((s, c) => s + count(c), 0)
    expect(count(tree)).toBe(8)
  })

  it('形状三态近似：circle→50%、square→0px、rounded→不写 borderRadius', () => {
    const tree = toEngineTree(parseMindmap(FIXTURE))
    expect(tree.data.style?.borderRadius).toBe('50%') // root((…))
    expect(findByText(tree, '代码')!.data.style?.borderRadius).toBe('0px') // id1[…]
    expect(findByText(tree, '圆角')!.data.style?.borderRadius).toBeUndefined() // id3(…)
    expect(findByText(tree, '发布')!.data.style?.borderRadius).toBe('50%') // id2((…))
  })

  it('缺省态：bare 纯文本节点=无框叶子口径，不写 style.borderRadius', () => {
    const tree = toEngineTree(parseMindmap(FIXTURE))
    expect(findByText(tree, '预览')!.data.style?.borderRadius).toBeUndefined()
    expect(findByText(tree, '图片')!.data.style?.borderRadius).toBeUndefined()
  })

  it('空树边界（仅 header）：不抛，返回 children 空的占位根', () => {
    const tree = toEngineTree(parseMindmap('mindmap'))
    expect(tree.children).toHaveLength(0)
    expect(typeof tree.data.text).toBe('string')
  })

  it('单根边界：单根无子 → 引擎单节点；形状近似保持', () => {
    const tree = toEngineTree(parseMindmap('mindmap\n  root((MM))'))
    expect(tree.data.text).toBe('MM')
    expect(tree.children).toHaveLength(0)
    expect(tree.data.style?.borderRadius).toBe('50%')
  })
})

describe('fromEngineTree（编辑树合并回 base 模型）', () => {
  it('键全对往返零 diff：to→from→serialize 与未编辑基线逐字节一致（raw 优先语义）', () => {
    const base = parseMindmap(FIXTURE)
    const result = fromEngineTree(toEngineTree(base), base)
    expect(serializeMindmap(result)).toBe(FIXTURE)
  })

  it('不可变：返回新模型，base 模型毫发无伤', () => {
    const base = parseMindmap(FIXTURE)
    const result = fromEngineTree(toEngineTree(base), base)
    expect(result).not.toBe(base)
    expect(serializeMindmap(base)).toBe(FIXTURE)
    const root = [...base.nodes.values()][0]!
    expect(root).toMatchObject({ label: 'MMagic-Files', shape: 'circle', bare: false, mmId: 'root' })
    expect(base.edges).toHaveLength(7)
  })

  it('改叶子文案（键全对之外的单点漂移）：其余子树装饰原样保留', () => {
    const base = parseMindmap(FIXTURE)
    const tree = toEngineTree(base)
    findByText(tree, '发布')!.data.text = '上线'
    const out = serializeMindmap(fromEngineTree(tree, base))
    expect(out).toContain('root((MMagic-Files))') // 根装饰保留
    expect(out).toContain('id1[代码]') // 兄弟装饰保留
    expect(out).toContain('id3(圆角)')
  })

  it('改叶子文案：该节点按引擎树重建——文本取引擎、形状取缺省（装饰降级不丢树）', () => {
    const base = parseMindmap(FIXTURE)
    const tree = toEngineTree(base)
    findByText(tree, '发布')!.data.text = '上线'
    expect(serializeMindmap(fromEngineTree(tree, base))).toBe(
      [
        'mindmap',
        '  root((MMagic-Files))',
        '    预览',
        '      图片',
        '      文档',
        '    编辑',
        '      id1[代码]',
        '      id3(圆角)',
        '    上线', // 重建为纯文本（不再是 id2((…)) 形态）
      ].join('\n'),
    )
  })

  it('兄弟重排：顺序以引擎树为准采纳，键（文本+路径）不变 → 装饰全保留', () => {
    const base = parseMindmap(FIXTURE)
    const tree = toEngineTree(base)
    const fa = findByText(tree, '发布')!
    const yulan = findByText(tree, '预览')!
    const bianji = findByText(tree, '编辑')!
    tree.children = [fa, yulan, bianji]
    expect(serializeMindmap(fromEngineTree(tree, base))).toBe(
      [
        'mindmap',
        '  root((MMagic-Files))',
        '    id2((发布))',
        '    预览',
        '      图片',
        '      文档',
        '    编辑',
        '      id1[代码]',
        '      id3(圆角)',
      ].join('\n'),
    )
  })

  it('新增节点：按引擎树重建为缺省形态（纯文本），既有兄弟装饰不受影响', () => {
    const base = parseMindmap(FIXTURE)
    const tree = toEngineTree(base)
    findByText(tree, '预览')!.children.push({ data: { text: '新分支' }, children: [] })
    const result = fromEngineTree(tree, base)
    expect(result.nodes.size).toBe(9)
    expect(serializeMindmap(result).split('\n')).toContain('      新分支') // 深度 2 纯文本行
    expect(serializeMindmap(result)).not.toContain('(新分支)') // 无装饰包裹
  })

  it('删除节点：树随引擎收缩', () => {
    const base = parseMindmap(FIXTURE)
    const tree = toEngineTree(base)
    const yulan = findByText(tree, '预览')!
    yulan.children = yulan.children.filter((c) => c.data.text !== '文档')
    const result = fromEngineTree(tree, base)
    expect(result.nodes.size).toBe(7)
    expect(result.edges).toHaveLength(6)
    expect(serializeMindmap(result)).not.toContain('文档')
  })

  it('外部整树漂移（键全漂）：结构全盘采纳引擎树，装饰降级为缺省形态', () => {
    const base = parseMindmap(FIXTURE)
    const alien: EngineNode = {
      data: { text: '新根' },
      children: [
        { data: { text: '甲' }, children: [] },
        { data: { text: '乙' }, children: [{ data: { text: '丙' }, children: [] }] },
      ],
    }
    const result = fromEngineTree(alien, base)
    expect(result.header).toBe('mindmap')
    expect(result.nodes.size).toBe(4)
    expect(result.edges).toHaveLength(3)
    expect(serializeMindmap(result)).toBe(['mindmap', '  新根', '    甲', '    乙', '      丙'].join('\n'))
  })

  it('引擎 data 附加字段（uid/超集键）：容忍不炸，文本不变则仍零 diff', () => {
    const base = parseMindmap(FIXTURE)
    const tree = toEngineTree(base)
    const img = findByText(tree, '图片')!
    img.data.uid = 'engine-uid-1'
    img.data.hyperlink = 'https://example.com/help'
    expect(serializeMindmap(fromEngineTree(tree, base))).toBe(FIXTURE)
  })
})

// ───────────────────────── MC0-T-fix（MC0-V 评审轮 1 修复裁决钉值，测试先行预期红） ─────────────────────────

describe('同名兄弟消费式对位（MC0-V P1-2：byKey 改 Map 按序消费，废 last-wins）', () => {
  /** base 两片同名兄弟：id1[待定]（square 装饰）+ bare 待定（无装饰），键同为 MM/待定 */
  const SIB = ['mindmap', '  root((MM))', '    id1[待定]', '    待定'].join('\n')

  it('P1-2 两片同名兄弟（装饰各异）：from(to(base)) 零编辑 → serialize 逐字节等价于基线（消费式对位）', () => {
    const base = parseMindmap(SIB)
    const out = serializeMindmap(fromEngineTree(toEngineTree(base), base))
    expect(out).toBe(SIB) // 首片按引擎序消费 base 首片：id1 装饰保留，次片保裸形态
    expect(out).toBe(serializeMindmap(base))
  })

  it('P1-2 三片同名只配对到两片：base 两片被按序耗尽，第三片缺省重建不炸', () => {
    const base = parseMindmap(SIB)
    const tree = toEngineTree(base)
    tree.children.push({ data: { text: '待定' }, children: [] }) // 引擎端新增第三片同名兄弟
    const result = fromEngineTree(tree, base)
    expect(result.nodes.size).toBe(4)
    expect(serializeMindmap(result)).toBe(
      ['mindmap', '  root((MM))', '    id1[待定]', '    待定', '    待定'].join('\n'),
    )
  })
})

describe('环防御（MC0-V P2-2：treeShape 加 seen 集，与 serializeMindmap 同口径）', () => {
  it('P2-2 含环模型（R→A→B→A 回边）toEngineTree 不栈溢出：环边静默截断为合法树', () => {
    const base = parseMindmap(['mindmap', '  R', '    A', '      B'].join('\n'))
    base.edges.push({ from: 'm3', to: 'm2', label: '', line: -1 }) // B→A 回边成环（m1/m2/m3=R/A/B）
    // 对照基线：serializeMindmap 对同一环模型存活（seen 截断口径的正本行为）
    expect(serializeMindmap(base)).toBe(['mindmap', '  R', '    A', '      B'].join('\n'))
    const tree = toEngineTree(base) // 修复前：treeShape 无 seen → 无限递归栈溢出（预期红）
    expect(tree.data.text).toBe('R')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]!.data.text).toBe('A')
    expect(tree.children[0]!.children.map((c) => c.data.text)).toEqual(['B'])
    expect(tree.children[0]!.children[0]!.children).toHaveLength(0) // B→A 环边按 seen 截断
  })
})
