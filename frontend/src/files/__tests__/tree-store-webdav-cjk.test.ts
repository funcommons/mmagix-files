/**
 * 复现测试（实机故障：notes/草稿 v2.md 挂树根级 + 打开 404）——tree-store 全链切片。
 *
 * 真实 WebDavClient + fetch 桩（根 XML + notes/ XML）+ createFileTree，跑实机同款序列：
 *   loadDir('')（根列举）→ 展开 loadDir('notes/')。
 *
 * 断言【期望行为】：
 * 1. bucket 'notes/' 的文件条目 key 是全 key 'notes/草稿 v2.md'（当前=相对 key → 红）。
 * 2. 「挂树根级」机制复现：把 list 产出的 CJK 条目 key 喂 applyChange(put)（renderer 保存
 *   回流链 Home.vue:913 → applyChange → upsertToBucket）——期望落 bucket 'notes/'；
 *   当前相对 key 经 parentPrefix('草稿 v2.md')='' 被插进根 bucket '' → 树根级出现该文件 → 红。
 *   （这就是实机「meeting.md 嵌套正确、草稿 v2.md 挂根级」不对称的来源：只有被打开/保存过的
 *   文件才走 applyChange 回流插根 bucket。）
 * 3. 打开回路：对条目 key 调 client.get 必须命中 /notes/ 编码 URL（当前根级 → 红）。
 */
import { describe, expect, it, vi } from 'vitest'
import { WebDavClient } from '../../sdk/webdav/client'
import { createFileTree } from '../tree-store'

const NOTES_XML =
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">` +
  `<d:response><d:href>/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `<d:response><d:href>/notes/meeting.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>10</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `<d:response><d:href>/notes/%E8%8D%89%E7%A8%BF%20v2.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>20</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `</d:multistatus>`

const ROOT_XML =
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">` +
  `<d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `<d:response><d:href>/notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  `</d:multistatus>`

/** 实机同款装配：WebDavClient（endpoint 5240、rootPath 空）+ createFileTree（rootPrefix=''，setup.ts:48-50 口径） */
async function makeTree() {
  const fetcher = vi.fn(async (url: string) => {
    const path = url.replace('http://localhost:5240', '')
    const body = path === '/notes/' ? NOTES_XML : ROOT_XML
    return new Response(body, { status: 207 })
  })
  const client = new WebDavClient({ endpoint: 'http://localhost:5240' }, fetcher as unknown as typeof fetch)
  const tree = createFileTree({ client, rootPrefix: '' })
  await tree.loadDir('') // 根列举
  await tree.loadDir('notes/') // 展开 notes/
  return { fetcher, client, tree }
}

const cjkKeyOf = (tree: ReturnType<typeof createFileTree>): string =>
  tree.nodes.get('notes/')?.files.find((f) => f.name === '草稿 v2.md')?.key ?? ''

describe('tree-store × WebDavClient 全链：notes/ 子文件条目 key 形态', () => {
  it("展开 notes/ 后 bucket 'notes/' 文件 key = notes/草稿 v2.md（红=当前相对 key）", async () => {
    const { tree } = await makeTree()
    const files = tree.nodes.get('notes/')?.files.map((f) => f.key) ?? []
    expect(files).toEqual(['notes/meeting.md', 'notes/草稿 v2.md'])
  })

  it('渲染层同构断言：根 bucket 不含 草稿 v2.md（树根级不应出现该文件）', async () => {
    const { tree } = await makeTree()
    const rootFiles = tree.nodes.get('')?.files.map((f) => f.key) ?? []
    expect(rootFiles).toEqual([]) // 红=一旦 applyChange 回流相对 key，根 bucket 被污染（见下）
  })
})

describe('「挂树根级」机制复现：list 产出的相对 key 经 applyChange 回流 → 根 bucket 被污染', () => {
  it('applyChange(put, 条目.key) 应落 bucket notes/（红=当前 parentPrefix(相对key)="" 插进根 bucket）', async () => {
    const { tree } = await makeTree()
    const key = cjkKeyOf(tree)
    expect(key).not.toBe('') // 前置：list 确实产出了该条目
    // renderer 保存回流（Home.vue:913 notifyFileChanged → tree.applyChange）
    tree.applyChange({ key, action: 'put' })
    const inNotes = tree.nodes.get('notes/')?.files.some((f) => f.key === key) ?? false
    const inRoot = tree.nodes.get('')?.files.some((f) => f.key === key) ?? false
    expect(inNotes).toBe(true) // 落 notes/ bucket（全 key → parentPrefix='notes/'）
    expect(inRoot).toBe(false) // 不得污染根 bucket（红=当前插进了根 bucket → 树根级渲染）
  })
})

describe('打开回路（全链）：client.get(条目.key) 命中 /notes/ 编码 URL', () => {
  it('红=当前 get(相对 key) 打到根级 URL → 404', async () => {
    const { fetcher, client, tree } = await makeTree()
    const key = cjkKeyOf(tree)
    await client.get(key)
    expect(fetcher.mock.calls[2]?.[0]).toBe('http://localhost:5240/notes/%E8%8D%89%E7%A8%BF%20v2.md')
  })
})
