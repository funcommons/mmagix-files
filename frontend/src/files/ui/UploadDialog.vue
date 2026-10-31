<script setup lang="ts">
/**
 * UploadDialog — 上传/传输双 Tab 弹窗（2026-10 订单：上传先弹窗确认；传输任务中心并入为 Tab）。
 * Tab「上传」：目标目录（只读，Home 按「目录=其内 / 文件=所在目录」解析后传入）+ FcDropZone
 * 拖放/点选区（multiple，不限大小）+ 已选清单（可移除）+ 确认入队（confirm 吐 File[] 由 Home 接）；
 * Tab「传输」：#transfer 槽（Home 嵌 embedded UploadPanel 任务中心）。
 * 标题「文件」；宽度自适应视口：92% + max-width 680px（FcDialog 会对非数字/百分��宽度做
 * parseInt 兜底，故不用 min() 表达式，用 dialog-class 兜上限）；确认即关门，「成功开始入队后
 * 重开传输页签」由 Home 编排（冲突提示在关门后弹出不被遮挡）；每次打开清空已选并落到指定页签。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcDialog, FcDropZone, FcSegmented } from '@/components/sdk'

const props = withDefaults(
  defineProps<{
    open: boolean
    dir: string
    /** 打开时落到的页签（默认上传）；传输页签=任务中心 */
    tab?: 'upload' | 'transfer'
  }>(),
  { tab: 'upload' },
)

const emit = defineEmits<{
  'update:open': [open: boolean]
  /** 确认上传：携带已选文件（非空才可能触发），Home 接 trackedEnqueue(files, dir) */
  confirm: [files: File[]]
}>()

const { t } = useI18n()

const files = ref<File[]>([])
const activeTab = ref<'upload' | 'transfer'>(props.tab)

// 每次打开清空上次选择（目标目录可能已变）并落到调用方指定页签；
// 已开状态下 tab prop 再变化（如传输页签中又点树头「上传」）也要跟随落页
watch(
  () => props.open,
  (o) => {
    if (o) {
      files.value = []
      activeTab.value = props.tab
    }
  },
)
watch(
  () => props.tab,
  (t) => {
    if (props.open) activeTab.value = t
  },
)

const tabOptions = computed(() => [
  { label: t('files.upload.dialog-tab-upload'), value: 'upload' },
  { label: t('files.upload.dialog-tab-transfer'), value: 'transfer' },
])

function addFiles(incoming: File[]): void {
  if (incoming.length > 0) files.value.push(...incoming)
}

function removeAt(i: number): void {
  files.value.splice(i, 1)
}

function close(): void {
  emit('update:open', false)
}

function onConfirm(): void {
  if (files.value.length === 0) return
  emit('confirm', [...files.value])
  close() // 确认即关门；「成功开始入队后重开传输页签」由 Home 编排（重开时 tab=transfer）
}

const dirLabel = computed(() => props.dir || '/')

/** B/KB/MB/GB（1024 进制，<10 保一位小数）——弹窗清单展示用，不做上传逻辑 */
function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  const num = u === 0 ? String(v) : v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)
  return `${num} ${units[u]}`
}
</script>

<template>
  <FcDialog
    :open="open"
    :title="t('files.upload.dialog-title')"
    width="92%"
    dialog-class="upload-dialog__pop"
    append-to-body
    destroy-on-close
    @update:open="emit('update:open', $event)"
  >
    <div class="upload-dialog">
      <FcSegmented v-model="activeTab" :options="tabOptions" size="sm" data-testid="upload-dialog-tabs" />

      <template v-if="activeTab === 'upload'">
      <div class="upload-dialog__target" data-testid="upload-dialog-target">
        <span class="upload-dialog__target-label">{{ t('files.upload.dialog-target') }}</span>
        <i class="ri-folder-line upload-dialog__target-icon" />
        <span class="upload-dialog__target-dir" :title="dirLabel">{{ dirLabel }}</span>
      </div>

      <FcDropZone class="upload-dialog__zone" data-testid="upload-dialog-zone" :max-size="0" @drop="addFiles">
        <template #default="{ isDragOver }">
          <i class="ri-upload-cloud-2-line upload-dialog__zone-icon" />
          <span class="upload-dialog__zone-text">
            {{ isDragOver ? t('files.upload.dialog-drop') : t('files.upload.dialog-hint') }}
          </span>
        </template>
      </FcDropZone>

      <ul v-if="files.length > 0" class="upload-dialog__list" data-testid="upload-dialog-list">
        <li v-for="(f, i) in files" :key="`${f.name}-${f.size}-${f.lastModified}-${i}`" class="upload-dialog__file" data-testid="upload-dialog-file">
          <i class="ri-file-line upload-dialog__file-icon" />
          <span class="upload-dialog__file-name" :title="f.name">{{ f.name }}</span>
          <span class="upload-dialog__file-size">{{ formatSize(f.size) }}</span>
          <button
            type="button"
            class="upload-dialog__file-remove"
            data-testid="upload-dialog-file-remove"
            :title="t('common.delete')"
            :aria-label="t('common.delete')"
            @click="removeAt(i)"
          >
            <i class="ri-close-line" />
          </button>
        </li>
      </ul>

      <p class="upload-dialog__count" data-testid="upload-dialog-count">
        {{ t('files.upload.dialog-selected', { n: files.length }) }}
      </p>
      </template>

      <!-- 传输页签：任务中心（Home 嵌 embedded UploadPanel；空态提示由 Home 层出） -->
      <div v-else class="upload-dialog__transfer" data-testid="upload-dialog-transfer">
        <slot name="transfer" />
      </div>
    </div>

    <template #footer>
      <FcButton variant="secondary" data-testid="upload-dialog-cancel" @click="close">
        {{ t('common.cancel') }}
      </FcButton>
      <FcButton
        v-if="activeTab === 'upload'"
        variant="primary"
        :disabled="files.length === 0"
        data-testid="upload-dialog-confirm"
        @click="onConfirm"
      >
        {{ t('files.upload.dialog-confirm') }}
      </FcButton>
    </template>
  </FcDialog>
</template>

<style lang="scss" scoped>
.upload-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.upload-dialog__transfer {
  min-height: 160px;
}

.upload-dialog__target {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
}

.upload-dialog__target-label {
  flex: none;
  color: var(--app-text-secondary);
}

.upload-dialog__target-icon {
  flex: none;
  color: var(--app-primary);
}

.upload-dialog__target-dir {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: break-all;
}

.upload-dialog__zone {
  min-height: 128px;
  flex-direction: column;
  gap: 6px;
  padding: 18px 12px;
}

.upload-dialog__zone-icon {
  font-size: 30px;
  color: var(--app-text-tertiary);
}

.upload-dialog__zone-text {
  font-size: 13px;
  color: var(--app-text-secondary);
  text-align: center;
}

.upload-dialog__list {
  max-height: min(240px, 32vh);
  margin: 0;
  overflow-y: auto;
  padding: 0;
  list-style: none;
}

.upload-dialog__file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;

  &:hover .upload-dialog__file-remove {
    opacity: 1;
  }
}

.upload-dialog__file-icon {
  flex: none;
  color: var(--app-text-tertiary);
}

.upload-dialog__file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-dialog__file-size {
  flex: none;
  font-size: 12px;
  color: var(--app-text-secondary);
  font-variant-numeric: tabular-nums;
}

.upload-dialog__file-remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text-tertiary);
  cursor: pointer;
  opacity: 0.6;
  font-size: 14px;
  transition: opacity 0.15s, background 0.15s;

  &:hover {
    background: color-mix(in srgb, var(--app-danger, #d54941) 12%, transparent);
    color: var(--app-danger, #d54941);
    opacity: 1;
  }
}

.upload-dialog__count {
  margin: 0;
  font-size: 12px;
  color: var(--app-text-tertiary);
}
</style>

<!-- 弹窗本体挂在 body（append-to-body），上限类必须全局选择器；92% + max-width = 自适应视口且大屏不无限拉宽 -->
<style lang="scss">
.el-dialog.upload-dialog__pop {
  max-width: 680px;
}
</style>
