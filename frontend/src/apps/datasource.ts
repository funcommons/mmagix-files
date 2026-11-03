/**
 * 应用数据面桥——S3Client（工作台）/ UrlSourceProvider（单文件）→ AppCtx 数据面
 * 契约：《docs/design/solution-design.md》V1.2 §4.1b「数据源抽象：内置应用与插件零感知」
 * getMediaUrl（Lane F6）：可选媒体直链——预签名/源 URL 直接作 <video>/<audio> src，
 * 浏览器原生 Range 请求拖动进度（S3 原生支持），无则渲染器回落 Blob 路径。
 */
import type { S3Client } from '../sdk/types'
import type { UrlSourceProvider } from '../sdk/url-source'
import { ERROR_CODES, SdkError } from '../sdk/errorCodes'
import { isMemKey, memGet, memUpdate } from '../files/mem-store'

export interface AppDataSource {
  getObject(key: string): Promise<Blob>
  putObject(key: string, data: Blob, contentType?: string): Promise<void>
  /**
   * 可选：媒体直链（key 语义同 getObject）。仅当直链能被浏览器原样 GET 通时提供——
   * 媒体渲染器以它作 src 实现「Range 拖动」（见 renderers/media.ts 实现口径注释）。
   */
  getMediaUrl?(key: string): string
  /**
   * 可选：对象 Range 读通道（§W5 在线解压第二 RangeReader——无直链源走 GET+Range）。仅非 mem 键
   * 且底层支持时提供；[start, end) 半开区间（HTTP Range `bytes=start-(end-1)` 换算在实现层）；
   * 206=精确区间字节，200（源不支持 Range）=整包字节（上层整包缓存后本地切片）。
   * mem:// 键域不提供该成员（上层走 Blob 兜底——内存 Blob 零成本整包，Range 无增益）。
   */
  getObjectRange?(key: string, start: number, end: number): Promise<Uint8Array>
}

/**
 * 内存文件分流（用户口径「上传文件·内存中处理」）：`mem://` 键不落 S3——getObject/putObject
 * 直读写 MemFileStore。所有 Blob-first 渲染器/插件零改动（ctx.getObject/putObject 对来源无感）；
 * getMediaUrl 对 mem key 给 blob URL（媒体渲染器 Range 语义弱化为全量，内存文件无此诉求）。
 */
function withMemSource(ds: AppDataSource): AppDataSource {
  const wrapped: AppDataSource = {
    getObject: async (key) => {
      if (isMemKey(key)) {
        const e = memGet(key)
        if (!e) throw new Error(`mem key not found: ${key}`)
        return e.blob
      }
      return ds.getObject(key)
    },
    putObject: async (key, data, contentType) => {
      if (isMemKey(key)) {
        memUpdate(key, data, contentType)
        return
      }
      await ds.putObject(key, data, contentType)
    },
  }
  if (ds.getMediaUrl) {
    const inner = ds.getMediaUrl.bind(ds)
    wrapped.getMediaUrl = (key) => (isMemKey(key) ? URL.createObjectURL(memGet(key)!.blob) : inner(key))
  }
  if (ds.getObjectRange) {
    const inner = ds.getObjectRange.bind(ds)
    wrapped.getObjectRange = (key, start, end) => {
      // 防御面：mem:// 键不提供该成员是渲染器可观察契约（探测不到 → Blob 兜底），zip 渲染器
      // isMemKey 先判正常不达此；万一直调（插件无视探测）也绝不把 mem:// 键送进底层 client.get
      //（必然错域请求）
      if (isMemKey(key)) throw new Error(`mem key 不支持 Range 读通道：${key}`)
      return inner(key, start, end)
    }
  }
  return wrapped
}

/** 工作台模式：key=相对 prefix 的对象键（S3Client 内部已含 prefix 域语义） */
export function s3DataSource(client: S3Client): AppDataSource {
  const ds: AppDataSource = {
    getObject: async (key) => (await client.get(key)).blob(),
    putObject: async (key, data, contentType) => {
      await client.put(key, data, contentType)
    },
  }
  // client 未实现 getPresignedUrl（可选能力缺位）→ 不提供直链（媒体走 Blob 兜底）
  if (client.getPresignedUrl) {
    const presign = client.getPresignedUrl.bind(client)
    ds.getMediaUrl = (key) => presign(key)
  }
  // §W5 Range 读通道：client.get 带 rangeHeader（SigV4/WebDAV GET+Range 均原生支持）——206 精确
  // 区间字节原样透出；200（源不支持 Range）整包字节透出，上层整包缓存后本地切片。mem:// 键域
  // 的排除在 withMemSource 包裹层（不提供该成员 → 上层 Blob 兜底）。
  ds.getObjectRange = async (key, start, end) => {
    const res = await client.get(key, { rangeHeader: `bytes=${start}-${end - 1}` })
    // 非 2xx（404=列表后对象被删等）直接抛错（M3-V1 评审）——client.get 的 404 容忍返回原始
    // Response（存在性判断语义），此处不得把错误响应体折叠成字节（zip 侧会把短体误判整包缓存）
    if (!res.ok) {
      throw new SdkError(ERROR_CODES.S3_ERROR, `Range 读失败：HTTP ${res.status}`, { status: res.status })
    }
    return new Uint8Array(await res.arrayBuffer())
  }
  return withMemSource(ds)
}

/**
 * 单文件模式：key 语义弱化（单文件仅一个源）——provider 忽略 key，读写绑 source/save。
 * getMediaUrl 仅当源「可直接 GET」时提供：method 为 GET/未配置且无自定义 headers——
 * 带 headers/POST 的源浏览器 <video src> 复现不了请求形态，直链必然 401/405，宁缺毋滥。
 * 注：source 配置在 UrlSourceProvider 私有域（url-source.ts 本波次只读），此处只读内省
 * opts 供判定；url-source 后续开放 source 只读口后应替换为正式 API。
 */
export function urlDataSource(provider: UrlSourceProvider): AppDataSource {
  const source = (provider as unknown as { opts?: { source?: { url: string; method?: string; headers?: Record<string, string> } } })
    .opts?.source
  const directGet = !!source
    && (source.method ?? 'GET') === 'GET'
    && !(source.headers && Object.keys(source.headers).length > 0)
  const ds: AppDataSource = {
    getObject: async () => await provider.getBlob(),
    putObject: async (_key, data, contentType) => {
      await provider.put(data, contentType)
    },
  }
  if (directGet && source) ds.getMediaUrl = () => source.url
  return withMemSource(ds)
}
