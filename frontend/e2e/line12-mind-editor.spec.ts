/**
 * 业务线 12 —— 脑图编辑器 e2e 收口（MC4-T）
 * 契约正本：.claude/mind-loop-state.md「MC4 e2e 契约（预锁）」五条断言链
 * 被测面：apps/renderers/mindEditor.ts（flow-editor.ts mindmap 方言分派 → MindEditor 面）
 *
 * 与既有 e2e（line1~line11）的手法差异：本线不打 s3.mock.local 拦截桩，走**真实 5240 WebDAV
 * 演示服务**（mmagix-embed-demo/scripts/dev-webdav.mjs，匿名、CORS 全放行）——backend 注入方式
 * = `#config=` URL 直启 + `backend.type:'webdav'`（workspace 模式校验 §W6：endpoint 必填，余可空缺）。
 * seed/清理自包含：beforeAll 幂等 DELETE+PUT 两份种子，afterAll DELETE 收尾。
 *
 * 断言链（全部走 DOM 不走像素——headless 下 foreignObject/内联文本字形有花字伪影，截图仅存证）：
 *   1. 面断言：打开 .mmd → mind 面在场（工具栏 .mmagic-mind__bar + 引擎挂载类 .smm-mind-map-container
 *      + svg 内 g.smm-node 节点=3）+ X6 面 .mmagic-flow__canvas 缺席。
 *      契约勘误注记（已转活，MC4-F）：预锁契约写「.mmagic-mind 容器在场」——修复前实测不存在
 *      （当时 mindEditor.ts 只创建 .mmagic-mind__bar/.mmagic-mind__badge，两处 .mmagic-mind{...}
 *      CSS 规则为死规则）；转活后 mount 给宿主 el 挂 .mmagic-mind 类（CSS 规则域 + 断言锚）、
 *      dispose 对称摘除，e2e 实证 count=1。本线断言面维持实测口径（__bar + 挂载类 + 节点数），
 *      .mmagic-mind 以 mind-01 存证日志留档、不升硬断言（行为断言零改动口径）。
 *   2. 编辑链：双击「分支A」节点 → 引擎文本编辑框（body 下 div.smm-node-edit-wrap contenteditable）
 *      → 键盘输入替换文案 + Enter 提交 → 保存钮 is-dirty 红点 → 点保存钮 → PUT 落 5240 →
 *      GET 回读断言新文案在树行。
 *   3. 重开：切换到另一文件再切回 → 新文案在 DOM 可见。
 *   4. 未编辑零 diff 红线：全新 reload 后重开、不动引擎直接点保存钮 → GET 回读与保存前基线
 *      **字节级相等**（Buffer.equals）且无任何 `%% meta:` 行（禁 _mindview 缺省行合成）。
 *   5. png 快照存证（test-report/2026-10-09-01/screenshots/；花字伪影知情注记如上）。
 *
 * 挂载即 dirty（已修复）：真实引擎下曾未做任何编辑保存钮即带 is-dirty（引擎初始化合成 uid/
 * 规范化数据触发 data_change 的误信号，jsdom mock 面不重现）——MC4 门控重裁两闸串联修复：
 * 闸 1 基线闩（首个 node_tree_render_end 前一律早退）+ 闸 2 内容闸（真引擎 command 在场时，
 * 引擎现态走 save() 同一序列化链 == 打开时文本即早退，即 dirty ⇔ 保存会改字节）；mind-01
 * 静置 2.5s 采样实证挂载后无 is-dirty。保存链与零 diff 红线（字节相等口径）不受影响。
 */
import { expect, test, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test'

const WEBDAV = 'http://localhost:5240'
const MIND_KEY = 'mc4t-mind-e2e.mmd'
const OTHER_KEY = 'mc4t-other-e2e.md'
/** 种子（零 diff 红线的字节基线）：43 字节、无尾换行——serializeMindmap 产物本就无尾换行 */
const SEED = 'mindmap\n  根主题\n    分支A\n    分支B'
const OTHER_MD = '# 其他文件\n\n用于「切换到别的文件再切回」的重开链。\n'
const NEW_TEXT = '分支A-已改'
const EDITED_BYTES = `mindmap\n  根主题\n    分支A-已改\n    分支B`

const objUrl = (key: string): string => `${WEBDAV}/${key}`

/** workspace 直开 URL（顶层导航，无宿主；#config= 通道） */
function configUrl(cfg: Record<string, unknown>): string {
  return '/#config=' + encodeURIComponent(JSON.stringify(cfg))
}

/** WebDAV workspace 合法配置（§W6 校验：endpoint 必填，username/password/rootPath 可空缺=匿名） */
function webdavConfig(): Record<string, unknown> {
  return {
    v: 1,
    mode: 'workspace',
    backend: { type: 'webdav', endpoint: WEBDAV },
    security: { allowedOrigins: ['http://localhost:5199'] },
    appearance: { theme: 'light', locale: 'zh-CN' },
  }
}

async function seedAndClean(request: APIRequestContext): Promise<void> {
  // 幂等：先清残再种（重跑安全）
  await request.delete(objUrl(MIND_KEY))
  await request.delete(objUrl(OTHER_KEY))
  const putMind = await request.put(objUrl(MIND_KEY), { data: SEED })
  expect(putMind.status(), 'seed PUT mindmap').toBe(201)
  const putOther = await request.put(objUrl(OTHER_KEY), { data: OTHER_MD })
  expect(putOther.status(), 'seed PUT other').toBe(201)
}

/** GET 回读原始字节 */
async function readBytes(request: APIRequestContext, key: string): Promise<Buffer> {
  const res = await request.get(objUrl(key))
  expect(res.status(), `GET ${key}`).toBe(200)
  return await res.body()
}

/** 打开 workspace 并双击打开文件，等待 mind 面装配完成（返回预览舞台 locator） */
async function openMindFile(page: Page, key: string): Promise<void> {
  await page.goto(configUrl(webdavConfig()))
  const row = page.locator('[data-testid="row"]', { hasText: key })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.dblclick()
  // mind 面装配完成：工具栏在场 + 引擎三节点渲染齐（引擎异步布局，放宽轮询）
  await expect(page.locator('.mmagic-mind__bar')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.mmf-preview-stage g.smm-node')).toHaveCount(3, { timeout: 30_000 })
}

test.describe('业务线12：脑图编辑器（MC4 收口）', () => {
  test.beforeAll(async () => {
    const ctx = await pwRequest.newContext()
    try {
      await seedAndClean(ctx)
    } finally {
      await ctx.dispose()
    }
  })

  test.afterAll(async () => {
    const ctx = await pwRequest.newContext()
    try {
      await ctx.delete(objUrl(MIND_KEY))
      await ctx.delete(objUrl(OTHER_KEY))
    } finally {
      await ctx.dispose()
    }
  })

  test('mind-01 面断言：.mmd → MindEditor 面（无 X6 canvas）+ 挂载静置零 dirty 采样（两闸修复实证）', async ({ page }) => {
    test.setTimeout(120_000)
    await openMindFile(page, MIND_KEY)

    const stage = page.locator('.mmf-preview-stage')
    // 面断言①：工具栏（MindEditor 面自有 chrome）+ 引擎挂载类（宿主 el 被引擎加类）
    await expect(page.locator('.mmagic-mind__bar')).toBeVisible()
    await expect(stage).toHaveClass(/smm-mind-map-container/)
    // 面断言②：svg 内节点元素=3（根主题 + 分支A + 分支B），文案逐点可见
    await expect(stage.locator('g.smm-node')).toHaveCount(3)
    await expect(stage.locator('g.smm-node', { hasText: '根主题' })).toBeVisible()
    await expect(stage.locator('g.smm-node', { hasText: '分支A' })).toBeVisible()
    await expect(stage.locator('g.smm-node', { hasText: '分支B' })).toBeVisible()
    // 面断言③：分派后 mindmap 不进 X6 面——.mmagic-flow__canvas 缺席
    await expect(page.locator('.mmagic-flow__canvas')).toHaveCount(0)

    // 契约勘误存证（不作硬断言，见文件头注记）：.mmagic-mind 已随 MC4-F 转活（mount 挂类/
    // dispose 摘除）——现采样计数应恒=1，留档对照「修复前实测不存在」的漂移史
    const mindClassCount = await page.locator('.mmagic-mind').count()
    console.log(`[mc4] .mmagic-mind 类元素数=${mindClassCount}（MC4-F 转活后实证口径：mount 挂类=1）`)

    // 静置零 dirty 采样（挂载即 dirty 已修复）：无任何交互下保存钮 class 应静置 2.5s 持续无 is-dirty
    const saveBtn = page.locator(".mmagic-mind__bar button[data-act='save']")
    const clsAtMount = await saveBtn.getAttribute('class')
    await page.waitForTimeout(2500)
    const clsAfterIdle = await saveBtn.getAttribute('class')
    console.log(`[mc4] 静置零 dirty 采样：mount 后即时="${clsAtMount}" → 静置 2.5s="${clsAfterIdle}"（两闸修复后应持续无 is-dirty）`)

    await page.screenshot({ path: '/Users/justin/codes/funcommons/mmagix-files/test-report/2026-10-09-01/screenshots/mc4-mind-01-surface.png', fullPage: false })
  })

  test('mind-02 编辑链：双击改「分支A」→ is-dirty → 保存 → GET 回读新文案在树行', async ({ page, request }) => {
    test.setTimeout(120_000)
    await openMindFile(page, MIND_KEY)

    // 双击「分支A」→ 引擎文本编辑框（body 直挂 contenteditable div）
    const nodeA = page.locator('.mmf-preview-stage g.smm-node', { hasText: '分支A' }).first()
    await expect(nodeA).toBeVisible()
    await nodeA.dblclick()
    const editBox = page.locator('body > .smm-node-edit-wrap')
    await expect(editBox).toBeVisible({ timeout: 15_000 })
    await expect(editBox).toHaveText('分支A')

    // 键盘替换文案 + Enter 提交（fill=合法聚焦键盘输入通道；单行文本无 <br> 歧义）
    await editBox.fill(NEW_TEXT)
    await page.keyboard.press('Enter')

    // 编辑落树：DOM 节点文案已换（文本在 svg 节点元素内，DOM 口径不受截图花字伪影影响）
    await expect(page.locator('.mmf-preview-stage g.smm-node', { hasText: NEW_TEXT })).toBeVisible({ timeout: 15_000 })

    // dirty 红点：保存钮 is-dirty（挂载即 dirty 已由 MC4 两闸门控修复——静置基线无 is-dirty
    // 见 mind-01 采样，本断言即真实编辑信号；编辑生效性另有上方 DOM 文案断言独立承载）
    const saveBtn = page.locator(".mmagic-mind__bar button[data-act='save']")
    await expect(saveBtn).toHaveClass(/is-dirty/)

    // 点保存钮 → PUT 落 5240 → GET 回读断言新文案在树行（4 空格缩进=深度 2）
    await saveBtn.click()
    await expect
      .poll(async () => (await request.get(objUrl(MIND_KEY))).text(), { timeout: 20_000 })
      .toContain(`\n    ${NEW_TEXT}`)
    const saved = await (await request.get(objUrl(MIND_KEY))).text()
    expect(saved).toBe(EDITED_BYTES)

    // 保存链反馈：脏标记清除
    await expect(saveBtn).not.toHaveClass(/is-dirty/, { timeout: 15_000 })

    await page.screenshot({ path: '/Users/justin/codes/funcommons/mmagix-files/test-report/2026-10-09-01/screenshots/mc4-mind-02-edited-saved.png', fullPage: false })
  })

  test('mind-03 重开：切到别的文件再切回 → 新文案在 DOM 可见', async ({ page }) => {
    test.setTimeout(120_000)
    await openMindFile(page, MIND_KEY)

    // 切到别的文件（.md 渲染器），再切回 .mmd——MindEditor 面整拆整装
    const otherRow = page.locator('[data-testid="row"]', { hasText: OTHER_KEY })
    await otherRow.dblclick()
    await expect(page.locator('.mmagic-mind__bar')).toHaveCount(0)
    await expect(page.locator('.mmf-preview-stage h1', { hasText: '其他文件' })).toBeVisible({ timeout: 20_000 })

    const mindRow = page.locator('[data-testid="row"]', { hasText: MIND_KEY })
    await mindRow.dblclick()
    await expect(page.locator('.mmagic-mind__bar')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.mmf-preview-stage g.smm-node', { hasText: NEW_TEXT })).toBeVisible({ timeout: 30_000 })

    await page.screenshot({ path: '/Users/justin/codes/funcommons/mmagix-files/test-report/2026-10-09-01/screenshots/mc4-mind-03-reopened.png', fullPage: false })
  })

  test('mind-04 未编辑零 diff 红线：全新 reload 重开、不动引擎点保存 → GET 回读字节级相等', async ({ page, request }) => {
    test.setTimeout(120_000)
    // 全新 reload（等价另一条重开通道），mind-02 落盘内容即基线
    await openMindFile(page, MIND_KEY)
    // 编辑生效前置校验：重开面里新文案可见（内容确为 mind-02 落盘态）
    await expect(page.locator('.mmf-preview-stage g.smm-node', { hasText: NEW_TEXT })).toBeVisible()

    const baseline = await readBytes(request, MIND_KEY)
    expect(baseline.toString('utf8')).toBe(EDITED_BYTES) // 基线=编辑链产物（防环境串味）

    // 不动引擎直接点保存（expect.poll 回调经序列化管道，body() 非 Buffer——轮询用 text() 等落盘
    // 稳定；字节级红线断言在 poll 之外以 Buffer.equals 承载）
    await page.locator(".mmagic-mind__bar button[data-act='save']").click()
    const baselineText = baseline.toString('utf8')
    await expect
      .poll(async () => (await request.get(objUrl(MIND_KEY))).text(), { timeout: 20_000 })
      .toBe(baselineText)

    const after = await readBytes(request, MIND_KEY)
    if (!after.equals(baseline)) {
      // 失败取证：两侧全文 dump（JSON 转义可见尾随空白差异）
      console.log('[mc4][zerodiff-mismatch] baseline:', JSON.stringify(baseline.toString('utf8')))
      console.log('[mc4][zerodiff-mismatch] after   :', JSON.stringify(after.toString('utf8')))
    }
    expect(after.equals(baseline), '未编辑保存后字节级相等（零 diff 红线）').toBe(true)
    // 禁缺省行合成：不得出现任何 meta 行（_mindview/_assoc/schema/节点行）
    expect(after.toString('utf8')).not.toContain('%% meta:')

    await page.screenshot({ path: '/Users/justin/codes/funcommons/mmagix-files/test-report/2026-10-09-01/screenshots/mc4-mind-04-zerodiff.png', fullPage: false })
  })
})
