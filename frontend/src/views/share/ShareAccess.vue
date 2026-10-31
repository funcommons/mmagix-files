<script setup lang="ts">
/**
 * ShareAccess — 分享校验页（v1.2.0 M5-UI-a，契约：docs/design/capabilities-contract-v1.2.0.md §「UI 波次契约」）。
 * 公开路由 /s/:shareId 的访客页，IO 全部回调注入（fetchMeta / openSecret），本组件不直接触网。
 *
 * 状态机：loading →（meta null=已取消态 | isShareExpired=到期态 | 有效→密码框态）；
 * 错密码（openSecret reject）→ 错误提示 + 本地防暴破：连错 5 次锁 30s，计数器落盘
 * localStorage 'share:lock:<shareId>'（值 {count, until}，键存在即算、值格式不钉；写锁读-改-写
 * 取 max——旧在途回应不抹已生效锁定；存储禁用时锁静默降级为无阻尼，GCM 解密仍是真的门）。
 * 锁定拦截判定一律 Date.now() 惰性现读——假时钟推进即自然解锁；提交拦截收口在 handler 内
 * （以落盘值为准，不依赖 disabled 属性随时间自行摘除）；提交带序号守卫：shareId 切换/新提交
 * 起算后，在途旧提交既不回灌下载面也不写错锁键；锁定「提示文案」另挂 1s 心跳强制重渲染
 * （倒计时递减、到期自动消失）——心跳只驱动 UI，不参与拦截判定。
 * 成功（openSecret resolve URL）→ 本地计数清零，渲染文件名/大小 + 「下载」<a :href> 直指该 URL。
 *
 * data-testid：share-loading / share-cancelled / share-expired / share-submit /
 * share-locked / share-error / share-download
 * 大小格式化复用 files/format 的 formatBytes（全仓唯一正本）；token 样式对齐 TrashPanel.vue。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatBytes } from '@/files/format'
import { isShareExpired } from '@/files/share-crypto'
import type { ShareMetaV1 } from '@/files/share-crypto'

const props = defineProps<{
  /** 分享 id（原样透传给 fetchMeta，单参严格） */
  shareId: string
  /** 拉取分享 meta；null=已撤销/不存在 */
  fetchMeta: (shareId: string) => Promise<ShareMetaV1 | null>
  /** 开封（密码校验=解密成功）；reject=错密码等失败；resolve=下载 URL */
  openSecret: (meta: ShareMetaV1, password: string) => Promise<string>
}>()

const { t } = useI18n()

// ───────────────────────── 状态机 ─────────────────────────

type ViewState = 'loading' | 'cancelled' | 'expired' | 'ready'
const state = ref<ViewState>('loading')
const meta = ref<ShareMetaV1 | null>(null)
const password = ref('')
const error = ref('')
const downloadUrl = ref('')
const submitting = ref(false)

const sizeText = computed(() => (meta.value ? formatBytes(meta.value.size) : ''))

// ───────────────────────── 本地防暴破（localStorage 计数器，惰性锁定判定） ─────────────────────────

const LOCK_KEY_PREFIX = 'share:lock:'
/** 连错 5 次触发锁定 */
const LOCK_MAX_COUNT = 5
/** 锁定时长 30s（Date.now() 惰性比较，到点即解锁） */
const LOCK_MS = 30_000

interface LockState {
  count: number
  /** 锁定截止时间戳；0=未锁定（仅计数） */
  until: number
}

/** 现读落盘锁态：until>0 且已过 → 视为已解锁且计数一并清零（新一轮防暴破从此起算），顺手清残留键 */
function readLock(shareId: string): LockState {
  try {
    const raw = localStorage.getItem(LOCK_KEY_PREFIX + shareId)
    if (!raw) return { count: 0, until: 0 }
    const p = JSON.parse(raw) as { count?: unknown; until?: unknown }
    const count = typeof p.count === 'number' && Number.isFinite(p.count) ? p.count : 0
    const until = typeof p.until === 'number' && Number.isFinite(p.until) ? p.until : 0
    if (until > 0 && Date.now() >= until) {
      removeLock(shareId) // 过期锁顺手清残留（removeLock 自吞存储异常）
      return { count: 0, until: 0 }
    }
    return { count, until }
  } catch {
    return { count: 0, until: 0 }
  }
}

/** 写锁（读-改-写合并）：until/count 均取 max——旧在途回应不得抹掉已生效的更长锁定 */
function writeLock(shareId: string, lock: LockState): void {
  try {
    const existing = readLock(shareId)
    const merged: LockState = {
      count: Math.max(existing.count, lock.count),
      until: Math.max(existing.until, lock.until),
    }
    localStorage.setItem(LOCK_KEY_PREFIX + shareId, JSON.stringify(merged))
  } catch {
    // 存储禁用时锁降级为无阻尼，GCM 解密仍是真的门
  }
}

/** 清锁键（成功开封计数清零 / 过期残留清理）；存储禁用时静默 */
function removeLock(shareId: string): void {
  try {
    localStorage.removeItem(LOCK_KEY_PREFIX + shareId)
  } catch {
    // 存储禁用时锁降级为无阻尼，GCM 解密仍是真的门
  }
}

/** 锁定截止镜像（仅驱动提示文案；拦截判定以 readLock 现读为准，二者不互相依赖时效） */
const lockUntil = ref(0)

/**
 * 锁定剩余秒数（响应式；0=未锁定/已到期 → 提示消失）。Date.now 非响应式，锁定期挂 1s 心跳
 * 强制重渲染驱动它递减、到期自动归零——心跳只服务提示 UI，拦截判定仍走 readLock 惰性现读。
 */
const lockRemainS = ref(0)

let lockTicker: ReturnType<typeof setInterval> | null = null

function stopLockTicker(): void {
  if (lockTicker !== null) {
    clearInterval(lockTicker)
    lockTicker = null
  }
}

/** 按 lockUntil 现值同步心跳：锁定中则起 1s interval（幂等，已起不重复），否则摘除并清零文案 */
function syncLockTicker(): void {
  stopLockTicker()
  if (lockUntil.value <= 0 || Date.now() >= lockUntil.value) {
    lockRemainS.value = 0
    return
  }
  lockRemainS.value = Math.max(1, Math.ceil((lockUntil.value - Date.now()) / 1000))
  lockTicker = setInterval(() => {
    const remainS = Math.ceil((lockUntil.value - Date.now()) / 1000)
    lockRemainS.value = Math.max(0, remainS)
    if (remainS <= 0) {
      lockUntil.value = 0 // 到期：镜像归零 → 提示消失（拦截判定 readLock 现读同样放行）
      stopLockTicker()
    }
  }, 1000)
}

watch(lockUntil, syncLockTicker)
onUnmounted(stopLockTicker)

// ───────────────────────── 加载与提交 ─────────────────────────

let loadSeq = 0
/** 提交序号：load 重跑（shareId 切换）或新提交起算即作废在途旧提交，防旧结果写进新状态 */
let submitSeq = 0
async function load(): Promise<void> {
  const seq = ++loadSeq
  submitSeq++ // 新一轮加载使在途提交全部过期：成功不回灌旧 URL，失败不写旧 shareId 的锁键
  const id = props.shareId
  state.value = 'loading'
  meta.value = null
  downloadUrl.value = ''
  password.value = ''
  error.value = ''
  lockUntil.value = 0
  let m: ShareMetaV1 | null = null
  try {
    m = await props.fetchMeta(id)
  } catch {
    // 拉取异常与 null 同口径（不存在/不可得）
  }
  if (seq !== loadSeq) return // shareId 已再变更，过期响应弃用
  if (m === null) {
    state.value = 'cancelled'
    return
  }
  if (isShareExpired(m)) {
    state.value = 'expired'
    return
  }
  meta.value = m
  lockUntil.value = readLock(id).until // 页面刷新/切换后锁镜像同步（锁跨会话生效）
  state.value = 'ready'
}

onMounted(load)
watch(() => props.shareId, load)

async function onSubmit(): Promise<void> {
  if (submitting.value || !meta.value || downloadUrl.value) return
  const seq = ++submitSeq
  const shareId = props.shareId // 入口捕获常量：await 期间 shareId 切换后，锁键不得写进新分享的键域
  // 锁定期拦截（回调触达前的最后一道闸）：以落盘值惰性现读为准——Date.now() 到点即放行，
  // 不依赖提示文案/disabled 属性的重渲染时机
  const lock = readLock(shareId)
  if (Date.now() < lock.until) {
    lockUntil.value = lock.until
    return
  }
  error.value = ''
  submitting.value = true
  try {
    const url = await props.openSecret(meta.value, password.value)
    if (seq !== submitSeq) return // 提交已过期：旧预签名 URL 不得回灌进新分享状态（未验密码出下载面）
    removeLock(shareId) // 成功：失败计数清零
    lockUntil.value = 0
    downloadUrl.value = url
  } catch {
    if (seq !== submitSeq) return // 过期提交的失败不得写进新 shareId 的锁键（错计串锁）
    const count = lock.count + 1
    const until = count >= LOCK_MAX_COUNT ? Date.now() + LOCK_MS : 0
    writeLock(shareId, { count, until })
    lockUntil.value = until
    error.value = t('share.access.error')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="share-access" data-testid="share-access">
    <div v-if="state === 'loading'" class="share-access__loading" data-testid="share-loading">
      <i class="ri-loader-4-line share-access__spinner" aria-hidden="true" />
      <span>{{ t('share.access.loading') }}</span>
    </div>

    <div v-else-if="state === 'cancelled'" class="share-access__state" data-testid="share-cancelled" role="alert">
      <i class="ri-forbid-line share-access__state-icon" aria-hidden="true" />
      <p class="share-access__state-text">{{ t('share.access.cancelled') }}</p>
    </div>

    <div v-else-if="state === 'expired'" class="share-access__state" data-testid="share-expired" role="alert">
      <i class="ri-time-line share-access__state-icon" aria-hidden="true" />
      <p class="share-access__state-text">{{ t('share.access.expired') }}</p>
    </div>

    <template v-else>
      <!-- 成功态：文件名/大小 + 「下载」（<a :href> 直指 openSecret 返回的预签名 URL） -->
      <div v-if="downloadUrl" class="share-access__result">
        <i class="ri-file-3-line share-access__state-icon" aria-hidden="true" />
        <div class="share-access__file">
          <p class="share-access__name">{{ meta?.name }}</p>
          <p class="share-access__size">{{ sizeText }}</p>
        </div>
        <a class="share-access__download" data-testid="share-download" :href="downloadUrl" download>
          <i class="ri-download-2-line" aria-hidden="true" />
          <span>{{ t('share.access.download') }}</span>
        </a>
      </div>

      <!-- 密码框态 -->
      <div v-else class="share-access__form">
        <label class="share-access__label" for="share-access-password">{{ t('share.access.password') }}</label>
        <div class="share-access__row">
          <input
            id="share-access-password"
            v-model="password"
            type="password"
            class="share-access__input"
            :placeholder="t('share.access.password-placeholder')"
            :aria-label="t('share.access.password')"
            autocomplete="off"
            @keyup.enter="onSubmit"
          />
          <button
            type="button"
            class="share-access__submit"
            data-testid="share-submit"
            :disabled="submitting"
            @click="onSubmit"
          >
            {{ t('share.access.submit') }}
          </button>
        </div>
        <p v-if="lockRemainS > 0" class="share-access__locked" data-testid="share-locked" role="alert">
          {{ t('share.access.locked', { s: lockRemainS }) }}
        </p>
        <p v-else-if="error" class="share-access__error" data-testid="share-error" role="alert">
          {{ error }}
        </p>
      </div>
    </template>
  </section>
</template>

<style lang="scss" scoped>
.share-access {
  max-width: 420px;
  margin: 48px auto;
  padding: 24px;
  background: var(--app-section-bg);
  border: 1px solid var(--app-section-border-color);
  border-radius: var(--app-section-radius);
  color: var(--app-text-primary);
}

.share-access__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 0;
  font-size: 13px;
  color: var(--app-text-secondary);
}

.share-access__spinner {
  animation: share-access-spin 1s linear infinite;
  color: var(--app-text-tertiary);
}

@keyframes share-access-spin {
  to {
    transform: rotate(360deg);
  }
}

.share-access__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  text-align: center;
}

.share-access__state-icon {
  font-size: 28px;
  color: var(--app-text-tertiary);
}

.share-access__state-text {
  margin: 0;
  font-size: 14px;
  color: var(--app-text-secondary);
}

.share-access__result {
  display: flex;
  align-items: center;
  gap: 12px;
}

.share-access__file {
  flex: 1;
  min-width: 0;
}

.share-access__name {
  margin: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.share-access__size {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--app-text-secondary);
  font-variant-numeric: tabular-nums;
}

.share-access__download {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--app-on-primary, #fff);
  text-decoration: none;
  background: var(--el-color-primary, var(--brand-primary, #409eff));
  border-radius: var(--app-section-radius);

  &:hover {
    opacity: 0.9;
  }
}

.share-access__label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
}

.share-access__row {
  display: flex;
  gap: 8px;
}

.share-access__input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--app-text-primary);
  background: transparent;
  border: 1px solid var(--app-section-border-color);
  border-radius: var(--app-section-radius);

  &:focus {
    outline: none;
    border-color: var(--el-color-primary, var(--brand-primary, #409eff));
  }
}

.share-access__submit {
  padding: 6px 14px;
  font-size: 13px;
  color: var(--app-on-primary, #fff);
  white-space: nowrap;
  cursor: pointer;
  background: var(--el-color-primary, var(--brand-primary, #409eff));
  border: none;
  border-radius: var(--app-section-radius);

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}

.share-access__locked,
.share-access__error {
  margin: 10px 0 0;
  font-size: 12px;
}

.share-access__locked {
  color: var(--app-text-secondary);
}

.share-access__error {
  color: var(--el-color-danger, var(--brand-danger, #f56c6c));
}
</style>
