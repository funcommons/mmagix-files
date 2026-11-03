<script setup lang="ts">
/**
 * Toolbar — 工作台选中簇动作条（2026-10 布局改版：挂于预览区头右侧，与 tab 条同行）。
 * 创建簇（上传/新建目录/刷新/搜索）已迁 TreePanel 树头——隐藏 input、queue 入队链、
 * search emit 随迁删除；本组件只保留「针对当前选中集」的动作。
 * 重命名/删除：操作链在 workspace-ops 收口（与 TreePanel 右键菜单共用，零复制）。
 * F1 门控：features.*=false 的操作入口整链禁用（UI 隐藏层，契约《用户手册》§一）；
 * 未传 features 或缺省键=默认放开（对齐 resolveFeatures 的「default 全开、false 优先」）。
 * 多选：selected 为数组——删除按全集（>1 用多选确认文案）、重命名按首项、
 * 下载单文件直下/多文件（均非目录）批量打包语义（emit download 数组，zip 在 Home 收口）。
 * 分享钮——双门分离：能力门控 v-if（WebDAV 无预签名→整钮不渲染）+ 选择门控 disabled
 * （单选文件才启用）——S3 行为逐字节不变；启用时 emit('share', entry)（对话框在 Home 收口）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { S3ObjectSummary } from '@/sdk/types'
import type { FileTreeController } from '../tree-store'
import { createWorkspaceOps } from './workspace-ops'

/** withDefaults 仅兜 shareEnabled：纯 Boolean prop 缺省会被 Vue 转型为 false，而本 prop 契约是
 * 「不传=有能力」（与 TreePanel versioning 同款兜底；既有 S3 用法/测试不传该 prop 行为不变） */
const props = withDefaults(
  defineProps<{
    controller: FileTreeController
    /** 当前选中集（多选数组；空=删除/重命名/下载禁用） */
    selected?: S3ObjectSummary[]
    /** features 门控（resolveFeatures 结果；显式 false 隐藏对应操作入口） */
    features?: Record<string, boolean>
    /** 当前预览应用（用户口径：工具栏显示应用名，多应用可点击切换；null=无 tab/无命中不显示） */
    previewApp?: { currentId: string; options: { id: string; label: string }[] } | null
    /** 分享入口能力门控（客户端预签名能力；WebDAV 会话=false 整钮卸载）；不传=true（S3 行为不变） */
    shareEnabled?: boolean
  }>(),
  { shareEnabled: true },
)

/** 操作入口可见性：仅显式 false 关闭（缺省=未配置=放开） */
const enabled = computed(() => ({
  rename: props.features?.rename !== false,
  delete: props.features?.delete !== false,
  download: props.features?.download !== false, // （手册 features 表：download ↔ cmd download）
}))

const selection = computed<S3ObjectSummary[]>(() => props.selected ?? [])
const firstSelected = computed<S3ObjectSummary | null>(() => selection.value[0] ?? null)
/** 下载可用：单文件、或多文件且均非目录（批量打包语义） */
const canDownload = computed(() => {
  const s = selection.value
  if (s.length === 0) return false
  return s.every((e) => !e.isDir)
})
/** 分享可用：单选文件（目录不给分享——前缀分享列 P2；多选无单链接口径） */
const canShare = computed(() => firstSelected.value !== null && selection.value.length === 1 && !firstSelected.value.isDir)

/** 破坏性操作（删除/重命名）成功后发 changed(key)，父层据此维护选中集；多选批量下载/share 出口 */
const emit = defineEmits<{
  changed: [key: string]
  download: [entries: S3ObjectSummary[]]
  /** 分享选中文件（单选文件才可用；对话框在 Home 收口） */
  share: [entry: S3ObjectSummary]
  /** 切换当前预览的应用（多应用命中时下拉选择；Home → preview.open(entry, {appId})） */
  switchApp: [appId: string]
}>()

/** 应用徽标：单应用=纯显示；多应用=下拉可切换（el-dropdown，当前项打勾） */
const appOptions = computed(() => props.previewApp?.options ?? [])
const currentAppLabel = computed(
  () => appOptions.value.find((o) => o.id === props.previewApp?.currentId)?.label ?? '',
)
function onSwitchApp(id: string): void {
  if (id !== props.previewApp?.currentId) emit('switchApp', id)
}

const { t } = useI18n()
/** 操作链（rename/remove）与右键菜单共用（workspace-ops 收口） */
const ops = createWorkspaceOps({ tree: props.controller, t })

async function renameSelected(): Promise<void> {
  const entry = firstSelected.value
  if (!entry) return
  const r = await ops.renameEntry(entry)
  if (r) emit('changed', r.from)
}

async function removeSelected(): Promise<void> {
  const keys = await ops.removeEntries(selection.value)
  if (keys) for (const k of keys) emit('changed', k)
}

/** 下载选中：单文件直下 / 多文件（均非目录）批量打包；执行链在 Home（get→blob/zip→triggerDownload） */
function downloadSelected(): void {
  if (!canDownload.value) return
  emit('download', selection.value.filter((e) => !e.isDir))
}

/** 分享选中文件：仅单选文件；对话框实例与关闭在 Home 收口 */
function shareSelected(): void {
  const entry = firstSelected.value
  if (!canShare.value || !entry) return
  emit('share', entry)
}
</script>

<template>
  <div class="ws-toolbar">
    <!-- 应用徽标（用户口径：显示当前打开文件的应用名；多应用命中=下拉可切换，单应用纯显示） -->
    <el-dropdown v-if="previewApp" trigger="click" @command="onSwitchApp">
      <button
        type="button"
        class="ws-toolbar__app"
        data-testid="toolbar-app-badge"
        :title="t('files.toolbar.switchApp')"
        :aria-label="t('files.toolbar.switchApp')"
      >
        <i class="ri-apps-2-line" />
        <span class="ws-toolbar__app-name">{{ currentAppLabel }}</span>
        <i v-if="appOptions.length > 1" class="ri-arrow-down-s-line ws-toolbar__app-caret" />
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="o in appOptions"
            :key="o.id"
            :command="o.id"
            :data-testid="`toolbar-app-${o.id}`"
          >
            <i
              :class="o.id === previewApp.currentId ? 'ri-check-line' : 'ri-apps-line'"
              style="margin-right: 6px"
            />{{ o.label }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <!-- 紧凑图标钮（2026-10）：样式复用文件树头动作钮口径（ghost 态，hover bg-muted）；
         可访问名=aria-label/title（与原文字文案同键，e2e/单测按 testid 定位） -->
    <!-- 分享入口：双门分离——能力门控 v-if（WebDAV 无预签名→整钮不渲染）+ 选择门控 disabled
         （单选文件才启用，S3 行为逐字节不变）；文案复用 files.menu.share
         （词典无 files.toolbar.share，禁改词典口径） -->
    <button
      v-if="shareEnabled"
      type="button"
      class="ws-toolbar__act"
      :disabled="!canShare"
      data-testid="toolbar-share"
      :title="t('files.menu.share')"
      :aria-label="t('files.menu.share')"
      @click="shareSelected"
    >
      <i class="ri-share-line" />
    </button>
    <button
      v-if="enabled.download"
      type="button"
      class="ws-toolbar__act"
      :disabled="!canDownload"
      data-testid="toolbar-download"
      :title="t('files.toolbar.download')"
      :aria-label="t('files.toolbar.download')"
      @click="downloadSelected"
    >
      <i class="ri-download-2-line" />
    </button>
    <button
      v-if="enabled.rename"
      type="button"
      class="ws-toolbar__act"
      :disabled="!firstSelected"
      data-testid="toolbar-rename"
      :title="t('files.toolbar.rename')"
      :aria-label="t('files.toolbar.rename')"
      @click="renameSelected"
    >
      <i class="ri-edit-line" />
    </button>
    <button
      v-if="enabled.delete"
      type="button"
      class="ws-toolbar__act ws-toolbar__act--danger"
      :disabled="selection.length === 0"
      data-testid="toolbar-delete"
      :title="t('files.toolbar.delete')"
      :aria-label="t('files.toolbar.delete')"
      @click="removeSelected"
    >
      <i class="ri-delete-bin-line" />
    </button>
  </div>
</template>

<style lang="scss" scoped>
/* 间距（含与宿主容器的留白）由宿主容器控——这里只管自身排布 */
.ws-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 应用徽标（当前应用名 + 多应用切换下拉触发器）：ghost 钮风格 + 名字文本 */
.ws-toolbar__app {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: none;
  background: transparent;
  border-radius: var(--app-radius-button, 6px);
  color: var(--app-text-secondary);
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s, color 0.15s;

  &:hover {
    background: var(--app-bg-muted);
    color: var(--app-text-primary);
  }
}

.ws-toolbar__app-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-toolbar__app-caret {
  font-size: 13px;
  opacity: 0.7;
}

/* 与 TreePanel 树头动作钮（tree-panel__act）同款 ghost 样式——用户订单：样式复用文件树工具栏 */
.ws-toolbar__act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--app-radius-button, 6px);
  color: var(--app-text-secondary);
  cursor: pointer;
  font-size: 15px;
  transition: background 0.15s, color 0.15s;

  &:hover:not(:disabled) {
    background: var(--app-bg-muted);
    color: var(--app-text-primary);
  }
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  &--danger {
    color: var(--el-color-danger);
    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
      color: var(--el-color-danger);
    }
  }
}
</style>
