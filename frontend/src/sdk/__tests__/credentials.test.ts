/**
 * credentials.ts 单测：凭证获取接缝（《docs/design/solution-design.md》§4.3 fetchCredentials 抽象）
 * 本期实现 = FragmentCredentialsProvider（fragment 直取）
 */
import { describe, it, expect } from 'vitest'
import { FragmentCredentialsProvider, fetchCredentials, type CredentialsProvider } from '../credentials'
import type { BackendConfig } from '../types'

const backend: BackendConfig = {
  endpoint: 'https://oss-cn-shenzhen.aliyuncs.com',
  region: 'oss-cn-shenzhen',
  bucket: 'your-bucket',
  prefix: 'sessions/20261008-abc/',
  credentials: { accessKeyId: 'STS.xxx', accessKeySecret: 'xxx', sessionToken: 'xxx' },
  ttlSeconds: 3600,
  expiresAt: 1800000000000,
}

describe('FragmentCredentialsProvider', () => {
  it('get() 返回 backend 凭证三要素', async () => {
    const p = new FragmentCredentialsProvider(backend)
    const creds = await p.get()
    expect(creds).toEqual({ accessKeyId: 'STS.xxx', accessKeySecret: 'xxx', sessionToken: 'xxx' })
  })

  it('ttlSeconds / expiresAt 透传（会话定时器对齐用）', () => {
    const p: CredentialsProvider = new FragmentCredentialsProvider(backend)
    expect(p.ttlSeconds).toBe(3600)
    expect(p.expiresAt).toBe(1800000000000)
  })

  it('未配置 ttlSeconds / expiresAt 时为 undefined', () => {
    const { ttlSeconds: _t, expiresAt: _e, ...bare } = backend
    const p = new FragmentCredentialsProvider(bare)
    expect(p.ttlSeconds).toBeUndefined()
    expect(p.expiresAt).toBeUndefined()
  })

  it('每次 get() 返回克隆副本：外部改动不污染 provider 内部态', async () => {
    const p = new FragmentCredentialsProvider(backend)
    const first = await p.get()
    first.accessKeyId = 'hacked'
    first.sessionToken = 'hacked'
    const second = await p.get()
    expect(second).toEqual({ accessKeyId: 'STS.xxx', accessKeySecret: 'xxx', sessionToken: 'xxx' })
    expect(second).not.toBe(first)
  })

  it('构造时持快照：构造后改动 backend.credentials 不影响 get()', async () => {
    const mutable: BackendConfig = { ...backend }
    const p = new FragmentCredentialsProvider(mutable)
    mutable.credentials = { accessKeyId: 'rotated', accessKeySecret: 'r', sessionToken: 'r' }
    const creds = await p.get()
    expect(creds.accessKeyId).toBe('STS.xxx')
  })
})

describe('fetchCredentials（接缝）', () => {
  it('委托 provider.get() 取凭证', async () => {
    const p = new FragmentCredentialsProvider(backend)
    const creds = await fetchCredentials(p)
    expect(creds).toEqual(backend.credentials)
  })

  it('接缝可替换：自定义 provider 同样可用（增强期 RPC 换发不返工）', async () => {
    const rpc: CredentialsProvider = {
      ttlSeconds: 600,
      get: async () => ({ accessKeyId: 'rpc-ak', accessKeySecret: 'rpc-sk', sessionToken: 'rpc-tok' }),
    }
    const creds = await fetchCredentials(rpc)
    expect(creds.accessKeyId).toBe('rpc-ak')
  })
})
