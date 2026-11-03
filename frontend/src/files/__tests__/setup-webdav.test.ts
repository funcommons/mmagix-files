/**
 * setupStores WebDAV 分流装配测试（M2-T 测试先行）
 * 契约：《docs/design/webdav-support-design.md》§W6（M2 装配）
 *
 * - setupStores 按 backend.type==='webdav' 构造 WebDavClient；'s3'/缺省 → 现行 S3SigV4Client
 *   （零改动，含时钟校准包装 fetcher——仅 S3SigV4Client 有 calibrateClock）。
 * - 手法照既有 setup.test.ts：两个客户端类都经 vi.mock 换内存 Fake（不触网），静态 instances
 *   记录入参；WorkspaceStores 经 setupWorkspace 构造（bus 以 { emit: spy } 最小形状注入）；
 *   resetWorkspaceSetup 清模块级单例。
 * - 不断言 tree 根值：webdav 的 rootPath 由客户端内部消化，树根映射（rootPrefix 传什么）属实现细节。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Client, WorkspaceConfig } from '@/sdk/types'
import type { BootHandle } from '@/boot'
// mock 后的假类（下方 vi.mock 工厂注入；取静态 instances 与构造入参）
import { S3SigV4Client } from '@/sdk/s3/client'
import { WebDavClient } from '@/sdk/webdav/client'
import { resetWorkspaceSetup, setupWorkspace } from '../setup'
import { UploadQueue } from '../upload-queue'

vi.mock('@/sdk/s3/client', () => {
  class FakeS3Client implements S3Client {
    static instances: Array<{ config: unknown; fetcher: unknown }> = []
    readonly config: unknown
    readonly fetcher: unknown
    constructor(config: unknown, fetcher: unknown = undefined) {
      this.config = config
      this.fetcher = fetcher
      FakeS3Client.instances.push({ config, fetcher })
    }
    calibrateClock(): void {}
    async list() {
      return { prefix: '', dirs: [], files: [] }
    }
    async put() {
      return { etag: 'fake-etag' }
    }
    async get() {
      return new Response('', { status: 404 })
    }
    async head() {
      return { exists: false }
    }
    async copy() {}
    async remove() {}
    async createMultipart() {
      return { uploadId: 'u-1' }
    }
    async uploadPart() {
      return { etag: 'p-1' }
    }
    async completeMultipart() {}
    async abortMultipart() {}
  }
  return { S3SigV4Client: FakeS3Client }
})

vi.mock('@/sdk/webdav/client', () => {
  class FakeWebDavClient implements S3Client {
    static instances: Array<{ config: unknown; fetcher: unknown }> = []
    readonly config: unknown
    readonly fetcher: unknown
    constructor(config: unknown, fetcher: unknown = undefined) {
      this.config = config
      this.fetcher = fetcher
      FakeWebDavClient.instances.push({ config, fetcher })
    }
    async list() {
      return { prefix: '', dirs: [], files: [] }
    }
    async put() {
      return { etag: 'fake-etag' }
    }
    async get() {
      return new Response('', { status: 404 })
    }
    async head() {
      return { exists: false }
    }
    async copy() {}
    async remove() {}
    async createMultipart(): Promise<{ uploadId: string }> {
      throw new Error('WebDAV 分片上传未实现')
    }
    async uploadPart(): Promise<{ etag: string }> {
      throw new Error('WebDAV 分片上传未实现')
    }
    async completeMultipart(): Promise<void> {
      throw new Error('WebDAV 分片上传未实现')
    }
    async abortMultipart(): Promise<void> {
      throw new Error('WebDAV 分片上传未实现')
    }
  }
  return { WebDavClient: FakeWebDavClient }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s3Instances = (): Array<{ config: unknown; fetcher: unknown }> => (S3SigV4Client as any).instances
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const davInstances = (): Array<{ config: unknown; fetcher: unknown }> => (WebDavClient as any).instances

/** 现行 S3 backend（缺 type=黄金向后兼容形态） */
const s3Backend: Record<string, unknown> = {
  endpoint: 'https://s3.test',
  region: 'test-1',
  bucket: 'bkt',
  prefix: 'sessions/abc/',
  credentials: { accessKeyId: 'ak', accessKeySecret: 'sk', sessionToken: 'tok' },
}

/** webdav backend（§W6 向导 WebDAV 分支落盘形态） */
const davBackend: Record<string, unknown> = {
  type: 'webdav',
  endpoint: 'https://dav.example.com',
  username: 'alice',
  password: 'dav-pass',
  rootPath: '/dav',
}

function workspaceHandle(backend: Record<string, unknown>): { handle: BootHandle; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn()
  const handle = {
    config: {
      mode: 'workspace',
      v: 1,
      backend: backend as WorkspaceConfig['backend'],
      security: { allowedOrigins: ['https://host.test'] },
    },
    bus: { emit },
  } as unknown as BootHandle
  return { handle, emit }
}

describe('setupStores：backend.type 分流（§W6 M2）', () => {
  beforeEach(() => {
    resetWorkspaceSetup()
    // mock 静态 instances 表随用例累积（resetWorkspaceSetup 只清单例，同既有 setup.test.ts 注记）——
    // 本文件断言「构造次数（toHaveLength(1)）」，须在每例前清表
    s3Instances().length = 0
    davInstances().length = 0
  })

  it("webdav config（type:'webdav'）→ client 为 WebDavClient 实例，收 webdav backend；不多造 S3 客户端", () => {
    const { handle } = workspaceHandle(davBackend)
    const ws = setupWorkspace(handle)
    if (!ws) throw new Error('workspace 装配应成功')

    expect(ws.client).toBeInstanceOf(WebDavClient)
    expect(davInstances()).toHaveLength(1)
    expect(davInstances()[0]?.config).toEqual(davBackend) // 端点/凭证/根路径原样进客户端
    expect(s3Instances()).toHaveLength(0) // 分流：S3 分支不得被连带构造
    // 装配链不因分流断链：tree/queue 照常产出
    expect(ws.queue).toBeInstanceOf(UploadQueue)
    // [M2-V1 P2] 树根='' 是装配契约（setup.ts 分流处 rootPath 由客户端内部消化、树根空串；
    // S3 侧对称钉见下例 toBe('sessions/abc/')）——恒真 typeof 断言收紧为值钉，防三处分流漂移
    expect(ws.tree.currentPath).toBe('')
  })

  it("显式 type:'s3' → 现行 S3SigV4Client；不构造 WebDavClient", () => {
    const { handle } = workspaceHandle({ type: 's3', ...s3Backend })
    const ws = setupWorkspace(handle)
    if (!ws) throw new Error('workspace 装配应成功')

    expect(ws.client).toBeInstanceOf(S3SigV4Client)
    expect(s3Instances()).toHaveLength(1)
    expect(davInstances()).toHaveLength(0)
    // 树根=prefix 同现行（S3 分支零改动）
    expect(ws.tree.currentPath).toBe('sessions/abc/')
  })

  it('缺 type（黄金向后兼容）→ 现行 S3SigV4Client；时钟校准包装 fetcher 保留（§4.3 零改动）', async () => {
    const { handle } = workspaceHandle(s3Backend)
    const ws = setupWorkspace(handle)
    if (!ws) throw new Error('workspace 装配应成功')

    expect(ws.client).toBeInstanceOf(S3SigV4Client)
    expect(davInstances()).toHaveLength(0)
    // Lane F3 接缝：S3 分支构造注入包装 fetcher（响应透传并喂 calibrateClock）
    const inst = s3Instances()[s3Instances().length - 1]!
    expect(typeof inst.fetcher).toBe('function')
    const res = new Response('', { status: 200, headers: { date: 'Fri, 09 Oct 2026 00:00:00 GMT' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res)
    try {
      const fetcher = inst.fetcher as (url: string, init?: RequestInit) => Promise<Response>
      await expect(fetcher('https://s3.test/bkt', { method: 'GET' })).resolves.toBe(res)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('模块级单例跨分流成立：webdav 装配后重复调用返回同一实例', () => {
    const first = workspaceHandle(davBackend)
    const second = workspaceHandle(davBackend)
    const a = setupWorkspace(first.handle)
    expect(a).not.toBeNull()
    expect(setupWorkspace(second.handle)).toBe(a)
    expect(davInstances()).toHaveLength(1) // 单例短路：不重复构造客户端
  })

  // [M4-V1 P2] §W4 上传矩阵装配面：chunkedWrite/maxUploadSize 只在 webdav 分支透传，
  // S3 分支不得无中生有（判别联合单向收窄纪律的装配面落点）。
  it('M4 装配透传：webdav chunkedWrite/maxUploadSize 进 client config 与 queue；S3 分支两键 undefined', () => {
    // ── webdav 分支：backend 两键 → WebDavClient config 原样 + maxUploadSize 透传 UploadQueue ──
    const dav = workspaceHandle({ ...davBackend, chunkedWrite: true, maxUploadSize: 5 * 1024 * 1024 })
    const ws = setupWorkspace(dav.handle)
    if (!ws) throw new Error('workspace 装配应成功')
    const davConfig = davInstances()[0]!.config as Record<string, unknown>
    expect(davConfig.chunkedWrite).toBe(true) // 家族开关进客户端（§W4① 分流依据）
    expect(davConfig.maxUploadSize).toBe(5 * 1024 * 1024)
    // queue 侧读构造期冻结的整包上限（私有字段；类型闸见 config-webdav.test.ts，缺省 1GB 兜底在队列构造器）
    expect((ws.queue as unknown as { maxUploadSize: number }).maxUploadSize).toBe(5 * 1024 * 1024)

    // ── S3 分支：两键 undefined=不传（缺省形状不被吃掉；队列侧回落缺省 1GB、策略 s3-multipart）──
    resetWorkspaceSetup()
    s3Instances().length = 0 // 同 beforeEach 口径：instances 表随用例累积，分支切换前手动清
    davInstances().length = 0
    const s3 = workspaceHandle({ type: 's3', ...s3Backend })
    const wsS3 = setupWorkspace(s3.handle)
    if (!wsS3) throw new Error('workspace 装配应成功')
    const s3Config = s3Instances()[0]!.config as Record<string, unknown>
    expect(s3Config.chunkedWrite).toBeUndefined()
    expect(s3Config.maxUploadSize).toBeUndefined()
    expect((wsS3.queue as unknown as { maxUploadSize: number }).maxUploadSize).toBe(1024 ** 3) // 缺省 1GB
    expect((wsS3.queue as unknown as { multipartStrategy: string }).multipartStrategy).toBe('s3-multipart')
  })
})
