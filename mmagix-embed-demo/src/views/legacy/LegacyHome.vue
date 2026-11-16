<script setup lang="ts">
// 官网首页（Hallmark 契约：Long Document · corridor · cobalt 映射到项目 Fc token）。
// 铁律：颜色全部 var(--app-*)；动效只 transform/opacity 且带 reduced-motion 兜底；
// 实数只用仓库既有口径（14 内置应用 / 19 宿主命令 / 151 测试文件 / 1972 单测用例，源自 docs/）。
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { FcButton } from "@/components/sdk";

const { t } = useI18n();
const router = useRouter();

function go(to: string): void {
  void router.push(to);
}

/** hero 签名面板（config 进,工作台出）：合法可解析的 WebDAV 示例 #config,凭证位打码 */
const configSample = [
  "{",
  '  "mode": "workspace",',
  '  "v": 1,',
  '  "backend": {',
  '    "type": "webdav",',
  '    "endpoint": "https://dav.example.com/home",',
  '    "username": "dav-user",',
  '    "password": "••••••"',
  "  },",
  '  "security": {',
  '    "allowedOrigins": ["https://your-app.example.com"]',
  "  }",
  "}",
].join("\n");

const treeRows = [
  { icon: "ri-folder-line", name: "reports/" },
  { icon: "ri-file-line", name: "hello.md" },
  { icon: "ri-file-line", name: "demo.csv" },
];

/** 四实数（来源 docs/：design/webdav-support-design.md M4 收口等）——禁造数 */
const metrics = [
  { value: "14", label: "site.metrics.apps" },
  { value: "19", label: "site.metrics.commands" },
  { value: "151", label: "site.metrics.files" },
  { value: "1972", label: "site.metrics.tests" },
];

const caps = [
  { key: "site.cap.sources", desc: "site.cap.sourcesDesc" },
  { key: "site.cap.apps", desc: "site.cap.appsDesc" },
  { key: "site.cap.plugins", desc: "site.cap.pluginsDesc" },
  { key: "site.cap.resume", desc: "site.cap.resumeDesc" },
  { key: "site.cap.trash", desc: "site.cap.trashDesc" },
  { key: "site.cap.share", desc: "site.cap.shareDesc" },
];

/** 协议操作面（真实 WebDAV 客户端操作,溯源 docs/design/webdav-support-design.md §W2/§W4） */
const protocol = [
  { method: "PROPFIND", act: "site.proto.propfind", note: "site.proto.propfindNote" },
  { method: "MKCOL", act: "site.proto.mkcol", note: "site.proto.mkcolNote" },
  { method: "COPY", act: "site.proto.copy", note: "site.proto.copyNote" },
  { method: "MOVE", act: "site.proto.move", note: "site.proto.moveNote" },
  { method: "DELETE", act: "site.proto.delete", note: "site.proto.deleteNote" },
  { method: "PUT Content-Range", act: "site.proto.putRange", note: "site.proto.putRangeNote", wash: true },
];

const docLinks = [
  { to: "/docs/user-guide", key: "site.doclink.guide" },
  { to: "/docs/deployment", key: "site.doclink.deploy" },
  { to: "/docs/webdav", key: "site.doclink.webdav" },
  { to: "/docs/jsdk-api", key: "site.doclink.jsdk" },
];

/** pnpm dev 复制键:clipboard API,仅在写成功后才变成功文案（不假成功） */
const copyState = ref<"idle" | "done">("idle");
let copyTimer: number | undefined;
async function copyDev(): Promise<void> {
  try {
    await navigator.clipboard.writeText("pnpm dev");
    copyState.value = "done";
    if (copyTimer !== undefined) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copyState.value = "idle"; }, 2000);
  } catch {
    // 剪贴板不可用：保持原样,不做假成功
  }
}
</script>

<template>
  <!-- 多根模板：section 直接是 main 的子节点——Hallmark 77 的 section 计数与 59 的缝距检查
    都以顶层 section 为对象。1. Banner hero（corridor：左文右图,发丝线夹持） -->
  <section class="hero">
    <div class="container front-grid">
      <div class="front-copy">
        <h1>{{ t("site.hero.title") }}</h1>
        <p class="lede">{{ t("site.hero.lede") }}</p>
        <div class="front-actions">
          <FcButton variant="primary" size="lg" @click="go('/play/workspace')">{{ t("site.hero.primary") }}</FcButton>
          <FcButton variant="secondary" size="lg" @click="go('/docs')">{{ t("site.hero.secondary") }}</FcButton>
        </div>
      </div>

      <div class="panel">
        <div class="pane-code"><pre><code>{{ configSample }}</code></pre></div>
        <div class="connectors" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="pane-tree">
          <ul>
            <li v-for="row in treeRows" :key="row.name">
              <i :class="row.icon" aria-hidden="true"></i><span>{{ row.name }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- 2. Statement + 四实数 ledger -->
  <section class="statement">
    <div class="container">
      <p class="big">{{ t("site.statement") }}</p>
      <dl class="ledger">
        <div v-for="m in metrics" :key="m.label" class="row">
          <dt>{{ t(m.label) }}</dt>
          <dd>{{ m.value }}</dd>
        </div>
      </dl>
    </div>
  </section>

  <!-- 3. 能力 ledger（ruled 行式） -->
  <section id="capabilities" class="caps">
    <div class="container">
      <h2>{{ t("site.caps.title") }}</h2>
      <ul class="cap-rows">
        <li v-for="c in caps" :key="c.key">
          <span class="name">{{ t(c.key) }}</span><span class="desc">{{ t(c.desc) }}</span>
        </li>
      </ul>
    </div>
  </section>

  <!-- 4. 协议表（table that is the API） -->
  <section id="protocol" class="proto">
    <div class="container">
      <h2>{{ t("site.proto.title") }}</h2>
      <table class="proto-table">
        <thead>
          <tr>
            <th scope="col">{{ t("site.proto.thMethod") }}</th>
            <th scope="col">{{ t("site.proto.thAct") }}</th>
            <th scope="col">{{ t("site.proto.thNote") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in protocol" :key="row.method" :class="{ 'is-wash': row.wash }">
            <td><code>{{ row.method }}</code></td>
            <td>{{ t(row.act) }}</td>
            <td class="note">{{ t(row.note) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- 5. 文档条 -->
  <section class="docstrip">
    <div class="container">
      <h2>{{ t("site.docstrip.title") }}</h2>
      <p class="strip-lede">{{ t("site.docstrip.lede") }}</p>
      <ul class="doc-links">
        <li v-for="d in docLinks" :key="d.to"><RouterLink :to="d.to">{{ t(d.key) }}</RouterLink></li>
      </ul>
    </div>
  </section>

  <!-- 6. CTA 带（全页唯一深底：token 反转的石墨面板） -->
  <section class="cta">
    <div class="container">
      <div class="cta-panel">
        <h2>{{ t("site.cta.title") }}</h2>
        <div class="cta-actions">
          <FcButton variant="primary" size="lg" @click="go('/play/workspace')">{{ t("site.cta.primary") }}</FcButton>
          <span class="chip">
            <code>pnpm dev</code>
            <button type="button" class="chip-copy" :data-state="copyState" @click="copyDev">
              {{ copyState === "done" ? t("site.cta.copied") : t("site.cta.copy") }}
            </button>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
/* Hallmark · shape: Long Document · hero: corridor · nav: banner over a retracting bar · footer: index columns · theme: cobalt (mapped to project tokens) · draw: c4f075 · genre: modern-minimal · job: try · imagery: none · signature: config-in workspace-out twin panes · posture: restrained */
/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 · weakest: S, hero could be any dev tool; led with the real #config fragment and the WebDAV method table instead of a stock dashboard */

/* 多根模板：ink 墨阶与容器宽度 token 由 SiteLayout 的 .site-layout 统一定义,此处继承。
   本组件零 transition/animation（Hallmark 27 无需兜底）;动效收敛在 SiteLayout 的 veil opacity */
.container { width: 100%; max-width: var(--container, 1360px); margin: 0 auto; padding-left: var(--space-lg); padding-right: var(--space-lg); }
h1, h2 { text-wrap: balance; overflow-wrap: break-word; min-width: 0; }

/* 1. hero：dot-grid 素底（cobalt ASCII 场域的 no-script 替身） */
.hero { border-bottom: 1px solid var(--app-separator); background-image: radial-gradient(circle, color-mix(in srgb, var(--app-text-tertiary) 40%, transparent) 1px, transparent 1px); background-size: var(--space-md) var(--space-md); }

.front-grid {
  // 签名优先构型：文案柱窄（文字铺满柱宽,44c 的 text-visual 距离落回 48-120px）,
  // config 面板吃满余量。100dvh: Hallmark 6a 禁 vh;上重下轻的 padding 让首屏内容重心
  // 略低,折叠带（79）与 content-sits-low（44a）在 1440×900 同时成立
  display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 8fr); align-items: center; gap: var(--space-2xl);
  min-height: calc(100dvh - var(--site-header-h, 64px)); padding-top: calc(var(--space-2xl) * 2); padding-bottom: var(--space-md);
}
.front-copy { border-left: 1px solid var(--app-separator); padding-left: var(--space-lg); min-width: 0;
  h1 { margin: 0; font-size: clamp(30px, 4.2vw, 46px); line-height: 1.05; letter-spacing: -0.02em; font-weight: 700; }
  .lede { margin: var(--space-md) 0 0; max-width: 44ch; color: var(--ink-soft); font-size: 16px; line-height: 1.6; }
}
.front-actions {
  display: flex; flex-wrap: wrap; gap: var(--space-sm); margin-top: var(--space-lg);
  // Hallmark 39b:营销页主控 44-52px（el-button lg=40px）
  :deep(.el-button) { min-height: 44px; }
  // Hallmark 26a:EP 焦点环在纸面上仅 1.46:1——换 token 墨色,即时显示
  :deep(.el-button:focus-visible) { outline: 2px solid var(--app-text-primary); outline-offset: 2px; }
}

/* 签名面板：切角面板（token 圆角兜底,@supports corner-shape 时对角切角） */
.panel {
  display: flex; flex-direction: column; border: 1px solid var(--app-separator); border-radius: var(--app-radius-card);
  background: var(--app-bg-card); box-shadow: var(--app-shadow-md); overflow: hidden;
  @supports (corner-shape: bevel) { corner-shape: bevel round bevel round; border-radius: var(--space-lg) var(--app-radius-card) var(--space-lg) var(--app-radius-card); }
}
/* 上 pane：graphite 代码面板（token 反转:墨为底,纸为字） */
.pane-code { background: var(--app-text-primary);
  pre { margin: 0; padding: var(--space-md) var(--space-lg); overflow-x: auto; }
  code { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7; color: var(--app-bg-card); white-space: pre; }
}
/* 2-3 条 hairline elbow 连线：映射示意 */
.connectors { display: flex; gap: var(--space-2xl); height: var(--space-lg); padding-left: var(--space-xl);
  span { width: var(--space-lg); height: 100%; border-left: 1px solid var(--app-separator); border-bottom: 1px solid var(--app-separator); }
}
/* 下 pane：迷你文件树 */
.pane-tree { padding: 0 var(--space-lg) var(--space-md);
  ul { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--app-separator); }
  li { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm) 0; color: var(--app-text-secondary); font-size: 13px; font-family: var(--font-mono);
    i { color: var(--app-text-tertiary); } &:first-child i { color: var(--app-primary); } }
}

/* 2. statement + 四实数 ledger */
.statement { padding-top: calc(var(--space-2xl) * 2); padding-bottom: calc(var(--space-2xl) * 1.5); }
.big { margin: 0 0 var(--space-xl); max-width: 30ch; font-size: clamp(24px, 3vw, 36px); line-height: 1.15; font-weight: 700; }
.ledger { margin: 0; border-bottom: 1px solid var(--app-separator);
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-lg); border-top: 1px solid var(--app-separator); padding: var(--space-sm) 0; }
  dt { color: var(--ink-soft); font-size: 14px; }
  dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: clamp(20px, 2.4vw, 28px); color: var(--app-text-primary); }
}

/* 3. 能力 ledger（行式,非卡片） */
.caps { padding-top: calc(var(--space-2xl) * 1.5); padding-bottom: calc(var(--space-2xl) * 2);
  h2 { margin: 0 0 var(--space-lg); font-size: clamp(30px, 3.1vw, 44px); line-height: 1.1; font-weight: 700; } /* Hallmark 78：1440 下段落主标题 ≥40px */ }
.cap-rows { margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--app-separator);
  li { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-lg); border-top: 1px solid var(--app-separator); padding: var(--space-md) 0; }
  .name { font-weight: 600; font-size: 15px; color: var(--app-text-primary); white-space: nowrap; }
  .desc { color: var(--ink-soft); font-size: 14px; text-align: right; max-width: 48ch; }
}

/* 4. 协议表 */
.proto { padding-top: calc(var(--space-2xl) * 2); padding-bottom: calc(var(--space-2xl) * 1.5);
  h2 { margin: 0 0 var(--space-lg); font-size: clamp(30px, 3.1vw, 44px); line-height: 1.1; font-weight: 700; } }
.proto-table {
  width: 100%; border-collapse: collapse;
  th, td { text-align: left; padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--app-separator); }
  th { color: var(--ink-faint); font-size: 13px; font-weight: 600; white-space: nowrap; }
  td { font-size: 14px; color: var(--app-text-primary); }
  td code { font-family: var(--font-mono); font-size: 12.5px; background: var(--app-bg-muted); padding: 2px var(--space-xs); border-radius: var(--app-radius-sm); white-space: nowrap; }
  .note { color: var(--ink-soft); font-size: 13px; }
  .is-wash td { background: color-mix(in srgb, var(--app-primary) 8%, transparent); } /* 一行 cobalt wash */
}

/* 5. 文档条 */
.docstrip { padding-top: calc(var(--space-2xl) * 2); padding-bottom: calc(var(--space-2xl) * 2);
  h2 { margin: 0; font-size: clamp(30px, 3.1vw, 44px); line-height: 1.1; font-weight: 700; }
  .strip-lede { margin: var(--space-sm) 0 0; color: var(--ink-soft); font-size: 14px; } }
.doc-links {
  // 四入口一行铺满全宽（Hallmark 77 的 across-mass：spread ≥70% 容器宽）
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-sm) var(--space-lg);
  margin: var(--space-lg) 0 0; padding: var(--space-md) 0 0; list-style: none; border-top: 1px solid var(--app-separator);
  a { color: var(--app-text-primary); font-weight: 600; font-size: 14px; line-height: 1.6; text-decoration: none; border-bottom: 1px solid var(--app-separator); padding-bottom: var(--space-xs); white-space: nowrap;
    &:hover { color: var(--app-primary); border-color: var(--app-primary); } }
}

/* 6. CTA 带（token 反转石墨:全页唯一深底） */
.cta { padding-top: var(--space-2xl); padding-bottom: calc(var(--space-2xl) * 2); }
.cta-panel {
  display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-lg);
  border: 1px solid var(--app-text-primary); border-radius: var(--app-radius-card); background: var(--app-text-primary); color: var(--app-bg-card);
  // 面板 ≥240px 高（Hallmark 77 的 filled-mass），收尾带读到块量而非细条
  padding: calc(var(--space-2xl) * 2) var(--space-xl);
  @supports (corner-shape: bevel) { corner-shape: bevel round bevel round; border-radius: var(--space-lg) var(--app-radius-card) var(--space-lg) var(--app-radius-card); }
  h2 { margin: 0; font-size: clamp(30px, 3.1vw, 44px); line-height: 1.1; font-weight: 700; max-width: 28ch; }
}
.cta-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-md);
  :deep(.el-button) { min-height: 44px; }
  // 石墨面板上墨色反转：焦点环用纸色
  :deep(.el-button:focus-visible) { outline: 2px solid var(--app-bg-card); outline-offset: 2px; }
}
/* pnpm dev cut-chip + 复制键 */
.chip {
  display: inline-flex; align-items: center; gap: var(--space-sm); border: 1px solid color-mix(in srgb, var(--app-bg-card) 30%, transparent);
  border-radius: var(--app-radius-sm); padding: var(--space-xs) var(--space-xs) var(--space-xs) var(--space-md);
  @supports (corner-shape: bevel) { corner-shape: bevel; border-radius: var(--space-sm); }
  code { font-family: var(--font-mono); font-size: 13px; color: var(--app-bg-card); white-space: nowrap; }
}
.chip-copy {
  border: none; border-radius: var(--app-radius-sm); background: color-mix(in srgb, var(--app-bg-card) 14%, transparent);
  color: var(--app-bg-card); font-size: 12px; min-height: 44px; padding: var(--space-xs) var(--space-sm); cursor: pointer; white-space: nowrap;
  &:hover { background: color-mix(in srgb, var(--app-bg-card) 24%, transparent); }
  &:active { background: color-mix(in srgb, var(--app-bg-card) 30%, transparent); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
  &:focus-visible { outline: 2px solid var(--app-bg-card); outline-offset: 2px; }
}

/* 响应式 */
@media (max-width: 960px) {
  .front-grid { grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .cap-rows li { flex-direction: column; gap: var(--space-xs); }
  .cap-rows .desc { text-align: left; }
  /* 协议表窄屏转块级内滚（Hallmark 34:任何宽度禁横向溢出） */
  .proto-table { display: block; overflow-x: auto; }
}
@media (max-width: 720px) {
  /* 手机上注列收起,方法+动作两列原生放下（防 F25 两列离屏） */
  .proto-table th:nth-child(3), .proto-table td:nth-child(3) { display: none; }
}
</style>
