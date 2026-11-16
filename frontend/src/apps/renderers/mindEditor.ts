/**
 * MindEditor 渲染面（MC2 装配 + MC3b 面板接线与保存链装饰整合 + MC3c 大纲/搜索接线
 * + MC3d 关联线/外框装配收口）——mindmap 方言的 simple-mind-map 引擎装配胶水
 * 契约正本：.claude/mind-loop-state.md「MC2 表面契约」+「MC2 契约锚点」+「MC3b 契约（锁定）」
 * +「MC3c 契约（锁定）」+「MC3d 契约裁决」节
 * （测试=可执行规格：src/apps/renderers/__tests__/mindEditor.test.ts）
 *
 * 装配序（测试钉死 log 序）：defineTheme 四套（MIND_THEMES 全量，实例化前）→ usePlugin
 * 防护式注册七件（Drag→Select→KeyboardNavigation→Search——MC3c 批第四件→AssociativeLine→
 * OuterFrame——MC3d 批收口→Export——MP2-E1 批末位，实例挂 mm.doExport；mock 无 usePlugin
 * 静态时静默跳过）→
 * constructor(opt{el,data,layout,theme}) → on() 接线
 * → render()。引擎 import 顶层安全（vi.mock 拦截 + jsdom 顶层零 DOM），实例化只在
 * createMindEditorSurface 调用时发生。
 *
 * 数据流（flow-editor 保存链逐条镜像）：
 *  - mount = parseMindmap → toEngineTree → applyDecorations(·, meta) → applyAssociativeLines(·,
 *    meta) → opt.data（MC3b-C2：文件装饰 apply-on-load；MC3d 起 _assoc 关联线同链续接——两通道
 *    键域不相交，组合序自由；装饰/关联线回写不走此通道——extractDecorations 保存链反提）；
 *    缺省口径：text 无 _mindview meta →
 *    layout='logicalStructure' + theme='xm-green'（生产皮肤），有 → 按 meta 值透传
 *  - save = mm.getData() → fromEngineTree(edited, base) → serializeMindmap → 拼回
 *    writeMetaBlock(mergedMeta)（fromEngineTree 不搬运 meta 通道——MC0-T 裁决 5，故 meta 块
 *    按 writeMetaBlock 产物插回 header 之后，与 serializeMindmap 自身 meta 落位同位点；
 *    MC3b 起拼接源=文件 meta ⊕ extractDecorations(引擎树).nodeMeta 按键覆盖——编辑过的节点
 *    以引擎现态为准，schema/_mindview 沿文件原值；_assoc=extract 整表替换（MC3d 契约裁决②：
 *    extract 为保存时唯一真源——行非空写行恰一次禁与文件底 concat 双发射；空=行整体移除=
 *    删线持久化；行集合与文件底多重集等值时沿用文件 assoc 对象=字节零漂移）；无 meta 源且
 *    extract 空=零拼接 →
 *    未编辑保存零 diff，禁合成缺省 _mindview 行）
 *    → putObject(key, Blob text/plain;charset=utf-8) → notify('saved',{key})
 *  - 4305 = setReadonly 闩锁（后续 data_change 不再标脏、save 不再触 putObject）；
 *    其它失败保持 dirty 可重试（不 notify）
 *  - MC3b 属性面板：mindPanel 工厂挂宿主（absolute 浮层）；引擎 node_active(node, list)
 *    事件（Render.js emitNodeActiveEvent setTimeout(0) 异步派发）→ 有激活 extract 单节点装饰
 *    回填 panel.setNode / 无激活 panel.clear；onEdit(patch)→防护式 execCommand('SET_NODE_DATA',
 *    node, patch)（Render.js:324 实证命令，逐键合并 nodeData.data）→脏标走 data_change 两闸
 *    正常路径；面板生命周期随 dispose
 *  - MC3c 大纲：工具栏旁容器自有钮「大纲」（data-act='outline'，不进 shared 工具栏四键集——
 *    锁定例红线）→画布/大纲切换（叠置形态：大纲面板 absolute 盖画布，引擎容器不动=切换零
 *    引擎副作用）；每次开启实时取 mm.getData()→outlineFromTree→render+show；readonly 仍可开
 *    （视图态零写路径）。行点击 onLocate(key)→现态树按键寻节点→GO_TARGET_NODE 防护调用
 *    （Render.js:1966 goTargetNode 收 uid 串形态；终评 P2-2：真引擎节点恒带 uid，无 uid 零调
 *    ——键漂移 best-effort 同口径）→
 *    关大纲回画布
 *  - MC3c 搜索：Ctrl+F→浮条（工厂=mindSearch.ts，readonly 闩锁禁入）；引擎面=Search 插件实例
 *    mm.search（instanceName 'search'，Search.js:323 实测）防护调用：onSearch(text)→search(text)
 *    （空串早退=终评 P2-3，不直通引擎）
 *    （同文=引擎原生 next 语义 Search.js:76-78、异文=重搜跳首）；onNext→同文再 search 直通；
 *    onPrev→jump(显式索引)（Search.js:205 jump→searchNext(callback,index)——无索引恒向下一个，
 *    倒退只能带索引，索引自 search_info_change 追踪回绕）；onClose→endSearch()（Search.js:95）；
 *    search_info_change({currentIndex,total}) 0 基原样透传浮条 setCount（显示格式归浮条域）
 *  - MP1 视图态切换器：容器自有 select×2（data-act='layout'/'theme'，与大纲钮同族——不进
 *    shared 工具栏四键集）；change→mm.setLayout/setTheme（index.js:436/:379 面，cast optional
 *    ——ambient d.ts 未声明、mock 缺省无此面）+显式 markDirty（引擎切换路径无 data_change
 *    侧信道——脏标业务侧显式承担裁决）；会话覆写闭包 viewOverride 记录+视图基线
 *    mindviewBaseline（初始=文件 _mindview 记录或等价缺省形态——select 回显/reset 还原/
 *    mergedMeta 复用分支的统一正本）；mergedMeta 的 _mindview 通道读取：无覆写且基线未
 *    转正沿文件原对象复用（字节零漂移，sameAssocLines 同口径），有覆写→layout-first 完整
 *    记录重写（未覆写轴沿基线=会话现效值；缺省兜底 logicalStructure/xm-green 与缺省口径
 *    同源）；save() 成功路径把本次落盘的视图记录转正为基线+按飞行窗快照 CAS 清 viewOverride
 *    （MP1-UI-R P2-1：基线随保存更新——不转正则 reset 回显/再保存把已存盘视图回退成打开时
 *    视图；MP2-Q 洞 A：await 前快照覆写轴，只清「当前值===快照值」的轴——飞行窗内新覆写
 *    存活不被吞；MP2-Q P2-1：savedValue 同路刷新为落盘 value——gate 2 基线随已存内容走）；
 *    resetToSaved 清覆写+两 select 回显还原基线+引擎面 best-effort 归位
 *  - MP2-E1 导出：容器自有 select（data-act='export'，与 MP1 两 select 同族——不进 shared
 *    工具栏四键集）；选项 png/svg/json/opml 四格式齐序，change 派发导出后复位回首项（导出=
 *    动作非状态）；png/svg/json=引擎 Export 插件实例 mm.doExport.export(fmt, true, 导出名)
 *    防护透传（Export.js:24 面，isDownload=true=真下载语义；导出名=打开文件名去扩展——
 *    真引擎拼 '.<fmt>' 后缀落盘，Export.js:28）；opml=业务侧纯函数链（opml 非 Export 插件
 *    类型，引擎 export('opml') 落 Export.js:32 null——禁路由 doExport）：实时取 mm.getData()
 *    →outlineFromTree→opmlFromOutline（mind/opml.ts）→Blob(application/xml)→<a download>
 *    click（引擎 utils downloadFile 同构面）。导出全链只读——零 markDirty/setData/
 *    updateData（dirty 守卫例钉）；readonly 不闩（与大纲钮「视图态零写路径」同族口径）
 *  - MP2-X1 .xmind 导入：容器自有钮（data-act='xmind-import'，大纲钮/导出 select 同族——
 *    不进 shared 工具栏四键集）+隐藏 file input（accept='.xmind'；钮=选文件入口，click→
 *    input.click()）；change 捕获 File 后 input.value='' 复位（同文件重选仍触发 change）
 *    →file.arrayBuffer→fflate unzipSync 解包取 content.json（旧版 xmind8 content.xml 面
 *    本批不钉=缺席即 throw 走失败链）→JSON.parse→xmindToMindmap（mind/xmindImport.ts）
 *    →parseMindmap→toEngineTree→mm.setData(树)+显式 markDirty（引擎 setData 无 data_change
 *    侧信道——MP1「脏标业务侧显式承担」同族口径；setData=引擎树形态，resetToSaved :889 同面）
 *    →保存链落盘替换现文件（putObject 覆写同 key，导出文本=mermaid mindmap canonical）。
 *    坏链防御（unzip/JSON/转换任一 throw，含 content.json 缺席）：catch→console.warn 恰一次
 *    +零 setData/updateData+零 dirty（导入失败不落不标脏——测试钉）。导入=数据写路径，受
 *    readonly 闩锁：setReadonly 禁用钮+处理器 readonly 早退双闸（与 undo/redo 同族；不可
 *    类比导出/大纲「视图态零写路径不闩」族）
 *  - MP2-TP 模板库：容器自有 select（data-act='templates'，MP1/导出 select 同族——不进
 *    shared 工具栏四键集）；首项=占位（value=''，文本 t(app.mind-templates.placeholder)——
 *    动作入口非状态回显，mount 初值=占位），其余选项=MIND_TEMPLATES 齐序（value=id、文本
 *    t(nameKey)）；aria-label/title 走 t(app.mind-templates.do)。change→readonly 早退（双闸
 *    之二，闸 1=setReadonly 禁用控件）→查表 parseMindmap(content)→toEngineTree→mm.setData(树)
 *    （.xmind 导入同链同面）+显式 markDirty（引擎 setData 无 data_change 侧信道——导入族
 *    同口径）→select 复位占位（动作非状态，导出 select 复位同款；复位不吞后续选择）。模板
 *    替换=数据写路径，readonly 受闩——导入族双闸同款
 *  - MP2-TH 主题样式面板：容器自有钮（data-act='theme-style'，大纲/导入钮同族——不进
 *    shared 工具栏四键集）+浮动面板（DOM 工厂=mind/themePanel.ts，mindPanel 族同构：mount
 *    即挂入隐藏，is-open 在场=显示）；三控制轴 fill/line（color input）+lineStyle（select
 *    solid|dashed——引擎值映射 solid→'none'/dashed→'6,4'）；apply=写路径（canApply 闸：
 *    readonly 双闸之二+saving 飞行窗闩——模板/导入族同款）→ 触轴稀疏 overrides（未触轴
 *    不落键；填充轴写满 root/second/node 三消费层同值——third 不被引擎消费不写死数据）→
 *    base⊕overrides 合成（mergeThemeCfg——defineTheme 引擎合成基准不含 base 层，合成归
 *    胶水自担）→ defineTheme(`mind-custom-<n>`（闭包计数器递增——引擎同名再注册=静默
 *    no-op 滞留旧 cfg，计数器避撞））→ mm.setTheme（注册先于生效）+显式 markDirty
 *    （引擎 setTheme 无 data_change 侧信道——MP1 同族口径）→ 面板收起；
 *    持久化：会话 custom 态 sessionCustom={name,base,overrides}（savedCustom=已存盘正本
 *    ——保存成功随落盘刷新/reset 归位还原，MP1-UI-R P2-1 转正链同族）；mergedMeta
 *    _mindview 分支：sessionCustom 在场→完整记录 {layout 沿会话现效,theme:custom 名,
 *    custom:{base,overrides}}（键序 layout→theme→custom），缺席→既有基线复用分支零变化
 *    （零 diff 红线不动）；mount 回放：meta.mindview.custom 在场→合成 cfg defineTheme
 *    （先于实例化——未注册名 initTheme 回退 default）+opt.theme=回放名（constructor opt
 *    面构造期生效；零 dirty）+面板计数器起点=回放名序号递进；主题 select 切走→
 *    sessionCustom 清空+面板回基线缺省（savedCustom 留档——reset 还原已存盘）；
 *    MP2-R5：本 surface 定义名（回放+apply 两通道）入闭包名录 customDefinedNames——dispose
 *    链 mm.destroy() 前逐名 cast-optional removeTheme 回收+clear（引擎主题注册表=模块级
 *    单例跨 destroy 存续、生产零 removeTheme；不回收则下个 surface 同名注册被引擎 no-op
 *    吞=错显陈旧 cfg）；MP2-R5 N2：apply 合成基准=用户眼前主题（baseOf 读 viewOverride.theme
 *    覆写轴 ?? 基线）
 *
 * 引擎面裁决：undo/redo = mm.execCommand('BACK'/'FORWARD')（引擎 Command.js 的
 * Control+z/y 注册即此二命令；mock 无 execCommand 成员 → optional 调用防护）；
 * fit = 'node_tree_render_end' 事件后 mm.view.fit()（mm.fit() 不存在）；容器域
 * p{margin:0} reset（UA 缺省 margin 会把 foreignObject 文本推出节点框，plan.md §十）。
 */
import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag'
import Select from 'simple-mind-map/src/plugins/Select'
import KeyboardNavigation from 'simple-mind-map/src/plugins/KeyboardNavigation'
import Search from 'simple-mind-map/src/plugins/Search'
import AssociativeLine from 'simple-mind-map/src/plugins/AssociativeLine'
import OuterFrame from 'simple-mind-map/src/plugins/OuterFrame'
import Export from 'simple-mind-map/src/plugins/Export'
import { unzipSync } from 'fflate'
import { parseMindmap, serializeMindmap } from '../flow-model'
import { parseMindMeta, writeMetaBlock, isSafeImageUrl, buildNodeKey } from '../mind/meta'
import type { MindMeta } from '../mind/meta'
import { toEngineTree, fromEngineTree, type EngineNode } from '../mind/convert'
import { outlineFromTree } from '../mind/outline'
import { opmlFromOutline } from '../mind/opml'
import { xmindToMindmap } from '../mind/xmindImport'
import { MIND_TEMPLATES } from '../mind/templates'
import { applyDecorations, applyAssociativeLines, extractDecorations } from '../mind/decorations'
import { MIND_THEMES } from '../mind/themes'
import { createMindThemePanel, mergeThemeCfg } from '../mind/themePanel'
import type { MindCustomThemeState } from '../mind/themePanel'
import { createEditToolbar } from '../../shared/editToolbar'
import { createMindPanel } from './mindPanel'
import { createMindOutline } from './mindOutline'
import type { MindOutlineApi } from './mindOutline'
import { createMindSearch } from './mindSearch'
import type { MindSearchApi } from './mindSearch'
import type { AppCtx, AppInstance, DisposeReason } from '../../sdk/types'

const UNSAVED_KEY = 'app.code-unsaved'
const READONLY_KEY = 'app.code-readonly'

// ───────────────────────── 工具栏图标（MP2-UI 美化批：16×描边风格 stroke=currentColor，
// flow-editor ICONS 同语言同源；模块级一份零 per-mount 成本） ─────────────────────────

const icon = (paths: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

const MIND_BAR_ICONS = {
  // 大纲：列表（圆点+行）
  outline: icon('<circle cx="3.5" cy="4" r="1"/><circle cx="3.5" cy="8" r="1"/><circle cx="3.5" cy="12" r="1"/><path d="M6.5 4h6"/><path d="M6.5 8h6"/><path d="M6.5 12h4"/>'),
  // 主题样式：双滑杆调整轴（fill/line/lineStyle 三轴语义）
  themeStyle: icon('<path d="M2.5 5.5h11"/><circle cx="6" cy="5.5" r="1.6"/><path d="M2.5 10.5h11"/><circle cx="10" cy="10.5" r="1.6"/>'),
  // .xmind 导入：托盘+上行箭头（flow export 下载箭头的镜像——数据进应用）
  xmindImport: icon('<path d="M8 9.5v-7"/><path d="M5.5 5 8 2.5 10.5 5"/><path d="M3 11v2.5h10V11"/>'),
} as const

/** Search 插件实例面（mm.search——instanceName 'search'；单测 mock 缺省无此成员，
 *  测试侧按需播种 spy；胶水一律防护式 optional 调用） */
interface MindSearchFace {
  search?: (text: string, callback?: () => void) => void
  jump?: (index: number, callback?: () => void) => void
  endSearch?: () => void
}

/** Export 插件实例面（mm.doExport——instanceName 'doExport' Export.js:458 实测；单测 mock
 *  缺省无此成员，测试侧按需播种 spy；胶水一律防护式 optional 调用）。png/svg/json 走此面
 *  透传（export(type, isDownload, name)，Export.js:24）；opml 非插件类型（引擎
 *  export('opml') 落 Export.js:32 null）不路由此面=业务侧实现 */
interface MindExportFace {
  export?: (type: string, isDownload?: boolean, name?: string) => Promise<unknown>
}

/** MP2-E1 导出格式枚举（png/svg=引擎矢量位图面、json=引擎序列化面、opml=业务侧大纲面）——
 *  select 选项齐序钉死（测试=可执行规格） */
const EXPORT_FORMATS: readonly string[] = ['png', 'svg', 'json', 'opml']

/** OPML blob 下载面（业务侧）：Blob(application/xml) → <a download> click——引擎
 *  utils/index.js downloadFile（:272-277）同构面（离场锚 click 真浏览器照常派发下载）；
 *  blob URL 点击后延迟 revoke（零时刻 revoke 有竞速截断下载的已知面，挪到宏任务尾兜底） */
function downloadOpml(xml: string, filename: string): void {
  const blob = new Blob([xml], { type: 'application/xml' })
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(href), 0)
}

/** 渲染面入参（MC2 表面契约锁定；opt.el 直供引擎——测试钉 opt.el===el） */
export interface MindEditorSurfaceOpts {
  el: HTMLElement
  text: string
  ctx: AppCtx
  file: { key: string; name: string }
  /** 面级 i18n（只读徽标/关闭确认文案）；工具栏标签按契约走 ctx.t 的 app.edt-* 键 */
  t: (key: string) => string
  onDirty?: (dirty: boolean) => void
  onReadonly?: () => void
}

/** meta 块并入序列化文本：writeMetaBlock 产物插在 header 行之后——serializeMindmap 的
 *  meta 通道本就落位 header 后，此处按同位点拼回；metaLines 空（无 meta 源）时零拼接 */
function spliceMetaBlock(body: string, metaLines: string[]): string {
  if (metaLines.length === 0) return body
  const lines = body.split('\n')
  const header = lines[0]
  if (header === undefined) return body
  return [header, ...metaLines, ...lines.slice(1)].join('\n')
}

/** extract 关联线行集合 vs 文件底多重集等值判定（行序契约不钉——JSON 串排序后逐位比对）：
 *  等值→保存链沿用文件 assoc 对象（_assoc 行字节零漂移，含 meta 文件挂载未编辑不因行序被
 *  extract 重排而误翻 dirty）；任一线 from/to/text 增删改即破等值，extract 照常接管 */
function sameAssocLines(a: Array<{ from: string; to: string; text?: string }>, b: Array<{ from: string; to: string; text?: string }>): boolean {
  if (a.length !== b.length) return false
  const canon = (lines: Array<{ from: string; to: string; text?: string }>): string[] => lines.map((l) => JSON.stringify(l)).sort()
  const ca = canon(a)
  const cb = canon(b)
  return ca.every((s, i) => s === cb[i])
}

/** confirm 包装：原生同步应答转 Promise，与 3s 超时竞速（flow-editor/code.ts 同口径） */
function confirmWithTimeout(message: string, timeoutMs = 3000): Promise<boolean> {
  const answer = window.confirm(message) as boolean | Promise<boolean>
  return Promise.race([Promise.resolve(answer), new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs))])
}

/** 普通对象闸（decorations.ts 同名私有工具的面内镜像，零引擎 import） */
function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 引擎节点 data 防御读取（双形态兼容）：引擎树节点={data}；真引擎 MindMapNode 实例
 *  数据在 nodeData.data（MindMapNode.js:22 实证，实例无 .data 属性名不冲突） */
function nodeDataOf(node: unknown): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') return null
  const w = node as { data?: unknown; nodeData?: { data?: unknown } }
  const d = w.data !== undefined ? w.data : w.nodeData?.data
  return isPlainObj(d) ? d : null
}

/** MC3-V2 N1 strip 合并键集：EXTRACT_DECOR_FIELDS = extractDecorations 对单节点记录实际可能
 *  产出的键集（strip 集，meta 命名系）——decorations.ts:260-272 collect 逐行核对：note/image/
 *  imageTitle（随 image 同生共死，:261-264）/hyperlink/hyperlinkTitle/tags（引擎 tag 改名，
 *  :270）/generalization/outerFrame（:272）——恰「八装饰字段」（mindEditor.test.ts:803 同口径；
 *  uid/associativeLineTargets 等引擎私有键不入记录，不在集内）。
 *  （原「引擎 data 命名系同八键」判别常量 ENGINE_DECOR_FIELDS 已随 MC3-V3 P0 通道更换拆除
 *  ——其 `in` 证据判别在生产域恒假，替代通道见 legalDecorKeys 注） */
const EXTRACT_DECOR_FIELDS: readonly string[] = ['note', 'image', 'imageTitle', 'hyperlink', 'hyperlinkTitle', 'tags', 'generalization', 'outerFrame']

/** MC3-V3 P0（主代理裁决=V3 推荐项 1）：mount 期合法装饰键集 L——文件 meta.nodeMeta 中
 *  「applyRecord 实际会注入 ≥1 字段」的键集。注入条件逐键镜像 decorations.ts:79-124
 *  applyRecord（逐条核对）：note/hyperlink/hyperlinkTitle 注入条件=值 string；tags=string
 *  数组；generalization/outerFrame=对象形态；image+imageTitle 仅 image 过 isSafeImageUrl 闸
 *  才注（imageTitle 随 image 同生共死，不能独立成注）——仅含非法 image 的记录注入 0 字段
 *  →键∉L。
 *  通道裁决依据（V3 P0 实证锚点）：真引擎 mm.getData() 经 JSON 深克隆剥 undefined 值键名
 *  （Command.js:177-181 → utils/index.js:153-163 simpleDeepClone 实证），MC3-F2 落的「引擎
 *  data `in` 证据判别」（ENGINE_DECOR_FIELDS.some(f => f in d)）在生产域恒假——单装饰字段
 *  节点清除不翻脏+旧值复活（N1 双红形态）。L 通道以 mount 期注入事实替代运行期 data 证据：
 *  键∈L=该节点 mount 时确有装饰进引擎，引擎现态对其装饰面有发言权→mergedMeta 一律 strip
 *  合并（extract 缺席=已清除，不复活）；键∉L=注入 0 字段，引擎现态对装饰面零发言权→base
 *  记录原样保留（零 diff 优先，不因规范化制造挂载即 dirty）。纯 meta 派生：reset 走 mount
 *  同链（同一 meta）→ L 无需重算 */
function legalDecorKeys(meta: MindMeta): Set<string> {
  const keys = new Set<string>()
  for (const [key, rec] of meta.nodeMeta) {
    const injects =
      typeof rec.note === 'string' ||
      (typeof rec.image === 'string' && isSafeImageUrl(rec.image)) ||
      typeof rec.hyperlink === 'string' ||
      typeof rec.hyperlinkTitle === 'string' ||
      (Array.isArray(rec.tags) && rec.tags.every((t) => typeof t === 'string')) ||
      isPlainObj(rec.generalization) ||
      isPlainObj(rec.outerFrame)
    if (injects) keys.add(key)
  }
  return keys
}

/** 激活节点装饰就地提取（面板回填源）——decorations.ts extractDecorations 的单节点粒度镜像：
 *  现成导出只有整树 walking（单节点复用须造伪树，且 targets 解析不到会制造逐线 warn 噪声），
 *  故就地按同粒度对齐五面板字段（note/image+imageTitle/hyperlink+hyperlinkTitle/tag→tags/
 *  generalization；outerFrame 无面板字段不提；非法 image 不回填——与 extract 同口径） */
function extractActiveDecos(node: unknown): Record<string, unknown> {
  const d = nodeDataOf(node)
  const rec: Record<string, unknown> = {}
  if (!d) return rec
  if (typeof d.note === 'string') rec.note = d.note
  if (typeof d.image === 'string' && isSafeImageUrl(d.image)) {
    rec.image = d.image
    if (typeof d.imageTitle === 'string') rec.imageTitle = d.imageTitle
  }
  if (typeof d.hyperlink === 'string') rec.hyperlink = d.hyperlink
  if (typeof d.hyperlinkTitle === 'string') rec.hyperlinkTitle = d.hyperlinkTitle
  if (Array.isArray(d.tag)) rec.tags = [...d.tag]
  if (isPlainObj(d.generalization)) rec.generalization = d.generalization
  return rec
}

/** MP2-TH mount 回放校验：meta.mindview.custom 形态闸（theme:string + custom={base:string,
 *  overrides:object} 齐备）——parseMindMeta 对 custom 对象字段零损透传（meta.ts spread 保留，
 *  零改 meta.ts），校验归胶水；任一不满足=custom 通道缺席（畸形防御回退既有基线链路，零抛；
 *  MindViewMeta 类型面无 custom 键——载荷面按 unknown 读取） */
function customStateOfMindview(mv: { theme?: unknown; custom?: unknown }): MindCustomThemeState | null {
  if (typeof mv.theme !== 'string' || !isPlainObj(mv.custom)) return null
  const custom = mv.custom as { base?: unknown; overrides?: unknown }
  if (typeof custom.base !== 'string' || !isPlainObj(custom.overrides)) return null
  return { name: mv.theme, base: custom.base, overrides: custom.overrides }
}

export async function createMindEditorSurface(opts: MindEditorSurfaceOpts): Promise<AppInstance> {
  const { el, text, ctx, file, t, onDirty, onReadonly } = opts

  // ── 状态面 ──
  let dirty = false
  let saving = false
  // MP2-Q3-C（MP2-R2 P2-2）导入重入闩：闭包级（与 saving/viewOverride 同域形态）——
  // runXmindImport 全链（arrayBuffer 解码→unzip→setData→markDirty）飞行期间为真，
  // 重入派发（连选两文件）静默拒（先到先得，末到不覆盖）
  let importBusy = false
  let readonly = false
  let disposed = false
  // 初始基线闩：首个 node_tree_render_end 前一律忽略 data_change（渲染完成即初始基线）。
  // 门控对一切 render_end 前的 data_change 生效——含 jsdom mock（mock 的 emit 同样走门控，
  // 测试侧既有用例已按新契约补 node_tree_render_end 前奏）；e2e 为本门控主验收
  let initialBaselineSet = false
  // MP1 会话视图态覆写闭包（本批）：切换器 change 记录（仅记已切换轴）、resetToSaved 清空；
  // mergedMeta 的 _mindview 通道据此区分「文件原值复用（无覆写，字节零漂移）」vs「完整记录
  // 重写（有覆写）」。const 对象可变字段形态（不整体重赋值——闭包读侧零 TDZ/窄化陷阱）
  const viewOverride: { layout?: string; theme?: string } = {}

  // ── 容器骨架：宿主 el 直供引擎（absolute inset 防塌陷），工具栏浮层叠加 ──
  const prevElPos = el.style.position
  el.style.position = 'relative'
  const style = document.createElement('style')
  style.textContent = `
.mmagic-mind{position:absolute;inset:0;overflow:hidden;background:var(--app-bg-card,#fff)}
.mmagic-mind__bar{position:absolute;top:8px;left:8px;right:8px;z-index:20;display:flex;align-items:center;gap:3px;padding:4px 8px;
  background:var(--app-bg-card,#fff);border:1px solid var(--app-separator,#e5e7eb);border-radius:8px;
  box-shadow:0 2px 8px rgba(0,0,0,.08)}
.mmagic-mind__badge{font-size:12px;padding:1px 8px;border-radius:999px;
  background:var(--app-bg-muted,#f5f5f5);color:var(--app-text-secondary,#666);white-space:nowrap}
.mmagic-mind__badge:empty{display:none}
/* UA 缺省 margin 会把引擎 foreignObject 文本推出节点框（plan.md §十）——容器域 reset */
.mmagic-mind p{margin:0;padding:0}
/* 属性面板（MC3b；DOM 工厂=mindPanel.ts，样式 scoped 本容器域——唯一注入点，flow-editor 面板同构） */
.mmagic-mind-panel{position:absolute;top:46px;right:8px;z-index:20;display:none;flex-direction:column;gap:6px;width:224px;padding:10px;
  background:var(--app-bg-card,#fff);border:1px solid var(--app-separator,#e5e7eb);border-radius:8px;
  box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px}
.mmagic-mind-panel.is-open{display:flex}
.mmagic-mind-panel .row{display:flex;align-items:flex-start;gap:6px}
.mmagic-mind-panel label{color:var(--app-text-secondary,#666);flex:none;min-width:56px;line-height:24px}
.mmagic-mind-panel input,.mmagic-mind-panel textarea{
  font:inherit;padding:2px 6px;border:1px solid var(--app-separator,#e5e7eb);border-radius:4px;
  background:var(--app-bg-card,#fff);color:var(--app-text-primary,#111);width:100%;min-width:0;box-sizing:border-box}
.mmagic-mind-panel textarea{min-height:52px;resize:vertical}
.mmagic-mind-panel .is-invalid{border-color:var(--app-color-danger,var(--el-color-danger,#ff3b30))}
.mmagic-mind-panel__foot{justify-content:flex-end}
.mmagic-mind-panel button{font:inherit;padding:2px 10px;border:1px solid var(--app-separator,#e5e7eb);border-radius:4px;
  background:var(--app-bg-muted,#f5f5f5);color:var(--app-text-primary,#111);cursor:pointer}
/* 容器自有 icon 钮（MP2-UI 美化批：大纲/主题样式/导入三钮 icon 化——flow__bar 同语言：
 * ghost 28×28+15×15 stroke svg+title/aria 双通道；不进 shared 工具栏四键集——锁定例红线） */
.mmagic-mind__bar>button{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;
  border:1px solid transparent;border-radius:var(--app-radius-button,6px);background:var(--app-bg-card,#fff);
  color:var(--app-text-secondary,#57606a);cursor:pointer;font-size:0;transition:background .15s,color .15s,border-color .15s}
.mmagic-mind__bar>button:hover:not(:disabled){background:var(--app-bg-muted,#eaeef2);color:var(--app-text-primary,#1f2328);
  border-color:var(--app-separator,rgba(127,127,127,.25))}
.mmagic-mind__bar>button:disabled{opacity:.4;cursor:not-allowed}
.mmagic-mind__bar>button svg{width:15px;height:15px;display:block}
/* 容器自有 select（MP1 视图态切换器 data-act='layout'/'theme' 两枚+MP2-E1 导出控件
 * data-act='export'+MP2-TP 模板控件 data-act='templates'——不进 shared 工具栏四键集；
 * 28px 高+12px 字号=icon 钮节奏对齐；max-width 抑制长枚举标签把条撑爆） */
.mmagic-mind__bar>select{height:28px;font-size:12px;padding:0 4px;border:1px solid var(--app-separator,#e5e7eb);border-radius:var(--app-radius-button,6px);
  background:var(--app-bg-card,#fff);color:var(--app-text-primary,#111);cursor:pointer;max-width:120px}
/* 「下载要最右」：导出 select 推至条右端（只读徽标前） */
.mmagic-mind__bar>select[data-act='export']{margin-left:auto}
/* 分组分隔（flow__bar .sep 同语言） */
.mmagic-mind__bar .sep{flex:none;width:1px;height:18px;background:var(--app-separator,#e5e7eb);margin:0 5px}
/* 大纲视图（MC3c；DOM 工厂=mindOutline.ts，样式 scoped 本容器域——唯一注入点） */
.mmagic-mind-outline{position:absolute;inset:0;z-index:15;display:none;overflow:auto;padding:12px 16px;
  background:var(--app-bg-card,#fff);color:var(--app-text-primary,#111);font-size:13px}
.mmagic-mind-outline.is-open{display:block}
.mmagic-mind-outline .row{line-height:2;cursor:pointer;border-radius:4px;white-space:nowrap}
.mmagic-mind-outline .row:hover{background:var(--app-bg-muted,#f5f5f5)}
/* 搜索浮条（MC3c；DOM 工厂=mindSearch.ts） */
.mmagic-mind-search{position:absolute;top:46px;left:50%;transform:translateX(-50%);z-index:22;display:none;align-items:center;gap:4px;padding:4px 8px;
  background:var(--app-bg-card,#fff);border:1px solid var(--app-separator,#e5e7eb);border-radius:8px;
  box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px}
.mmagic-mind-search.is-open{display:flex}
.mmagic-mind-search input{font:inherit;padding:2px 6px;border:1px solid var(--app-separator,#e5e7eb);border-radius:4px;
  background:var(--app-bg-card,#fff);color:var(--app-text-primary,#111);width:160px;min-width:0;box-sizing:border-box}
.mmagic-mind-search button{font:inherit;padding:2px 8px;border:1px solid var(--app-separator,#e5e7eb);border-radius:4px;
  background:var(--app-bg-muted,#f5f5f5);color:var(--app-text-primary,#111);cursor:pointer}
.mmagic-mind-search__count{min-width:36px;text-align:center;color:var(--app-text-secondary,#666);font-variant-numeric:tabular-nums}
/* 主题样式面板（MP2-TH；DOM 工厂=mind/themePanel.ts，样式 scoped 本容器域——唯一注入点，
 * mindPanel 族同构；left 侧浮置避让属性面板 right 位） */
.mmagic-mind-theme-panel{position:absolute;top:46px;left:8px;z-index:20;display:none;flex-direction:column;gap:6px;width:224px;padding:10px;
  background:var(--app-bg-card,#fff);border:1px solid var(--app-separator,#e5e7eb);border-radius:8px;
  box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px}
.mmagic-mind-theme-panel.is-open{display:flex}
.mmagic-mind-theme-panel .row{display:flex;align-items:center;gap:6px}
.mmagic-mind-theme-panel label{color:var(--app-text-secondary,#666);flex:none;min-width:56px;line-height:24px}
.mmagic-mind-theme-panel input,.mmagic-mind-theme-panel select{font:inherit;padding:2px 6px;border:1px solid var(--app-separator,#e5e7eb);border-radius:4px;
  background:var(--app-bg-card,#fff);color:var(--app-text-primary,#111);width:100%;min-width:0;box-sizing:border-box}
.mmagic-mind-theme-panel button{font:inherit;padding:2px 10px;border:1px solid var(--app-separator,#e5e7eb);border-radius:4px;
  background:var(--app-bg-muted,#f5f5f5);color:var(--app-text-primary,#111);cursor:pointer}
.mmagic-mind-theme-panel__foot{justify-content:flex-end}
`
  el.replaceChildren(style)
  // .mmagic-mind 现承担两职：样式规则域（上方 inset/p reset 规则以此类为作用域——宿主
  // el 本无此类，mount 挂上才使规则生效）+ e2e 面断言锚；dispose 对称移除（幂等）
  el.classList.add('mmagic-mind')

  // ── 解析 + meta 视图态（缺省口径：无 _mindview → logicalStructure + xm-green） ──
  const base = parseMindmap(text)
  const meta = parseMindMeta(text)
  // MC3-V3 P0：mount 期合法装饰键集 L（闭包持有，mergedMeta strip 合并准入闸）——纯 meta
  // 派生；reset 走 mount 同链（同一 meta）→ L 无需重算。依据与镜像条件见 legalDecorKeys 注
  const legalKeys = legalDecorKeys(meta)
  // 文件装饰注入引擎树（apply-on-load）＝P1 装饰可见性，裁决 MC3b-C2：meta.nodeMeta 六类装饰
  // 按文本路径键注入 opt.data（面板激活节点可见既有装饰；fixture 无 meta 时空转零污染）；
  // MC3d：_assoc 关联线注入续接其后（两通道键域不相交——组合序与反序深等价，序不钉）
  const data = applyAssociativeLines(applyDecorations(toEngineTree(base), meta), meta)
  // MP1-UI-R P2-1 视图基线（本批）：select 回显/reset 还原/mergedMeta _mindview 通道的统一
  // 正本——初始=文件 _mindview 记录两轴（缺轴/无行以缺省 logicalStructure/xm-green 补位，
  // 与 mount 缺省口径同源）；save() 成功路径把本次落盘的视图记录转正为基线（主代理裁决：
  // 基线随保存更新，仅转正常量/仅清 viewOverride 不够——否则 reset 回显与再保存把已存盘
  // 视图回退成打开时视图，mindEditor.test.ts「MP2-P-T 修整批」例 1 红例）。const 对象可变
  // 字段形态（同 viewOverride——闭包读侧零 TDZ/窄化陷阱）
  const mindviewBaseline: { layout: string; theme: string } = {
    layout: meta.mindview?.layout ?? 'logicalStructure',
    theme: meta.mindview?.theme ?? 'xm-green',
  }
  // 基线转正标记：false=基线仍=文件记录 → mergedMeta 无覆写分支沿 meta.mindview 原对象
  // 复用（JSON 键序/额外字段保真=字节零漂移，mind-04 零 diff 红线与 MP1 零 diff 守卫例）；
  // true=已随保存转正 → 无覆写分支产基线记录（再保存/reset 回显沿已存盘视图，不回退打开
  // 时视图）
  let mindviewBaselinePromoted = false
  // mount 现效值（引擎初值/切换器初显）由基线派生——t0 时基线即文件记录，值与旧 const 同源
  const layout = mindviewBaseline.layout
  const theme = mindviewBaseline.theme
  // ── MP2-TH 会话自定义主题态（本批）：sessionCustom=会话现效 custom（apply 产出/reset
  //    归位还原/changeTheme 切走清空），savedCustom=已存盘正本（保存成功随落盘刷新——
  //    reset 归位还原正本，MP1-UI-R P2-1 转正链同族）；与 MP1 两通道（mindviewBaseline/
  //    viewOverride select 链）键域隔离——custom 在场时 mergedMeta 走 custom 完整记录分支
  //    （layout 轴仍沿 viewOverride 覆写优先），theme select 的 viewOverride.theme 通道让位
  //    （changeTheme 显式清 custom）。声明先于 mount 回放块赋值（闭包读侧：baseOf/mergedMeta/
  //    resetToSaved 零 TDZ）
  let sessionCustom: MindCustomThemeState | null = null
  let savedCustom: MindCustomThemeState | null = null
  // 面板计数器起点（mount 回放已占名 mind-custom-<k> → k——首 apply 铸 k+1 避同名再注册
  // no-op 滞留旧 cfg；无回放=0 → mind-custom-1）
  let customCounterStart = 0
  // MP2-R5 N1：本 surface 自定义主题名录（引擎主题注册表=模块级单例，跨 mm.destroy() 存续
  // 且生产零 removeTheme；同名再注册=静默 no-op index.js:836-841 滞留陈旧 cfg——本 surface
  // 计数器从 0/回放序号起铸名→下个 surface 同名 apply/回放被 no-op 吞=错显陈旧 cfg，形态 b
  // 「mount 即错显零用户动作」）。收录面=mount 回放名+面板 apply 铸名两通道；dispose 链
  // mm.destroy() 前逐名 cast-optional removeTheme 回收+clear（真引擎 index.js:843-846 置 null
  // 非 delete——initTheme `theme[name] || theme.default` 对 null 安全回退 default，置 null 后
  // falsy 可重注册=引擎实证）。多 surface 同页并存边缘（现产品单开）：仅回收本 surface 名录，
  // 其它实例 themeConfig=合并拷贝不受影响——记账
  const customDefinedNames = new Set<string>()

  // ── 主题注册（实例化前，测试钉 log 序）+ 插件注册（防护式——MC2-R2 后补断言） ──
  for (const [name, cfg] of Object.entries(MIND_THEMES)) MindMap.defineTheme(name, cfg)
  // ── MP2-TH mount 回放（custom 通道，本批）：meta.mindview.custom 在场 → base⊕overrides
  //    合成 defineTheme——须先于实例化（log 序红线：未注册名 initTheme 回退 default，晚于
  //    construct 则回放失效）；生效通道=constructor opt.theme（theme 常量=基线直读
  //    meta.mindview.theme=回放名，opt 面构造期生效）；零 dirty——mount 期恢复非编辑。
  //    面板计数器起点随回放名序号递进（回放占 mind-custom-1 → 首 apply 铸 mind-custom-2，
  //    同名再注册=no-op 避撞）；savedCustom 同步回放态（reset 归位正本=已存盘）
  const replayCustom = meta.mindview !== null ? customStateOfMindview(meta.mindview) : null
  if (replayCustom !== null && replayCustom.base in MIND_THEMES) {
    const baseCfg = (MIND_THEMES as Record<string, Record<string, unknown>>)[replayCustom.base] ?? MIND_THEMES['xm-green']
    MindMap.defineTheme(replayCustom.name, mergeThemeCfg(baseCfg, replayCustom.overrides))
    customDefinedNames.add(replayCustom.name) // MP2-R5 N1：回放定义名入回收名录（回放通道亦占引擎注册表）
    sessionCustom = replayCustom
    savedCustom = replayCustom
    const probed = /^mind-custom-(\d+)$/.exec(replayCustom.name)
    if (probed !== null) customCounterStart = Number(probed[1] ?? '0')
  }
  if (typeof MindMap.usePlugin === 'function') {
    // 真实引擎 hasPlugin 去重，多实例重复注册无害；mock 无此静态 → 静默跳过。
    // 装配序测试钉死：Drag→Select→KeyboardNavigation→Search（MC3c 批第四件，实例挂
    // mm.search，instanceName 'search' 实测）→AssociativeLine→OuterFrame（MC3d 批收口——
    // 关联线/外框 P1-3 裁决①，两插件包内源码 MIT 可用）→Export（MP2-E1 批末位——png/svg/
    // json 导出面，实例挂 mm.doExport，instanceName 'doExport' Export.js:458 实测；opml
    // 非插件类型不路由引擎=业务侧 mind/opml.ts）
    MindMap.usePlugin(Drag)
    MindMap.usePlugin(Select)
    MindMap.usePlugin(KeyboardNavigation)
    MindMap.usePlugin(Search)
    MindMap.usePlugin(AssociativeLine)
    MindMap.usePlugin(OuterFrame)
    MindMap.usePlugin(Export)
  }

  const mm = new MindMap({ el, data, layout, theme })

  // ── 统一工具栏（save/undo/redo/reset 四键，shared/editToolbar 唯一样式源）──
  //    初始禁用钮由 setDirty(true) 启用（editToolbar reset 初始 disabled 契约）
  const bar = document.createElement('div')
  bar.className = 'mmagic-mind__bar'
  const toolbar = createEditToolbar(
    { save: ctx.t('app.edt-save'), undo: ctx.t('app.edt-undo'), redo: ctx.t('app.edt-redo'), reset: ctx.t('app.edt-reset') },
    { onSave: () => void save(), onUndo: () => undo(), onRedo: () => redo(), onReset: resetToSaved },
  )
  const badge = document.createElement('span')
  badge.className = 'mmagic-mind__badge'
  // 大纲切换钮（MC3c）：容器自有钮（data-act='outline'），不进 shared 工具栏四键集（锁定例
  // 红线——.mmx-edt__btn[data-act] 恒等 save/undo/redo/reset）；readonly 仍可用=视图态零写路径
  const outlineBtn = document.createElement('button')
  outlineBtn.type = 'button'
  outlineBtn.setAttribute('data-act', 'outline')
  // MP2-UI 美化批：文本钮→icon 钮（flow 同语言）——title/aria 双通道保留 i18n 面
  outlineBtn.innerHTML = MIND_BAR_ICONS.outline
  const outlineLabel = t('app.mind-outline.toggle')
  outlineBtn.setAttribute('title', outlineLabel)
  outlineBtn.setAttribute('aria-label', outlineLabel)
  outlineBtn.addEventListener('click', toggleOutline)
  // ── MP1 视图态切换器（本批）：容器自有 select×2（data-act='layout'/'theme'），与大纲钮
  //    同族（不进 shared 工具栏四键集——锁定例红线）；现态回显=mount 现效值（layout/theme
  //    由视图基线 mindviewBaseline 派生：初始=meta.mindview 或缺省 logicalStructure/xm-green，
  //    与 mount 缺省口径同源；保存转正后基线=已存盘视图，reset 回显随基线——见基线声明注）；
  //    选项枚举序=plan §五布局 7 项+themes.ts 注册序主题 4 项；i18n 面=aria-label/title 走
  //    t(app.mind-view.layout|theme)、选项文本走 t(app.mind-view.<act>.<枚举>)
  const LAYOUT_OPTIONS = ['logicalStructure', 'mindMap', 'organizationStructure', 'fishbone', 'timeline', 'verticalTimeline', 'catalogOrganization'] as const
  const THEME_OPTIONS = ['xm-green', 'xm-blue', 'xm-slate', 'xm-amber'] as const
  function createViewSelect(act: 'layout' | 'theme', options: readonly string[], current: string, onChange: (value: string) => void): HTMLSelectElement {
    const sel = document.createElement('select')
    sel.setAttribute('data-act', act)
    const label = t(`app.mind-view.${act}`)
    sel.setAttribute('aria-label', label)
    sel.setAttribute('title', label)
    for (const v of options) {
      const opt = document.createElement('option')
      opt.value = v
      opt.textContent = t(`app.mind-view.${act}.${v}`)
      sel.appendChild(opt)
    }
    sel.value = current
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }
  /** 引擎切换 API 面（setLayout index.js:436-445 / setTheme index.js:379-388）：cast optional
   *  调用——ambient d.ts（src/types/simple-mind-map.d.ts）只收胶水触达面未声明此二成员，
   *  mock 缺省亦无 setLayout（setTheme 有类方法但不回写 opt）；MP1 测试侧 seedViewFace 播种 */
  function callViewApi(name: 'setLayout' | 'setTheme', value: string): void {
    ;(mm as unknown as Record<string, ((v: string) => void) | undefined>)[name]?.(value)
  }
  // 切换行为（本批口径裁决）：覆写闭包记录 → 引擎切换 → 显式 markDirty——引擎切换路径
  // 不 emit data_change（仅 layout_change/view_theme_change），脏标业务侧显式承担；readonly
  // 闩锁下 markDirty 自早退（纯视图态零写路径，与大纲钮「readonly 仍可用」同族口径）
  // MP2-R4 P2-1 分界线：视图态族 saving 窗不闩=CAS 存活护航（:967-992）；模板/导入/面板
  // apply=内容写族无护航故闩
  function changeLayout(value: string): void {
    viewOverride.layout = value
    callViewApi('setLayout', value)
    markDirty()
  }
  function changeTheme(value: string): void {
    viewOverride.theme = value
    // MP2-TH：主题 select 切走=显式弃用会话 custom——sessionCustom 清空+面板回基线缺省
    // （savedCustom 留档——reset 归位还原已存盘态）；mergedMeta custom 分支自此让位 MP1 分支
    if (sessionCustom !== null) {
      sessionCustom = null
      themePanelApi.echo({})
    }
    callViewApi('setTheme', value)
    markDirty()
  }
  const layoutSelect = createViewSelect('layout', LAYOUT_OPTIONS, layout, changeLayout)
  const themeSelect = createViewSelect('theme', THEME_OPTIONS, theme, changeTheme)
  // ── MP2-E1 导出控件（本批）：容器自有 select（data-act='export'），与 MP1 两 select 同族
  //    （不进 shared 工具栏四键集——锁定例红线）；选项=四格式齐序（EXPORT_FORMATS 钉死）；
  //    i18n 面=aria-label/title 走 t(app.mind-export.do)、选项文本走 t(app.mind-export.<fmt>)；
  //    导出为动作非状态——change 派发导出后复位回首项（置 selectedIndex 不触发 change）
  const exportBaseName = (() => {
    const dot = file.name.lastIndexOf('.')
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name
    return stem !== '' ? stem : 'mindmap' // 无文件名兜底（真引擎缺省导出名思维导图，Export.js:24）
  })()
  function runExport(fmt: string): void {
    // 只读操作全链：不触 markDirty/onDirty/setData/updateData（dirty 守卫例钉）；readonly
    // 不闩（导出=视图态零写路径，与大纲钮同族口径）
    if (fmt === 'opml') {
      // 业务侧纯函数链：opml 非 Export 插件类型（引擎 export('opml') 落 Export.js:32 null，
      // 禁路由 doExport）——实时取引擎现态（大纲同源 mm.getData()），树缺省零产零下载
      const tree = mm.getData() as EngineNode | null
      if (!tree) return
      downloadOpml(opmlFromOutline(outlineFromTree(tree)), `${exportBaseName}.opml`)
      return
    }
    // png/svg/json=引擎 Export 插件面透传：export(fmt, true, 导出名)（Export.js:24 面，
    // isDownload=true=真下载语义；导出名=打开文件名去扩展，引擎拼 '.<fmt>' 后缀落盘 :28）；
    // cast optional 防护调用——mock 缺省无 doExport（真引擎 usePlugin(Export) 后实例挂载），
    // 测试侧 seedExportFace 播种
    const face = (mm as unknown as { doExport?: MindExportFace }).doExport
    void face?.export?.(fmt, true, exportBaseName)
  }
  const exportSelect = document.createElement('select')
  exportSelect.setAttribute('data-act', 'export')
  const exportLabel = t('app.mind-export.do')
  exportSelect.setAttribute('aria-label', exportLabel)
  exportSelect.setAttribute('title', exportLabel)
  for (const fmt of EXPORT_FORMATS) {
    const opt = document.createElement('option')
    opt.value = fmt
    opt.textContent = t(`app.mind-export.${fmt}`)
    exportSelect.appendChild(opt)
  }
  exportSelect.addEventListener('change', () => {
    runExport(exportSelect.value)
    exportSelect.selectedIndex = 0 // 动作非状态：派发后复位回首项
  })
  // ── MP2-X1 导入控件（本批）：容器自有钮（data-act='xmind-import'）+隐藏 file input——
  //    与大纲钮/导出 select 同族（不进 shared 工具栏四键集——锁定例红线）；钮=选文件入口
  //    （click→input.click() 打开选择器），change 捕获 File 后 input.value='' 复位（同文件
  //    重选仍触发 change）；隐藏机制不钉（display:none——测试面只钉 type/accept 两属性）。
  //    导入=数据写路径（替换现内容走 dirty 保存链），与导出「视图态零写路径不闩」不可类比：
  //    readonly 受闩——setReadonly 禁钮+处理器 readonly 早退双闸（undo/redo 同族口径）
  const xmindImportBtn = document.createElement('button')
  xmindImportBtn.type = 'button'
  xmindImportBtn.setAttribute('data-act', 'xmind-import')
  // MP2-UI 美化批：文本钮→icon 钮（托盘+上行箭头）——补 title（原缺，仅 aria）
  xmindImportBtn.innerHTML = MIND_BAR_ICONS.xmindImport
  const importLabel = t('app.mind-import.do')
  xmindImportBtn.setAttribute('title', importLabel)
  xmindImportBtn.setAttribute('aria-label', importLabel)
  xmindImportBtn.addEventListener('click', () => xmindInput.click())
  const xmindInput = document.createElement('input')
  xmindInput.type = 'file'
  xmindInput.accept = '.xmind'
  xmindInput.style.display = 'none'
  xmindInput.addEventListener('change', () => {
    const file = xmindInput.files?.[0]
    xmindInput.value = '' // 复位复用：清选后再异步消费（真实 DOM 设 value 即清 FileList，file 引用独立有效）
    if (file) void runXmindImport(file)
  })
  /** 导入行为链（MP2-X1）：arrayBuffer→unzipSync→content.json→xmindToMindmap→
   *  parseMindmap→toEngineTree→mm.setData(树)+显式 markDirty（引擎 setData 无 data_change
   *  侧信道，MP1 同族口径；setData 收引擎树=resetToSaved :889 同面）。坏链防御：任一环节
   *  throw（含 content.json 缺席——旧版 xmind8 content.xml 本批不钉）→console.warn 恰一次
   *  +零 setData/updateData+零 dirty（MIND_SAVE_ERR 同族告警面；导入失败不落不标脏）。
   *  MP2-Q3-C 双闩（MP2-R2 裁决正典，readonly 早退闸之后）：
   *  ①P2-1 saving 闩——putObject 飞行窗内拒导入。窗内 setData+markDirty 会被保存收尾
   *    置假三连吞（收尾守卫只查 viewOverride 残轴不查内容脏）→dispose 静默丢导入内容；
   *    窄窗静默拒=安全侧（用户保存完成后重试即可），不加 warn（R2 最小修复集口径）。
   *  ②P2-2 importBusy 重入闩——首链挂起窗（await arrayBuffer）内连选第二文件丢弃
   *    （先到先得，末到不覆盖=并发 setData「末到胜」红例的闩拒面）。 */
  async function runXmindImport(file: File): Promise<void> {
    if (readonly) return // readonly 闸 2（setReadonly 禁钮闸 1 的兜底双闸——编程派发 change 面）
    if (saving) return // P2-1：保存飞行窗内拒导入（窄窗静默拒=安全侧，保存完成后重试）
    if (importBusy) return // P2-2：重入拒（连选第二文件丢弃，先到先得）
    importBusy = true
    try {
      const buf = await file.arrayBuffer()
      // MP2-R3（Q3 P2-1 镜像窗复检 + 记账①）：入口 saving 闩只拦「保存先起飞」——挂起窗内
      // 保存后起飞时，恢复落在保存飞行窗内，setData+markDirty 被收尾置假三连吞 → dispose
      // 静默丢导入内容。恢复后补两复检（try 内前置：return 走 finally，importBusy 照常收闩）：
      if (saving) return // 镜像窗内保存已读旧树，迟导入拒（窄窗静默=安全侧，下次可重试）
      if (disposed) return // R3 记账①：dispose 后零写（写已销毁引擎+脏标上抛宿主=静默幽灵态）
      // MP2-R4 P2-3（注记）：镜像窗内 readonly 可翻转（真域=putObject 拒 4305→save catch→
      // setReadonly 唯一入口）——闩锁封写面，恢复链 setData/markDirty 落已闩锁面=写路径穿透，
      // 复检须补 readonly（与入口 :636 闸 2 同面：setReadonly 禁钮闸 1 的兜底双闸——镜像窗
      // 挂起期间禁钮未及覆盖此链）
      if (readonly) return
      const entries = unzipSync(new Uint8Array(buf))
      const entry = entries['content.json']
      if (entry === undefined) throw new Error('content.json 缺席（旧版 xmind8 content.xml 面本批不钉）')
      const contentJson: unknown = JSON.parse(new TextDecoder().decode(entry))
      const imported = xmindToMindmap(contentJson)
      mm.setData(toEngineTree(parseMindmap(imported)))
      markDirty()
    } catch (err) {
      console.warn('MIND_IMPORT_ERR', String(err).slice(0, 200))
    } finally {
      importBusy = false
    }
  }
  // ── MP2-TP 模板控件（本批）：容器自有 select（data-act='templates'），MP1/导出 select
  //    同族（不进 shared 工具栏四键集——锁定例红线）；首项=占位（value=''，文本
  //    t(app.mind-templates.placeholder)——动作入口非状态回显，mount 初值=占位），其余选项=
  //    MIND_TEMPLATES 齐序（value=id、文本=t(nameKey)，名称 i18n 面 mind-templates.items.<id>
  //    ——数据源 mind/templates.ts）；aria-label/title 走 t(app.mind-templates.do)（导出/导入
  //    do 键命名族同构）
  const templateSelect = document.createElement('select')
  templateSelect.setAttribute('data-act', 'templates')
  const templateLabel = t('app.mind-templates.do')
  templateSelect.setAttribute('aria-label', templateLabel)
  templateSelect.setAttribute('title', templateLabel)
  const templatePlaceholder = document.createElement('option')
  templatePlaceholder.value = ''
  templatePlaceholder.textContent = t('app.mind-templates.placeholder')
  templateSelect.appendChild(templatePlaceholder)
  for (const tpl of MIND_TEMPLATES) {
    const opt = document.createElement('option')
    opt.value = tpl.id
    opt.textContent = t(tpl.nameKey)
    templateSelect.appendChild(opt)
  }
  templateSelect.addEventListener('change', () => {
    // MP2-R3 P1-1：saving 闩与 runXmindImport :545 同族口径（readonly 闸同首行合写）——保存
    // 飞行窗内（putObject 未决）选模板 → setData+markDirty 落窗内 → 保存收尾置假三连吞掉
    // 模板脏 → dispose 静默丢模板内容；窄窗静默拒=安全侧（保存完成后重选即可，P2-1 同款不加 warn）
    if (readonly || saving) {
      // MP2-R4 P2-2：闩拒早退亦复位占位（R4 P2-2 注记）——native DOM 语义：value 残留所选值时
      // 同项重选不触发 change=闩拒后须先选他项再回；复位占位=用户可立即重选同项（保存完成后）。
      // readonly 分支共用无害：readonly 时控件已 disabled（setReadonly 闸 1），编程派发面下
      // value 复位零可见副作用（成功路径 :690 复位同款——复位不吞后续选择）
      templateSelect.value = ''
      return // readonly 闸 2（setReadonly 禁用控件闸 1 的兜底双闸——编程派发 change 面）
    }
    const id = templateSelect.value
    templateSelect.value = '' // 动作非状态：复位占位（导出 select 复位同款——复位不吞后续选择）
    if (id === '') return
    const tpl = MIND_TEMPLATES.find((item) => item.id === id)
    if (!tpl) return
    // 模板替换=数据写路径（.xmind 导入同链）：parseMindmap→toEngineTree→mm.setData(树)+
    // 显式 markDirty（引擎 setData 无 data_change 侧信道——MP1「脏标业务侧显式承担」同族口径）
    mm.setData(toEngineTree(parseMindmap(tpl.content)))
    markDirty()
  })
  // ── MP2-TH 主题样式面板钮（本批）：容器自有钮（data-act='theme-style'），大纲/导入钮
  //    同族（不进 shared 工具栏四键集——锁定例红线）；click→浮动面板开合（toggle——面板
  //    mindPanel 族同构 mount 即挂入隐藏，监听闭包晚绑 themePanelApi 零 TDZ——outlineBtn→
  //    toggleOutline 同族先例）；readonly 闸 1=setReadonly 禁钮（apply 处理器 canApply
  //    readonly 早退=兜底双闸，导入/模板写路径族同款）
  const themeStyleBtn = document.createElement('button')
  themeStyleBtn.type = 'button'
  themeStyleBtn.setAttribute('data-act', 'theme-style')
  // MP2-UI 美化批：文本钮→icon 钮（双滑杆）——title/aria 双通道保留 i18n 面
  const themeStyleLabel = t('app.mind-theme-panel.do')
  themeStyleBtn.innerHTML = MIND_BAR_ICONS.themeStyle
  themeStyleBtn.setAttribute('aria-label', themeStyleLabel)
  themeStyleBtn.setAttribute('title', themeStyleLabel)
  themeStyleBtn.addEventListener('click', () => themePanelApi.toggle())
  // ── MP2-UI 美化批：分组编排（flow__bar 同语言）——[统一钮簇]｜[视图态：布局/主题/大纲/
  //    主题样式]｜[内容：模板/导入] ⟶ 右推 [下载导出]（margin-left:auto=「下载要最右」口径）
  //    ＋只读徽标收尾；sep 分隔组间
  const sep = (): HTMLDivElement => {
    const s = document.createElement('div')
    s.className = 'sep'
    bar.appendChild(s)
    return s
  }
  bar.append(toolbar.el)
  sep()
  bar.append(layoutSelect, themeSelect, outlineBtn, themeStyleBtn)
  sep()
  bar.append(templateSelect, xmindImportBtn, exportSelect, xmindInput, badge)
  el.appendChild(bar)

  // ── 属性面板（MC3b）：宿主 el 内 absolute 浮层（样式域=上方注入块），生命周期随 dispose ──
  let activeNode: unknown = null
  const panel = createMindPanel({ el, t, onEdit: applyPanelPatch })

  // ── 主题样式面板（MP2-TH）：浮动面板工厂挂宿主（mindPanel 族同构——mount 即挂入隐藏，
  //    is-open 在场=显示），生命周期随 dispose；依赖面注入（t/mm/回调三件）：canApply=
  //    readonly 双闸之二+saving 飞行窗闩（内容写族口径——窗内 apply 会被保存收尾置假三连吞），
  //    baseOf=sessionCustom.base ?? viewOverride.theme 覆写轴 ?? 视图基线主题名（合成基准
  //    cfg+回显缺省值来源——MP2-R5 N2：基准=用户眼前主题；theme select 切走清 custom 后自回
  //    现效主题），onDefine 转接 MindMap.defineTheme（defineTheme
  //    先于 mm.setTheme 生效序由工厂钉死），onApplied=会话 custom 态记录+显式 markDirty
  //    （写路径口径——引擎 setTheme 无 data_change 侧信道，MP1 同族）；回显随 mount 现效
  //    custom（回放在场=回放 overrides+触轴标记补齐，否则基线缺省）
  const themePanelApi = createMindThemePanel({
    el,
    t,
    mm,
    canApply: () => !readonly && !saving,
    baseOf: () => {
      // MP2-R5 N2：合成基准=用户眼前主题——未存盘 changeTheme 切走基线主题后（viewOverride.theme
      // 覆写轴在场）apply/回显不得仍以旧基线为底铸 cfg（红实测 backgroundColor 落 xm-green 值 vs
      // 期望眼前 xm-blue）；无覆写沿基线原值=既有链零变化
      const baseName = sessionCustom !== null ? sessionCustom.base : (viewOverride.theme ?? mindviewBaseline.theme)
      const cfg = (MIND_THEMES as Record<string, Record<string, unknown>>)[baseName]
      return { name: baseName, cfg: cfg ?? MIND_THEMES['xm-green'] }
    },
    startIndex: customCounterStart,
    onDefine: (name, cfg) => {
      MindMap.defineTheme(name, cfg)
      customDefinedNames.add(name) // MP2-R5 N1：apply 铸名入回收名录（dispose 链逐名回收）
    },
    onApplied: (applied) => {
      sessionCustom = applied
      markDirty()
    },
  })
  themePanelApi.echo(sessionCustom !== null ? sessionCustom.overrides : {})

  // ── 大纲视图（MC3c）：懒建工厂+叠置形态（大纲面板 absolute 盖画布，引擎容器不动=切换零
  //    引擎副作用）；每次开启实时取 mm.getData()（编辑后现态）；readonly 仍可开（视图态零写路径）
  let outlineApi: MindOutlineApi | null = null
  let outlineOpen = false
  function toggleOutline(): void {
    if (outlineOpen) {
      outlineOpen = false
      outlineApi?.hide()
      return
    }
    if (!outlineApi) outlineApi = createMindOutline({ el, t, onLocate: locateByKey })
    const tree = mm.getData() as EngineNode | null
    if (tree) outlineApi.render(outlineFromTree(tree))
    outlineOpen = true
    outlineApi.show()
  }

  /** 大纲行定位：按键（buildNodeKey 文本路径键，行模型同源）在引擎现态树先序找节点 →
   *  GO_TARGET_NODE 防护调用（Search.js:190 同款命令面；Render.js:1966 goTargetNode 收 uid 串
   *  形态——终评 P2-2：真引擎树节点恒带 uid，仅 uid 串下发，无 uid 即 undefined 零调，与键漂移
   *  best-effort 同口径，不再兜底传节点引用）；定位后关大纲回画布。键漂移（找不到）best-effort 零调。
   *  寻节点=纯递归（无闭包回写——TS 对闭包赋值变量恒窄化 null 的陷阱，MC3c-C 实测 TS2339 never） */
  function findNodeByKey(node: EngineNode, key: string, path: string[]): EngineNode | null {
    const next = [...path, typeof node.data?.text === 'string' ? node.data.text : '']
    if (buildNodeKey(next) === key) return node
    for (const c of node.children ?? []) {
      const hit = findNodeByKey(c, key, next)
      if (hit) return hit
    }
    return null
  }
  function locateByKey(key: string): void {
    const tree = mm.getData() as EngineNode | null
    if (!tree) return
    const found = findNodeByKey(tree, key, [])
    if (!found) return
    const uid = typeof found.data.uid === 'string' && found.data.uid !== '' ? found.data.uid : null
    // 终评 P2-2：无 uid 即 undefined 零调（真引擎节点恒带 uid；不兜底传节点引用）
    if (uid === null) return
    mm.execCommand?.('GO_TARGET_NODE', uid)
    outlineOpen = false
    outlineApi?.hide()
  }

  // ── 搜索浮条（MC3c）：Ctrl+F 懒建+开（readonly 闩锁禁入=两闸 readonly 口径复用）；
  //    引擎面=Search 插件实例 mm.search 防护调用（mock 无此成员——测试侧按需播种 spy）
  let searchApi: MindSearchApi | null = null
  let lastSearchText = ''
  let searchIndex = -1
  let searchTotal = 0
  const searchFaceOf = (): MindSearchFace | undefined =>
    (mm as unknown as { search?: MindSearchFace }).search

  function openSearch(): void {
    if (readonly) return
    if (!searchApi) {
      searchApi = createMindSearch({
        el,
        t,
        onSearch: runSearch,
        onNext: searchNextFace,
        onPrev: searchPrevFace,
        onClose: endSearchFace,
      })
    }
    searchApi.open()
  }
  function runSearch(text: string): void {
    // 终评 P2-3：空串早退——不直通引擎 search('')（空文搜索语义未定义面）；lastSearchText
    // 不动（残留上轮文本，searchNextFace 的空串闸自兜底）
    if (!text) return
    lastSearchText = text
    searchFaceOf()?.search?.(text)
  }
  /** 「下一个」直通：同文本再 search＝引擎原生 next 语义（Search.js:76-78 实测——与上次
   *  搜索文本一样即 searchNext；异文=重搜跳首） */
  function searchNextFace(): void {
    if (lastSearchText === '') return
    searchFaceOf()?.search?.(lastSearchText)
  }
  /** 「上一个」＝jump(显式索引)：searchNext 无索引恒向下一个，倒退只能带索引
   *  （Search.js:205 jump→searchNext(callback,index)）；索引/总数自 search_info_change 追踪，
   *  0 基回绕（0→total-1）；无搜索态零调 */
  function searchPrevFace(): void {
    const face = searchFaceOf()
    if (!face?.jump || searchTotal <= 0) return
    face.jump(searchIndex > 0 ? searchIndex - 1 : searchTotal - 1)
  }
  function endSearchFace(): void {
    searchFaceOf()?.endSearch?.()
  }

  /** 引擎命令面（Command.js）：undo='BACK'、redo='FORWARD'——mock 无 execCommand 成员，
   *  optional 调用防护；真实引擎另注册 Control+z/y 快捷键，与按钮双通道 */
  function undo(): void {
    if (readonly) return
    mm.execCommand?.('BACK')
  }
  function redo(): void {
    if (readonly) return
    mm.execCommand?.('FORWARD')
  }

  /** 面板编辑 → 激活节点 data 补丁（防护式 execCommand；SET_NODE_DATA=Render.js:324 实证命令，
   *  setNodeData 逐键合并 node.nodeData.data——undefined 值=键置 undefined 即清除语义）。
   *  终评 P1-1：面板键→引擎字段映射——面板键属 meta 命名系（mindPanel FIELDS 与 nodeMeta
   *  记录同系），引擎 data 命名系为 tag（decorations applyRecord 同映射 tags→tag）；逐键
   *  改写后下发：仅 tags→tag 改名，其余键（note/image/imageTitle/hyperlink/hyperlinkTitle/
   *  generalization）直通，undefined 清除语义原样保持（undefined 键在 Object.entries 中
   *  键名存活）。
   *  脏标不在此处直调：引擎命令链自身触发 data_change → 两闸 → markDirty（门控正常路径）。
   *  终评 P2-1：命令落定后数据+历史已更新但画布未重渲——末尾防护式 mm.render?.() 补画布
   *  重渲（真引擎重渲触发 node_tree_render_end → view.fit 自适应随既有接线） */
  function applyPanelPatch(patch: Record<string, unknown>): void {
    if (readonly || activeNode === null) return
    const cmdPatch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) cmdPatch[k === 'tags' ? 'tag' : k] = v
    mm.execCommand?.('SET_NODE_DATA', activeNode, cmdPatch)
    mm.render?.()
  }

  function markDirty(): void {
    // 只读闩锁后数据面已封：编辑不再产生「可保存的脏」（flow-editor markDirty 同口径）
    if (readonly) return
    dirty = true
    toolbar.setDirty(true)
    onDirty?.(true)
  }
  /** 只读闩锁：4305 唯一入口（徽标 + 整簇隐藏 + onReadonly 上抛） */
  function setReadonly(): void {
    if (readonly) return
    readonly = true
    badge.textContent = t(READONLY_KEY)
    toolbar.setReadonly(true)
    xmindImportBtn.disabled = true // MP2-X1：导入=写路径随闩禁钮（change 处理器 readonly 早退=兜底双闸）
    templateSelect.disabled = true // MP2-TP：模板替换=写路径随闩禁控件（change 处理器 readonly 早退=兜底双闸，导入族同款）
    themeStyleBtn.disabled = true // MP2-TH：主题 apply=写路径随闩禁面板钮（canApply readonly 早退=兜底双闸，导入/模板族同款）
    onReadonly?.()
  }

  // ── 引擎事件接线（须在 toolbar 在场后注册，markDirty 闭包直引） ──
  // 挂载即 dirty 门控（重裁二修版，两闸串联；首版「历史条目 index」闸已被 e2e 证伪——见闸 2 注）：
  // 闸 1 基线闩：初始基线未立（首个 render_end 未到）时一律早退。
  // 闸 2 内容闸（command 在场＝真引擎才启用；mock 缺席直通，全部既有例语义不变）：引擎
  //  Command.addHistory 自身节流 300ms，初始化期条目请求先于首个 render_end、emit 落于
  //  其后（实测 render_end t+442ms → data_change t+531ms），闸 1 拦不住；且首编辑若与
  //  初始化条目落入同一节流窗（挂载后即刻编辑），throttle 丢弃第二笔请求、两笔合并为
  //  唯一历史条目——activeHistoryIndex===0 却携带编辑后内容（e2e mind-02 实证 3 红），
  //  故 index 判据不成立。改判内容：引擎现态走 save() 同一序列化链，== savedValue
  //  （打开时文本）＝非真编辑，忽略——即 dirty ⇔ 保存会改字节（mind-04 zerodiff 同源）。
  //  已知副作用（重裁接受，本闸下语义更优）：undo 回基线（内容==已存）同样忽略，脏态
  //  留存至下次编辑/保存；resetToSaved 的 setData 回灌也不再误翻红点；字节面无影响。
  /** MC3b 保存链装饰整合 + MC3d _assoc 整表替换：meta 拼接源=文件 meta ⊕ 引擎树装饰反提——
   *  以 parseMindMeta(text) 的 nodeMeta 为底，extractDecorations(引擎树).nodeMeta 按键字段级
   *  合并（MC3-F1 P1-2 + MC3-V2 N1 stripDecorFields 合并、MC3-V3 P0 准入闸换 L 通道：键∈L
   *  一律 strip 合并——extract 产键集内字段以引擎现态为准，引擎 undefined=清除，base 旧值不
   *  复活；非 extract 产键字段 style/custom/未知键自 base 保留；键∉L 键 base 记录原样保留
   *  （extract 在场则字段级 ∪ 并入会话新增装饰，MC3-V4 P1-1，见第二循环 ∉L∪ 注）；
   *  base 无该键记录→整记录新增=原行为——逐条依据见函数内 N1 注+legalDecorKeys 注）；
   *  schema/_mindview 沿文件原值；_assoc=extract 整表替换（MC3d 契约
   *  裁决②：extract 为保存时唯一真源——行非空写行恰一次禁与文件底 concat 双发射；空=行整体
   *  移除=删线持久化）。未编辑时 extract 产物=文件 meta 有损等值（_assoc 行集合等值沿用文件
   *  assoc 对象=字节零漂移，见 sameAssocLines）→ 零 diff 红线不破；
   *  反提异常保守回退文件 meta（同闸 2 口径：不放大为崩溃） */
  function mergedMeta(edited: EngineNode): MindMeta {
    try {
      const ext = extractDecorations(edited)
      const nodeMeta = new Map(meta.nodeMeta)
      // MC3-V2 N1【P1】清除装饰不复活（MC3-V3 P0 通道更换：mount 期合法装饰键集 L 取代引擎
      // data `in` 证据判别）——合并策略为 stripDecorFields 合并。复活链与不翻脏链：面板清除发
      // {field: undefined}（mindPanel 契约：undefined=清除）→SET_NODE_DATA 逐键置引擎
      // data[key]=undefined→真引擎 getData 经 JSON 深克隆剥 undefined 值键名（Command.js:
      // 177-181→utils/index.js:153-163 simpleDeepClone 实证=V3 P0 锚点，「undefined 键名存活」
      // 旧前提作废）→extractDecorations 对该键零产→base 旧值不被删即复活；且闸 2
      // engineStateIsSaved 走同一 mergedMeta 链、序列化相等早退→清除编辑连 dirty 都不翻
      // （红例双形态实证，mindEditor.test.ts「MC3-V2（N1）清除装饰不复活」，克隆域现形红）。
      // 现合并语义（键域=base 记录键 ∪ extract 键）：
      //  - 准入闸=mount 期 L：键∈L（文件记录在 mount 期实际注入 ≥1 字段，legalDecorKeys 镜像
      //    applyRecord 注入条件）→一律 strip 合并——extract 沉默不再二义：该键 mount 时确有
      //    装饰进引擎，extract 缺席即「已清除」（生产域 undefined 键名不存活，运行期 data `in`
      //    证据恒假，判别面只能取自 mount 期注入事实）。键∉L（注入 0 字段——含仅含非法 image
      //    的记录）→引擎现态对装饰面零发言权，base 记录原样保留（「未编辑键保留原值」MC3b
      //    叠加规则与未编辑零 diff 红线所钉，不因合并策略破坏；extract 产记录=会话新增装饰的
      //    例外通道见第二循环 ∉L∪ 注，MC3-V4 P1-1）。
      //  - strip 集内字段（EXTRACT_DECOR_FIELDS）以引擎现态为准：rec 在场=按 rec 原位覆盖
      //    （原位赋值保字段序=字节级零 diff 前提）；rec 不在场=自 base 删除（清除持久化，
      //    image/imageTitle 随 extract 同生共死口径一并不复活）。
      //  - strip 集外字段（style/custom/未知键）从 baseRec 保留（P1-2「含 style 记录未编辑
      //    零 diff」/「混合记录不丢 custom」守卫续绿）。
      //  - 合并后空记录整键删除（extract :273 不产空记录，同口径不落 `%% meta: key {}` 空行）。
      //  - base 无该键记录→整记录新增=原行为（extract 键循环，Map 追加序=extract walking 序）。
      //  已裁角落注记（L 口径）：base 记录中未过 isSafeImageUrl 闸的 image 字段——记录含其它
      //  有效装饰字段时（键∈L，extract 同样不产非法 image）保存落盘丢弃=接受（loader
      //  applyRecord decorations.ts:87 本就不渲染非法 image，落盘丢弃=规范化非丢失）；记录仅含
      //  该非法 image 时键∉L→保留原字段（零 diff 优先，不因规范化制造挂载即 dirty）。
      //  已裁暗面注记（∈L 记录内错型字段，MP2-P-T 例 4 行为钉）：base 记录含 ≥1 合法字段
      //  （键∈L 前提面）但另有一字段错型（如 tags:"not-array" 非 string 数组）——applyRecord
      //  decorations.ts:109-113 warnDrop 丢弃=挂载零注入；extract 产出条件与 applyRecord 注入
      //  条件逐键镜像=永不复产错型字段 → strip 删链必删之 → merged≠savedValue=此类文件挂载
      //  即脏（闸 2 内容闸也判「保存会改字节」，任意 touch 即翻红）。已知暗面非缺陷：行为钉在
      //  mindEditor.test.ts「MP2-P（V4/V5 泛化口径）case A+错型字段挂载即脏·行为钉」例，
      //  P2 批裁决是否特判保留（实现翻面=特判不标脏须回该例翻转例名与本注记）。
      //  通道不对称注记（幽灵键 vs ∉L 孤儿）：键∈L 时 extract 对该键缺席（会话清空该节点全部
      //  装饰=extract 零产记录）→ 本循环 strip 删键=「保存即清」（幽灵键——mount 在场、一次
      //  保存后消失）；键∉L 时 base 记录本循环整体跳过、第二循环 ∉L∪ 亦只增不删（extract 对
      //  注入 0 字段记录永不产可清形态）→「∉L 孤儿」永续落盘（错型/仅非法 image 记录无限代
      //  传递）。不对称=L 通道定义的自然推论（∈L=引擎对装饰面有发言权亦有清除权，∉L=零发言
      //  权亦零清除权），非疏漏；与上方非法 image/错型字段两暗面同族。
      for (const [key, baseRec] of nodeMeta) {
        if (!legalKeys.has(key)) continue // 键∉L：mount 期注入 0 字段，base 全字段保留（extract 在场时由第二循环 ∉L∪ 合并，MC3-V4 P1-1）
        const rec = ext.nodeMeta[key]
        const merged = { ...baseRec }
        for (const f of EXTRACT_DECOR_FIELDS) {
          if (rec !== undefined && f in rec) merged[f] = rec[f]
          else delete merged[f] // 清除持久化：extract 不产键=引擎已无此装饰，base 旧值不复活
        }
        if (Object.keys(merged).length === 0) nodeMeta.delete(key) // 空记录不落盘（extract :273 同口径）
        else nodeMeta.set(key, merged)
      }
      for (const [key, rec] of Object.entries(ext.nodeMeta)) {
        if (!nodeMeta.has(key)) {
          nodeMeta.set(key, rec) // base 无该键记录→整记录新增=原行为
        } else if (!legalKeys.has(key)) {
          // MC3-V4 P1-1 ∉L∪：键∉L 且 base 记录在，但 extract 产了记录=会话新增装饰（修复前：
          // 第一循环 :516 continue 整体弃置 extract 产物、本循环旧判 `!nodeMeta.has(key)` 因
          // base 记录在不中→note 静默丢弃且 mergedMeta==meta 闸 2 相等早退不翻脏——红例双形态，
          // mindEditor.test.ts「MC3-V4 门控越权回归守卫」）。修复=字段级并集：base 全字段保留
          // （含仅非法 image/style/custom 等注入 0 字段字段——∪ 口径主代理已裁：键∉L 记录
          // base 字段不因规范化丢失，extract 对非法 image 本就零产、保留源=baseRec），extract
          // 同名键覆盖（引擎现态对会话真实持有的装饰有发言权）。
          // 无「清除复活」风险（N1 反向面论证）：∉L 定义=applyRecord 注入 0 字段（legalDecorKeys
          // 注入条件与 extractDecorations 产出条件逐键同镜像）→base 不含任何 extract 可产形态的
          // 合法字段→会话中能被清除的装饰只可能源自会话新增（引擎侧），base 旧字段不受 extract
          // 沉默影响、不复活任何引擎已无的装饰；唯一潜在交叠面=base 非法 image vs 会话合法
          // image，extract 同名覆盖=引擎现态胜（是 ∪ 口径的覆盖而非复活）。
          // 零 diff 保护原义不破：未编辑 ∉L 键 extract 不产记录（引擎装饰面空→八装饰字段全缺→
          // decorations.ts collect 不产空记录）→∪ 分支不触发→base 记录原样保留如旧。
          nodeMeta.set(key, { ...nodeMeta.get(key)!, ...rec })
        }
        // 键∈L 且 base 在：第一循环 strip 合并已处理，此处不动（不动即保 N1 原位覆盖语义）
      }
      // MC3d 裁决②：_assoc 整表替换（引擎=保存时唯一真源；空=删线持久化）
      const extLines = ext.assoc.lines
      const assoc =
        extLines.length === 0
          ? null
          : meta.assoc !== null && sameAssocLines(extLines, meta.assoc.lines)
            ? meta.assoc
            : { lines: extLines }
      // MP1 _mindview 会话覆写通道（本批）：键域隔离——只触此一键，schema/_assoc/nodeMeta
      // 各通道（整表替换/strip/∪ 合并）零纠缠。读取统一沿视图基线 mindviewBaseline（MP1-UI-R
      // P2-1：save 成功转正后基线=已存盘视图——覆写轴缺省回退与无覆写分支都不得直读
      // meta.mindview，否则 reset/再保存把已存盘布局回退落盘=例 1 红例断言②）：
      //  - 无覆写+基线未转正 → 文件 mindview 记录原对象复用（JSON 键序/额外字段保真=字节
      //    零漂移——未编辑保存零 diff 红线与 sameAssocLines 同口径；mind-04/MP1 零 diff
      //    守卫例哨兵）；
      //  - 无覆写+已转正 → 基线记录 layout-first 重写（与上次保存落盘字节同形，再保存零回退）；
      //  - 有覆写 → 完整记录 layout-first 重写（writeMetaBlock 产物即 `%% meta: _mindview
      //    {"layout":…,"theme":…}` 单行；未覆写轴沿基线=会话现效值），替换文件行/无行新增
      //    恰一次（保留键隔离既有链，meta.ts P2-1）
      const mindview =
        sessionCustom !== null
          ? {
              // MP2-TH custom 完整记录分支（本批）：键序 layout→theme→custom（writeMetaBlock
              // 单行产物序=字节钉面）；layout 沿会话现效值（viewOverride 覆写轴优先——MP1
              // 覆写分支同源），theme=custom 注册名，custom={base,overrides}（稀疏记录只含
              // 已触轴）。sessionCustom 变更面=apply（显式 markDirty）/reset（归位
              // savedCustom）/changeTheme（清空让位）——saving 闩拦飞行窗变更，记录=保存
              // 瞬间稳定快照；无覆写+未触轴重保存=同形字节（回放态往返零漂移）
              layout: viewOverride.layout ?? mindviewBaseline.layout,
              theme: sessionCustom.name,
              custom: { base: sessionCustom.base, overrides: sessionCustom.overrides },
            }
          : viewOverride.layout === undefined && viewOverride.theme === undefined
            ? mindviewBaselinePromoted
              ? { layout: mindviewBaseline.layout, theme: mindviewBaseline.theme }
              : meta.mindview
            : {
                layout: viewOverride.layout ?? mindviewBaseline.layout,
                theme: viewOverride.theme ?? mindviewBaseline.theme,
              }
      return { schema: meta.schema, mindview, assoc, nodeMeta }
    } catch {
      return meta
    }
  }

  /** 引擎现态是否等已存内容：save() 同一序列化链比对；序列化异常视为「已改」（保守标脏）。
   *  仅真引擎 data_change 调用（引擎侧 ≤1 次/300ms 节流），开销可忽略。
   *  P1-4：基线须走保存链同一规范化形态（单 meta 块）——parseMindmap 把 meta 行收进模型
   *  （metaSchema/metaById），serializeMindmap 对 base 自身重发 meta 块（flow-model.ts:513-516），
   *  而 spliceMetaBlock 前提=输入无既有块（保存链 body 侧 fromEngineTree 输出 metaById/
   *  metaSchema 恒空=convert.ts「禁叠加」契约）→ 基线若 serializeMindmap(base) 直拼 writeMetaBlock
   *  即双块≠保存链单块，闸 2 对含 meta 文件恒假=挂载即 dirty。基线克隆剥 meta 重发
   *  （metaSchema:null+metaById 空表，浅拷贝不触 base 本体；header 沿 base=与保存链同源），
   *  再拼 writeMetaBlock(meta)=保存链同构单块 */
  // MP2-Q（MP2-P-R P2-1）let 化：初始值仍=打开时文本（mount 期赋值不变），save 成功路径
  // 随落盘刷新为本次输出 value——否则保存后「引擎内容==已存（=落盘 value）」的 data_change
  // 被 gate 2 用 stale savedValue（打开时内容）误判脏，「dirty ⇔ 保存会改字节」在保存后
  // 窗口失真（undo 回落盘基线形态复翻红）。唯一消费点=engineStateIsSaved（gate 2 内容闸；
  // 无 save 前置/dispose 判定消费点）——刷新语义=保存后基线随已存内容走，失败路径不刷新
  // （保持 dirty 可重试）；未编辑保存沿零 diff 红线输出原字节→刷新为同字节=零行为差
  let savedValue = spliceMetaBlock(serializeMindmap({ ...base, metaSchema: null, metaById: new Map() }), writeMetaBlock(meta))
  function engineStateIsSaved(): boolean {
    try {
      const edited = mm.getData() as EngineNode
      return spliceMetaBlock(serializeMindmap(fromEngineTree(edited, base)), writeMetaBlock(mergedMeta(edited))) === savedValue
    } catch {
      return false
    }
  }
  mm.on('data_change', () => {
    if (!initialBaselineSet) return
    const command = (mm as unknown as { command?: unknown }).command
    if (command !== undefined && engineStateIsSaved()) return
    markDirty()
  })
  // 每轮渲染完自适应（mm.fit() 不存在；mount 期引擎自带 fit 与本监听增量无冲突）；
  // 首个 render_end 顺带立初始基线（解除 data_change 门控）
  mm.on('node_tree_render_end', () => {
    initialBaselineSet = true
    mm.view.fit()
  })
  // 历史可用性：引擎 back_forward(activeIndex, historyLen)（Command.js emit 面）
  mm.on('back_forward', (...args: unknown[]) => {
    const idx = typeof args[0] === 'number' ? args[0] : 0
    const len = typeof args[1] === 'number' ? args[1] : 0
    toolbar.setHistory(idx > 0, idx < len - 1)
  })
  // 节点激活 → 属性面板回填/隐藏（契约勘误：事件名=node_active 非 active_node_change；
  // Render.js emitNodeActiveEvent 实证 (node, activeNodeList) 且 setTimeout(0) 异步派发——
  // 本接线只 mm.on 不自理异步，无激活=(null, [])。载荷=引擎现态单节点装饰反提）
  mm.on('node_active', (...args: unknown[]) => {
    const node = args[0]
    const list = Array.isArray(args[1]) ? args[1] : []
    activeNode = node ?? null
    if (activeNode === null || list.length === 0) {
      panel.clear()
      return
    }
    panel.setNode(extractActiveDecos(activeNode))
  })
  // 搜索计数回传（Search.js emitEvent 实测 {currentIndex,total}，currentIndex 0 基）：
  // 0 基原样透传浮条 setCount（不换算——显示格式归浮条工厂域）；索引/总数留档供 onPrev 回绕
  mm.on('search_info_change', (...args: unknown[]) => {
    const info = args[0] as { currentIndex?: unknown; total?: unknown } | undefined
    searchIndex = info && typeof info.currentIndex === 'number' ? info.currentIndex : -1
    searchTotal = info && typeof info.total === 'number' ? info.total : 0
    searchApi?.setCount(searchIndex, searchTotal)
  })
  mm.render()

  // ── 保存链（saving 重入守卫 + 只读闩锁守卫 → serialize → putObject → notify；
  //     4305 = 只读闩锁；瞬时失败保持 dirty 可重试不 notify）──
  // 契约裁决（对齐报告项）：save 不设 dirty 守卫——测试 7/8/9 未发 data_change 即点保存钮
  // 且断言 putObject/notify 全链触发（可执行规格优先于 flow-editor 锚点「dirty 守卫」措辞）；
  // dirty 只管红点/重置可用/onDirty 通道，保存恒序列化引擎现态
  async function save(): Promise<void> {
    if (readonly || saving) return
    saving = true
    toolbar.setBusy(true)
    try {
      // MP2-TH 域既修（reset 归位例裸保存面）：引擎现态缺位（mock 未播种 dataTree →
      // getData null；真引擎 constructor 播种恒非 null=死代码防御）→ 沿 mount 树兜底
      // （未编辑等价态——零 diff 通道照常，保存恒序列化引擎现态口径不破）
      const edited = (mm.getData() as EngineNode | null) ?? data
      const body = serializeMindmap(fromEngineTree(edited, base))
      const merged = mergedMeta(edited)
      const value = spliceMetaBlock(body, writeMetaBlock(merged))
      // MP2-Q（洞 A）飞行窗快照：await 前捕获覆写轴现值——merged/value 本就是保存瞬间产物
      // （:829-832 同步算完），快照补齐第三件同源产物；下方转正与清除都只基于这组快照，
      // 飞行窗内（putObject 未决期间）用户新切换的覆写不在快照内
      const capturedLayout = viewOverride.layout
      const capturedTheme = viewOverride.theme
      await ctx.putObject(file.key, new Blob([value], { type: 'text/plain;charset=utf-8' }))
      // MP2-Q（MP2-P-R P2-1）savedValue 随保存刷新为本次落盘 value（与 putObject 实参同源
      // =mergedMeta 后序列化产物）：保存后 gate 2「引擎内容==已存」的判据基线自此=落盘内容，
      // undo 回落盘基线形态不再误翻脏。仅成功路径（catch 分支不达此行，savedValue 保持
      // 打开时/上次保存值=dirty 可重试语义不变）；未编辑保存沿零 diff 红线输出原字节→
      // 刷新为同字节=零行为差
      savedValue = value
      ctx.notify('saved', { key: file.key })
      // MP1-UI-R P2-1 基线转正（仅成功路径——失败保持 dirty 可重试，覆写/基线原样）：
      // 本次落盘的视图记录与文件记录分叉（有覆写产物=新对象；未动视图态时 merged.mindview
      // 即 meta.mindview 原引用，此处零操作=原对象复用通道与 promoted 标记均不翻，字节零
      // 漂移不破）→ 基线两轴随保存产物更新+转正（reset 回显/mergedMeta 复用分支自此沿已
      // 存盘视图）。转正读 merged=保存瞬间快照（非飞行窗后实时 viewOverride）——转正与
      // 下方清除基于同一保存瞬间状态（MP2-Q 口径）
      if (merged.mindview !== null && merged.mindview !== meta.mindview) {
        mindviewBaseline.layout = merged.mindview.layout ?? mindviewBaseline.layout
        mindviewBaseline.theme = merged.mindview.theme ?? mindviewBaseline.theme
        mindviewBaselinePromoted = true
      }
      // MP2-TH：已存盘 custom 正本随保存刷新（=本次落盘的会话 custom 态——sessionCustom
      // 变更面被 saving 闩拦在飞行窗外，此处赋值即保存瞬间快照；无 custom 会话=null——
      // changeTheme 切走后保存=custom 自落盘消失，正本同步归零；reset 归位正本随之）
      savedCustom = sessionCustom
      // MP2-Q（洞 A）CAS 清除：仅清「当前值===飞行窗前快照值」的轴——覆写已固化进基线/
      // 落盘的轴归零（mergedMeta 与闸 2 的「会话现效值」自此沿基线，视图态不进闸 2 判据
      // 本体），而飞行窗内新切换的轴（当前值≠快照值）存活到下一次保存落盘，不被吞
      if (viewOverride.layout === capturedLayout) viewOverride.layout = undefined
      if (viewOverride.theme === capturedTheme) viewOverride.theme = undefined
      // MP2-Q2-C（MP2-R1 P2-1）：置假前查 CAS 存活残轴——飞行窗内新覆写任一轴在场
      // （mergedMeta 有覆写分支走完整记录重写）=下次保存必改字节，须保持脏不置假
      // （红点保持/reset 可用/beforeDispose 仍询问——「dirty ⇔ 保存会改字节」）；两轴
      // 全空（CAS 全清=覆写已固化进基线/落盘）才置假三连。残轴分支 dirty 保持 true
      // （覆写轴 markDirty 已翻真、本函数无置假路径），return 时 finally 照常收
      // saving/setBusy
      if (viewOverride.layout !== undefined || viewOverride.theme !== undefined) return
      dirty = false
      toolbar.setDirty(false)
      onDirty?.(false)
    } catch (err) {
      console.warn('MIND_SAVE_ERR', String(err).slice(0, 200), (err as { code?: number }).code)
      if ((err as { code?: number }).code === 4305) setReadonly()
      // 瞬时失败：保持 dirty（未保存内容仍可重试），不 notify
    } finally {
      saving = false
      toolbar.setBusy(false)
    }
  }

  /** 重置=resetToSaved 语义：放弃未保存修改，引擎重喂打开时原树（同 mount 源含文件装饰与
   *  _assoc 关联线——MC3b-C2 批复：reset 后会话内装饰不消失；MC3d 同源续接：缺关联线重喂会
   *  使 extract 为空→保存链按整表替换删掉文件 _assoc 行，故 reset 须与 mount 同一组合链；
   *  引擎 setData 自清历史） */
  function resetToSaved(): void {
    if (readonly || !dirty) return
    mm.setData(applyAssociativeLines(applyDecorations(toEngineTree(base), meta), meta))
    // MP1（本批）：视图态覆写随重置一并放弃——闭包清空+两 select 回显还原视图基线
    // （MP1-UI-R P2-1：基线随保存转正——reset 还原「已存盘视图」而非打开时视图=例 1 红例
    // 断言①；未转正时基线=mount 同链口径，行为与旧 const 还原一致）；引擎面 best-effort
    // 归位（callViewApi cast optional——mock 缺省无 setLayout；真引擎 setLayout/setTheme
    // 自带重渲归位画布）
    viewOverride.layout = undefined
    viewOverride.theme = undefined
    // MP2-TH：会话 custom 归位已存盘正本（apply 未保存的 custom 随重置放弃——MP1 覆写清空
    // 同族）+面板控件回基线（有 custom=已存盘 custom 值回显；无=基线缺省——MP1-UI-R P2-1
    // reset 还原已存盘视图同族，转正链含 custom 基线）
    sessionCustom = savedCustom
    themePanelApi.echo(sessionCustom !== null ? sessionCustom.overrides : {})
    layoutSelect.value = mindviewBaseline.layout
    themeSelect.value = mindviewBaseline.theme
    callViewApi('setLayout', mindviewBaseline.layout)
    callViewApi('setTheme', mindviewBaseline.theme)
    dirty = false
    toolbar.setDirty(false)
    onDirty?.(false)
  }

  // Ctrl+S / Ctrl+F 在容器上监（el 直供引擎——keydown 冒泡自画布；flow-editor 同口径拦截）
  const onKeydown = (ev: KeyboardEvent): void => {
    const mod = ev.ctrlKey || ev.metaKey
    if (mod && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void save()
    } else if (mod && ev.key.toLowerCase() === 'f') {
      // MC3c：Ctrl+F 搜索浮条（拦浏览器原生查找；readonly 闩锁禁入闸在 openSearch 内）
      ev.preventDefault()
      openSearch()
    }
  }
  el.addEventListener('keydown', onKeydown)

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      outlineApi?.dispose() // 大纲视图生命周期随 dispose（工厂幂等）
      searchApi?.dispose() // 搜索浮条生命周期随 dispose（工厂幂等）
      panel.dispose() // 属性面板生命周期随 dispose（摘监听+摘 DOM，工厂幂等）
      themePanelApi.dispose() // 主题样式面板生命周期随 dispose（摘监听+摘 DOM，工厂幂等——MP2-TH 三工厂族先例）
      el.removeEventListener('keydown', onKeydown)
      // MP2-R5 N1：引擎主题注册表=模块级单例（跨 mm.destroy() 存续、生产零 removeTheme）——
      // 本 surface 自定义名逐名回收（cast-optional——ambient d.ts 未声明 removeTheme，mock 有
      // 静态即被调/真引擎 index.js:843-846 在场；置 null 后 falsy 可重注册=引擎实证）后 clear
      // 名录。不回收则下个 surface 计数器从 0/回放序号起铸同名→defineTheme no-op 吞=错显陈旧
      // cfg（R5 N1 形态 b「mount 即错显零用户动作」）。多 surface 同页并存边缘（现产品单开）：
      // 仅回收本 surface 名录，其它实例 themeConfig=合并拷贝不受影响——记账
      for (const name of customDefinedNames) {
        ;(MindMap as unknown as { removeTheme?: (name: string) => void }).removeTheme?.(name)
      }
      customDefinedNames.clear()
      mm.destroy()
      el.replaceChildren() // 容器清空（引擎 destroy 已清 innerHTML——幂等兜底，二次 dispose 不重复拆引擎）
      el.classList.remove('mmagic-mind') // 与 mount 挂类对称：规则域/断言锚随面销毁一并撤除
      el.style.position = prevElPos
    },
    // 关闭确认（flow-editor/code.ts 同口径）：非 dirty/只读放行；dirty confirm + 3s 超时竞速；
    // expired/destroy=通知式跳过询问
    beforeDispose: (reason?: DisposeReason) => {
      if ((reason && reason !== 'close') || !dirty || readonly) return true
      return confirmWithTimeout(t(UNSAVED_KEY))
    },
  }
}
