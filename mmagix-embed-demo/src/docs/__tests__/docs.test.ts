// @vitest-environment jsdom
// 为什么 jsdom：renderMarkdown 的 DOMPurify.sanitize 需要 window/DOM（vitest.config 默认 node 环境）。
// 业务代码零改动、零 mock：manifest/glob/render 全走真实实现。
// glob 探针口径：markdown.ts 的 sources 未导出，但 loadDoc(entry) 与键集直连——
// 返回 undefined ⟺ entry.path 不在 import.meta.glob 键集；返回 loader 且 await 出非空串 ⟺ 键命中且文件可解析。
import { describe, it, expect } from "vitest";
import { renderMarkdown, loadDoc, groupManifest } from "../markdown";
import { DOC_MANIFEST, type DocEntry } from "../manifest";

/** manifest.ts 注释声明的五组合法分组键 */
const LEGAL_GROUPS = [
  "docs.group.getting",
  "docs.group.product",
  "docs.group.design",
  "docs.group.ops",
  "docs.group.release",
] as const;

describe("manifest.ts DOC_MANIFEST", () => {
  it("条目数 ≥10，slug 全仓唯一（Set 去重大小=数组长度）", () => {
    expect(DOC_MANIFEST.length).toBeGreaterThanOrEqual(10);
    const slugs = DOC_MANIFEST.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("每条有 group 且命中五组白名单", () => {
    for (const e of DOC_MANIFEST) {
      expect(e.group, `slug=${e.slug} 的 group 为空或不在白名单`).toBeTruthy();
      expect(LEGAL_GROUPS).toContain(e.group);
    }
  });

  it("每条 path：'../../../' 前缀 + '.md' 后缀，且为 docs 树 / 仓根散篇两桶之一", () => {
    for (const e of DOC_MANIFEST) {
      expect(e.path.startsWith("../../../"), `slug=${e.slug} path=${e.path}`).toBe(true);
      expect(e.path.endsWith(".md"), `slug=${e.slug} path=${e.path}`).toBe(true);
      const inDocsTree = e.path.startsWith("../../../docs/");
      const repoRootLoose = /^(\.\.\/){3}[^/]+\.md$/.test(e.path);
      expect(inDocsTree || repoRootLoose, `两桶都不占: ${e.path}`).toBe(true);
    }
  });

  it("探针：每条 manifest path 都命中 glob 键集且 await 解析出非空 md（manifest 不挂死链）", async () => {
    expect(DOC_MANIFEST.length).toBeGreaterThan(0);
    for (const entry of DOC_MANIFEST) {
      const loader = loadDoc(entry);
      expect(loader, `glob 未命中: ${entry.path} (slug=${entry.slug})`).toBeDefined();
      const content = await loader!;
      expect(content.length, `命中但内容为空: ${entry.path}`).toBeGreaterThan(0);
    }
    // 仓根 glob（'../../../*.md'）专项钉：docs/** glob 命中不了 CHANGELOG，能命中它的只有仓根散篇 glob
    const changelog = DOC_MANIFEST.find((e) => e.slug === "changelog")!;
    expect(loadDoc(changelog), "仓根散篇 glob 未命中 CHANGELOG.md").toBeDefined();
  });

  it("groupManifest：组数 ≥5、每组 items 非空、键序=manifest 首现序、覆盖全部条目", () => {
    const groups = groupManifest();
    expect(groups.length).toBeGreaterThanOrEqual(5);
    for (const g of groups) {
      expect(g.items.length, `组 ${g.key} items 为空`).toBeGreaterThan(0);
      for (const item of g.items) expect(item.group).toBe(g.key);
    }
    const firstSeen = [...new Set(DOC_MANIFEST.map((e) => e.group))];
    expect(groups.map((g) => g.key)).toEqual(firstSeen);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(DOC_MANIFEST.length);
  });
});

describe("markdown.ts renderMarkdown（sanitize 铁律）", () => {
  it("<script> 混入 md → 输出不含 '<script'（原文与小写化各查一遍；节点连内容一并移除）", async () => {
    const out = await renderMarkdown("# t\n\n<script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("<script");
    // DOMPurify 的 FORBID_CONTENTS 含 script：内容随节点移除，不会降级成正文文本
    expect(out).not.toContain("alert(1)");
  });

  it("img 向量：javascript: 伪协议与 onerror 属性均被剥净", async () => {
    const mdAttr = await renderMarkdown("![](javascript:alert(1))");
    const rawHtml = await renderMarkdown("<img src=x onerror=alert(1)>");
    for (const out of [mdAttr, rawHtml]) {
      expect(out.toLowerCase()).not.toContain("onerror");
      expect(out.toLowerCase()).not.toContain("javascript:");
    }
  });

  it("基本渲染：'# 标题' → <h1", async () => {
    expect(await renderMarkdown("# 标题")).toContain("<h1");
  });

  it("基本渲染：行内 `code` → <code>", async () => {
    expect(await renderMarkdown("行内 `code` 片")).toContain("<code>");
  });

  it("基本渲染：GFM 表格 → <table", async () => {
    const out = await renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("<table");
    expect(out).toContain("<tr>");
  });

  it("基本渲染：'**b**' → <strong>", async () => {
    expect(await renderMarkdown("**b**")).toContain("<strong>");
  });

  it("空串 → 空串（marked 空输入产出空 html，DOMPurify.sanitize('') 亦为空串）", async () => {
    expect(await renderMarkdown("")).toBe("");
  });

  it("纯空白 → 空串（按实现实际行为：marked 对空白-only 输入产出空 html）", async () => {
    expect(await renderMarkdown("   \n\t  ")).toBe("");
  });
});

describe("markdown.ts loadDoc", () => {
  it("manifest 第一条（slug=readme）→ 非空 md 原文，含标题井号", async () => {
    const entry: DocEntry = DOC_MANIFEST[0]!;
    const loader = loadDoc(entry);
    expect(loader, `glob 未命中首条 path: ${entry.path}`).toBeDefined();
    const content = await loader!;
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("#");
  });

  it("不存在的 slug/path → 返回 undefined（实现缺省行为：path 无对应 loader 即 undefined，不抛错）", () => {
    const ghost: DocEntry = {
      slug: "no-such-doc",
      path: "../../../docs/__no_such_doc__.md",
      group: "docs.group.getting",
    };
    expect(loadDoc(ghost)).toBeUndefined();
  });
});
