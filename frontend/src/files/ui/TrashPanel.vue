<script setup lang="ts">
/**
 * TrashPanel — 回收站面板（M3-UI；风格对齐 UploadPanel.vue）。
 * 列表：checkbox 多选 + 原路径 + 删除时间（deletedAt null → files.trash.no-time='—'）+ 版本数；
 * 工具栏：恢复 / 彻底删除（需选中） / 清空回收站（不依赖选中态）；busy 时三钮禁用。
 * 纯展示：props 进、事件出，恢复/彻底删除/清空的实际执行（含确认框）在父级 workspace-ops 层收口，
 * 本组件不做任何确认交互。
 * data-testid：trash-panel / trash-item / trash-restore / trash-purge / trash-empty
 * （表头全选框为 DOM 首个 checkbox）。时间格式化复用 utils/date 的 formatDateTime。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcEmpty } from '@/components/sdk'
import { formatDateTime } from '@/utils/date'
import type { TrashEntry } from '../tree-store'

const props = defineProps<{ entries: TrashEntry[]; busy?: boolean }>()

const emit = defineEmits<{
  /** 恢复选中条目（父级接 FileTreeWithTrash.restoreTrash；确认框在父级） */
  restore: [entries: TrashEntry[]]
  /** 彻底删除选中条目（父级接 purgeTrash；确认框在父级） */
  purge: [entries: TrashEntry[]]
  /** 清空回收站（父级接 emptyTrash；确认框在父级，组件内单击即 emit） */
  empty: []
}>()

const { t } = useI18n()

/** 勾选集合（按 key；Set 整体替换保持响应式） */
const selected = ref(new Set<string>())

// entries 整体替换（刷新/清空后）时清掉已失效的勾选
watch(
  () => props.entries,
  (entries) => {
    const keys = new Set(entries.map((e) => e.key))
    const next = new Set([...selected.value].filter((k) => keys.has(k)))
    if (next.size !== selected.value.size) selected.value = next
  },
)

const selectedEntries = computed(() => props.entries.filter((e) => selected.value.has(e.key)))
const hasSelection = computed(() => selectedEntries.value.length > 0)
/** 表头全选框（writable computed：读=是否全选，写=全选/全不选） */
const allSelectedProxy = computed({
  get: () => props.entries.length > 0 && props.entries.every((e) => selected.value.has(e.key)),
  set: (checked: boolean) => {
    selected.value = checked ? new Set(props.entries.map((e) => e.key)) : new Set()
  },
})

function toggleRow(e: TrashEntry, ev: Event) {
  const checked = (ev.target as HTMLInputElement).checked
  const next = new Set(selected.value)
  if (checked) next.add(e.key)
  else next.delete(e.key)
  selected.value = next
}

/** deletedAt null → '—'（files.trash.no-time）；时间戳 → YYYY-MM-DD HH:mm（formatDateTime） */
function deletedAtText(e: TrashEntry): string {
  if (e.deletedAt == null) return t('files.trash.no-time')
  return formatDateTime(new Date(e.deletedAt).toISOString())
}

function onRestore() {
  if (!props.busy && hasSelection.value) emit('restore', selectedEntries.value)
}
function onPurge() {
  if (!props.busy && hasSelection.value) emit('purge', selectedEntries.value)
}
function onEmpty() {
  if (!props.busy) emit('empty')
}
</script>

<template>
  <section class="trash-panel" data-testid="trash-panel">
    <header class="trash-panel__head">
      <i class="ri-delete-bin-line trash-panel__title-icon" />
      <span class="trash-panel__title">{{ t('files.trash.title') }}</span>
      <span class="trash-panel__spacer" />
      <FcButton
        variant="text"
        size="sm"
        data-testid="trash-restore"
        :disabled="busy || !hasSelection"
        @click="onRestore"
      >
        {{ t('files.trash.restore') }}
      </FcButton>
      <FcButton
        variant="text"
        size="sm"
        data-testid="trash-purge"
        :disabled="busy || !hasSelection"
        @click="onPurge"
      >
        {{ t('files.trash.purge') }}
      </FcButton>
      <FcButton variant="text" size="sm" data-testid="trash-empty" :disabled="busy" @click="onEmpty">
        {{ t('files.trash.empty') }}
      </FcButton>
    </header>

    <FcEmpty v-if="entries.length === 0" type="empty" :title="t('files.trash.empty-state')" />

    <template v-else>
      <div class="trash-panel__row trash-panel__row--head">
        <input
          v-model="allSelectedProxy"
          type="checkbox"
          class="trash-panel__check"
          data-testid="trash-select-all"
          :aria-label="t('files.trash.select-all')"
        />
        <span class="trash-panel__path">{{ t('files.trash.path') }}</span>
        <span class="trash-panel__time">{{ t('files.trash.deleted-at') }}</span>
        <span class="trash-panel__versions">{{ t('files.trash.versions') }}</span>
      </div>
      <ul class="trash-panel__list">
        <li v-for="e in entries" :key="e.key" class="trash-panel__row" data-testid="trash-item">
          <input
            type="checkbox"
            class="trash-panel__check"
            :checked="selected.has(e.key)"
            :aria-label="e.key"
            @change="toggleRow(e, $event)"
          />
          <span class="trash-panel__path" :title="e.key">{{ e.key }}</span>
          <span class="trash-panel__time">{{ deletedAtText(e) }}</span>
          <span class="trash-panel__versions">{{ e.versions }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style lang="scss" scoped>
.trash-panel {
  padding: 4px 8px 8px;
  background: var(--app-section-bg);
  border: 1px solid var(--app-section-border-color);
  border-radius: var(--app-section-radius);
  color: var(--app-text-primary);
}

.trash-panel__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--app-section-border-color);
}

.trash-panel__title {
  font-size: 13px;
  font-weight: 600;
}

.trash-panel__title-icon {
  color: var(--app-text-tertiary);
}

.trash-panel__spacer {
  flex: 1;
}

.trash-panel__list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.trash-panel__row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 128px 56px;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;

  &.trash-panel__row--head {
    padding-top: 6px;
    font-size: 12px;
    color: var(--app-text-tertiary);
  }
}

.trash-panel__check {
  margin: 0;
  accent-color: var(--el-color-primary, var(--brand-primary, #409eff));
}

.trash-panel__path {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.trash-panel__time {
  font-size: 12px;
  color: var(--app-text-secondary);
  font-variant-numeric: tabular-nums;
}

.trash-panel__versions {
  font-size: 12px;
  color: var(--app-text-secondary);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
