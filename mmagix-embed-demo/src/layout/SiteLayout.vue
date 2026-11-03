<script setup lang="ts">
// 官网骨架：sticky 头部（滚动收窄：padding 换挡不动画 + 发丝线 opacity 淡入）+ index-columns footer。
// 主题/品牌归 App.vue 的 FcThemeProvider；语言切换沿用 AppLayout 口径（fc-demo-locale 持久化）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { FcThemeSwitcher } from "@/components/sdk";

const { t, locale } = useI18n();
const route = useRoute();

const navs = computed(() => [
  { path: "/", label: t("site.nav.home"), exact: true },
  { path: "/docs", label: t("site.nav.docs"), exact: false },
  { path: "/play/workspace", label: t("site.nav.play"), exact: false },
]);

function isActive(nav: { path: string; exact: boolean }): boolean {
  return nav.exact ? route.path === nav.path : route.path.startsWith(nav.path);
}

// retracting bar：滚动后 padding 换挡（即时切换,不动画 padding——Hallmark 10b）,
// 视觉反馈交给底部发丝线/阴影的 opacity 淡入（仅 opacity,配 prefers-reduced-motion 兜底）。
const scrolled = ref(false);
function onScroll(): void {
  scrolled.value = window.scrollY > 8;
}
onMounted(() => {
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
});
onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));

/** 语言即时切换 + LocalStorage 持久化（同 AppLayout：fc-demo-locale 只存语言） */
function toggleLocale() {
  locale.value = locale.value === "zh-CN" ? "en-US" : "zh-CN";
}
watch(locale, (v) => localStorage.setItem("fc-demo-locale", v));

/** footer index columns：品牌列 + 产品/文档/协议三列（站内路由） */
const columns = computed(() => [
  {
    title: t("site.footer.product"),
    links: [
      { label: t("site.nav.home"), to: "/" },
      { label: t("site.nav.play"), to: "/play/workspace" },
      { label: t("site.footer.capabilities"), to: "/#capabilities" },
    ],
  },
  {
    title: t("site.footer.docs"),
    links: [
      { label: t("site.doclink.guide"), to: "/docs/user-guide" },
      { label: t("site.doclink.deploy"), to: "/docs/deployment" },
      { label: t("site.doclink.webdav"), to: "/docs/webdav" },
      { label: t("docs.doc.changelog"), to: "/docs/changelog" },
    ],
  },
  {
    title: t("site.footer.protocol"),
    links: [
      { label: t("site.doclink.jsdk"), to: "/docs/jsdk-api" },
      { label: t("docs.doc.architecture"), to: "/docs/architecture" },
      { label: t("docs.doc.plugin-system"), to: "/docs/plugin-system" },
      { label: t("docs.doc.readme"), to: "/docs/readme" },
    ],
  },
]);
</script>

<template>
  <div class="site-layout">
    <header class="site-header" :class="{ 'is-scrolled': scrolled }">
      <span class="veil" aria-hidden="true"></span>
      <div class="bar">
        <RouterLink to="/" class="brand">
          <span class="mark"><i class="ri-folder-3-line" aria-hidden="true"></i></span>
          <strong>MMagiX Files</strong>
        </RouterLink>
        <nav class="nav" aria-label="site">
          <RouterLink v-for="nav in navs" :key="nav.path" :to="nav.path" class="nav-link" :class="{ active: isActive(nav) }">
            {{ nav.label }}
          </RouterLink>
        </nav>
        <div class="actions">
          <button type="button" class="locale-toggle" @click="toggleLocale">{{ locale === "zh-CN" ? "EN" : "中" }}</button>
          <FcThemeSwitcher variant="popover" />
        </div>
      </div>
    </header>

    <main class="site-main">
      <router-view />
    </main>

    <footer class="site-footer">
      <div class="foot-grid">
        <div class="brand-col">
          <div class="brand">
            <span class="mark"><i class="ri-folder-3-line" aria-hidden="true"></i></span>
            <strong>MMagiX Files</strong>
          </div>
          <p class="blurb">{{ t("site.footer.blurb") }}</p>
        </div>
        <nav v-for="col in columns" :key="col.title" class="foot-col" :aria-label="col.title">
          <p class="col-title">{{ col.title }}</p>
          <RouterLink v-for="link in col.links" :key="link.to" :to="link.to">{{ link.label }}</RouterLink>
        </nav>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.site-layout {
  // 头部基准高度：hero 视口扣减、Docs 侧栏 sticky 偏移都引用它
  --site-header-h: 64px;
  // 容器封顶（Hallmark 44d）+ 次级墨阶（token 混合,text-tertiary 在纸面 2.54:1 不达 4.5 红线）
  --container: 1360px;
  --ink-soft: color-mix(in srgb, var(--app-text-secondary) 75%, var(--app-text-primary));
  --ink-faint: color-mix(in srgb, var(--app-text-tertiary) 50%, var(--app-text-primary));
  min-height: 100dvh; display: flex; flex-direction: column;
}

/* sticky header（banner over a retracting bar） */
.site-header { position: sticky; top: 0; z-index: 20; background: var(--app-bg-card); }
.veil { position: absolute; left: 0; right: 0; bottom: 0; height: 1px; background: var(--app-separator); box-shadow: var(--app-shadow-md); opacity: 0; transition: opacity 0.2s ease; }
.site-header.is-scrolled .veil { opacity: 1; }
.bar { display: flex; align-items: center; gap: var(--space-lg); width: 100%; max-width: var(--container, 1360px); margin: 0 auto; padding: var(--space-md) var(--space-lg); }
.site-header.is-scrolled .bar { padding-top: var(--space-sm); padding-bottom: var(--space-sm); }

.brand { display: inline-flex; align-items: center; gap: var(--space-sm); color: var(--app-text-primary); text-decoration: none; font-weight: 700; font-size: 16px; white-space: nowrap;
  .mark { display: inline-flex; color: var(--app-primary); font-size: 18px; } }

.nav { display: flex; gap: var(--space-xs); }
.nav-link { display: inline-flex; align-items: center; padding: var(--space-sm) var(--space-md); border-radius: var(--app-radius-sm); color: var(--ink-soft); font-size: 14px; text-decoration: none; white-space: nowrap;
  &:hover { color: var(--app-text-primary); background: var(--app-bg-muted); }
  &.active { color: var(--app-primary); background: color-mix(in srgb, var(--app-primary) 12%, transparent); font-weight: 600; } }

.actions { display: flex; align-items: center; gap: var(--space-xs); margin-left: auto; }
.locale-toggle { min-width: var(--space-xl); padding: var(--space-xs) var(--space-sm); border: 1px solid var(--app-separator); border-radius: var(--app-radius-sm); background: transparent; color: var(--ink-soft); font-size: 13px; white-space: nowrap; cursor: pointer;
  &:hover { color: var(--app-text-primary); background: var(--app-bg-muted); }
  &:active { background: color-mix(in srgb, var(--app-primary) 10%, transparent); }
  &:disabled { opacity: 0.5; cursor: not-allowed; } }

/* 头部/footer 所有可交互元素：即时 focus ring（Hallmark 15/26a） */
.site-header :focus-visible, .site-footer :focus-visible { outline: 2px solid var(--app-primary); outline-offset: 2px; }

/* footer（index columns） */
.site-footer { margin-top: auto; border-top: 1px solid var(--app-separator); background: var(--app-bg-card); }
.foot-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-lg); width: 100%; max-width: var(--container, 1360px); margin: 0 auto; padding: var(--space-xl) var(--space-lg); }
.blurb { margin: var(--space-sm) 0 0; color: var(--ink-soft); font-size: 13px; max-width: 32ch; }
.col-title { margin: 0 0 var(--space-sm); font-size: 13px; font-weight: 600; color: var(--ink-soft); }
.foot-col { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-xs);
  a { color: var(--ink-soft); font-size: 13px; text-decoration: none;
    &:hover { color: var(--app-primary); text-decoration: underline; text-underline-offset: 3px; } } }

/* 响应式：窄屏收导航（导航属 F25 例外项），footer 降列 */
@media (max-width: 860px) {
  .nav { display: none; }
  .foot-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
@media (max-width: 540px) {
  .foot-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .veil { transition: none; }
}
</style>
