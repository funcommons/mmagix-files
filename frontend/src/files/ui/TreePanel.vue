<script lang="ts">
/** Lane H-2 type-ahead 同键接续窗口（ms）：窗口内重复同键=跳到下一个匹配（Quantum 循环口径） */
export const TYPE_AHEAD_WINDOW_MS = 500
</script>

<script setup lang="ts">
/**
 * TreePanel — 展开树（2026-10 范式：目录原位展开，VS Code 口径；Wave2-T2 起家/Lane F5 交互面）。
 * UI 直连 store：props.controller 为 FileTreeController（不依赖 setup 单例，便于测试）。
 * 交互模型：
 *  - 目录：单击名字/chevron=选中+原位展开/收起（loadDir 懒加载；激活目录 currentPath 随动，
 *    上传/新建目录/拖拽落点跟随）；双击目录=展开/收起；Alt+↓/↑=展开/收起首个选中目录；
 *  - 文件：单击=选中（ctrl/cmd 切换、shift 自锚点范围）→ emit('select')；双击/回车=emit('open')；
 *  - 行右键=上下文菜单（features.openWithMenu!==false 门控）：打开/打开方式/重命名/删除/下载/分享/
 *    历史版本（文件条目）→ emit('menu-action'/'open-with'/'open-history')
 *    （操作链在 Home 层经 workspace-ops 收口；历史版本接 VersionPanel）；
 *    空白处右键=上传/新建目录/刷新（同门控）；
 *  - 树头动作（创建簇小图标）：上传/新建目录/刷新/搜索/回收站（emit upload-request/search/trash；
 *    上传确认弹窗 UploadDialog 在 Home 层承载——面板只举手，选文件不入面板）；
 *  - 容器拖拽文件=上传 → emit('drop-files', {files, path})（enqueue+拒收 toast 在 Home 收口）；
 *  - 未加载/加载中 FcSkeleton、空态/失败态 FcEmpty(error)+重试；
 *  - 键盘流（shortcuts.ts 纯工具）：Esc=清空选中、字母/数字 type-ahead 循环跳转（500ms 接续）、
 *    双击列表空白区=全选可见行。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FcButton, FcContextMenu, FcEmpty, FcSkeleton } from '@/components/sdk'
import type { MenuItem } from '@/components/sdk/overlay/FcContextMenu.vue'
import type { AppRegistry } from '@/apps/registry'
import { normalizePrefix } from '../tree-store'
import { createWorkspaceOps } from './workspace-ops'
import type { FileTreeController } from '../tree-store'
import type { S3ObjectSummary } from '@/sdk/types'
import { isTypingTarget, matchesHotkey } from './shortcuts'

/** withDefaults 仅兜 versioning：纯 Boolean prop 缺省会被 Vue 转型为 false，而本 prop 契约是「不传=有能力」 */
const props = withDefaults(
  defineProps<{
    controller: FileTreeController
    /** 树根域（面包屑从此截断显示；默认 bucket 根） */
    rootPrefix?: string
  /** 树标题覆写（ui.treeTitle；缺省=rootPrefix 末段，根=t('files.tree.root')「根目录」） */
  treeTitle?: string
  /** 当前选中集（多选数组；父层持有并回传高亮） */
  selected?: S3ObjectSummary[]
  /** features 门控（openWithMenu/rename/delete/download/mkdir；仅显式 false 关） */
  features?: Record<string, boolean>
  /** 应用注册表（「打开方式」列全部命中应用；缺省=不出应用子列） */
  registry?: AppRegistry | null
  /** 版本能力（桶 Versioning 已开启且 client 支持）；false=隐藏回收站入口与「历史版本」菜单（订单 2026-10） */
    versioning?: boolean
  }>(),
  { versioning: true },
)

const emit = defineEmits<{
  /** 选中集变化（单击/ctrl/shift 多选） */
  select: [entries: S3ObjectSummary[]]
  /** 打开（双击文件/回车/菜单「打开」）；Home 接 preview.open */
  open: [entry: S3ObjectSummary]
  /** 「打开方式」指定应用；Home 接 preview.open(entry, { appId }) */
  'open-with': [payload: { entry: S3ObjectSummary; appId: string }]
  /** 「历史版本」（文件条目右键菜单，M3-F8）；Home 接 VersionPanel（objectKey=key） */
  'open-history': [key: string]
  /** 菜单动作（上传/重命名/删除/下载/分享/新建目录）；操作链在 Home 层收口 */
  'menu-action': [payload: { action: 'upload' | 'rename' | 'delete' | 'download' | 'share' | 'mkdir'; entry?: S3ObjectSummary }]
  /** 拖拽落文件（Home 接 queue.enqueue + 拒收 toast） */
  'drop-files': [payload: { files: File[]; path: string }]
  /** 打开全局搜索面板（树头搜索图标；面板与数据流在 Home 收口，与旧 Toolbar search 同链） */
  search: []
  /** 请求上传（树头钮/空白菜单；选文件弹窗 UploadDialog 在 Home 层，确认后才入队） */
  'upload-request': []
  /** 打开回收站抽屉（树头回收图标；数据链 listTrash/restore/purge 在 Home 收口） */
  trash: []
}>()

const { t, te } = useI18n()

/**
 * 2026-10 展开树改版：目录不再「进入」（视图切换+面包屑），而是原位展开（VS Code 口径）。
 * 树基 = 挂载期捕获的 rootPrefix（未显式传时回退 currentPath——session 起始目录；捕获一次
 * 不随 currentPath 漂移）。可见行 = 从根深度优先走 expanded 集；目录子级由 nodes 缓存懒加载。
 */
const rootPrefix = normalizePrefix(props.rootPrefix ?? props.controller.currentPath)

/** 版本能力开关（versioning!==false 即视为开；Home 层探测 Versioning 后下发）——树头回收站入口/右键「历史版本」共用 */
const versioningOn = computed(() => props.versioning !== false)

/** 已展开目录 key 集（indirection ref 保证整集替换可触发 rows 重算） */
const expanded = ref<Set<string>>(new Set())

interface Row {
  entry: S3ObjectSummary
  depth: number
}

/** 可见行序列：根起 DFS；展开的目录才下钻（未加载=懒加载挂起，不下钻不出行） */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (prefix: string, depth: number): void => {
    const b = props.controller.nodes.get(prefix)
    if (!b?.loaded) return
    for (const d of b.dirs) {
      out.push({ entry: d, depth })
      if (expanded.value.has(d.key)) walk(d.key, depth + 1)
    }
    for (const f of b.files) out.push({ entry: f, depth })
  }
  walk(rootPrefix, 0)
  return out
})
/** 可见条目序列（选中锚点/type-ahead/全选等按行交互的消费面） */
const rowEntries = computed<S3ObjectSummary[]>(() => rows.value.map((r) => r.entry))
const notLoaded = computed(() => !props.controller.nodes.get(rootPrefix)?.loaded)

/** 树头标题（基目录名；根域显示「根目录」） */
const rootName = computed(() => (rootPrefix === '' ? t('files.tree.root') : lastSeg(rootPrefix)))

/** 选中键集（高亮判定） */
const selectedKeys = computed(() => new Set((props.selected ?? []).map((s) => s.key)))

function lastSeg(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/**
 * 展开/收起目录（2026-10 展开树核心）：展开=loadDir（缓存命中不重拉；副作用=激活目录
 * currentPath 随动——上传/新建目录/拖拽落点跟随用户正在操作的目录）；收起=纯状态。
 */
function toggleDir(e: S3ObjectSummary): void {
  const next = new Set(expanded.value)
  if (next.has(e.key)) {
    next.delete(e.key)
    expanded.value = next
    return
  }
  next.add(e.key)
  expanded.value = next
  void props.controller.loadDir(e.key)
}

/** 目录名点击（.stop 防透传行点击）：完全委托行点击口径——选中 + 目录展开/收起（一次 toggle） */
function onDirNameClick(e: MouseEvent, entry: S3ObjectSummary, index: number): void {
  onRowClick(e, entry, index)
}

function retry(): void {
  void props.controller.loadDir(rootPrefix, { force: true })
}

// ── 多选与打开（Lane F5 交互模型） ──

/** 范围选择锚点（最近一次非 shift 点击的行下标） */
let anchorIndex = -1

function onRowClick(e: MouseEvent, entry: S3ObjectSummary, index: number): void {
  const list = rowEntries.value // 锚点/范围选择按当前页可见序列（v-for 下标口径一致）
  if (e.shiftKey && anchorIndex >= 0) {
    const [a, b] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex]
    emit('select', list.slice(a, b + 1))
    return
  }
  if (e.ctrlKey || e.metaKey) {
    const current = props.selected ?? []
    const next = current.some((s) => s.key === entry.key)
      ? current.filter((s) => s.key !== entry.key)
      : [...current, entry]
    anchorIndex = index
    emit('select', next)
    return
  }
  anchorIndex = index
  emit('select', [entry])
  // 展开树：单击目录行 = 选中并展开/收起（双击文件打开的口径不受影响）
  if (entry.isDir) toggleDir(entry)
}

/** 双击：文件=打开预览；目录=展开/收起（进入语义已废） */
function onRowDblClick(entry: S3ObjectSummary): void {
  if (entry.isDir) toggleDir(entry)
  else emit('open', entry)
}

/** 回车：打开首个选中文件；目录=展开/收起 */
function openFirstSelected(e: KeyboardEvent): void {
  const first = (props.selected ?? [])[0]
  if (!first) return
  e.preventDefault()
  if (first.isDir) toggleDir(first)
  else emit('open', first)
}

// ── 键盘流（Lane H-2：全部收口在本组件；组合键/焦点判定纯工具在 shortcuts.ts） ──

const listEl = ref<HTMLUListElement | null>(null)

/** Alt+↑：收起首个选中的目录（展开树语义；无目录选中=无效） */
function goParentDir(): void {
  const firstDir = (props.selected ?? []).find((s) => s.isDir)
  if (firstDir && expanded.value.has(firstDir.key)) toggleDir(firstDir)
}

/** Alt+↓：展开首个选中的目录（懒加载子级；无目录选中=无效） */
function enterFirstSelectedDir(): void {
  const firstDir = (props.selected ?? []).find((s) => s.isDir)
  if (firstDir && !expanded.value.has(firstDir.key)) toggleDir(firstDir)
}

/** type-ahead 状态：上次命中字符/时刻/下标（500ms 同键接续窗口，见 TYPE_AHEAD_WINDOW_MS） */
let typeAheadChar = ''
let typeAheadAt = 0
let typeAheadIdx = -1

/** 从 start（含）循环向后找首个 name 以 ch 开头（大小写不敏感）的条目下标；无命中=-1 */
function findTypeAhead(start: number, ch: string): number {
  const list = rowEntries.value
  for (let i = 0; i < list.length; i++) {
    const idx = (((start + i) % list.length) + list.length) % list.length
    if (list[idx]!.name.toLowerCase().startsWith(ch)) return idx
  }
  return -1
}

/** 字母/数字 type-ahead：锚点起循环跳转并选中 + 滚动到可见（jsdom 缺 scrollIntoView 走可选调用） */
function handleTypeAhead(e: KeyboardEvent): void {
  const list = rowEntries.value
  if (list.length === 0) return
  const ch = e.key.toLowerCase()
  const now = Date.now()
  const chained = ch === typeAheadChar && now - typeAheadAt <= TYPE_AHEAD_WINDOW_MS && typeAheadIdx >= 0
  const start = chained ? typeAheadIdx + 1 : Math.max(anchorIndex, 0)
  const hit = findTypeAhead(start, ch)
  if (hit < 0) {
    typeAheadChar = '' // 无匹配：断链（下次重按从锚点起算），不 emit
    return
  }
  typeAheadChar = ch
  typeAheadAt = now
  typeAheadIdx = hit
  anchorIndex = hit // 命中行成为新锚点（shift 范围选择与下一次 type-ahead 同源）
  emit('select', [list[hit]!])
  const rowEl = listEl.value?.children[hit] as HTMLElement | undefined
  rowEl?.scrollIntoView?.({ block: 'nearest' })
}

/** Esc：清空选中 + 关右键菜单（窗口级 Esc 关菜单另有既有监听，此处补列表焦点语义） */
function clearSelection(): void {
  menu.value = null
  emit('select', [])
}

/** 双击列表空白区（非行，.self 口径）：全选当前页条目 */
function onListDblClickSelf(): void {
  if (rowEntries.value.length === 0) return
  emit('select', [...rowEntries.value])
}

/**
 * 列表键盘（Lane H-2 扩展；isTypingTarget 守卫=输入焦点一律让路；已处理键均 preventDefault）：
 *  - Enter=打开首个选中（既有口径）；
 *  - Alt+↑=父目录、Alt+↓=进首个选中目录；
 *  - Esc=清空选中+关菜单；
 *  - 字母/数字（无 ctrl/meta/alt 修饰，shift 允许）=type-ahead 循环跳转。
 */
function onListKeydown(e: KeyboardEvent): void {
  if (isTypingTarget(e)) return
  if (e.key === 'Enter') {
    openFirstSelected(e)
    return
  }
  if (matchesHotkey(e, { key: 'ArrowUp', alt: true })) {
    e.preventDefault()
    goParentDir()
    return
  }
  if (matchesHotkey(e, { key: 'ArrowDown', alt: true })) {
    e.preventDefault()
    enterFirstSelectedDir()
    return
  }
  if (matchesHotkey(e, { key: 'Escape' })) {
    e.preventDefault()
    clearSelection()
    return
  }
  if (e.key.length === 1 && /[a-z0-9]/i.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    handleTypeAhead(e)
  }
}

// ── 右键菜单 ──

const menu = ref<{ entry: S3ObjectSummary; x: number; y: number } | null>(null)

function onRowContextMenu(e: MouseEvent, entry: S3ObjectSummary): void {
  if (props.features?.openWithMenu === false) return // 门控关闭：不拦截，交还浏览器默认菜单
  // macOS Chromium 把 ctrl+click 合成为 contextmenu——该组合属多选切换语义（见 onRowClick），不开菜单
  if (e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  menu.value = { entry, x: e.clientX, y: e.clientY }
}

const menuItems = computed<MenuItem[]>(() => {
  const m = menu.value
  if (!m) return []
  const f = props.features ?? {}
  const items: MenuItem[] = [
    { value: 'open', label: t('files.menu.open'), icon: m.entry.isDir ? 'ri-folder-open-line' : 'ri-eye-line' },
    // 上传到该目录（目录=其内；文件=其所在目录）
    { value: 'upload', label: t('files.menu.upload'), icon: 'ri-upload-2-line' },
  ]
  if (!m.entry.isDir) {
    const matches = props.registry?.listMatches({ name: m.entry.name, mime: m.entry.mime, size: m.entry.size }) ?? []
    if (matches.length > 1) {
      items.push({ value: '__open-with__', label: t('files.menu.open-with'), disabled: true })
      for (const def of matches) {
        // 显示名优先级（复审②修正版）：label 若是宿主词典键（内置应用 label=词典 key 约定）→ 翻译；
        // 否则视为插件自带显示名原样用（无宿主词典键时不再回显 key 原文）；无 label 回退 t('app.<id>')
        const shown = def.label ? (te(def.label) ? t(def.label) : def.label) : t(`app.${def.id}`)
        items.push({ value: `open-with:${def.id}`, label: shown, icon: 'ri-apps-2-line' })
      }
    }
  }
  if (f.rename !== false) items.push({ value: 'rename', label: t('files.menu.rename'), icon: 'ri-edit-line' })
  if (f.delete !== false) {
    items.push({ value: 'delete', label: t('files.menu.delete'), icon: 'ri-delete-bin-line', danger: true })
  }
  if (!m.entry.isDir && f.download !== false) {
    items.push({ value: 'download', label: t('files.menu.download'), icon: 'ri-download-2-line' })
  }
  // Lane H-2：分享（仅文件；目录→前缀分享列 P2，简化口径不出口）
  if (!m.entry.isDir) items.push({ value: 'share', label: t('files.menu.share'), icon: 'ri-share-line' })
  // M3-F8：历史版本（仅文件；版本列表/恢复链路在 Home 层接 VersionPanel 收口）；无版本能力不出口
  if (!m.entry.isDir && props.versioning !== false) {
    items.push({ value: 'history', label: t('files.history.menu'), icon: 'ri-history-line' })
  }
  if (f.mkdir !== false) items.push({ value: 'mkdir', label: t('files.menu.mkdir'), icon: 'ri-folder-add-line' })
  return items
})

function onMenuSelect(value: string): void {
  const m = menu.value
  menu.value = null
  if (!m) return
  if (value === 'open') {
    if (m.entry.isDir) toggleDir(m.entry)
    else emit('open', m.entry)
    return
  }
  if (value.startsWith('open-with:')) {
    emit('open-with', { entry: m.entry, appId: value.slice('open-with:'.length) })
    return
  }
  if (value === 'history') {
    emit('open-history', m.entry.key)
    return
  }
  if (value === 'upload') {
    emit('menu-action', { action: 'upload', entry: m.entry })
    return
  }
  if (value === 'rename' || value === 'delete' || value === 'download' || value === 'share' || value === 'mkdir') {
    emit('menu-action', { action: value, entry: m.entry })
  }
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    menu.value = null
    blankMenu.value = null
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

// ── 树头动作（创建簇：上传/新建目录/刷新/搜索——2026-10 布局改版自 Toolbar 移入，小图标位） ──

/** 操作链本面板自持（mkdir 即席建目录；与 Home/Toolbar 的 ops 同一 workspace-ops 收口，零复制） */
const ops = createWorkspaceOps({ tree: props.controller, t })
function refreshDir(): void {
  void props.controller.loadDir(props.controller.currentPath, { force: true })
}

// ── 空白处右键菜单（上传/新建目录/刷新；openWithMenu 门控与行菜单同口径） ──

const blankMenu = ref<{ x: number; y: number } | null>(null)

function onBlankContextMenu(e: MouseEvent): void {
  if (props.features?.openWithMenu === false) return // 门控关闭：不拦截，交还浏览器默认菜单
  if (e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  blankMenu.value = { x: e.clientX, y: e.clientY }
}

const blankMenuItems = computed<MenuItem[]>(() => {
  const f = props.features ?? {}
  const items: MenuItem[] = []
  if (f.upload !== false) items.push({ value: 'upload', label: t('files.toolbar.upload'), icon: 'ri-upload-2-line' })
  if (f.mkdir !== false) items.push({ value: 'mkdir', label: t('files.menu.mkdir'), icon: 'ri-folder-add-line' })
  items.push({ value: 'refresh', label: t('files.toolbar.refresh'), icon: 'ri-refresh-line' })
  return items
})

function onBlankMenuSelect(value: string): void {
  blankMenu.value = null
  if (value === 'upload') emit('upload-request')
  else if (value === 'mkdir') void ops.createDir()
  else if (value === 'refresh') refreshDir()
}

// ── 拖拽上传 ──

const dragDepth = ref(0)
const dragOver = computed(() => dragDepth.value > 0)

function onDrop(e: DragEvent): void {
  dragDepth.value = 0
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length === 0) return
  emit('drop-files', { files, path: props.controller.currentPath })
}

onMounted(() => {
  void props.controller.loadDir(props.controller.currentPath)
})
</script>

<template>
  <div
    class="tree-panel"
    :class="{ 'is-dragover': dragOver }"
    @dragenter.prevent="dragDepth++"
    @dragover.prevent
    @dragleave.prevent="dragDepth = Math.max(0, dragDepth - 1)"
    @drop.prevent="onDrop"
    @contextmenu="onBlankContextMenu"
  >
    <div class="tree-panel__head">
      <span class="tree-panel__title" data-testid="tree-title">{{ props.treeTitle ?? rootName }}</span>
      <!-- 树头动作（创建簇小图标，2026-10 自 Toolbar 迁入）：上传/新建目录/刷新/搜索/回收站 -->
      <span class="tree-panel__tools">
        <button
          v-if="features?.upload !== false"
          type="button"
          class="tree-panel__act"
          data-testid="tree-upload"
          :title="t('files.toolbar.upload')"
          :aria-label="t('files.toolbar.upload')"
          @click="emit('upload-request')"
        >
          <i class="ri-upload-2-line" />
        </button>
        <button
          v-if="features?.mkdir !== false"
          type="button"
          class="tree-panel__act"
          data-testid="tree-mkdir"
          :title="t('files.toolbar.mkdir')"
          :aria-label="t('files.toolbar.mkdir')"
          @click="ops.createDir()"
        >
          <i class="ri-folder-add-line" />
        </button>
        <button
          type="button"
          class="tree-panel__act"
          data-testid="tree-refresh"
          :title="t('files.toolbar.refresh')"
          :aria-label="t('files.toolbar.refresh')"
          @click="refreshDir"
        >
          <i class="ri-refresh-line" />
        </button>
        <button
          type="button"
          class="tree-panel__act"
          data-testid="tree-search"
          :title="t('search.title')"
          :aria-label="t('search.title')"
          @click="emit('search')"
        >
          <i class="ri-search-line" />
        </button>
        <!-- M3 回收站入口（2026-10 自预览头迁入树头簇；ri-recycle-line 回收语义，抽屉在 Home 承载）；
             versioning=false（桶未开版本控制/client 不支持）整入口隐藏 -->
        <button
          v-if="features?.trash !== false && versioningOn"
          type="button"
          class="tree-panel__act"
          data-testid="trash-open"
          :title="t('files.trash.title')"
          :aria-label="t('files.trash.title')"
          @click="emit('trash')"
        >
          <i class="ri-recycle-line" />
        </button>
      </span>
    </div>

    <FcSkeleton
      v-if="rows.length === 0 && notLoaded && !controller.error"
      class="tree-panel__state"
      variant="text"
      :rows="6"
    />
    <FcEmpty
      v-else-if="rows.length === 0 && notLoaded && controller.error"
      class="tree-panel__state"
      type="error"
      :title="t('files.tree.load-failed')"
      :description="controller.error.message"
    >
      <template #action>
        <FcButton variant="secondary" size="sm" @click="retry">{{ t('files.tree.retry') }}</FcButton>
      </template>
    </FcEmpty>
    <FcEmpty
      v-else-if="rows.length === 0"
      class="tree-panel__state"
      type="empty"
      :title="t('files.tree.empty')"
    />
    <ul
      v-else
      ref="listEl"
      class="tree-panel__list"
      tabindex="0"
      data-testid="tree-list"
      @keydown="onListKeydown"
      @dblclick.self="onListDblClickSelf"
    >
      <li
        v-for="(r, i) in rows"
        :key="r.entry.key"
        class="tree-panel__row"
        :class="{ 'is-dir': r.entry.isDir, 'is-selected': selectedKeys.has(r.entry.key), 'is-menu-target': menu?.entry.key === r.entry.key }"
        :style="{ paddingLeft: 10 + r.depth * 16 + 'px' }"
        data-testid="row"
        @click="onRowClick($event, r.entry, i)"
        @dblclick="onRowDblClick(r.entry)"
        @contextmenu.stop="onRowContextMenu($event, r.entry)"
      >
        <!-- 展开树：目录行 chevron（点击=展开/收起）；文件行占位对齐 -->
        <button
          v-if="r.entry.isDir"
          type="button"
          class="tree-panel__chev"
          :class="{ 'is-open': expanded.has(r.entry.key) }"
          :aria-label="t(expanded.has(r.entry.key) ? 'files.tree.dir-collapse' : 'files.tree.dir-expand')"
          @click.stop="toggleDir(r.entry)"
        >
          <i class="ri-arrow-right-s-line" />
        </button>
        <span v-else class="tree-panel__chev-spacer" />
        <i class="tree-panel__icon" :class="r.entry.isDir ? 'ri-folder-line' : 'ri-file-line'" />
        <button
          v-if="r.entry.isDir"
          type="button"
          class="tree-panel__name"
          data-testid="dir-name"
          @click.stop="onDirNameClick($event, r.entry, i)"
        >
          {{ r.entry.name }}
        </button>
        <span v-else class="tree-panel__name">{{ r.entry.name }}</span>
      </li>
    </ul>

    <!-- 分页条（Lane H3）：单页不渲染；页码纯数字+斜杠（不依赖词典）；aria-label 用纯符号；
         按钮复用 SDK 原生 button 外观类（fc-button-icon/xs=24px 方形图标钮） -->

    <FcContextMenu
      :visible="menu !== null"
      :pos="menu ? { x: menu.x, y: menu.y } : { x: 0, y: 0 }"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
    <!-- 空白处右键菜单（上传/新建目录/刷新；行内右键已 .stop 不至此） -->
    <FcContextMenu
      :visible="blankMenu !== null"
      :pos="blankMenu ? { x: blankMenu.x, y: blankMenu.y } : { x: 0, y: 0 }"
      :items="blankMenuItems"
      @select="onBlankMenuSelect"
      @close="blankMenu = null"
    />
  </div>
</template>

<style lang="scss" scoped>
.tree-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--app-text-primary);

  &.is-dragover {
    outline: 2px dashed var(--el-color-primary, var(--brand-primary, #409eff));
    outline-offset: -4px;
    background: var(--brand-primary-soft, var(--el-color-primary-light-9));
  }
}

.tree-panel__head {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--app-section-border-color);
}

.tree-panel__title {
  font-weight: 600;
  font-size: 13px;
  color: var(--app-text-primary);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tree-panel__tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.tree-panel__chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: var(--app-text-tertiary);
  cursor: pointer;
  font-size: 14px;
  transition: transform 0.15s, background 0.15s, color 0.15s;

  &:hover {
    background: var(--app-bg-muted);
    color: var(--app-text-primary);
  }
  &.is-open {
    transform: rotate(90deg);
  }
}

.tree-panel__chev-spacer {
  flex: none;
  width: 18px;
}

.tree-panel__act {
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

  &:hover {
    background: var(--app-bg-muted);
    color: var(--app-text-primary);
  }
}

.tree-panel__crumb.is-current {
  font-weight: 600;
  color: var(--app-text-primary);
}

.tree-panel__crumb-sep {
  color: var(--app-text-tertiary);
}

.tree-panel__state {
  padding: 24px 0;
}

.tree-panel__list {
  flex: 1;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow: auto;

  &:focus {
    outline: none;
  }
}

.tree-panel__row {
  display: grid;
  /* 展开树 3 列：chevron | 图标 | 名称（2026-10 二次精简：大小/类型列不显示；单元格左对齐） */
  grid-template-columns: 16px 18px minmax(0, 1fr);
  align-items: center;
  justify-items: start;
  gap: 6px;
  padding: 2px;
  border-radius: var(--app-radius-md, 8px);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--brand-bg-hover, var(--app-bg-muted, rgba(0, 0, 0, 0.04)));
  }

  &.is-selected {
    background: var(--brand-primary-soft, var(--el-color-primary-light-9));
  }

  /* 右键菜单目标：实线外框叠加（菜单关闭即随 menu ref 清除） */
  &.is-menu-target {
    outline: 2px solid var(--app-primary);
    outline-offset: -2px;
  }
}

.tree-panel__icon {
  font-size: 16px;
  color: var(--app-text-tertiary);

  .is-dir & {
    color: var(--el-color-warning);
  }
}

.tree-panel__name {
  /* 目录名=原生 button（不复用 fc-button 外观类，避免 32px 按钮高度撑高行）；
     与文件名 span 同类名同样式，padding 2px 紧凑口径 */
  padding: 2px;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;

  &:hover {
    color: var(--el-color-primary);
  }
}
</style>
