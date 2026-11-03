import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import i18n from "@/locales";

/**
 * 官网化路由：
 *   /            官网骨架（SiteLayout）→ 首页 + 文档中心
 *   /play/*      在线演示（AppLayout，原 demo 三页）
 *   旧路径       /overview、/embed/* 全部重定向，README/外链不断
 */
const routes: RouteRecordRaw[] = [
  {
    path: "/",
    component: () => import("@/layout/SiteLayout.vue"),
    children: [
      {
        path: "",
        name: "Home",
        component: () => import("@/views/Home.vue"),
        meta: { title: "site.nav.home" },
      },
      {
        path: "docs/:slug?",
        name: "Docs",
        component: () => import("@/views/Docs.vue"),
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
  // 旧路径重定向（原 demo 深链兼容）
  { path: "/overview", redirect: "/play/overview" },
  { path: "/embed/play", redirect: "/play/workspace" },
  { path: "/embed/file", redirect: "/play/file" },
  /** 未匹配路由兜底：回官网首页，避免未知 URL 渲染成空白页 */
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

/** 尊重系统「减弱动态效果」：hash 滚动退化为即时跳转 */
function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 官网首页锚点（footer「能力一览���等）：滚过 sticky 头部
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
