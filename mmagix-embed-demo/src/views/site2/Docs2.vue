<script setup lang="ts">
// site2 文档中心（/docs/:slug? 新壳；S07 preview-split 的文档壳用法：左=文档目录，右=渲染正文，无文件操作条）。
// 渲染管线全部复用 src/docs/manifest.ts + src/docs/markdown.ts（groupManifest/loadDoc/renderMarkdown 直接 import，不复制逻辑），
// 与 legacy 功能 parity：slug 缺省取 manifest 首条、未命中空态、glob eager:false 懒加载、过期加载按序号丢弃。
// 相对 LegacyDocs 只换布局与视觉：目录 280px + signal 竖条高亮（sticky 对齐 SiteNav2 64px+24）、
// 内容顶条面包屑（不建新导航，全局导航是 SiteNav2）、右缘信息面板（≥1280px，仅来源路径+发布说明，不造假数据）、
// 正文底部上一篇/下一篇（manifest 顺序，新增小功能）。
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { FcEmpty } from "@/components/sdk";
import { DOC_MANIFEST, type DocEntry } from "@/docs/manifest";
import { groupManifest, loadDoc, renderMarkdown } from "@/docs/markdown";

const { t } = useI18n();
const route = useRoute();

const groups = groupManifest();

/** /docs 缺省 slug=manifest 首条；未收录 slug → 空态（同 LegacyDocs 口径） */
const slug = computed(() => (route.params.slug as string | undefined) ?? DOC_MANIFEST[0]?.slug);
const entry = computed(() => DOC_MANIFEST.find((d) => d.slug === slug.value));

/** 前后篇：manifest 声明顺序（legacy 无此导航） */
const idx = computed(() => DOC_MANIFEST.findIndex((d) => d.slug === slug.value));
const prev = computed(() => (idx.value > 0 ? DOC_MANIFEST[idx.value - 1] : undefined));
const next = computed(() =>
  idx.value >= 0 && idx.value < DOC_MANIFEST.length - 1 ? DOC_MANIFEST[idx.value + 1] : undefined,
);

/** 信息面板来源路径：manifest.path 相对 src/docs（'../../..' 即仓根），剥掉 ../ 前缀 = repo 相对路径 */
const repoPath = computed(() => entry.value?.path.replace(/^(?:\.\.\/)+/, "") ?? "");

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
  <div class="docs2">
    <!-- 左：文档目录（S07 左窄列表的文档壳用法） -->
    <aside class="docs2-toc">
      <nav class="toc-sticky">
        <div v-for="g in groups" :key="g.key" class="toc-group">
          <p class="toc-group-name">{{ t(g.key) }}</p>
          <RouterLink
            v-for="d in g.items"
            :key="d.slug"
            :to="`/docs/${d.slug}`"
            class="toc-item"
            :class="{ active: d.slug === slug }"
          >
            {{ t(`docs.doc.${d.slug}`) }}
          </RouterLink>
        </div>
      </nav>
    </aside>

    <!-- 右大内容区：容器封顶 72ch 居中 -->
    <section class="docs2-main">
      <div class="docs2-inner">
        <!-- 顶条：面包屑 + 返回首页（放内容区顶部，不建新导航） -->
        <header class="docs2-crumb">
          <span class="crumb-root">{{ t("site2.nav.docs") }}</span>
          <span v-if="entry" class="crumb-sep">·</span>
          <strong v-if="entry" class="crumb-title">{{ t(`docs.doc.${entry.slug}`) }}</strong>
          <RouterLink class="back-home" to="/">{{ t("site2.docs.backHome") }}</RouterLink>
        </header>

        <FcEmpty v-if="state === 'loading'" type="processing" :title="t('docs.loading')" />
        <FcEmpty
          v-else-if="state === 'missing'"
          type="search"
          :title="t('docs.empty.title')"
          :description="t('docs.empty.desc')"
        />
        <template v-else>
          <!-- eslint-disable-next-line vue/no-v-html —— 渲染产物已过 DOMPurify.sanitize（markdown.ts 唯一出口） -->
          <div class="md2-body" v-html="html" />

          <!-- 前后篇导航（manifest 顺序） -->
          <nav v-if="prev || next" class="docs2-pn" aria-label="pager">
            <RouterLink v-if="prev" :to="`/docs/${prev.slug}`" class="pn-link">
              <span class="pn-label">{{ t("site2.docs.prev") }}</span>
              <span class="pn-title">{{ t(`docs.doc.${prev.slug}`) }}</span>
            </RouterLink>
            <RouterLink v-if="next" :to="`/docs/${next.slug}`" class="pn-link pn-next">
              <span class="pn-label">{{ t("site2.docs.next") }}</span>
              <span class="pn-title">{{ t(`docs.doc.${next.slug}`) }}</span>
            </RouterLink>
          </nav>
        </template>
      </div>
    </section>

    <!-- 右缘信息面板（≥1280px；仅两行事实：来源路径 + 发布说明） -->
    <aside v-if="entry" class="docs2-info">
      <p class="info-label">{{ t("site2.docs.sourceLabel") }}</p>
      <p class="info-path">{{ repoPath }}</p>
      <p class="info-note">{{ t("site2.docs.localNote") }}</p>
    </aside>
  </div>
</template>

<style scoped lang="scss">
// 三栏 pane 布局（S07 语言：左窄目录 | 右大内容 | 右缘信息面板，发丝线分隔）
.docs2 {
  display: grid;
  grid-template-columns: minmax(0, 280px) minmax(0, 1fr);
  width: 100%;
  max-width: var(--site2-container, 1360px);
  margin: 0 auto;
  padding: var(--space-xl, 32px) var(--space-lg, 16px) 0;
  box-sizing: border-box;
  align-items: stretch;
}

/* 左目录：发丝线夹右缘；内部 sticky 对齐 SiteNav2 高度（64px）+ 24 */
.docs2-toc {
  min-width: 0;
  border-right: 1px solid var(--app-separator);
}
.toc-sticky {
  position: sticky;
  top: calc(var(--site2-header-h, 64px) + var(--space-lg, 24px));
  padding: var(--space-xs, 4px) var(--space-lg, 24px) var(--space-lg, 24px) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md, 16px);
}
.toc-group-name {
  margin: 0 0 var(--space-xs, 4px);
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text-secondary);
}
.toc-item {
  position: relative;
  display: block;
  padding: var(--space-xs, 4px) var(--space-sm, 8px);
  border-radius: var(--app-radius-sm, 6px);
  color: var(--app-text-secondary);
  font-size: 13px;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  &:hover { color: var(--app-text-primary); background: var(--app-bg-muted); }
  // 当前 slug：wash 高亮 + 左缘 signal 竖条（S07 .frow.sel 口径）
  &.active {
    color: var(--app-primary);
    background: color-mix(in srgb, var(--app-primary) 8%, transparent);
    font-weight: 600;
    &::before {
      content: "";
      position: absolute;
      left: 0;
      top: 8px;
      bottom: 8px;
      width: 3px;
      border-radius: 2px;
      background: var(--app-primary);
    }
  }
}

/* 右大内容区 */
.docs2-main {
  min-width: 0;
  padding: 0 var(--space-2xl, 48px) var(--space-xl, 32px);
}
.docs2-inner {
  max-width: 72ch;
  margin: 0 auto;
}

/* 顶条：面包屑 + 返回首页 */
.docs2-crumb {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm, 8px);
  margin: 0 0 var(--space-lg, 24px);
  padding-bottom: var(--space-sm, 8px);
  border-bottom: 1px solid var(--app-separator);
  .crumb-root { color: var(--app-text-tertiary); font-size: 13px; white-space: nowrap; }
  .crumb-sep { color: var(--app-text-quaternary, var(--app-text-tertiary)); font-size: 13px; }
  .crumb-title {
    color: var(--app-text-primary); font-size: 14px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .back-home {
    margin-left: auto; color: var(--app-primary); font-size: 13px; text-decoration: none; white-space: nowrap;
    &:hover { text-decoration: underline; text-underline-offset: 3px; }
  }
}

/* 正文排版（自 LegacyDocs .md-body 改造，token 全走 --app-*）；
   v-html 产物非本组件模板，统一 :deep 穿透 */
.md2-body {
  :deep(h1) { margin: var(--space-sm, 8px) 0 var(--space-md, 16px); font-size: 30px; line-height: 1.25; color: var(--app-text-primary); overflow-wrap: break-word; }
  :deep(h2) { margin: var(--space-xl, 32px) 0 var(--space-sm, 8px); padding-bottom: var(--space-xs, 4px); border-bottom: 1px solid var(--app-separator); font-size: 22px; line-height: 1.3; color: var(--app-text-primary); overflow-wrap: break-word; }
  :deep(h3) { margin: var(--space-lg, 24px) 0 var(--space-sm, 8px); font-size: 17px; line-height: 1.35; color: var(--app-text-primary); }
  :deep(h4), :deep(h5), :deep(h6) { margin: var(--space-md, 16px) 0 var(--space-sm, 8px); font-size: 15px; color: var(--app-text-primary); }
  :deep(p), :deep(li) { margin: var(--space-sm, 8px) 0; color: var(--app-text-secondary); font-size: 14px; line-height: 1.75; }
  :deep(a) { color: var(--app-primary); text-decoration: none;
    &:hover { text-decoration: underline; text-underline-offset: 3px; } }
  :deep(strong) { color: var(--app-text-primary); }
  :deep(code) { font-family: var(--font-mono); font-size: 12.5px; background: var(--app-bg-muted); padding: 2px var(--space-xs, 4px); border-radius: var(--app-radius-sm, 6px); }
  // 代码块：token 深色面板（--app-text-primary/--app-bg-card 反转），mono 栈
  :deep(pre) { background: var(--app-text-primary); padding: var(--space-md, 16px); border-radius: var(--app-radius-md, 12px); overflow-x: auto; }
  :deep(pre code) { background: transparent; padding: 0; color: var(--app-bg-card); font-size: 12.5px; line-height: 1.7; }
  // 表格：发丝线；块级+横向内滚，防长表撑破容器
  :deep(table) { display: block; width: 100%; margin: var(--space-md, 16px) 0; border-collapse: collapse; font-size: 13px; overflow-x: auto; }
  :deep(th), :deep(td) { border: 1px solid var(--app-separator); padding: var(--space-xs, 4px) var(--space-sm, 8px); text-align: left; vertical-align: top; }
  :deep(th) { background: var(--app-bg-muted); color: var(--app-text-tertiary); font-weight: 600; }
  :deep(blockquote) { margin: var(--space-md, 16px) 0; padding: var(--space-sm, 8px) var(--space-md, 16px); border: 1px solid var(--app-separator); border-radius: var(--app-radius-sm, 6px); background: var(--app-bg-muted); color: var(--app-text-secondary);
    p { margin: var(--space-xs, 4px) 0; } }
  :deep(hr) { margin: var(--space-xl, 32px) 0; border: none; border-top: 1px solid var(--app-separator); }
  :deep(img) { max-width: 100%; }
}

/* 前后篇导航 */
.docs2-pn {
  display: flex;
  gap: var(--space-md, 16px);
  margin-top: var(--space-xl, 32px);
  padding-top: var(--space-md, 16px);
  border-top: 1px solid var(--app-separator);
}
.pn-link {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 48%;
  padding: var(--space-sm, 8px) var(--space-md, 16px);
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-sm, 6px);
  text-decoration: none;
  .pn-label { color: var(--app-text-tertiary); font-size: 12px; }
  .pn-title { color: var(--app-primary); font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &:hover { border-color: var(--app-primary); background: var(--app-bg-muted); }
}
.pn-next { margin-left: auto; text-align: right; }

/* 右缘信息面板：<1280 隐藏 */
.docs2-info {
  display: none;
}

@media (min-width: 1280px) {
  .docs2 { grid-template-columns: minmax(0, 280px) minmax(0, 1fr) minmax(0, 220px); }
  .docs2-info {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-xs, 4px);
    min-width: 0;
    padding-left: var(--space-lg, 24px);
    border-left: 1px solid var(--app-separator);
    .info-label { margin: 0; font-size: 12px; font-weight: 600; color: var(--app-text-secondary); }
    .info-path { margin: 0; font-family: var(--font-mono); font-size: 12px; color: var(--app-text-tertiary); overflow-wrap: anywhere; }
    .info-note { margin: var(--space-sm, 8px) 0 0; padding-top: var(--space-sm, 8px); border-top: 1px solid var(--app-separator); color: var(--app-text-tertiary); font-size: 12px; line-height: 1.6; }
  }
}

/* 响应式：窄屏目录退化为顶部块（发丝线移到底边） */
@media (max-width: 900px) {
  .docs2 { grid-template-columns: minmax(0, 1fr); }
  .docs2-toc { border-right: none; border-bottom: 1px solid var(--app-separator); }
  .toc-sticky { position: static; padding: 0 0 var(--space-lg, 24px); }
  .docs2-main { padding-left: 0; padding-right: 0; }
}
</style>
