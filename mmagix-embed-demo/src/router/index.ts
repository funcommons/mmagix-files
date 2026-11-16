import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import i18n from "@/locales";

/**
 * 站点 v2 并存路由（S0 脚手架；site2 页面由后续代理按
 * docs/design/site-redesign-v2/prototypes/README.md §六 实现）：
 *   /            新站骨架（SiteNav2）→ Home2 / Guide2 / Sources2 / Docs2
 *                + /workspace /singlefile（挂原 demo 页面组件，meta.embed 供布局判全高）
 *   /legacy      旧站原样（LegacySiteLayout）→ LegacyHome / LegacyDocs
 *   /play/*      在线演示（AppLayout，原 demo 三页）——零改动
 * 重定向：/home → /；旧 demo 深链（/overview、/embed/*）→ /play/*；catch-all → /。
 * 旧 /docs/:slug 即新 Docs2（旧文档内容整体在 /legacy/docs/:slug）。
 */
const routes: RouteRecordRaw[] = [
  {
    path: "/",
    component: () => import("@/layout/SiteNav2.vue"),
    children: [
      {
        path: "",
        name: "Home2",
        component: () => import("@/views/site2/Home2.vue"),
        meta: { title: "site2.nav.home" },
      },
      {
        path: "guide",
        name: "Guide2",
        component: () => import("@/views/site2/Guide2.vue"),
        meta: { title: "site2.nav.guide" },
      },
      {
        path: "sources",
        name: "Sources2",
        component: () => import("@/views/site2/Sources2.vue"),
        meta: { title: "site2.nav.features" },
      },
      {
        path: "docs/:slug?",
        name: "Docs2",
        component: () => import("@/views/site2/Docs2.vue"),
        meta: { title: "site2.nav.docs" },
      },
      {
        // 新引导交接的工作台：复用原 demo EmbedPlay（懒加载同一文件，非复制）；
        // embed=true 供 SiteNav2 布局切全高模式（.play 根 height:100% 需完整高度链）
        path: "workspace",
        name: "Workspace2",
        component: () => import("@/views/embed/EmbedPlay.vue"),
        meta: { embed: true },
      },
      {
        // 单文件模式：复用原 demo FilePlay（同一文件）；原 /play/* 三条原样保留（原版 demo 不动）
        path: "singlefile",
        name: "Singlefile2",
        component: () => import("@/views/embed/FilePlay.vue"),
        meta: { embed: true },
      },
    ],
  },
  {
    path: "/legacy",
    component: () => import("@/layout/legacy/LegacySiteLayout.vue"),
    children: [
      {
        path: "",
        name: "LegacyHome",
        component: () => import("@/views/legacy/LegacyHome.vue"),
        meta: { title: "site.nav.home" },
      },
      {
        path: "docs/:slug?",
        name: "LegacyDocs",
        component: () => import("@/views/legacy/LegacyDocs.vue"),
        meta: { title: "site.nav.docs" },
      },
    ],
  },
  {
    path: "/play",
    component: () => import("@/layout/AppLayout.vue"),
    children: [
      {
        path: "overview",
        name: "Overview",
        component: () => import("@/views/Overview.vue"),
        meta: { title: "demo.nav.overview", icon: "Compass" },
      },
      {
        path: "workspace",
        name: "EmbedPlay",
        component: () => import("@/views/embed/EmbedPlay.vue"),
        meta: { title: "demo.nav.workspace", icon: "FolderOpened" },
      },
      {
        path: "file",
        name: "FilePlay",
        component: () => import("@/views/embed/FilePlay.vue"),
        meta: { title: "demo.nav.file", icon: "Document" },
      },
    ],
  },
  // 旧首页路径兼容（/home → /）
  { path: "/home", redirect: "/" },
  // 旧路径重定向（原 demo 深链兼容）
  { path: "/overview", redirect: "/play/overview" },
  { path: "/embed/play", redirect: "/play/workspace" },
  { path: "/embed/file", redirect: "/play/file" },
  /** 未匹配路由兜底：回新站首页，避免未知 URL 渲染成空白页 */
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

/** 尊重系统「减弱动态效果」：hash 滚动退化为即时跳转 */
function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 官网首页锚点（footer「能力一览」等）：滚过 sticky 头部
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash, top: 96, behavior: reducedMotion() ? "auto" : "smooth" };
    return { top: 0 };
  },
});

router.afterEach((to) => {
  // fc-web-sdk §2.1：title 走 i18n（meta.title 为词典 key；router 层在 setup 外，用 global scope）
  const meta = to.meta as { title?: string };
  const app = "mmagix-files";
  document.title = meta.title ? `${i18n.global.t(meta.title)} · ${app}` : app;
});

export default router;
