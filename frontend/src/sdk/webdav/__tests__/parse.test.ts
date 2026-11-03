/**
 * M1 协议层：parseMultistatus 单测（TDD 红先行——实现尚在同步落地，模块不存在=预期红）
 * 契约锚：《docs/design/webdav-support-design.md》§W1/W3（方案正本）
 *
 * 被测契约（frontend/src/sdk/webdav/parse.ts）：
 * - DavEntry { key: 相对 key、已 percent-decode、目录不带尾斜杠; isDir; size(目录=0); lastModified?(epoch ms); etag? }
 * - parseMultistatus(xmlText, collectionPath)：collectionPath=请求的【编码】路径（如 '/dav/docs/'）；
 *   href 剥该前缀 + decode 得 key；self 条目（href===collectionPath）排除；
 * - 解析失败 → SdkError(S3_ERROR)，错误信息含 'multistatus'
 *
 * 形状说明：jsdom 环境（DOMParser 可用）；fixtures 采用真实 WebDAV 服务器 207 形状
 * （d: 前缀与默认命名空间两种形态都覆盖）。
 */
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, SdkError } from '../../errorCodes'
import { parseMultistatus } from '../parse'

const COLLECTION = '/dav/docs/'

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>\n'

/** 单条 <d:response>：prop 缺省=空 resourcetype（文件） */
const resp = (href: string, prop = '<d:resourcetype/>'): string =>
  `<d:response><d:href>${href}</d:href>` +
  `<d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`

/** 目录属性（resourcetype 含 collection） */
const COLLECTION_PROP = '<d:resourcetype><d:collection/></d:resourcetype>'

/** 文件属性：size 必带，lastModified(HTTP-date)/etag 可选 */
const fileProp = (size: number, lastModified?: string, etag?: string): string =>
  '<d:resourcetype/>' +
  `<d:getcontentlength>${size}</d:getcontentlength>` +
  (lastModified ? `<d:getlastmodified>${lastModified}</d:getlastmodified>` : '') +
  (etag ? `<d:getetag>${etag}</d:getetag>` : '')

/** d: 前缀形态组装 multistatus */
const multistatusD = (inner: string, withDecl = true): string =>
  `${withDecl ? XML_DECL : ''}<d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`

const parse = (xmlText: string, collectionPath = COLLECTION): ReturnType<typeof parseMultistatus> =>
  parseMultistatus(xmlText, collectionPath)

describe('parseMultistatus（PROPFIND 207 multistatus 解析，§W3）', () => {
  it('基本形态：self 排除、collection→目录、文件字段透传、文档顺序保持', () => {
    const xml = multistatusD(
      resp(COLLECTION, COLLECTION_PROP) +
        resp('/dav/docs/sub/', COLLECTION_PROP) +
        resp('/dav/docs/a b.txt', fileProp(42, 'Tue, 01 Jul 2025 08:12:34 GMT', '"abc123"')),
    )
    const entries = parse(xml)

    // self（href===collectionPath）被排除；只剩 2 条
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.key)).toEqual(['sub', 'a b.txt'])

    // 目录：isDir=true、无尾斜杠、size=0（collection 无 getcontentlength）
    expect(entries[0]).toEqual({
      key: 'sub',
      isDir: true,
      size: 0,
      lastModified: undefined,
      etag: undefined,
    })

    // 文件：isDir=false、size 数值、HTTP-date→epoch ms、etag 透传
    expect(entries[1]).toEqual({
      key: 'a b.txt',
      isDir: false,
      size: 42,
      lastModified: Date.parse('Tue, 01 Jul 2025 08:12:34 GMT'),
      etag: '"abc123"',
    })
  })

  it('默认命名空间形态（xmlns="DAV:" 无前缀）同样可解析', () => {
    const xml =
      '<multistatus xmlns="DAV:">' +
      '<response><href>/dav/docs/</href><propstat><prop><resourcetype><collection/></resourcetype></prop>' +
      '<status>HTTP/1.1 200 OK</status></propstat></response>' +
      '<response><href>/dav/docs/plain.txt</href><propstat><prop><resourcetype/><getcontentlength>7</getcontentlength></prop>' +
      '<status>HTTP/1.1 200 OK</status></propstat></response>' +
      '</multistatus>'
    const entries = parse(xml)
    expect(entries.map((e) => e.key)).toEqual(['plain.txt'])
    expect(entries[0]).toMatchObject({ isDir: false, size: 7 })
  })

  it('percent 解码：空格/中文还原；+ 号不被误转空格', () => {
    const xml = multistatusD(
      resp('/dav/docs/a%20b.txt', fileProp(1)) +
        resp('/dav/docs/%E4%B8%AD%E6%96%87%E5%90%8D.txt', fileProp(2)) +
        resp('/dav/docs/a+b.txt', fileProp(3)),
    )
    const entries = parse(xml)
    expect(entries.map((e) => e.key)).toEqual(['a b.txt', '中文名.txt', 'a+b.txt'])
  })

  it('单次解码裁决：真名含合法 %XX 的 href 只解一次，不被二次解码成空格（防 a%20b.txt 与 a b.txt 撞 key）', () => {
    // 真名 'a%20b.txt' 的 href 即 'a%2520b.txt'：二次解码会误写成 'a b.txt'（M1-V1 评审推翻二次解码）
    const xml = multistatusD(resp('/dav/docs/a%2520b.txt', fileProp(9)))
    const entries = parse(xml)
    expect(entries.map((e) => e.key)).toEqual(['a%20b.txt'])
  })

  it('双重编码名（非规范服务器）如实呈现转义形态，不猜：逐段 %25 双重编码解一层保持单层编码', () => {
    // href 全部段落为 %25 双重编码形态：单次解码后 key='%E4%B8%AD.txt'（转义名如实透出，实机批次记录）
    const xml = multistatusD(resp('/dav/docs/%25E4%25B8%25AD.txt', fileProp(9)))
    const entries = parse(xml)
    expect(entries.map((e) => e.key)).toEqual(['%E4%B8%AD.txt'])
  })

  it('collectionPath 为编码路径：剥编码前缀后再 decode', () => {
    // 请求的是带空格目录（已编码）/dav/my%20docs/，href 同为编码形态
    const xml = multistatusD(resp('/dav/my%20docs/na me.txt', fileProp(5)))
    const entries = parse(xml, '/dav/my%20docs/')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ key: 'na me.txt', isDir: false, size: 5 })
  })

  it('目录缺 getcontentlength → size=0；缺 getlastmodified/getetag → undefined', () => {
    const xml = multistatusD(
      resp('/dav/docs/bare-dir/', COLLECTION_PROP) + resp('/dav/docs/bare.txt', '<d:resourcetype/>'),
    )
    const entries = parse(xml)
    expect(entries[0]).toEqual({ key: 'bare-dir', isDir: true, size: 0, lastModified: undefined, etag: undefined })
    expect(entries[1]).toEqual({ key: 'bare.txt', isDir: false, size: 0, lastModified: undefined, etag: undefined })
  })

  it('getlastmodified HTTP-date → epoch ms（Date.parse 口径）', () => {
    const xml = multistatusD(resp('/dav/docs/timed.txt', fileProp(3, 'Mon, 30 Jun 2025 10:00:00 GMT')))
    const entries = parse(xml)
    expect(entries[0].lastModified).toBe(Date.parse('Mon, 30 Jun 2025 10:00:00 GMT'))
  })

  it('嵌套容错：子 collection 无尾斜杠；更深层路径 key 原样保留（Depth:1 之外的形状不丢条目）', () => {
    const xml = multistatusD(
      resp('/dav/docs/parent/', COLLECTION_PROP) + resp('/dav/docs/parent/deep.txt', fileProp(11)),
    )
    const entries = parse(xml)
    expect(entries.map((e) => e.key)).toEqual(['parent', 'parent/deep.txt'])
    expect(entries[0].isDir).toBe(true)
    expect(entries[1].isDir).toBe(false)
    // 目录 key 不得带尾斜杠（契约：目录不带尾斜杠）
    expect(entries[0].key.endsWith('/')).toBe(false)
  })

  it('坏 XML → SdkError(S3_ERROR)，错误信息含 multistatus 字样', async () => {
    const err = await Promise.resolve()
      .then(() => parse('<这不是 xml <<<'))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    const text = `${(err as SdkError).message}${String((err as SdkError).detail)}`
    expect(text).toContain('multistatus')
  })

  it('<?xml 声明 + 空 multistatus（无子节点）→ []', () => {
    expect(parse(multistatusD(''))).toEqual([])
  })
})
