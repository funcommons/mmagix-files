/**
 * mind/decorations.ts——装饰数据层：meta 通道 ↔ 引擎节点 data 六类装饰+关联线双向映射（apps/mind）
 * 契约正本：.claude/mind-loop-state.md「MC3 契约草案」MC3a 节（2026-11-10 锁定）+「MC3d 契约裁决」行；
 * 可执行规格=src/apps/mind/__tests__/decorations.test.ts（21 例，文件头「解释口径」6 裁决逐条对齐）
 * +src/apps/renderers/__tests__/mindEditor.test.ts MC3d 区段（applyAssociativeLines 9 例）
 *
 * 三函数皆纯函数零引擎 import（引擎字段形态用本地最小契约 EngineNode 声明）：
 *  - applyAssociativeLines(tree, meta)：关联线 load 装配（MC3d 契约裁决② _assoc load 接线）——
 *    meta.assoc.lines 逐线 from/to 键（buildNodeKey 同口径）双端寻节点：to 节点 data.uid 缺则
 *    生成（'assoc-uid-'+序号 独立命名域，避撞既有 uid）；from 节点 data.associativeLineTargets
 *    =[…既有,新 uid]（多线同 from 按行序追加）+线文本 data.associativeLineText={[toUid]:text}
 *    （text 非空 string 才注入，缺省/空不建字段——引擎空文本存 '' 不落 meta 同口径）；键漂移
 *    （任一端解析不到）=console.warn 丢该线、其余线不受牵连、树零污染（逐线粒度=P2-4 口径）；
 *    不可变新树（同 applyDecorations 口径）；通道隔离：nodeMeta 装饰不二次注入（applyDecorations
 *    职责面），只注 uid/associativeLineTargets/associativeLineText 三键。
 *  - applyDecorations(tree, meta)：不可变新树（逐节点重建、data 浅拷贝），从根 walking 累积
 *    文本路径，key=buildNodeKey(祖先文本链含自身)，把 meta.nodeMeta[key] 六类字段字段级注入
 *    node.data（note；hyperlink+hyperlinkTitle；tags→tag；generalization/outerFrame 透传；
 *    image 过 isSafeImageUrl 闸+imageTitle）——非法值丢该字段+console.warn（MC0-V P2-4 口径，
 *    字段级粒度非整记录丢弃）；既有 data 键（style/uid/associativeLineTargets 等）透传保留
 *    （MC3a-T 裁决④：MC3b 关联线接线依赖 uid 在 apply 产物上存活）；meta 无键节点 data 零
 *    污染；_assoc/schema/_mindview 不在处理范围（关联线 load 接线=上方 applyAssociativeLines 专函），忽略不炸。
 *  - extractDecorations(tree)：编辑树反提——六类装饰字段按同规则 key 收进 nodeMeta 记录
 *    （记录恰为装饰字段，uid 不入 meta；image 写回过 isSafeImageUrl）；关联线
 *    data.associativeLineTargets（uid 数组）→assoc.lines（先全树建 uid→key 索引解析目标
 *    节点→toKey；解析不到丢线+warn=MC3a-T 裁决⑥建议口径）。
 *
 * 【契约空白实现选择（MC3a-T 裁决⑥留白的实现侧定案）】
 *  - imageTitle 与 image 同生共死（对称实现）：apply 侧 image 缺席/非法时 imageTitle 不注入；
 *    extract 侧 image 缺席/非法时不回写 imageTitle——图题无图不成义，往返零残留零泄漏。
 *  - 线文本实测锁定：引擎存储形态 data.associativeLineText={ [toUid]: string }
 *    （node_modules/simple-mind-map/src/plugins/AssociativeLine.js hideEditTextBox 写入、
 *    associativeLine/associativeLineText.js getText 读取实证；默认文本存 '' 不落 meta）——
 *    extract 按 toUid 尽力读取，非空 string 才写回 line.text（测试只钉 from/to 与无 text
 *    缺省形态，text 提取路径契约明示不钉）。
 *  - hyperlinkTitle 独立于 hyperlink 字段级注入/回写（与 P2-4 字段级粒度一致；URL 闸仅
 *    image，hyperlink 无闸；契约空白只声明了 imageTitle 的对称性）。
 */
import type { EngineNode } from './convert'
import { buildNodeKey, isSafeImageUrl } from './meta'
import type { MindMeta } from './meta'

// ───────────────────────── 类型 ─────────────────────────

/** 关联线反提元素（与 meta.ts AssocMeta.lines 元素同构：from/to 文本路径键+可选 text） */
export interface AssocLine {
  from: string
  to: string
  text?: string
}

/** extractDecorations 返回形态：nodeMeta 为普通 Record（装配面自行 new Map(Object.entries)
 *  重建 MindMeta.nodeMeta），assoc.lines 为键漂移 best-effort 后的存活线 */
export interface ExtractedDecorations {
  nodeMeta: Record<string, Record<string, unknown>>
  assoc: { lines: AssocLine[] }
}

// ───────────────────────── 内部工具 ─────────────────────────

/** 普通对象闸（非 null/非数组）——generalization/outerFrame/associativeLineText 形态共用 */
function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 节点文本防御读取（EngineNode 声明 text: string，非 string 容忍为 ''——与 convert.ts
 *  fromEngineTree 同口径；两侧 walking 用同一取值函数保证键域一致） */
function nodeText(n: EngineNode): string {
  const t = n.data?.text
  return typeof t === 'string' ? t : ''
}

function warnDrop(key: string, field: string, why: string): void {
  console.warn(`[mind/decorations] ${key} 的 ${field} ${why}，已丢字段`)
}

/** 单记录六类字段字段级注入（P2-4 口径：非法丢该字段+warn，同记录其余字段不受牵连；
 *  未声明的记录多余键忽略不注入——data 零额外污染） */
function applyRecord(data: EngineNode['data'], rec: Record<string, unknown>, key: string): void {
  const note = rec.note
  if (note !== undefined) {
    if (typeof note === 'string') data.note = note
    else warnDrop(key, 'note', '非 string')
  }
  const image = rec.image
  if (image !== undefined) {
    if (typeof image === 'string' && isSafeImageUrl(image)) {
      data.image = image
      const title = rec.imageTitle
      if (title !== undefined) {
        if (typeof title === 'string') data.imageTitle = title
        else warnDrop(key, 'imageTitle', '非 string')
      }
    } else {
      // 契约空白①对称口径：image 非法时 imageTitle 一并不注入（图题无图不成义）
      warnDrop(key, 'image', '非 string 或未过 isSafeImageUrl 闸')
    }
  }
  const hyperlink = rec.hyperlink
  if (hyperlink !== undefined) {
    if (typeof hyperlink === 'string') data.hyperlink = hyperlink
    else warnDrop(key, 'hyperlink', '非 string')
  }
  const hyperlinkTitle = rec.hyperlinkTitle
  if (hyperlinkTitle !== undefined) {
    if (typeof hyperlinkTitle === 'string') data.hyperlinkTitle = hyperlinkTitle
    else warnDrop(key, 'hyperlinkTitle', '非 string')
  }
  const tags = rec.tags
  if (tags !== undefined) {
    if (Array.isArray(tags) && tags.every((t) => typeof t === 'string')) data.tag = [...tags]
    else warnDrop(key, 'tags', '非 string 数组')
  }
  const generalization = rec.generalization
  if (generalization !== undefined) {
    if (isPlainObj(generalization)) data.generalization = generalization
    else warnDrop(key, 'generalization', '非对象形态')
  }
  const outerFrame = rec.outerFrame
  if (outerFrame !== undefined) {
    if (isPlainObj(outerFrame)) data.outerFrame = outerFrame
    else warnDrop(key, 'outerFrame', '非对象形态')
  }
}

// ───────────────────────── applyDecorations（meta → data 注入） ─────────────────────────

/** meta.nodeMeta → 引擎树 data 注入（不可变新树：入参树毫发无伤；data 逐节点浅拷贝重建，
 *  既有键 style/uid/associativeLineTargets 等透传保留，无键节点零装饰污染）。schema/_mindview/
 *  _assoc 不在处理范围（关联线接线=applyAssociativeLines 专函——MC3d 起装配链续接本函数之后），
 *  忽略不炸 */
export function applyDecorations(tree: EngineNode, meta: MindMeta): EngineNode {
  const walk = (n: EngineNode, path: string[]): EngineNode => {
    const p = [...path, nodeText(n)]
    const key = buildNodeKey(p)
    const data: EngineNode['data'] = { ...n.data }
    const rec = meta.nodeMeta.get(key)
    if (rec) applyRecord(data, rec, key)
    return { data, children: (n.children ?? []).map((c) => walk(c, p)) }
  }
  return walk(tree, [])
}

// ───────────────────────── applyAssociativeLines（_assoc → data 注入，MC3d 装配面） ─────────────────────────

/** meta.assoc.lines → 引擎树关联线 data 注入（load 接线，MC3d 契约裁决②；装配序=applyDecorations
 *  之后续接——两通道键域不相交，组合序与反序深等价）。不可变新树（逐节点重建、data 浅拷贝，
 *  同 applyDecorations 口径——根与 from/to 节点 data 引用全新，uid/targets 注入不原地）。
 *  逐线：from/to 键各寻节点（先序首见为准，与 extractDecorations uidToKey 同口径），双端解析
 *  成功才装配——to 节点 uid 缺则生成（'assoc-uid-'+序号，既有 uid 集避撞：重复 uid 会破坏
 *  extract 侧 uid→key 解析）；from 节点 targets 行序追加、线文本非空注入。键漂移（任一端解析
 *  不到）=warn 丢该线（解析先于 uid 分配——漂移线零 uid 零字段，树零污染），其余线不受牵连 */
export function applyAssociativeLines(tree: EngineNode, meta: MindMeta): EngineNode {
  const lines = meta.assoc?.lines ?? []

  // 键→节点索引（buildNodeKey 同口径；先序首见为准——同名兄弟共享路径键，与 extract 同口径）
  const keyToNode = new Map<string, EngineNode>()
  const index = (n: EngineNode, path: string[]): void => {
    const p = [...path, nodeText(n)]
    const key = buildNodeKey(p)
    if (!keyToNode.has(key)) keyToNode.set(key, n)
    for (const c of n.children ?? []) index(c, p)
  }
  index(tree, [])

  // 既有 uid 集（生成命名域避撞）+ 生成器（'assoc-uid-'+序号；测试只钉非空 string，字面不入 meta）
  const usedUids = new Set<string>()
  const collectUid = (n: EngineNode): void => {
    const u = n.data?.uid
    if (typeof u === 'string' && u !== '') usedUids.add(u)
    for (const c of n.children ?? []) collectUid(c)
  }
  collectUid(tree)
  let uidSeq = 0
  const genUid = (): string => {
    let u = `assoc-uid-${++uidSeq}`
    while (usedUids.has(u)) u = `assoc-uid-${++uidSeq}`
    usedUids.add(u)
    return u
  }

  // 注入计划（按输入树节点对象归集）：uid=该节点装配后 uid、targets/texts=该节点 from 侧增量
  const plan = new Map<EngineNode, { uid?: string; targets: string[]; texts: Record<string, string> }>()
  const uidOf = (to: EngineNode): string => {
    const existing = to.data?.uid
    if (typeof existing === 'string' && existing !== '') return existing
    const entry = plan.get(to)
    if (entry?.uid !== undefined) return entry.uid // 同节点多线复用首个生成 uid
    const u = genUid()
    if (entry) entry.uid = u
    else plan.set(to, { uid: u, targets: [], texts: {} })
    return u
  }
  for (const line of lines) {
    const from = keyToNode.get(line.from)
    const to = keyToNode.get(line.to)
    if (from === undefined || to === undefined) {
      // 键漂移：逐线丢线保树（MC3a-T 裁决⑥口径），其余线不受牵连
      console.warn(`[mind/decorations] 关联线 ${line.from} → ${line.to} 键解析不到节点，已丢线`)
      continue
    }
    const uid = uidOf(to)
    let entry = plan.get(from)
    if (entry === undefined) {
      entry = { targets: [], texts: {} }
      plan.set(from, entry)
    }
    entry.targets.push(uid)
    if (typeof line.text === 'string' && line.text !== '') entry.texts[uid] = line.text
  }

  // 不可变重建：data 浅拷贝后按计划注入（计划空=产物深等入参树，零字段污染）
  const walk = (n: EngineNode): EngineNode => {
    const data: EngineNode['data'] = { ...n.data }
    const entry = plan.get(n)
    if (entry) {
      if (entry.uid !== undefined) data.uid = entry.uid
      if (entry.targets.length > 0) {
        // targets 行序追加（[…既有,新 uid]；既有形态防御——非数组/非 string 项不继承）
        const prev = Array.isArray(data.associativeLineTargets)
          ? (data.associativeLineTargets as unknown[]).filter((u): u is string => typeof u === 'string')
          : []
        data.associativeLineTargets = [...prev, ...entry.targets]
      }
      if (Object.keys(entry.texts).length > 0) {
        const prevText = isPlainObj(data.associativeLineText) ? { ...data.associativeLineText } : {}
        data.associativeLineText = { ...prevText, ...entry.texts }
      }
    }
    return { data, children: (n.children ?? []).map(walk) }
  }
  return walk(tree)
}

// ───────────────────────── extractDecorations（编辑树 → meta 反提） ─────────────────────────

/** 编辑树反提：六类装饰字段→nodeMeta 记录（key 同 buildNodeKey 规则；记录恰为装饰字段，
 *  uid/associativeLineTargets 等引擎私有键不入 meta；无装饰节点不产记录）；
 *  associativeLineTargets→assoc.lines（uid 先全树建索引解析，解析不到丢线+warn）；
 *  无装饰干净树→空对象+空 lines */
export function extractDecorations(tree: EngineNode): ExtractedDecorations {
  const nodeMeta: Record<string, Record<string, unknown>> = {}
  const lines: AssocLine[] = []
  // 先全树建 uid→key 索引（targets 只存目标 uid，解析须对照全树；重复 uid 首见为准）
  const uidToKey = new Map<string, string>()
  const index = (n: EngineNode, path: string[]): void => {
    const p = [...path, nodeText(n)]
    const key = buildNodeKey(p)
    const uid = n.data?.uid
    if (typeof uid === 'string' && !uidToKey.has(uid)) uidToKey.set(uid, key)
    for (const c of n.children ?? []) index(c, p)
  }
  index(tree, [])

  const collect = (n: EngineNode, path: string[]): void => {
    const p = [...path, nodeText(n)]
    const key = buildNodeKey(p)
    const d = n.data ?? ({} as EngineNode['data']) // 可选防御（与 index/walk 侧 n.data?. 对称）
    const rec: Record<string, unknown> = {}
    if (typeof d.note === 'string') rec.note = d.note
    if (typeof d.image === 'string' && isSafeImageUrl(d.image)) {
      rec.image = d.image
      // 契约空白①对称口径：imageTitle 随 image 同生共死，非法 image 零 imageTitle 残留
      if (typeof d.imageTitle === 'string') rec.imageTitle = d.imageTitle
    } else if (d.image !== undefined) {
      console.warn(`[mind/decorations] ${key} 的 image 非 string 或未过 isSafeImageUrl 闸，不回写`)
    }
    if (typeof d.hyperlink === 'string') rec.hyperlink = d.hyperlink
    if (typeof d.hyperlinkTitle === 'string') rec.hyperlinkTitle = d.hyperlinkTitle
    if (Array.isArray(d.tag) && d.tag.every((t) => typeof t === 'string')) rec.tags = [...d.tag]
    if (isPlainObj(d.generalization)) rec.generalization = d.generalization
    if (isPlainObj(d.outerFrame)) rec.outerFrame = d.outerFrame
    if (Object.keys(rec).length > 0) nodeMeta[key] = rec

    // 关联线反提：data.associativeLineTargets（uid 数组）→ lines（行序=walking 序，契约不钉）；
    // 线文本按实测形态 associativeLineText={ [toUid]: string } 尽力读取（默认文本 '' 不落 meta）
    const targets = d.associativeLineTargets
    if (Array.isArray(targets)) {
      const textMap = isPlainObj(d.associativeLineText) ? d.associativeLineText : null
      for (const uid of targets) {
        if (typeof uid !== 'string') {
          console.warn(`[mind/decorations] ${key} 的关联线目标 uid 非 string，已丢线`)
          continue
        }
        const toKey = uidToKey.get(uid)
        if (toKey === undefined) {
          // MC3a-T 裁决⑥：uid 解析不到（节点已删/键漂移）丢线保树，warn 不炸
          console.warn(`[mind/decorations] ${key} 的关联线目标 uid（${uid}）解析不到节点，已丢线`)
          continue
        }
        const line: AssocLine = { from: key, to: toKey }
        const t = textMap?.[uid]
        if (typeof t === 'string' && t !== '') line.text = t
        lines.push(line)
      }
    }
    for (const c of n.children ?? []) collect(c, p)
  }
  collect(tree, [])
  return { nodeMeta, assoc: { lines } }
}
