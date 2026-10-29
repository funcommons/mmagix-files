<script setup lang="ts">
/**
 * VersionPanel — 对象历史版本面板（M3-F8 波次；风格对齐 TrashPanel.vue / ZipBrowser.vue）。
 * mount 即调 list(objectKey) → 版本行列表（versionId 全显 + 大小 formatBytes + 时间 formatDateTime）；
 * isLatest 行「最新」标、无恢复钮；非 latest 行恢复钮 → restore(objectKey, versionId)（逐参严格）；
 * download 注入时行内出下载钮（同实参口径），未注入则整列缺席；关闭钮 → emit('close')。
 * 纯展示 + 回调注入：list/restore/download 全走 props 回调，实际 IO（含恢复后刷新）在父级收口。
 * busy（父级恢复链路忙）与本面板 opRunning（恢复执行中）任一为真即禁恢复钮——防重入双闸。
 * ⚠ 偏差钉注：契约伪码的 prop 名 `key` 是 Vue 保留属性（createVNode 抽去 vnode.key 位，运行时
 *   直接丢弃），故按测试钉定改用 `objectKey`（对齐 src/api/types.ts 既有命名）。
 * data-testid：version-panel / version-item / version-restore / version-download / version-close。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcEmpty, FcSkeleton } from '@/components/sdk'
import { formatDateTime } from '@/utils/date'
import { formatBytes } from '../format'
import type { VersionRow } from '@/sdk/types'

const props = defineProps<{
  /** 目标对象 key（契约伪码 key 为 Vue 保留属性名，实现钉为 objectKey） */
  objectKey: string
  /** 列版本回调（mount 即调，实参=objectKey 单参） */
  list: (key: string) => Promise<VersionRow[]>
  /** 恢复到指定版本（实参严格 (objectKey, versionId)；确认框/刷新在父级） */
  restore: (key: string, versionId: string) => Promise<void>
  /** 行内下载该版本（可选注入；未注入不渲染下载钮） */
  download?: (key: string, versionId: string) => Promise<void>
  /** 父级忙（恢复链路执行中）；与本面板 opRunning 任一为真即禁恢复钮 */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** 关闭面板（父级收口显隐） */
  close: []
}>()

const { t } = useI18n()

/** 行序列 + 面板相位（loading/ready/error；error 非空白：错误文案 + 重试） */
const rows = ref<VersionRow[]>([])
const state = ref<'loading' | 'ready' | 'error'>('loading')

async function load(): Promise<void> {
  state.value = 'loading'
  try {
    rows.value = await props.list(props.objectKey)
    state.value = 'ready'
  } catch {
    rows.value = []
    state.value = 'error'
  }
}

onMounted(() => {
  void load()
})

/** 恢复执行中（面板内防重入闸；busy=父级闸——任一为真即禁） */
const opRunning = ref(false)

async function onRestore(row: VersionRow): Promise<void> {
  if (props.busy || opRunning.value || row.isLatest) return
  opRunning.value = true
  try {
    await props.restore(props.objectKey, row.versionId)
  } catch {
    // 错误提示由父级恢复链路收口（toast 层）；面板只负责防重入闸复位
  } finally {
    opRunning.value = false
  }
}

async function onDownload(row: VersionRow): Promise<void> {
  if (!props.download || props.busy || opRunning.value) return
  await props.download(props.objectKey, row.versionId)
}

/** 版本时间（epoch ms → YYYY-MM-DD HH:mm；缺省 '-'） */
function timeText(row: VersionRow): string {
  if (row.lastModified == null) return '-'
  return formatDateTime(new Date(row.lastModified).toISOString())
}
</script>

<template>
  <section class="version-panel" data-testid="version-panel">
    <header class="version-panel__head">
      <i class="ri-history-line version-panel__title-icon" />
      <span class="version-panel__title">{{ t('files.history.title') }}</span>
      <span class="version-panel__key" :title="objectKey">{{ objectKey }}</span>
      <span class="version-panel__spacer" />
      <FcButton variant="text" size="sm" data-testid="version-close" @click="emit('close')">
        {{ t('files.history.close') }}
      </FcButton>
    </header>

    <FcSkeleton v-if="state === 'loading'" class="version-panel__state" variant="text" :rows="5" />

    <FcEmpty
      v-else-if="state === 'error'"
      class="version-panel__state"
      type="error"
      :title="t('files.history.load-fail')"
    >
      <template #action>
        <FcButton variant="secondary" size="sm" @click="load">{{ t('files.history.retry') }}</FcButton>
      </template>
    </FcEmpty>

    <FcEmpty
      v-else-if="rows.length === 0"
      class="version-panel__state"
      type="empty"
      :title="t('files.history.empty')"
    />

    <template v-else>
      <div class="version-panel__row version-panel__row--head">
        <span>{{ t('files.history.col-id') }}</span>
        <span>{{ t('files.history.col-size') }}</span>
        <span>{{ t('files.history.col-time') }}</span>
        <span class="version-panel__ops">{{ t('files.history.col-actions') }}</span>
      </div>
      <ul class="version-panel__list">
        <li
          v-for="row in rows"
          :key="row.versionId"
          class="version-panel__row"
          data-testid="version-item"
        >
          <span class="version-panel__id" :title="row.versionId">{{ row.versionId }}</span>
          <span class="version-panel__size">{{ formatBytes(row.size) }}</span>
          <span class="version-panel__time">{{ timeText(row) }}</span>
          <span class="version-panel__ops">
            <span v-if="row.isLatest" class="version-panel__latest">{{ t('files.history.latest') }}</span>
            <FcButton
              v-else
              variant="text"
              size="sm"
              data-testid="version-restore"
              :disabled="busy || opRunning"
              @click="onRestore(row)"
            >
              {{ t('files.history.restore') }}
            </FcButton>
            <FcButton
              v-if="download"
              variant="text"
              size="sm"
              data-testid="version-download"
              :disabled="busy || opRunning"
              @click="onDownload(row)"
            >
              {{ t('files.history.download') }}
            </FcButton>
          </span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style lang="scss" scoped>
.version-panel {
  padding: 4px 8px 8px;
  background: var(--app-section-bg);
  border: 1px solid var(--app-section-border-color);
  border-radius: var(--app-section-radius);
  color: var(--app-text-primary);
}

.version-panel__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--app-section-border-color);
}

.version-panel__title {
  flex: none;
  font-size: 13px;
  font-weight: 600;
}

.version-panel__title-icon {
  color: var(--app-text-tertiary);
}

.version-panel__key {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--app-text-tertiary);
}

.version-panel__spacer {
  flex: none;
}

.version-panel__state {
  padding: 24px 0;
}

.version-panel__list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.version-panel__row {
  display: grid;
  /* 4 列：版本 Id | 大小 | 时间 | 操作（Id 列吃满余量，长 versionId 截断） */
  grid-template-columns: minmax(0, 1fr) 72px 124px auto;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;

  &.version-panel__row--head {
    padding-top: 6px;
    font-size: 12px;
    color: var(--app-text-tertiary);
  }
}

.version-panel__id {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.version-panel__size,
.version-panel__time {
  font-size: 12px;
  color: var(--app-text-secondary);
  font-variant-numeric: tabular-nums;
}

.version-panel__ops {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  min-width: 0;
}

.version-panel__latest {
  padding: 0 6px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--el-color-success, var(--app-text-secondary));
  border: 1px solid var(--el-color-success, var(--app-section-border-color));
  border-radius: var(--app-radius-sm, 4px);
}
</style>
