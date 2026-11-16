/**
 * mind/outline.ts——脑图大纲行模型纯函数（MC3c）
 * 契约正本：.claude/mind-loop-state.md「MC3c 契约（锁定）」节
 * （测试=可执行规格：src/apps/renderers/__tests__/mindOutline.test.ts outlineFromTree 9 例）
 *
 * outlineFromTree(tree)：引擎树→扁平缩进行模型（大纲视图数据源，MC3c-T 裁决定型）：
 *  - OutlineRow 恰三字段 {key,depth,text}：key=buildNodeKey(祖先文本链含自身)（meta.ts 同源，
 *    转义域/保留键隔离零漂移）；depth 0 基（根=0）；行序=先序遍历（文档序，非 BFS）；
 *    text 原样透传不 trim（键仍走转义）
 *  - 纯函数不可变：入参树毫发无伤（只读遍历，零写入）；零引擎 import（decorations.ts 同域
 *    红线——引擎形状用 convert.ts 本地契约类型 EngineNode）
 *  - 边界：空树（空文本无子根）→ 单行 {key:'',depth:0,text:''}（大纲域不炸不空返回）；
 *    data.text 非 string 缺省 ''（与 fromEngineTree 同口径）
 */
import { buildNodeKey } from './meta'
import type { EngineNode } from './convert'

/** 大纲行模型（恰三字段——契约钉死，禁加字段） */
export interface OutlineRow {
  key: string
  depth: number
  text: string
}

/** 引擎树 → 扁平大纲行（先序）；不可变纯函数 */
export function outlineFromTree(tree: EngineNode): OutlineRow[] {
  const rows: OutlineRow[] = []
  const walk = (n: EngineNode, path: string[]): void => {
    const text = typeof n.data?.text === 'string' ? n.data.text : ''
    const next = [...path, text]
    rows.push({ key: buildNodeKey(next), depth: next.length - 1, text })
    for (const c of n.children ?? []) walk(c, next)
  }
  walk(tree, [])
  return rows
}
