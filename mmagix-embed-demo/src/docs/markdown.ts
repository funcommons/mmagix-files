// md 原文装载 + 渲染：import.meta.glob(?raw) 动态取文 → marked.parse → DOMPurify.sanitize。
// 无语法高亮依赖（任务口径）；manifest 树构建 helper 供 Docs.vue 侧栏用。
import { marked } from "marked";
import DOMPurify from "dompurify";
import { DOC_MANIFEST, type DocEntry } from "./manifest";

/** 仓根 docs/** 与仓根散篇（CHANGELOG.md 等）两处 glob，键均相对 src/docs/ */
const sources = {
  ...import.meta.glob("../../../docs/**/*.md", { query: "?raw", import: "default", eager: false }),
  ...import.meta.glob("../../../*.md", { query: "?raw", import: "default", eager: false }),
} as Record<string, () => Promise<string>>;

/** 按 manifest 条目取 md 原文（未收录/路径漂移返回 undefined） */
export function loadDoc(entry: DocEntry): Promise<string> | undefined {
  const loader = sources[entry.path];
  return loader?.();
}

/** marked → DOMPurify：唯一出口，调用方拿到的 html 已消毒 */
export async function renderMarkdown(raw: string): Promise<string> {
  const html = marked.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

export interface DocGroup {
  /** i18n 键（docs.group.*） */
  key: string;
  items: DocEntry[];
}

/** manifest 按分组键聚组（保持 manifest 声明顺序） */
export function groupManifest(entries: DocEntry[] = DOC_MANIFEST): DocGroup[] {
  const groups: DocGroup[] = [];
  const byKey = new Map<string, DocGroup>();
  for (const entry of entries) {
    let g = byKey.get(entry.group);
    if (!g) {
      g = { key: entry.group, items: [] };
      byKey.set(entry.group, g);
      groups.push(g);
    }
    g.items.push(entry);
  }
  return groups;
}
