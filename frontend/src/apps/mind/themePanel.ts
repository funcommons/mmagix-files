/**
 * themePanel.ts——脑图主题样式面板 DOM 工厂（MP2-TH）
 * 契约正本：.claude/mind-loop-state.md「MP2-TH-T」行（含主代理持久化契约裁决）
 * （测试=可执行规格：src/apps/renderers/__tests__/mindEditor.test.ts「MP2-TH 主题样式面板」
 * describe 9 例）
 *
 * DOM 工厂零引擎 import（引擎面全回调/实例注入——t/mm/回调三件，mindPanel 工厂依赖面同构）：
 * createMindThemePanel({ el, t, mm, canApply, baseOf, onDefine, onApplied, startIndex? })
 *   → { el, open(), close(), toggle(), echo(overrides), dispose() }
 *  - 面板根 div.mmagic-mind-theme-panel，create 即挂入宿主 el（mindPanel 族同构：mount 即挂、
 *    初始隐藏——is-open 在场=显示、缺席=隐藏）；样式 scoped 归 mindEditor 注入的 .mmagic-mind
 *    容器域（本文件零 <style> 注入，全 token 化）
 *  - 三控制轴（data-field 钉位）：fill/line=两枚 input[type=color]、lineStyle=select（选项
 *    value 齐序 solid|dashed——UI 值；引擎值映射 solid→'none'/dashed→'6,4'）；行结构=div.row
 *    内 label+控件（mindPanel 同构）；应用钮 button[data-act='apply']（面板根内——mindPanel
 *    close 钮 data-act 域同构）
 *  - i18n 恰七键 app.mind-theme-panel.{do,fill,line,lineStyle,lineStyle.solid,lineStyle.dashed,apply}
 *    经 t（do 键=面板钮文案面，归 mindEditor 装配侧）
 *
 * 行为契约（对齐 mindEditor.test.ts MP2-TH 钉面）：
 *  - 控件 change（冒泡，jsdom/真 UI 同通道）→ 触轴标记（touched 集合追加——overrides 稀疏
 *    记录的准入面：未触轴不落键，D-THEME 勘察锚点：填充轴写满 root/second/node 三消费层
 *    同值，third 不被引擎消费不写死数据）
 *  - echo(overrides)：逆映射回显（reset 归位通道）——overrides 在场轴回显值+补触轴标记，
 *    缺席轴回基线缺省（baseOf()）+不标触；echo({})=全回基线缺省+清触轴（主题 select 切走时用）
 *  - apply（应用钮 click）：canApply() 闸（readonly 双闸之二+saving 飞行窗闩——内容写族口径，
 *    模板/导入族同款）静默早退 → 触轴读值组稀疏 overrides → base⊕overrides 合成
 *    （mergeThemeCfg）→ onDefine(`mind-custom-<n>`)（闭包计数器递增——引擎 MindMap.defineTheme
 *    同名再注册=静默 no-op 滞留旧 cfg，计数器避撞；startIndex=mount 回放已占名序号递进）→
 *    mm.setTheme(新名)（注册先于生效——未注册名 setTheme 回退 default）→ onApplied({name,
 *    base,overrides})（会话 custom 态记录+markDirty 归胶水——写路径显式标脏口径）→ 面板收起
 *  - dispose 摘监听+摘 DOM（幂等，重复不抛）
 *
 * mergeThemeCfg(base, overrides)：base⊕overrides 合成——defineTheme 的引擎合成基准=引擎
 * defaultTheme 不含 base 层，base 层合成归胶水/本工厂自担：顶层浅拷贝，对象值单层深合并
 * （base 其余键保真——root.color 等），标量直换；overrides 未触键零触碰。
 */

// ───────────────────────── 契约类型 ─────────────────────────

/** 稀疏覆写记录（只含已触轴；形态=引擎主题顶层键/分层键的局部覆盖） */
export type MindThemeOverrides = Record<string, unknown>

/** 会话自定义主题态（apply 产出/mount 回放还原/持久化 custom 字段共用形态——胶水持有） */
export interface MindCustomThemeState {
  /** 引擎注册名（mind-custom-<n>——defineTheme 同名再注册=no-op，计数器避撞） */
  name: string
  /** 基线主题名（MIND_THEMES 之一——合成基准 cfg 与回显缺省值来源） */
  base: string
  /** 稀疏覆写记录（只含已触轴） */
  overrides: MindThemeOverrides
}

export interface MindThemePanelOpts {
  /** 宿主容器（面板根挂入其中，absolute 叠加形态） */
  el: HTMLElement
  /** i18n（恰七键 app.mind-theme-panel.*） */
  t: (key: string) => string
  /** 引擎实例面（setTheme 生效通道——cast optional 调用，mock/真引擎缺面零调） */
  mm: unknown
  /** 应用准入闸（readonly 双闸之二+saving 飞行窗闩——胶水供 () => !readonly && !saving） */
  canApply: () => boolean
  /** 当前基线主题面（合成基准 cfg+回显缺省值来源；胶水供 sessionCustom.base ?? 视图基线
   *  主题名的解析） */
  baseOf: () => { name: string; cfg: Record<string, unknown> }
  /** 注册出口（defineTheme 通道——胶水转接 MindMap.defineTheme；须先于 setTheme 生效） */
  onDefine: (name: string, cfg: Record<string, unknown>) => void
  /** 应用成功上抛（会话 custom 态记录+markDirty 归胶水——写路径显式标脏口径） */
  onApplied: (applied: MindCustomThemeState) => void
  /** 计数器起点（缺省 0=首 apply 铸 mind-custom-1；mount 回放已占名 mind-custom-<k> 时传
   *  k——首 apply 铸 k+1，避同名再注册 no-op 滞留旧 cfg） */
  startIndex?: number
}

export interface MindThemePanelApi {
  el: HTMLElement
  open(): void
  close(): void
  toggle(): void
  /** 回显（reset 归位通道）：稀疏 overrides → 控件值+触轴标记还原 */
  echo(overrides: MindThemeOverrides): void
  dispose(): void
}

// ───────────────────────── 常量与纯函数 ─────────────────────────

const PANEL_I18N_PREFIX = 'app.mind-theme-panel.'

/** 线型控制轴 UI 枚举（select 选项 value 齐序钉死） */
const DASH_UI_VALUES = ['solid', 'dashed'] as const
type DashUiValue = (typeof DASH_UI_VALUES)[number]

/** 线型 UI 值 → 引擎 lineDasharray 值映射（solid='none'=实线缺省；dashed='6,4'——引擎自产
 *  associativeLineDasharray 缺省同形；非 lineStyle 形状轴——那是 curve/straight/direct，
 *  与实/虚线正交） */
const DASH_BY_UI: Record<DashUiValue, string> = { solid: 'none', dashed: '6,4' }

/** echo 逆映射的虚线判值（'6,4'→dashed，其余——含缺省 'none'→solid） */
const DASH_DASHED_VALUE = '6,4'

/** 填充轴三层消费键（引擎按 layerIndex 只读 root/second/node 三层——third 不消费不写死
 *  数据，D-THEME 勘察锚点；单控制轴写满三消费层同值） */
const FILL_LAYER_KEYS = ['root', 'second', 'node'] as const

/** 普通对象闸（decorations.ts 同名私有工具的面内镜像，零引擎 import） */
function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** base⊕overrides 合成：顶层浅拷贝，对象值单层深合并（base 其余键保真——root.color 等），
 *  标量直换；overrides 未触键零触碰。defineTheme 的引擎合成基准=引擎 defaultTheme 不含
 *  base 层（mergeTheme(defaultTheme, config)）——base 层合成归胶水/本工厂自担（MP2-TH
 *  勘察结论 3） */
export function mergeThemeCfg(
  base: Record<string, unknown>,
  overrides: MindThemeOverrides,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const baseValue = merged[key]
    merged[key] = isPlainObj(baseValue) && isPlainObj(value) ? { ...baseValue, ...value } : value
  }
  return merged
}

// ───────────────────────── 工厂 ─────────────────────────

export function createMindThemePanel(opts: MindThemePanelOpts): MindThemePanelApi {
  const { el, t, mm, canApply, baseOf, onDefine, onApplied, startIndex = 0 } = opts

  /** 闭包计数器（重注册 no-op 规避——引擎 MindMap.defineTheme 同名再注册静默 no-op，同名
   *  将滞留旧 cfg 使二次应用失效；仅成功 apply 递增——闩拒/闸早退不占名） */
  let counter = startIndex
  /** 触轴标记（overrides 稀疏记录准入面——未触轴不落键；echo 补标/清空） */
  const touched = new Set<'fill' | 'line' | 'lineStyle'>()

  const root = document.createElement('div')
  root.className = 'mmagic-mind-theme-panel'

  // 三控制轴控件（data-field 钉位由 appendRow 统一设置）
  const fillInput = document.createElement('input')
  fillInput.type = 'color'
  const lineInput = document.createElement('input')
  lineInput.type = 'color'
  const dashSelect = document.createElement('select')
  for (const uiValue of DASH_UI_VALUES) {
    const opt = document.createElement('option')
    opt.value = uiValue
    opt.textContent = t(`${PANEL_I18N_PREFIX}lineStyle.${uiValue}`)
    dashSelect.appendChild(opt)
  }

  /** 控件行：label + 控件（mindPanel 同构形态；i18n 键后缀与 data-field 同名） */
  function appendRow(field: 'fill' | 'line' | 'lineStyle', control: HTMLInputElement | HTMLSelectElement): void {
    control.setAttribute('data-field', field)
    const row = document.createElement('div')
    row.className = 'row'
    const label = document.createElement('label')
    label.textContent = t(`${PANEL_I18N_PREFIX}${field}`)
    row.append(label, control)
    root.appendChild(row)
  }
  appendRow('fill', fillInput)
  appendRow('line', lineInput)
  appendRow('lineStyle', dashSelect)

  // 应用钮（面板根内 button[data-act='apply']——mindPanel close 钮 data-act 域同构）
  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.setAttribute('data-act', 'apply')
  applyBtn.textContent = t(`${PANEL_I18N_PREFIX}apply`)
  applyBtn.setAttribute('aria-label', t(`${PANEL_I18N_PREFIX}apply`))
  const foot = document.createElement('div')
  foot.className = 'row mmagic-mind-theme-panel__foot'
  foot.appendChild(applyBtn)
  root.appendChild(foot)
  el.appendChild(root)

  // ── 触轴标记：控件 change（冒泡——jsdom 程序派发/真 UI 同通道）→ touched 追加（只记
  //    轴不触发应用——应用只在 apply 钮） ──
  function handleChange(ev: Event): void {
    const target = ev.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return
    const field = target.getAttribute('data-field')
    if (field === 'fill' || field === 'line' || field === 'lineStyle') touched.add(field)
  }

  /** 触轴读值组稀疏 overrides（键序 canonical：三层填充→lineColor→lineDasharray——
   *  writeMetaBlock 产物键面审美与 deep-equal 双兼容） */
  function buildOverrides(): MindThemeOverrides {
    const overrides: MindThemeOverrides = {}
    if (touched.has('fill')) {
      // 单控制轴写满三消费层同值（third 不被引擎消费不写死数据——D-THEME 锚点）
      for (const layer of FILL_LAYER_KEYS) overrides[layer] = { fillColor: fillInput.value }
    }
    if (touched.has('line')) overrides.lineColor = lineInput.value
    if (touched.has('lineStyle')) overrides.lineDasharray = DASH_BY_UI[dashSelect.value as DashUiValue]
    return overrides
  }

  // ── apply（写路径）：准入闸 → 稀疏 overrides → base⊕overrides 合成注册 → 引擎生效 →
  //    会话态上抛 → 面板收起。canApply 闸=readonly 双闸之二（setReadonly 禁面板钮闸 1 的
  //    兜底——编程派发 click 绕 disabled 激活抑制面）+saving 飞行窗闩（窗内 defineTheme/
  //    setTheme/markDirty 会被保存收尾置假三连吞——内容写族口径，静默早退=安全侧） ──
  function handleApply(): void {
    if (!canApply()) return
    const overrides = buildOverrides()
    const { name: baseName, cfg } = baseOf()
    const name = `mind-custom-${++counter}`
    onDefine(name, mergeThemeCfg(cfg, overrides)) // 注册先于生效（未注册名 setTheme 回退 default）
    ;(mm as { setTheme?: (name: string) => void }).setTheme?.(name)
    onApplied({ name, base: baseName, overrides }) // 会话 custom 态记录+markDirty 归胶水
    root.classList.remove('is-open') // 面板收起（应用即离场，控件态留驻——echo 通道回显）
  }

  root.addEventListener('change', handleChange)
  applyBtn.addEventListener('click', handleApply)

  // ── 可见性 / 回显 / 销毁 ──
  function open(): void {
    root.classList.add('is-open')
  }

  function close(): void {
    root.classList.remove('is-open')
  }

  function toggle(): void {
    if (root.classList.contains('is-open')) close()
    else open()
  }

  /** 逆映射回显：overrides 在场轴回显+补触轴标记，缺席轴回基线缺省（baseOf().cfg）+不标
   *  触；echo({})=全回基线缺省+清触轴。触轴标记随回显补齐——reset 归位后再 apply 稀疏
   *  记录忠实重建已存盘轴集（不会把缺席轴凭空落键） */
  function echo(overrides: MindThemeOverrides): void {
    const { cfg } = baseOf()
    touched.clear()
    const rootFill = isPlainObj(overrides.root) && typeof overrides.root.fillColor === 'string' ? overrides.root.fillColor : null
    const baseFill = isPlainObj(cfg.root) && typeof cfg.root.fillColor === 'string' ? cfg.root.fillColor : ''
    if (rootFill !== null) touched.add('fill')
    fillInput.value = rootFill ?? baseFill
    const lineColor = typeof overrides.lineColor === 'string' ? overrides.lineColor : null
    const baseLine = typeof cfg.lineColor === 'string' ? cfg.lineColor : ''
    if (lineColor !== null) touched.add('line')
    lineInput.value = lineColor ?? baseLine
    const dash = typeof overrides.lineDasharray === 'string' ? overrides.lineDasharray : null
    if (dash !== null) touched.add('lineStyle')
    dashSelect.value = dash === DASH_DASHED_VALUE ? 'dashed' : 'solid'
  }

  function dispose(): void {
    root.removeEventListener('change', handleChange)
    applyBtn.removeEventListener('click', handleApply)
    root.remove() // remove 天然幂等（重复 dispose 不抛）
  }

  return { el: root, open, close, toggle, echo, dispose }
}
