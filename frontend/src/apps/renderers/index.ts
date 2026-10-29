/**
 * 渲染器总表——code → renderer（registerBuiltins 的 renderers 注入源）
 * 契约正本：《docs/product/PRD.md》§一应用清单
 * R5（docx/xlsx）落地后补两行；image-painter（Canvas 画板）M2+ 排期。
 */
import type { AppDefinition } from '../../sdk/types'
import { markdownRenderer } from './markdown'
import { videoRenderer, audioRenderer } from './media'
import { pdfRenderer } from './pdf'
import { csvTableRenderer } from './csv'
import { htmlViewerRenderer } from './html'
import { imageViewRenderer } from './image'
import { heicViewerRenderer } from './heic'
import { codeEditorRenderer } from './code'
import { docxRenderer } from './docx'
import { xlsxRenderer } from './xlsx'
import { mermaidViewerRenderer } from './mermaid'
import { flowEditorRenderer } from './flow-editor'
import { zipBrowserRenderer } from './zip'

export const RENDERERS: Partial<Record<string, AppDefinition['renderer']>> = {
  'markdown-renderer': markdownRenderer,
  'image-viewer': imageViewRenderer,
  'video-player': videoRenderer,
  'audio-player': audioRenderer,
  'pdf-viewer': pdfRenderer,
  'code-editor': codeEditorRenderer,
  'csv-table': csvTableRenderer,
  'html-viewer': htmlViewerRenderer,
  'docx-viewer': docxRenderer,
  'xlsx-viewer': xlsxRenderer,
  'heic-viewer': heicViewerRenderer, // Lane F6
  'flow-editor': flowEditorRenderer,
  'mermaid-viewer': mermaidViewerRenderer,
  'zip-browser': zipBrowserRenderer, // M4-UI
}
