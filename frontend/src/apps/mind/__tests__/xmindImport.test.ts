/**
 * mind/xmindImport.ts xmindToMindmap 单测（MP2-X1-T 测试先行，预期红：模块未落地——import
 * 解析失败整文件红，归因=纯函数面未落地）
 * 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2 生态「.xmind 导入（zip+content.json，
 * 逃生舱）」+ §四 mermaid mindmap 文本形态（D1 主存不动：导入产物=mermaid mindmap 文本）
 *
 * 【MP2-X1-T 勘察一：zip 依赖盘点（frontend/package.json 实证）】fflate@^0.8.3 已在
 * dependencies（src/files/zip.ts store 打包 + src/files/zip-reader.ts 自研读包双面在用，
 * zip.test.ts 同域经验）——零新依赖；解包选型建议=fflate unzipSync（同步 API、包内既有），
 * 新依赖安装面零动作（落地归 MP2-X1-C）。本文件纯函数面不触 zip：zip 字节→contentJson
 * 的解包归胶水/实现侧，编辑器行为例（mindEditor.test.ts MP2-X1 describe）以 fflate
 * zipSync 造真 zip 字节驱动——标准 zip 任何 unzip 库皆可读，测试桩不锁实现选型。
 *
 * 【MP2-X1-T 勘察二：content.json schema 反推（node_modules/simple-mind-map/src/parse/xmind.js
 * + src/plugins/ExportXMind.js 实证，0.14.0-fix.3——引擎自产 .xmind=权威样例）】
 *  - .xmind=zip 包：content.json（新版主存，JSON.parse 后=sheet 数组）+ metadata.json +
 *    content.xml（旧版兼容面）；引擎 parse 侧 json 优先、xml 兜底（xmind8 content.xml 旧版
 *    解析面本批不钉，归实现裁量）。
 *  - sheet：{ id, class:'sheet', title:<导出名>, extensions:[], rootTopic }——引擎导出恒单
 *    sheet 数组 [sheet]（parse/xmind.js transformToXmind :314 contentData=[newTree]）；
 *    真 XMind 可多 sheet（引擎 parse 侧 content[0] 取首+handleMultiCanvas 钩子同语义）。
 *  - topic：{ id, structureClass:'org.xmind.ui.logic.right', title:<节点文本,可缺省>,
 *    children:{ attached:[子topic…] } }；根 topic 另带 class:'topic'（isRoot 分支）；
 *    children.attached=子节点数组（数组序=兄弟序）；notes/href/labels/summaries 超集字段
 *    引擎 parse 侧有消费，本批纯结构面不钉（超集搬运归实现裁量，注记供后续批）。
 *  - title 缺省：引擎 parse 侧 isUndef→''；mermaid 空白行会被 parseMindmap 吞行且子级重挂
 *    （parseMindmap 对 trim 后空行 return——空标题节点占位策略归实现裁量，本批不钉）。
 *
 * 【契约（测试侧裁量，实现侧对齐或回本文件改钉）】xmindToMindmap(contentJson: unknown): string
 *  - 入参=content.json 的 JSON.parse 产物（sheet 数组域）；出参=mermaid mindmap 文本，形
 *    态与 serializeMindmap 同构：header 'mindmap' 行 + 根 2 空格缩进 + 每层 +2 空格
 *    （'  '.repeat(depth+1)——偏离任务 prompt「根无缩进」字面：parseMindmap 缩进栈=相对
 *    深度语义，两种形态解析同构；钉 serializeMindmap 同形使「导入→保存链」字节零漂移，
 *    且 plan §四 正本示例根行亦 2 空格缩进 `  新品发布计划`）。
 *  - 兄弟序：children.attached 数组序→出参行序（先序）。
 *  - 特殊字符（mermaid 文本面）：needsQuote 命中（含 " { } [ ] ( ) | \ 换行）→
 *    `["<escapeLabel 转义>"]` 包裹形态（flow-model mindmapNodeToken bare 分支同口径）——
 *    parseMindmap 回读 label 全等原文（\" \\\\ 转义对称）；中文/emoji 直通不加包裹。
 *  - 多 sheet：取首 sheet + console.warn（mind/* 域既有告警通道，meta.ts/decorations.ts
 *    同族）；非数组入参（含 null/bare 单 sheet 对象）→ throw（引擎 parse 侧 content[0]
 *    只认数组域，bare 对象同样落 undefined 崩——防御口径=胶水 catch 统一告警）。
 *  - 空树/缺 rootTopic 防御：throw（裁决建议，备选=空串+warn 如实注记供推翻）：引擎
 *    parseXmindFile 对空 content 同 reject(Error('解析失败')) 形态；throw 使防御单点收敛
 *    纯函数、胶水 catch 后走「告警+零 setData+零 dirty」（编辑器行为例反断钉）；空串+warn
 *    会把「文件不是脑图」与「空脑图」混一——导入=显式用户动作，失败须可见。
 *  - 纯函数不可变：入参 contentJson 毫发无伤（opml/decorations 同域红线）；零引擎
 *    import（simple-mind-map 零触）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { xmindToMindmap } from '../xmindImport'
import { parseMindmap, serializeMindmap } from '../../flow-model'
import { toEngineTree } from '../convert'

/** 引擎自产形态造 topic（schema 见块头注记；id/structureClass 恒带=引擎导出面） */
function mkTopic(title: string, attached: unknown[] = []): Record<string, unknown> {
  return { id: `topic-${title}`, structureClass: 'org.xmind.ui.logic.right', title, children: { attached } }
}

/** 引擎自产形态造 sheet（根 topic 另带 class:'topic'——transformToXmind isRoot 分支实证） */
function mkSheet(root: Record<string, unknown>): Record<string, unknown> {
  return { id: 'sheet-1', class: 'sheet', title: '导入稿', extensions: [], rootTopic: { ...root, class: 'topic' } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mind/xmindImport xmindToMindmap', () => {
  it('单根转换：sheet 数组入参 → mermaid mindmap 文本（header+根+attached 子树，缩进 2 空格逐层，兄弟序=数组序）', () => {
    const out = xmindToMindmap([mkSheet(mkTopic('导入根', [mkTopic('分支一'), mkTopic('分支二')]))])
    expect(out.split('\n'), 'header+根 2 空格+两子 4 空格（serializeMindmap 同构字节形态）').toEqual([
      'mindmap',
      '  导入根',
      '    分支一',
      '    分支二',
    ])
    expect(parseMindmap(out).header, '产物 header=mindmap（flow-model 方言头同款）').toBe('mindmap')
  })

  it('多级嵌套（三/四层）：attached 递归展开先序行序——根→A→B{C1,C2}+D 四层链，每层 +2 空格', () => {
    const out = xmindToMindmap([
      mkSheet(
        mkTopic('根', [
          mkTopic('A', [mkTopic('B', [mkTopic('C1'), mkTopic('C2')]), mkTopic('D')]),
          mkTopic('E', [mkTopic('F', [mkTopic('G', [mkTopic('H')])])]),
        ]),
      ),
    ])
    expect(out.split('\n')).toEqual([
      'mindmap',
      '  根',
      '    A',
      '      B',
      '        C1',
      '        C2',
      '      D',
      '    E',
      '      F',
      '        G',
      '          H',
    ])
  })

  it('数组包裹与多 sheet：content.json=[sheet] 取首（引擎导出面恒数组）+多 sheet 取首+console.warn 恰一次；非数组入参 throw（引擎 content[0] 只认数组域）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s1 = mkSheet(mkTopic('首页根', [mkTopic('甲')]))
    const s2 = mkSheet(mkTopic('次页根'))
    const out = xmindToMindmap([s1, s2])
    expect(out.split('\n'), '多 sheet 取首（引擎 parse 侧 content[0] 同语义）').toEqual(['mindmap', '  首页根', '    甲'])
    expect(warnSpy, '多 sheet 须告警（弃 sheet2 可见）').toHaveBeenCalledTimes(1)
    const before = JSON.stringify([s1, s2])
    void out
    expect(JSON.stringify([s1, s2]), '入参毫发无伤（纯函数不可变红线）').toBe(before)
    // 非数组域防御：null / bare 单 sheet 对象 / 空数组 → throw（胶水 catch 统一告警，见编辑器块防御例）
    expect(() => xmindToMindmap(null), 'null → throw').toThrow()
    expect(() => xmindToMindmap(mkSheet(mkTopic('裸对象'))), 'bare 单 sheet 对象（非数组包裹）→ throw').toThrow()
    expect(() => xmindToMindmap([]), '空数组（零 sheet）→ throw').toThrow()
  })

  it('特殊字符文本（mermaid 文本面）：title 含 []/引号/反斜杠 → ["…"] 包裹+escapeLabel 转义（mindmapNodeToken bare 同口径），parseMindmap 回读 label 全等原文；中文/emoji 直通', () => {
    const out = xmindToMindmap([
      mkSheet(mkTopic('根', [mkTopic('带[方]括号'), mkTopic('引"号\\反斜'), mkTopic('中文😀直通')])),
    ])
    expect(out.split('\n'), '特殊字符包 ["…"]（防 mermaid 形状定界歧义）；plain 文本直通不加包裹').toEqual([
      'mindmap',
      '  根',
      '    ["带[方]括号"]',
      '    ["引\\"号\\\\反斜"]',
      '    中文😀直通',
    ])
    const tree = toEngineTree(parseMindmap(out))
    expect(
      tree.children.map((c) => c.data.text),
      'parseMindmap 回读 label 全等原文（escapeLabel/unquote 转义对称无损）',
    ).toEqual(['带[方]括号', '引"号\\反斜', '中文😀直通'])
    expect(serializeMindmap(parseMindmap(out)), '编辑器自身 parse+serialize 循环字节稳定（导入→保存链零漂移前提）').toBe(out)
  })

  it('空树/缺 rootTopic 防御：sheet 无 rootTopic / rootTopic=null → throw（裁决建议：throw 收敛防御单点，胶水 catch 走告警+零写路径；备选空串+warn 见块头注记；rootTopic 非对象形态不钉=实现自由度）', () => {
    expect(() => xmindToMindmap([{ id: 'sheet-1', class: 'sheet', title: '空稿' }]), 'sheet 缺 rootTopic → throw').toThrow()
    expect(() => xmindToMindmap([{ rootTopic: null }]), 'rootTopic=null → throw').toThrow()
  })

  it('往返 sanity：产物 parseMindmap 解析成功（import 面 OK）+结构树语义全等（四层混合 plain/特殊字符树经 toEngineTree 走通）', () => {
    const out = xmindToMindmap([
      mkSheet(
        mkTopic('主根', [
          mkTopic('普通分支', [mkTopic('孙[带括]', [mkTopic('曾孙')])]),
          mkTopic('乙'),
        ]),
      ),
    ])
    const tree = toEngineTree(parseMindmap(out))
    expect(tree.data.text, '根语义').toBe('主根')
    expect(tree.children.map((c) => c.data.text), '首层两子').toEqual(['普通分支', '乙'])
    expect(tree.children[0]!.children[0]!.data.text, '特殊字符孙节点回读无损').toBe('孙[带括]')
    expect(tree.children[0]!.children[0]!.children[0]!.data.text, '四层链贯通').toBe('曾孙')
    expect(serializeMindmap(parseMindmap(out)), '全树 parse+serialize 字节稳定（canonical 钉）').toBe(out)
  })
})
