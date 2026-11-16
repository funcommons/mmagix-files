/**
 * 脑图模板库（首批 3 套）——mindEditor 模板控件（select[data-act='templates']）的数据源
 * 契约正本：docs/design/mind-editor-redesign/plan.md §七 P2「模板库」
 * （测试=可执行规格：src/apps/renderers/__tests__/mindEditor.test.ts「MP2-TP 模板库」块）
 *
 * 【模块契约（MP2-TP-C 落地）】MIND_TEMPLATES 恰 3 项 { id, nameKey, content }：
 *  - id 集合钉死 ['project','brainstorm','release']（数组序=控件选项序）；
 *  - nameKey=`app.mind-templates.items.<id>`（i18n 名称走 locales，键面 zh/en 双语在场）；
 *  - content=mermaid mindmap 文本，canonical 缩进同构 serializeMindmap（根 2 空格+每层+2、
 *    无尾换行、无空行/无 meta 行）——parseMindmap 解析成功+根唯一+serialize(parse(content))
 *    往返零漂移（测试红线断言）。
 *
 * 【主题结构】project=项目管理（根+5 分支各 2 叶级）、brainstorm=头脑风暴（根+4 分支发散）、
 * release=产品发布（根+3 阶段各含任务与里程碑）。
 *
 * 【MVP 记账限制】节点文本 zh 固定（模板内容不做 en 本地化——mermaid content 为数据面非
 * i18n 面，en 本地化需模板内容双语化机制，本批不立；名称/控件文案已走 locales 双语）。
 * 节点文本撰写约束：不含 mermaid 定界符与需引号字符（["{}[\]()|\\]）——bare 纯文本节点
 * 经 mindmapToken/mindmapNodeToken 对称面零漂移往返。
 */

/** 模板项（id=控件选项 value+查表键；nameKey=locales app 域平铺键；content=模板正文） */
export interface MindTemplate {
  id: string
  nameKey: string
  content: string
}

/** 模板正文（canonical 缩进：根 2 空格、每层+2；数组序=控件选项序） */
export const MIND_TEMPLATES: MindTemplate[] = [
  {
    id: 'project',
    nameKey: 'app.mind-templates.items.project',
    content: [
      'mindmap',
      '  新项目管理',
      '    目标与范围',
      '      明确项目目标',
      '      界定交付范围',
      '    里程碑计划',
      '      关键节点排期',
      '      交付物清单',
      '    任务分解',
      '      拆解工作包',
      '      指派责任人',
      '    进度跟踪',
      '      周会同步进展',
      '      风险预警看板',
      '    复盘与归档',
      '      阶段复盘记录',
      '      文档归档入库',
    ].join('\n'),
  },
  {
    id: 'brainstorm',
    nameKey: 'app.mind-templates.items.brainstorm',
    content: [
      'mindmap',
      '  头脑风暴主题',
      '    问题定义',
      '      现状痛点',
      '      目标用户',
      '    想法发散',
      '      自由联想',
      '      极端假设',
      '    方案筛选',
      '      可行性评估',
      '      影响面排序',
      '    行动落地',
      '      最小验证',
      '      责任与时限',
    ].join('\n'),
  },
  {
    id: 'release',
    nameKey: 'app.mind-templates.items.release',
    content: [
      'mindmap',
      '  产品发布计划',
      '    发布前准备',
      '      完成回归测试',
      '      准备发布物料',
      '      里程碑：发布评审通过',
      '    发布执行',
      '      灰度放量观测',
      '      值班与告警盯守',
      '      里程碑：全量上线',
      '    发布后跟进',
      '      收集用户反馈',
      '      复盘发布数据',
      '      里程碑：发布复盘归档',
    ].join('\n'),
  },
]
