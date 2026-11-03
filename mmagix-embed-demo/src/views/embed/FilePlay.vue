<script setup lang="ts">
import { computed, reactive, ref, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { FcButton, FcSegmented, FcSelect, FcSection } from "@/components/sdk";
import LogPanel from "@/components/LogPanel.vue";
import { OEM_CONFIG } from "@/config/oem";
import {
  buildFileUrl,
  useMmagixFilesClient,
  CONFIG_VERSION,
  type LogEntry,
  type MmxSingleFileConfig,
} from "@/composables/useMmagixFilesClient";

const { t } = useI18n();

const {
  iframeRef,
  status,
  logs: logsRef,
  mount,
  call,
  destroy,
  log,
} = useMmagixFilesClient();
// 裸绑定类型解包坑（仅类型层，运行时同一对象零改动）：files-client 源码直连（tsconfig paths）
// 下其 `vue` 解析到 frontend 副本，与 demo 副本的 `Ref` 品牌符号（unique symbol）不互通，
// vue-tsc 对裸 prop 绑定的 `__VLS_unwrap` 跨副本判 `T extends Ref` 失败→不解包→整只 Ref
// 流进 LogPanel 的 `LogEntry[]` prop（EmbedPlay 因模板另有 logs.length 命中 .value 通道而幸免）。
// 以 demo 侧 `Ref` 重述类型后 vue-tsc 正常解包。
const logs = logsRef as unknown as Ref<LogEntry[]>;

// ── #file 配置表单 ──
const form = reactive({
  sourceUrl: `${OEM_CONFIG.sampleBase}hello.md`,
  name: "hello.md",
  method: "GET" as "GET" | "POST",
  body: "",
  theme: "light" as "light" | "dark",
  locale: "zh-CN" as "zh-CN" | "en-US",
  /** 勾选=附加 save 段（可编辑回写）；不勾=只读 */
  saveEnabled: false,
  saveMethod: "PUT" as "PUT" | "POST",
  saveUrl: "",
});

interface Preset {
  label: string;
  url: string;
  name: string;
  /** 带 writable 标记的预设：一键填好 save 段（GET/PUT 同址——scripts/single-file-server.mjs 语义） */
  writable?: boolean;
}

/** 示例预设（label 走 i18n；url/name 为协议字面量） */
const PRESETS = computed<Preset[]>(() => [
  { label: t("demo.file.preset.sampleHello"), url: `${OEM_CONFIG.sampleBase}hello.md`, name: "hello.md" },
  { label: t("demo.file.preset.sampleCsv"), url: `${OEM_CONFIG.sampleBase}demo.csv`, name: "demo.csv" },
  {
    label: t("demo.file.preset.svcHello"),
    url: "http://localhost:5210/files/hello.md",
    name: "hello.md",
    writable: true,
  },
  {
    label: t("demo.file.preset.svcCsv"),
    url: "http://localhost:5210/files/demo.csv",
    name: "demo.csv",
    writable: true,
  },
  {
    label: t("demo.file.preset.external"),
    url: "https://raw.githubusercontent.com/markedjs/marked/master/README.md",
    name: "marked-README.md",
  },
]);

function applyPreset(p: Preset) {
  form.sourceUrl = p.url;
  form.name = p.name;
  // writable 预设：save 段自动配齐（PUT 回写同址）；只读预设则还原为只读
  form.saveEnabled = p.writable === true;
  form.saveMethod = "PUT";
  form.saveUrl = p.writable === true ? p.url : "";
}

const statusLabel = computed(
  () =>
    ({
      idle: t("demo.status.idle"),
      mounting: t("demo.status.mounting"),
      ready: t("demo.status.ready"),
      error: t("demo.status.error"),
    })[status.value],
);

function buildFileConfig(): MmxSingleFileConfig {
  const cfg: MmxSingleFileConfig = {
    mode: "file",
    v: CONFIG_VERSION,
    source: {
      url: form.sourceUrl.trim(),
      method: form.method,
      ...(form.method === "POST" && form.body.trim() ? { body: form.body } : {}),
    },
    name: form.name.trim() || undefined,
    appearance: { theme: form.theme, locale: form.locale },
    // security.allowedOrigins：file 模式可选（缺省 iframe 侧从 document.referrer 推导），
    // 但 mount() 内 withHostOrigin 同样会显式写入宿主 origin，两不误。
    // 插件按勾选注入（启动即载）；未勾选的插件在独立区「加载」时经 registerApp 动态初始化
    plugins: PLUGIN_DEFS.filter((p) => pluginChecks[p.key as keyof typeof pluginChecks]).map((p) => ({
      url: `${OEM_CONFIG.filesBase}${p.url}`,
      lazy: false as const,
    })),
  };
  if (form.saveEnabled && form.saveUrl.trim()) {
    cfg.save = { method: form.saveMethod, url: form.saveUrl.trim() };
  }
  return cfg;
}

const fileUrlPreview = computed(() => buildFileUrl(OEM_CONFIG.filesBase, buildFileConfig()));

const editable = computed(() => form.saveEnabled && form.saveUrl.trim() !== "");
const readonlyFlag = computed(() => (editable.value ? t("demo.file.editable") : t("demo.file.readonly")));

async function onMount() {
  if (!form.sourceUrl.trim()) {
    ElMessage.warning(t("demo.file.msg.needSource"));
    return;
  }
  try {
    await mount(buildFileConfig(), OEM_CONFIG.filesBase);
  } catch {
    /* 日志区已记录 */
  }
}

async function act(name: string, payload?: unknown, label?: string) {
  // name=真实命令名；label=展示名（仅日志/Toast）——分离防展示名污染命令名（4005 无处理器）
  const show = label ?? name;
  try {
    await call(name, payload);
    ElMessage.success(t("demo.embed.msg.actOk", { name: show }));
  } catch (err) {
    const code = (err as { code?: number }).code;
    ElMessage.error(t("demo.embed.msg.actFail", { name: show, code: code ?? "?" }));
  }
}

async function onTryWorkspaceCmd() {
  // 单文件模式的命令子集=setTheme/setLocale/getInfo/destroy；
  // 工作台命令（如 navigate）一律 reject 4305 UNSUPPORTED_MODE——按钮本身就是个错误码演示。
  await act("navigate", { path: "/" }, "navigate（4305）");
}

/**
 * uploadFiles(target='memory')：本地文件 → structured clone 传入 iframe 内存 store（不落 S3），
 * iframe 内经 opener hook 自动打开预览（mem:// 由 DataSource 分支供数，渲染器零改动）。
 * 编辑保存（可写模式）写回内存条目，同样不落 S3。
 */
const memInput = ref<HTMLInputElement | null>(null);
function onPickMemFile() {
  memInput.value?.click();
}

// ── 插件勾选（装载区）：勾选=启动即载；未勾选=独立区「加载」时 registerApp 动态初始化 ──
const PLUGIN_DEFS = [
  { key: "univer", label: "Univer 文档", url: "/plugins/univer-office.js" },
  { key: "pdf", label: "PDF 签批", url: "/plugins/pdf-annotator.js" },
  { key: "md", label: "Markdown 编辑", url: "/plugins/markdown-editor.js" },
  { key: "html", label: "HTML 编辑", url: "/plugins/html-editor.js" },
  { key: "pptx", label: "PPTX 预览", url: "/plugins/pptx-viewer.js" },
  { key: "artplayer", label: "媒体播放", url: "/plugins/artplayer-player.js" },
  { key: "filerobot", label: "图片编辑", url: "/plugins/filerobot-image-editor.js" },
] as const;
const pluginChecks = reactive<Record<string, boolean>>({
  univer: true,
  pdf: true,
  md: true,
  html: true,
  pptx: true,
  artplayer: true,
  filerobot: true,
});

// ── 应用静态清单（独立区②「未初始化也可选应用」）：exts 做扩展名过滤、pluginUrl=加载时动态注册 ──
interface CatalogApp {
  id: string;
  label: string;
  kind: "view" | "edit";
  exts: string[];
  pluginKey?: string;
}
const APP_CATALOG: CatalogApp[] = [
  { id: "image-viewer", label: "图片查看", kind: "view", exts: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"] },
  { id: "markdown-renderer", label: "Markdown 预览", kind: "view", exts: ["md", "markdown"] },
  { id: "code-editor", label: "代码编辑", kind: "edit", exts: ["md", "markdown", "txt", "json", "csv", "tsv", "js", "ts", "css", "html", "xml", "sql", "sh", "yaml", "py", "conf"] },
  { id: "html-viewer", label: "HTML 预览", kind: "view", exts: ["html", "htm"] },
  { id: "csv-table", label: "CSV 表格", kind: "view", exts: ["csv", "tsv"] },
  { id: "pdf-viewer", label: "PDF 查看", kind: "view", exts: ["pdf"] },
  { id: "docx-viewer", label: "Word 查看", kind: "view", exts: ["docx"] },
  { id: "xlsx-viewer", label: "Excel 查看", kind: "view", exts: ["xlsx"] },
  { id: "heic-viewer", label: "HEIC 查看", kind: "view", exts: ["heic"] },
  { id: "video-player", label: "视频播放", kind: "view", exts: ["mp4", "webm", "mov"] },
  { id: "audio-player", label: "音频播放", kind: "view", exts: ["mp3", "wav", "ogg", "flac", "m4a"] },
  { id: "flow-editor", label: "流程图编辑", kind: "edit", exts: ["mmd"] },
  { id: "mermaid-viewer", label: "Mermaid 预览", kind: "view", exts: ["mmd"] },
  { id: "markdown-editor", label: "Markdown 编辑", kind: "edit", exts: ["md", "markdown"], pluginKey: "md" },
  { id: "univer-office", label: "Univer 文档编辑", kind: "edit", exts: ["xlsx", "xls", "docx"], pluginKey: "univer" },
  { id: "filerobot-image-editor", label: "图片编辑", kind: "edit", exts: ["png", "jpg", "jpeg", "webp", "bmp", "gif"], pluginKey: "filerobot" },
  { id: "artplayer-media", label: "媒体播放增强", kind: "view", exts: ["mp4", "webm", "mov", "mp3", "wav", "ogg", "flac", "m4a"], pluginKey: "artplayer" },
  { id: "pdf-annotator", label: "PDF 签批", kind: "edit", exts: ["pdf"], pluginKey: "pdf" },
  { id: "html-editor", label: "HTML 编辑", kind: "edit", exts: ["html", "htm"], pluginKey: "html" },
  { id: "pptx-viewer", label: "PPTX 预览", kind: "view", exts: ["pptx"], pluginKey: "pptx" },
];

async function onMemUpload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (files.length === 0) return;
  // 立即缓冲为纯数据副本（源文件失效免疫）；读不出的文件跳过并提示
  const buffered: File[] = [];
  for (const f of files) {
    try {
      buffered.push(new File([await f.arrayBuffer()], f.name, { type: f.type || "application/octet-stream" }));
    } catch {
      ElMessage.error(`${t("demo.file.memUnreadable")}: ${f.name}`);
    }
  }
  if (buffered.length > 0) {
    void act("uploadFiles", { files: buffered, target: "memory" }, `uploadFiles(files×${buffered.length}, memory)`);
  }
  input.value = "";
}

// ── 内存文件 DEMO 独立区（①上传 ②选应用 ③只读/编辑 ④应用参数 ⑤加载） ──
const memDemo = reactive({
  file: null as File | null,
  /** 选文件时立即读入的内容快照（ArrayBuffer）——File 引用会因源文件移动/删除/云盘逐出而
   *  失效（渲染期 NotReadableError），上传改用纯数据副本对源失效免疫 */
  buffer: null as ArrayBuffer | null,
  appId: "",
  mode: "view" as "view" | "edit",
  optionsJson: "",
});
const memAppOptions = computed(() => {
  const ext = memDemo.file?.name.split(".").pop()?.toLowerCase() ?? "";
  return APP_CATALOG.filter(
    (a) => a.kind === memDemo.mode && (!ext || a.exts.includes(ext)),
  ).map((a) => ({ label: a.label + (a.pluginKey && !pluginChecks[a.pluginKey] ? "（加载时初始化）" : ""), value: a.id }));
});
/** 下拉占位两态：该扩展名无命中 / 有命中未选（一键直达后装载不再是前置——「加载」自动装） */
const memPlaceholder = computed(() => {
  const ext = memDemo.file?.name.split(".").pop()?.toLowerCase() ?? "";
  const pool = APP_CATALOG.filter((a) => a.kind === memDemo.mode && a.exts.includes(ext));
  if (pool.length === 0) return t("demo.file.memNoMatch");
  return t("demo.file.memNoFile");
});
const memDemoInput = ref<HTMLInputElement | null>(null);
function onPickMemDemo() {
  memDemoInput.value?.click();
}
async function onMemDemoPick(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  try {
    memDemo.buffer = await f.arrayBuffer(); // 立即读入内存（源文件此刻读不出就当场报错，不拖到加载）
  } catch {
    ElMessage.error(`${t("demo.file.memUnreadable")}: ${f.name}`);
    input.value = "";
    return;
  }
  memDemo.file = f;
  // appId 不在此清空——下方 watch 按新文件过滤集裁决：兼容则保留已选（先选应用后选文件不丢），
  // 不兼容自动切首项
  input.value = "";
}

// 选文件/切模式 → appId 不在新过滤集时自动切到首项（catalog 静态清单驱动，未装载也可选）
watch(
  [() => memDemo.file, () => memDemo.mode],
  ([f, mode]) => {
    const ext = f?.name.split(".").pop()?.toLowerCase() ?? "";
    const pool = APP_CATALOG.filter((a) => a.kind === mode && (!ext || a.exts.includes(ext)));
    if (!pool.some((a) => a.id === memDemo.appId)) memDemo.appId = pool[0]?.id ?? "";
  },
);

/** ⑤加载（一键直达）：未装载→装载 / 已装载→先卸载重装（mount() 内部先 destroy 旧会话再重建，
 * 保证会话与当前插件勾选一致）→ ready 后按需 registerApp 动态初始化 → uploadFiles(target=memory)
 * + appId/appOptions 透传——iframe 落库后按指定应用+参数打开预览 */
const memLoading = ref(false);
async function onMemDemoLoad() {
  if (memLoading.value) return;
  // 不校验 sourceUrl——v1.2 无源装载（source.url=''）：一键加载重装后 boot 不打开源文件，
  // 舞台直接等 uploadFiles 打开内存文件（防 hello.md 闪现）；手动「装载 iframe（#file）」仍要求源
  if (!memDemo.file) {
    ElMessage.warning(t("demo.file.memPickFirst"));
    return;
  }
  if (!memDemo.appId) {
    ElMessage.warning(t("demo.file.memPickApp"));
    return;
  }
  let appOptions: Record<string, unknown> | undefined;
  if (memDemo.optionsJson.trim()) {
    try {
      appOptions = JSON.parse(memDemo.optionsJson);
    } catch {
      ElMessage.error(t("demo.file.memBadJson"));
      return;
    }
  }
  memLoading.value = true;
  try {
    if (status.value !== "idle") log("一键加载：先卸载旧会话，按当前勾选重新装载 …");
    // 一键加载=纯内存容器装载：source.url 置空（v1.2 无源装载）——boot 不打开源文件，
    // 舞台直接等 uploadFiles（防 hello.md 一闪而过）；手动「装载 iframe（#file）」才带源预览
    const cfg = buildFileConfig();
    cfg.source = { ...cfg.source, url: "" };
    await mount(cfg, OEM_CONFIG.filesBase);
    // 「加载时再初始化」：选中应用属插件且未在启动勾选中（本会话未装载）→ registerApp 动态载入
    // （loader 幂等）；启动已载/内置应用跳过。
    const cat = APP_CATALOG.find((a) => a.id === memDemo.appId);
    if (cat?.pluginKey && !pluginChecks[cat.pluginKey]) {
      const def = PLUGIN_DEFS.find((p) => p.key === cat.pluginKey)!;
      await call("registerApp", { url: `${OEM_CONFIG.filesBase}${def.url}` });
    }
    // 用内容快照重建 File（structured clone 纯数据，源文件失效免疫）；buffer 必存在（选文件时已读）
    const snapshot = new File([memDemo.buffer!], memDemo.file.name, {
      type: memDemo.file.type || "application/octet-stream",
    });
    await act(
      "uploadFiles",
      { files: [snapshot], target: "memory", appId: memDemo.appId, appOptions },
      `uploadFiles(memory → ${memDemo.appId})`,
    );
  } catch {
    /* mount/call 失败已进日志区（act 自带成功/失败 Toast） */
  } finally {
    memLoading.value = false;
  }
}

async function onDestroy() {
  try {
    await destroy();
    ElMessage.success(t("demo.file.msg.destroyOk"));
  } catch {
    /* 日志区已记录 */
  }
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(fileUrlPreview.value);
    ElMessage.success(t("demo.file.msg.copied"));
  } catch {
    ElMessage.warning(t("demo.file.msg.copyFailed"));
  }
}

const methodOptions = [
  { label: "GET", value: "GET" },
  { label: "POST", value: "POST" },
];
const saveMethodOptions = [
  { label: "PUT", value: "PUT" },
  { label: "POST", value: "POST" },
];
const localeOptions = [
  { label: "zh-CN", value: "zh-CN" },
  { label: "en-US", value: "en-US" },
];
const themeOptions = [
  { label: "light", value: "light" },
  { label: "dark", value: "dark" },
];
</script>

<template>
  <div class="play">
    <div class="play-main">
      <aside class="panel">
        <FcSection padding="md" shadow="sm">
          <template #header>
            <h3 class="section-title">{{ t("demo.file.title") }}</h3>
          </template>

          <el-alert type="info" :closable="false" class="hint">
            <p>
              <code>#file</code> / <code>#config</code>
              {{ t("demo.file.hint0") }}
              <b>{{ t("demo.file.hint1") }}</b
              >。
            </p>
          </el-alert>

          <el-form label-position="top" size="small" class="conn-form">
            <el-form-item class="fc-form-item" :label="t('demo.file.label.preset')">
              <div class="presets">
                <FcButton
                  v-for="p in PRESETS"
                  :key="p.url"
                  variant="secondary"
                  size="sm"
                  @click="applyPreset(p)"
                >
                  {{ p.label }}
                </FcButton>
              </div>
            </el-form-item>
            <el-form-item class="fc-form-item" :label="t('demo.file.label.sourceUrl')">
              <el-input v-model="form.sourceUrl" class="fc-input" placeholder="https://…/doc.md" />
            </el-form-item>
            <div class="row2">
              <el-form-item class="fc-form-item" :label="t('demo.file.label.name')">
                <el-input v-model="form.name" class="fc-input" placeholder="hello.md" />
              </el-form-item>
              <el-form-item class="fc-form-item" label="source.method">
                <FcSelect v-model="form.method" :options="methodOptions" style="width: 100%" />
              </el-form-item>
            </div>
            <el-form-item v-if="form.method === 'POST'" class="fc-form-item" :label="t('demo.file.label.body')">
              <el-input v-model="form.body" class="fc-input" type="textarea" :rows="2" placeholder="body" />
            </el-form-item>
            <div class="row2">
              <el-form-item class="fc-form-item" :label="t('demo.file.label.theme')">
                <FcSegmented v-model="form.theme" :options="themeOptions" size="sm" />
              </el-form-item>
              <el-form-item class="fc-form-item" :label="t('demo.file.label.locale')">
                <FcSelect v-model="form.locale" :options="localeOptions" size="small" style="width: 96px" />
              </el-form-item>
            </div>

            <el-divider class="divider" />
            <el-form-item class="fc-form-item">
              <el-checkbox v-model="form.saveEnabled">
                {{ t("demo.file.label.savePrefix") }}——<b>{{ readonlyFlag }}</b>
              </el-checkbox>
            </el-form-item>
            <template v-if="form.saveEnabled">
              <div class="row2">
                <el-form-item class="fc-form-item" label="save.method">
                  <FcSelect v-model="form.saveMethod" :options="saveMethodOptions" style="width: 100%" />
                </el-form-item>
                <el-form-item class="fc-form-item" label="save.url">
                  <el-input v-model="form.saveUrl" class="fc-input" placeholder="https://api.your.com/docs/42" />
                </el-form-item>
              </div>
              <el-alert type="warning" :closable="false" class="hint">
                <p>{{ t("demo.file.saveHint") }}</p>
              </el-alert>
            </template>
          </el-form>

          <el-collapse class="preview">
            <el-collapse-item :title="t('demo.file.previewTitle')">
              <pre class="code">{{ fileUrlPreview }}</pre>
            </el-collapse-item>
          </el-collapse>
          <div class="actions">
            <FcButton variant="secondary" size="sm" @click="copyUrl">{{ t("demo.file.copyLink") }}</FcButton>
          </div>

          <div class="actions" :style="{ flexWrap: 'wrap', rowGap: '4px' }">
            <span class="note" style="margin: 0; white-space: nowrap">{{ t("demo.file.pluginsLabel") }}</span>
            <el-checkbox
              v-for="p in PLUGIN_DEFS"
              :key="p.key"
              v-model="pluginChecks[p.key]"
              size="small"
              :disabled="status !== 'idle'"
              :title="pluginChecks[p.key] ? t('demo.file.pluginOnMount') : t('demo.file.pluginOnInit')"
            >
              {{ p.label }}
            </el-checkbox>
          </div>
          <div class="actions mount-row">
            <FcButton variant="primary" :disabled="status === 'mounting'" @click="onMount">
              {{ t("demo.file.mount") }}
            </FcButton>
            <FcButton variant="secondary" :disabled="status !== 'ready'" @click="onDestroy">destroy</FcButton>
            <label class="mem-upload" :style="{ opacity: status === 'ready' ? 1 : 0.5, cursor: status === 'ready' ? 'pointer' : 'not-allowed' }">
              <input ref="memInput" type="file" multiple hidden @change="onMemUpload" />
              <FcButton variant="secondary" size="sm" @click="onPickMemFile">
                <i class="ri-upload-2-line" style="margin-right: 4px" />{{ t("demo.file.memUpload") }}
              </FcButton>
            </label>
          </div>
          <p class="note">{{ t("demo.file.memUploadNote") }}</p>
        </FcSection>

        <FcSection padding="md" shadow="sm">
          <template #header>
            <h3 class="section-title">{{ t("demo.file.memTitle") }}</h3>
          </template>
          <div class="actions">
            <label :style="{ cursor: 'pointer' }">
              <input ref="memDemoInput" type="file" hidden @change="onMemDemoPick" />
              <FcButton variant="secondary" size="sm" @click="onPickMemDemo">
                <i class="ri-file-add-line" style="margin-right: 4px" />1 {{ t("demo.file.memStepUpload") }}
              </FcButton>
            </label>
            <span class="note" style="margin: 0">{{ memDemo.file ? "✓ " + memDemo.file.name : t("demo.file.memNoFile") }}</span>
          </div>
          <div class="actions" :style="{ flexWrap: 'wrap', rowGap: '6px' }">
            <span class="note" style="margin: 0; white-space: nowrap">2 {{ t("demo.file.memStepApp") }}</span>
            <FcSelect
              v-model="memDemo.appId"
              :options="memAppOptions"
              size="small"
              :placeholder="memPlaceholder"
              style="width: 200px; min-width: 200px"
            />
            <span :style="{ margin: 0, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '6px' }">
              <span class="note" style="margin: 0">3 {{ t("demo.file.memStepMode") }}</span>
              <FcSegmented
                v-model="memDemo.mode"
                size="sm"
                :options="[
                  { label: t('demo.file.memModeView'), value: 'view' },
                  { label: t('demo.file.memModeEdit'), value: 'edit' },
                ]"
              />
            </span>
          </div>
          <div class="actions">
            <span class="note" style="margin: 0">4 {{ t("demo.file.memStepOpts") }}</span>
            <el-input
              v-model="memDemo.optionsJson"
              size="small"
              placeholder='{"initialMode":"preview"}'
              style="width: 260px"
            />
          </div>
          <div class="actions">
            <FcButton
              variant="primary"
              size="sm"
              :disabled="memLoading"
              :loading="memLoading"
              :title="t('demo.file.memLoadTip')"
              @click="onMemDemoLoad"
            >
              <i v-if="!memLoading" class="ri-play-circle-line" style="margin-right: 4px" />5 {{ t("demo.file.memStepLoad") }}
            </FcButton>
          </div>
          <p class="note">{{ t("demo.file.memDemoNote") }}</p>
        </FcSection>

        <FcSection padding="md" shadow="sm">
          <template #header>
            <h3 class="section-title">{{ t("demo.file.actionsTitle") }}</h3>
          </template>
          <div class="actions">
            <FcButton variant="secondary" size="sm" :disabled="status !== 'ready'" @click="act('getInfo', {})">getInfo</FcButton>
            <FcButton
              variant="secondary"
              size="sm"
              :disabled="status !== 'ready'"
              @click="act('setTheme', { theme: form.theme === 'light' ? 'dark' : 'light' })"
            >
              {{ t("demo.file.setThemeToggle") }}
            </FcButton>
            <FcButton
              variant="secondary"
              size="sm"
              :disabled="status !== 'ready'"
              @click="act('setLocale', { locale: form.locale === 'zh-CN' ? 'en-US' : 'zh-CN' })"
            >
              {{ t("demo.file.setLocaleToggle") }}
            </FcButton>
            <FcButton variant="secondary" size="sm" :disabled="status !== 'ready'" @click="onTryWorkspaceCmd">
              {{ t("demo.file.tryNavigate") }}
            </FcButton>
          </div>
          <p class="note">
            {{ t("demo.file.eventsNote0") }}<code>ready / expired / error / fileChanged</code>{{ t("demo.file.eventsNote1") }}
          </p>
        </FcSection>
      </aside>

      <section class="stage">
        <div class="stage-head">
          <span class="status-dot" :data-status="status"></span>
          <span>{{ statusLabel }}</span>
          <span class="src">{{ readonlyFlag }}</span>
        </div>
        <iframe
          ref="iframeRef"
          class="stage-body"
          :title="t('demo.file.iframeTitle')"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      </section>
    </div>

    <footer class="play-log">
      <FcSection padding="md" shadow="sm">
        <LogPanel :logs="logs" />
      </FcSection>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.play {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
}

.play-main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.panel {
  width: 400px;
  flex: none;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;

  .section-title {
    font-size: 13px;
    margin: 0;
  }
  .hint {
    p {
      margin: 2px 0;
      font-size: 12px;
      line-height: 1.5;
    }
    code {
      background: var(--app-bg-muted);
      padding: 0 3px;
      border-radius: 3px;
    }
  }
  .note {
    color: var(--app-text-tertiary);
    font-size: 12px;
    margin: 0;
    line-height: 1.6;
    code {
      background: var(--app-bg-muted);
      padding: 0 3px;
      border-radius: 3px;
    }
  }
}

.conn-form {
  margin-top: 10px;

  .el-form-item {
    margin-bottom: 10px;
  }
  :deep(.el-form-item__label) {
    font-size: 12px;
    padding-bottom: 2px;
    color: var(--app-text-secondary);
  }
  .divider {
    margin: 8px 0;
  }
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.preview {
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-button);

  .code {
    margin: 0;
    padding: 8px;
    background: var(--app-bg-muted);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.5;
    word-break: break-all;
    white-space: pre-wrap;
    max-height: 160px;
    overflow: auto;
  }
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.mount-row {
  margin-top: 2px;
}

.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-separator);
  border-radius: var(--app-radius-card);
  overflow: hidden;
  background: var(--app-bg-card);

  .stage-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--app-separator);
    font-size: 13px;
    color: var(--app-text-secondary);

    .src {
      margin-left: auto;
      font-size: 12px;
    }
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--app-text-tertiary);
    &[data-status="ready"] {
      background: var(--el-color-success);
    }
    &[data-status="error"] {
      background: var(--el-color-danger);
    }
    &[data-status="mounting"] {
      background: var(--el-color-warning);
    }
  }

  .stage-body {
    flex: 1;
    min-height: 0;
    border: 0;
    width: 100%;
    background: var(--app-bg-card);
  }
}

.play-log {
  flex: none;
  display: flex;
}
</style>
