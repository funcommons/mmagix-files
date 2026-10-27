<script setup lang="ts">
/**
 * ConnectWizard — 本地连接模式 · S3 连接向导（Lane G5）。
 * 契约：PROGRESS.md Wave G / G5；文案全部走预置的 wizard.* 词典键（禁改 locales）。
 *
 * 结构：FcDialog（el-dialog 封装，SDK 强制规则）双栏——左 Profile 侧栏（列出/选用/删除，
 * 数据在 profiles.ts 的 localStorage 明文库，风险见 profiles.ts 头注释），右连接表单。
 *
 * 三条动作链：
 * - 测试连接：临时 new S3SigV4Client(表单真实凭据) → list(prefix,{delimiter:'/'}) 一次成功即 OK；
 *   凭据用空 sessionToken（sigv4 对空不发 x-amz-security-token，与 AK/SK 长期凭证语义一致）；
 *   testing 期间按钮 loading + 函数早退双保险禁重复。
 * - 连接：buildWorkspaceConfig（v:1/mode:workspace/ttlSeconds 截 86400）→ JSON →
 *   '#config='+encodeURIComponent → persistRawConfig 写 sessionStorage 备份 → reload。
 *   凭据**不写 URL/历史**——scrubFragment 已抹掉 fragment，reload 后 boot 的
 *   restoreRawConfig→parseAppConfig 原链重建，这是选 sessionStorage 备份路径的核心理由。
 * - 保存配置：saveProfile/updateProfile 落 localStorage（明文，常驻警示条 wizard.plaintext-warn）。
 *
 * 测试接缝（props 注入，生产用真实现）：storageFactory（profiles 与 raw 备份统一改走注入产物）、
 * reload（默认 location.reload）、clientFactory（默认 new S3SigV4Client）。
 * 挂载入口由主线收口（本组件不碰 Home.vue/boot.ts/main.ts）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcDialog, FcSwitch } from '@/components/sdk'
import { S3SigV4Client } from '@/sdk/s3/client'
import { persistRawConfig } from '@/sdk/config'
import {
  DEFAULT_TTL_MINUTES,
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

// ───────────────────────── Profile 侧栏 ─────────────────────────

const profiles = ref<S3Profile[]>(listProfiles({ storage: profileStorage() }))

/** 选用=回填表单并进入编辑态（再保存=更新同一份） */
function applyProfile(p: S3Profile): void {
  editingId.value = p.id
  name.value = p.name
  endpoint.value = p.endpoint
  region.value = p.region
  bucket.value = p.bucket
  accessKeyId.value = p.accessKeyId
  secretAccessKey.value = p.secretAccessKey
  prefix.value = p.prefix ?? ''
  pathStyle.value = p.pathStyle === true
  clearMessages()
}

function deleteProfile(id: string): void {
  profiles.value = removeProfile(id, { storage: profileStorage() })
  if (editingId.value === id) editingId.value = null
}

// ───────────────────────── 表单状态 ─────────────────────────

const name = ref('')
const endpoint = ref('')
const region = ref('')
const bucket = ref('')
const accessKeyId = ref('')
const secretAccessKey = ref('')
const prefix = ref('')
const pathStyle = ref(false)
/** 会话时长（分钟）；number input 文本态，NaN 由 resolveTtlSeconds 回退缺省档 */
const ttlText = ref<string>(String(DEFAULT_TTL_MINUTES))
const ttlMinutes = computed(() => Number.parseInt(ttlText.value, 10))

/** 编辑态 id：侧栏选用或首次保存后置位；null=新建 */
const editingId = ref<string | null>(null)

const formErrors = ref<string[]>([])
const testing = ref(false)
const testResult = ref<'ok' | 'fail' | null>(null)
const testError = ref('')
const saveError = ref('')

function clearMessages(): void {
  formErrors.value = []
  testResult.value = null
  testError.value = ''
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

async function testConnection(): Promise<void> {
  if (testing.value) return // 进行中禁重复（与按钮 loading 双保险）
  formErrors.value = validateForm()
  if (formErrors.value.length > 0) return
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

function connect(): void {
  formErrors.value = validateForm()
  if (formErrors.value.length > 0) return
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

function saveCurrent(): void {
  saveError.value = ''
  formErrors.value = validateForm()
  if (formErrors.value.length > 0) return
  try {
    if (editingId.value !== null) {
      const next = updateProfile(editingId.value, baseFields(), { storage: profileStorage() })
      profiles.value = next ?? listProfiles({ storage: profileStorage() })
    } else {
      const profile = createProfile(baseFields())
      profiles.value = saveProfile(profile, { storage: profileStorage() })
      editingId.value = profile.id // 转编辑态：再保存=更新，避免侧栏重复
    }
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <FcDialog
    v-model:open="dialogOpen"
    :title="t('wizard.title')"
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
            v-for="p in profiles"
            :key="p.id"
            class="cw-side__item"
            data-testid="profile-item"
            @click="applyProfile(p)"
          >
            <span class="cw-side__name">{{ p.name }}</span>
            <span class="cw-side__meta">{{ p.bucket }}</span>
            <FcButton
              variant="text"
              size="sm"
              data-testid="profile-delete"
              @click.stop="deleteProfile(p.id)"
            >
              {{ t('wizard.delete') }}
            </FcButton>
          </li>
        </ul>
        <p v-if="profiles.length === 0" class="cw-side__empty" data-testid="profile-empty">—</p>
      </aside>

      <!-- 右：连接表单 -->
      <section class="cw-main">
        <el-form class="cw-form" label-position="top" @submit.prevent>
          <el-form-item class="fc-form-item" :label="t('wizard.name')">
            <el-input v-model="name" class="fc-input" data-testid="f-name" />
          </el-form-item>
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
        <el-alert
          v-if="testResult === 'fail'"
          type="error"
          :title="`${t('wizard.test-fail')}：${testError}`"
          :closable="false"
          class="cw-alert"
          data-testid="test-fail"
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
</style>
