/**
 * 统一编辑工具栏 截图取证·第二批：html-editor（三态）/ univer xlsx / pdf-annotator / filerobot（偏差存档）
 */
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const require = createRequire('/Users/justin/codes/funcommons/mmagix-files/frontend/package.json')
const { chromium } = require('@playwright/test')
const reqPdf = createRequire('/Users/justin/codes/funcommons/mmagix-files/frontend/plugins/pdf-annotator/package.json')

const DIR = 'test-report/2026-10-26-01/artifacts'
const browser = await chromium.launch()

// fixtures：pdf（pdf-lib 生成）+ png（canvas 生成）
const { PDFDocument } = reqPdf('pdf-lib')
const pdfDoc = await PDFDocument.create()
const p1 = pdfDoc.addPage([595, 842])
p1.drawText('mmagix edt toolbar fixture', { x: 60, y: 760, size: 18 })
const pdfBytes = await pdfDoc.save()
const pdfPath = join(tmpdir(), 'ws-edt-143.pdf')
writeFileSync(pdfPath, pdfBytes)

const ctxPage = await browser.newPage()
const dataUrl = await ctxPage.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 480
  c.height = 320
  const g = c.getContext('2d')
  g.fillStyle = '#3b82f6'
  g.fillRect(0, 0, 480, 320)
  g.fillStyle = '#fff'
  g.font = 'bold 40px sans-serif'
  g.fillText('EDIT ME', 130, 170)
  return c.toDataURL('image/png')
})
const pngPath = join(tmpdir(), 'ws-edt-143.png')
writeFileSync(pngPath, Buffer.from(dataUrl.split(',')[1], 'base64'))
await ctxPage.close()

const page = await browser.newPage({ viewport: { width: 1676, height: 930 } })
page.on('dialog', (d) => d.accept())
const logs = []
page.on('pageerror', (e) => logs.push(e.message.slice(0, 90)))

await page.goto('http://localhost:5200/embed/play')
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /装载/ }).first().click()
await page.waitForSelector('iframe', { timeout: 15000 })
await page.waitForFunction(() => document.body.textContent?.includes('已就绪'), { timeout: 40000 })
await page.waitForTimeout(1500)

// 宿主直传 fixtures
await page.locator('input[type="file"]').first().setInputFiles([pdfPath, pngPath])
await page.waitForTimeout(800)
await page.getByRole('button', { name: /uploadFiles（files/ }).first().click()
await page.waitForTimeout(2500)

const f = () => page.frames().find((fr) => fr.url().startsWith('http://localhost:5199'))
// 树行定位：必须锚定 .tree-panel 的 li 行——通用 span/div 文本匹配会命中已开 tab 的同名标题（右键落空的前因）
const node = (name) => f().locator('.tree-panel [data-testid="row"]').filter({ hasText: new RegExp('^' + name + '$') }).last()
async function shotBar(tag, barSel) {
  const bar = f().locator(barSel).first()
  const box = await bar.boundingBox()
  if (box) await page.screenshot({ path: `${DIR}/shot-${tag}-bar.png`, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 10), width: 680, height: 120 } })
  await page.screenshot({ path: `${DIR}/shot-${tag}-full.png` })
}
/** 应用切换：workspace 工具栏应用徽标（toolbar-app-badge，EP dropdown trigger=click）→ 菜单项目标 app */
async function openWith(file, appId) {
  await node(file).dblclick()
  await page.waitForTimeout(2000)
  await f().locator('[data-testid="toolbar-app-badge"]').click()
  await page.waitForTimeout(700)
  const item = f().locator(`li[data-testid="toolbar-app-${appId}"]`)
  if (!(await item.count())) {
    console.log(`  openWith(${appId}) → NO_ITEM`)
    return
  }
  await item.click()
  console.log(`  openWith(${appId}) → OK`)
  await page.waitForTimeout(3000)
}

// ── 1. html-editor 三态（ws-page.html）──
await node('ws-page.html').dblclick()
await page.waitForTimeout(2500)
if (!(await f().evaluate(() => !!document.querySelector(".mm-html-root")))) await openWith("ws-page.html", "html-editor")
console.log('html mounted:', await f().evaluate(() => !!document.querySelector('.mm-html-root')))
// 源码态：敲字弄脏
await f().locator('.mm-html-pane[data-active="true"] .cm-content').click().catch(() => {})
await page.keyboard.type('<!-- x -->')
await page.waitForTimeout(500)
console.log('html source dirty =', await f().evaluate(() => document.querySelector('[data-act="save"]')?.classList.contains('is-dirty')))
await shotBar('html-source', '.mm-html-toolbar')
// 可视态：簇仍在（非只读）；离态重排确认条（自定义 confirm bar）需点确认
async function acceptRewrite() {
  const yes = f().locator('.mm-html-confirm[data-active="true"] button.is-primary')
  if (await yes.count()) {
    await yes.click()
    await page.waitForTimeout(1200)
  }
}
await f().locator('.mm-html-modes button[data-mode="wysiwyg"]').click()
await page.waitForTimeout(1500)
await acceptRewrite()
console.log('html wysiwyg cluster hidden =', await f().evaluate(() => document.querySelector('.mmx-edt')?.classList.contains('is-readonly')))
await shotBar('html-wysiwyg', '.mm-html-toolbar')
// 预览态：整簇隐藏（is-readonly）
await f().locator('.mm-html-modes button[data-mode="preview"]').click()
await page.waitForTimeout(1200)
await acceptRewrite()
console.log('html preview cluster readonly =', await f().evaluate(() => document.querySelector('.mmx-edt')?.classList.contains('is-readonly')))
await shotBar('html-preview', '.mm-html-toolbar')

// ── 2. univer xlsx ──
await node('ws-style-1792482250.xlsx').dblclick()
await page.waitForTimeout(2500)
if (!(await f().evaluate(() => !!document.querySelector(".mmu-univer-root")))) await openWith("ws-style-1792482250.xlsx", "univer-office")
await page.waitForTimeout(6000)
const cell = f().locator('.mmu-univer-root canvas').first()
if (await cell.count()) {
  await cell.click()
  await page.keyboard.type('99')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
}
console.log('univer xlsx dirty =', await f().locator('.mmu-univer-root [data-act="save"]').evaluate((e) => e.classList.contains('is-dirty')).catch(() => 'ERR'))
await shotBar('univer-xlsx', '.mmu-univer-root .mmx-edt')

// ── 3. pdf-annotator ──
await node('ws-edt-143.pdf').dblclick()
await page.waitForTimeout(2500)
if (!(await f().evaluate(() => !!document.querySelector("[style*=\"crosshair\"]")))) await openWith("ws-edt-143.pdf", "pdf-annotator")
await page.waitForTimeout(4000)
// 矩形工具 + 画布拖拽 → 标注 → dirty
const rectBtn = f().locator('button').filter({ hasText: /矩形/ }).first()
if (await rectBtn.count()) {
  await rectBtn.click()
  await page.waitForTimeout(300)
  const ov = f().locator('div[style*="crosshair"]').first()
  const b = await ov.boundingBox()
  if (b) {
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.35, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(600)
  }
}
console.log('pdf dirty =', await f().evaluate(() => {
  const s = document.querySelector('[data-act="save"]')
  return s ? s.classList.contains('is-dirty') : 'NO CLUSTER'
}))
// pdf 工具栏 div 无类名：以簇为锚截图（簇本体 + 周边工具区）
const pdfCluster = f().locator('.mmx-edt').last()
const pcb = await pdfCluster.boundingBox()
if (pcb) await page.screenshot({ path: `${DIR}/shot-pdf-bar.png`, clip: { x: Math.max(0, pcb.x - 8), y: Math.max(0, pcb.y - 10), width: 680, height: 60 } })
await page.screenshot({ path: `${DIR}/shot-pdf-full.png` })

// ── 4. filerobot（偏差存档：内核 UI，无自建簇）──
await node('ws-edt-143.png').dblclick()
await page.waitForTimeout(2500)
if (!(await f().evaluate(() => !!document.querySelector('.fie-root') || !!document.querySelector('[class*="FIE_topbar"]')))) {
  await openWith("ws-edt-143.png", "filerobot-image-editor")
  await page.waitForTimeout(6000)
}
console.log('filerobot kernel UI =', await f().evaluate(() => !!document.querySelector('.fie-root') || !!document.querySelector('[class*="FIE_topbar"]')))
await page.waitForTimeout(2000)
await page.screenshot({ path: `${DIR}/shot-filerobot-full.png` })

console.log('errors:', logs.length ? logs.join(' | ') : 'none')
await browser.close()
