/**
 * 复现测试（实机故障：notes/草稿 v2.md 挂树根级 + 打开 404）——client.list / get 切片。
 *
 * 断言【期望行为】：
 * 1. list('notes/') 的 S3ListResult.files[].key 必须是全 key（notes/前缀），与
 *    S3SigV4Client.list 同契约（s3/client.ts Contents.Key 原样=含 prefix 全 key）。
 *    当前实现经 parseMultistatus 剥前缀 → 相对 key（'草稿 v2.md'）→ 红。
 * 2. 打开回路：client.get(list 出的 key) 必须请求 /notes/%E8%8D%89%E7%A8%BF%20v2.md。
 *    当前 list 出相对 key → get 打到根级 URL → 红（= 实机「点击打开按根级 key 请求 → 404」）。
 */
import { describe, expect, it, vi } from 'vitest'
import { WebDavClient } from '../client'

const NOTES_MULTISTATUS =
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">` +
  `<d:response><d:href>/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `<d:response><d:href>/notes/meeting.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `<d:response><d:href>/notes/%E8%8D%89%E7%A8%BF%20v2.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>20</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `</d:multistatus>`

function makeClient() {
  const fetcher = vi.fn(async () => new Response(NOTES_MULTISTATUS, { status: 207 }))
  const client = new WebDavClient({ endpoint: 'http://localhost:5240' }, fetcher as unknown as typeof fetch)
  return { fetcher, client }
}

describe('WebDavClient.list：嵌套目录条目 key 必须带目录前缀（S3Client 契约）', () => {
  it("list('notes/') files keys = ['notes/meeting.md', 'notes/草稿 v2.md']（红=当前剥前缀成相对 key）", async () => {
    const { client } = makeClient()
    const result = await client.list('notes/')
    expect(result.prefix).toBe('notes/')
    expect(result.dirs).toHaveLength(0)
    expect(result.files.map((f) => f.key)).toEqual(['notes/meeting.md', 'notes/草稿 v2.md'])
  })

  it('name 取末段不受影响：草稿 v2.md（红例同上，钉 name 与 key 解耦）', async () => {
    const { client } = makeClient()
    const result = await client.list('notes/')
    const cjk = result.files.find((f) => f.name.includes('草稿'))
    expect(cjk).toBeDefined()
    expect(cjk!.name).toBe('草稿 v2.md')
  })
})

describe('打开回路：get(list 出的 key) 必须命中 /notes/ 编码路径（实机 404 复现点）', () => {
  it('get(草稿条目.key) 请求 URL = /notes/%E8%8D%89%E7%A8%BF%20v2.md（红=当前打到根级 URL）', async () => {
    const { fetcher, client } = makeClient()
    const result = await client.list('notes/')
    const cjk = result.files.find((f) => f.name === '草稿 v2.md')!
    await client.get(cjk.key)
    expect(fetcher.mock.calls[1]?.[0]).toBe('http://localhost:5240/notes/%E8%8D%89%E7%A8%BF%20v2.md')
  })
})
