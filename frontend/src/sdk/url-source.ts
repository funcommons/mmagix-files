/**
 * 单文件模式数据源（#file）——普通 HTTP provider
 * 契约：《docs/design/solution-design.md》V1.2 §4.1b——AppRegistry ctx 统一 getObject/putObject 语义，
 * 与 S3 provider（工作台模式）双实现，内置应用与插件零感知。
 * 只读=无 save 段（写链零存在）；可写=有 save 段（按 save.method 回写）。
 */
import { ERROR_CODES, SdkError } from './errorCodes'
import type { FileSave, FileSource } from './types'

export interface UrlSourceOptions {
  source: FileSource
  save?: FileSave
  /** 可注入 fetch（测试用） */
  fetcher?: typeof fetch
}

export class UrlSourceProvider {
  readonly writable: boolean
  private readonly opts: UrlSourceOptions
  private readonly fetcher: typeof fetch

  // 注意：项目开启 erasableSyntaxOnly，禁止 ctor 参数属性，须显式字段赋值
  constructor(opts: UrlSourceOptions) {
    this.opts = opts
    this.writable = !!opts.save
    this.fetcher = opts.fetcher ?? fetch.bind(globalThis)
  }

  /** 取源内容字节流（ctx.getObject 底座） */
  async get(): Promise<Response> {
    const { source } = this.opts
    const method = source.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      throw new SdkError(ERROR_CODES.BAD_PARAM, `source.method 仅支持 GET/POST，收到 ${method}`)
    }
    let res: Response
    try {
      res = await this.fetcher(source.url, {
        method,
        headers: source.headers,
        body: method === 'POST' ? source.body : undefined,
      })
    } catch (err) {
      throw new SdkError(ERROR_CODES.S3_ERROR, `源请求失败：${(err as Error)?.message ?? 'network'}`, { status: 0 })
    }
    if (!res.ok) this.throwForStatus(res.status)
    return res
  }

  /** 取源内容为文本（预览应用常用便捷方法） */
  async getText(): Promise<string> {
    return (await this.get()).text()
  }

  /** 取源内容为 Blob */
  async getBlob(): Promise<Blob> {
    return (await this.get()).blob()
  }

  /**
   * 回写保存（ctx.putObject 底座）。只读模式（无 save 段）调用即拒：
   * 写链在配置层就不存在，对应 4305 UNSUPPORTED_MODE。
   */
  async put(data: Blob | ArrayBuffer | string, contentType?: string): Promise<void> {
    const save = this.opts.save
    if (!save) {
      throw new SdkError(ERROR_CODES.UNSUPPORTED_MODE, '单文件模式为只读（配置无 save 段），无写链')
    }
    const headers: Record<string, string> = { ...(save.headers ?? {}) }
    if (contentType) headers['Content-Type'] = contentType
    let res: Response
    try {
      res = await this.fetcher(save.url, {
        method: save.method,
        headers,
        body: data as BodyInit,
      })
    } catch (err) {
      throw new SdkError(ERROR_CODES.S3_ERROR, `保存请求失败：${(err as Error)?.message ?? 'network'}`, { status: 0 })
    }
    if (!res.ok) this.throwForStatus(res.status)
  }

  private throwForStatus(status: number): never {
    if (status === 401 || status === 403) {
      throw new SdkError(ERROR_CODES.CREDENTIAL_INVALID, `源拒绝访问（${status}）——检查 source/save headers 的短时 token`, { status })
    }
    throw new SdkError(ERROR_CODES.S3_ERROR, `源返回 ${status}`, { status })
  }
}
