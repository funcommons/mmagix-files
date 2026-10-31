/**
 * 业务线 5 —— 上传：setInputFiles→PutObject→uploadDone 事件；denyExts/超限拒收 toast；
 * 重名冲突确认（Lane G1：head 探测 → ElMessageBox 覆盖/跳过）。
 * 期望（用户手册 §一）：params.uploadMaxBytes 超限前端拒收；denyExts 命中拒收；上传成功入树。
 */
import { test, expect } from '@playwright/test'
import { hostConfigUrl, workspaceConfig, MOCK_PREFIX } from './fixtures/config'
import { installS3Mock } from './fixtures/s3-mock'
import { defaultSeed } from './fixtures/seed'
import {
  attachConsole,
  consoleEvidence,
  findEvent,
  shot,
  toolbarButton,
} from './fixtures/host'

const floc = (page: import('@playwright/test').Page) => page.frameLocator('#mmf')

/** 上传弹窗流（2026-10：上传先弹窗确认）：点树头「上传」→ 弹窗拖放区 input 灌文件 → 确认入队 */
async function dialogUpload(
  root: import('@playwright/test').FrameLocator | import('@playwright/test').Page,
  files: Parameters<import('@playwright/test').Locator['setInputFiles']>[0],
) {
  await root.locator('[data-testid="tree-upload"]').click()
  await root.locator('[data-testid="upload-dialog-zone"] input[type="file"]').setInputFiles(files)
  await root.locator('[data-testid="upload-dialog-confirm"]').click()
}

async function openHostWorkspace(page: import('@playwright/test').Page, cfgOverrides: Record<string, unknown> = {}) {
  const state = await installS3Mock(page, { seed: defaultSeed() })
  await page.goto(hostConfigUrl(workspaceConfig(cfgOverrides)))
  await page.frameLocator('#mmf').locator('[data-testid="row"]').first().waitFor({ timeout: 30_000 })
  return state
}

test.describe('业务线5：上传', () => {
  test('up-01：上传 txt → PUT + uploadDone 事件 + 树自动刷新出现新文件（F6 修复验证）', async ({ page }) => {
    const cap = attachConsole(page)
    const state = await openHostWorkspace(page)
    const frame = floc(page)

    await dialogUpload(frame, {
      name: 'uploaded.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('uploaded via e2e\n', 'utf8'),
    })
    // PUT 到当前目录（根 prefix）+ uploadDone 事件
    await expect.poll(async () => state.putRequests.includes(`${MOCK_PREFIX}uploaded.txt`), { timeout: 15_000 }).toBe(true)
    const evt = await findEvent(page, 'uploadDone')
    expect(evt.payload).toMatchObject({ key: `${MOCK_PREFIX}uploaded.txt` })

    // F6 修复后契约：上传终态接树刷新（hooks.onDone → loadDir force）——免手动刷新即出现。
    // 修复前佐证（up-01a-after-upload-no-refresh.png）：上传完成后树无新文件，需手动刷新。
    await expect(frame.locator('[data-testid="row"]', { hasText: 'uploaded.txt' })).toBeVisible({ timeout: 10_000 })
    await shot(page, 'fix-upload-tree-autorefresh.png')

    // 手动刷新仍可用（幂等复核：刷新后行保持）
    await toolbarButton(frame, '刷新').click()
    await expect(frame.locator('[data-testid="row"]', { hasText: 'uploaded.txt' })).toBeVisible()
    await shot(page, 'up-01b-after-refresh-pass.png')
    console.log('[up-01] 修复验证：上传完成后新文件免手动刷新直接出现在树中（F6 已修）')
    console.log('[up-01] console 证据：\n' + consoleEvidence(cap))
  })

  test('up-02：denyExts 命中（.exe）→ 拒收 toast，无 PUT', async ({ page }) => {
    const cap = attachConsole(page)
    const state = await openHostWorkspace(page, { permissions: { denyExts: ['exe'] } })
    const frame = floc(page)

    await dialogUpload(frame, {
      name: 'evil.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZfakebinary'),
    })
    await expect(page.frameLocator('#mmf').locator('.el-message', { hasText: '拒收' })).toBeVisible({ timeout: 10_000 })
    expect(state.putRequests.filter((k) => k.endsWith('evil.exe'))).toHaveLength(0)
    await shot(page, 'up-02-deny-ext-toast-pass.png', false)
    console.log('[up-02] console 证据：\n' + consoleEvidence(cap))
  })

  test('up-03：uploadMaxBytes 超限 → 拒收 toast（size），无 PUT', async ({ page }) => {
    const cap = attachConsole(page)
    const state = await openHostWorkspace(page, { params: { uploadMaxBytes: 10 } })
    const frame = floc(page)

    await dialogUpload(frame, {
      name: 'big.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(1024, 'a'),
    })
    await expect(page.frameLocator('#mmf').locator('.el-message', { hasText: '拒收' })).toBeVisible({ timeout: 10_000 })
    expect(state.putRequests.filter((k) => k.endsWith('big.txt'))).toHaveLength(0)
    await shot(page, 'up-03-size-limit-toast-pass.png', false)
    console.log('[up-03] console 证据：\n' + consoleEvidence(cap))
  })

  // Lane G1：UI 上传显式 onConflict → 队列 head 探测重名 → ElMessageBox 三按钮（覆盖/跳过/关闭）。
  // notes.txt 在种子中已存在（HEAD 命中）；跳过 → 不 PUT；覆盖 → PUT 覆盖 + uploadDone。
  test('up-04：重名冲突确认 → 跳过不 PUT，覆盖后 PUT + uploadDone（Lane G1）', async ({ page }) => {
    const cap = attachConsole(page)
    const state = await openHostWorkspace(page)
    const frame = floc(page)
    const conflictKey = `${MOCK_PREFIX}notes.txt`

    // ① 跳过：对话框出现（文件名冲突 + {n} 文案）→ 点「跳过」→ 无 PUT、无面板行
    await dialogUpload(frame, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('conflict probe', 'utf8'),
    })
    const box = page.frameLocator('#mmf').locator('.el-message-box')
    await expect(box).toBeVisible({ timeout: 10_000 })
    await expect(box).toContainText('文件名冲突')
    await expect(box).toContainText('同名文件')
    // R2-04：第三态「取消上传」的可见入口——message 体提示行（弱化样式）说明「关闭窗口=取消整批」
    await expect(box.locator('.conflict-abort-hint')).toBeVisible()
    await expect(box.locator('.conflict-abort-hint')).toContainText('取消上传')
    await expect(box.locator('.conflict-abort-hint')).toContainText('关闭')
    await box.locator('button', { hasText: '跳过' }).click()
    await expect(box).toBeHidden()
    await expect.poll(async () => state.putRequests.filter((k) => k === conflictKey).length, { timeout: 5_000 }).toBe(0)
    const panel = page.frameLocator('#mmf').locator('[data-testid="upload-panel"]')
    await expect(panel.locator('[data-testid="upload-item"]', { hasText: 'notes.txt' })).toHaveCount(0)
    await shot(page, 'up-04a-conflict-skip-no-put.png', false)

    // ② 覆盖：同名再传 → 点「覆盖」→ PUT 覆盖 + uploadDone + 面板终态
    await dialogUpload(frame, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('overwritten via e2e\n', 'utf8'),
    })
    await expect(page.frameLocator('#mmf').locator('.el-message-box')).toBeVisible({ timeout: 10_000 })
    await page.frameLocator('#mmf').locator('.el-message-box__btns button.el-button--primary').click()
    await expect.poll(async () => state.putRequests.filter((k) => k === conflictKey).length, { timeout: 15_000 }).toBe(1)
    const evt = await findEvent(page, 'uploadDone')
    expect(evt.payload).toMatchObject({ key: conflictKey })
    // 2026-10：任务中心并入上传弹窗「传输」页签——开传输页签后断言终态
    await frame.locator('[data-testid="transfers-open"]').click()
    await expect(panel.locator('[data-testid="upload-item"]', { hasText: 'notes.txt' })).toContainText('已完成', {
      timeout: 10_000,
    })
    await shot(page, 'up-04b-conflict-overwrite-put-pass.png')
    console.log('[up-04] console 证据：\n' + consoleEvidence(cap))
  })
})
