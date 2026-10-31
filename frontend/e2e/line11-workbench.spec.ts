/**
 * 业务线 11 —— 工作台交互面（Lane F5）：右键菜单（open-with）/ 拖拽上传 / 多选批量删除 /
 * UploadPanel 取消 / 粘贴上传（Lane G1）。
 * 期望（手册「双击/回车打开」交互模型 + §一 features）：
 *  - 行右键 → 菜单（打开/打开方式▸应用子列/重命名/删除/下载/新建目录），open-with 指定应用打开预览；
 *  - 容器 drop → queue.enqueue(当前目录) → PUT + 入树 + 上传面板终态；
 *  - ctrl 多选 → 下载批量语义启用 → 删除走多选确认（{n} 文案）→ 两对象一并 DeleteObjects；
 *  - 上传中任务取消钮可见 → 取消 → 「已取消」终态；
 *  - 粘贴（clipboardData.files）→ 入队当前目录 → PUT + 传输面板终态（Lane G1）；
 *  - 预览 Tab 条（Lane H1）：预览态原位替换 / 双击钉住 / 钉住后并存 / 点切回内容恢复（wb-06）；
 *  - 分享生成器（Lane H-2）：选中文件 → 工具栏分享 → GET/PUT 预签名链接含 X-Amz-Signature（wb-07）。
 * （双击=打开预览由业务线 3/9 与 warmup 的 dblclick 改造覆盖，此处不重复。）
 */
import os from 'node:os'
import { test, expect } from '@playwright/test'
import { configUrl, workspaceConfig, MOCK_PREFIX } from './fixtures/config'
import { installS3Mock } from './fixtures/s3-mock'
import { defaultSeed } from './fixtures/seed'
import {
  attachConsole,
  confirmMessageBox,
  consoleEvidence,
  openRow,
  shot,
  toolbarButton,
  waitTreeLoaded,
} from './fixtures/host'

/** 上传弹窗流（2026-10：上传先弹窗确认）：点树头「上传」→ 弹窗拖放区 input 灌文件 → 确认入队 */
async function dialogUpload(
  root: import('@playwright/test').FrameLocator | import('@playwright/test').Page,
  files: Parameters<import('@playwright/test').Locator['setInputFiles']>[0],
) {
  await root.locator('[data-testid="tree-upload"]').click()
  await root.locator('[data-testid="upload-dialog-zone"] input[type="file"]').setInputFiles(files)
  await root.locator('[data-testid="upload-dialog-confirm"]').click()
}

/** 打开传输任务中心（2026-10：并入上传弹窗「传输」页签）：点预览头传输钮 → 弹窗内任务面板可见 */
async function openTransfers(root: import('@playwright/test').FrameLocator | import('@playwright/test').Page) {
  await root.locator('[data-testid="transfers-open"]').click()
  await expect(root.locator('[data-testid="upload-panel"]')).toBeVisible()
}

async function openWorkspace(
  page: import('@playwright/test').Page,
  opts: { delayPutKeys?: Record<string, number> } = {},
) {
  const state = await installS3Mock(page, { seed: defaultSeed(), delayPutKeys: opts.delayPutKeys })
  await page.goto(configUrl(workspaceConfig()))
  await waitTreeLoaded(page)
  return state
}

/**
 * 多选修饰键：macOS 上 Control+click 被 Chromium 合成为右键（contextmenu，无 click 事件），
 * 组件侧 ctrl/meta 等价（onRowClick: ctrlKey || metaKey），故 mac 用 Meta、其余用 Control。
 */
const MULTI_MODIFIER = os.platform() === 'darwin' ? 'Meta' : 'Control'

test.describe('业务线11：工作台交互面（Lane F5）', () => {
  test('wb-01：行右键 → 菜单出现（打开/打开方式/重命名/删除/下载/新建目录），open-with 指定应用打开', async ({ page }) => {
    const cap = attachConsole(page)
    await openWorkspace(page)

    // csv 命中两个应用（csv-table 默认 + code-editor）→「打开方式」下应列应用子列
    await page.locator('[data-testid="row"]', { hasText: 'data.csv' }).click({ button: 'right' })
    const menu = page.locator('.fc-menu')
    await expect(menu).toBeVisible()
    for (const label of ['打开', '打开方式', '重命名', '删除', '下载', '新建目录']) {
      await expect(menu.locator('button', { hasText: label }).first()).toBeVisible()
    }
    await expect(menu.locator('button', { hasText: '表格视图' })).toBeVisible()
    await expect(menu.locator('button', { hasText: '代码编辑' })).toBeVisible()

    // open-with → preview.open(entry, {appId:'code-editor'}) → Monaco 渲染 csv
    await menu.locator('button', { hasText: '代码编辑' }).click()
    await expect(menu).toBeHidden() // 选中后自动关
    await expect(page.locator('.ws__preview-host .monaco-editor')).toBeVisible({ timeout: 30_000 })
    await shot(page, 'wb-01-context-menu-open-with-pass.png', false)
    console.log('[wb-01] console 证据：\n' + consoleEvidence(cap))
  })

  test('wb-02：容器拖拽 drop → enqueue 当前目录 → PUT + 入树 + 上传面板完成态', async ({ page }) => {
    const cap = attachConsole(page)
    const state = await openWorkspace(page)

    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['dropped via e2e dnd'], 'dropped-dnd.txt', { type: 'text/plain' }))
      return dt
    })
    await page.locator('.tree-panel').dispatchEvent('drop', { dataTransfer })

    // PUT 到当前目录 + 树出现新文件 + 上传面板终态「已完成」
    await expect
      .poll(async () => state.putRequests.includes(`${MOCK_PREFIX}dropped-dnd.txt`), { timeout: 15_000 })
      .toBe(true)
    await expect(page.locator('[data-testid="row"]', { hasText: 'dropped-dnd.txt' })).toBeVisible({ timeout: 10_000 })
    await openTransfers(page)
    const panel = page.locator('[data-testid="upload-panel"]')
    await expect(panel.locator('[data-testid="upload-item"]', { hasText: 'dropped-dnd.txt' })).toContainText('已完成')
    await shot(page, 'wb-02-dragdrop-upload-pass.png')
    console.log('[wb-02] console 证据：\n' + consoleEvidence(cap))
  })

  test('wb-03：ctrl 多选 → 批量下载钮启用 → 删除走 {n} 多选确认 → 两对象一并删除', async ({ page }) => {
    const cap = attachConsole(page)
    const state = await openWorkspace(page)

    await page.locator('[data-testid="row"]', { hasText: 'README.md' }).click()
    // 2026-10 布局：选中簇仅在已开 tab 时显示——先打开文件再批量选
    await openRow(page, 'README.md')
    await page.locator('[data-testid="row"]', { hasText: 'notes.txt' }).click({ modifiers: [MULTI_MODIFIER] })

    // 多选（均非目录）→「下载」启用（批量打包语义）；重命名按首项可用
    await expect(toolbarButton(page, '下载')).toBeEnabled()
    await expect(toolbarButton(page, '重命名')).toBeEnabled()

    await toolbarButton(page, '删除').click()
    // 多选确认文案（delete-multi-confirm {n}），非单文件名确认
    await expect(page.locator('.el-message-box')).toContainText('确定删除选中的 2 项')
    await confirmMessageBox(page)

    await expect(page.locator('[data-testid="row"]', { hasText: 'README.md' })).toHaveCount(0)
    await expect(page.locator('[data-testid="row"]', { hasText: 'notes.txt' })).toHaveCount(0)
    const deleted = state.deleteRequests.flat()
    expect(deleted).toContain(`${MOCK_PREFIX}README.md`)
    expect(deleted).toContain(`${MOCK_PREFIX}notes.txt`)
    await shot(page, 'wb-03-multi-delete-pass.png')
    console.log('[wb-03] console 证据：\n' + consoleEvidence(cap))
  })

  test('wb-04：上传中任务取消钮可见 → 取消 → 「已取消」终态（UploadPanel）', async ({ page }) => {
    const cap = attachConsole(page)
    await openWorkspace(page, { delayPutKeys: { [`${MOCK_PREFIX}slow.txt`]: 8000 } })

    await dialogUpload(page, [
      { name: 'quick.txt', mimeType: 'text/plain', buffer: Buffer.from('quick') },
      { name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('slow payload') },
    ])
    await openTransfers(page)
    const panel = page.locator('[data-testid="upload-panel"]')
    await expect(panel.locator('[data-testid="upload-item"]', { hasText: 'quick.txt' })).toContainText('已完成', {
      timeout: 10_000,
    })

    const slowItem = panel.locator('[data-testid="upload-item"]', { hasText: 'slow.txt' })
    const cancelBtn = slowItem.locator('[data-testid="upload-cancel"]')
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()
    await expect(slowItem).toContainText('已取消', { timeout: 5_000 })
    // 取消后清记录钮可用（终态存在）且清除后面板消失
    await panel.locator('[data-testid="upload-clear"]').click()
    await expect(panel).toBeHidden()
    await shot(page, 'wb-04-upload-cancel-pass.png', false)
    console.log('[wb-04] console 证据：\n' + consoleEvidence(cap))
  })

  // Lane G1 粘贴上传：window 'paste'（features.upload 门控）→ clipboardData.files 入队当前目录。
  test('wb-05：粘贴文件 → 入队当前目录 → PUT + 传输面板完成态（Lane G1）', async ({ page }) => {
    const cap = attachConsole(page)
    const state = await openWorkspace(page)

    await page.locator('body').evaluate((body) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['pasted via e2e clipboard'], 'pasted-clip.txt', { type: 'text/plain' }))
      body.ownerDocument.defaultView!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }))
    })

    await expect
      .poll(async () => state.putRequests.includes(`${MOCK_PREFIX}pasted-clip.txt`), { timeout: 15_000 })
      .toBe(true)
    await expect(page.locator('[data-testid="row"]', { hasText: 'pasted-clip.txt' })).toBeVisible({ timeout: 10_000 })
    await openTransfers(page)
    const panel = page.locator('[data-testid="upload-panel"]')
    await expect(panel.locator('[data-testid="upload-item"]', { hasText: 'pasted-clip.txt' })).toContainText('已完成')
    await shot(page, 'wb-05-paste-upload-pass.png', false)
    console.log('[wb-05] console 证据：\n' + consoleEvidence(cap))
  })

  // Lane H1 预览 Tab 条（OpenVSCode 预览态模型）：连开两文件 → 激活 tab 未钉住被原位替换（预览态）→
  // 双击钉住 → 再开新文件 → 两 tab 并存 → 点回被钉 tab 内容恢复（preview.open 重跑 + savedState 回注）。
  test('wb-06：预览 tab 条——追加制多开 / 双击钉住 / 切回恢复（Lane H1，2026-10 追加制定版）', async ({ page }) => {
    const cap = attachConsole(page)
    await openWorkspace(page)

    // 首开 README.md → tab 条出现，1 个 tab 且激活
    await openRow(page, 'README.md')
    const tabs = page.locator('[data-testid="preview-tabs"]')
    await expect(tabs).toBeVisible()
    await expect(tabs.locator('[data-testid="preview-tab"]')).toHaveCount(1)
    const readmeTab = tabs.locator('[data-testid="preview-tab"]', { hasText: 'README.md' })
    await expect(readmeTab).toHaveClass(/is-active/)

    // 再开 data.csv：追加制 → 恒追加（两 tab 并存），csv 激活且表格渲染
    await openRow(page, 'data.csv')
    await expect(page.locator('.mmagic-csv-table')).toBeVisible({ timeout: 30_000 })
    await expect(tabs.locator('[data-testid="preview-tab"]')).toHaveCount(2)
    const csvTab = tabs.locator('[data-testid="preview-tab"]', { hasText: 'data.csv' })
    await expect(csvTab).toHaveClass(/is-active/)

    // 双击 csv tab → 钉住（图钉出现，防 LRU 淘汰）
    await csvTab.dblclick()
    await expect(csvTab.locator('[data-testid="preview-tab-pin"]')).toBeVisible()

    // 再开 notes.txt：恒追加（三 tab 并存），notes 激活
    await openRow(page, 'notes.txt')
    await expect(tabs.locator('[data-testid="preview-tab"]')).toHaveCount(3)
    const notesTab = tabs.locator('[data-testid="preview-tab"]', { hasText: 'notes.txt' })
    await expect(notesTab).toHaveClass(/is-active/)

    // 点回 csv tab → 内容恢复（表格重渲染 + 激活态迁移）
    await csvTab.click()
    await expect(page.locator('.mmagic-csv-table')).toBeVisible({ timeout: 30_000 })
    await expect(csvTab).toHaveClass(/is-active/)
    await expect(page.locator('.mmagic-csv-table tbody', { hasText: 'Alice' })).toBeVisible()
    await shot(page, 'wb-06-preview-tabs-pass.png', false)
    console.log('[wb-06] console 证据：\n' + consoleEvidence(cap))
  })

  // Lane H-2 分享生成器：选中文件 → 工具栏「分享」→ 生成 → GET/PUT 预签名链接含 X-Amz-Signature。
  // 查询串 SigV4 纯本地签名（client.presignedUrl 零网络），mock S3 对分享链路零感知。
  test('wb-07：选中文件 → 分享 → GET/PUT 预签名链接生成（含 X-Amz-Signature）（Lane H-2）', async ({ page }) => {
    const cap = attachConsole(page)
    await openWorkspace(page)

    await page.locator('[data-testid="row"]', { hasText: 'README.md' }).click()
    await openRow(page, 'README.md') // 选中簇仅在已开 tab 时显示
    await toolbarButton(page, '分享').click()
    const dialog = page.locator('[data-testid="share-dialog"]')
    await expect(dialog).toBeVisible()

    // 默认有效期（1 小时）直接生成 → GET/PUT 两行只读链接，签名参数齐全
    await dialog.locator('[data-testid="share-generate"]').click()
    const getUrl = dialog.locator('[data-testid="share-get-url"]')
    await expect(getUrl).toBeVisible()
    const getValue = await getUrl.inputValue()
    expect(getValue).toContain(`${MOCK_PREFIX}README.md`)
    for (const part of ['X-Amz-Algorithm=AWS4-HMAC-SHA256', 'X-Amz-Expires=3600', 'X-Amz-SignedHeaders=host', 'X-Amz-Signature=']) {
      expect(getValue).toContain(part)
    }
    const putValue = await dialog.locator('[data-testid="share-put-url"]').inputValue()
    expect(putValue).toContain(`${MOCK_PREFIX}README.md`)
    expect(putValue).toContain('X-Amz-Signature=')

    // 换 7 天档 → 旧链接清空，再生成按新有效期；本 harness 会话 TTL=3600s，
    // client 按口径钳制（预签名不比凭证活得久）→ X-Amz-Expires 恒 3600。
    // 回归 #6 判责注：查询串 SigV4 为确定性 HMAC——钳制后两次签名的
    // method/key/expires/credentials 全同源，唯一可变输入是 X-Amz-Date（秒粒度）。
    // 同秒内重生成两链逐字节相同是正确语义（非缓存 bug），故先跨秒等待 >1s
    // 再重生成，断言「时间进位 → 签名重算与首链不同」。
    await dialog.locator('input[type="radio"]').nth(2).check()
    await expect(getUrl).toBeHidden()
    await page.waitForTimeout(1100) // 跨过 X-Amz-Date 秒粒度（确定性签名下唯一可变输入）
    await dialog.locator('[data-testid="share-generate"]').click()
    await expect(getUrl).toBeVisible()
    const regenValue = await getUrl.inputValue()
    expect(regenValue).toContain('X-Amz-Expires=3600') // TTL 钳制语义
    expect(regenValue).not.toBe(getValue) // X-Amz-Date 进位 → 签名重算（与首链不同）

    await shot(page, 'wb-07-share-dialog-pass.png', false)
    console.log('[wb-07] console 证据：\n' + consoleEvidence(cap))
  })

  // R2-01（P1）⌘K 命令面板可达：mod+k 绑定上移 App.vue（原唯一绑定在死代码 AppLayout）。
  // 顺带覆盖：R2-07 冷启动空结果引导行（索引 0 条 → search.index-hint 提示行）、
  // cmd:transfers 命令（statusbar.transfers 词条 → 滚动定位上传面板 + 短暂高亮）。
  test('wb-08：⌘K/Ctrl+K 唤起命令面板 → 冷索引引导行 → Esc 关闭 → 「传输任务」命令定位高亮传输面板', async ({ page }) => {
    const cap = attachConsole(page)
    const MOD_KEY = os.platform() === 'darwin' ? 'Meta' : 'Control'
    // 慢上传在途 → 传输面板可见（cmd:transfers 执行后可断言高亮）
    await openWorkspace(page, { delayPutKeys: { [`${MOCK_PREFIX}slow.txt`]: 12000 } })
    await dialogUpload(page, [
      { name: 'quick.txt', mimeType: 'text/plain', buffer: Buffer.from('quick') },
      { name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('slow payload') },
    ])
    await openTransfers(page)
    const panel = page.locator('[data-testid="upload-panel"]')
    await expect(panel.locator('[data-testid="upload-item"]', { hasText: 'quick.txt' })).toContainText('已完成', {
      timeout: 10_000,
    })

    // ① mod+k → 面板出现
    await page.keyboard.press(`${MOD_KEY}+k`)
    const paletteInput = page.locator('.fc-cp input.fc-cp__input')
    await expect(page.locator('.fc-cp')).toBeVisible()
    await expect(paletteInput).toBeFocused()

    // ② R2-07：文件模式输入 → 索引 0 条（冷启动）→ 引导行（index-hint + 扫描动作）而非裸空态
    await paletteInput.fill('md')
    const hintRow = page.locator('.fc-cp__item', { hasText: '索引范围' })
    await expect(hintRow).toBeVisible()
    await expect(hintRow).toContainText('扫描当前前缀')

    // ③ Escape 关闭
    await page.keyboard.press('Escape')
    await expect(page.locator('.fc-cp')).toBeHidden()

    // ④ cmd:transfers：命令模式 >传输 → 「传输任务」命令 → 回车执行 → 传输弹窗（任务面板可见）
    await page.keyboard.press(`${MOD_KEY}+k`)
    await expect(page.locator('.fc-cp')).toBeVisible()
    await paletteInput.fill('>传输')
    const transfersCmd = page.locator('.fc-cp__item', { hasText: '传输任务' })
    await expect(transfersCmd).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.fc-cp')).toBeHidden()
    // 2026-10：任务中心并入上传弹窗「传输」页签——命令直达弹窗内任务面板（此前=底部面板高亮）
    await expect(page.locator('[data-testid="upload-panel"]')).toBeVisible()

    await shot(page, 'wb-08-command-palette-pass.png', false)
    console.log('[wb-08] console 证据：\n' + consoleEvidence(cap))
  })
})
