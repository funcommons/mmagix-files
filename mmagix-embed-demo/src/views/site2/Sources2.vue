<script setup lang="ts">
/**
 * site2 /sources —— S11 数据源管理页（轻量版）
 * 原型：docs/design/site-redesign-v2/prototypes/s11-sources-panel.html
 *
 * ── 存储契约（正本）───────────────────────────────────────────────
 * 1. 最近连接档案：localStorage['mmagic.site2.recentSources']，JSON 数组：
 *      interface RecentSource {
 *        id: string; name: string;
 *        backendType: 's3' | 'webdav';
 *        endpoint: string;
 *        mountPath?: string;   // 挂载路径（人话：=你将看到的文件夹名）
 *        savedAt: number;      // epoch ms
 *      }
 *    写入方 = 连接成功的一侧（Guide2 在连接成功后 append 本页读取）；
 *    本页只做 读/移除/重连。坏 JSON / 非数组 / 非法条目 → 静默按空库
 *    （坏 JSON 顺带清键重建，对齐 frontend/src/files/profiles.ts 容错口径）。
 *    档案不含任何凭证字段（红线：凭证不出前端）。
 * 2. 手递带预填：sessionStorage['mmagic.site2.prefill']，值 JSON：
 *      { backendType: 's3' | 'webdav'; fields?: Partial<DemoFormFields> }
 *    「按用途添加」卡只带 backendType（不带凭证）；「重新连接」额外带
 *    fields（endpoint + mountPath 映射：s3→prefix / webdav→webdavRootPath）。
 *    消费方 = /guide（Guide2）。
 * 3. 读写全部 try/catch 静默容错（隐私模式/quota 降级为不持久，页面照常工作）。
 * ── 范围边界（用户裁决：纯 UI 增量）──────────────────────────────
 * 不做协议探测——状态灯只有灰态「未连接」，不连就不亮绿灯（诚实口径）；
 * 不改任何协议行为。
 */
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Plus } from "@element-plus/icons-vue";
import { FcButton, FcEmpty, FcTag } from "@/components/sdk";
import type { DemoFormFields } from "@/views/embed/configBuilder";

/** 最近连接档案 localStorage 键（契约见文件头） */
const STORAGE_KEY = "mmagic.site2.recentSources";
/** /guide 预填手递带 sessionStorage 键（契约见文件头） */
const PREFILL_KEY = "mmagic.site2.prefill";

type BackendType = DemoFormFields["backendType"]; // 's3' | 'webdav'

/** 最近连接档案（不含凭证；形状即契约，见文件头注释） */
interface RecentSource {
  id: string;
  name: string;
  backendType: BackendType;
  endpoint: string;
  mountPath?: string;
  savedAt: number;
}

/** 手递带值形状（/guide 消费契约，见文件头注释） */
interface GuidePrefill {
  backendType: BackendType;
  fields?: Partial<DemoFormFields>;
}

// ───────────────────────── 存储（读写静默容错） ─────────────────────────

/** 非空字符串判定（与 profiles.ts isNonEmptyString 同口径：纯空白视为空） */
function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** 条目校验：五字段形状逐一验（id/name/endpoint 非空串、backendType 枚举、savedAt 数字） */
function isRecentSource(v: unknown): v is RecentSource {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.name) &&
    (r.backendType === "s3" || r.backendType === "webdav") &&
    isNonEmptyString(r.endpoint) &&
    (r.mountPath === undefined || typeof r.mountPath === "string") &&
    typeof r.savedAt === "number"
  );
}

/** 清键（坏 JSON 重建，静默） */
function clearRecentSources(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 静默：隐私模式等受限环境按空库处理
  }
}

/** 读全部：缺失→[]；坏 JSON/非数组→清键按空库；非法条目过滤（防脏数据外溢） */
function readRecentSources(): RecentSource[] {
  let text: string | null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    return []; // 读取即抛（隐私模式）：按空库处理
  }
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    clearRecentSources(); // 损坏：清空重置（无抢救价值，对齐 profiles.ts）
    return [];
  }
  if (!Array.isArray(parsed)) {
    clearRecentSources();
    return [];
  }
  return parsed.filter(isRecentSource);
}

/** 写全部：静默容错（quota/禁写降级为不持久，内存态照常） */
function writeRecentSources(list: RecentSource[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 静默：不持久化不影响本会话
  }
}

/** 写 /guide 手递带（sessionStorage 随页签即焚，不落凭证） */
function writePrefill(payload: GuidePrefill): void {
  try {
    sessionStorage.setItem(PREFILL_KEY, JSON.stringify(payload));
  } catch {
    // 静默：受限环境跳转后 /guide 按无预填处理
  }
}

// ───────────────────────── 状态与动作 ─────────────────────────

const router = useRouter();
const { t } = useI18n();

/** 展示列表：新→旧（savedAt 降序，写入顺序无关） */
const recentSources = ref<RecentSource[]>(
  readRecentSources().sort((a, b) => b.savedAt - a.savedAt),
);

/** mountPath → 表单字段映射：s3=prefix / webdav=webdavRootPath（不含凭证） */
function fieldsFor(item: RecentSource): Partial<DemoFormFields> {
  const mount = item.mountPath;
  if (item.backendType === "webdav") {
    return { endpoint: item.endpoint, ...(mount ? { webdavRootPath: mount } : {}) };
  }
  return { endpoint: item.endpoint, ...(mount ? { prefix: mount } : {}) };
}

/** 重新连接：写手递带（类型+字段）→ /guide；Guide2 侧读 prefill 预填表单 */
function reconnect(item: RecentSource): void {
  writePrefill({ backendType: item.backendType, fields: fieldsFor(item) });
  router.push("/guide");
}

/** 忽略：从列表移除并落盘（空数组也照写——下次进页即为空态） */
function forget(id: string): void {
  recentSources.value = recentSources.value.filter((s) => s.id !== id);
  writeRecentSources(recentSources.value);
}

/** 按用途添加：只预填 backendType（不带凭证）→ /guide */
function addByType(backendType: BackendType): void {
  writePrefill({ backendType });
  router.push("/guide");
}

/** 空态 CTA / 页头主钮：直接进引导（无预填，Guide2 走缺省表单） */
function openGuide(): void {
  router.push("/guide");
}
</script>

<template>
  <section class="site2-page">
    <!-- 页头：标题 + 唯一主钮 -->
    <div class="phead">
      <div class="phead-main">
        <h1>{{ t("site2.sources.title") }}</h1>
        <p class="sub">{{ t("site2.sources.subtitle") }}</p>
      </div>
      <FcButton variant="primary" :icon="Plus" data-testid="sources-add" @click="openGuide">
        {{ t("site2.sources.addTitle") }}
      </FcButton>
    </div>

    <!-- 最近连接 -->
    <h2 class="sec-t">
      {{ t("site2.sources.recentTitle") }}
      <span v-if="recentSources.length > 0" class="n">
        {{ t("site2.sources.recentCount", { n: recentSources.length }) }}
      </span>
    </h2>

    <FcEmpty
      v-if="recentSources.length === 0"
      type="empty"
      :title="t('site2.sources.empty.title')"
      :description="t('site2.sources.empty.desc')"
    >
      <template #action>
        <FcButton variant="primary" :icon="Plus" @click="openGuide">
          {{ t("site2.sources.empty.cta") }}
        </FcButton>
      </template>
    </FcEmpty>

    <ul v-else class="src-list">
      <li v-for="item in recentSources" :key="item.id" class="src">
        <!-- 本期不做状态探测：灯恒灰（诚实口径——不连就不亮绿灯） -->
        <span class="lamp" aria-hidden="true"></span>
        <span class="fico" aria-hidden="true">
          <!-- WebDAV：双框服务器线稿 -->
          <svg v-if="item.backendType === 'webdav'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="5" width="16" height="6" rx="1.5" />
            <rect x="4" y="13" width="16" height="6" rx="1.5" />
            <circle cx="7.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="7.5" cy="16" r="0.9" fill="currentColor" stroke="none" />
          </svg>
          <!-- S3：数据库圆柱线稿 -->
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <ellipse cx="12" cy="6.5" rx="7" ry="2.5" />
            <path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11" />
            <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
          </svg>
        </span>
        <div class="body">
          <div class="nrow">
            <strong>{{ item.name }}</strong>
            <FcTag color="gray" size="sm">
              {{ item.backendType === "webdav" ? t("site2.sources.typeTag.webdav") : t("site2.sources.typeTag.s3") }}
            </FcTag>
          </div>
          <div class="vrow">
            <span class="k">{{ t("site2.sources.endpointLabel") }}</span>
            <span class="mono">{{ item.endpoint }}</span>
          </div>
          <div v-if="item.mountPath" class="mrow">
            <span class="k">{{ t("site2.sources.mountPathLabel") }}</span>
            {{ item.mountPath }}
            <span class="hint">{{ t("site2.sources.mountPathHint") }}</span>
          </div>
        </div>
        <div class="right">
          <span class="st">
            <span class="lamp" aria-hidden="true"></span>
            {{ t("site2.sources.light.unconnected") }}
          </span>
          <div class="ops">
            <FcButton variant="secondary" size="sm" @click="reconnect(item)">
              {{ t("site2.sources.reconnect") }}
            </FcButton>
            <FcButton variant="text" size="sm" @click="forget(item.id)">
              {{ t("site2.sources.forget") }}
            </FcButton>
          </div>
        </div>
      </li>
    </ul>

    <!-- 按用途添加：选型即分组——先想用途，再选协议 -->
    <h2 class="sec-t">{{ t("site2.sources.addByUse") }}</h2>
    <div class="addwrap">
      <div class="group g-a">
        <div class="gt">{{ t("site2.sources.group.objectStorage") }}</div>
        <div class="cards">
          <button type="button" class="addcard" @click="addByType('s3')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <ellipse cx="12" cy="6.5" rx="7" ry="2.5" />
              <path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11" />
              <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
            </svg>
            <span class="txt">
              <span class="t">{{ t("site2.sources.s3.title") }}</span>
              <span class="d">{{ t("site2.sources.s3.blurb") }}</span>
            </span>
            <i class="ri-arrow-right-s-line go" aria-hidden="true"></i>
          </button>
          <button type="button" class="addcard" @click="addByType('s3')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 18.5h10.2a3.8 3.8 0 0 0 .5-7.6 5.3 5.3 0 0 0-10.4-1.2A4.1 4.1 0 0 0 7 18.5z" />
              <path d="M12 15.5v-5" />
              <path d="m9.8 12.7 2.2-2.2 2.2 2.2" />
            </svg>
            <span class="txt">
              <span class="t">{{ t("site2.sources.r2.title") }}</span>
              <span class="d">{{ t("site2.sources.r2.blurb") }}</span>
            </span>
            <i class="ri-arrow-right-s-line go" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="group g-b">
        <div class="gt">{{ t("site2.sources.group.nas") }}</div>
        <div class="cards">
          <button type="button" class="addcard" @click="addByType('webdav')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="5" width="16" height="6" rx="1.5" />
              <rect x="4" y="13" width="16" height="6" rx="1.5" />
              <circle cx="7.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="7.5" cy="16" r="0.9" fill="currentColor" stroke="none" />
            </svg>
            <span class="txt">
              <span class="t">{{ t("site2.sources.webdav.title") }}</span>
              <span class="d">{{ t("site2.sources.webdav.blurb") }}</span>
            </span>
            <i class="ri-arrow-right-s-line go" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- 边界诚实注记：凭证不出前端红线 -->
    <p class="notice">{{ t("site2.sources.notice.localOnly") }}</p>
  </section>
</template>

<style scoped lang="scss">
// 布局/字号/动效走本文件；颜色圆角阴影全走 var(--app-*) token（SDK 纪律）
.site2-page {
  width: 100%;
  max-width: var(--site2-container, 1360px);
  margin: 0 auto;
  padding: var(--space-xl, 32px) var(--space-lg, 16px) var(--space-2xl, 48px);
  box-sizing: border-box;
}

// ── 页头 ──
.phead {
  display: flex;
  align-items: center;
  gap: var(--space-md, 16px);
  margin-bottom: var(--space-lg, 24px);

  .phead-main { min-width: 0; }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--app-text-primary);
  }

  .sub {
    margin: var(--space-xs, 4px) 0 0;
    font-size: 13px;
    color: var(--app-text-tertiary);
  }

  // 主钮右侧顶到容器右缘（窄屏换行）
  > :last-child { margin-left: auto; }
}

// ── 分区标题 ──
.sec-t {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm, 8px);
  margin: var(--space-lg, 24px) 0 var(--space-md, 16px);
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-secondary);

  .n { font-size: 12px; font-weight: 400; color: var(--app-text-tertiary); }
}

// ── 最近连接卡 ──
.src-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-width: 1180px;
}

.src {
  display: flex;
  align-items: center;
  gap: var(--space-md, 16px);
  padding: var(--space-md, 16px) var(--space-lg, 24px);
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-card, 16px);
  background: var(--app-bg-card);
  box-sizing: border-box;

  & + .src { margin-top: var(--space-sm, 8px); }

  &:hover { transform: translateY(-2px); border-color: var(--app-text-quaternary); }

  .lamp {
    width: 10px;
    height: 10px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--app-text-quaternary); // 恒灰：本期不做状态探测
  }

  .fico {
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    color: var(--app-text-secondary);

    svg { width: 100%; height: 100%; display: block; }
  }

  .body { min-width: 0; }

  .nrow {
    display: flex;
    align-items: center;
    gap: var(--space-sm, 8px);

    strong { font-size: 14.5px; color: var(--app-text-primary); }
  }

  .vrow,
  .mrow {
    margin-top: var(--space-xs, 4px);
    font-size: 12.5px;
    color: var(--app-text-secondary);
    overflow-wrap: anywhere;
  }

  .k { color: var(--app-text-tertiary); margin-right: var(--space-xs, 4px); }

  .mrow .hint { color: var(--app-text-tertiary); font-size: 11.5px; margin-left: var(--space-xs, 4px); }

  .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .right {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-sm, 8px);
    flex: 0 0 auto;
  }

  .st {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--app-text-tertiary);

    .lamp { width: 8px; height: 8px; }
  }

  .ops { display: flex; align-items: center; gap: var(--space-sm, 8px); }
}

// ── 按用途添加 ──
.addwrap {
  display: flex;
  gap: var(--space-lg, 24px);
  max-width: 1180px;
}

.group {
  display: flex;
  flex-direction: column;

  .gt {
    margin-bottom: var(--space-sm, 8px);
    font-size: 12px;
    color: var(--app-text-tertiary);
  }

  .cards { display: flex; gap: var(--space-sm, 8px); flex: 1; }

  &.g-a { flex: 2; }
  &.g-b { flex: 1; }
}

.addcard {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-md, 16px);
  min-width: 0;
  min-height: 44px; // 鼠标 + 触控双适配：最小点击热区
  padding: var(--space-md, 16px);
  text-align: left;
  border: 1px dashed var(--app-text-quaternary);
  border-radius: var(--app-radius-card, 16px);
  background: var(--app-bg-page);
  color: var(--app-text-secondary);
  cursor: pointer;
  font: inherit;

  svg { width: 24px; height: 24px; flex: 0 0 auto; color: var(--app-text-secondary); }

  .txt { min-width: 0; display: flex; flex-direction: column; }

  .t { font-size: 13.5px; font-weight: 600; color: var(--app-text-primary); }

  .d { font-size: 12px; color: var(--app-text-tertiary); }

  .go {
    margin-left: auto;
    font-size: 18px;
    color: var(--app-text-quaternary);
    flex: 0 0 auto;
  }

  &:hover {
    transform: translateY(-2px);
    border-color: var(--app-primary);
    .go { color: var(--app-primary); }
  }
}

// ── 边界诚实注记 ──
.notice {
  margin: var(--space-lg, 24px) 0 0;
  max-width: 1180px;
  font-size: 12px;
  color: var(--app-text-tertiary);
}

// 卡片/添加卡 hover 抬升动效（尊重系统减动效偏好，对齐原型口径）
@media (prefers-reduced-motion: no-preference) {
  .src,
  .addcard {
    transition: transform 150ms ease, border-color 150ms ease;
  }
}

// 窄屏：添加组纵向堆叠、卡操作区换行
@media (max-width: 860px) {
  .phead {
    flex-wrap: wrap;
    > :last-child { margin-left: 0; }
  }
  .addwrap { flex-direction: column; }
  .src { flex-wrap: wrap; .right { margin-left: 0; align-items: flex-start; } }
}
</style>
