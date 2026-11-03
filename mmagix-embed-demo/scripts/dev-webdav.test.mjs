/**
 * dev-webdav.test.mjs —— dev-webdav.mjs 契约测试（node:test + node:assert/strict，零新依赖）
 *
 * 运行：pnpm -C mmagix-embed-demo test:webdav（= node --test scripts/dev-webdav.test.mjs）
 *
 * 基建约定：
 * - 每个用例集独立 fs.mkdtemp root（os.tmpdir()），绝不触碰仓库 webdav-data/；after 统一 close+rm
 * - 一律 createServer({ root, port: 0 }) → await start() 取实际端口 → fetch(http://127.0.0.1)
 * - 「字面 .. 段」「%2e%2e 未解码形态」必须走 node:http 原始请求（undici/WHATWG URL 会在客户端
 *   把 .. 折叠归一化，测不到服务器裁决）；其余用例 fetch 即可。harness.raw / harness.socket。
 * - HEAD「无 body」用 net 裸 socket 字节面断言（fetch 对 HEAD 恒返回 null body，无证明力）
 * - 207 断言用字符串包含 + href 精确串（完整 XML 解析归客户端套件 frontend/src/sdk/webdav）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from './dev-webdav.mjs'

// ───────────────────────── 测试基建 ─────────────────────────

/** mkdtemp 独立 root + 种子落盘 + port:0 起服 → 统一 close/rm 收摊 */
async function makeServer({ seeds = {}, username = '', password = '' } = {}) {
  const root = await fs.promises.mkdtemp(join(os.tmpdir(), 'webdav-test-'))
  for (const [rel, body] of Object.entries(seeds)) {
    fs.mkdirSync(dirname(join(root, rel)), { recursive: true })
    fs.writeFileSync(join(root, rel), body)
  }
  const srv = createServer({ root, port: 0, username, password })
  const port = await srv.start()
  const base = `http://127.0.0.1:${port}`
  return {
    root,
    port,
    base,
    close: async () => {
      await srv.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
    fetch: (path, opts = {}) => fetch(`${base}${path}`, opts),
    /** node:http 原始请求：path 原样上 wire，绕过 undici 的 `..` 归一化 */
    raw: (method, path, headers = {}) =>
      new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        })
        rq.on('error', reject)
        rq.end()
      }),
    /** 裸 socket 字节面请求（HEAD 无 body 断言用；Connection: close 保 close 事件及时） */
    socket: (rawText) =>
      new Promise((resolve, reject) => {
        const chunks = []
        const sock = net.connect(port, '127.0.0.1', () => sock.end(rawText))
        sock.on('data', (c) => chunks.push(c))
        sock.on('error', reject)
        sock.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')))
      }),
  }
}

const PROP = (h, path, depth) => h.fetch(path, { method: 'PROPFIND', headers: { depth } })

/** 207 body → [{ href, chunk }]（不解析 XML：断言走精确 href 串 + 关键元素包含） */
function responsesOf(xml) {
  return xml
    .split('<D:response>')
    .slice(1)
    .map((chunk) => ({ href: /<D:href>([^<]*)<\/D:href>/.exec(chunk)?.[1] ?? '', chunk }))
}

// ───────────────────────── 工厂契约 ─────────────────────────

describe('createServer 工厂契约', () => {
  it('start() resolve 实际端口且与实例 port 一致；close() 后端口不再受理', async () => {
    const root = await fs.promises.mkdtemp(join(os.tmpdir(), 'webdav-test-'))
    const srv = createServer({ root, port: 0 })
    try {
      const port = await srv.start()
      assert.ok(Number.isInteger(port) && port > 0, `port 应为正整数，实际 ${port}`)
      assert.equal(srv.port, port)
      const res = await fetch(`http://127.0.0.1:${port}/`)
      assert.ok(res.status >= 200 && res.status < 500, `匿名根应可达，实际 ${res.status}`)
      await srv.close()
      await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`), (err) => err instanceof Error)
    } finally {
      await srv.close().catch(() => {})
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ───────────────────────── CORS / OPTIONS ─────────────────────────

describe('CORS / OPTIONS', () => {
  let h
  before(async () => {
    h = await makeServer({ seeds: { 'c.txt': 'x' } })
  })
  after(() => h.close())

  it('预检 204 + ACAO:* + allow-methods 含 PROPFIND/MKCOL/COPY/MOVE + max-age + DAV:1', async () => {
    const res = await h.fetch('/', { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const methods = res.headers.get('access-control-allow-methods') ?? ''
    for (const m of ['PROPFIND', 'MKCOL', 'COPY', 'MOVE']) assert.ok(methods.includes(m), `allow-methods 缺 ${m}：${methods}`)
    assert.equal(res.headers.get('access-control-max-age'), '86400')
    assert.equal(res.headers.get('dav'), '1')
  })

  it('预检带 access-control-request-headers: depth,destination → allow-headers 原样回显', async () => {
    const res = await h.fetch('/', { method: 'OPTIONS', headers: { 'access-control-request-headers': 'depth,destination' } })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-headers'), 'depth,destination')
  })

  it('普通 GET 响应也带 ACAO:*', async () => {
    const res = await h.fetch('/c.txt')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })

  it('expose-headers 含 ETag', async () => {
    const res = await h.fetch('/c.txt')
    const expose = res.headers.get('access-control-expose-headers') ?? ''
    assert.ok(expose.includes('ETag'), `expose-headers 缺 ETag：${expose}`)
  })
})

// ───────────────────────── PROPFIND ─────────────────────────

describe('PROPFIND', () => {
  let h
  before(async () => {
    h = await makeServer({
      // 注意：'a%20b.txt' 是磁盘上的**字面 % 名**（四个字节 a%20b），与 'a b.txt'（空格名）互不相同
      seeds: { 'a.txt': '12345', 'notes/meeting.md': '# meeting\n', 'a b.txt': 's', 'a%20b.txt': 'p' },
    })
  })
  after(() => h.close())

  it('depth 0 → 207 且只含自身 1 条 response（根 href=/ 且 collection）', async () => {
    const res = await PROP(h, '/', '0')
    assert.equal(res.status, 207)
    const xml = await res.text()
    assert.ok(xml.includes('<D:multistatus'))
    const entries = responsesOf(xml)
    assert.equal(entries.length, 1, `depth0 应只含自身 1 条，实际 ${entries.map((e) => e.href).join(',')}`)
    assert.equal(entries[0].href, '/')
    assert.ok(entries[0].chunk.includes('<D:collection'), '根是 collection')
  })

  it('depth 1 → 自身 + 直接子项（根：直接子项恰 4 条，href 集合精确）', async () => {
    const res = await PROP(h, '/', '1')
    assert.equal(res.status, 207)
    const entries = responsesOf(await res.text())
    const children = entries.filter((e) => e.href !== '/')
    assert.equal(entries.length, 5, `depth1 = 自身 1 条 + 子项 4 条，实际 ${entries.map((e) => e.href).join(',')}`)
    assert.equal(children.length, 4, `直接子项应 4 条（自身另计），实际 ${children.length}`)
    assert.deepEqual(
      children.map((e) => e.href).sort(),
      ['/a%20b.txt', '/a%2520b.txt', '/a.txt', '/notes/'],
    )
  })

  it('notes/ 的 href 以 / 结尾且带 <D:collection，depth1 含 meeting.md', async () => {
    const res = await PROP(h, '/notes/', '1')
    assert.equal(res.status, 207)
    const entries = responsesOf(await res.text())
    assert.equal(entries.length, 2, `notes depth1 应为自身+meeting.md 共 2 条，实际 ${entries.map((e) => e.href).join(',')}`)
    const dir = entries.find((e) => e.href === '/notes/')
    assert.ok(dir, '缺 /notes/ 条目')
    assert.ok(dir.href.endsWith('/'), '目录 href 以 / 结尾')
    assert.ok(dir.chunk.includes('<D:collection'), '目录条目带 <D:collection')
    assert.ok(entries.some((e) => e.href === '/notes/meeting.md'))
  })

  it('磁盘名 a b.txt（空格名）→ href 精确 /a%20b.txt', async () => {
    const res = await PROP(h, '/a%20b.txt', '0')
    assert.equal(res.status, 207)
    const [entry] = responsesOf(await res.text())
    assert.equal(entry.href, '/a%20b.txt')
  })

  it('磁盘名 a%20b.txt（字面 % 名）→ href 精确 /a%2520b.txt（% 编码为 %25，单次解码往返铁律）', async () => {
    const res = await PROP(h, '/a%2520b.txt', '0')
    assert.equal(res.status, 207)
    const [entry] = responsesOf(await res.text())
    assert.equal(entry.href, '/a%2520b.txt')
  })

  it('文件 response 含 getcontentlength=5、带引号 getetag、getlastmodified', async () => {
    const res = await PROP(h, '/a.txt', '0')
    const [{ chunk }] = responsesOf(await res.text())
    assert.ok(chunk.includes('<D:getcontentlength>5</D:getcontentlength>'))
    // 原始 XML 里引号按 XML 转义为 &quot;（responseXml 全文本转义口径），解析器解码后即 `"5-<秒>"`
    assert.match(chunk, /<D:getetag>&quot;5-\d+&quot;<\/D:getetag>/, 'ETag 形如 "size-mtime秒" 且带引号（XML 转义形态）')
    assert.ok(chunk.includes('<D:getlastmodified>'))
  })

  it('不存在 → 404', async () => {
    assert.equal((await PROP(h, '/ghost.txt', '0')).status, 404)
  })

  it('Depth: infinity → 400（只实现 0|1）', async () => {
    assert.equal((await PROP(h, '/', 'infinity')).status, 400)
  })
})

// ───────────────────────── GET / HEAD ─────────────────────────

describe('GET / HEAD', () => {
  let h
  before(async () => {
    h = await makeServer()
  })
  after(() => h.close())

  it('PUT 后 GET 200 body 逐字节一致 + Content-Type 按扩展名（.md → text/markdown 开头）', async () => {
    const put = await h.fetch('/hello.md', { method: 'PUT', body: '# 你好 WebDAV\n' })
    assert.equal(put.status, 201)
    const res = await h.fetch('/hello.md')
    assert.equal(res.status, 200)
    assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), '# 你好 WebDAV\n')
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/markdown'))
  })

  it('UTF-8 + CJK 文件名（草稿 v2.md）PUT→GET roundtrip，PROPFIND href 单次编码', async () => {
    const p = '/%E8%8D%89%E7%A8%BF%20v2.md'
    const put = await h.fetch(p, { method: 'PUT', body: '# 草稿\n' })
    assert.equal(put.status, 201)
    assert.ok(fs.existsSync(join(h.root, '草稿 v2.md')), '磁盘应出现解码后的真名文件')
    const res = await h.fetch(p)
    assert.equal(res.status, 200)
    assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), '# 草稿\n')
    const prop = await PROP(h, p, '0')
    assert.equal(responsesOf(await prop.text())[0].href, '/%E8%8D%89%E7%A8%BF%20v2.md')
  })

  it('HEAD 200：content-length 正确 + etag + accept-ranges: bytes 且无 body（裸 socket 字节面）', async () => {
    await h.fetch('/head.txt', { method: 'PUT', body: 'head!' })
    const text = await h.socket('HEAD /head.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    const sep = text.indexOf('\r\n\r\n')
    assert.notEqual(sep, -1, '响应缺头部终止符')
    const head = text.slice(0, sep).toLowerCase()
    assert.match(head, /^http\/1\.1 200/)
    assert.match(head, /content-length: 5\r\n/)
    assert.match(head, /^etag: "5-\d+"\r\n/m)
    assert.match(head, /accept-ranges: bytes\r\n/)
    assert.equal(text.slice(sep + 4), '', 'HEAD 不得携带任何 body 字节')
  })

  it('GET 缺失 → 404', async () => {
    assert.equal((await h.fetch('/ghost.txt')).status, 404)
  })

  it('GET 目录 → 400（collection 无可读字节面）', async () => {
    assert.equal((await h.fetch('/adirhere', { method: 'MKCOL' })).status, 201)
    assert.equal((await h.fetch('/adirhere')).status, 400)
  })
})

// ───────────────────────── PUT ─────────────────────────

describe('PUT（整包）', () => {
  let h
  before(async () => {
    h = await makeServer()
  })
  after(() => h.close())

  it('新建 → 201（带 ETag）', async () => {
    const res = await h.fetch('/new.txt', { method: 'PUT', body: 'v1' })
    assert.equal(res.status, 201)
    assert.match(res.headers.get('etag') ?? '', /^"2-\d+"$/)
  })

  it('覆盖 → 204 且内容被替换', async () => {
    const res = await h.fetch('/new.txt', { method: 'PUT', body: 'v2-longer' })
    assert.equal(res.status, 204)
    assert.equal(await (await h.fetch('/new.txt')).text(), 'v2-longer')
  })

  it('父目录缺失 → 409', async () => {
    const res = await h.fetch('/ghost-dir/x.txt', { method: 'PUT', body: 'x' })
    assert.equal(res.status, 409)
  })
})

// ───────────────────────── 非标 Content-Range 追加 ─────────────────────────

describe('非标 Content-Range 追加（bytes=-N）', () => {
  let h
  before(async () => {
    h = await makeServer()
  })
  after(() => h.close())

  it('目标不存在 + bytes=-0 + body → 201（内容=body）', async () => {
    const res = await h.fetch('/log.txt', { method: 'PUT', headers: { 'content-range': 'bytes=-0' }, body: 'abc' })
    assert.equal(res.status, 201)
    assert.equal(await (await h.fetch('/log.txt')).text(), 'abc')
  })

  it('5 字节基线 bytes=-5 追加 3 字节 → 204、全文 8 字节拼接、ETag 变化', async () => {
    const first = await h.fetch('/app.bin', { method: 'PUT', body: '12345' })
    assert.equal(first.status, 201)
    const etag1 = first.headers.get('etag')
    const res = await h.fetch('/app.bin', { method: 'PUT', headers: { 'content-range': 'bytes=-5' }, body: 'xyz' })
    assert.equal(res.status, 204)
    const etag2 = res.headers.get('etag')
    assert.ok(etag2, '追加响应应回新 ETag')
    assert.notEqual(etag1, etag2, '追加后 ETag 必须变化')
    const full = await (await h.fetch('/app.bin')).arrayBuffer()
    assert.equal(full.byteLength, 8)
    assert.equal(Buffer.from(full).toString(), '12345xyz')
  })

  it('bytes=-4（基线不符）→ 409 且原文不被破坏', async () => {
    await h.fetch('/guard.txt', { method: 'PUT', body: '12345' })
    const res = await h.fetch('/guard.txt', { method: 'PUT', headers: { 'content-range': 'bytes=-4' }, body: 'zz' })
    assert.equal(res.status, 409)
    assert.equal(await (await h.fetch('/guard.txt')).text(), '12345', '409 后原文须原样保留')
  })

  it('标准形态 bytes=0-5/10 → 400（只支持 bytes=-N 追加）', async () => {
    const res = await h.fetch('/app.bin', { method: 'PUT', headers: { 'content-range': 'bytes=0-5/10' }, body: 'abcdef' })
    assert.equal(res.status, 400)
  })
})

// ───────────────────────── Range 读 ─────────────────────────

describe('Range 读', () => {
  let h
  before(async () => {
    h = await makeServer({ seeds: { 'ten.bin': '0123456789' } })
  })
  after(() => h.close())

  it('bytes=2-5 → 206 + content-range: bytes 2-5/10 + body=第 2..5 字节', async () => {
    const res = await h.fetch('/ten.bin', { headers: { range: 'bytes=2-5' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(res.headers.get('content-length'), '4')
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '2345')
  })

  it('bytes=4- → 206 尾段（4..9）', async () => {
    const res = await h.fetch('/ten.bin', { headers: { range: 'bytes=4-' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 4-9/10')
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '456789')
  })

  it('bytes=-3 → 206 最后 3 字节（7..9）', async () => {
    const res = await h.fetch('/ten.bin', { headers: { range: 'bytes=-3' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 7-9/10')
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '789')
  })

  it('bytes=99-（start≥total）→ 416 + content-range: bytes */10', async () => {
    const res = await h.fetch('/ten.bin', { headers: { range: 'bytes=99-' } })
    assert.equal(res.status, 416)
    assert.equal(res.headers.get('content-range'), 'bytes */10')
  })

  it('多区间 bytes=0-1,3-4 → 206 且只回第一区间（0-1）', async () => {
    const res = await h.fetch('/ten.bin', { headers: { range: 'bytes=0-1,3-4' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 0-1/10')
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '01')
  })
})

// ───────────────────────── MKCOL ─────────────────────────

describe('MKCOL', () => {
  let h
  before(async () => {
    h = await makeServer()
  })
  after(() => h.close())

  it('新建（不带尾斜杠）→ 201', async () => {
    assert.equal((await h.fetch('/docs', { method: 'MKCOL' })).status, 201)
    assert.ok(fs.statSync(join(h.root, 'docs')).isDirectory())
  })

  it('新建（带尾斜杠）→ 201', async () => {
    assert.equal((await h.fetch('/docs2/', { method: 'MKCOL' })).status, 201)
    assert.ok(fs.statSync(join(h.root, 'docs2')).isDirectory())
  })

  it('已存在 → 405（不覆盖）', async () => {
    assert.equal((await h.fetch('/docs', { method: 'MKCOL' })).status, 405)
  })

  it('父目录缺失 → 409', async () => {
    assert.equal((await h.fetch('/ghost/child', { method: 'MKCOL' })).status, 409)
  })
})

// ───────────────────────── COPY / MOVE ─────────────────────────

describe('COPY / MOVE', () => {
  let h
  before(async () => {
    h = await makeServer({ seeds: { 'src.txt': 'copy-me', 'tree/inner.txt': 'inner-body' } })
  })
  after(() => h.close())

  it('COPY 文件 → 201 且 GET 目的=源内容', async () => {
    const res = await h.fetch('/src.txt', { method: 'COPY', headers: { destination: `${h.base}/dst.txt` } })
    assert.equal(res.status, 201)
    assert.equal(await (await h.fetch('/dst.txt')).text(), 'copy-me')
  })

  it('目的已存在 + Overwrite: T → 204 且内容被替换', async () => {
    await h.fetch('/ow-dst.txt', { method: 'PUT', body: 'old' })
    const res = await h.fetch('/src.txt', { method: 'COPY', headers: { destination: `${h.base}/ow-dst.txt`, overwrite: 'T' } })
    assert.equal(res.status, 204)
    assert.equal(await (await h.fetch('/ow-dst.txt')).text(), 'copy-me')
  })

  it('Overwrite: F + 目的存在 → 412 且目的保持原内容', async () => {
    await h.fetch('/keep.txt', { method: 'PUT', body: 'other' })
    const res = await h.fetch('/src.txt', { method: 'COPY', headers: { destination: `${h.base}/keep.txt`, overwrite: 'F' } })
    assert.equal(res.status, 412)
    assert.equal(await (await h.fetch('/keep.txt')).text(), 'other')
  })

  it('缺 Destination → 400', async () => {
    assert.equal((await h.fetch('/src.txt', { method: 'COPY' })).status, 400)
  })

  it('源缺失 → 404', async () => {
    const res = await h.fetch('/ghost.txt', { method: 'COPY', headers: { destination: `${h.base}/anywhere.txt` } })
    assert.equal(res.status, 404)
  })

  it('COPY 目录 → 递归（子项随行）', async () => {
    const res = await h.fetch('/tree', { method: 'COPY', headers: { destination: `${h.base}/tree-copy` } })
    assert.equal(res.status, 201)
    assert.equal(await (await h.fetch('/tree-copy/inner.txt')).text(), 'inner-body')
  })

  it('MOVE 文件 → 201、源消失、目的在', async () => {
    const res = await h.fetch('/src.txt', { method: 'MOVE', headers: { destination: `${h.base}/moved.txt` } })
    assert.equal(res.status, 201)
    assert.equal((await h.fetch('/src.txt')).status, 404)
    assert.equal(await (await h.fetch('/moved.txt')).text(), 'copy-me')
  })

  it('MOVE 目录 → 源树消失、目的树在', async () => {
    const res = await h.fetch('/tree', { method: 'MOVE', headers: { destination: `${h.base}/tree-moved` } })
    assert.equal(res.status, 201)
    assert.equal((await h.fetch('/tree/inner.txt')).status, 404)
    assert.equal((await PROP(h, '/tree', '0')).status, 404)
    assert.equal(await (await h.fetch('/tree-moved/inner.txt')).text(), 'inner-body')
  })

  it('目的===源（文件同路径；目录进自身内部）→ 403', async () => {
    const file = await h.fetch('/moved.txt', { method: 'COPY', headers: { destination: `${h.base}/moved.txt` } })
    assert.equal(file.status, 403)
    const dir = await h.fetch('/tree-moved', { method: 'MOVE', headers: { destination: `${h.base}/tree-moved/deeper` } })
    assert.equal(dir.status, 403)
  })
})

// ───────────────────────── DELETE ─────────────────────────

describe('DELETE', () => {
  let h
  before(async () => {
    h = await makeServer()
  })
  after(() => h.close())

  it('文件 → 204 且 HEAD 404', async () => {
    await h.fetch('/gone.txt', { method: 'PUT', body: 'x' })
    assert.equal((await h.fetch('/gone.txt', { method: 'DELETE' })).status, 204)
    assert.equal((await h.fetch('/gone.txt', { method: 'HEAD' })).status, 404)
  })

  it('目录 → 递归 204（子项一并消失）', async () => {
    await h.fetch('/dirdel', { method: 'MKCOL' })
    await h.fetch('/dirdel/inner.txt', { method: 'PUT', body: 'x' })
    assert.equal((await h.fetch('/dirdel', { method: 'DELETE' })).status, 204)
    assert.equal((await PROP(h, '/dirdel', '0')).status, 404)
    assert.ok(!fs.existsSync(join(h.root, 'dirdel')), '磁盘目录应整体移除')
  })

  it('缺失 → 404', async () => {
    assert.equal((await h.fetch('/ghost.txt', { method: 'DELETE' })).status, 404)
  })
})

// ───────────────────────── 路径安全（node:http 原始请求） ─────────────────────────

describe('路径安全（node:http 原始请求，绕过 undici 的 .. 归一化）', () => {
  let h
  before(async () => {
    h = await makeServer({ seeds: { 'ok.txt': 'ok' } })
  })
  after(() => h.close())

  it('对照：正常路径 GET 200（证明 404 出自安全闸而非服务失能）', async () => {
    assert.equal((await h.fetch('/ok.txt')).status, 200)
  })

  it('GET /../escape.txt → 404 且 root/tmp 外无落盘', async () => {
    const res = await h.raw('GET', '/../escape.txt')
    assert.equal(res.status, 404)
    assert.ok(!fs.existsSync(join(dirname(h.root), 'escape.txt')), 'tmp 父目录被逃逸写入')
    assert.ok(!fs.existsSync(join(h.root, 'escape.txt')), 'root 内不该出现 escape.txt')
  })

  it('GET /a/../b.txt（归一前形态）→ 404（safeSegments 见字面 .. 段直接拒，实现无归一化放行路径）', async () => {
    const res = await h.raw('GET', '/a/../b.txt')
    assert.equal(res.status, 404)
    assert.ok(!fs.existsSync(join(h.root, 'b.txt')), '不应有 b.txt 落盘')
    assert.ok(!fs.existsSync(join(dirname(h.root), 'b.txt')), '不应越出 root 落盘')
  })

  it('GET /%2e%2e/secret → 404（解码后 .. 同拦）', async () => {
    assert.equal((await h.raw('GET', '/%2e%2e/secret')).status, 404)
  })

  it('GET /%00 → 404（空字节段）', async () => {
    assert.equal((await h.raw('GET', '/%00')).status, 404)
  })

  it('含 \\ 段（raw 反斜杠与 %5C 编码两形态）→ 404', async () => {
    assert.equal((await h.raw('GET', '/a%5Cb.txt')).status, 404)
    assert.equal((await h.raw('GET', '/a\\b.txt')).status, 404)
  })
})

// ───────────────────────── 鉴权 ─────────────────────────

describe('鉴权（Basic，双凭证非空启用）', () => {
  let h
  before(async () => {
    h = await makeServer({ username: 'walter', password: 's3cret', seeds: { 'a.txt': '5bytes' } })
  })
  after(() => h.close())

  it('无 Authorization → 401 + www-authenticate 含 Basic', async () => {
    const res = await PROP(h, '/a.txt', '0')
    assert.equal(res.status, 401)
    assert.ok((res.headers.get('www-authenticate') ?? '').includes('Basic'))
  })

  it('错密码 → 401', async () => {
    const res = await h.fetch('/a.txt', {
      method: 'PROPFIND',
      headers: { depth: '0', authorization: `Basic ${btoa('walter:wrong')}` },
    })
    assert.equal(res.status, 401)
  })

  it('正确 Basic（btoa(user:pass)）→ PROPFIND 207', async () => {
    const res = await h.fetch('/a.txt', {
      method: 'PROPFIND',
      headers: { depth: '0', authorization: `Basic ${btoa('walter:s3cret')}` },
    })
    assert.equal(res.status, 207)
  })
})

describe('鉴权缺省：仅 username 无 password → 仍匿名放行（双凭证门控）', () => {
  let h
  before(async () => {
    h = await makeServer({ username: 'half', seeds: { 'a.txt': '5bytes' } })
  })
  after(() => h.close())

  it('无 Authorization 的 PROPFIND → 207（不 401）', async () => {
    assert.equal((await PROP(h, '/a.txt', '0')).status, 207)
  })
})

// ───────────────────────── 未实现方法 ─────────────────────────

describe('未实现方法 → 405（带 CORS 头）', () => {
  let h
  before(async () => {
    h = await makeServer()
  })
  after(() => h.close())

  it('LOCK → 405 + ACAO:*', async () => {
    const res = await h.fetch('/x.txt', { method: 'LOCK' })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })

  it('POST → 405 + ACAO:*', async () => {
    const res = await h.fetch('/', { method: 'POST' })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })
})
