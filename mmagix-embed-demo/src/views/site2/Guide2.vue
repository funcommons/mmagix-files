<script setup lang="ts">
// site2 演示引导（路由 /guide）：S04 四步向导 + S05 连接诊断 + 步骤 4 交接完成页（打开工作台）。
// 功能 parity 正本：src/views/embed/EmbedPlay.vue / configBuilder.ts——表单形状 = DemoFormFields，
// 校验（validateForm）/endpoint 联动缺省直接沿用；装配（buildWorkspaceConfig）在本文件步骤 4
// 消费（交接键 + 摘要卡共用，零逻辑复制）；WebDAV 探测/失败分类在 @/site2/diagnostics（纯函数）。
// 视觉正本：docs/design/site-redesign-v2/prototypes/s04-guide-steps.html + s05-connect-diagnostics.html。
// 对接契约（正本注释在 Sources2.vue 文件头，「读」侧在本组件）：
// 挂载时读 sessionStorage['mmagic.site2.prefill']（{ backendType, fields? }），写入表单后
// 直接进步骤 2；用完立即移除；坏 JSON/非法类型按无预填兜底；凭证字段永不采纳。
//
// ── 步骤 4 交接契约（正本；读方 = /workspace EmbedPlay，读取由该侧自行实现）──
// sessionStorage['mmagic.site2.handoff'] = JSON.stringify(MmxWorkspaceConfig)
// - 值 = buildWorkspaceConfig(form) 的完整 #config JSON（与 #config 同形状，含凭证）；
//   凭证进 sessionStorage（会话级、随标签页消亡）与 frontend 连接向导 persistRawConfig
//   先例同口径——绝不落 localStorage。
// - 写入顺序：写 handoff → 写 recentSources（契约正本在 Sources2.vue 文件头，凭证零落库）
//   → router.push('/workspace')。
// - 读方 onMounted 取用后必须 removeItem（一次性手递手，防残留重放）。
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { FcButton, FcSegmented, FcSelect } from "@/components/sdk";
import { OEM_CONFIG } from "@/config/oem";
import {
  buildWorkspaceConfig,
  maskConfigForPreview,
  validateForm,
  FEATURE_KEYS,
  WEBDAV_DEFAULT_ENDPOINT,
  type DemoFormFields,
} from "@/views/embed/configBuilder";
import { probeWebDav, type ProbeVerdict } from "@/site2/diagnostics";

const { t } = useI18n();

// ── 四步状态机：前进只经各步主按钮，回退只经左栏步骤条（点击已完成步骤） ──
const STEPS = [1, 2, 3, 4] as const;
const step = ref<number>(1);
/** 回退：步骤 4 交接页无会话可拆（挂载发生在 /workspace），仅需 setStep */
function goBack(n: number): void {
  if (n < step.value) step.value = n;
}

const panelTitle = computed(() =>
  t("site2.guide.panelHead", { n: step.value, name: t(`site2.guide.step.s${step.value}`) }),
);

// ── 连接表单（形状 = DemoFormFields；缺省与 EmbedPlay 同源：S3 读 .env.local 的 VITE_S3_*，WebDAV 全空） ──
const form = reactive<DemoFormFields>({
  backendType: "s3",
  endpoint: OEM_CONFIG.s3.endpoint,
  region: OEM_CONFIG.s3.region,
  bucket: OEM_CONFIG.s3.bucket,
  accessKeyId: OEM_CONFIG.s3.accessKeyId,
  accessKeySecret: OEM_CONFIG.s3.accessKeySecret,
  sessionToken: OEM_CONFIG.s3.sessionToken,
  prefix: OEM_CONFIG.s3.prefix,
  webdavUsername: "",
  webdavPassword: "",
  webdavRootPath: "",
  webdavChunkedWrite: false,
  ttl: 3600,
  theme: "light",
  locale: "zh-CN",
  initialPath: "",
  treeMode: "sidebar",
  treeTitle: "",
  disabledFeatures: [],
  univerPlugin: true,
  pdfAnnotator: true,
  mdPlugin: true,
  artplayerPlugin: true,
  filerobotPlugin: true,
  htmlPlugin: true,
  pptxPlugin: true,
  mdInitialMode: "",
  mdDefaultMode: "",
});

const isWebDav = computed(() => form.backendType === "webdav");

// backendType 联动（与 EmbedPlay 同构）：endpoint 只在「空串 / 对称缺省值」间搬移，用户手输的
// 其它值一律不动（陷阱：切到 WebDAV 后 endpoint 仍挂 S3 缺省 9000 → 对着不存在的端点探测必败）。
// 同时：切类型后旧诊断失效（五步条/诊断卡按新类型重画）。
watch(
  () => form.backendType,
  (type) => {
    if (type === "webdav") {
      if (form.endpoint === "" || form.endpoint === OEM_CONFIG.s3.endpoint) {
        form.endpoint = WEBDAV_DEFAULT_ENDPOINT;
      }
    } else if (form.endpoint === "" || form.endpoint === WEBDAV_DEFAULT_ENDPOINT) {
      form.endpoint = OEM_CONFIG.s3.endpoint;
    }
    probeState.value = "idle";
    verdict.value = null;
  },
);

// ── prefill（对接契约「读」侧，正本注释在 Sources2.vue 文件头） ──
const PREFILL_KEY = "mmagic.site2.prefill";
/** 步骤 4 交接键（写入侧契约正本见文件头；读方 /workspace 取用后必须 removeItem） */
const HANDOFF_KEY = "mmagic.site2.handoff";
/** 白名单：仅非凭证字段——即便 prefill 被塞进凭证键也绝不采纳 */
const PREFILL_KEYS: (keyof DemoFormFields)[] = [
  "endpoint",
  "region",
  "bucket",
  "prefix",
  "webdavRootPath",
  "ttl",
  "theme",
  "locale",
  "initialPath",
  "treeMode",
  "treeTitle",
];
function applyPrefill(fields: unknown): void {
  if (typeof fields !== "object" || fields === null) return;
  const rec = fields as Record<keyof DemoFormFields, unknown>;
  for (const k of PREFILL_KEYS) {
    const v = rec[k];
    if (v === undefined || v === null) continue;
    if (typeof v === typeof form[k]) {
      (form as unknown as Record<string, unknown>)[k] = v;
    }
  }
}
onMounted(() => {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PREFILL_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  try {
    sessionStorage.removeItem(PREFILL_KEY); // 用完立即移除（解析失败也移除，避免残留重放）
  } catch {
    /* 存储不可用 → 兜底继续 */
  }
  try {
    const parsed = JSON.parse(raw) as { backendType?: unknown; fields?: unknown };
    if (parsed?.backendType !== "s3" && parsed?.backendType !== "webdav") return; // 非法类型 → 无预填兜底
    form.backendType = parsed.backendType;
    applyPrefill(parsed.fields);
    step.value = 2; // 手递带：跳过选类型，直接填最小必需项
  } catch {
    /* 坏 JSON → 按无预填兜底 */
  }
});

// ── 步骤推进 ──
function toStep3(): void {
  // 成对校验纪律：直接调 configBuilder.validateForm（WebDAV endpoint 须合法 http(s)；S3 endpoint+bucket 必填）
  const err = validateForm(form);
  if (err) {
    ElMessage.warning(t(err));
    return;
  }
  step.value = 3;
}

// ── 步骤 3 连接（S05）：WebDAV 真实探测 / S3 诚实降级直接挂载 ──
type ProbeState = "idle" | "running" | "ok" | "fail";
const probeState = ref<ProbeState>("idle");
const verdict = ref<ProbeVerdict | null>(null);

async function onConnect(): Promise<void> {
  const err = validateForm(form);
  if (err) {
    ElMessage.warning(t(err));
    return;
  }
  if (!isWebDav.value) {
    // S3 诚实降级：不做浏览器端 SigV4 预探测（签名复杂易错）——直接进步骤 4（交接完成页），
    // 挂载验证在工作台（/workspace）进行，抛错在其状态条原地呈现（不伪造诊断步骤）。
    step.value = 4;
    return;
  }
  probeState.value = "running";
  verdict.value = null;
  const v = await probeWebDav(form.endpoint, { username: form.webdavUsername, password: form.webdavPassword });
  verdict.value = v;
  probeState.value = v.ok ? "ok" : "fail";
  if (v.ok) {
    // 五步全绿短暂定格后自动进入步骤 4（用户若已回退则不抢焦点）
    window.setTimeout(() => {
      if (step.value === 3) step.value = 4;
    }, 600);
  }
}

/** 失败三分诊：network|cors（浏览器不可分）→ CORS 卡；auth → 认证卡；address|server → 地址卡 */
type FailKind = "cors" | "auth" | "address";
const failKind = computed<FailKind | null>(() => {
  if (probeState.value !== "fail" || !verdict.value) return null;
  const r = verdict.value.reason;
  if (r === "auth") return "auth";
  if (r === "network" || r === "cors") return "cors";
  return "address";
});

// ── 五步条：解析地址→安全预检→身份验证→列目录→完成 ──
const PROBE_STEPS = ["parse", "preflight", "auth", "list", "done"] as const;
type SegState = "done" | "cur" | "fail" | "todo";
function segState(key: (typeof PROBE_STEPS)[number]): SegState {
  // 运行中：解析地址本地即时完成，安全预检转圈（单条 PROPFIND 承载后三步）
  if (probeState.value === "running") return key === "parse" ? "done" : key === "preflight" ? "cur" : "todo";
  const v = verdict.value;
  if (!v) return "todo";
  if (v.ok) return "done";
  const fi = PROBE_STEPS.indexOf(v.step);
  const ki = PROBE_STEPS.indexOf(key);
  if (ki < fi) return "done";
  if (ki === fi) return "fail";
  return "todo";
}

// nginx CORS 片段：代码块字面量常量（长富文本不进词典——zh 词典头注释先例）；origin 运行时注入
const pageOrigin = window.location.origin;
const NGINX_SNIPPET = [
  "location / {",
  `    add_header Access-Control-Allow-Origin  "${pageOrigin}";`,
  '    add_header Access-Control-Allow-Methods "GET, PUT, POST, DELETE, HEAD";',
  '    add_header Access-Control-Allow-Headers  "*";',
  '    add_header Access-Control-Expose-Headers "ETag";',
  "}",
].join("\n");

async function copyNginx(): Promise<void> {
  try {
    await navigator.clipboard.writeText(NGINX_SNIPPET);
    ElMessage.success(t("site2.guide.snippet.copied"));
  } catch {
    ElMessage.error(t("demo.file.msg.copyFailed"));
  }
}

// ── 步骤 4 · 打开工作台（交接完成页）：写交接键 + 记最近连接 → 跳工作台页（/workspace，SiteNav2 壳）──
const router = useRouter();

/** 当前表单生成的 #config（凭证打码预览；S3/WebDAV 打码规则见 configBuilder） */
const configPreview = computed(() => maskConfigForPreview(buildWorkspaceConfig(form)));

// 最近连接记录（对接契约，正本注释在 Sources2.vue 文件头）：只存非凭证字段——
// accessKey/secret/sessionToken/username/password 绝不落盘（自原连接后舞台组件原样迁入，形状与键名逐字不变）。
const RECENT_KEY = "mmagic.site2.recentSources";
function saveRecentSource(): void {
  try {
    let list: unknown[] = [];
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    }
    const endpoint = form.endpoint.trim();
    let host = endpoint;
    try {
      host = new URL(endpoint).host;
    } catch {
      /* 非 URL 字符串原样作 name */
    }
    const mountPath = (form.backendType === "s3" ? form.prefix : form.webdavRootPath).trim();
    list.push({
      id:
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name: host,
      backendType: form.backendType,
      endpoint,
      ...(mountPath !== "" ? { mountPath } : {}),
      savedAt: Date.now(),
    });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 坏 JSON/非数组按空库重建仍失败（隐私模式等）→ 静默容错，不阻塞主流程 */
  }
}

/** 主钮「打开工作台」：写交接键（完整 MmxWorkspaceConfig JSON）→ 记最近连接 → 跳工作台页（/workspace） */
function openWorkspace(): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(buildWorkspaceConfig(form)));
  } catch {
    /* 存储不可用（隐私模式等）→ 照常跳转，工作台按缺省配置挂载 */
  }
  saveRecentSource();
  void router.push("/workspace");
}

// ── 高级选项控件选项（与 EmbedPlay 同款形态；computed 包裹——label 随语言即时切换） ──
const localeOptions = [
  { label: "zh-CN", value: "zh-CN" },
  { label: "en-US", value: "en-US" },
];
const themeOptions = [
  { label: "light", value: "light" },
  { label: "dark", value: "dark" },
];
const treeModeOptions = computed(() => [
  { label: t("demo.embed.treeMode.sidebar"), value: "sidebar" },
  { label: t("demo.embed.treeMode.drawer"), value: "drawer" },
]);
const PLUGIN_SWITCHES = computed<{ key: "univerPlugin" | "pdfAnnotator" | "mdPlugin" | "htmlPlugin" | "pptxPlugin" | "artplayerPlugin" | "filerobotPlugin"; label: string }[]>(() => [
  { key: "univerPlugin", label: t("demo.embed.plugin.univer") },
  { key: "pdfAnnotator", label: t("demo.embed.plugin.pdfAnnotator") },
  { key: "mdPlugin", label: t("demo.embed.plugin.md") },
  { key: "htmlPlugin", label: t("demo.embed.plugin.html") },
  { key: "pptxPlugin", label: t("demo.embed.plugin.pptx") },
  { key: "artplayerPlugin", label: t("demo.embed.plugin.artplayer") },
  { key: "filerobotPlugin", label: t("demo.embed.plugin.filerobot") },
]);
const mdModeOptions = computed(() => [
  { label: t("demo.embed.mdMode.auto"), value: "" },
  { label: t("demo.embed.mdMode.source"), value: "source" },
  { label: t("demo.embed.mdMode.split"), value: "split" },
  { label: t("demo.embed.mdMode.preview"), value: "preview" },
]);
</script>

<template>
  <div class="guide">
    <header class="head">
      <h1>{{ t("site2.guide.title") }}</h1>
      <p class="sub">{{ t("site2.guide.sub") }}</p>
      <div class="progress" role="img" :aria-label="t('site2.guide.panelHead', { n: step, name: t(`site2.guide.step.s${step}`) })">
        <div v-for="s in STEPS" :key="s">
          <div class="seg-track" :class="{ done: s <= step }"></div>
          <div class="seg-label" :class="{ cur: s === step }">{{ s }} {{ t(`site2.guide.step.s${s}`) }}</div>
        </div>
      </div>
    </header>

    <div class="body">
      <!-- 左：竖步骤条（点击已完成步骤回退，回退即拆会话） -->
      <aside class="rail">
        <button
          v-for="s in STEPS"
          :key="s"
          type="button"
          class="rstep"
          :class="{ cur: s === step, back: s < step }"
          :disabled="s >= step"
          @click="goBack(s)"
        >
          <span class="rnum">{{ s < step ? "✓" : s }}</span>
          <span class="rt">
            <span class="rname">{{ t(`site2.guide.step.s${s}`) }}</span>
            <span class="rcap">{{ t(`site2.guide.step.cap${s}`) }}</span>
          </span>
        </button>
        <button type="button" class="skip" @click="step = 2">{{ t("site2.guide.skip") }}</button>
        <RouterLink class="skip" to="/singlefile">{{ t("site2.guide.singlefileHint") }}</RouterLink>
      </aside>

      <!-- 右：当前步详情面板 -->
      <main class="panels">
        <!-- 步骤 1 · 选存储类型 -->
        <section v-if="step === 1" class="panel">
          <div class="phead">
            <h2>{{ panelTitle }}</h2>
            <p class="cap">{{ t("site2.guide.step.cap1") }}</p>
          </div>
          <div class="types">
            <button type="button" class="type-card" :class="{ sel: form.backendType === 's3' }" @click="form.backendType = 's3'">
              <span v-if="form.backendType === 's3'" class="sel-dot" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
              </span>
              <span class="type-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14l-1.5 12a2 2 0 0 1-2 1.8h-7A2 2 0 0 1 6.5 19L5 7z" /><path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3" /></svg>
                <strong>{{ t("site2.guide.type.s3") }}</strong>
              </span>
              <span class="q">{{ t("site2.guide.type.q") }}</span>
              <span class="eg">{{ t("site2.guide.type.egS3") }}</span>
              <span class="tcode">backend.type = "s3"</span>
            </button>
            <button type="button" class="type-card" :class="{ sel: form.backendType === 'webdav' }" @click="form.backendType = 'webdav'">
              <span v-if="form.backendType === 'webdav'" class="sel-dot" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
              </span>
              <span class="type-head">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>
                <strong>{{ t("site2.guide.type.webdav") }}</strong>
              </span>
              <span class="q">{{ t("site2.guide.type.q") }}</span>
              <span class="eg">{{ t("site2.guide.type.egWebdav") }}</span>
              <span class="tcode">backend.type = "webdav"</span>
            </button>
          </div>
          <div class="pfoot">
            <span class="note">{{ t("site2.guide.step.cap2") }}</span>
            <FcButton variant="primary" @click="step = 2">{{ t("site2.guide.act.next") }}</FcButton>
          </div>
        </section>

        <!-- 步骤 2 · 填最小必需项（渐进披露：其余全收进高级选项） -->
        <section v-else-if="step === 2" class="panel">
          <div class="phead">
            <h2>{{ panelTitle }}</h2>
            <p class="cap">{{ t("site2.guide.step.cap2") }}</p>
          </div>
          <div class="fgrid">
            <div class="field wide">
              <label class="fl">{{ t("site2.guide.label.endpoint") }} <code>endpoint</code></label>
              <el-input v-model="form.endpoint" :placeholder="isWebDav ? 'http://localhost:5240' : 'http://localhost:9000'" />
            </div>
            <template v-if="isWebDav">
              <div class="field">
                <label class="fl">{{ t("site2.guide.label.username") }} <code>username</code></label>
                <el-input v-model="form.webdavUsername" :placeholder="t('demo.embed.placeholder.username')" autocomplete="off" />
              </div>
              <div class="field">
                <label class="fl">{{ t("site2.guide.label.password") }} <code>password</code></label>
                <el-input v-model="form.webdavPassword" :placeholder="t('demo.embed.placeholder.password')" show-password autocomplete="new-password" />
              </div>
            </template>
            <template v-else>
              <div class="field">
                <label class="fl">{{ t("site2.guide.label.bucket") }} <code>bucket</code></label>
                <el-input v-model="form.bucket" placeholder="mmagic-demo" />
              </div>
              <div class="field">
                <label class="fl">{{ t("site2.guide.label.accessKeyId") }} <code>accessKeyId</code></label>
                <el-input v-model="form.accessKeyId" :placeholder="t('demo.embed.placeholder.ak')" autocomplete="off" />
              </div>
              <div class="field">
                <label class="fl">{{ t("site2.guide.label.accessKeySecret") }} <code>accessKeySecret</code></label>
                <el-input v-model="form.accessKeySecret" :placeholder="t('demo.embed.placeholder.sk')" show-password autocomplete="new-password" />
              </div>
            </template>
          </div>

          <el-collapse class="adv">
            <el-collapse-item :title="t('site2.guide.adv')">
              <div class="fgrid">
                <template v-if="isWebDav">
                  <div class="field">
                    <label class="fl">{{ t("site2.guide.label.rootPath") }} <code>rootPath</code></label>
                    <el-input v-model="form.webdavRootPath" :placeholder="t('demo.embed.placeholder.rootPath')" />
                  </div>
                  <div class="field">
                    <label class="fl">{{ t("site2.guide.label.chunkedWrite") }} <code>chunkedWrite</code></label>
                    <div class="pair">
                      <el-switch v-model="form.webdavChunkedWrite" size="small" />
                      <span class="hint">{{ t("site2.guide.hint.chunkedWrite") }}</span>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div class="field">
                    <label class="fl">{{ t("site2.guide.label.region") }} <code>region</code></label>
                    <el-input v-model="form.region" placeholder="us-east-1" />
                  </div>
                  <div class="field">
                    <label class="fl">{{ t("site2.guide.label.prefix") }} <code>prefix</code></label>
                    <el-input v-model="form.prefix" placeholder="sessions/demo/" />
                  </div>
                  <div class="field">
                    <label class="fl">{{ t("site2.guide.label.sessionToken") }} <code>sessionToken</code></label>
                    <el-input v-model="form.sessionToken" :placeholder="t('demo.embed.placeholder.token')" show-password autocomplete="new-password" />
                  </div>
                </template>
                <div class="field">
                  <label class="fl">{{ t("site2.guide.label.ttl") }} <code>ttl</code></label>
                  <el-input-number v-model="form.ttl" :min="60" :max="86400" :step="600" style="width: 100%" />
                </div>
                <div class="field">
                  <label class="fl">{{ t("site2.guide.label.appearance") }} <code>theme · locale</code></label>
                  <div class="pair">
                    <FcSegmented v-model="form.theme" :options="themeOptions" size="sm" />
                    <FcSelect v-model="form.locale" :options="localeOptions" size="small" style="width: 110px" />
                  </div>
                </div>
                <div class="field">
                  <label class="fl">{{ t("site2.guide.label.initialPath") }} <code>initialPath</code></label>
                  <el-input v-model="form.initialPath" placeholder="/" />
                </div>
                <div class="field">
                  <label class="fl">{{ t("site2.guide.label.treeMode") }} <code>treeMode</code></label>
                  <FcSegmented v-model="form.treeMode" :options="treeModeOptions" size="sm" />
                </div>
                <div class="field">
                  <label class="fl">{{ t("site2.guide.label.treeTitle") }} <code>treeTitle</code></label>
                  <el-input v-model="form.treeTitle" :placeholder="t('demo.embed.placeholder.treeTitle')" />
                </div>
                <div class="field wide">
                  <label class="fl">{{ t("site2.guide.label.features") }} <code>features</code></label>
                  <el-checkbox-group v-model="form.disabledFeatures" size="small">
                    <el-checkbox v-for="k in FEATURE_KEYS" :key="k" :value="k">{{ k }}</el-checkbox>
                  </el-checkbox-group>
                </div>
                <div class="field wide">
                  <label class="fl">{{ t("site2.guide.label.plugins") }} <code>plugins</code></label>
                  <div class="plugins">
                    <el-checkbox
                      v-for="p in PLUGIN_SWITCHES"
                      :key="p.key"
                      v-model="form[p.key]"
                      size="small"
                      :title="form[p.key] ? t('demo.embed.label.pluginChecked') : t('demo.embed.label.pluginUnchecked')"
                    >
                      {{ p.label }}
                    </el-checkbox>
                  </div>
                </div>
                <template v-if="form.mdPlugin">
                  <div class="field">
                    <label class="fl">{{ t("demo.embed.label.mdInitialMode") }}</label>
                    <FcSelect v-model="form.mdInitialMode" :options="mdModeOptions" size="small" style="width: 100%" />
                  </div>
                  <div class="field">
                    <label class="fl">{{ t("demo.embed.label.mdDefaultMode") }}</label>
                    <FcSelect v-model="form.mdDefaultMode" :options="mdModeOptions" size="small" style="width: 100%" />
                  </div>
                </template>
              </div>
            </el-collapse-item>
          </el-collapse>

          <div class="pfoot">
            <span class="note">{{ t("site2.guide.step.cap3") }}</span>
            <FcButton variant="primary" @click="toStep3">{{ t("site2.guide.act.next") }}</FcButton>
          </div>
        </section>

        <!-- 步骤 3 · 连接（S05 诊断五步 + 三分诊） -->
        <section v-else-if="step === 3" class="panel">
          <div class="phead">
            <h2>{{ panelTitle }}</h2>
            <p class="cap">{{ t("site2.guide.step.cap3") }}</p>
          </div>

          <!-- S3 诚实降级卡：不做浏览器端预检，直接挂载验证 -->
          <div v-if="!isWebDav" class="diag-card honest">
            <div class="diag-head">
              <i class="dot" aria-hidden="true"></i>
              <strong>{{ t("site2.guide.diag.s3Honest") }}</strong>
            </div>
            <p class="mono-line">{{ form.endpoint }}</p>
          </div>

          <!-- WebDAV：状态 + 五步条 -->
          <template v-else>
            <div class="state-tag">
              <i :class="{ run: probeState === 'running', ok: probeState === 'ok', bad: probeState === 'fail' }" aria-hidden="true"></i>
              <span v-if="probeState === 'running'">{{ t("site2.guide.diag.run") }}</span>
              <span v-else-if="probeState === 'ok'">{{ t("site2.guide.diag.ok") }}</span>
              <span v-else-if="probeState === 'fail'">{{ t("site2.guide.diag.fail") }}</span>
            </div>
            <div class="steps">
              <template v-for="(key, i) in PROBE_STEPS" :key="key">
                <div class="st" :class="`st-${segState(key)}`">
                  <span class="st-ball">
                    <svg v-if="segState(key) === 'done'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>
                    <svg v-else-if="segState(key) === 'cur'" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="38 18" /></svg>
                    <template v-else>{{ i + 1 }}</template>
                  </span>
                  <span class="st-name">{{ t(`site2.guide.diag.${key}`) }}</span>
                </div>
                <span v-if="i < PROBE_STEPS.length - 1" class="st-line" :class="{ lit: segState(key) === 'done' }" aria-hidden="true"></span>
              </template>
            </div>
          </template>

          <!-- 失败诊断卡：三分诊（CORS+nginx 片段 / 认证 / 地址），每类带重试 -->
          <div v-if="failKind" class="diag-card">
            <div class="diag-head">
              <i class="red" aria-hidden="true"></i>
              <strong v-if="failKind === 'cors'">{{ t("site2.guide.diag.msgNetwork") }}</strong>
              <strong v-else-if="failKind === 'auth'">{{ t("site2.guide.triage.auth") }}</strong>
              <strong v-else>{{ t("site2.guide.triage.address") }}</strong>
            </div>
            <p class="mono-line">{{ form.endpoint }}</p>

            <template v-if="failKind === 'cors'">
              <p class="check-head">{{ t("site2.guide.diag.corsHead") }}</p>
              <div class="check-list">
                <p class="check-row">{{ t("site2.guide.diag.check1", { origin: pageOrigin }) }}</p>
                <p class="check-row">{{ t("site2.guide.diag.check2") }}</p>
                <p class="check-row">{{ t("site2.guide.diag.check3") }}</p>
                <p class="check-row">{{ t("site2.guide.diag.check4") }}</p>
              </div>
              <div class="snippet">
                <div class="snippet-head">
                  <span>{{ t("site2.guide.snippet.label") }}</span>
                  <button type="button" class="copy-btn" @click="copyNginx">{{ t("site2.guide.snippet.copy") }}</button>
                </div>
                <pre>{{ NGINX_SNIPPET }}</pre>
              </div>
              <details class="alt">
                <summary>{{ t("site2.guide.triage.alsoAuth") }}</summary>
              </details>
              <details class="alt">
                <summary>{{ t("site2.guide.triage.alsoAddress") }}</summary>
              </details>
            </template>
            <p v-else-if="failKind === 'auth'" class="check-head">{{ t("site2.guide.triage.authBody") }}</p>
            <p v-else class="check-head">{{ t("site2.guide.triage.addressBody") }}</p>

            <div class="pfoot">
              <FcButton variant="secondary" size="sm" :disabled="probeState === 'running'" @click="onConnect">
                {{ t("site2.guide.diag.retry") }}
              </FcButton>
            </div>
          </div>

          <div class="pfoot">
            <FcButton variant="primary" :disabled="probeState === 'running'" @click="onConnect">
              {{ t("site2.guide.act.connect") }}
            </FcButton>
          </div>
        </section>

        <!-- 步骤 4 · 打开工作台（交接完成页：配置带入 /workspace 挂载，交接契约见文件头） -->
        <section v-else class="panel">
          <div class="phead">
            <h2>{{ panelTitle }}</h2>
            <p class="cap">{{ t("site2.guide.step.cap4") }}</p>
          </div>

          <div class="done">
            <span class="done-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            </span>
            <strong>{{ t("site2.guide.done.title") }}</strong>
            <span class="done-sub">{{ t("site2.guide.done.sub") }}</span>
          </div>

          <div class="summary">
            <div class="summary-head">{{ t("site2.guide.done.summaryTitle") }}</div>
            <pre class="summary-code">{{ configPreview }}</pre>
          </div>

          <div class="pfoot">
            <span class="note">{{ t("site2.guide.done.hint") }}</span>
            <FcButton variant="primary" @click="openWorkspace">{{ t("site2.guide.done.open") }}</FcButton>
          </div>
          <div class="backline">
            <button type="button" class="back-link" @click="goBack(3)">← {{ t("site2.guide.done.back") }}</button>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped lang="scss">
.guide {
  width: 100%;
  max-width: var(--site2-container, 1360px);
  margin: 0 auto;
  padding: var(--space-lg, 24px) var(--space-md, 16px) var(--space-xl, 32px);
}

.head {
  h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.3px;
    color: var(--app-text-primary);
  }
  .sub {
    margin: var(--space-xs, 4px) 0 0;
    font-size: 13px;
    color: var(--app-text-secondary);
  }
}

.progress {
  margin-top: var(--space-md, 16px);
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-sm, 8px);

  .seg-track {
    height: 4px;
    border-radius: 999px;
    background: var(--app-separator);
    &.done {
      background: var(--app-primary);
    }
  }
  .seg-label {
    margin-top: 6px;
    font-size: 12px;
    color: var(--app-text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    &.cur {
      color: var(--app-text-primary);
      font-weight: 600;
    }
  }
}

.body {
  margin-top: var(--space-md, 16px);
  display: grid;
  grid-template-columns: minmax(240px, 4fr) 8fr;
  gap: var(--space-lg, 24px);
  align-items: start;
}

// ── 左栏步骤条 ──
.rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rstep {
  position: relative;
  display: flex;
  gap: var(--space-sm, 8px);
  padding: 12px 12px 12px 16px;
  border: 0;
  border-left: 3px solid transparent;
  border-radius: 0 var(--app-radius-button, 6px) var(--app-radius-button, 6px) 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
  cursor: default;

  &.cur {
    border-left-color: var(--app-primary);
    background: color-mix(in srgb, var(--app-primary) 8%, transparent);
  }
  &.back {
    cursor: pointer;
    &:hover {
      background: var(--app-bg-muted);
      color: var(--app-text-primary);
    }
    &:focus-visible {
      outline: 2px solid var(--app-primary);
      outline-offset: 2px;
    }
  }
  &:disabled {
    color: inherit;
  }

  .rnum {
    width: 26px;
    height: 26px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 999px;
    border: 1px solid var(--app-separator);
    background: var(--app-bg-card);
    font-size: 13px;
    color: var(--app-text-secondary);
  }
  &.cur .rnum {
    background: var(--app-primary);
    border-color: var(--app-primary);
    color: #fff;
    font-weight: 600;
  }
  &.back .rnum {
    color: var(--app-primary);
    border-color: var(--app-primary);
  }

  .rt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .rname {
    font-size: 14px;
    font-weight: 600;
    color: var(--app-text-primary);
  }
  .rcap {
    font-size: 12px;
    color: var(--app-text-tertiary);
  }
}

.skip {
  margin-top: var(--space-md, 16px);
  padding: 10px 16px 0;
  border: 0;
  border-top: 1px solid var(--app-separator);
  background: transparent;
  text-align: left;
  font-size: 13px;
  font-family: inherit;
  color: var(--app-primary);
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
  &:focus-visible {
    outline: 2px solid var(--app-primary);
    outline-offset: 2px;
  }
}

// 单文件模式入口（RouterLink 渲染 a）：与 skip 同款行样式，a 缺省 inline 需转块级并去下划线
a.skip {
  display: block;
  text-decoration: none;
}

// ── 右栏面板 ──
.panels {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.panel {
  background: var(--app-bg-card);
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-card);
  box-shadow: var(--app-shadow-sm, 0 1px 2px rgba(31, 31, 31, 0.06));
  padding: var(--space-md, 16px) var(--space-lg, 24px) var(--space-md, 16px);
}

.phead {
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--app-text-primary);
  }
  .cap {
    margin: 2px 0 0;
    font-size: 13px;
    color: var(--app-text-secondary);
  }
}

.pfoot {
  margin-top: var(--space-md, 16px);
  padding-top: var(--space-sm, 8px);
  border-top: 1px solid var(--app-separator);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm, 8px);

  .note {
    font-size: 12px;
    color: var(--app-text-tertiary);
  }
}

// ── 步骤 4：交接完成页（完成态 + 配置摘要 + 主钮/回退链接） ──
.done {
  margin-top: var(--space-lg, 24px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs, 4px);
  text-align: center;

  .done-badge {
    width: 44px;
    height: 44px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--el-color-success) 12%, transparent);
    color: var(--el-color-success);
    svg {
      width: 24px;
      height: 24px;
    }
  }
  strong {
    margin-top: var(--space-xs, 4px);
    font-size: 16px;
    font-weight: 700;
    color: var(--app-text-primary);
  }
  .done-sub {
    font-size: 13px;
    color: var(--app-text-secondary);
  }
}

.summary {
  margin-top: var(--space-lg, 24px);
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-button);
  overflow: hidden;

  .summary-head {
    padding: 8px 12px;
    background: var(--app-bg-muted);
    font-size: 12px;
    font-weight: 600;
    color: var(--app-text-secondary);
  }
  .summary-code {
    margin: 0;
    padding: 10px 12px;
    background: var(--app-bg-card);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.6;
    color: var(--app-text-primary);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 220px;
    overflow: auto;
  }
}

.backline {
  margin-top: var(--space-sm, 8px);
  text-align: center;
}

.back-link {
  border: 0;
  background: transparent;
  padding: 4px 8px;
  font-family: inherit;
  font-size: 13px;
  color: var(--app-text-secondary);
  cursor: pointer;

  &:hover {
    color: var(--app-primary);
    text-decoration: underline;
  }
  &:focus-visible {
    outline: 2px solid var(--app-primary);
    outline-offset: 2px;
  }
}

// ── 步骤 1：类型二选一卡 ──
.types {
  margin-top: var(--space-md, 16px);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md, 16px);
}

.type-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs, 4px);
  padding: var(--space-md, 16px);
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-card);
  background: var(--app-bg-card);
  font-family: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    border-color: var(--app-text-tertiary);
  }
  &:focus-visible {
    outline: 2px solid var(--app-primary);
    outline-offset: 2px;
  }
  &.sel {
    background: color-mix(in srgb, var(--app-primary) 8%, transparent);
    border-color: var(--app-primary);
  }

  .sel-dot {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background: var(--app-primary);
    color: #fff;
    svg {
      width: 12px;
      height: 12px;
    }
  }
  .type-head {
    display: flex;
    align-items: center;
    gap: var(--space-xs, 4px);
    svg {
      width: 22px;
      height: 22px;
      color: var(--app-text-secondary);
      flex: none;
    }
    strong {
      font-size: 15px;
      font-weight: 700;
      color: var(--app-text-primary);
    }
  }
  .q {
    font-size: 12px;
    color: var(--app-text-tertiary);
  }
  .eg {
    font-size: 13px;
    color: var(--app-text-secondary);
    line-height: 1.6;
  }
  .tcode {
    margin-top: var(--space-sm, 8px);
    padding-top: var(--space-xs, 4px);
    border-top: 1px dashed var(--app-separator);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--app-text-tertiary);
  }
}

// ── 步骤 2：字段网格（人话 label + 代码标识符对照小字） ──
.fgrid {
  margin-top: var(--space-md, 16px);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-sm, 8px) var(--space-md, 16px);
}

.field {
  min-width: 0;

  &.wide {
    grid-column: 1 / -1;
  }
  .fl {
    display: block;
    margin-bottom: 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--app-text-primary);

    code {
      margin-left: 4px;
      padding: 1px 5px;
      background: var(--app-bg-muted);
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      font-weight: 400;
      color: var(--app-text-tertiary);
    }
  }
  .hint {
    font-size: 12px;
    color: var(--app-text-tertiary);
    line-height: 1.6;
  }
  .pair {
    display: flex;
    gap: var(--space-sm, 8px);
    align-items: center;
    flex-wrap: wrap;
  }
  .plugins {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }
}

.adv {
  margin-top: var(--space-md, 16px);
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-button);

  :deep(.el-collapse-item__header) {
    font-size: 13px;
    color: var(--app-text-secondary);
    padding: 0 12px;
  }
  :deep(.el-collapse-item__content) {
    padding: 4px 12px 12px;
  }
}

// ── 步骤 3：五步条 + 诊断卡 ──
.state-tag {
  margin-top: var(--space-md, 16px);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text-secondary);

  i {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    display: inline-block;
    background: var(--app-text-tertiary);
    &.run {
      background: var(--el-color-warning);
    }
    &.ok {
      background: var(--el-color-success);
    }
    &.bad {
      background: var(--el-color-danger);
    }
  }
}

.steps {
  margin-top: var(--space-sm, 8px);
  display: flex;
  align-items: flex-start;

  .st {
    flex: none;
    width: 64px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;

    .st-ball {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      border: 1.5px solid var(--app-separator);
      background: var(--app-bg-card);
      font-size: 12px;
      color: var(--app-text-tertiary);
      svg {
        width: 14px;
        height: 14px;
      }
    }
    .st-name {
      font-size: 11px;
      color: var(--app-text-secondary);
      white-space: nowrap;
    }
    &.st-done .st-ball {
      border-color: var(--el-color-success);
      color: var(--el-color-success);
    }
    &.st-cur .st-ball {
      border-color: var(--app-primary);
      color: var(--app-primary);
    }
    &.st-fail .st-ball {
      border-color: var(--el-color-danger);
      color: var(--el-color-danger);
    }
    &.st-fail .st-name {
      color: var(--el-color-danger);
      font-weight: 600;
    }
  }

  .st-line {
    flex: 1;
    height: 2px;
    margin-top: 13px;
    background: var(--app-separator);
    border-radius: 999px;
    &.lit {
      background: var(--el-color-success);
    }
  }
}

.diag-card {
  margin-top: var(--space-sm, 8px);
  background: var(--app-bg-card);
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-card);
  box-shadow: var(--app-shadow-sm, 0 1px 2px rgba(31, 31, 31, 0.06));
  padding: var(--space-md, 16px) var(--space-lg, 24px);

  &.honest .diag-head strong {
    font-weight: 600;
  }

  .diag-head {
    display: flex;
    align-items: center;
    gap: var(--space-xs, 4px);
    flex-wrap: wrap;

    strong {
      font-size: 14px;
      color: var(--app-text-primary);
    }
    .red {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--el-color-danger);
      display: inline-block;
      flex: none;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--app-primary);
      display: inline-block;
      flex: none;
    }
  }

  .mono-line {
    margin: 6px 0 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: var(--app-text-secondary);
    word-break: break-all;
  }

  .check-head {
    margin: var(--space-sm, 8px) 0 0;
    font-size: 12.5px;
    color: var(--app-text-secondary);
  }

  .check-list {
    margin-top: var(--space-xs, 4px);
    display: grid;
    gap: 6px;
  }
  .check-row {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--app-text-primary);

    &::before {
      content: "×";
      color: var(--el-color-danger);
      font-weight: 700;
      flex: none;
    }
  }

  .snippet {
    margin-top: var(--space-sm, 8px);

    .snippet-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm, 8px);

      span {
        font-size: 12px;
        color: var(--app-text-tertiary);
      }
    }
    .copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 26px;
      padding: 0 10px;
      border: 1px solid var(--app-separator);
      border-radius: var(--app-radius-button);
      background: var(--app-bg-card);
      color: var(--app-text-secondary);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;

      &:hover {
        border-color: var(--app-text-tertiary);
        color: var(--app-text-primary);
      }
      &:focus-visible {
        outline: 2px solid var(--app-primary);
        outline-offset: 2px;
      }
    }
    pre {
      margin-top: 6px;
      padding: 10px 14px;
      background: var(--app-bg-muted);
      border-radius: var(--app-radius-button);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.7;
      color: var(--app-text-primary);
      overflow-x: auto;
    }
  }

  .alt {
    margin-top: var(--space-xs, 4px);
    border-top: 1px dashed var(--app-separator);

    summary {
      cursor: pointer;
      padding: 8px 0;
      font-size: 13px;
      font-weight: 500;
      color: var(--app-text-primary);
      list-style: none;

      &::-webkit-details-marker {
        display: none;
      }
      &:hover {
        color: var(--app-primary);
      }
    }
  }

  .pfoot {
    border-top: 1px dashed var(--app-separator);
    justify-content: flex-end;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .type-card,
  .rstep,
  .copy-btn,
  .skip,
  .st-ball {
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .spin {
    animation: g2-spin 1s linear infinite;
    transform-origin: center;
  }
  @keyframes g2-spin {
    to {
      transform: rotate(360deg);
    }
  }
}

@media (max-width: 960px) {
  .body {
    grid-template-columns: 1fr;
  }
  .types,
  .fgrid {
    grid-template-columns: 1fr;
  }
}
</style>
