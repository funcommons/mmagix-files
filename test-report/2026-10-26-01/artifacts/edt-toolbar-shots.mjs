/**
 * 统一编辑工具栏 截图取证（一百四十三番）：各可编辑应用实拍
 * code-editor / flow-editor / markdown-editor 插件 / univer-office 插件（docx）
 * 每应用：弄脏 → 工具栏区特写（红点可见）+ 全页截图。
 */
import { createRequire } from 'module'
const require = createRequire('/Users/justin/codes/funcommons/mmagix-files/frontend/package.json')
const { chromium } = require('@playwright/test')

const DIR = 'test-report/2026-10-26-01/artifacts'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1676, height: 930 } })
page.on('dialog', (d) => d.accept())
const logs = []
page.on('pageerror', (e) => logs.push('PAGEERR ' + e.message.slice(0, 100)))

await page.goto('http://localhost:5200/embed/play')
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /装载/ }).first().click()
await page.waitForSelector('iframe', { timeout: 15000 })
await page.waitForFunction(() => document.body.textContent?.includes('已就绪'), { timeout: 40000 })
await page.waitForTimeout(1500)

const f = () => page.frames().find((fr) => fr.url().startsWith('http://localhost:5199'))
const node = (name) => f().locator('span, div').filter({ hasText: new RegExp('^' + name + '$') }).last()
const frameOrigin = { x: 0, y: 0 }

/** 工具栏特写：预览区左上 640×130（iframe 在宿主里的偏移自动换算） */
async function shotBar(tag, barSel) {
  const bar = f().locator(barSel).first()
  const box = await bar.boundingBox()
  if (box) {
    await page.screenshot({
      path: `${DIR}/shot-${tag}-bar.png`,
      clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 10), width: 680, height: 120 },
    })
  }
  await page.screenshot({ path: `${DIR}/shot-${tag}-full.png` })
}

// ── 1. code-editor ──
await node('ws-edt-143.ts').dblclick()
await f().waitForSelector('.mmagic-code', { timeout: 20000 })
await page.waitForTimeout(1200)
await f().locator('.mmagic-code-stage .monaco-editor').click()
await page.keyboard.type('X')
await page.waitForTimeout(500)
await shotBar('code', '.mmagic-code-bar')
console.log('code dirty =', await f().locator('[data-act="save"]').evaluate((e) => e.classList.contains('is-dirty')))
// 关 tab：Esc + 点第二个 tab 前先存
await f().locator('[data-act="save"]').click()
await page.waitForTimeout(800)

// ── 2. flow-editor ──
await node('ws-edt-143.mmd').dblclick()
await f().waitForSelector('.mmagic-flow', { timeout: 20000 })
await page.waitForTimeout(1200)
await f().locator('[data-testid="flow-shape-btn"]').click()
await page.waitForTimeout(300)
await f().locator('[data-testid="flow-kind-process"]').click()
await page.waitForTimeout(500)
await shotBar('flow', '.mmagic-flow__bar')
console.log('flow dirty =', await f().locator('[data-testid="flow-save"]').evaluate((e) => e.classList.contains('is-dirty')))

// ── 3. markdown-editor 插件（hello.md）──
await node('hello.md').dblclick()
await page.waitForTimeout(3000)
const isMd = await f().evaluate(() => !!document.querySelector('.mm-md-root'))
if (!isMd) {
  // 顶部应用切换器 → Markdown 编辑
  const sw = f().locator('button').filter({ hasText: /预览|编辑/ }).last()
  await sw.click().catch(() => {})
  await page.waitForTimeout(500)
  await f().locator('button, li').filter({ hasText: /Markdown 编辑/ }).last().click().catch(() => {})
  await page.waitForTimeout(2500)
}
await f().locator('.cm-content').click()
await page.keyboard.type('X')
await page.waitForTimeout(500)
await shotBar('md', '.mm-md-toolbar')
console.log('md dirty =', await f().evaluate(() => document.querySelector('[data-mm-save]')?.classList.contains('is-dirty')))

// ── 4. univer-office 插件（docx）──
await node('用户权益中台设计.docx').dblclick()
await page.waitForTimeout(9000) // univer 首载重
const hasUniver = await f().evaluate(() => !!document.querySelector('.mmu-univer-root'))
if (hasUniver) {
  // 弄脏：点进文档画布敲字（doc.mutation → dirty）
  await f().locator('.mmu-univer-root canvas').first().click()
  await page.keyboard.type('X')
  await page.waitForTimeout(1200)
  await shotBar('univer', '.mmu-univer-root .mmx-edt')
  console.log('univer dirty =', await f().locator('.mmu-univer-root [data-act="save"]').evaluate((e) => e.classList.contains('is-dirty')))
} else {
  console.log('univer: 未挂载（插件开关未开？）')
}

console.log('errors:', logs.length ? logs.join(' | ') : 'none')
await browser.close()
