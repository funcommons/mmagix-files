/**
 * 凭证获取接缝（《docs/design/solution-design.md》V1.2 §4.3 fetchCredentials 抽象）
 *
 * - 本期 = fragment 直取：FragmentCredentialsProvider 构造时快照 backend.credentials
 * - 增强期（非本期，接缝不变）= 会话服务 RPC 换发：届时实现 RpcCredentialsProvider
 *   （构造持 endpoint/ticket，get() 内 RPC 换发临时凭证），调用方仍只依赖
 *   CredentialsProvider + fetchCredentials()，架构不因凭证来源分叉、不返工
 */
import type { BackendConfig, S3Credentials } from './types'

/** 凭证获取抽象：会话层（定时器/预警）与凭证来源解耦的唯一依赖面 */
export interface CredentialsProvider {
  /** 前端自毁定时器时长（秒，UX 线非安全线）；未配置=无倒计时线 */
  readonly ttlSeconds?: number
  /** STS 真实到期时刻（epoch ms，与前端定时器对齐用）；未配置=无对齐线 */
  readonly expiresAt?: number
  /** 取凭证。约定：每次返回新副本，调用方改动副本不得影响 provider 内部态 */
  get(): Promise<S3Credentials>
}

/** fragment 直取实现：构造时快照 backend 凭证（防后续外部改动串入） */
export class FragmentCredentialsProvider implements CredentialsProvider {
  readonly ttlSeconds?: number
  readonly expiresAt?: number
  private readonly creds: S3Credentials

  constructor(backend: BackendConfig) {
    this.ttlSeconds = backend.ttlSeconds
    this.expiresAt = backend.expiresAt
    this.creds = { ...backend.credentials }
  }

  /** 每次返回克隆副本，防外部持有者改动后污染内部凭证态 */
  async get(): Promise<S3Credentials> {
    return { ...this.creds }
  }
}

/** 凭证获取统一入口：本期直取；增强期换 RpcCredentialsProvider 即可，调用方零改动 */
export async function fetchCredentials(provider: CredentialsProvider): Promise<S3Credentials> {
  return provider.get()
}
