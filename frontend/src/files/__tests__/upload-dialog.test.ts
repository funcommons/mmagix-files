/**
 * UploadDialog 测试（2026-10 订单：上传先弹窗，确认后才入队）。
 * 契约：目标目录展示（dir||'/'）；FcDropZone 拖放吐文件入清单（可移除）；
 * 确认按钮空清单禁用、非空 emit confirm(File[]) + update:open(false)；取消只关门不入队；
 * 每次打开清空上次选择（目标目录可能已变）。
 * 测试环境：全局空词典 i18n（t 直返键名，不回显参数）→ 文案断言认键名，数量断言认行数；
 * el-dialog 内容懒渲染（visible 翻转后 v-if 才挂）→ 统一 open=false 挂载再 setProps 翻转；
 * teleport 桩：FcDialog→el-dialog append-to-body，stub 后原地渲染可 find。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import UploadDialog from '../ui/UploadDialog.vue'

const mkFile = (name: string, size: number): File =>
  new File(['x'.repeat(Math.max(0, size - 1)) || 'x'], name, { type: 'text/plain' })

/** 拖放入清单（FcDropZone @drop → addFiles）；dataTransfer.files 走 extractFilesFromDataTransfer 主路径 */
async function dropFiles(w: VueWrapper, files: File[]): Promise<void> {
  await w.find('[data-testid="upload-dialog-zone"]').trigger('drop', {
    dataTransfer: { files, items: [] },
  })
}

const rows = (w: VueWrapper) => w.findAll('[data-testid="upload-dialog-file"]')
const confirmBtn = (w: VueWrapper) => w.find('[data-testid="upload-dialog-confirm"]')
const countEl = (w: VueWrapper) => w.find('[data-testid="upload-dialog-count"]')
const targetEl = (w: VueWrapper) => w.find('[data-testid="upload-dialog-target"]')

/** 直挂 open=true 内容不渲染（el-dialog 懒渲染）——false 挂载后翻转开启；slots 可注传输页签内容 */
async function mountOpen(
  props: { open?: boolean; dir: string; tab?: 'upload' | 'transfer' } = { dir: 'docs/' },
  slots: Record<string, string> = {},
) {
  const w = mount(UploadDialog, {
    props: { open: false, ...props },
    slots,
    global: { stubs: { teleport: true } },
  })
  await w.setProps({ open: true })
  return w
}

describe('UploadDialog（上传确认弹窗：目录展示 + 选文件 + 确认门）', () => {
  it('open=false 不渲染弹窗内容；开启后渲染目标目录 + 计数键 + 空清单禁用确认', async () => {
    const w = mount(UploadDialog, { props: { open: false, dir: 'docs/' }, global: { stubs: { teleport: true } } })
    expect(w.find('[data-testid="upload-dialog-zone"]').exists()).toBe(false)
    await w.setProps({ open: true })
    const target = targetEl(w)
    expect(target.exists()).toBe(true)
    expect(target.text()).toContain('docs/')
    expect(target.text()).toContain('files.upload.dialog-target')
    expect(countEl(w).text()).toContain('files.upload.dialog-selected')
    expect(confirmBtn(w).attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('拖放 2 文件 → 2 行（名/大小）确认解禁；root 目录空串显示 /', async () => {
    const w = await mountOpen({ dir: '' })
    expect(targetEl(w).text()).toContain('/') // 空串 → 根
    await dropFiles(w, [mkFile('a.txt', 3), mkFile('b.png', 1572864)])
    const rs = rows(w)
    expect(rs).toHaveLength(2)
    expect(rs[0]!.text()).toContain('a.txt')
    expect(rs[1]!.text()).toContain('b.png')
    expect(rs[1]!.text()).toContain('1.5 MB') // 1024 进制一位小数
    expect(confirmBtn(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('移除单行：✕ 后清单联动；清到 0 重新禁用确认', async () => {
    const w = await mountOpen({ dir: 'docs/' })
    await dropFiles(w, [mkFile('a.txt', 3), mkFile('b.txt', 3)])
    await rows(w)[0]!.find('[data-testid="upload-dialog-file-remove"]').trigger('click')
    const rs = rows(w)
    expect(rs).toHaveLength(1)
    expect(rs[0]!.text()).toContain('b.txt')
    await rows(w)[0]!.find('[data-testid="upload-dialog-file-remove"]').trigger('click')
    expect(rows(w)).toHaveLength(0)
    expect(confirmBtn(w).attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('确认：emit confirm(File[])（顺序保持）+ update:open(false) 关门（重开传输页签由 Home 编排）；取消：只关门不 emit confirm', async () => {
    const f1 = mkFile('a.txt', 3)
    const f2 = mkFile('b.txt', 3)
    const w = await mountOpen({ dir: 'root/x/' }, { transfer: '<div data-testid="slot-tasks">TASKS</div>' })
    await dropFiles(w, [f1, f2])
    await confirmBtn(w).trigger('click')
    const confirmed = w.emitted('confirm')
    expect(confirmed).toHaveLength(1)
    const out = confirmed?.[0]?.[0] as File[]
    expect(out.map((f) => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(w.emitted('update:open')).toEqual([[false]])
    w.unmount()

    const w2 = await mountOpen({ dir: 'root/x/' })
    await dropFiles(w2, [f1])
    await w2.find('[data-testid="upload-dialog-cancel"]').trigger('click')
    expect(w2.emitted('confirm')).toBeUndefined()
    expect(w2.emitted('update:open')).toEqual([[false]])
    w2.unmount()
  })

  it('重开清空：关门后再次开启 → 清单归零、目录换新（陈旧选择不残留）', async () => {
    const w = await mountOpen({ dir: 'docs/' })
    await dropFiles(w, [mkFile('a.txt', 3)])
    expect(rows(w)).toHaveLength(1)
    await w.setProps({ open: false })
    await w.setProps({ open: true, dir: 'other/' })
    expect(rows(w)).toHaveLength(0)
    expect(countEl(w).text()).toContain('files.upload.dialog-selected')
    expect(targetEl(w).text()).toContain('other/')
    w.unmount()
  })

  it('双 Tab（上传|传输）：默认落上传页（确认钮在上传页）；点击「传输」切页渲染 #transfer 槽、无确认钮；tab=transfer 直落传输页', async () => {
    // 默认：上传页——拖放区 + 确认钮在
    const w = await mountOpen({ dir: 'docs/' }, { transfer: '<div data-testid="slot-tasks">TASKS</div>' })
    expect(w.find('[data-testid="upload-dialog-zone"]').exists()).toBe(true)
    expect(confirmBtn(w).exists()).toBe(true)
    expect(w.find('[data-testid="slot-tasks"]').exists()).toBe(false)
    // 点「传输」段钮（FcSegmented option button）→ 上传内容收起、槽内容渲染、确认钮消失（取消仍在）
    const segBtns = w.findAll('.fc-segmented__item')
    expect(segBtns).toHaveLength(2)
    await segBtns[1]!.trigger('click')
    expect(w.find('[data-testid="upload-dialog-zone"]').exists()).toBe(false)
    expect(w.find('[data-testid="slot-tasks"]').exists()).toBe(true)
    expect(confirmBtn(w).exists()).toBe(false)
    expect(w.find('[data-testid="upload-dialog-cancel"]').exists()).toBe(true)
    // 切回上传页：内容与确认钮恢复
    await w.findAll('.fc-segmented__item')[0]!.trigger('click')
    expect(w.find('[data-testid="upload-dialog-zone"]').exists()).toBe(true)
    expect(confirmBtn(w).exists()).toBe(true)
    w.unmount()

    // tab=transfer 打开直落传输页
    const w2 = await mountOpen({ dir: 'docs/', tab: 'transfer' }, { transfer: '<div data-testid="slot-tasks2">TASKS2</div>' })
    expect(w2.find('[data-testid="upload-dialog-zone"]').exists()).toBe(false)
    expect(w2.find('[data-testid="slot-tasks2"]').exists()).toBe(true)
    expect(confirmBtn(w2).exists()).toBe(false)
    w2.unmount()
  })
})
