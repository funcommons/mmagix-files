// 文档中心 manifest：docs/ 目录的 curated 精选条目（不索引全量，标题走 i18n docs.doc.<slug>）。
// path 与 src/docs/markdown.ts 的 import.meta.glob 键同构——均相对本文件所在目录（src/docs/），
// '../../..' = 仓库根（mmagix-files/），dev 侧由 vite server.fs.allow 放行。
export interface DocEntry {
  /** 路由段：/docs/<slug> */
  slug: string;
  /** md 原文相对路径（= import.meta.glob 键） */
  path: string;
  /** 分组 i18n 键（docs.group.*） */
  group: string;
}

export const DOC_MANIFEST: DocEntry[] = [
  // 入门
  { slug: "readme", path: "../../../docs/README.md", group: "docs.group.getting" },
  // 产品
  { slug: "prd", path: "../../../docs/product/PRD.md", group: "docs.group.product" },
  { slug: "competitive", path: "../../../docs/product/competitive-analysis-v1.3.0.md", group: "docs.group.product" },
  // 设计
  { slug: "architecture", path: "../../../docs/design/architecture.md", group: "docs.group.design" },
  { slug: "webdav", path: "../../../docs/design/webdav-support-design.md", group: "docs.group.design" },
  { slug: "jsdk-api", path: "../../../docs/design/jsdk-api.md", group: "docs.group.design" },
  { slug: "plugin-system", path: "../../../docs/design/plugin-system.md", group: "docs.group.design" },
  // 运维
  { slug: "deployment", path: "../../../docs/operations/deployment.md", group: "docs.group.ops" },
  { slug: "user-guide", path: "../../../docs/operations/user-guide.md", group: "docs.group.ops" },
  // 发布
  { slug: "changelog", path: "../../../CHANGELOG.md", group: "docs.group.release" },
];
