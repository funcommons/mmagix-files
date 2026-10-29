<script setup lang="ts">
/**
 * ZipBrowser — zip 在线解压浏览器（M4-UI 波次；风格对齐 files/ui/TrashPanel.vue）。
 * 契约：documents/v1.2.0执行进度.md §UI 波次契约 M4-UI——IO 全部回调注入，组件零业务依赖
 * （纯测可桩：load/extract/download 均 vi.fn）。业务实现在 renderers/zip.ts 闭包里。
 * 行为：
 *  - mount 即调 load → 条目表（名称/大小/修改时间；加密行 🔒 标 + 提示文案、不可勾；目录行
 *    checkbox 渲染但 disabled）；顶部常驻加密提示行（'zip.encrypted-hint'）。
 *  - 勾选 →「解出所选」= extract(勾选条目原序数组)；「全部解出」= extract(全部非加密非目录条目
 *    原序)；「下载」= download(勾选条目)。选中态按条目下标记录，实参恒按 entries 原序（勾选序
 *    ≠实参序，契约钉死；toEqual 深等同时兼容原对象引用与同形状拷贝）。
 *  - load reject → 错误态（'zip.load-fail' 文案 + zip-retry 钮复调 load）；busy=true → 三操作钮
 *    disabled（另叠加无选中禁用 + 组件内 opRunning 在途锁防双击重入）；零条目 → 空态
 *    （FcEmpty 'zip.empty'）。
 *  - extract/download reject → 顶部 notice 行显示 message（组件不做 IO，只呈现）。
 * data-testid：zip-browser / zip-item / zip-select-all / zip-extract / zip-extract-all /
 *   zip-download / zip-retry。
 * 取值口径：大小走 files/format.formatBytes（R2-05 全仓唯一正本）；时间走 utils/date.formatDateTime
 * （YYYY-MM-DD HH:mm，与 TrashPanel 同款）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcEmpty } from '@/components/sdk'
import { formatBytes } from '@/files/format'
import { formatDateTime } from '@/utils/date'
import type { ZipCentral, ZipEntryMeta } from '../../files/zip-reader'

const props = defineProps<{
  /** 拉取中心目录（renderer 注入：RangeReader + parseCentralDirectory）；reject=错误态 */
  load: () => Promise<ZipCentral>
  /** 解出（renderer 注入：sanitize/checkBomb 三闸在回调内做，组件只传勾选条目） */
  extract: (entries: ZipEntryMeta[]) => Promise<void>
  /** 下载所选条目（renderer 注入：逐条解出→锚点落盘） */
  download: (entries: ZipEntryMeta[]) => Promise<void>
  /** 父级在途/busy：true 时三操作钮禁用且不产生回调副作用 */
  busy?: boolean
}>()

const { t } = useI18n()

/** 渲染相位：loading=首拉/重试中；error=load reject；ready=已拿到 central（含零条目空态） */
type Phase = 'loading' | 'ready' | 'error'
const phase = ref<Phase>('loading')
const central = ref<ZipCentral | null>(null)
/** 勾选集合（entries 下标；Set 整体替换保响应式） */
const selected = ref(new Set<number>())
/** 操作回调失败提示（extract/download reject 时显示；成功汇总由回调方自持状态行） */
const notice = ref('')
/** 组件内在途锁：与 props.busy 相或——防操作双击重入（回调未落定前按钮保持禁用） */
const opRunning = ref(false)

const entries = computed<ZipEntryMeta[]>(() => central.value?.entries ?? [])
/** 可解出条目（非加密非目录，原序）——「全部解出」与表头全选共用口径 */
const extractable = computed(() => entries.value.filter((e) => !e.encrypted && !e.isDirectory))
/** 勾选条目（原序输出；可勾行本就只有非加密非目录，序过滤作冗余防御） */
const selectedEntries = computed(() =>
  entries.value.filter((e, i) => selected.value.has(i) && !e.encrypted && !e.isDirectory),
)
const hasSelection = computed(() => selectedEntries.value.length > 0)
const effectiveBusy = computed(() => props.busy === true || opRunning.value)

async function runLoad(): Promise<void> {
  phase.value = 'loading'
  notice.value = ''
  try {
    central.value = await props.load()
    selected.value = new Set()
    phase.value = 'ready'
  } catch {
    phase.value = 'error'
  }
}
onMounted(() => {
  void runLoad() // 契约：mount 调 load（同步发起，恰一次）
})

/** 行勾选变更（native checkbox；加密/目录行 disabled 浏览器层不可触发，防御性再判） */
function toggleRow(entry: ZipEntryMeta, index: number, ev: Event): void {
  if (entry.encrypted || entry.isDirectory) return
  const next = new Set(selected.value)
  if ((ev.target as HTMLInputElement).checked) next.add(index)
  else next.delete(index)
  selected.value = next
}

/**
 * 表头全选（writable computed，TrashPanel 同款）：读=可解出条目是否全选（selectedEntries ⊆
 * extractable，计数相等即全选，免 O(n²)）；写=全选/全不选——只作用于可解出条目
 * （加密/目录行不进集合，与「全部解出」口径一致）。
 */
const allSelectedProxy = computed<boolean>({
  get: () => extractable.value.length > 0 && selectedEntries.value.length === extractable.value.length,
  set: (checked: boolean) => {
    const next = new Set<number>()
    if (checked) {
      entries.value.forEach((e, i) => {
        if (!e.encrypted && !e.isDirectory) next.add(i)
      })
    }
    selected.value = next
  },
})

/** 操作统一包装：在途锁 + 失败 notice（message 直出；非 Error 垃圾回落 'zip.op-fail'） */
async function runOp(fn: () => Promise<void>): Promise<void> {
  if (effectiveBusy.value) return
  opRunning.value = true
  notice.value = ''
  try {
    await fn()
  } catch (e) {
    notice.value = e instanceof Error && e.message !== '' ? e.message : t('zip.op-fail')
  } finally {
    opRunning.value = false
  }
}

function onExtractSelected(): void {
  if (!hasSelection.value) return
  void runOp(() => props.extract(selectedEntries.value))
}
function onExtractAll(): void {
  if (extractable.value.length === 0) return
  void runOp(() => props.extract(extractable.value))
}
function onDownload(): void {
  if (!hasSelection.value) return
  void runOp(() => props.download(selectedEntries.value))
}

function sizeText(e: ZipEntryMeta): string {
  return formatBytes(e.size)
}
/** DOS 时间（zip-reader 按 UTC 定标的 epoch ms）→ YYYY-MM-DD HH:mm */
function timeText(e: ZipEntryMeta): string {
  return formatDateTime(new Date(e.lastModified).toISOString())
}
</script>

<template>
  <section class="zip-browser" data-testid="zip-browser">
    <header v-if="phase === 'ready' && entries.length > 0" class="zip-browser__bar">
      <i class="ri-file-zip-line zip-browser__title-icon" />
      <span class="zip-browser__hint">🔒 {{ t('zip.encrypted-hint') }}</span>
      <span class="zip-browser__spacer" />
      <FcButton
        variant="text"
        size="sm"
        data-testid="zip-extract"
        :disabled="effectiveBusy || !hasSelection"
        @click="onExtractSelected"
      >
        {{ t('zip.extract-selected') }}
      </FcButton>
      <FcButton
        variant="text"
        size="sm"
        data-testid="zip-extract-all"
        :disabled="effectiveBusy || extractable.length === 0"
        @click="onExtractAll"
      >
        {{ t('zip.extract-all') }}
      </FcButton>
      <FcButton
        variant="text"
        size="sm"
        data-testid="zip-download"
        :disabled="effectiveBusy || !hasSelection"
        @click="onDownload"
      >
        {{ t('zip.download') }}
      </FcButton>
    </header>

    <p v-if="notice !== ''" class="zip-browser__notice">{{ notice }}</p>

    <div v-if="phase === 'loading'" class="zip-browser__state">{{ t('zip.loading') }}</div>
    <div v-else-if="phase === 'error'" class="zip-browser__state zip-browser__state--error">
      <p class="zip-browser__error-text">{{ t('zip.load-fail') }}</p>
      <FcButton variant="text" size="sm" data-testid="zip-retry" @click="runLoad">
        {{ t('zip.retry') }}
      </FcButton>
    </div>
    <FcEmpty v-else-if="entries.length === 0" type="empty" :title="t('zip.empty')" />
    <template v-else>
      <div class="zip-browser__row zip-browser__row--head">
        <input
          v-model="allSelectedProxy"
          type="checkbox"
          class="zip-browser__check"
          data-testid="zip-select-all"
          :aria-label="t('zip.select-all')"
        />
        <span>{{ t('zip.name') }}</span>
        <span>{{ t('zip.size') }}</span>
        <span>{{ t('zip.modified') }}</span>
      </div>
      <ul class="zip-browser__list">
        <li v-for="(e, i) in entries" :key="i" class="zip-browser__row" data-testid="zip-item">
          <input
            type="checkbox"
            class="zip-browser__check"
            :checked="selected.has(i)"
            :disabled="e.encrypted || e.isDirectory"
            :aria-label="e.name"
            @change="toggleRow(e, i, $event)"
          />
          <span class="zip-browser__name" :title="e.name">
            {{ e.name }}
            <span v-if="e.encrypted" class="zip-browser__tag">🔒 {{ t('zip.encrypted-tag') }}</span>
            <span v-else-if="e.isDirectory" class="zip-browser__tag">{{ t('zip.directory') }}</span>
          </span>
          <span class="zip-browser__size">{{ sizeText(e) }}</span>
          <span class="zip-browser__time">{{ timeText(e) }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style lang="scss" scoped>
.zip-browser {
  padding: 4px 8px 8px;
  background: var(--app-section-bg);
  border: 1px solid var(--app-section-border-color);
  border-radius: var(--app-section-radius);
  color: var(--app-text-primary);
}

.zip-browser__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--app-section-border-color);
}

.zip-browser__title-icon {
  color: var(--app-text-tertiary);
}

.zip-browser__hint {
  overflow: hidden;
  font-size: 12px;
  color: var(--app-text-tertiary);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.zip-browser__spacer {
  flex: 1;
}

.zip-browser__notice {
  margin: 4px 0 0;
  padding: 4px 0;
  font-size: 12px;
  color: var(--el-color-danger);
}

.zip-browser__state {
  padding: 16px;
  font-size: 13px;
  color: var(--app-text-secondary);

  &.zip-browser__state--error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}

.zip-browser__error-text {
  margin: 0;
}

.zip-browser__list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.zip-browser__row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 84px 128px;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;

  &.zip-browser__row--head {
    padding-top: 6px;
    font-size: 12px;
    color: var(--app-text-tertiary);
  }
}

.zip-browser__check {
  margin: 0;
  accent-color: var(--el-color-primary, var(--brand-primary, #409eff));
}

.zip-browser__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.zip-browser__tag {
  margin-left: 6px;
  font-size: 12px;
  color: var(--app-text-tertiary);
}

.zip-browser__size,
.zip-browser__time {
  font-size: 12px;
  color: var(--app-text-secondary);
  font-variant-numeric: tabular-nums;
}
</style>
