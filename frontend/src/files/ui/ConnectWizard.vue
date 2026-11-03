<script setup lang="ts">
/**
 * ConnectWizard — 本地连接模式 · 连接向导（Lane G5 + WebDAV §W6）。
 * 契约：PROGRESS.md Wave G / G5；《docs/design/webdav-support-design.md》§W6；文案全部走 wizard.* 词典键。
 *
 * 结构：FcDialog（el-dialog 封装，SDK 强制规则）双栏——左 Profile 侧栏（列出/选用/删除），
 * 右连接表单。表单顶部「存储类型」分段选择（S3 ｜ WebDAV，缺省 S3；§W6），按分支切换字段组：
 * - S3：endpoint/region/bucket/AK/SK/prefix/path-style（既有字段与行为零改动）；
 * - WebDAV：endpoint/根路径(rootPath)/用户名/密码；rootPath 按未编码原文填写（M1-V1，
 *   client.ts normalizeRootPath 负责逐段编码，用户不预编码）。
 *
 * 三条动作链（按分支分流）：
 * - 测试连接：S3=临时 new S3SigV4Client(表单真实凭据) → list(prefix,{delimiter:'/'})；
 *   WebDAV=new WebDavClient({...}) → list('')（PROPFIND Depth:1）——2xx 即成功；
 *   401→认证失败文案（匿名空凭证放行，401 才暴露）；403/其它非 2xx→含 status 的通用文案；
 *   200 但 0 条目→仍算通过、附「根路径为空」警示（M1-V2 P2-3：rootPath 编码口径错会静默空树）；
 *   网络异常（status:0）→无法连接文案。testing 期间按钮 loading + 函数早退双保险禁重复。
 * - 连接：构造 WorkspaceConfig 信封 → JSON → '#config='+encodeURIComponent →
 *   persistRawConfig 写 sessionStorage 备份 → reload。凭据**不写 URL/历史**——scrubFragment
 *   已抹掉 fragment，reload 后 boot 的 restoreRawConfig→parseAppConfig 原链重建。
 *   ⚠️ SECURITY（§W6 注记）：TTL 自毁线对 WebDAV 密码的语义=前端主动遗忘（届时不再携带
 *   Authorization 头），**非凭证真到期**——服务器侧密码仍有效，勿误读为过期保护。
 * - 保存配置：S3 走 profiles.ts（localStorage 明文库，键 mmagic.profiles）；WebDAV 档案
 *   落**独立键 mmagic.profiles.webdav**（同库注入 seam；profiles.ts 的 validateProfile 强制
 *   region/bucket/AK/SK 必填，WebDAV 形状入库即被过滤，故组件内自持最小 schema）。
 *   档案带 type 字段：侧栏合并展示/回填按 type 分流；S3 旧档案无 type 一律视为 s3。
 *   两库同为明文 localStorage，风险定位与常驻警示条 wizard.plaintext-warn 一致。
 *
 * 测试接缝（props 注入，生产用真实现）：storageFactory（profiles 与 raw 备份统一改走注入产物）、
 * reload（默认 location.reload）、clientFactory（默认 new S3SigV4Client）、
 * webdavClientFactory（默认 new WebDavClient）。
 * 挂载入口由主线收口（本组件不碰 Home.vue/boot.ts/main.ts）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcDialog, FcSegmented, FcSwitch } from '@/components/sdk'
import { S3SigV4Client } from '@/sdk/s3/client'
import { WebDavClient } from '@/sdk/webdav/client'
import type { WebDavBackendConfig } from '@/sdk/webdav/client'
import { SdkError } from '@/sdk/errorCodes'
import { persistRawConfig } from '@/sdk/config'
import { CONFIG_VERSION } from '@/sdk/constants'
import {
  DEFAULT_TTL_MINUTES,
  PROFILES_MAX,
  buildWorkspaceConfig,
  createProfile,
  defaultProfilesStorage,
  listProfiles,
  removeProfile,
  resolveTtlSeconds,
  saveProfile,
  updateProfile,
  validateProfile,
} from '../profiles'
import type { S3Profile } from '../profiles'
import type { BackendConfig, S3Client } from '@/sdk/types'

const props = defineProps<{
  /** 弹窗开合（v-model:open） */
  open?: boolean
  /** 存储工厂（测试注入）：注入后 profiles 与 raw 备份统一用该产物；
   *  生产缺省=profiles 走 window.localStorage、raw 备份走 window.sessionStorage（config.ts 缺省） */
  storageFactory?: () => Storage | null
  /** 连接成功后的刷新（测试注入）；生产=location.reload() */
  reload?: () => void
  /** S3 客户端工厂（测试注入 fake）；生产=new S3SigV4Client(backend) */
  clientFactory?: (backend: BackendConfig) => Pick<S3Client, 'list'>
  /** WebDAV 客户端工厂（测试注入 fake）；生产=new WebDavClient(backend)（§W6 探测链入口） */
  webdavClientFactory?: (backend: WebDavBackendConfig) => Pick<S3Client, 'list'>
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const { t } = useI18n()

// ───────────────────────── 接缝实现（生产真实现/测试注入） ─────────────────────────

const dialogOpen = computed({
  get: () => props.open ?? false,
  set: (v: boolean) => emit('update:open', v),
})

function profileStorage(): Storage | null {
  return props.storageFactory ? props.storageFactory() : defaultProfilesStorage()
}

/** raw 备份只进 sessionStorage（生产=config.ts 缺省）；注入时用注入产物（测试观测点） */
function persistRawBackup(raw: string, ttlSeconds: number): void {
  if (props.storageFactory) persistRawConfig(raw, { storage: props.storageFactory(), ttlSeconds })
  else persistRawConfig(raw, { ttlSeconds })
}

function reloadPage(): void {
  if (props.reload) props.reload()
  else window.location.reload()
}

function newClient(backend: BackendConfig): Pick<S3Client, 'list'> {
  return props.clientFactory ? props.clientFactory(backend) : new S3SigV4Client(backend)
}

function newWebDavClient(backend: WebDavBackendConfig): Pick<S3Client, 'list'> {
  return props.webdavClientFactory ? props.webdavClientFactory(backend) : new WebDavClient(backend)
}

// ───────────────────────── WebDAV 连接档案（组件内私库，§W6） ─────────────────────────

/** WebDAV 档案独立键：profiles.ts 的 S3 schema 强制 region/bucket/AK/SK，WebDAV 形状入库即被过滤 */
const WEBDAV_PROFILES_STORAGE_KEY = 'mmagic.profiles.webdav'

/** 连接档案的 WebDAV 分支（§W6）；type 字段为侧栏合并展示/回填的分流依据 */
interface WebDavProfile {
  id: string
  type: 'webdav'
  name: string
  endpoint: string
  username?: string
  password?: string
  /** 会话根路径（未编码原文，client.ts 归一编码）；缺省=端点根 */
  rootPath?: string
  /** §W4 家族开关面：支持 PUT Content-Range 分块续写；缺省 false=整包上传（旧档案无此字段回落 false） */
  chunkedWrite?: boolean
  createdAt: number
}

/** 侧栏合并项：S3 旧档案无 type 视为 s3（§W6） */
type AnyProfile = S3Profile | WebDavProfile

function isWebDavProfile(p: unknown): p is WebDavProfile {
  if (typeof p !== 'object' || p === null) return false
  const v = p as Record<string, unknown>
  return (
    v.type === 'webdav' &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.endpoint === 'string' &&
    typeof v.createdAt === 'number' &&
    (v.username === undefined || typeof v.username === 'string') &&
    (v.password === undefined || typeof v.password === 'string') &&
    (v.rootPath === undefined || typeof v.rootPath === 'string') &&
    (v.chunkedWrite === undefined || typeof v.chunkedWrite === 'boolean')
  )
}

/** 读 WebDAV 档案：静默容错（缺失/坏 JSON/非法条目→按空库/过滤，对齐 profiles.ts 口径） */
function readWebdavProfiles(storage: Storage | null): WebDavProfile[] {
  if (!storage) return []
  try {
    const text = storage.getItem(WEBDAV_PROFILES_STORAGE_KEY)
    if (!text) return []
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isWebDavProfile)
  } catch {
    return []
  }
}

/** 写 WebDAV 档案：静默容错（quota/隐私模式降级为不持久，内存态照常） */
function writeWebdavProfiles(storage: Storage | null, list: WebDavProfile[]): void {
  if (!storage) return
  try {
    storage.setItem(WEBDAV_PROFILES_STORAGE_KEY, JSON.stringify(list))
  } catch {
    // 静默：不持久化不影响本会话内存态
  }
}

/** 生成唯一 id（与 profiles.ts newId 同口径：randomUUID 优先，受限环境回退） */
function newProfileId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // 回退到下方拼装
  }
  return `dav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ───────────────────────── Profile 侧栏 ─────────────────────────

const profiles = ref<S3Profile[]>(listProfiles({ storage: profileStorage() }))
const webdavProfiles = ref<WebDavProfile[]>(readWebdavProfiles(profileStorage()))

/** 合并展示：S3 在前、WebDAV 在后（两库独立键，id 各自全局唯一） */
const mergedProfiles = computed<AnyProfile[]>(() => [...profiles.value, ...webdavProfiles.value])

/** 侧栏 meta：S3 显 bucket；WebDAV 显根路径（空=端点根，退显 endpoint） */
function profileMeta(p: AnyProfile): string {
  return isWebDavProfile(p) ? p.rootPath || p.endpoint : p.bucket
}

/** 选用=按 type 切分支并回填表单进入编辑态（再保存=更新同一份） */
function applyProfile(p: AnyProfile): void {
  clearMessages()
  if (isWebDavProfile(p)) {
    editingId.value = p.id
    editingType.value = 'webdav'
    storageType.value = 'webdav'
    name.value = p.name
    davEndpoint.value = p.endpoint
    davRootPath.value = p.rootPath ?? ''
    davUsername.value = p.username ?? ''
    davPassword.value = p.password ?? ''
    davChunkedWrite.value = p.chunkedWrite === true // 旧档案无此字段 → 回落 false（安全降级）
    return
  }
  editingId.value = p.id
  editingType.value = 's3'
  storageType.value = 's3'
  name.value = p.name
  endpoint.value = p.endpoint
  region.value = p.region
  bucket.value = p.bucket
  accessKeyId.value = p.accessKeyId
  secretAccessKey.value = p.secretAccessKey
  prefix.value = p.prefix ?? ''
  pathStyle.value = p.pathStyle === true
}

function deleteProfile(p: AnyProfile): void {
  if (isWebDavProfile(p)) {
    webdavProfiles.value = webdavProfiles.value.filter((x) => x.id !== p.id)
    writeWebdavProfiles(profileStorage(), webdavProfiles.value)
  } else {
    profiles.value = removeProfile(p.id, { storage: profileStorage() })
  }
  if (editingId.value === p.id) {
    editingId.value = null
    editingType.value = storageType.value
  }
}

// ───────────────────────── 表单状态 ─────────────────────────

/** 存储类型（§W6：S3 ｜ WebDAV，缺省 S3） */
const storageType = ref<'s3' | 'webdav'>('s3')
const name = ref('')
const endpoint = ref('')
const region = ref('')
const bucket = ref('')
const accessKeyId = ref('')
const secretAccessKey = ref('')
const prefix = ref('')
const pathStyle = ref(false)
/** WebDAV 分支字段（rootPath 按未编码原文填写，M1-V1） */
const davEndpoint = ref('')
const davRootPath = ref('')
const davUsername = ref('')
const davPassword = ref('')
/** §W4 家族开关面：分块续写（实验），缺省关=安全降级（不支持续写的服务器走整包上传） */
const davChunkedWrite = ref(false)
/** 会话时长（分钟）；number input 文本态，NaN 由 resolveTtlSeconds 回退缺省档 */
const ttlText = ref<string>(String(DEFAULT_TTL_MINUTES))
const ttlMinutes = computed(() => Number.parseInt(ttlText.value, 10))

/** 编辑态 id+分支：侧栏选用或首次保存后置位；null=新建 */
const editingId = ref<string | null>(null)
const editingType = ref<'s3' | 'webdav'>('s3')

const formErrors = ref<string[]>([])
const testing = ref(false)
const testResult = ref<'ok' | 'fail' | null>(null)
const testError = ref('')
/** 空根警示（仅 WebDAV）：list 2xx 但 0 条目——测试仍算通过（M1-V2 P2-3） */
const emptyRoot = ref(false)
const saveError = ref('')

const typeOptions = computed(() => [
  { label: t('wizard.type-s3'), value: 's3' },
  { label: t('wizard.type-webdav'), value: 'webdav' },
])

/** 弹窗标题随分支切换（S3 保持原 wizard.title 不动） */
const dialogTitle = computed(() => (storageType.value === 'webdav' ? t('wizard.title-webdav') : t('wizard.title')))

function clearMessages(): void {
  formErrors.value = []
  testResult.value = null
  testError.value = ''
  emptyRoot.value = false
  saveError.value = ''
}

/** 表单 → Profile 入参（trim 收口在 createProfile/updateProfile 路径） */
function baseFields() {
  return {
    name: name.value,
    endpoint: endpoint.value,
    region: region.value,
    bucket: bucket.value,
    accessKeyId: accessKeyId.value,
    secretAccessKey: secretAccessKey.value,
    prefix: prefix.value,
    pathStyle: pathStyle.value,
  }
}

/** 表单校验：复用 profiles.schema（补齐 id/createdAt 满足完整 shape；消息即 form-errors 文案） */
function validateForm(): string[] {
  return validateProfile({ ...baseFields(), id: 'form', createdAt: 0 })
}

/**
 * WebDAV 表单校验（§W6）：连接名称/服务器地址必填；endpoint 须为合法 http(s) URL
 * （M2-V1 P2：对齐 profiles.ts validateProfile 对 S3 endpoint 的既有口径——new URL 成功
 * 且 protocol 限 http:/https:，两态共用 endpoint-invalid 文案）；username 与 password
 * 必须成对出现（只填其一=拦截；两者都空=匿名放行——是否 401 由测试连接给出明确文案）。
 */
function validateWebDavForm(): string[] {
  const problems: string[] = []
  if (!name.value.trim()) problems.push(t('wizard.name-required'))
  const trimmedEndpoint = davEndpoint.value.trim()
  if (trimmedEndpoint === '') {
    problems.push(t('wizard.endpoint-required'))
  } else {
    let url: URL
    try {
      url = new URL(trimmedEndpoint)
    } catch {
      return [...problems, t('wizard.endpoint-invalid')] // URL 解析失败先行返回（profiles.ts 同构）
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') problems.push(t('wizard.endpoint-invalid'))
  }
  const hasUsername = davUsername.value.trim() !== ''
  const hasPassword = davPassword.value !== ''
  if (hasUsername !== hasPassword) problems.push(t('wizard.pair-hint'))
  return problems
}

/** 当前分支校验（test/connect/save 三链共用） */
function validateActiveForm(): string[] {
  return storageType.value === 'webdav' ? validateWebDavForm() : validateForm()
}

// ───────────────────────── WebDAV 凭证/档案/配置字段 ─────────────────────────

/**
 * WebDAV 表单 → 客户端/档案共用字段：username 与 password **成对且非空才带**（匿名都不带，
 * 与 client.ts authHeader 半凭证不发 Authorization 的口径一致）；rootPath 非空才带（原文，不预编码）。
 */
function webDavFields(): { name: string } & WebDavBackendConfig {
  const username = davUsername.value.trim()
  const password = davPassword.value
  return {
    name: name.value.trim(),
    endpoint: davEndpoint.value.trim(),
    ...(username !== '' && password !== '' ? { username, password } : {}),
    ...(davRootPath.value.trim() !== '' ? { rootPath: davRootPath.value.trim() } : {}),
  }
}

// ───────────────────────── 测试连接 ─────────────────────────

function testBackend(): BackendConfig {
  return {
    endpoint: endpoint.value.trim(),
    region: region.value.trim(),
    bucket: bucket.value.trim(),
    prefix: prefix.value.trim(),
    credentials: {
      accessKeyId: accessKeyId.value.trim(),
      accessKeySecret: secretAccessKey.value,
      sessionToken: '', // AK/SK 无会话令牌：sigv4 空值不发 security-token 头（见组件头注释）
    },
  }
}

/**
 * WebDAV 测试失败文案（§W6 探测链）：SdkError.detail.status 分流——401→认证失败；
 * 0→网络异常（无法连接）；其它非 2xx→含 status 通用文案；非 SdkError（注入桩原样抛的
 * Error）→透传 message（与 S3 分支口径一致）。
 */
function webdavFailText(err: unknown): string {
  if (err instanceof SdkError) {
    const status = (err.detail as { status?: number } | undefined)?.status
    if (status === 401) return t('wizard.cred-401')
    if (status === 0) return t('wizard.unreachable')
    if (typeof status === 'number') return t('wizard.test-fail-status', { status })
  }
  return err instanceof Error ? err.message : String(err)
}

async function testConnectionWebDav(): Promise<void> {
  testing.value = true
  testResult.value = null
  testError.value = ''
  emptyRoot.value = false
  try {
    const client = newWebDavClient(webDavFields())
    const result = await client.list('') // PROPFIND Depth:1，一次成功即 OK
    emptyRoot.value = result.dirs.length === 0 && result.files.length === 0
    testResult.value = 'ok'
  } catch (err) {
    testResult.value = 'fail'
    testError.value = webdavFailText(err)
  } finally {
    testing.value = false
  }
}

async function testConnection(): Promise<void> {
  if (testing.value) return // 进行中禁重复（与按钮 loading 双保险）
  formErrors.value = validateActiveForm()
  if (formErrors.value.length > 0) return
  if (storageType.value === 'webdav') {
    await testConnectionWebDav()
    return
  }
  testing.value = true
  testResult.value = null
  testError.value = ''
  try {
    const client = newClient(testBackend())
    await client.list(prefix.value.trim(), { delimiter: '/' }) // 一次成功即 OK
    testResult.value = 'ok'
  } catch (err) {
    testResult.value = 'fail'
    testError.value = err instanceof Error ? err.message : String(err)
  } finally {
    testing.value = false
  }
}

// ───────────────────────── 连接 / 保存 ─────────────────────────

/**
 * WebDAV 连接：WorkspaceConfig 信封（mode/v/security 与 S3 同一口径）+ webdav backend
 * `{ type:'webdav', endpoint, username?, password?, rootPath?, chunkedWrite?, ttlSeconds? }`
 * （凭证成对才带；ttlSeconds 沿用现行 ttl 输入逻辑；chunkedWrite §W4 家族开关——**true 才带**，
 * false 缺省=配置最小面，运行时按安全降级整包上传）。走 '#config='+encodeURIComponent →
 * persistRawBackup 原链，凭据不进 URL（自毁线语义=前端主动遗忘，见头注释 SECURITY 注记）。
 */
function connectWebDav(): void {
  const ttlSeconds = resolveTtlSeconds(ttlMinutes.value)
  const fields = webDavFields()
  const backend = {
    type: 'webdav' as const,
    endpoint: fields.endpoint,
    ...(fields.username !== undefined ? { username: fields.username, password: fields.password } : {}),
    ...(fields.rootPath !== undefined ? { rootPath: fields.rootPath } : {}),
    ...(davChunkedWrite.value ? { chunkedWrite: true } : {}),
    ttlSeconds,
  }
  const config = {
    mode: 'workspace' as const,
    v: CONFIG_VERSION,
    backend,
    security: { allowedOrigins: [window.location.origin] },
  }
  // #config 原始片段（encodeURIComponent 与宿主拼装口径一致）。只写 sessionStorage 备份、
  // 不写 URL：凭据不进地址栏/历史/Referer，reload 后由 boot 原链重建。
  persistRawBackup('#config=' + encodeURIComponent(JSON.stringify(config)), ttlSeconds)
  reloadPage()
}

function connect(): void {
  formErrors.value = validateActiveForm()
  if (formErrors.value.length > 0) return
  if (storageType.value === 'webdav') {
    connectWebDav()
    return
  }
  const ttlSeconds = resolveTtlSeconds(ttlMinutes.value)
  const config = buildWorkspaceConfig(createProfile(baseFields()), {
    origin: window.location.origin,
    ttlMinutes: ttlMinutes.value,
  })
  // #config 原始片段（encodeURIComponent 与宿主拼装口径一致，见《docs/operations/user-guide.md》§一第 3 步）。
  // 只写 sessionStorage 备份、不写 URL：凭据不进地址栏/历史/Referer，reload 后由 boot 原链重建。
  persistRawBackup('#config=' + encodeURIComponent(JSON.stringify(config)), ttlSeconds)
  reloadPage()
}

/** WebDAV 档案落盘（编辑态=原地更新；新建受 PROFILES_MAX 上限，与 S3 库同档） */
function saveWebDavCurrent(): void {
  if (editingType.value === 'webdav' && editingId.value !== null) {
    const target = webdavProfiles.value.find((p) => p.id === editingId.value)
    if (target) {
      const fields = webDavFields()
      const updated: WebDavProfile = {
        id: target.id,
        type: 'webdav',
        createdAt: target.createdAt,
        name: fields.name,
        endpoint: fields.endpoint,
        ...(fields.username !== undefined ? { username: fields.username, password: fields.password } : {}),
        ...(fields.rootPath !== undefined ? { rootPath: fields.rootPath } : {}),
        ...(davChunkedWrite.value ? { chunkedWrite: true } : {}), // true 才带（缺省=最小面）
      }
      webdavProfiles.value = webdavProfiles.value.map((p) => (p.id === target.id ? updated : p))
      writeWebdavProfiles(profileStorage(), webdavProfiles.value)
      return
    }
    // 档案已被侧栏删除：落入下方新建分支
  }
  if (webdavProfiles.value.length >= PROFILES_MAX) {
    saveError.value = t('wizard.profiles-full', { n: PROFILES_MAX })
    return
  }
  const fields = webDavFields()
  const profile: WebDavProfile = {
    id: newProfileId(),
    type: 'webdav',
    createdAt: Date.now(),
    name: fields.name,
    endpoint: fields.endpoint,
    ...(fields.username !== undefined ? { username: fields.username, password: fields.password } : {}),
    ...(fields.rootPath !== undefined ? { rootPath: fields.rootPath } : {}),
    ...(davChunkedWrite.value ? { chunkedWrite: true } : {}), // true 才带（缺省=最小面）
  }
  const next = [...webdavProfiles.value, profile]
  webdavProfiles.value = next
  writeWebdavProfiles(profileStorage(), next)
  editingId.value = profile.id // 转编辑态：再保存=更新，避免侧栏重复
  editingType.value = 'webdav'
}

function saveCurrent(): void {
  saveError.value = ''
  formErrors.value = validateActiveForm()
  if (formErrors.value.length > 0) return
  if (storageType.value === 'webdav') {
    saveWebDavCurrent()
    return
  }
  try {
    if (editingId.value !== null && editingType.value === 's3') {
      const next = updateProfile(editingId.value, baseFields(), { storage: profileStorage() })
      profiles.value = next ?? listProfiles({ storage: profileStorage() })
    } else {
      const profile = createProfile(baseFields())
      profiles.value = saveProfile(profile, { storage: profileStorage() })
      editingId.value = profile.id // 转编辑态：再保存=更新，避免侧栏重复
      editingType.value = 's3'
    }
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <FcDialog
    v-model:open="dialogOpen"
    :title="dialogTitle"
    :width="760"
    :close-on-click-modal="false"
  >
    <p class="cw-subtitle">{{ t('wizard.subtitle') }}</p>
    <div class="cw-layout">
      <!-- 左：已存配置侧栏（localStorage 明文库，风险见常驻警示） -->
      <aside class="cw-side">
        <h4 class="cw-side__title">{{ t('wizard.profiles') }}</h4>
        <ul class="cw-side__list" data-testid="profile-list">
          <li
            v-for="p in mergedProfiles"
            :key="p.id"
            class="cw-side__item"
            data-testid="profile-item"
            @click="applyProfile(p)"
          >
            <span class="cw-side__name">{{ p.name }}</span>
            <span class="cw-side__meta">{{ profileMeta(p) }}</span>
            <FcButton
              variant="text"
              size="sm"
              data-testid="profile-delete"
              @click.stop="deleteProfile(p)"
            >
              {{ t('wizard.delete') }}
            </FcButton>
          </li>
        </ul>
        <p v-if="mergedProfiles.length === 0" class="cw-side__empty" data-testid="profile-empty">—</p>
      </aside>

      <!-- 右：连接表单（顶部存储类型分段，§W6） -->
      <section class="cw-main">
        <el-form class="cw-form" label-position="top" @submit.prevent>
          <el-form-item class="fc-form-item" :label="t('wizard.type')">
            <FcSegmented
              v-model="storageType"
              :options="typeOptions"
              size="sm"
              data-testid="f-type"
              @change="clearMessages"
            />
          </el-form-item>
          <el-form-item class="fc-form-item" :label="t('wizard.name')">
            <el-input v-model="name" class="fc-input" data-testid="f-name" />
          </el-form-item>

          <!-- S3 分支（既有字段与行为零改动） -->
          <template v-if="storageType === 's3'">
            <div class="cw-grid">
              <el-form-item class="fc-form-item" :label="t('wizard.endpoint')">
                <el-input
                  v-model="endpoint"
                  class="fc-input"
                  data-testid="f-endpoint"
                  placeholder="https://s3.example.com"
                />
              </el-form-item>
              <el-form-item class="fc-form-item" :label="t('wizard.region')">
                <el-input v-model="region" class="fc-input" data-testid="f-region" />
              </el-form-item>
            </div>
            <el-form-item class="fc-form-item" :label="t('wizard.bucket')">
              <el-input v-model="bucket" class="fc-input" data-testid="f-bucket" />
            </el-form-item>
            <el-form-item class="fc-form-item" :label="t('wizard.access-key')">
              <el-input v-model="accessKeyId" class="fc-input" data-testid="f-access-key" show-password />
            </el-form-item>
            <el-form-item class="fc-form-item" :label="t('wizard.secret-key')">
              <el-input
                v-model="secretAccessKey"
                class="fc-input"
                data-testid="f-secret-key"
                type="password"
                show-password
              />
            </el-form-item>
            <div class="cw-grid">
              <el-form-item class="fc-form-item" :label="t('wizard.prefix')">
                <el-input v-model="prefix" class="fc-input" data-testid="f-prefix" placeholder="docs/" />
              </el-form-item>
              <el-form-item class="fc-form-item" :label="t('wizard.ttl')">
                <el-input v-model="ttlText" class="fc-input" data-testid="f-ttl" type="number" :min="1" />
              </el-form-item>
            </div>
            <el-form-item class="fc-form-item" data-testid="f-path-style" :label="t('wizard.path-style')">
              <FcSwitch v-model="pathStyle" />
            </el-form-item>
          </template>

          <!-- WebDAV 分支（§W6：endpoint/rootPath/用户名/密码；rootPath 按未编码原文填写） -->
          <template v-else>
            <el-form-item class="fc-form-item" :label="t('wizard.endpoint')">
              <el-input
                v-model="davEndpoint"
                class="fc-input"
                data-testid="f-endpoint"
                placeholder="https://host/dav"
              />
            </el-form-item>
            <el-form-item class="fc-form-item" :label="t('wizard.root-path')">
              <el-input
                v-model="davRootPath"
                class="fc-input"
                data-testid="f-root-path"
                :placeholder="t('wizard.root-path-hint')"
              />
            </el-form-item>
            <div class="cw-grid">
              <el-form-item class="fc-form-item" :label="t('wizard.username')">
                <el-input v-model="davUsername" class="fc-input" data-testid="f-username" />
              </el-form-item>
              <el-form-item class="fc-form-item" :label="t('wizard.password')">
                <el-input
                  v-model="davPassword"
                  class="fc-input"
                  data-testid="f-password"
                  type="password"
                  show-password
                />
              </el-form-item>
            </div>
            <el-form-item class="fc-form-item" :label="t('wizard.ttl')">
              <el-input v-model="ttlText" class="fc-input" data-testid="f-ttl" type="number" :min="1" />
            </el-form-item>
            <!-- §W4 家族开关面：缺省关=安全降级（整包上传）；仅 WebDAV 分支可见，S3 分支零改动 -->
            <el-form-item class="fc-form-item" data-testid="f-chunked-write" :label="t('wizard.chunked-write')">
              <FcSwitch v-model="davChunkedWrite" />
            </el-form-item>
            <p class="cw-field-hint" data-testid="chunked-write-hint">{{ t('wizard.chunked-write-hint') }}</p>
          </template>
        </el-form>

        <el-alert
          v-if="formErrors.length > 0"
          type="error"
          :title="formErrors.join('；')"
          :closable="false"
          class="cw-alert"
          data-testid="form-errors"
        />
        <el-alert
          v-if="saveError"
          type="error"
          :title="saveError"
          :closable="false"
          class="cw-alert"
          data-testid="save-error"
        />

        <div class="cw-actions">
          <FcButton variant="secondary" :loading="testing" data-testid="btn-test" @click="testConnection">
            {{ testing ? t('wizard.testing') : t('wizard.test-conn') }}
          </FcButton>
          <FcButton variant="primary" data-testid="btn-connect" @click="connect">
            {{ t('wizard.connect') }}
          </FcButton>
          <FcButton variant="text" data-testid="btn-save" @click="saveCurrent">
            {{ t('wizard.save') }}
          </FcButton>
        </div>

        <el-alert
          v-if="testResult === 'ok'"
          type="success"
          :title="t('wizard.test-ok')"
          :closable="false"
          class="cw-alert"
          data-testid="test-ok"
        />
        <!-- 空根警示（仅 WebDAV）：200 但 0 条目，测试仍算通过（M1-V2 P2-3） -->
        <el-alert
          v-if="testResult === 'ok' && emptyRoot"
          type="warning"
          :title="t('wizard.test-empty-root')"
          :closable="false"
          class="cw-alert"
          data-testid="test-empty-root"
        />
        <el-alert
          v-if="testResult === 'fail' && storageType === 's3'"
          type="error"
          :title="`${t('wizard.test-fail')}：${testError}`"
          :closable="false"
          class="cw-alert"
          data-testid="test-fail"
        />
        <el-alert
          v-else-if="testResult === 'fail'"
          type="error"
          :title="testError"
          :closable="false"
          class="cw-alert"
          data-testid="test-fail-webdav"
        />
        <!-- 常驻警示：明文存储风险定位（个人设备；企业嵌入走宿主 #config 注入，不走此路径） -->
        <el-alert
          type="warning"
          :title="t('wizard.plaintext-warn')"
          :closable="false"
          class="cw-alert"
          data-testid="plaintext-warn"
        />
      </section>
    </div>
  </FcDialog>
</template>

<style lang="scss" scoped>
/* 仅布局/字号（SDK 纪律：颜色/圆角/阴影走 token，不硬编码） */
.cw-subtitle {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--app-text-secondary, inherit);
}

.cw-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.cw-side {
  flex: 0 0 200px;
  min-width: 0;
}

.cw-side__title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.cw-side__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cw-side__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
}

.cw-side__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.cw-side__meta {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-text-secondary, inherit);
}

.cw-side__empty {
  margin: 0;
  font-size: 12px;
  color: var(--app-text-secondary, inherit);
}

.cw-main {
  flex: 1;
  min-width: 0;
}

.cw-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.cw-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 12px;
}

.cw-alert {
  margin-top: 8px;
}

/* 开关下沿说明小字（§W4 分块续写 hint；仅字号/间距，颜色走 token） */
.cw-field-hint {
  margin: -10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--app-text-secondary, inherit);
}
</style>
