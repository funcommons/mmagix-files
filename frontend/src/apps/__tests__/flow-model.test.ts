/**
 * 流程图源模型单测（flow-editor 数据层）
 * 契约正本：apps/flow-model.ts 头注释 + 《流程图应用设计（Mermaid+X6）》§三
 * 硬验收：未编辑 → serialize(parse(x)) === x（往返 diff 为空，raw 优先纪律）
 */
import { describe, expect, it } from 'vitest'
import {
  addNode,
  connect,
  escapeLabel,
  isMindmapSource,
  nodeToken,
  parseFlowchart,
  parseMindmap,
  parseNodeToken,
  removeNode,
  serializeFlowchart,
  serializeMindmap,
  setNodeMeta,
  updateEdgeLabel,
  updateNode,
} from '../flow-model'

describe('parseNodeToken / escapeLabel（转义对称）', () => {
  it('四种形状 + 裸 id', () => {
    expect(parseNodeToken('A[文本]')).toEqual({ id: 'A', label: '文本', shape: 'rect', bare: false })
    expect(parseNodeToken('A(圆角)')).toEqual({ id: 'A', label: '圆角', shape: 'round', bare: false })
    expect(parseNodeToken('A((圆))')).toEqual({ id: 'A', label: '圆', shape: 'circle', bare: false })
    expect(parseNodeToken('A{菱}')).toEqual({ id: 'A', label: '菱', shape: 'diamond', bare: false })
    expect(parseNodeToken('B')).toEqual({ id: 'B', label: 'B', shape: 'rect', bare: true })
  })

  it('引号包裹 label：去引号还原；含特殊字符时序列化自动加引号，往返对称', () => {
    expect(parseNodeToken('A["含(括号)文本"]')!.label).toBe('含(括号)文本')
    const label = '特殊|文本"引号"'
    const tok = nodeToken({ id: 'X', label, shape: 'rect' })
    expect(parseNodeToken(tok)!.label).toBe(label)
    expect(escapeLabel('plain')).toBe('plain')
    expect(escapeLabel('a|b')).toBe('"a|b"')
  })

  it('非法 token → null', () => {
    expect(parseNodeToken('1不是合法id!')).toBeNull()
    expect(parseNodeToken('')).toBeNull()
  })

  it('多行 label：换行落为 \\n 转义序列（源单行），parseNodeToken 还原真换行（对称）', () => {
    const label = '第一行\n第二行'
    const tok = nodeToken({ id: 'M', label, shape: 'rect' })
    // 源保持单行：换行以字面 \n 两字序列进引号
    expect(tok).toBe('M["第一行\\n第二行"]')
    expect(tok.includes('\n')).toBe(false)
    // 还原对称
    expect(parseNodeToken(tok)).toMatchObject({ id: 'M', label, shape: 'rect' })
    // 反斜杠本身对称：a\b ↔ "a\\b"
    expect(parseNodeToken(nodeToken({ id: 'B', label: 'a\\b', shape: 'rect' }))!.label).toBe('a\\b')
  })

  it('多行边 label：updateEdgeLabel → 序列化 |"x\\ny"|；parse 还原真换行', () => {
    const m = parseFlowchart('graph TD\n  A --> B')
    m.edges[0]!.label = '通过\n复核'
    const out = serializeFlowchart(m)
    expect(out).toContain('A -->|"通过\\n复核"| B')
    expect(parseFlowchart(out).edges[0]!.label).toBe('通过\n复核')
  })
})

describe('parseFlowchart', () => {
  it('解析节点/边/meta/subgraph 透传行', () => {
    const src = `graph TD
  %% meta: schema=v1
  %% meta: B {"owner":"张三","sla":"4h"}
  A[提交申请] --> B{审批}
  B -->|通过| C[归档]
  subgraph 子流程
    C --> D((结束))
  end
`
    const m = parseFlowchart(src)
    expect(m.headerLine).toBe(0)
    expect(m.metaSchema).toBe('schema=v1')
    expect(m.nodes.get('A')).toMatchObject({ label: '提交申请', shape: 'rect' })
    expect(m.nodes.get('B')).toMatchObject({ label: '审批', shape: 'diamond' })
    expect(m.nodes.get('D')).toMatchObject({ label: '结束', shape: 'circle' })
    expect(m.nodes.get('B')!.meta).toEqual({ owner: '张三', sla: '4h' })
    expect(m.edges.map((e) => [e.from, e.to, e.label])).toEqual([
      ['A', 'B', ''],
      ['B', 'C', '通过'],
      ['C', 'D', ''],
    ])
  })

  it('链式边 A --> B --> C 拆成两条', () => {
    const m = parseFlowchart('graph TD\n  A --> B --> C')
    expect(m.edges).toHaveLength(2)
    expect(m.edges[0]).toMatchObject({ from: 'A', to: 'B' })
    expect(m.edges[1]).toMatchObject({ from: 'B', to: 'C' })
  })

  it('非法语法行透传（不抛出、不丢失）', () => {
    const src = 'graph TD\n  A --> B\n  这不是合法语法 ### \n  classDef bad fill:#f00'
    const m = parseFlowchart(src)
    expect(m.edges).toHaveLength(1)
    const out = serializeFlowchart(m)
    expect(out).toContain('这不是合法语法 ###')
    expect(out).toContain('classDef bad fill:#f00')
  })
})

describe('serializeFlowchart（raw 优先）', () => {
  it('硬验收：未编辑 → 往返 diff 为空', () => {
    const src = `graph TD
  %% meta: schema=v1
  %% meta: B {"owner":"张三"}
  A[提交申请] --> B{审批}
  B -->|通过| C[归档]

  subgraph 子流程
    C --> D((结束))
  end
`
    expect(serializeFlowchart(parseFlowchart(src))).toBe(src)
  })

  it('编辑一处：仅目标行变化，透传行原样', () => {
    const src = 'graph TD\n  %% 注释保留\n  A[旧名] --> B{审批}\n  classDef x fill:#eee'
    const m = parseFlowchart(src)
    updateNode(m, 'A', { label: '新名' })
    const out = serializeFlowchart(m)
    expect(out).toContain('A[新名]')
    expect(out).toContain('%% 注释保留')
    expect(out).toContain('classDef x fill:#eee')
    expect(out).not.toContain('A[旧名]')
  })

  it('meta 编辑：meta 块在 header 后整体重建，正文行不动', () => {
    const src = 'graph TD\n  A[开始] --> B[结束]'
    const m = parseFlowchart(src)
    setNodeMeta(m, 'B', { owner: '李四' })
    const out = serializeFlowchart(m)
    const lines = out.split('\n')
    expect(lines[0]).toBe('graph TD')
    expect(lines[1]).toBe('%% meta: B {"owner":"李四"}')
    expect(lines.map((l) => l.trim())).toContain('A[开始] --> B[结束]')
  })

  it('新增节点/连边追加尾部；删除节点级联边', () => {
    const m = parseFlowchart('graph TD\n  A[开始] --> B{审批}')
    const id = addNode(m, '新增步骤')
    connect(m, 'B', id, '确认')
    let out = serializeFlowchart(m)
    expect(out).toContain('B -->|确认| n1[新增步骤]')

    removeNode(m, 'A')
    out = serializeFlowchart(m)
    expect(out).not.toContain('A[开始]')
    expect(out).toContain('B -->|确认| n1[新增步骤]')
  })

  it('边 label 编辑（updateEdgeLabel）', () => {
    const m = parseFlowchart('graph TD\n  A -->|旧| B')
    updateEdgeLabel(m, 0, '新')
    expect(serializeFlowchart(m)).toContain(`A -->|新| B`)
  })
})

// ───────────────────────── mindmap 方言（缩进树适配） ─────────────────────────

describe('mindmap：isMindmapSource / parseMindmap / serializeMindmap', () => {
  const FIXTURE = [
    'mindmap',
    '  root((MMagic-Files))',
    '    预览',
    '      图片',
    '      文档',
    '      图示',
    '    编辑',
    '      代码',
    '      画板',
    '    嵌入',
    '      iframe',
    '      JSSDK',
  ].join('\n')

  it('isMindmapSource：mindmap 头=真；graph TD/sequence=false；meta/空行跳过后仍识别', () => {
    expect(isMindmapSource(FIXTURE)).toBe(true)
    expect(isMindmapSource('graph TD\n A-->B')).toBe(false)
    expect(isMindmapSource('sequenceDiagram\n U->>F: x')).toBe(false)
    expect(isMindmapSource('%% meta: schema=v1\n\nmindmap')).toBe(true)
    expect(isMindmapSource('')).toBe(false)
  })

  it('parseMindmap：节点/隐式父子边/装饰形状/纯文本 bare 全对', () => {
    const m = parseMindmap(FIXTURE)
    expect(m.header).toBe('mindmap')
    expect(m.nodes.size).toBe(11) // 根+3 分支+7 叶
    expect(m.edges.length).toBe(10)
    const root = [...m.nodes.values()][0]!
    expect(root.label).toBe('MMagic-Files')
    expect(root.shape).toBe('circle') // ((…))
    expect(root.bare).toBe(false)
    const children = m.edges.filter((e) => e.from === root.id)
    expect(children.map((e) => m.nodes.get(e.to)?.label)).toEqual(['预览', '编辑', '嵌入'])
    const yulan = m.nodes.get(children[0]!.to)!
    expect(yulan.bare).toBe(true) // 纯文本节点
    expect(yulan.shape).toBe('rect')
  })

  it('硬验收：未编辑 → serializeMindmap(parseMindmap(x)) === x（缩进/装饰/纯文本逐字节还原）', () => {
    expect(serializeMindmap(parseMindmap(FIXTURE))).toBe(FIXTURE)
  })

  it('编辑对称：改 label/装饰/增删节点后序列化反映变更；纯文本含形状字符自动包 ["…"]', () => {
    const m = parseMindmap(FIXTURE)
    const root = [...m.nodes.values()][0]!
    updateNode(m, root.id, { label: '新根' })
    let out = serializeMindmap(m)
    expect(out).toContain('root((新根))') // 装饰保持

    const yulan = m.edges.map((e) => m.nodes.get(e.to)!).find((n) => n.label === '图片')!
    updateNode(m, yulan.id, { label: '图片(缩略)' }) // 纯文本含括号 → 序列化包 ["…"]
    out = serializeMindmap(m)
    expect(out).toContain('["图片(缩略)"]')

    const nid = addNode(m, '新分支', 'round')
    connect(m, root.id, nid)
    out = serializeMindmap(m)
    expect(out).toContain('(新分支)')
    removeNode(m, nid)
    expect(serializeMindmap(m)).not.toContain('新分支')
  })

  it('宽容口径：tab 缩进归一（broken-tab 修复）；非法记号行按纯文本收编（broken-mind 不炸）', () => {
    const tabbed = 'mindmap\n  root((MM))\n\t分支(tab缩进)'
    const m = parseMindmap(tabbed)
    expect(m.nodes.size).toBe(2) // tab 归一：分支与 root 同级=第二根（mermaid 会拒，我们宽容收编）
    expect(m.edges.length).toBe(0)
    const out = serializeMindmap(m)
    // 序列化单根收拢：分支挂为主根子节点（层级修正），括号文本自动加保护包裹
    expect(out).toBe('mindmap\n  root((MM))\n    ["分支(tab缩进)"]')

    const garbage = parseMindmap('mindmap\n  root((MM))\n    分支\n  @@@@ 非法记号 []]] {{{')
    expect(garbage.nodes.size).toBe(3) // 非法行按纯文本节点收编（root+分支+非法行），永不失败
    expect(serializeMindmap(garbage)).toContain('@@@@ 非法记号')
  })

  it('meta 通道：%% meta 行解析进 metaById 并随序列化重建；位置持久化对脑图同样生效', () => {
    const src = 'mindmap\n  %% meta: schema=v1\n  %% meta: m1 {"kind":"root"}\n  root((MM))\n    子'
    const m = parseMindmap(src)
    expect(m.metaSchema).toBe('schema=v1')
    const root = [...m.nodes.values()].find((n) => n.label === 'MM')!
    expect(m.metaById.get(root.id)).toEqual({ kind: 'root' })
    setNodeMeta(m, root.id, { kind: 'root', layout: { x: 1 } })
    const out = serializeMindmap(m)
    expect(out).toContain('%% meta: schema=v1')
    expect(out).toContain('"layout"')
  })
})
