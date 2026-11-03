<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { FcButton, FcHeader, FcThemeSwitcher } from "@/components/sdk";
import { OEM_CONFIG } from "@/config/oem";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();

const navs = computed(() => [
  { path: "/play/overview", label: t("demo.nav.overview"), icon: "ri-compass-3-line" },
  { path: "/play/workspace", label: t("demo.nav.workspace"), icon: "ri-folder-opened-line" },
  { path: "/play/file", label: t("demo.nav.file"), icon: "ri-file-line" },
]);

const activePath = computed(() => route.path);

/** 语言即时切换 + LocalStorage 持久化（fc-web-sdk §2.1；主题/品牌归 FcThemeProvider，fc-demo-locale 只存语言） */
function toggleLocale() {
  locale.value = locale.value === "zh-CN" ? "en-US" : "zh-CN";
}
watch(locale, (v) => localStorage.setItem("fc-demo-locale", v));
</script>

<template>
  <div class="app-shell">
    <FcHeader>
      <template #brand>
        <div class="app-logo">
          <span class="logo-mark"><i class="ri-folder-3-line"></i></span>
          <strong>{{ OEM_CONFIG.appName }}</strong>
          <small>{{ t("demo.app.subtitle") }}</small>
        </div>
      </template>

      <template #actions>
        <nav class="app-nav">
          <button
            v-for="nav in navs"
            :key="nav.path"
            class="nav-item"
            :class="{ active: activePath.startsWith(nav.path) }"
            type="button"
            @click="router.push(nav.path)"
          >
            <i :class="nav.icon"></i>
            {{ nav.label }}
          </button>
        </nav>
        <FcButton variant="text" size="sm" class="locale-toggle" @click="toggleLocale">
          {{ locale === "zh-CN" ? "EN" : "中" }}
        </FcButton>
        <!-- fc-web-sdk §1.4：主题/品牌切换必用 sdk 组件（原自写 swatch 弹层已退役） -->
        <FcThemeSwitcher variant="popover" />
      </template>
    </FcHeader>

    <main class="app-page">
      <router-view />
    </main>
  </div>
</template>

<style scoped lang="scss">
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-logo {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
  color: var(--app-text-primary);

  .logo-mark {
    color: var(--app-primary);
  }
  small {
    color: var(--app-text-tertiary);
    font-weight: 400;
    font-size: var(--app-header-logo-subtitle-size);
  }
}

.app-nav {
  display: flex;
  gap: 4px;

  .nav-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: var(--app-text-secondary);
    padding: 8px 12px;
    border-radius: var(--app-radius-button);
    cursor: pointer;
    font-size: 14px;

    &:hover {
      background: var(--app-bg-muted);
      color: var(--app-text-primary);
    }
    &.active {
      background: color-mix(in srgb, var(--app-primary) 14%, transparent);
      color: var(--app-primary);
      font-weight: 600;
    }
  }
}

.locale-toggle {
  margin: 0 4px;
}
</style>
