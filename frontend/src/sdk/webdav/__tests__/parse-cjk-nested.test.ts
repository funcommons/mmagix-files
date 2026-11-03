/**
 * 复现测试配套（实机故障：notes/草稿 v2.md 挂树根级 + 打开 404）——parse 层切片。
 *
 * 结论：**解码无罪**。parseMultistatus 对 `/notes/%E8%8D%89%E7%A8%BF%20v2.md` 与
 * `/notes/meeting.md` 处理完全对称：逐段单次解码正确还原真名（含 %20→真空格）。
 * 真正的缺陷在 client.list 组装层：parseMultistatus 按 collectionPath 剥前缀产出
 * 「相对 key」（parse.ts:119 `path.slice(prefix.length)`，本文件如实断言该内部契约——
 * parse.test.ts 既有钉死同口径），而 S3Client 契约（types.ts:232）要求 list 返回
 * **全 key**（S3 正本 s3/client.ts:219 Contents.Key 原样）。修复落点=WebDavClient.list
 * 组装时重拼 prefix（见 client-cjk-nested.test.ts / tree-store-webdav-cjk.test.ts 红断言），
 * 本层零改动。
 */
import { describe, expect, it } from 'vitest'
import { parseMultistatus } from '../parse'

/** 真实形态 multistatus（与 dev-webdav.mjs hrefOf 产物一致：path-absolute、单次编码、目录带尾斜杠） */
const NOTES_MULTISTATUS =
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">` +
  `<d:response><d:href>/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `<d:response><d:href>/notes/meeting.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `<d:response><d:href>/notes/%E8%8D%89%E7%A8%BF%20v2.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>20</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `</d:multistatus>`

describe('parseMultistatus 解码锚（实机错位与编码无关，本组恒绿）', () => {
  it('%E8%8D%89%E7%A8%BF%20v2.md 逐段单次解码=真名 草稿 v2.md（真空格，无残留转义、无二次解码）', () => {
    const entries = parseMultistatus(NOTES_MULTISTATUS, '/notes/')
    expect(entries.map((e) => e.key)).toContain('草稿 v2.md')
    const cjk = entries.find((e) => e.key === '草稿 v2.md')!
    expect(cjk.key).not.toContain('%')
    expect(cjk.size).toBe(20)
  })

  it('ASCII 与 CJK 条目处理同构：两 key 均剥 collectionPath 前缀（/notes/）、均不含前缀', () => {
    const entries = parseMultistatus(NOTES_MULTISTATUS, '/notes/')
    expect(entries.map((e) => e.key)).toEqual(['meeting.md', '草稿 v2.md'])
    // 同构性本身即证明：本层不可能对同一响应里的两条目产生「一个嵌套一个根级」的分叉
    expect(entries.every((e) => !e.key.startsWith('notes/'))).toBe(true)
  })
})
