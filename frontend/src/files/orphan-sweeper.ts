/**
 * 孤儿 uploadId 清理：对齐 S3 lifecycle AbortIncompleteMultipartUpload 语义，7 天默认。
 *
 * 分片上传中断后会残留进行中的 uploadId（计费/占存储），本模块列举后对超龄者 abort：
 *  - 超龄判定：initiated（ISO 字符串透传）经 Date.parse 距今（Date.now）严格 > maxAgeMs；
 *  - 保守原则：initiated 缺失 / 解析不出日期 / 恰好等于阈值，一律不动（aborted:false），
 *    宁可多留一期，不误杀可能仍在进行的上传；
 *  - 隔离原则：单条 abort 失败只标记该条 aborted:false，不中断其余；清单本身拉取失败
 *    则整体向上抛（调用方感知能力故障）。
 * 契约来源：frontend/src/files/__tests__/orphan-sweeper.test.ts（v1.2.0 §2.2 F5 / M2 契约）。
 */
import type { S3Client } from '@/sdk/types'

// ───────────────────────── 契约 ─────────────────────────

/** 清扫结果行：aborted=true = 已成功 abort；false = 未动（不超龄/信息缺失）或 abort 失败 */
export interface SweepResult {
  key: string
  uploadId: string
  aborted: boolean
}

// ───────────────────────── 实现 ─────────────────────────

/** 默认超龄阈值：7 天 = 604800000ms（与 S3 lifecycle AbortIncompleteMultipartUpload 常用口径一致） */
const DEFAULT_MAX_AGE_MS = 604_800_000

export async function sweepOrphanUploads(
  client: Pick<S3Client, 'listMultipartUploads' | 'abortMultipart'>,
  opts?: { maxAgeMs?: number },
): Promise<SweepResult[]> {
  const rawMaxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  // 非法阈值守卫：NaN/负数（如配置残渣 Number('7d') → NaN）会让 Date.now()-initiated <= NaN 恒为 false，
  // 全部在途被误判超龄 → 误杀活断点，推翻「宁留勿杀」。不满足「有限且非负」一律回落默认 7 天。
  const maxAgeMs = Number.isFinite(rawMaxAgeMs) && rawMaxAgeMs >= 0 ? rawMaxAgeMs : DEFAULT_MAX_AGE_MS
  // 可选能力未实现 → 按空清单降级（能力 reject 仍由此向上抛，不会被吞）
  const uploads = (await client.listMultipartUploads?.()) ?? []

  const results: SweepResult[] = []
  for (const upload of uploads) {
    // initiated 缺失 / Date.parse 得 NaN → 保守跳过，不发起 abort
    const initiatedMs = upload.initiated === undefined ? Number.NaN : Date.parse(upload.initiated)
    if (Number.isNaN(initiatedMs) || Date.now() - initiatedMs <= maxAgeMs) {
      // 未超龄（含恰好等于阈值的边界）同样归「保留」侧
      results.push({ key: upload.key, uploadId: upload.uploadId, aborted: false })
      continue
    }
    // 超龄 → abort(key, uploadId)；单条失败只标记本条，不中断其余
    try {
      await client.abortMultipart(upload.key, upload.uploadId)
      results.push({ key: upload.key, uploadId: upload.uploadId, aborted: true })
    } catch {
      results.push({ key: upload.key, uploadId: upload.uploadId, aborted: false })
    }
  }
  return results
}
