<script setup lang="ts">
// 文档中心：左 manifest 树（curated,src/docs/manifest.ts）+ 右 markdown 渲染（marked→DOMPurify）。
// 内容区封顶 72ch（Hallmark 25）；侧栏 sticky 偏移避开 sticky 头部（56）；过期加载按序号丢弃。
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { FcEmpty } from "@/components/sdk";
import { DOC_MANIFEST, type DocEntry } from "@/docs/manifest";
import { groupManifest, loadDoc, renderMarkdown } from "@/docs/markdown";

const { t } = useI18n();
const route = useRoute();

const groups = groupManifest();

/** /docs 缺省 slug=manifest 首条；未收录 slug → 空态 */
const slug = computed(() => (route.params.slug as string | undefined) ?? DOC_MANIFEST[0]?.slug);
const entry = computed(() => DOC_MANIFEST.find((d) => d.slug === slug.value));

const html = ref("");
const state = ref<"loading" | "ready" | "missing">("loading");
let seq = 0;

async function load(): Promise<void> {
  const e: DocEntry | undefined = entry.value;
  const id = ++seq;
  if (!e) {
    state.value = "missing";
    html.value = "";
    return;
  }
  state.value = "loading";
  const raw = await loadDoc(e);
  if (id !== seq) return; // 已切走：丢弃过期结果
  if (raw === undefined) {
    state.value = "missing";
    return;
  }
  html.value = await renderMarkdown(raw);
  if (id !== seq) return;
  state.value = "ready";
}

watch(slug, () => void load(), { immediate: true });
</script>

<template>
  <div class="docs-page">
    <aside class="toc">
      <div v-for="g in groups" :key="g.key" class="toc-group">
        <p class="toc-title">{{ t(g.key) }}</p>
        <RouterLink v-for="d in g.items" :key="d.slug" :to="`/docs/${d.slug}`" class="toc-link" :class="{ active: d.slug === slug }">
          {{ t(`docs.doc.${d.slug}`) }}
        </RouterLink>
      </div>
    </aside>

    <article class="doc">
      <FcEmpty v-if="state === 'loading'" type="processing" :title="t('docs.loading')" />
      <FcEmpty v-else-if="state === 'missing'" type="search" :title="t('docs.empty.title')" :description="t('docs.empty.desc')" />
      <!-- eslint-disable-next-line vue/no-v-html —— 渲染产物已过 DOMPurify.sanitize（markdown.ts 唯一出口） -->
      <div v-else class="md-body" v-html="html" />
    </article>
  </div>
</template>

<style scoped lang="scss">
.docs-page {
  // 次级墨阶（同 Home/SiteLayout）继承自 .site-layout；此处只管布局
  display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: var(--space-xl); align-items: start;
  width: 100%; max-width: var(--container, 1360px); margin: 0 auto; padding: var(--space-xl) var(--space-lg);
}

/* 侧栏 manifest 树 */
.toc {
  // 避开 sticky 头部（Hallmark 56：第二个 sticky 不用 top:0）
  position: sticky; top: calc(var(--site-header-h, 64px) + var(--space-lg));
  display: flex; flex-direction: column; gap: var(--space-md); min-width: 0;
}
.toc-title { margin: 0 0 var(--space-xs); font-size: 12px; font-weight: 600; color: var(--ink-faint); }
.toc-link {
  display: block; padding: var(--space-xs) var(--space-sm); border-radius: var(--app-radius-sm); color: var(--ink-soft); font-size: 13px;
  text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  &:hover { color: var(--app-primary); background: var(--app-bg-muted); }
  &.active { color: var(--app-primary); background: color-mix(in srgb, var(--app-primary) 10%, transparent); font-weight: 600; }
}

/* 内容区（封顶 72ch）；v-html 产物非本组件模板,统一 :deep 穿透,配色全走 token */
.doc { min-width: 0; max-width: 72ch; }
.md-body {
  :deep(h1) { margin: var(--space-sm) 0 var(--space-md); font-size: 30px; line-height: 1.25; overflow-wrap: break-word; }
  :deep(h2) { margin: var(--space-xl) 0 var(--space-sm); padding-bottom: var(--space-xs); border-bottom: 1px solid var(--app-separator); font-size: 22px; line-height: 1.3; overflow-wrap: break-word; }
  :deep(h3) { margin: var(--space-lg) 0 var(--space-sm); font-size: 17px; line-height: 1.35; }
  :deep(h4), :deep(h5), :deep(h6) { margin: var(--space-md) 0 var(--space-sm); font-size: 15px; }
  :deep(p), :deep(li) { margin: var(--space-sm) 0; color: var(--ink-soft); font-size: 14px; line-height: 1.75; }
  :deep(a) { color: var(--app-primary); text-decoration: none;
    &:hover { text-decoration: underline; text-underline-offset: 3px; } }
  :deep(strong) { color: var(--app-text-primary); }
  :deep(code) { font-family: var(--font-mono); font-size: 12.5px; background: var(--app-bg-muted); padding: 2px var(--space-xs); border-radius: var(--app-radius-sm); }
  /* 代码块：graphite 深色面板（token 反转）,无语法高亮 */
  :deep(pre) { background: var(--app-text-primary); padding: var(--space-md); border-radius: var(--app-radius-md); overflow-x: auto; }
  :deep(pre code) { background: transparent; padding: 0; color: var(--app-bg-card); font-size: 12.5px; line-height: 1.7; }
  /* 表格：发丝线；块级+横向内滚,防长表撑破容器（Hallmark 34） */
  :deep(table) { display: block; width: 100%; margin: var(--space-md) 0; border-collapse: collapse; font-size: 13px; overflow-x: auto; }
  :deep(th), :deep(td) { border: 1px solid var(--app-separator); padding: var(--space-xs) var(--space-sm); text-align: left; vertical-align: top; }
  :deep(th) { background: var(--app-bg-muted); color: var(--ink-faint); font-weight: 600; }
  :deep(blockquote) { margin: var(--space-md) 0; padding: var(--space-sm) var(--space-md); border: 1px solid var(--app-separator); border-radius: var(--app-radius-sm); background: var(--app-bg-muted); color: var(--ink-soft);
    p { margin: var(--space-xs) 0; } }
  :deep(hr) { margin: var(--space-xl) 0; border: none; border-top: 1px solid var(--app-separator); }
  :deep(img) { max-width: 100%; }
}

/* 响应式：窄屏侧栏退化为顶部块 */
@media (max-width: 900px) {
  .docs-page { grid-template-columns: minmax(0, 1fr); }
  .toc { position: static; }
}
</style>
