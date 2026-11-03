#!/usr/bin/env node
/**
 * dev-webdav.mjs —— 演示用 WebDAV 服务端（零依赖 Node ESM；RFC 4918 class 1 子集 + 非标追加写）
 *
 *   端口 5240（WEBDAV_PORT 覆盖）；数据目录缺省 <demo>/s3-data/mmagic-demo——与 dev-s3 的 s3rver
 *   桶 mmagic-demo 共享同一数据池（两边上传/建目录互相可见；CLI 启动即 mkdir recursive，S3 未启动
 *   时目录由本服务建出，双方都只做普通文件系统读写、无冲突），collection=真实文件系统目录，
 *   CLI 启动即灌入种子文件；WEBDAV_ROOT 环境变量可指向独立目录（优先级最高，想与 S3 数据隔离时用）
 *   共享语义边界：S3 无真目录（「目录」由键路径前缀涌现，s3rver 仅对 `dir/` 型标记键在磁盘仿真出目录）
 *   ↔ WebDAV 目录=真目录；WebDAV 侧建的空目录在 S3 列举侧不可见（无键即无前缀），文件级互通无障碍
 *   鉴权：WEBDAV_USERNAME 与 WEBDAV_PASSWORD 都非空才启用 Basic（realm="mmagix"，头缺失/错
 *   → 401 + WWW-Authenticate）；缺省匿名（对齐 dev-s3 的「演示不设防」口径）
 *   CORS：所有响应（含 4xx/207）带 Access-Control-Allow-Origin:* 与 Expose-Headers
 *   （ETag/Content-Length/Content-Type/Content-Range/Last-Modified/DAV）；OPTIONS → 204 预检
 *   放行扩展方法（浏览器 fetch 直连 PROPFIND/MKCOL/COPY/MOVE 无需代理，故预检不设鉴权）
 *
 *   方法集：OPTIONS / GET / HEAD / PUT / DELETE / MKCOL / COPY / MOVE / PROPFIND(Depth 0|1)；
 *   LOCK/UNLOCK/POST 等未实现 → 405
 *   **非标 PUT Content-Range: bytes=-N 追加写**（本服务器的核心存在理由，Nextcloud 同型——
 *   HTTP Range 只为 GET 定义，写侧续写无 RFC 标准）：N=期望的当前已有字节数。目标不存在且
 *   N=0 → 201 创建；size===N → 204 追加（回新 ETag）；size!==N → 409 Conflict（客户端上传
 *   队列靠它触发会话重置）；其它 Content-Range 形态 → 400
 *
 *   与 frontend/src/sdk/webdav 客户端的对齐点（破坏即解析错位，勿动）：
 *   - 路径逐段 decodeURIComponent 仅一次（parse.ts decodeSegment 口径）：磁盘名 `a%20b.txt`
 *     的 href 必须编码成 `a%2520b.txt`（% 本身编码），单次解码还原真名、不与 `a b.txt` 撞 key
 *   - 207 元素名固定 multistatus/response/href/propstat/prop/resourcetype/collection/
 *     getcontentlength/getlastmodified/getetag/getcontenttype/displayname——客户端
 *     getElementsByTagNameNS('*') 按 localName 取，前缀形态任意、名字不能变
 *   - Depth:1 响应必须含自身条目（客户端 parseMultistatus 自行按 collectionPath 剥 self）
 *   - 续传探测（probeUploadProgress）靠 HEAD 的 Content-Length → HEAD 与 GET 同头不省略
 *   - 本服务器无锁概念，永不出现 423——客户端 423 分支仅对真实服务器有意义
 *
 *   零依赖、同步 fs（演示规模）；每方法一个处理函数；兜底 try/catch → 500 + CORS 头。
 */
import http from 'node:http'
import { appendFileSync, copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ───────────────────────── 纯工具 ─────────────────────────

/** 扩展名 → Content-Type（PROPFIND getcontenttype 与 GET/HEAD 共用一表；未知 → octet-stream） */
const MIME_BY_EXT = {
  '.md': 'text/markdown', '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}

function mimeOf(name) {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

function xmlEscape(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
}

function rfc1123(ms) {
  return new Date(ms).toUTCString()
}

/** ETag = "<size>-<mtime秒>"（带引号；目录 size 记 0）——PROPFIND 与 GET/HEAD 同源不漂移 */
function etagOf(st) {
  return `"${st.isFile() ? st.size : 0}-${Math.floor(st.mtimeMs / 1000)}"`
}

function statSafe(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

/**
 * URL path 逐段 decodeURIComponent 仅一次（契约铁律，客户端 parse.ts 同口径）+ 路径安全：
 * `..` 段 / `\` / 空字节段 / 解码失败（非法 % 序列）→ 拒。解码后校验（`%2E%2E`、`%5C`、
 * `%00` 等编码形态同样被拦）；越界兜底见 fsPathOf 的 resolve 前缀校验。
 */
function safeSegments(pathname) {
  const out = []
  for (const seg of pathname.split('/')) {
    if (seg === '') continue
    let dec
    try {
      dec = decodeURIComponent(seg)
    } catch {
      return null
    }
    if (dec === '..' || dec.includes('\\') || dec.includes('\0')) return null
    out.push(dec)
  }
  return out
}

/** 解码段数组 → href：逐段 encodeURIComponent（% → %25，磁盘 `a%20b.txt` → `a%2520b.txt`）；
 *  目录以 / 结尾，根恒 '/' */
function hrefOf(segs, isDir) {
  const p = `/${segs.map(encodeURIComponent).join('/')}`
  return isDir && p !== '/' ? `${p}/` : p
}

/** URI/path → 原始 path（剥 scheme://host 与 query；**不做点段归一**——new URL 的 pathname 会把
 *  字面 `..` 折叠掉，路径安全闸必须见到原始段才能按契约 404） */
function rawPathnameOf(target) {
  let p = String(target ?? '/')
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(p)
  if (scheme) {
    const rest = p.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    p = slash === -1 ? '/' : rest.slice(slash)
  }
  const q = p.indexOf('?')
  return q === -1 ? p : p.slice(0, q)
}

/** 逐段读请求体（演示规模：内存整聚 Buffer 即可） */
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const UNSATISFIABLE = { unsatisfiable: true }

/**
 * GET Range 单区间解析（多区间只取第一区间——正则天然取首段）：`bytes=N-`（到尾）/
 * `bytes=N-M`（钳到 total-1）/ `bytes=-N`（读侧后缀，最后 N 字节）；非法形态 / 逆序 /
 * start≥total / total=0 → UNSATISFIABLE（上层 416）；无 Range 头 → null（200 全量）。
 */
function parseRange(header, total) {
  const text = header === undefined || header === null ? '' : String(header).trim()
  if (text === '') return null
  const m = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)/.exec(text)
  if (!m) return UNSATISFIABLE
  const [startText, endText] = [m[1], m[2]]
  if (startText === '' && endText === '') return UNSATISFIABLE
  if (startText === '') {
    const n = Number(endText)
    if (n === 0 || total === 0) return UNSATISFIABLE
    return { start: Math.max(0, total - n), end: total - 1 }
  }
  const start = Number(startText)
  if (endText === '') return start >= total ? UNSATISFIABLE : { start, end: total - 1 }
  const end = Number(endText)
  if (start > end || start >= total) return UNSATISFIABLE
  return { start, end: Math.min(end, total - 1) }
}

// ───────────────────────── 服务器工厂 ─────────────────────────

/**
 * createServer({ root, port, username?, password? }) → { start, close, port }
 * start() resolve 实际端口（port=0 时系统分配，实例 port 同步刷新）；close() 幂等收摊。
 */
export function createServer({ root, port = 0, username = '', password = '' } = {}) {
  const rootAbs = resolve(root)
  const authRequired = username !== '' && password !== ''
  let boundPort = port

  /** 安全段数组 → 磁盘绝对路径；resolve 后越出 root（前缀校验）→ null（上层 404） */
  function fsPathOf(segs) {
    const p = resolve(rootAbs, ...segs)
    return p === rootAbs || p.startsWith(rootAbs + sep) ? p : null
  }

  /** 统一出口：CORS 两头恒在（含 4xx/207）；HEAD 无 body 但保留调用方给的 Content-Length（probe 靠它） */
  function respond(res, req, status, headers = {}, body) {
    const all = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Type, Content-Range, Last-Modified, DAV',
      ...headers,
    }
    if (status === 204) {
      // 204 不带 body/Content-Length（RFC 7230）
      res.writeHead(204, all)
      res.end()
      return
    }
    if (body === undefined || req.method === 'HEAD') {
      if (all['Content-Length'] === undefined) all['Content-Length'] = '0'
      res.writeHead(status, all)
      res.end()
      return
    }
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    all['Content-Length'] = String(buf.length)
    res.writeHead(status, all)
    res.end(buf)
  }

  // ── PROPFIND：207 multistatus（Depth 0=自身；1=自身+直接子项；其它 → 400）──

  function handlePropfind(req, res, target) {
    const depth = String(req.headers.depth ?? '').trim()
    if (depth !== '0' && depth !== '1') return respond(res, req, 400, {}, 'PROPFIND 仅支持 Depth: 0|1（infinity 不实现）')
    const st = statSafe(target.fsPath)
    if (!st) return respond(res, req, 404, {}, 'Not Found')
    const listing = [{ segs: target.segs, isDir: st.isDirectory(), st }]
    if (depth === '1' && st.isDirectory()) {
      for (const name of readdirSync(target.fsPath).sort()) {
        const cst = statSafe(join(target.fsPath, name))
        if (cst) listing.push({ segs: [...target.segs, name], isDir: cst.isDirectory(), st: cst })
      }
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${listing.map((e) => responseXml(e.segs, e.isDir, e.st)).join('')}</D:multistatus>`
    respond(res, req, 207, { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1' }, xml)
  }

  /** 单条 <D:response>：元素名固定（客户端按 localName 全命名空间匹配），文本一律 XML 转义 */
  function responseXml(segs, isDir, st) {
    const name = segs.length === 0 ? '' : segs[segs.length - 1]
    const props = isDir
      ? '<D:resourcetype><D:collection/></D:resourcetype>'
      : `<D:resourcetype/><D:getcontentlength>${st.size}</D:getcontentlength><D:getcontenttype>${xmlEscape(mimeOf(name))}</D:getcontenttype>`
    return (
      `<D:response><D:href>${xmlEscape(hrefOf(segs, isDir))}</D:href>` +
      `<D:propstat status="HTTP/1.1 200 OK"><D:prop>${props}` +
      `<D:getlastmodified>${xmlEscape(rfc1123(st.mtimeMs))}</D:getlastmodified>` +
      `<D:getetag>${xmlEscape(etagOf(st))}</D:getetag>` +
      `<D:displayname>${xmlEscape(name)}</D:displayname>` +
      `</D:prop></D:propstat></D:response>`
    )
  }

  // ── GET/HEAD：同头（ETag/Content-Length/Accept-Ranges/Content-Type/Last-Modified），HEAD 无 body ──

  function handleGet(req, res, target, isHead) {
    const st = statSafe(target.fsPath)
    if (!st) return respond(res, req, 404, {}, 'Not Found')
    if (st.isDirectory()) return respond(res, req, 400, {}, 'GET/HEAD 对 collection 非法（目录无可读字节面）')
    const name = target.segs[target.segs.length - 1] ?? ''
    const base = {
      'Content-Type': mimeOf(name),
      ETag: etagOf(st),
      'Accept-Ranges': 'bytes',
      'Last-Modified': rfc1123(st.mtimeMs),
    }
    const range = parseRange(req.headers.range, st.size)
    if (range === null) {
      respond(res, req, 200, { ...base, 'Content-Length': String(st.size) }, isHead ? undefined : readFileSync(target.fsPath))
      return
    }
    if (range.unsatisfiable) {
      respond(res, req, 416, { 'Content-Range': `bytes */${st.size}` }, isHead ? undefined : 'Range Not Satisfiable')
      return
    }
    const body = isHead ? undefined : readFileSync(target.fsPath).subarray(range.start, range.end + 1)
    respond(res, req, 206, { ...base, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}` }, body)
  }

  // ── PUT：整包（201 新建/204 覆盖）或非标追加 bytes=-N（201/204/409/400）──

  function handlePut(req, res, target, body) {
    const parent = statSafe(dirname(target.fsPath))
    if (!parent || !parent.isDirectory()) return respond(res, req, 409, {}, '父目录（collection）缺失')
    const st = statSafe(target.fsPath)
    if (st && st.isDirectory()) return respond(res, req, 409, {}, '目标路径已是 collection，文件 PUT 不得覆盖目录')
    const contentRange = req.headers['content-range']
    if (contentRange === undefined) {
      writeFileSync(target.fsPath, body)
      respond(res, req, st ? 204 : 201, { ETag: etagOf(statSafe(target.fsPath)) })
      return
    }
    const m = /^bytes\s*=\s*-(\d+)$/.exec(String(contentRange).trim())
    if (!m) return respond(res, req, 400, {}, '仅支持非标追加写 Content-Range: bytes=-N（N=期望的当前已有字节数），其它形态一律 400')
    const expect = Number(m[1])
    if (!st) {
      if (expect !== 0) return respond(res, req, 409, {}, `追加基线不匹配：目标不存在而期望 bytes=-${expect}≠0`)
      writeFileSync(target.fsPath, body)
      return respond(res, req, 201, { ETag: etagOf(statSafe(target.fsPath)) })
    }
    if (st.size !== expect) {
      return respond(res, req, 409, {}, `追加基线不匹配：已有 ${st.size}B ≠ 期望 ${expect}B（客户端据此重置上传会话）`)
    }
    appendFileSync(target.fsPath, body)
    respond(res, req, 204, { ETag: etagOf(statSafe(target.fsPath)) })
  }

  // ── DELETE：文件 unlink / 目录递归 rm → 204；缺失 404；根受保护（demo 数据目录不塌方）──

  function handleDelete(req, res, target) {
    if (target.segs.length === 0) return respond(res, req, 403, {}, '拒绝删除数据目录根')
    const st = statSafe(target.fsPath)
    if (!st) return respond(res, req, 404, {}, 'Not Found')
    if (st.isDirectory()) rmSync(target.fsPath, { recursive: true, force: true })
    else unlinkSync(target.fsPath)
    respond(res, req, 204)
  }

  // ── MKCOL：父存在且目标不存在 → 201；已存在 405；父缺失 409（尾斜杠与否均按目录）──

  function handleMkcol(req, res, target) {
    if (statSafe(target.fsPath)) return respond(res, req, 405, {}, '目标已存在（RFC 4918：MKCOL 不覆盖）')
    const parent = statSafe(dirname(target.fsPath))
    if (!parent || !parent.isDirectory()) return respond(res, req, 409, {}, '父目录（collection）缺失')
    mkdirSync(target.fsPath)
    respond(res, req, 201)
  }

  // ── COPY/MOVE：Destination（绝对 URI 取 path，同一路径安全规则）+ Overwrite（缺省=T）──

  function handleCopyMove(req, res, target, isMove) {
    const destHeader = req.headers.destination
    if (destHeader === undefined) return respond(res, req, 400, {}, 'COPY/MOVE 需要 Destination 头')
    const destPathname = rawPathnameOf(destHeader) // 绝对 URI 取 path 部分，同一路径安全规则（无点段归一）
    const destSegs = safeSegments(destPathname)
    if (!destSegs) return respond(res, req, 404, {}, 'Destination 路径不安全（../反斜杠/空字节/非法 % 序列）')
    if (destSegs.length === 0) return respond(res, req, 403, {}, '拒绝以数据目录根为目标')
    const destFs = fsPathOf(destSegs)
    if (!destFs) return respond(res, req, 404, {}, 'Destination 越出数据目录')
    const srcSt = statSafe(target.fsPath)
    if (!srcSt) return respond(res, req, 404, {}, '源资源不存在')
    if (target.segs.length === 0) return respond(res, req, 403, {}, '拒绝以数据目录根为源')
    // 目的段以 / 结尾 → 目录语义：dir 源按该路径成目录；file 源并入该目录保源名（RFC 4918 §9.8.3 同型）
    let finalFs = destFs
    if (/\/$/.test(destPathname) && !srcSt.isDirectory()) {
      const dst = statSafe(destFs)
      if (!dst || !dst.isDirectory()) return respond(res, req, 409, {}, 'Destination 以 / 结尾但目标 collection 不存在')
      finalFs = join(destFs, basename(target.fsPath))
    }
    if (finalFs === target.fsPath || (srcSt.isDirectory() && finalFs.startsWith(target.fsPath + sep))) {
      return respond(res, req, 403, {}, '目的与源相同或在源内部')
    }
    const overwrite = String(req.headers.overwrite ?? 'T').trim().toUpperCase() !== 'F'
    const existed = statSafe(finalFs)
    if (existed && !overwrite) return respond(res, req, 412, {}, '目标已存在且 Overwrite: F')
    const parent = statSafe(dirname(finalFs))
    if (!parent || !parent.isDirectory()) return respond(res, req, 409, {}, '目标父目录（collection）缺失')
    if (existed) rmSync(finalFs, { recursive: true, force: true }) // Overwrite: T（或缺省）：先删再拷/移 → 204
    if (isMove) renameSync(target.fsPath, finalFs)
    else if (srcSt.isDirectory()) cpSync(target.fsPath, finalFs, { recursive: true })
    else copyFileSync(target.fsPath, finalFs)
    respond(res, req, existed ? 204 : 201)
  }

  /** Basic 鉴权：username+password 都非空才启用（authRequired 门控在 route 里）；比对失败/缺头 → 401 */
  function authOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return false
    try {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
      const i = decoded.indexOf(':')
      if (i === -1) return false
      return decoded.slice(0, i) === username && decoded.slice(i + 1) === password
    } catch {
      return false
    }
  }

  // ── 路由：OPTIONS 预检（不设鉴权，浏览器预检不带凭证）→ 鉴权 → 路径安全 → 方法分发 ──

  async function route(req, res) {
    const method = String(req.method ?? '').toUpperCase()
    if (method === 'OPTIONS') {
      const askHeaders = typeof req.headers['access-control-request-headers'] === 'string' ? String(req.headers['access-control-request-headers']).trim() : ''
      respond(res, req, 204, {
        DAV: '1',
        'Access-Control-Allow-Methods': 'GET,HEAD,PUT,DELETE,OPTIONS,PROPFIND,MKCOL,COPY,MOVE,LOCK,UNLOCK',
        'Access-Control-Allow-Headers': askHeaders !== '' ? askHeaders : '*',
        'Access-Control-Max-Age': '86400',
      })
      return
    }
    if (authRequired && !authOk(req)) {
      respond(res, req, 401, { 'WWW-Authenticate': 'Basic realm="mmagix"' }, '需要 Basic 认证')
      return
    }
    const segs = safeSegments(rawPathnameOf(req.url))
    if (!segs) return respond(res, req, 404, {}, '路径不安全（../反斜杠/空字节/非法 % 序列）')
    const fsPath = fsPathOf(segs)
    if (!fsPath) return respond(res, req, 404, {}, '路径越出数据目录')
    const target = { segs, fsPath }
    switch (method) {
      case 'PROPFIND':
        return handlePropfind(req, res, target)
      case 'GET':
      case 'HEAD':
        return handleGet(req, res, target, method === 'HEAD')
      case 'PUT':
        return handlePut(req, res, target, await readBody(req))
      case 'DELETE':
        return handleDelete(req, res, target)
      case 'MKCOL':
        return handleMkcol(req, res, target)
      case 'COPY':
        return handleCopyMove(req, res, target, false)
      case 'MOVE':
        return handleCopyMove(req, res, target, true)
      default:
        return respond(res, req, 405, {}, `方法 ${method} 未实现（演示服务器方法集见文件头注释）`)
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      // 兜底：任何处理函数抛出 → 500 + CORS 头（socket 已毁时安静放弃）
      try {
        respond(res, req, 500, {}, `dev-webdav 内部错误：${(err && err.message) || String(err)}`)
      } catch {
        try { res.end() } catch { /* 连接已断，无可清理 */ }
      }
    })
  })

  return {
    async start() {
      await new Promise((ok, fail) => {
        server.once('error', fail)
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', fail)
          ok()
        })
      })
      boundPort = server.address().port
      return boundPort
    },
    async close() {
      await new Promise((ok) => {
        server.close(ok)
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
      })
    },
    get port() {
      return boundPort
    },
  }
}

// ───────────────────────── CLI 入口（仅 node 直接执行本文件时） ─────────────────────────

/** 种子文件：与 dev-s3.mjs 同模式（装载后目录树/预览即有内容可看）；经 HTTP 灌入顺带自检整包 PUT */
const SEEDS = [
  { key: 'hello.md', type: 'text/markdown', body: `# MMagic-Files × WebDAV 演示\n\n这是一份由 **dev-webdav.mjs**（零依赖 Node WebDAV 服务端）提供的文件。\n\n- 目录树左侧应能看到它\n- 点开即渲染 Markdown 预览\n- 试着编辑保存（Ctrl+S）→ 整包 PUT\n- 连接向导开启「分片追加写」（chunkedWrite）可体验非标 PUT Content-Range: bytes=-N 续传\n\n> endpoint: http://localhost:5240 · root: s3-data/mmagic-demo（与 S3 演示共享） · 匿名可读写\n` },
  { key: 'notes/meeting.md', type: 'text/markdown', body: `# 会议纪要（WebDAV）\n\n## 事项\n1. iframe 接入演示走通（ready 握手 → workspace 装载）\n2. PROPFIND Depth:1 列目录 → 207 multistatus 解析入树\n\n## 待办\n- [ ] 上传一张图片试试预览\n- [ ] 建个目录拖文件进去\n` },
  { key: 'notes/草稿 v2.md', type: 'text/markdown', body: `# 草稿（文件名带空格与 CJK）\n\n本文件名故意含空格与中文：验证逐段 percent-encoding 往返——\nhref 里应为 \`%E8%8D%89%E7%A8%BF%20v2.md\`，客户端单次解码还原真名。\n` },
  { key: 'demo.csv', type: 'text/csv', body: `id,name,city,amount\n1,Alice,杭州,120.50\n2,Bob,上海,89.00\n3,Carol,深圳,240.75\n4,Dave,北京,15.20\n` },
  { key: 'logo.svg', type: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="16" fill="#67c23a"/><text x="60" y="70" font-size="40" fill="#fff" text-anchor="middle" font-family="sans-serif">DAV</text></svg>\n` },
]

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url))
  // 缺省=与 dev-s3 共享数据池（s3rver 桶 mmagic-demo 的磁盘目录）；WEBDAV_ROOT 覆盖（优先级最高）
  const dataRoot = process.env.WEBDAV_ROOT || join(here, '..', 's3-data', 'mmagic-demo')
  mkdirSync(dataRoot, { recursive: true })
  const cliUser = process.env.WEBDAV_USERNAME ?? ''
  const cliPass = process.env.WEBDAV_PASSWORD ?? ''
  const cliPort = Number(process.env.WEBDAV_PORT || 5240)
  const instance = createServer({ root: dataRoot, port: cliPort, username: cliUser, password: cliPass })
  const realPort = await instance.start()
  const base = `http://localhost:${realPort}`
  console.log(`webdav ready: ${base}  root=${dataRoot}  auth=${cliUser !== '' ? `${cliUser}/***` : 'anonymous'}`)
  const cliHeaders = cliUser !== '' && cliPass !== '' ? { authorization: `Basic ${Buffer.from(`${cliUser}:${cliPass}`).toString('base64')}` } : {}
  for (const { key, type, body } of SEEDS) {
    const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
    if (dir !== '') await fetch(`${base}/${dir}`, { method: 'MKCOL', headers: cliHeaders }).catch(() => {}) // 已存在 405 无害
    const res = await fetch(`${base}/${key}`, { method: 'PUT', headers: { ...cliHeaders, 'content-type': type }, body })
    console.log(`seed ${res.ok ? '✓' : '✗ ' + res.status} ${key} (${body.length}B)`)
  }
}
