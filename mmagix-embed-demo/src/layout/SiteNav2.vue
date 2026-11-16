<script setup lang="ts">
// 站点 v2 导航壳（S01 banner 导航，视觉正本 s01-home-hero.html）。
// 品牌（文件夹线稿 mark + MMagiX Files）+ 五导航项（首页 / 功能#features / 演示 / 文档 / 单文件）
// + 语言切换 + FcThemeSwitcher；主题/品牌归 App.vue 的 FcThemeProvider；
// 语言切换沿用旧站口径（fc-demo-locale 持久化）。当前态=原型同款下划线。
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { FcThemeSwitcher } from "@/components/sdk";

const { t, locale } = useI18n();
const route = useRoute();

// embed 路由（/workspace、/singlefile 挂原 demo 页，meta.embed）→ main 切全高模式（见样式段）
const isEmbed = computed(() => route.meta.embed === true);

// 五项：首页→/（当前态下划线）、功能→/#features（hash 锚点，router scrollBehavior 滚过 sticky 头）、
// 演示→/guide（当前态含 /workspace——引导步骤 4 交接落地的工作台页）、文档→/docs、
// 单文件→/singlefile（第四项后插入；带线稿文件图标，前缀匹配当前态）
const navs = computed(() => [
  { path: "/", label: t("site2.nav.home"), match: () => route.path === "/" && !route.hash, icon: false },
  { path: "/#features", label: t("site2.nav.features"), match: () => route.path === "/" && route.hash === "#features", icon: false },
  { path: "/guide", label: t("site2.nav.guide"), match: () => route.path.startsWith("/guide") || route.path === "/workspace", icon: false },
  { path: "/docs", label: t("site2.nav.docs"), match: () => route.path.startsWith("/docs"), icon: false },
  { path: "/singlefile", label: t("site2.nav.singlefile"), match: () => route.path.startsWith("/singlefile"), icon: true },
]);

/** 语言即时切换 + LocalStorage 持久化（同 LegacySiteLayout/AppLayout：fc-demo-locale 只存语言） */
function toggleLocale() {
  locale.value = locale.value === "zh-CN" ? "en-US" : "zh-CN";
}
watch(locale, (v) => localStorage.setItem("fc-demo-locale", v));
</script>

<template>
  <div class="site2-layout">
    <header class="site2-header">
      <div class="site2-bar">
        <RouterLink to="/" class="site2-brand">
          <svg class="site2-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>
          <strong>MMagiX Files</strong>
        </RouterLink>
        <nav class="site2-nav" aria-label="site2">
          <RouterLink
            v-for="nav in navs"
            :key="nav.path"
            :to="nav.path"
            class="site2-nav-link"
            :class="{ active: nav.match() }"
          >
            <svg v-if="nav.icon" class="site2-nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M6 3h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /></svg>
            {{ nav.label }}
          </RouterLink>
        </nav>
        <div class="site2-actions">
          <button type="button" class="site2-locale" @click="toggleLocale">{{ locale === "zh-CN" ? "EN" : "中" }}</button>
          <FcThemeSwitcher variant="popover" />
        </div>
      </div>
    </header>

    <main class="site2-main" :class="{ embed: isEmbed }">
      <router-view />
    </main>
  </div>
</template>

<style scoped lang="scss">
// 头部基准高度与容器封顶：site2 页面引用（与旧站 --site-header-h/--container 口径一致）
.site2-layout {
  --site2-header-h: 64px;
  --site2-container: 1360px;
  --site2-wash: color-mix(in srgb, var(--app-primary) 8%, transparent);
  min-height: 100dvh; display: flex; flex-direction: column;
}

// sticky 顶导航：高 64，发丝线夹底
.site2-header {
  position: sticky; top: 0; z-index: 20;
  background: var(--app-bg-card);
  border-bottom: 1px solid var(--app-separator);
}
.site2-bar {
  display: flex; align-items: center; gap: var(--space-md, 16px);
  width: 100%; max-width: var(--site2-container); margin: 0 auto;
  padding: 0 var(--space-lg, 24px);
  min-height: var(--site2-header-h); box-sizing: border-box;
}

.site2-brand {
  display: inline-flex; align-items: center; gap: var(--space-sm, 8px);
  color: var(--app-text-primary); text-decoration: none; font-weight: 700; font-size: 16px; white-space: nowrap;
  .site2-mark { width: 22px; height: 22px; color: var(--app-primary); flex: none; }
  &:hover strong { color: var(--app-primary); }
}

.site2-nav { margin: 0 auto; display: flex; gap: var(--space-xs, 4px); }
// 单文件项图标：ri-file-line 同款线稿（stroke 1.5，随链接色 hover/active 变化）
.site2-nav-ico { width: 15px; height: 15px; margin-right: 5px; flex: none; }
.site2-nav-link {
  display: inline-flex; align-items: center;
  padding: 6px 14px;
  border-radius: var(--radius-full, 9999px);
  color: var(--app-text-secondary); font-size: 14px; text-decoration: none; white-space: nowrap;
  &:hover { background: var(--site2-wash); color: var(--app-text-primary); }
  // 当前态：原型同款信号色下划线
  &.active {
    color: var(--app-text-primary); font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--app-primary); border-radius: 0;
  }
}

.site2-actions { display: flex; align-items: center; gap: var(--space-sm, 8px); }
.site2-locale {
  display: inline-flex; align-items: center; gap: 4px;
  height: 28px; padding: 0 10px;
  border: 1px solid var(--app-separator); border-radius: var(--radius-full, 9999px);
  background: var(--app-bg-card); color: var(--app-text-secondary);
  font-size: 12.5px; white-space: nowrap; cursor: pointer;
  &:hover { border-color: var(--app-text-tertiary); color: var(--app-text-primary); }
}

.site2-main { flex: 1 0 auto; }

// embed 全高模式（/workspace、/singlefile）：EmbedPlay/FilePlay 根 .play 为 height:100% 弹性布局，
// 需要完整高度链——main 定高=视口−头 64、overflow hidden、padding 0（页面自带留白，容器不再叠加）；
// 其余页面保持上方常流式容器不动
.site2-main.embed {
  height: calc(100vh - var(--site2-header-h, 64px));
  overflow: hidden;
  padding: 0;
}

.site2-header :focus-visible { outline: 2px solid var(--app-primary); outline-offset: 2px; }

@media (prefers-reduced-motion: no-preference) {
  .site2-nav-link, .site2-locale { transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
}

// 窄屏折叠：中间导航项隐藏（锚点入口在页内仍在）
@media (max-width: 768px) {
  .site2-nav { display: none; }
}
</style>
