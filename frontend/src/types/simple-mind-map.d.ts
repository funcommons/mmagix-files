/**
 * simple-mind-map 0.14.0-fix.3 环境声明——包无自带类型（纯 JS），ambient 声明整体接管。
 * 仅收录 MindEditor 渲染面（apps/renderers/mindEditor.ts）实际触达面：
 * constructor(opt)/on/render/setData/getData/execCommand?/destroy/view.fit + 静态
 * defineTheme/usePlugin/hasPlugin。引擎超集成员（setFullData/layout/plugins…）未用不声明。
 * execCommand 刻意声明为可选：单测 mock（renderers/__tests__/mindEditor.test.ts）无此成员，
 * 胶水必须走 optional 调用（mm.execCommand?.('BACK')），不得裸依赖。
 */
declare module 'simple-mind-map' {
  /** 引擎构造 opt——仅声明胶水面实际传入键，其余键按引擎缺省 */
  interface MindMapOptions {
    /** 挂载容器（引擎直接接管：加类名 smm-mind-map-container、append 画布 svg） */
    el: HTMLElement
    /** 节点树 { data:{text,…}, children:[] } */
    data: unknown
    /** 布局名（logicalStructure/fishbone/…）；缺省引擎兜底 */
    layout?: string
    /** 主题名（须先经 MindMap.defineTheme 注册） */
    theme?: string
    [key: string]: unknown
  }

  class MindMap {
    /** 构造 opt 原样留存（引擎 getLayout 等读此对象） */
    opt: MindMapOptions
    /** 视图面（mm.fit() 不存在——自适应走 view.fit()，挂 node_tree_render_end 后调） */
    view: { fit(): void; [key: string]: unknown }
    constructor(opt: MindMapOptions)
    /** 事件订阅（data_change/node_tree_render_end/back_forward…） */
    on(event: string, handler: (...args: unknown[]) => void): unknown
    render(): void
    /** 整树重喂（清历史重渲染——resetToSaved 语义） */
    setData(data: unknown): void
    /** 取当前编辑树 */
    getData(withConfig?: boolean): unknown
    /** 命令面（undo='BACK'/redo='FORWARD'，Command.js）；mock 无此成员→调用方必须 optional 调用 */
    execCommand?(...args: unknown[]): void
    destroy(): void
    /** 注册主题（实例化前；同名重复注册引擎内静默返回 Error 不抛） */
    static defineTheme(name: string, config?: Record<string, unknown>): unknown
    /** 注册插件（hasPlugin 去重，重复注册无害） */
    static usePlugin(plugin: unknown, opt?: Record<string, unknown>): unknown
    static hasPlugin(plugin: unknown): number
  }
  export default MindMap
}

/** 引擎内置插件子路径（MIT，包内源码全可用；胶水仅透传给 usePlugin，不直接实例化） */
declare module 'simple-mind-map/src/plugins/Drag' {
  const Drag: abstract new (...args: never[]) => unknown
  export default Drag
}
declare module 'simple-mind-map/src/plugins/Select' {
  const Select: abstract new (...args: never[]) => unknown
  export default Select
}
declare module 'simple-mind-map/src/plugins/KeyboardNavigation' {
  const KeyboardNavigation: abstract new (...args: never[]) => unknown
  export default KeyboardNavigation
}
declare module 'simple-mind-map/src/plugins/Search' {
  const Search: abstract new (...args: never[]) => unknown
  export default Search
}
declare module 'simple-mind-map/src/plugins/AssociativeLine' {
  const AssociativeLine: abstract new (...args: never[]) => unknown
  export default AssociativeLine
}
declare module 'simple-mind-map/src/plugins/OuterFrame' {
  const OuterFrame: abstract new (...args: never[]) => unknown
  export default OuterFrame
}
declare module 'simple-mind-map/src/plugins/Export' {
  const Export: abstract new (...args: never[]) => unknown
  export default Export
}
