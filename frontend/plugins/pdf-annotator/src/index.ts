/**
 * PDF 标注签批插件（方案 V1.0 P1+P2+P3）：pdf.js 渲染 + 每页覆盖层（矩形/文字(CJK图章化)/画笔/签名图章/
 * AcroForm 表单控件），保存=pdf-lib 压平写回原字节（不改原内容流）。sidecar 标注层显式导出/导入
 * （schema=v1，P3 归并：createdAt 定序、id 冲突保留双份）。契约同 univer-office：activate(sdk)。
 * 坐标纪律：模型=PDF 用户空间 pt（y 左下）；屏幕↔模型换算唯一出口 toModel()/scale。
 */
import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { PDFDocument } from 'pdf-lib'
import { flattenAnnotations, smoothPoints } from './exporter'
import { applyFormValuesAndFlatten, hasXFA, inspectFields, type FieldInfo } from './form'
import { mergeAnnotations, parseSidecar, sidecarKeyOf, toSidecar } from './sidecar'
import { createEditToolbar } from '../../../src/shared/editToolbar'
import type { Annotation, HostCtx, HostFile, HostInstance, HostSdk } from './types'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const COLORS = ['#dc2626', '#2563eb', '#16a34a', '#d97706']
const AUTHOR = 'annotator@session'
const SIGN_KEY = 'pdf-annotator.signature'

export function activate(sdk: HostSdk): void {
  sdk.registerApp({
    id: 'pdf-annotator',
    matcher: { ext: ['pdf'] },
    label: 'app.pdf-annotator',
    actions: ['edit'],
    version: '1.1.0',
    requiresSdk: 1,
    maxBytes: 50 * 1024 * 1024,
    renderer: render,
  })
}

/** 预检失败卡（加密/损坏：§8.1/§8.5，不向宿主抛出） */
function failCard(el: HTMLElement, title: string, ctx: HostCtx): HostInstance {
  const card = document.createElement('div')
  card.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:var(--app-bg-card,#fff)'
  const t = document.createElement('p')
  t.style.cssText = 'font-size:14px;color:var(--app-text-primary,#111);margin:0'
  t.textContent = title
  const d = document.createElement('button')
  d.type = 'button'
  d.textContent = ctx.t('files.download')
  d.style.cssText = 'padding:3px 12px;font-size:12px;cursor:pointer'
  card.append(t, d)
  el.style.position = 'relative'
  el.appendChild(card)
  return {
    dispose: () => card.remove(),
  }
}

async function render(el: HTMLElement, file: HostFile, ctx: HostCtx): Promise<HostInstance> {
  const originalBytes = await (await ctx.getObject(file.key)).arrayBuffer()
  // §六/§8.6：>20MB 提示由预览闸 confirmLargeFile 承担（不重复建闸）；>50MB 硬闸也在预览闸
  // 写回留原件；渲染用副本（pdf.js 会 detach 传入 buffer）
  const renderBytes = originalBytes.slice(0)

  // 预检层（§8.1/§8.5）：加密拒绝进编辑态；损坏降级提示
  let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']> | null = null
  let pdfLibDoc: PDFDocument | null = null
  try {
    pdf = await pdfjsLib.getDocument({ data: renderBytes }).promise
  } catch (err) {
    const name = (err as { name?: string })?.name ?? ''
    const msg = name.includes('Password') ? '加密 PDF 不支持标注签批（可用口令在原应用打开后另存未加密版本）' : 'PDF 无法解析（文件可能损坏），仅可下载查看'
    console.warn('PDFANN_PRECHECK', String(err)?.slice(0, 160))
    return failCard(el, msg, ctx)
  }
  try {
    pdfLibDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true })
  } catch (err) {
    console.warn('PDFANN_LOAD_ERR', String(err)?.slice(0, 160))
    return failCard(el, 'PDF 结构无法读取（写回层初始化失败），仅可下载查看', ctx)
  }
  // §8.1：pdf-lib 对加密件只能读不能写——加密件即使渲染成功也拒绝进编辑态
  if (pdfLibDoc.isEncrypted) {
    return failCard(el, '加密 PDF 不支持标注签批（可在原应用打开后另存未加密版本）', ctx)
  }

  // ── 状态面 ──
  const pages: PageBox[] = []
  /** 起草态（跨页共享——finishDraft 定义在页循环外） */
  let drafting: Annotation | null = null
  let draftEl: HTMLElement | null = null
  let dirty = false
  let disposed = false
  let saving = false // 保存防重入（renderBadge 读它驱动簇 busy——必须先于首次 renderBadge() 声明，TDZ 前车）
  let tool: 'rect' | 'text' | 'ink' | 'sign' = 'rect'
  let color = COLORS[0]
  const anns: Annotation[] = []
  const undoStack: Annotation[][] = []
  const formValues: Record<string, string | boolean> = {}
  let selected: Annotation | null = null
  let signDataUrl: string | null = sessionStorage.getItem(SIGN_KEY) // §七.5：签名会话留存

  // sidecar 导入（§五 P2/P3）：404 容忍；P3 归并（createdAt 定序、id 冲突保留双份）
  let sidecarInfo = ''
  try {
    const res = await ctx.getObject(sidecarKeyOf(file.key))
    const sc = parseSidecar(await res.text())
    if (sc) {
      const merged = mergeAnnotations(anns, sc.annotations)
      anns.push(...merged.annotations)
      Object.assign(formValues, sc.formValues)
      if (sc.annotations.length > 0)
        sidecarInfo = `（sidecar +${merged.added}${merged.duplicated ? ` 冲突×${merged.duplicated}` : ''}）`
    }
  } catch {
    // 404=无 sidecar；其余错误不阻断
  }

  // 重置基线（打开时的标注/表单态快照；压平保存后基线翻空——烙印进 PDF 的内容不再以覆盖层回滚）
  const initialAnns: Annotation[] = JSON.parse(JSON.stringify(anns)) as Annotation[]
  const initialValues: Record<string, string | boolean> = JSON.parse(JSON.stringify(formValues))

  // ── 表单面（§4.4 P2）：XFA 整链禁用；字段定位为覆盖层控件 ──
  const xfa = hasXFA(pdfLibDoc)
  const fields: FieldInfo[] = xfa ? [] : inspectFields(pdfLibDoc)
  let formAppliedNote = ''

  // ── 骨架 ──
  const root = document.createElement('div')
  root.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:var(--app-bg-card,#f5f5f5)'
  const bar = document.createElement('div')
  bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:4px;padding:4px 10px;border-bottom:1px solid var(--app-separator,#e5e7eb);font-size:12px;overflow-x:auto'
  const scroll = document.createElement('div')
  scroll.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:12px'
  const badge = document.createElement('span')
  badge.style.cssText = 'margin-left:auto;font-size:12px;color:#b88230'
  root.append(bar, scroll)
  el.style.position = 'relative'
  el.appendChild(root)

  const countLabel = document.createElement('span')
  // 统一编辑钮簇（一百四十三番：保存红点｜撤销 重做 重置——样式唯源 shared/editToolbar，构建期内联）。
  // 徽标只剩 XFA/标注计数信息；dirty 一律=保存钮红点，「未保存」文字废弃
  const toolbarCtl = createEditToolbar(
    {
      save: `${ctx.t('app.edt-save')}（压平合并）`,
      undo: ctx.t('app.edt-undo'),
      redo: ctx.t('app.edt-redo'),
      reset: ctx.t('app.edt-reset'),
    },
    {
      onSave: () => void save(),
      onUndo: () => undo(),
      onRedo: () => redo(),
      onReset: () => resetToSaved(),
    },
  )
  bar.appendChild(toolbarCtl.el)
  const markDirty = (): void => {
    dirty = true
    renderBadge()
  }
  const renderBadge = (): void => {
    countLabel.textContent = anns.length > 0 ? `标注 ${anns.length}` : ''
    toolbarCtl.setDirty(dirty)
    toolbarCtl.setBusy(saving)
    toolbarCtl.setHistory(undoStack.length > 0, redoStack.length > 0)
    if (dirty) return // dirty 只走保存钮红点（一百四十三番）
    if (xfa) {
      badge.textContent = 'XFA 表单：填写链禁用（仅标注）'
      badge.style.color = '#b88230'
    } else if (anns.length > 0 || sidecarInfo) {
      badge.textContent = `标注 ${anns.length}${sidecarInfo}`
      badge.style.color = 'var(--app-text-secondary,#888)'
    } else {
      badge.textContent = ''
      badge.style.color = ''
    }
  }

  const redoStack: Annotation[][] = []
  const syncHist = (): void => {
    toolbarCtl.setHistory(undoStack.length > 0, redoStack.length > 0)
  }

  const pushUndo = (): void => {
    undoStack.push(JSON.parse(JSON.stringify(anns)))
    if (undoStack.length > 50) undoStack.shift()
    redoStack.length = 0 // 新分支：旧重做线作废
  }
  const rerenderAnns = (pageNo: number): void => {
    const box = pages[pageNo - 1]
    if (!box) return
    box.overlay.querySelectorAll<HTMLElement>('[data-ann]').forEach((n) => n.remove())
    for (const ann of anns) {
      if (ann.page !== pageNo) continue
      box.overlay.appendChild(annEl(ann, box))
    }
  }
  const rerenderAll = (): void => pages.forEach((_, i) => rerenderAnns(i + 1))

  /** 撤销（快照栈，上限 50）：当前态推重做栈；恢复后保持 dirty（历史内容≠保存态） */
  function undo(): void {
    const prev = undoStack.pop()
    if (!prev) return
    redoStack.push(JSON.parse(JSON.stringify(anns)))
    anns.length = 0
    anns.push(...prev)
    selected = null
    rerenderAll()
    markDirty()
    syncHist()
  }
  /** 重做（撤销的对偶） */
  function redo(): void {
    const next = redoStack.pop()
    if (!next) return
    undoStack.push(JSON.parse(JSON.stringify(anns)))
    anns.length = 0
    anns.push(...next)
    selected = null
    rerenderAll()
    markDirty()
    syncHist()
  }
  /** 重置：回到打开时标注/表单态（历史栈清空；压平保存后基线=空覆盖层） */
  function resetToSaved(): void {
    if (disposed || saving || !dirty) return
    undoStack.length = 0
    redoStack.length = 0
    anns.length = 0
    anns.push(...(JSON.parse(JSON.stringify(initialAnns)) as Annotation[]))
    for (const k of Object.keys(formValues)) delete formValues[k]
    Object.assign(formValues, JSON.parse(JSON.stringify(initialValues)))
    selected = null
    rerenderAll()
    renderFormControls()
    dirty = false
    toolbarCtl.setDirty(false)
    syncHist()
    renderBadge()
  }

  const annEl = (ann: Annotation, box: PageBox): HTMLElement => {
    const s = box.scale
    let div: HTMLElement
    if (ann.type === 'rect') {
      div = document.createElement('div')
      div.style.cssText = `position:absolute;border:${ann.style.strokeWidth ?? 1.5}px solid ${ann.style.color};pointer-events:auto;cursor:pointer`
      div.style.left = `${ann.rect!.x * s}px`
      div.style.top = `${(box.ptH - ann.rect!.y - ann.rect!.h) * s}px`
      div.style.width = `${ann.rect!.w * s}px`
      div.style.height = `${ann.rect!.h * s}px`
    } else if (ann.type === 'text') {
      div = document.createElement('div')
      div.style.cssText = `position:absolute;pointer-events:auto;cursor:pointer;white-space:pre;font-size:${(ann.style.fontSize ?? 14) * s}px;line-height:1.4;color:${ann.style.color}`
      div.style.left = `${ann.rect!.x * s}px`
      div.style.top = `${(box.ptH - ann.rect!.y - (ann.style.fontSize ?? 14) * 1.2) * s}px`
      div.textContent = ann.text ?? ''
    } else if (ann.type === 'ink') {
      div = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as HTMLElement
      div.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:auto;cursor:pointer'
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const pts = (ann.points ?? []).map((p) => ({ x: p.x * s, y: (box.ptH - p.y) * s }))
      path.setAttribute('d', smoothPoints(pts))
      path.setAttribute('stroke', ann.style.color)
      path.setAttribute('stroke-width', String(ann.style.strokeWidth ?? 1.5))
      path.setAttribute('fill', 'none')
      div.appendChild(path)
    } else {
      div = document.createElement('img')
      div.style.cssText = 'position:absolute;pointer-events:auto;cursor:pointer'
      ;(div as HTMLImageElement).src = ann.dataUrl ?? ''
      div.style.left = `${ann.rect!.x * s}px`
      div.style.top = `${(box.ptH - ann.rect!.y - ann.rect!.h) * s}px`
      div.style.width = `${ann.rect!.w * s}px`
    }
    ;(div as HTMLElement).dataset.ann = ann.id
    if (selected?.id === ann.id) (div as HTMLElement).style.outline = '2px dashed #f59e0b'
    ;(div as HTMLElement).addEventListener('click', (ev) => {
      ev.stopPropagation()
      selected = ann
      rerenderAll()
    })
    return div
  }

  // ── 工具栏 ──
  const mkBtn = (label: string, onClick: () => void, separate = false): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.style.cssText = `padding:2px 8px;font-size:12px;cursor:pointer;border:1px solid var(--app-separator,#e5e7eb);border-radius:6px;background:transparent;color:var(--app-text-primary,#374151);${separate ? 'margin-left:8px' : ''}`
    b.addEventListener('click', onClick)
    bar.appendChild(b)
    return b
  }
  const toolBtns: Array<[HTMLButtonElement, string]> = []
  const pickTool = (t: typeof tool) => {
    tool = t
    for (const [b, name] of toolBtns) {
      b.style.background = name === t ? 'var(--brand-primary-soft,#ecf5ff)' : 'transparent'
      b.style.color = name === t ? 'var(--el-color-primary,#409eff)' : 'var(--app-text-primary,#374151)'
    }
  }
  for (const [t, label] of [
    ['rect', '□ 矩形'],
    ['text', 'T 文字'],
    ['ink', '✎ 画笔'],
    ['sign', '签 名'],
  ] as const) {
    const b = mkBtn(label, () => {
      if (t === 'sign' && !signDataUrl) {
        openSignPad()
        return
      }
      pickTool(t)
    })
    toolBtns.push([b, t])
  }
  for (const c of COLORS) {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.style.cssText = `flex:none;width:18px;height:18px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 0 0 1px #d1d5db;cursor:pointer`
    dot.addEventListener('click', () => {
      color = c
      pickTool(tool)
    })
    bar.appendChild(dot)
  }
  mkBtn('导出标注层', () => void exportSidecar(), false)
  mkBtn('导入标注层', () => fileInput.click(), false)
  mkBtn('下载副本', () => downloadCopy(), false)
  bar.appendChild(badge)
  bar.appendChild(countLabel)

  // sidecar 导入（本地 JSON 文件）
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.json,application/json'
  fileInput.style.display = 'none'
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0]
    fileInput.value = ''
    if (!f) return
    const sc = parseSidecar(await f.text())
    if (!sc) {
      window.alert('标注层 JSON 无法解析（需 schema=v1）')
      return
    }
    const merged = mergeAnnotations(anns, sc.annotations)
    anns.length = 0
    anns.push(...merged.annotations)
    Object.assign(formValues, sc.formValues)
    renderFormControls()
    rerenderAll()
    markDirty()
    window.alert(`归并完成：+${merged.added} 条${merged.duplicated ? `，冲突保留双份 ${merged.duplicated} 条` : ''}`)
  })
  root.appendChild(fileInput)

  const exportSidecar = async (): Promise<void> => {
    if (anns.length === 0 && Object.keys(formValues).length === 0) {
      window.alert('暂无标注/表单值可导出')
      return
    }
    try {
      const json = JSON.stringify(toSidecar(anns, formValues, AUTHOR), null, 2)
      await ctx.putObject(sidecarKeyOf(file.key), new Blob([json], { type: 'application/json' }))
      ctx.notify('saved', { key: sidecarKeyOf(file.key) })
      window.alert('标注层已导出（<key>.annotations.json）')
    } catch (err) {
      console.warn('PDFANN_SIDECAR_ERR', String(err)?.slice(0, 200))
    }
  }
  /** 逃生通道（§六）：下载副本=本地导出压平 PDF，不落桶不改原文件 */
  const downloadCopy = async (): Promise<void> => {
    try {
      const bytes = anns.length > 0 ? await flattenAnnotations(originalBytes, anns) : originalBytes
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      const a = document.createElement('a')
      a.href = url
      a.download = file.name.replace(/\.pdf$/i, '') + '-annotated.pdf'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.warn('PDFANN_DL_ERR', String(err)?.slice(0, 160))
    }
  }

  // ── 签名板（§七：pointer 采集 + 贝塞尔平滑；签名会话留存 sessionStorage） ──
  function openSignPad(): void {
    const mask = document.createElement('div')
    mask.style.cssText = 'position:absolute;inset:0;z-index:50;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center'
    const panel = document.createElement('div')
    panel.style.cssText = 'background:#fff;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px'
    const pad = document.createElement('canvas')
    pad.width = 480
    pad.height = 200
    pad.style.cssText = 'border:1px dashed #9ca3af;background:#fff;cursor:crosshair;touch-action:none'
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
    const ctx2d = pad.getContext('2d')!
    ctx2d.lineWidth = 3
    ctx2d.lineCap = 'round'
    ctx2d.strokeStyle = '#111'
    let drawing = false
    const pos = (ev: PointerEvent) => {
      const r = pad.getBoundingClientRect()
      return { x: ev.clientX - r.left, y: ev.clientY - r.top }
    }
    pad.addEventListener('pointerdown', (ev) => {
      drawing = true
      const p = pos(ev)
      ctx2d.beginPath()
      ctx2d.moveTo(p.x, p.y)
    })
    pad.addEventListener('pointermove', (ev) => {
      if (!drawing) return
      const p = pos(ev)
      ctx2d.lineTo(p.x, p.y)
      ctx2d.stroke()
    })
    const onUp = () => (drawing = false)
    window.addEventListener('pointerup', onUp)
    const close = () => {
      window.removeEventListener('pointerup', onUp)
      mask.remove()
    }
    const clearBtn = document.createElement('button')
    clearBtn.textContent = '重写'
    clearBtn.style.cssText = 'padding:3px 12px;font-size:12px;cursor:pointer'
    clearBtn.addEventListener('click', () => ctx2d.clearRect(0, 0, pad.width, pad.height))
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = '取消'
    cancelBtn.style.cssText = 'padding:3px 12px;font-size:12px;cursor:pointer'
    cancelBtn.addEventListener('click', close)
    const okBtn = document.createElement('button')
    okBtn.textContent = '采用签名'
    okBtn.style.cssText = 'padding:3px 12px;font-size:12px;cursor:pointer;background:var(--el-color-primary,#409eff);color:#fff;border:none;border-radius:4px'
    okBtn.addEventListener('click', () => {
      signDataUrl = pad.toDataURL('image/png')
      try {
        sessionStorage.setItem(SIGN_KEY, signDataUrl)
      } catch {
        // 存储满/受限：仅会话内存
      }
      pickTool('sign')
      close()
    })
    row.append(clearBtn, cancelBtn, okBtn)
    panel.append(pad, row)
    mask.appendChild(panel)
    root.appendChild(mask)
  }

  // ── 页面渲染 + 覆盖层交互 ──
  const containerW = Math.max(560, el.clientWidth - 48)
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo)
    const vp1 = page.getViewport({ scale: 1 })
    const scale = Math.min(2, containerW / vp1.width)
    const vp = page.getViewport({ scale })
    const wrap = document.createElement('div')
    wrap.style.cssText = `position:relative;margin:0 auto 12px;width:${vp.width}px;height:${vp.height}px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.18)`
    const canvas = document.createElement('canvas')
    canvas.width = vp.width
    canvas.height = vp.height
    wrap.appendChild(canvas)
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:absolute;inset:0;touch-action:none;cursor:crosshair'
    wrap.appendChild(overlay)
    scroll.appendChild(wrap)
    pages.push({ wrap, overlay, canvas, ptW: vp1.width, ptH: vp1.height, scale })

    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas }).promise
    rerenderAnns(pageNo) // 打开时已存在的标注（sidecar 导入）随页面挂载即渲染，否则只入模型不见视图

    const toModel = (ev: PointerEvent | MouseEvent): { x: number; y: number } => {
      const r = overlay.getBoundingClientRect()
      const px = ev.clientX - r.left
      const py = ev.clientY - r.top
      return { x: px / scale, y: vp1.height - py / scale } // y 翻转为用户空间（左下原点）
    }
    overlay.addEventListener('pointerdown', (ev) => {
      if (disposed) return
      ev.preventDefault()
      selected = null
      rerenderAll()
      const m = toModel(ev)
      if (tool === 'sign') {
        if (!signDataUrl) return
        const w = 140
        const h = w * 0.42
        pushUndo()
        anns.push({ id: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`, page: pageNo, type: 'stamp', rect: { x: m.x, y: m.y - h, w, h }, dataUrl: signDataUrl, style: { color }, author: AUTHOR, createdAt: new Date().toISOString() })
        markDirty()
        rerenderAnns(pageNo)
        return
      }
      if (tool === 'text') {
        // pushUndo 在 commit 时才压栈：Escape 丢弃的草稿不得消耗撤销层
        const input = document.createElement('input')
        input.style.cssText = `position:absolute;left:${m.x * scale}px;top:${(vp1.height - m.y) * scale}px;font-size:${14 * scale}px;width:${180 * scale}px;border:1px dashed ${color};background:#fff;padding:2px;z-index:5`
        overlay.appendChild(input)
        input.focus()
        let done = false // Enter/blur/Escape 三路竞争：提交必须一次性（否则 blur 后至 → 重复入模 / 二次 remove）
        const commit = () => {
          if (done) return
          done = true
          const text = input.value.trim()
          if (input.isConnected) input.remove()
          if (!text) return
          pushUndo()
          anns.push({ id: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`, page: pageNo, type: 'text', rect: { x: m.x, y: m.y, w: 0, h: 0 }, text, style: { color, fontSize: 14 }, author: AUTHOR, createdAt: new Date().toISOString() })
          markDirty()
          rerenderAnns(pageNo)
        }
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') commit()
          if (ke.key === 'Escape') {
            done = true // 丢弃：不得被随后的 blur 提交
            if (input.isConnected) input.remove()
          }
        })
        input.addEventListener('blur', commit)
        return
      }
      drafting = { id: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`, page: pageNo, type: tool, rect: { x: m.x, y: m.y, w: 0, h: 0 }, points: tool === 'ink' ? [m] : undefined, style: { color, strokeWidth: 2, fontSize: 14 }, author: AUTHOR, createdAt: new Date().toISOString() }
      if (tool === 'rect') {
        draftEl = document.createElement('div')
        draftEl.style.cssText = `position:absolute;border:1.5px dashed ${color};pointer-events:none`
        overlay.appendChild(draftEl)
      } else {
        draftEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as HTMLElement
        draftEl.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none'
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('stroke', color)
        path.setAttribute('stroke-width', '2')
        path.setAttribute('fill', 'none')
        draftEl.appendChild(path)
        overlay.appendChild(draftEl)
      }
    })
    overlay.addEventListener('pointermove', (ev) => {
      if (!drafting || !draftEl) return
      const m = toModel(ev)
      if (drafting.type === 'rect') {
        drafting.rect!.w = m.x - drafting.rect!.x
        drafting.rect!.h = m.y - drafting.rect!.y
        const s = scale
        draftEl.style.left = `${Math.min(drafting.rect!.x, drafting.rect!.x + drafting.rect!.w) * s}px`
        draftEl.style.top = `${Math.min(drafting.rect!.y, drafting.rect!.y + drafting.rect!.h) * s}px`
        draftEl.style.width = `${Math.abs(drafting.rect!.w) * s}px`
        draftEl.style.height = `${Math.abs(drafting.rect!.h) * s}px`
      } else if (drafting.type === 'ink') {
        drafting.points!.push(m)
        const pts = drafting.points!.map((p) => ({ x: p.x * scale, y: (vp1.height - p.y) * scale }))
        const path = draftEl.querySelector('path')!
        path.setAttribute('d', smoothPoints(pts))
      }
    })
    overlay.addEventListener('pointerup', () => finishDraft())
    overlay.addEventListener('pointerleave', () => finishDraft())
  }

  function finishDraft(): void {
    if (!drafting) return
    const d = drafting
    drafting = null
    draftEl?.remove()
    draftEl = null
    if (d.type === 'rect' && (Math.abs(d.rect!.w) < 4 || Math.abs(d.rect!.h) < 4)) return
    if (d.type === 'ink' && (d.points?.length ?? 0) < 2) return
    if (d.type === 'rect') {
      d.rect = { x: Math.min(d.rect!.x, d.rect!.x + d.rect!.w), y: Math.min(d.rect!.y, d.rect!.y + d.rect!.h), w: Math.abs(d.rect!.w), h: Math.abs(d.rect!.h) }
    }
    pushUndo()
    anns.push(d)
    markDirty()
    rerenderAnns(d.page)
  }

  // ── 表单覆盖层控件（§4.4 P2）：字段定位 + 受控值（XFA 已在上方禁链） ──
  function renderFormControls(): void {
    if (xfa) return
    for (const f of fields) {
      const box = pages[f.page - 1]
      if (!box) continue
      const s = box.scale
      const val = formValues[f.name]
      let ctl: HTMLElement
      if (f.type === 'checkbox') {
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = val === true || val === 'true'
        cb.addEventListener('change', () => {
          formValues[f.name] = cb.checked
          markDirty()
        })
        ctl = cb
      } else if (f.type === 'dropdown' || f.type === 'radio' || f.type === 'option') {
        const sel = document.createElement('select')
        sel.style.cssText = 'width:100%;height:100%;font-size:inherit'
        for (const o of f.options ?? []) {
          const opt = document.createElement('option')
          opt.value = o
          opt.textContent = o
          sel.appendChild(opt)
        }
        if (typeof val === 'string') sel.value = val
        sel.addEventListener('change', () => {
          formValues[f.name] = sel.value
          markDirty()
        })
        ctl = sel
      } else {
        const input = document.createElement('input')
        input.type = 'text'
        input.value = typeof val === 'string' ? val : ''
        input.placeholder = f.name
        input.addEventListener('input', () => {
          formValues[f.name] = input.value
          markDirty()
        })
        ctl = input
      }
      const wrapCtl = document.createElement('div')
      wrapCtl.style.cssText = `position:absolute;left:${f.rect.x * s}px;top:${(box.ptH - f.rect.y - f.rect.h) * s}px;width:${f.rect.w * s}px;height:${f.rect.h * s}px;border:1px dashed #94a3b8;background:rgba(255,255,255,.85);box-sizing:border-box;font-size:${Math.max(10, f.rect.h * s * 0.6)}px;overflow:hidden`
      wrapCtl.appendChild(ctl)
      if (ctl instanceof HTMLInputElement || ctl instanceof HTMLSelectElement) {
        ctl.style.cssText += 'width:100%;height:100%;border:none;outline:none;background:transparent;box-sizing:border-box;padding:1px 3px'
      }
      box.overlay.appendChild(wrapCtl)
    }
  }
  renderFormControls()
  renderBadge()

  // ── 保存链（压平写回原字节 + 表单值应用/flatten） ──
  const save = async (): Promise<void> => {
    if (disposed || saving) return
    // 幂等守卫：压平后 anns/表单已清——重复触发不得再写一遍空内容覆盖成果
    if (!dirty && anns.length === 0 && Object.keys(formValues).length === 0) return
    saving = true
    toolbarCtl.setBusy(true)
    try {
      const bytes = await flattenAnnotations(originalBytes, anns)
      // 表单值应用 + 外观压平（在标注之后、save 之前——同一份重建文档上执行）
      const work = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const formResult = fields.length > 0 ? applyFormValuesAndFlatten(work, formValues) : { applied: 0, flattened: false }
      formAppliedNote = formResult.applied > 0 ? `（表单 ${formResult.applied}）` : ''
      const finalBytes = await work.save()
      await ctx.putObject(file.key, new Blob([finalBytes], { type: 'application/pdf' }))
      ctx.notify('saved', { key: file.key })
      // 烙印=一次性出口（§九）：覆盖层已并入 PDF，sidecar 重写为空——避免重开把已烙印内容再导入→二次烙印
      try {
        await ctx.putObject(
          sidecarKeyOf(file.key),
          new Blob([JSON.stringify(toSidecar([], {}, AUTHOR), null, 2)], { type: 'application/json' }),
        )
      } catch {
        // sidecar 重写失败不影响保存主链
      }
      dirty = false
      badge.textContent = ''
      countLabel.textContent = ''
      anns.length = 0
      undoStack.length = 0
      redoStack.length = 0
      // 烙印后基线翻空：重置不得把已烙进 PDF 的覆盖层快照滚回来
      initialAnns.length = 0
      for (const k of Object.keys(initialValues)) delete initialValues[k]
      for (const k of Object.keys(formValues)) delete formValues[k]
      renderFormControls()
      syncHist()
    } catch (err) {
      console.warn('PDFANN_SAVE_ERR', String(err)?.slice(0, 200))
    } finally {
      saving = false
      toolbarCtl.setBusy(false)
    }
  }
  const onKey = (ev: KeyboardEvent): void => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void save()
      return
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected) {
      const t = ev.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      ev.preventDefault()
      pushUndo()
      anns.splice(anns.indexOf(selected), 1)
      selected = null
      rerenderAll()
      markDirty()
    }
  }
  window.addEventListener('keydown', onKey)

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      window.removeEventListener('keydown', onKey)
      root.remove()
    },
    beforeDispose: () => {
      if (!dirty) return true
      const ans = window.confirm(ctx.t('app.code-unsaved')) as boolean | Promise<boolean>
      return Promise.race([Promise.resolve(ans), new Promise<boolean>((r) => setTimeout(() => r(true), 3000))])
    },
    getState: () => ({ dirty, count: anns.length, forms: Object.keys(formValues).length }),
  }
}
