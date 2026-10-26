<script setup lang="ts">
// 接入总览：三步接入 + #config 字段表 + 命令/事件/错误码表
// 内容提炼自《JSSDK 接口文档.md》V1.0 与《用户手册.md》V1.0（契约正本，冲突以其为准）。
// fc-web-sdk 合规改造：卡片=FcSection、表格=数据驱动（cell 内 {zh,en} 双语随 locale 取），
// 富文本 cell 走 v-html（内容为本页静态文档常量，非用户输入）。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { FcSection } from "@/components/sdk";

const { t, locale } = useI18n();

/** 双语文案单元：随当前 locale 取值（富文本用 html 字段） */
type L = { zh: string; en: string };
const pick = (v: L) => (locale.value === "en-US" ? v.en : v.zh);

// 长富文本走组件内常量而非 vue-i18n 词典——正文含字面量 `{}`（信封示例），
// 会与 vue-i18n 具名插值语法冲突；表格 cell 同款 L 模式，静态文档不进词典。
const heroHtml: L = {
  zh: "mmagix-files 是<strong>纯前端、S3 直连</strong>的文件工作台（无业务后端）：凭证即配置，配置走 URL fragment（<code>#config=</code> 工作台 / <code>#file=</code> 单文件，二者互斥）。本项目演示消费方视角的完整接入：iframe 嵌入、裸 <code>postMessage</code> 协议驱动、单文件只读预览。契约正本见仓库 <code>documents/JSSDK 接口文档.md</code>。",
  en: "mmagix-files is a <strong>pure-frontend, S3-direct</strong> file workspace (no business backend): credentials as config, config via URL fragment (<code>#config=</code> workspace / <code>#file=</code> single file, mutually exclusive). This project demonstrates full integration from the consumer side: iframe embed, raw <code>postMessage</code> protocol, single-file preview. Contract source of truth: <code>documents/JSSDK 接口文档.md</code>.",
};
const step1Html: L = {
  zh: "配置 JSON → <code>encodeURIComponent</code> → 拼到 <code>https://files.example.com/#config=…</code>。<b>只走 fragment，禁 query</b>（fragment 不到服务端/代理日志）；解析端用 <code>decodeURIComponent</code> 还原——对端不用 URLSearchParams，因为它会把 <code>+</code> 解成空格。建议整段 ≤8KB。",
  en: "Config JSON → <code>encodeURIComponent</code> → append to <code>https://files.example.com/#config=…</code>. <b>Fragment only, never query</b> (fragment never reaches server/proxy logs); parse with <code>decodeURIComponent</code> — do not use URLSearchParams on the consuming side, it decodes <code>+</code> as space. Keep the whole thing ≤8KB.",
};
const step2Html: L = {
  zh: '<code>&lt;iframe src="…#config=…" allow="clipboard-write"&gt;</code>。<b class="warn">头号坑</b>：<code>security.allowedOrigins</code> 必须包含<b>宿主自身 origin</b>（本 demo = <code>window.location.origin</code>，联调即 <code>http://localhost:5200</code>）——否则 iframe 侧按白名单静默丢弃宿主消息，症状是「ready 收得到、命令全部 4004 超时」。demo 的 <code>mount()</code> 已自动追加。',
  en: '<code>&lt;iframe src="…#config=…" allow="clipboard-write"&gt;</code>. <b class="warn">#1 pitfall</b>: <code>security.allowedOrigins</code> must include the <b>host page origin</b> (this demo = <code>window.location.origin</code>, i.e. <code>http://localhost:5200</code> in dev) — otherwise the iframe silently drops host messages per the whitelist; symptom: ready received, every command 4004 timeout. The demo <code>mount()</code> appends it automatically.',
};
const step3Html: L = {
  zh: "等 <code>evt ready</code>（10s 超时）后即可发 <code>{ ns:'mmagix-files', v:1, kind:'cmd', id, name, payload }</code>（targetOrigin=iframe 精确 origin，禁 <code>*</code>）；reply 按 <code>id</code> 匹配，<code>ok:false</code> 携 §七错误码。完整封装即 npm 包 <code>@mmagix/files-client</code>（源码：<code>frontend/packages/files-client/</code>，Vue 用 <code>@mmagix/files-client/vue</code>）。",
  en: "After <code>evt ready</code> (10s timeout) send <code>{ ns:'mmagix-files', v:1, kind:'cmd', id, name, payload }</code> (targetOrigin = exact iframe origin, never <code>*</code>); replies match by <code>id</code>, <code>ok:false</code> carries a §7 error code. Full wrapper: npm package <code>@mmagix/files-client</code> (source: <code>frontend/packages/files-client/</code>, Vue entry <code>@mmagix/files-client/vue</code>).",
};
const fileNoteHtml: L = {
  zh: "<code>#file</code> 单文件模式（互斥二选一）：<code>{ v, source:{ url, method?, body?, headers? }, save?, name?, appearance?, security? }</code>——只读=无 <code>save</code> 段；可写=有 <code>save:{ method:'PUT'|'POST', url }</code>。命令子集仅 <code>setTheme / setLocale / getInfo / destroy</code>（其余=4305）。",
  en: "<code>#file</code> single-file mode (mutually exclusive): <code>{ v, source:{ url, method?, body?, headers? }, save?, name?, appearance?, security? }</code> — read-only = no <code>save</code>; writable = with <code>save:{ method:'PUT'|'POST', url }</code>. Command subset only <code>setTheme / setLocale / getInfo / destroy</code> (others = 4305).",
};

interface Row {
  a: string;
  b?: L | string;
  c?: L;
}

/** 「必填」列标记（随 locale 取值） */
const REQ: L = { zh: "是", en: "Yes" };

const fieldRows: Row[] = [
  { a: "v", b: REQ, c: { zh: "配置协议版本，当前 <code>1</code>", en: 'Config protocol version, currently <code>1</code>' } },
  { a: "backend.endpoint / region / bucket", b: REQ, c: { zh: "S3 兼容端点三元组（OSS / MinIO / AWS…）", en: "S3-compatible endpoint triple (OSS / MinIO / AWS…)" } },
  { a: "backend.prefix", b: REQ, c: { zh: "会话目录域，文件树从此起；<code>''</code>=bucket 根", en: "Session directory root; <code>''</code> = bucket root" } },
  { a: "backend.credentials", b: REQ, c: { zh: "STS scoped 临时凭证三要素 <code>accessKeyId / accessKeySecret / sessionToken</code>（本地长期 AK/SK 模式 sessionToken 可为空串）", en: "STS scoped temporary credential triple <code>accessKeyId / accessKeySecret / sessionToken</code> (sessionToken may be empty in local long-term AK/SK mode)" } },
  { a: "backend.ttlSeconds", b: "-", c: { zh: "前端自毁定时器（秒），须 ≤ STS 真实 TTL（硬帽 24h）；可选 <code>expiresAt</code>（epoch ms）直接对齐到期时刻", en: "Frontend self-destruct timer (seconds), must ≤ real STS TTL (hard cap 24h); optional <code>expiresAt</code> (epoch ms) aligns expiry exactly" } },
  { a: "security.allowedOrigins", b: REQ, c: { zh: "<b>宿主页 origin 白名单</b>（必须含宿主自身）；不含即 5001 静默丢弃", en: "<b>Host page origin whitelist</b> (must include the host itself); otherwise silent drop with 5001" } },
  { a: "params.uploadMaxBytes / uploadConcurrency", b: "-", c: { zh: "单文件上传上限（字节）/ 并发数（默认 3）", en: "Per-file upload cap (bytes) / concurrency (default 3)" } },
  { a: "appearance.theme / locale / brand", b: "-", c: { zh: "light|dark|auto；zh-CN|en-US；OEM 品牌名/logo/主色", en: "light|dark|auto; zh-CN|en-US; OEM brand name/logo/primary color" } },
  { a: "features.*", b: "-", c: { zh: "功能开关，缺省全开：<code>upload</code>/<code>mkdir</code>/<code>rename</code>/<code>delete</code>/<code>download</code>/<code>multiTab</code>/<code>openWithMenu</code>/<code>plugins</code>", en: "Feature switches, all on by default: <code>upload</code>/<code>mkdir</code>/<code>rename</code>/<code>delete</code>/<code>download</code>/<code>multiTab</code>/<code>openWithMenu</code>/<code>plugins</code>" } },
  { a: "permissions.denyExts", b: "-", c: { zh: '拒收扩展名黑名单（不带点，如 <code>["exe"]</code>），命中=4304', en: 'Denied extension blacklist (no dot, e.g. <code>["exe"]</code>), hit = 4304' } },
  { a: "plugins[]", b: "-", c: { zh: "动态插件 <code>{ url, sri, lazy }</code>，SRI 完整性校验", en: "Dynamic plugins <code>{ url, sri, lazy }</code> with SRI integrity check" } },
  { a: "ui.initialPath / defaultOpen", b: "-", c: { zh: "初始目录 / 默认打开文件", en: "Initial directory / default opened file" } },
];

const cmdRows: Row[] = [
  { a: "navigate", b: "<code>{ path }</code>", c: { zh: "<code>{ path }</code>", en: "<code>{ path }</code>" } },
  { a: "openFile", b: "<code>{ path, appId? }</code>", c: { zh: "<code>{ tabId }</code>", en: "<code>{ tabId }</code>" } },
  { a: "closeTab", b: "<code>{ tabId }</code>", c: { zh: "<code>{}</code>", en: "<code>{}</code>" } },
  { a: "getTabs", b: "<code>{}</code>", c: { zh: "<code>{ tabs:[{tabId,path,appId}] }</code>", en: "<code>{ tabs:[{tabId,path,appId}] }</code>" } },
  { a: "select", b: "<code>{ mode:'file'|'multi'|'off', filter? }</code>", c: { zh: "<code>{}</code>；确认发 <code>selectionConfirmed</code>", en: "<code>{}</code>; confirmation emits <code>selectionConfirmed</code>" } },
  { a: "createFolder", b: "<code>{ path }</code>", c: { zh: "<code>{ key }</code>", en: "<code>{ key }</code>" } },
  { a: "uploadFiles", b: "<code>{ files?: File[] }</code>", c: { zh: "<code>{ accepted:[{id}], rejected:[{name,reason}] }</code>；终态走 upload 事件", en: "<code>{ accepted:[{id}], rejected:[{name,reason}] }</code>; terminal states via upload events" } },
  { a: "download", b: "<code>{ paths: string[] }</code>", c: { zh: "<code>{ id }</code>；终态走 download 事件", en: "<code>{ id }</code>; terminal states via download events" } },
  { a: "rename", b: "<code>{ from, to }</code>", c: { zh: "<code>{}</code>（copy+delete 语义）", en: "<code>{}</code> (copy+delete semantics)" } },
  { a: "remove", b: "<code>{ paths: string[] }</code>", c: { zh: "<code>{}</code>", en: "<code>{}</code>" } },
  { a: "registerApp", b: "<code>{ url, sri?, lazy? }</code>", c: { zh: "<code>{ appId }</code>（运行时追加插件）", en: "<code>{ appId }</code> (runtime plugin registration)" } },
  { a: "setTheme", b: "<code>{ theme }</code>", c: { zh: "<code>{}</code>", en: "<code>{}</code>" } },
  { a: "setLocale", b: "<code>{ locale }</code>", c: { zh: "<code>{}</code>", en: "<code>{}</code>" } },
  { a: "getInfo", b: "<code>{}</code>", c: { zh: "<code>{ sdkVersion, session:{expiresInSec}, features }</code>", en: "<code>{ sdkVersion, session:{expiresInSec}, features }</code>" } },
  { a: "destroy", b: "<code>{}</code>", c: { zh: "<code>{}</code>；先 ack 后 <code>expired</code>", en: "<code>{}</code>; ack first, then <code>expired</code>" } },
];

const evtRows: Row[] = [
  { a: "ready", b: "<code>{ sdkVersion, protocolVersion, configSummary }</code>", c: { zh: "初始化完成（握手点）", en: "Initialization done (handshake point)" } },
  { a: "pathChanged", b: "<code>{ path }</code>", c: { zh: "用户切目录", en: "User changed directory" } },
  { a: "fileOpened", b: "<code>{ tabId, path, appId }</code>", c: { zh: "用户打开文件", en: "User opened a file" } },
  { a: "tabClosed", b: "<code>{ tabId }</code>", c: { zh: "用户关 tab", en: "User closed a tab" } },
  { a: "selectionChanged", b: "<code>{ paths }</code>", c: { zh: "勾选变化（浏览态）", en: "Selection changed (browse mode)" } },
  { a: "selectionConfirmed", b: "<code>{ paths }</code>", c: { zh: "select 模式用户确认", en: "User confirmed in select mode" } },
  { a: "uploadProgress", b: "<code>{ id, loaded, total }</code>", c: { zh: "上传分块进度（~200ms 节流）", en: "Upload chunk progress (~200ms throttled)" } },
  { a: "uploadDone / uploadFailed", b: "<code>{ id, key? , error? }</code>", c: { zh: "上传终态", en: "Upload terminal state" } },
  { a: "downloadDone / downloadFailed", b: "<code>{ id, error? }</code>", c: { zh: "下载终态", en: "Download terminal state" } },
  { a: "fileChanged", b: "<code>{ key, action:'put'|'delete'|'rename', from? }</code>", c: { zh: "面板内变更（单文件 save 成功亦触发）", en: "Change within the panel (also fired after single-file save)" } },
  { a: "expired", b: "<code>{ reason:'ttl'|'destroyed' }</code>", c: { zh: "会话终态（之后零消息）", en: "Session terminal (zero messages afterwards)" } },
  { a: "error", b: "<code>{ code, message, detail? }</code>", c: { zh: "非命令类故障", en: "Non-command failure" } },
];

const errRows: Row[] = [
  { a: "4001", b: "BAD_CONFIG", c: { zh: "配置缺失/非法（#config 缺 backend、#file 缺 source、JSON 坏、<code>v</code> 不为 1）", en: "Config missing/invalid (#config missing backend, #file missing source, bad JSON, <code>v</code> ≠ 1)" } },
  { a: "4002", b: "CREDENTIAL_INVALID", c: { zh: "凭证被 S3 拒（scope/policy 错）", en: "Credentials rejected by S3 (scope/policy wrong)" } },
  { a: "4003", b: "CREDENTIAL_EXPIRED", c: { zh: "凭证 TTL 到（会话终态前奏）", en: "Credential TTL reached (session terminal prelude)" } },
  { a: "4004", b: "TIMEOUT", c: { zh: "命令超时（默认 10s）——<b>全部命令都超时 = 白名单坑</b>，见上②", en: "Command timeout (default 10s) — <b>all commands timing out = whitelist pitfall</b>, see ② above" } },
  { a: "4005", b: "BAD_PARAM", c: { zh: "参数非法/格式错（含未知命令）", en: "Invalid param/format (incl. unknown command)" } },
  { a: "4101", b: "S3_ERROR", c: { zh: "S3 端点错误（detail 携 status；先查 bucket CORS）", en: "S3 endpoint error (detail carries status; check bucket CORS first)" } },
  { a: "4102", b: "NOT_FOUND", c: { zh: "路径/tabId/appId 不存在", en: "Path/tabId/appId not found" } },
  { a: "4201", b: "PLUGIN_LOAD_FAILED", c: { zh: "插件 import 失败/SRI 不符", en: "Plugin import failed / SRI mismatch" } },
  { a: "4202", b: "NO_APP", c: { zh: "matcher 不命中且无默认应用", en: "No matcher hit and no default app" } },
  { a: "4301", b: "FEATURE_DISABLED", c: { zh: "功能开关关闭（如 delete=false 时 remove）", en: "Feature disabled (e.g. remove while delete=false)" } },
  { a: "4302", b: "LIMIT_EXCEEDED", c: { zh: "超 uploadMaxBytes 等限制", en: "Exceeds uploadMaxBytes etc." } },
  { a: "4303", b: "QUEUE_OVERFLOW", c: { zh: "ready 前队列超 50 拒（宿主侧未握手直接拒也用此码）", en: "Pre-ready queue over 50 rejected (also used for direct pre-handshake rejection)" } },
  { a: "4304", b: "EXT_DENIED", c: { zh: "扩展名黑名单拒收", en: "Denied by extension blacklist" } },
  { a: "4305", b: "UNSUPPORTED_MODE", c: { zh: "当前模式不支持（单文件模式下调工作台命令）", en: "Unsupported in current mode (workspace command in single-file mode)" } },
  { a: "5000", b: "SESSION_EXPIRED", c: { zh: "会话已终态后的任何 cmd", en: "Any cmd after session terminal" } },
  { a: "5001", b: "ORIGIN_REJECTED", c: { zh: "origin 不在白名单——<b>静默丢弃、不回包</b>（只能在 iframe console 看到）", en: "Origin not whitelisted — <b>silent drop, no reply</b> (only visible in iframe console)" } },
];

const cell = (v: Row["b"] | Row["c"]) => (typeof v === "string" ? v : v ? pick(v) : "");
</script>

<template>
  <div class="overview">
    <FcSection padding="lg" shadow="sm">
      <h1>{{ t("demo.ov.heroTitle") }}</h1>
      <!-- eslint-disable-next-line vue/no-v-html —— 静态文档内容（本组件常量/词典），无用户输入 -->
      <p v-html="pick(heroHtml)" />
    </FcSection>

    <div class="grid">
      <FcSection padding="md" shadow="sm">
        <template #header><h3 class="section-title">{{ t("demo.ov.step1Title") }}</h3></template>
        <!-- eslint-disable-next-line vue/no-v-html —— 同上：静态文档 -->
        <p v-html="pick(step1Html)" />
      </FcSection>
      <FcSection padding="md" shadow="sm">
        <template #header><h3 class="section-title">{{ t("demo.ov.step2Title") }}</h3></template>
        <!-- eslint-disable-next-line vue/no-v-html —— 同上：静态文档 -->
        <p v-html="pick(step2Html)" />
      </FcSection>
      <FcSection padding="md" shadow="sm">
        <template #header><h3 class="section-title">{{ t("demo.ov.step3Title") }}</h3></template>
        <!-- eslint-disable-next-line vue/no-v-html —— 同上：静态文档 -->
        <p v-html="pick(step3Html)" />
      </FcSection>
    </div>

    <FcSection padding="md" shadow="sm">
      <template #header><h3 class="section-title">{{ t("demo.ov.fieldTitle") }}</h3></template>
      <table>
        <thead>
          <tr><th>{{ t("demo.ov.thSeg") }}</th><th>{{ t("demo.ov.thRequired") }}</th><th>{{ t("demo.ov.thDesc") }}</th></tr>
        </thead>
        <tbody>
          <!-- eslint-disable-next-line vue/no-v-html —— 静态文档表 -->
          <tr v-for="r in fieldRows" :key="r.a"><td><code>{{ r.a }}</code></td><td>{{ cell(r.b) }}</td><td v-html="cell(r.c)" /></tr>
        </tbody>
      </table>
      <!-- eslint-disable-next-line vue/no-v-html —— 静态文档 -->
      <p class="note" v-html="pick(fileNoteHtml)" />
    </FcSection>

    <div class="two-col">
      <FcSection padding="md" shadow="sm">
        <template #header><h3 class="section-title">{{ t("demo.ov.cmdTitle") }}</h3></template>
        <table>
          <thead><tr><th>{{ t("demo.ov.thCmd") }}</th><th>payload</th><th>reply</th></tr></thead>
          <tbody>
            <!-- eslint-disable-next-line vue/no-v-html —— 静态文档表 -->
            <tr v-for="r in cmdRows" :key="r.a"><td><code>{{ r.a }}</code></td><td v-html="cell(r.b)" /><td v-html="cell(r.c)" /></tr>
          </tbody>
        </table>
        <p class="note">{{ t("demo.ov.pathNote") }}</p>
      </FcSection>

      <FcSection padding="md" shadow="sm">
        <template #header><h3 class="section-title">{{ t("demo.ov.evtTitle") }}</h3></template>
        <table>
          <thead><tr><th>{{ t("demo.ov.thEvt") }}</th><th>payload</th><th>{{ t("demo.ov.thTrigger") }}</th></tr></thead>
          <tbody>
            <!-- eslint-disable-next-line vue/no-v-html —— 静态文档表 -->
            <tr v-for="r in evtRows" :key="r.a"><td><code>{{ r.a }}</code></td><td v-html="cell(r.b)" /><td v-html="cell(r.c)" /></tr>
          </tbody>
        </table>
      </FcSection>
    </div>

    <FcSection padding="md" shadow="sm">
      <template #header><h3 class="section-title">{{ t("demo.ov.errTitle") }}</h3></template>
      <table>
        <thead><tr><th>code</th><th>{{ t("demo.ov.thConst") }}</th><th>{{ t("demo.ov.thMeaning") }}</th></tr></thead>
        <tbody>
          <!-- eslint-disable-next-line vue/no-v-html —— 静态文档表 -->
          <tr v-for="r in errRows" :key="r.a"><td><code>{{ r.a }}</code></td><td>{{ cell(r.b) }}</td><td v-html="cell(r.c)" /></tr>
        </tbody>
      </table>
    </FcSection>
  </div>
</template>

<style scoped lang="scss">
.overview {
  padding: 20px;
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

h1 {
  margin: 0 0 8px;
  font-size: 22px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.two-col {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 12px;
  align-items: start;
}

.section-title {
  margin: 0;
}

p {
  color: var(--app-text-secondary);
  font-size: 13px;
  line-height: 1.7;
  margin: 8px 0 0;

  :deep(code) {
    background: var(--app-bg-muted);
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 12px;
  }
}

.section-title + p {
  margin-top: 0;
}

.note {
  font-size: 12px;
  color: var(--app-text-tertiary);
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
  font-size: 12px;

  th,
  td {
    text-align: left;
    border-bottom: 1px solid var(--app-separator);
    padding: 6px 8px;
    vertical-align: top;
    line-height: 1.5;
  }
  th {
    color: var(--app-text-tertiary);
    font-weight: 600;
    white-space: nowrap;
  }
  td:first-child {
    white-space: nowrap;
  }

  td :deep(code) {
    background: var(--app-bg-muted);
    padding: 1px 4px;
    border-radius: 4px;
  }
}
</style>
