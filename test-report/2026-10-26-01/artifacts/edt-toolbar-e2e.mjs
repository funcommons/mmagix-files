/**
 * 统一编辑工具栏 E2E（一百四十三番）：demo 装载 → 宿主直传 fixtures → 双击验证
 *  1. code-editor（fixture .ts）：簇四钮 data-act 就位、编辑→保存钮红点 is-dirty、无「未保存」文字、
 *     重置→红点清+重置自锁、再弄脏→保存链走通
 *  2. flow-editor（fixture .mmd graph TD）：flow-save/flow-reset testid 透传、加形状→红点、重置→清
 */
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const require = createRequire('/Users/justin/codes/funcommons/mmagix-files/frontend/package.json')
const { chromium } = require('@playwright/test')

const TS_FIXTURE = 'ws-edt-143.ts'
const MMD_FIXTURE = 'ws-edt-143.mmd'
const tsPath = join(tmpdir(), TS_FIXTURE)
const mmdPath = join(tmpdir(), MMD_FIXTURE)
writeFileSync(tsPath, 'const answer = 42\n')
writeFileSync(mmdPath, 'graph TD\n  A[开始] --> B[过程]\n  B --> C{判定}\n')

const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1676, height: 930 } })
  page.on('dialog', (d) => d.accept())
  await page.goto('http://localhost:5200/embed/play')
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /装载/ }).first().click()
  await page.waitForSelector('iframe', { timeout: 15000 })
  await page.waitForFunction(() => document.body.textContent?.includes('已就绪'), { timeout: 40000 })
  await page.waitForTimeout(1500)

  // 宿主直传 fixtures（两文件一次队列）
  await page.locator('input[type="file"]').first().setInputFiles([tsPath, mmdPath])
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /uploadFiles（files/ }).first().click()
  await page.waitForTimeout(2500)

  const f = () => page.frames().find((fr) => fr.url().startsWith('http://localhost:5199'))
  const node = (name) => f().locator('span, div').filter({ hasText: new RegExp('^' + name + '$') }).last()

  // ── code-editor 面 ──
  await node(TS_FIXTURE).dblclick()
  await f().waitForSelector('.mmagic-code', { timeout: 20000 })
  await page.waitForTimeout(1000)

  const acts = await f().locator('.mmagic-code-bar .mmx-edt [data-act]').evaluateAll((els) => els.map((e) => e.dataset.act))
  ok('code: 簇四钮就位', JSON.stringify(acts) === JSON.stringify(['save', 'undo', 'redo', 'reset']), acts.join(','))
  const saveBtn = f().locator('.mmagic-code-bar [data-act="save"]')
  const resetBtn = f().locator('.mmagic-code-bar [data-act="reset"]')
  ok('code: 初始重置禁用', await resetBtn.isDisabled())

  await f().locator('.mmagic-code-stage .monaco-editor').click()
  await page.keyboard.type('X')
  await page.waitForTimeout(500)
  ok('code: 编辑后保存钮红点', await saveBtn.evaluate((e) => e.classList.contains('is-dirty')))
  const barText = await f().locator('.mmagic-code-bar').innerText()
  ok('code: 无「未保存」文字', !barText.includes('未保存') && !barText.includes('Unsaved'))

  await resetBtn.click()
  await page.waitForTimeout(400)
  ok('code: 重置后红点清', !(await saveBtn.evaluate((e) => e.classList.contains('is-dirty'))))
  ok('code: 重置后重置钮自锁', await resetBtn.isDisabled())

  await f().locator('.mmagic-code-stage .monaco-editor').click()
  await page.keyboard.type('Y')
  await page.waitForTimeout(400)
  await saveBtn.click()
  await page.waitForTimeout(1200)
  ok('code: 保存链走通（红点清）', !(await saveBtn.evaluate((e) => e.classList.contains('is-dirty'))))

  // 关 tab（Esc 不关则走右上角关闭钮；容忍残留）
  const closeBtn = f().locator('.mmagic-code-bar button, .ws-tabs [aria-label], .ws-tabs button').filter({ hasText: /×|close/i })
  if (await closeBtn.count()) await closeBtn.first().click().catch(() => {})
  await page.waitForTimeout(600)

  // ── flow-editor 面 ──
  await node(MMD_FIXTURE).dblclick()
  await f().waitForSelector('.mmagic-flow', { timeout: 20000 })
  await page.waitForTimeout(1000)

  const facts = await f().locator('.mmagic-flow .mmx-edt [data-act]').evaluateAll((els) => els.map((e) => e.dataset.act))
  ok('flow: 簇四钮就位', JSON.stringify(facts) === JSON.stringify(['save', 'undo', 'redo', 'reset']), facts.join(','))
  const fSave = f().locator('.mmagic-flow [data-testid="flow-save"]')
  const fReset = f().locator('.mmagic-flow [data-testid="flow-reset"]')
  ok('flow: testid 透传', (await fSave.count()) === 1 && (await fReset.count()) === 1)

  await f().locator('[data-testid="flow-shape-btn"]').click()
  await page.waitForTimeout(300)
  await f().locator('[data-testid="flow-kind-process"]').click()
  await page.waitForTimeout(500)
  ok('flow: 加形状后红点', await fSave.evaluate((e) => e.classList.contains('is-dirty')))
  ok('flow: 无「未保存」文字', !(await f().locator('.mmagic-flow__bar').innerText()).includes('未保存'))

  await fReset.click()
  await page.waitForTimeout(600)
  ok('flow: 重置后红点清+自锁', !(await fSave.evaluate((e) => e.classList.contains('is-dirty'))) && (await fReset.isDisabled()))

  await page.screenshot({ path: 'test-report/2026-10-26-01/artifacts/edt-toolbar-final.png' })
} catch (err) {
  console.log('FATAL', String(err).slice(0, 300))
  results.push({ name: 'fatal', pass: false })
} finally {
  await browser.close()
}

const fails = results.filter((r) => !r.pass)
console.log(`\n== EDT TOOLBAR E2E: ${results.length - fails.length}/${results.length} pass ==`)
process.exit(fails.length ? 1 : 0)
