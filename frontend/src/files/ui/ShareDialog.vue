<script setup lang="ts">
defineOptions({ name: 'ShareDialog' })
/**
 * ShareDialog — 预签名分享链接生成器（Lane H-2）。
 *
 * 数据流：client 可选能力 getPresignedUrl / presignPutUrl（SigV4 查询串预签名，
 * 纯本地签名零网络）；缺任一能力 → 禁用态（有效期与生成钮不可用，仅标题+条目可见）。
 *
 * 交互口径：
 *  - 有效期三档 1h / 24h（=1d）/ 7d（AWS 预签名硬上限恰为 7 天，顶格）；
 *  - 生成 → GET/PUT 两行只读输入 + 复制钮（clipboard.writeText 优先，失败降级
 *    document.execCommand('copy')——该 API 已废弃，仅作非安全上下文/旧内核兜底）；
 *  - 目录条目不给分享（前缀分享列 P2）→ 禁用态；
 *  - 换有效期/换条目 → 清空已生成链接（防误分享旧口径链接）。
 *
 * 增强面（M5-UI-b，契约 documents/v1.2.0执行进度.md §UI 波次契约）：createShare /
 * listShares / revokeShare 三 IO 回调皆可选——注入才启用对应区块；三回调全缺省时
 * 增强面整体不渲染（密码框/重掷/自定义档/管理区均不出现，有效期仍三档），既有行为
 * 零回归（向后兼容红线）。注入后：
 *  - 密码开关默认开 + randomPassword()（share-crypto 无歧义字符集 6 位）+ 重掷钮；
 *    关开关 = 无有效密码 → 生成禁用（v1 封装分享必须带密码，seal 链拒绝空密码）；
 *  - 有效期第四档「自定义日期」：选中日整天有效（次日零点到期），>7 天（AWS 预签名
 *    同款硬上限）或过去日 → 生成钮禁用 + 内联提示（超标禁用为最简口径）；
 *  - 生成（增强支）→ createShare({key,name,size,password,ttlMs}) 精确五键，resolve →
 *    结果区链接+密码同框、各带复制钮；reject → 内联错误文本（share-error）；生成中防重入；
 *  - 管理区懒加载：首次展开才调 listShares；行=目标 key+到期时间+复制（shareId）+撤销；
 *    撤销 revokeShare(shareId) 成功后本地移除该行，失败 toast 且行不动。
 *
 * UI 口径：v-model:open 与 SearchDialog 同款——open prop 必须显式缺省 true
 * （Boolean 型 prop 缺省会被 Vue 铸成 false，「缺省即开」不成立）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcDialog, toast } from '@/components/sdk'
import type { S3Client, S3ObjectSummary } from '@/sdk/types'
import { randomPassword } from '../share-crypto'

/** 分享管理行（契约 M5-UI-b 五字段；expiresAt/createdAt 为 ms 时间戳） */
export interface ShareRow {
  shareId: string
  key: string
  name: string
  createdAt: number
  expiresAt: number
}

const props = withDefaults(
  defineProps<{
    client: S3Client
    /** 分享目标（null=无目标：空壳禁用态，仅标题可见） */
    entry?: S3ObjectSummary | null
    /** 弹窗显隐（v-model:open）；显式缺省 true（Boolean 缺省坑，见文件头注） */
    open?: boolean
    /** 注入则启用增强面：创建封装分享（密码 seal 由回调层收口，组件只传五键） */
    createShare?: (input: {
      key: string
      name: string
      size: number
      password: string
      ttlMs: number
    }) => Promise<{ shareId: string; url: string }>
    /** 注入则启用管理区（懒加载：首次展开调用） */
    listShares?: () => Promise<ShareRow[]>
    /** 撤销单条分享；成功后组件本地移除该行 */
    revokeShare?: (shareId: string) => Promise<void>
  }>(),
  { entry: null, open: true },
)

const emit = defineEmits<{
  'update:open': [open: boolean]
}>()

const { t } = useI18n()

// ── 能力/条目门控 ──

const hasPresign = computed(
  () => typeof props.client.getPresignedUrl === 'function' && typeof props.client.presignPutUrl === 'function',
)
/** 可分享 = 客户端有双预签名能力 + 目标为文件（目录→前缀分享列 P2，简化不给分享） */
const canShare = computed(() => hasPresign.value && props.entry !== null && !props.entry.isDir)

// ── 有效期 ──

interface ExpiryOption {
  sec: number
  label: string
}
const EXPIRY_OPTIONS: ExpiryOption[] = [
  { sec: 3600, label: t('share.expiry-h', { n: 1 }) },
  { sec: 86_400, label: t('share.expiry-d', { n: 1 }) },
  { sec: 604_800, label: t('share.expiry-d', { n: 7 }) },
]
const expirySec = ref(EXPIRY_OPTIONS[0]!.sec)

// ── 增强面启用门（向后兼容红线：三回调全缺省 → 整个增强面不渲染） ──

/** 注入 createShare → 密码开关 + 自定义档 + 生成增强支启用 */
const enhanced = computed(() => typeof props.createShare === 'function')
/** 注入 listShares/revokeShare 任一 → 管理区启用 */
const hasManage = computed(
  () => typeof props.listShares === 'function' || typeof props.revokeShare === 'function',
)

// ── 密码（增强面）：默认开 + 无歧义随机 6 位 + 重掷 ──

const pwdOn = ref(true)
const password = ref(props.createShare ? randomPassword() : '')

function reroll(): void {
  password.value = randomPassword()
}

// ── 有效期第四档（增强面）：自定义日期，选中日整天有效（次日零点到期） ──

/** 自定义档在 radio 组的哨兵值（0 不是任何预设秒数，避免与三档混淆） */
const CUSTOM_SEC = 0
const DAY_MS = 86_400_000
/** 7 天 = AWS 预签名硬上限（与第三档顶格对齐），超标禁用生成 */
const MAX_TTL_MS = 604_800_000

/** 自定义到期毫秒（已按选中日算好）；null=未选/日期非法 */
const customTtlMs = ref<number | null>(null)

const customActive = computed(() => enhanced.value && expirySec.value === CUSTOM_SEC)
const customValid = computed(
  () => customTtlMs.value !== null && customTtlMs.value > 0 && customTtlMs.value <= MAX_TTL_MS,
)

function onCustomDate(e: Event): void {
  const v = (e.target as HTMLInputElement).value // native date input 恒 yyyy-mm-dd
  if (!v) {
    customTtlMs.value = null
    return
  }
  const [y, m, d] = v.split('-').map(Number)
  if (!y || !m || !d) {
    customTtlMs.value = null
    return
  }
  // 本地时区次日零点为到期点（选中的那一天整天有效）；过去日算出负 TTL → customValid 拦
  customTtlMs.value = new Date(y, m - 1, d).getTime() + DAY_MS - Date.now()
}

/** 实际生效 TTL：自定义档取 customTtlMs（无效为 null），预设档秒转毫秒 */
const effectiveTtlMs = computed<number | null>(() =>
  customActive.value ? (customValid.value ? customTtlMs.value : null) : expirySec.value * 1000,
)

// ── 生成 ──

const getUrl = ref('')
const putUrl = ref('')
const creating = ref(false)
const createError = ref('')
const shareResult = ref<{ shareId: string; url: string; password: string } | null>(null)

/** 生成可用性：既有面只看 canShare；增强面还需密码开关开 + 密码非空 + TTL 有效 */
const generateReady = computed(
  () => !enhanced.value || (pwdOn.value && password.value.length > 0 && effectiveTtlMs.value !== null),
)

async function generate(): Promise<void> {
  const entry = props.entry
  if (!canShare.value || !entry) return
  const create = props.createShare
  if (create) {
    if (!generateReady.value || creating.value) return
    creating.value = true
    createError.value = ''
    try {
      // 契约五键精确透传（key/name/size/password/ttlMs），零二次加工
      const res = await create({
        key: entry.key,
        name: entry.name,
        size: entry.size,
        password: password.value,
        ttlMs: effectiveTtlMs.value!,
      })
      shareResult.value = { shareId: res.shareId, url: res.url, password: password.value }
    } catch {
      createError.value = t('share.create-failed')
    } finally {
      creating.value = false
    }
    return
  }
  // 查询串 SigV4 纯本地签名（零网络）；有效期上限钳制在 client 侧（对齐会话 TTL 语义）
  getUrl.value = props.client.getPresignedUrl!(entry.key, expirySec.value)
  putUrl.value = props.client.presignPutUrl!(entry.key, expirySec.value)
}

/** 换有效期 → 已生成链接口径已变，清空防误分享（增强面结果/错误同口径） */
watch(expirySec, () => {
  getUrl.value = ''
  putUrl.value = ''
  shareResult.value = null
  createError.value = ''
})
/** 换条目 → 清空（防上个文件的链接串显） */
watch(
  () => props.entry?.key,
  () => {
    getUrl.value = ''
    putUrl.value = ''
    shareResult.value = null
    createError.value = ''
  },
)

// ── 复制（clipboard API 优先，失败/缺失降级 execCommand） ──

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限拒绝 / 非安全上下文异常 → 走降级
  }
  // 降级：document.execCommand('copy') 已废弃，但在无 Clipboard API 的环境仍是唯一可用面
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

async function onCopy(text: string): Promise<void> {
  if (await copyText(text)) toast.success(t('share.copied'))
  // 复制失败（无剪贴板能力且降级失败）静默：词典无失败文案键，不生造
}

// ── 管理区（增强面）：折叠懒加载 + 行内撤销/复制 ──

const manageOpen = ref(false)
const manageLoaded = ref(false)
const manageLoading = ref(false)
const manageError = ref('')
const shares = ref<ShareRow[]>([])

/** 首次展开才拉列表（懒加载）；此后复用已载数据 */
async function toggleManage(): Promise<void> {
  manageOpen.value = !manageOpen.value
  if (manageOpen.value && !manageLoaded.value) await refreshShares()
}

async function refreshShares(): Promise<void> {
  if (!props.listShares) return
  manageLoading.value = true
  manageError.value = ''
  try {
    shares.value = await props.listShares()
    manageLoaded.value = true
  } catch {
    manageError.value = t('share.load-failed')
  } finally {
    manageLoading.value = false
  }
}

/** 撤销：revokeShare(shareId) 成功 → 本地移除该行（不重拉）；失败 → toast 且行不动 */
async function onRevoke(row: ShareRow): Promise<void> {
  if (!props.revokeShare) return
  try {
    await props.revokeShare(row.shareId)
    shares.value = shares.value.filter((s) => s.shareId !== row.shareId)
  } catch {
    toast.error(t('share.revoke-failed'))
  }
}

/** 到期时刻本地时区格式化（恒 4 位年份，管理行展示口径） */
function fmtExpiry(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function onVisibleChange(visible: boolean): void {
  emit('update:open', visible)
}
</script>

<template>
  <FcDialog
    dialog-class="share-dialog"
    :open="open"
    :title="t('share.title')"
    :width="640"
    @update:open="onVisibleChange"
  >
    <div v-if="entry" class="share-dialog__body" data-testid="share-dialog">
      <p class="share-dialog__entry">
        <i :class="entry.isDir ? 'ri-folder-line' : 'ri-file-line'" class="share-dialog__entry-icon" />
        <span class="share-dialog__entry-name" :title="entry.key">{{ entry.name }}</span>
      </p>

      <!-- 增强面：密码保护（注入 createShare 才渲染） -->
      <div v-if="enhanced" class="share-dialog__pwd">
        <label class="share-dialog__switch">
          <input v-model="pwdOn" type="checkbox" data-testid="share-password-switch">
          {{ t('share.pwd-switch') }}
        </label>
        <div v-if="pwdOn" class="share-dialog__row">
          <span class="share-dialog__label">{{ t('share.pwd') }}</span>
          <input
            v-model="password"
            class="share-dialog__url"
            type="text"
            data-testid="share-password"
          >
          <FcButton variant="secondary" size="sm" data-testid="share-reroll" @click="reroll">
            {{ t('share.reroll') }}
          </FcButton>
        </div>
      </div>

      <div class="share-dialog__expiry">
        <span class="share-dialog__label">{{ t('share.expiry') }}</span>
        <label v-for="opt in EXPIRY_OPTIONS" :key="opt.sec" class="share-dialog__opt">
          <input
            v-model="expirySec"
            type="radio"
            name="share-expiry"
            :value="opt.sec"
            :disabled="!canShare"
          >
          {{ opt.label }}
        </label>
        <!-- 增强面第四档：自定义日期 -->
        <label v-if="enhanced" class="share-dialog__opt">
          <input
            v-model="expirySec"
            type="radio"
            name="share-expiry"
            :value="CUSTOM_SEC"
            :disabled="!canShare"
          >
          {{ t('share.expiry-custom') }}
        </label>
        <input
          v-if="customActive"
          class="share-dialog__date"
          type="date"
          @change="onCustomDate"
        >
      </div>
      <p v-if="customActive && !customValid" class="share-dialog__hint">
        {{ t('share.expiry-custom-limit') }}
      </p>

      <div class="share-dialog__actions">
        <FcButton
          variant="primary"
          size="sm"
          :disabled="!canShare || !generateReady || creating"
          data-testid="share-generate"
          @click="generate"
        >
          {{ t('share.generate') }}
        </FcButton>
      </div>

      <div v-if="getUrl" class="share-dialog__row">
        <span class="share-dialog__label share-dialog__label--url">{{ t('share.get-url') }}</span>
        <input
          class="share-dialog__url"
          type="text"
          readonly
          :value="getUrl"
          data-testid="share-get-url"
        >
        <FcButton variant="secondary" size="sm" data-testid="share-copy-get" @click="onCopy(getUrl)">
          {{ t('share.copy') }}
        </FcButton>
      </div>
      <div v-if="putUrl" class="share-dialog__row">
        <span class="share-dialog__label share-dialog__label--url">{{ t('share.put-url') }}</span>
        <input
          class="share-dialog__url"
          type="text"
          readonly
          :value="putUrl"
          data-testid="share-put-url"
        >
        <FcButton variant="secondary" size="sm" data-testid="share-copy-put" @click="onCopy(putUrl)">
          {{ t('share.copy') }}
        </FcButton>
      </div>

      <!-- 增强面：生成结果（链接+密码同框，各带复制钮） -->
      <div v-if="shareResult" class="share-dialog__result" data-testid="share-result">
        <div class="share-dialog__row">
          <span class="share-dialog__label share-dialog__label--url">{{ t('share.link') }}</span>
          <input
            class="share-dialog__url"
            type="text"
            readonly
            :value="shareResult.url"
            data-testid="share-result-url"
          >
          <FcButton variant="secondary" size="sm" data-testid="share-copy-url" @click="onCopy(shareResult.url)">
            {{ t('share.copy') }}
          </FcButton>
        </div>
        <div class="share-dialog__row">
          <span class="share-dialog__label share-dialog__label--url">{{ t('share.pwd') }}</span>
          <input
            class="share-dialog__url"
            type="text"
            readonly
            :value="shareResult.password"
            data-testid="share-result-password"
          >
          <FcButton variant="secondary" size="sm" data-testid="share-copy-password" @click="onCopy(shareResult.password)">
            {{ t('share.copy') }}
          </FcButton>
        </div>
      </div>
      <p v-if="createError" class="share-dialog__error" data-testid="share-error">
        {{ createError }}
      </p>

      <!-- 增强面：分享管理（注入 listShares/revokeShare 才渲染；懒加载） -->
      <div v-if="hasManage" class="share-dialog__manage" data-testid="share-manage">
        <div class="share-dialog__manage-head">
          <span class="share-dialog__label">{{ t('share.manage') }}</span>
          <FcButton variant="secondary" size="sm" data-testid="share-manage-toggle" @click="toggleManage">
            {{ t('share.manage') }}
          </FcButton>
        </div>
        <template v-if="manageOpen">
          <p v-if="manageLoading" class="share-dialog__hint">{{ t('share.loading') }}</p>
          <p v-else-if="manageError" class="share-dialog__error">{{ manageError }}</p>
          <p v-else-if="shares.length === 0" class="share-dialog__hint">{{ t('share.manage-empty') }}</p>
          <ul v-else class="share-dialog__shares">
            <li v-for="row in shares" :key="row.shareId" class="share-dialog__share" data-testid="share-row">
              <span class="share-dialog__share-key" :title="row.key">{{ row.key }}</span>
              <span class="share-dialog__share-exp">{{ t('share.expires-at') }} {{ fmtExpiry(row.expiresAt) }}</span>
              <FcButton variant="secondary" size="sm" @click="onCopy(row.shareId)">
                {{ t('share.copy') }}
              </FcButton>
              <FcButton variant="secondary" size="sm" data-testid="share-revoke" @click="onRevoke(row)">
                {{ t('share.revoke') }}
              </FcButton>
            </li>
          </ul>
        </template>
      </div>
    </div>
  </FcDialog>
</template>

<style lang="scss" scoped>
/* el-dialog teleport 到 body 后 scoped 对弹窗外壳失效，但默认槽内容在本组件作用域编译，样式可用 */
.share-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--app-text-secondary);
}

.share-dialog__entry {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  color: var(--app-text-primary);
}

.share-dialog__entry-icon {
  font-size: 16px;
  color: var(--app-text-tertiary);
}

.share-dialog__entry-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 600;
}

.share-dialog__label {
  font-size: 12px;
  color: var(--app-text-tertiary);
  white-space: nowrap;
}

.share-dialog__expiry {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.share-dialog__opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  cursor: pointer;

  input:disabled {
    cursor: not-allowed;
  }
}

.share-dialog__pwd {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.share-dialog__switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  cursor: pointer;
}

.share-dialog__date {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--app-section-border-color, var(--el-border-color));
  border-radius: var(--app-radius-sm, 6px);
  background: var(--app-bg-muted, rgba(0, 0, 0, 0.02));
  color: var(--app-text-secondary);
  font-size: 12px;
}

.share-dialog__hint {
  margin: 0;
  font-size: 12px;
  color: var(--el-color-warning);
}

.share-dialog__error {
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger);
}

.share-dialog__result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.share-dialog__manage {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--app-section-border-color, var(--el-border-color-lighter));
}

.share-dialog__manage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.share-dialog__shares {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.share-dialog__share {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.share-dialog__share-key {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--app-text-primary);
}

.share-dialog__share-exp {
  white-space: nowrap;
  color: var(--app-text-tertiary);
}

.share-dialog__actions {
  display: flex;
}

.share-dialog__row {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.share-dialog__url {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--app-section-border-color, var(--el-border-color));
  border-radius: var(--app-radius-sm, 6px);
  background: var(--app-bg-muted, rgba(0, 0, 0, 0.02));
  color: var(--app-text-secondary);
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;

  &:focus {
    outline: none;
    border-color: var(--el-color-primary);
  }
}
</style>
