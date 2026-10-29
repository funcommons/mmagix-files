/**
 * v1.2.0 S3 版本管理四方法测试（红先行）：getBucketVersioning / listObjectVersions / deleteVersion / listMultipartUploads
 * 断言口径与 client.test.ts 同构：mock fetcher 捕获 (url, init) 断言 method/URL/query 编码 + SigV4 头，
 * 响应用真实 S3 XML 形状（含 xmlns）；解析模式沿 client.ts 现有 DOMParser + getElementsByTagName。
 */
import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, SdkError } from '../../errorCodes'
import type { BackendConfig } from '../../types'
import { S3SigV4Client } from '../client'

const CONFIG: BackendConfig = {
  endpoint: 'https://s3.test',
  region: 'us-east-1',
  bucket: 'bkt',
  prefix: 'sessions/abc/',
  credentials: { accessKeyId: 'AKID', accessKeySecret: 'SK', sessionToken: 'TOK' },
}

/** 签名无关断言的公用校验：请求带了 SigV4 关键头（新方法走同一 request 管道） */
function expectSignedHeaders(init: RequestInit | undefined): void {
  const headers = (init?.headers ?? {}) as Record<string, string>
  expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//)
  expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  expect(headers['x-amz-security-token']).toBe('TOK')
  expect(headers['x-amz-content-sha256']).toBeTruthy()
}

function makeClient(responses: Response[] | ((url: string, init?: RequestInit) => Response)) {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
  if (Array.isArray(responses)) {
    for (const r of responses) fetcher.mockResolvedValueOnce(r)
  } else {
    fetcher.mockImplementation(async (url, init) => responses(url, init))
  }
  return { fetcher, client: new S3SigV4Client(CONFIG, fetcher) }
}

const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/xml' } })

/** 真实 S3 ListVersionsResult 形状（xmlns + Version/DeleteMarker 混排 + Next markers） */
const LIST_VERSIONS_XML = `<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bkt</Name>
  <Prefix>photos</Prefix>
  <KeyMarker>photos/a.txt</KeyMarker>
  <VersionIdMarker/>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <Version>
    <Key>photos/a.txt</Key>
    <VersionId>3HL4kqtJlcpXroDTDmjVBH40Nrjfkd</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2009-10-22T13:57:44.000Z</LastModified>
    <ETag>"fba9dede5f27731c9771645a39863328"</ETag>
    <Size>434234</Size>
    <StorageClass>STANDARD</StorageClass>
    <Owner><ID>owner-id-1</ID><DisplayName>owner</DisplayName></Owner>
  </Version>
  <Version>
    <Key>photos/a.txt</Key>
    <VersionId>oldest-version-000</VersionId>
    <IsLatest>false</IsLatest>
    <LastModified>2009-10-20T08:00:01.000Z</LastModified>
    <Size>1024</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
  <DeleteMarker>
    <Key>photos/removed.txt</Key>
    <VersionId>g0KT5s1Sf6AqaYtS38K4zgiFzijaGDpa</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2009-11-11T01:02:03.000Z</LastModified>
  </DeleteMarker>
  <DeleteMarker>
    <Key>photos/gone.txt</Key>
    <VersionId>marker-superseded-001</VersionId>
    <IsLatest>false</IsLatest>
    <LastModified>2009-11-10T09:30:00.000Z</LastModified>
  </DeleteMarker>
  <NextKeyMarker>photos/z.zip</NextKeyMarker>
  <NextVersionIdMarker>next-version-id-9=</NextVersionIdMarker>
</ListVersionsResult>`

describe('getBucketVersioning（回收站前置检测）', () => {
  it('GET ?versioning；<Status>Enabled → "Enabled"', async () => {
    const { fetcher, client } = makeClient([
      xml(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>`),
    ])
    expect(await client.getBucketVersioning()).toBe('Enabled')
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://s3.test/bkt?versioning')
    expect(init?.method).toBe('GET')
    expectSignedHeaders(init)
  })

  it('<Status>Suspended → "Suspended"', async () => {
    const { client } = makeClient([
      xml(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>`),
    ])
    expect(await client.getBucketVersioning()).toBe('Suspended')
  })

  it('空 VersioningConfiguration（未配置版本控制）→ "Disabled"', async () => {
    const { client } = makeClient([xml(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`)])
    expect(await client.getBucketVersioning()).toBe('Disabled')
  })

  it('非 2xx → S3_ERROR，detail={status}（沿用 client 现有错误模式）', async () => {
    const { client } = makeClient([xml('<Error><Code>NoSuchBucket</Code></Error>', 404)])
    const err = await client.getBucketVersioning().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 404 })
  })
})

describe('listObjectVersions（回收站/版本历史）', () => {
  it('Version 与 DeleteMarker 混合解析：IsLatest 布尔、LastModified epoch ms、Size 数值', async () => {
    const { fetcher, client } = makeClient([xml(LIST_VERSIONS_XML)])
    const result = await client.listObjectVersions({ prefix: 'photos/' })

    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://s3.test/bkt?versions&prefix=photos%2F')
    expect(init?.method).toBe('GET')
    expectSignedHeaders(init)

    expect(result.versions).toEqual([
      {
        key: 'photos/a.txt',
        versionId: '3HL4kqtJlcpXroDTDmjVBH40Nrjfkd',
        isLatest: true,
        lastModified: Date.parse('2009-10-22T13:57:44.000Z'),
        size: 434234,
      },
      {
        key: 'photos/a.txt',
        versionId: 'oldest-version-000',
        isLatest: false,
        lastModified: Date.parse('2009-10-20T08:00:01.000Z'),
        size: 1024,
      },
    ])
    expect(result.deleteMarkers).toEqual([
      {
        key: 'photos/removed.txt',
        versionId: 'g0KT5s1Sf6AqaYtS38K4zgiFzijaGDpa',
        isLatest: true,
        lastModified: Date.parse('2009-11-11T01:02:03.000Z'),
      },
      {
        key: 'photos/gone.txt',
        versionId: 'marker-superseded-001',
        isLatest: false,
        lastModified: Date.parse('2009-11-10T09:30:00.000Z'),
      },
    ])
    expect(result.isTruncated).toBe(true)
    expect(result.nextKeyMarker).toBe('photos/z.zip')
    expect(result.nextVersionIdMarker).toBe('next-version-id-9=')
  })

  it('分页参数全量透传（key-marker / version-id-marker / max-keys，RFC3986 编码）', async () => {
    const { fetcher, client } = makeClient([xml(LIST_VERSIONS_XML)])
    await client.listObjectVersions({ prefix: 'd ir/a+b/', keyMarker: 'k/1+2=', versionIdMarker: 'vid/1=', maxKeys: 50 })
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://s3.test/bkt?versions&prefix=d%20ir%2Fa%2Bb%2F&key-marker=k%2F1%2B2%3D&version-id-marker=vid%2F1%3D&max-keys=50',
    )
  })

  it('无参数 → 仅 ?versions（零多余 query）', async () => {
    const { fetcher, client } = makeClient([xml('<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>')])
    const result = await client.listObjectVersions()
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://s3.test/bkt?versions')
    expect(result.versions).toEqual([])
    expect(result.deleteMarkers).toEqual([])
    expect(result.isTruncated).toBe(false)
    expect(result.nextKeyMarker).toBeUndefined()
    expect(result.nextVersionIdMarker).toBeUndefined()
  })

  it('IsTruncated=false → 不透出 next markers', async () => {
    const { client } = makeClient([
      xml(`<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <IsTruncated>false</IsTruncated>
        <Version><Key>k.txt</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>1</Size></Version>
      </ListVersionsResult>`),
    ])
    const result = await client.listObjectVersions()
    expect(result.isTruncated).toBe(false)
    expect(result.nextKeyMarker).toBeUndefined()
    expect(result.nextVersionIdMarker).toBeUndefined()
  })

  it('非 2xx（403 普通 AccessDenied）→ CREDENTIAL_INVALID（沿用现有错误映射）', async () => {
    const { client } = makeClient([xml('<Error><Code>AccessDenied</Code></Error>', 403)])
    const err = await client.listObjectVersions().catch((e: unknown) => e)
    expect((err as SdkError).code).toBe(ERROR_CODES.CREDENTIAL_INVALID)
    expect((err as SdkError).detail).toMatchObject({ status: 403 })
  })
})

describe('deleteVersion（恢复：删 DeleteMarker / 彻底删除）', () => {
  it('DELETE /{key}?versionId=…；key 路径逐段编码、versionId query 编码；2xx 即成功', async () => {
    const { fetcher, client } = makeClient([new Response(null, { status: 204 })])
    await expect(client.deleteVersion('a dir/b+c.txt', 'vid/1+2=')).resolves.toBeUndefined()
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://s3.test/bkt/a%20dir/b%2Bc.txt?versionId=vid%2F1%2B2%3D')
    expect(init?.method).toBe('DELETE')
    expectSignedHeaders(init)
  })

  it('非 2xx → S3_ERROR，detail={status}', async () => {
    const { client } = makeClient([xml('<Error><Code>NoSuchVersion</Code></Error>', 404)])
    const err = await client.deleteVersion('k.txt', 'v1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkError)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toMatchObject({ status: 404 })
  })
})

describe('listMultipartUploads（孤儿 uploadId 清理）', () => {
  it('GET ?uploads；多 Upload 项解析 Key/UploadId/Initiated', async () => {
    const { fetcher, client } = makeClient([
      xml(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <Bucket>bkt</Bucket>
        <KeyMarker/>
        <UploadIdMarker/>
        <MaxUploads>1000</MaxUploads>
        <IsTruncated>false</IsTruncated>
        <Upload>
          <Key>big.bin</Key>
          <UploadId>UP/1+2=</UploadId>
          <Initiated>2026-01-01T00:00:00.000Z</Initiated>
        </Upload>
        <Upload>
          <Key>other dir/v.dat</Key>
          <UploadId>dVUtMi8z</UploadId>
          <Initiated>2026-01-02T12:34:56.000Z</Initiated>
        </Upload>
      </ListMultipartUploadsResult>`),
    ])
    const uploads = await client.listMultipartUploads()
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://s3.test/bkt?uploads')
    expect(init?.method).toBe('GET')
    expectSignedHeaders(init)
    expect(uploads).toEqual([
      { key: 'big.bin', uploadId: 'UP/1+2=', initiated: '2026-01-01T00:00:00.000Z' },
      { key: 'other dir/v.dat', uploadId: 'dVUtMi8z', initiated: '2026-01-02T12:34:56.000Z' },
    ])
  })

  it('空列表（无 Upload 项）→ []', async () => {
    const { client } = makeClient([
      xml(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <Bucket>bkt</Bucket>
        <IsTruncated>false</IsTruncated>
      </ListMultipartUploadsResult>`),
    ])
    expect(await client.listMultipartUploads()).toEqual([])
  })

  it('翻页聚合：IsTruncated 续列两页，NextKeyMarker/NextUploadIdMarker → key-marker/upload-id-marker（RFC3986 编码）', async () => {
    const { fetcher, client } = makeClient([
      xml(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <Bucket>bkt</Bucket>
        <MaxUploads>2</MaxUploads>
        <IsTruncated>true</IsTruncated>
        <Upload><Key>p1 dir/first.bin</Key><UploadId>up-1</UploadId><Initiated>2026-01-01T00:00:00.000Z</Initiated></Upload>
        <Upload><Key>p1 dir/last+1.bin</Key><UploadId>up-2</UploadId><Initiated>2026-01-02T00:00:00.000Z</Initiated></Upload>
        <NextKeyMarker>p1 dir/last+1.bin</NextKeyMarker>
        <NextUploadIdMarker>up-2</NextUploadIdMarker>
      </ListMultipartUploadsResult>`),
      xml(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <Bucket>bkt</Bucket>
        <KeyMarker>p1 dir/last+1.bin</KeyMarker>
        <UploadIdMarker>up-2</UploadIdMarker>
        <MaxUploads>2</MaxUploads>
        <IsTruncated>false</IsTruncated>
        <Upload><Key>p2 dir/third.bin</Key><UploadId>up-3</UploadId><Initiated>2026-01-03T00:00:00.000Z</Initiated></Upload>
      </ListMultipartUploadsResult>`),
    ])
    const uploads = await client.listMultipartUploads()

    // 跨页聚合齐全（内部循环翻页，不透出截断）
    expect(uploads).toEqual([
      { key: 'p1 dir/first.bin', uploadId: 'up-1', initiated: '2026-01-01T00:00:00.000Z' },
      { key: 'p1 dir/last+1.bin', uploadId: 'up-2', initiated: '2026-01-02T00:00:00.000Z' },
      { key: 'p2 dir/third.bin', uploadId: 'up-3', initiated: '2026-01-03T00:00:00.000Z' },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
    // 第二页续列标记：NextKeyMarker（=page1 末项 Key）→ key-marker、NextUploadIdMarker → upload-id-marker
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      'https://s3.test/bkt?uploads&key-marker=p1%20dir%2Flast%2B1.bin&upload-id-marker=up-2',
    )
  })

  it('IsTruncated=true 但缺 Next*Marker（非标实现）→ 防御性终止：仅一页，不死循环', async () => {
    const { fetcher, client } = makeClient([
      xml(`<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <Bucket>bkt</Bucket>
        <IsTruncated>true</IsTruncated>
        <Upload><Key>only.bin</Key><UploadId>up-1</UploadId></Upload>
      </ListMultipartUploadsResult>`),
    ])
    const uploads = await client.listMultipartUploads()

    expect(uploads).toEqual([{ key: 'only.bin', uploadId: 'up-1' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('网络异常 → S3_ERROR，detail={status:0}（沿用现有管道）', async () => {
    const { client } = makeClient(() => {
      throw new TypeError('fetch failed')
    })
    const err = await client.listMultipartUploads().catch((e: unknown) => e)
    expect((err as SdkError).code).toBe(ERROR_CODES.S3_ERROR)
    expect((err as SdkError).detail).toEqual({ status: 0 })
  })
})

describe('copy 源版本恢复（M3-F8：VersionPanel 恢复链）', () => {
  it('copy(from, to, { fromVersionId }) → copy-source 带 ?versionId=（RFC3986 编码，目标 URL 不变）', async () => {
    const { client, fetcher } = makeClient([xml('<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>')])
    await client.copy('docs/a.txt', 'docs/a.txt', { fromVersionId: 'vid 1?x' })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toContain('/docs/a.txt')
    expect((init?.headers as Record<string, string>)['x-amz-copy-source']).toBe('/bkt/docs/a.txt?versionId=vid%201%3Fx')
  })

  it('copy 不传 opts → copy-source 无 query（逐字节回归既有行为）', async () => {
    const { client, fetcher } = makeClient([xml('<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>')])
    await client.copy('a.txt', 'b.txt')
    const [, init] = fetcher.mock.calls[0]!
    expect((init?.headers as Record<string, string>)['x-amz-copy-source']).toBe('/bkt/a.txt')
  })
})
