/**
 * 工作台装配（Wave2-T2）：boot 句柄 → 管理面 store 构造（UI 直连 store，不绕 JSSDK）。
 * 契约：《docs/design/solution-design.md》§4.4（S3 直连签名）、《docs/design/jsdk-api.md》§六（fileChanged / upload* 事件）、
 * 《docs/design/webdav-support-design.md》§W1（backend.type 装配分流）。
 *
 * 构造链：client 按 backend.type 分流——S3=S3SigV4Client（backend 凭证；包装 fetcher
 * best-effort 校准时钟 §4.3）｜WebDAV=WebDavClient（缺省 fetch；键域=rootPath 相对）→
 * createFileTree（onFileChanged→bus 'fileChanged'，宿主同步视图）→
 * UploadQueue（hooks 映射 uploadProgress/Done/Failed→bus）。下游 tree/queue 只消费 S3Client 接口面。
 * 模块级单例：页面生命周期内只装配一次，重复调用返回同一实例；file 模式返回 null。
 */
import type { BootHandle } from '@/boot'
import { S3SigV4Client } from '@/sdk/s3/client'
import { WebDavClient } from '@/sdk/webdav/client'
import type { EventName, S3Client } from '@/sdk/types'
import { createIdbCheckpointStore } from './checkpoint-store'
import { createUploadHooks, joinKey } from './commands'
import { createFileTree } from './tree-store'
import type { FileTreeWithTrash } from './tree-store'
import { UploadQueue } from './upload-queue'

export interface WorkspaceStores {
  /** 数据面客户端（WebDAV §W1 分流：S3SigV4Client｜WebDavClient）——放宽为 S3Client 接口，
   *  下游 tree/queue/UI 消费接口面；setCredentials/calibrateClock 等具体类方法仅 S3 客户端具备 */
  client: S3Client
  /** P2-3 放宽：createFileTree 本就返回 FileTreeWithTrash 全量面，此处如实标注——
   *  trash 四方法（listTrash/restoreTrash/purgeTrash/emptyTrash）自装配面可达（FileTreeController 消费方不受影响：全量面是其超集） */
  tree: FileTreeWithTrash
  queue: UploadQueue
}

let singleton: WorkspaceStores | null = null

/** 纯构造核心（config 就绪即可用，不等 handle）——M1 overrides 与 UI 装配共用 */
export function setupStores(
  config: Extract<BootHandle['config'], { mode: 'workspace' }>,
  emit: (evt: EventName, payload: unknown) => void,
): WorkspaceStores {
  if (singleton) return singleton
  const backend = config.backend
  // backend.type 单向判别（types.ts WorkspaceBackend 注记：缺省形状=S3，既有消费点零改动）
  let client: S3Client
  let rootPrefix: string
  if (backend.type === 'webdav') {
    // WebDAV 分支（§W1）：backend 原样进客户端（端点/凭证/根路径；type/ttl 等额外键被
    // WebDavClient 忽略，凭证只进 Authorization 头）。缺省 fetch——时钟校准是 S3SigV4Client
    // 特有方法（CalibrateClock 消费 Date 头做 SigV4 签名偏移），WebDAV Basic 认证无时钟语义。
    client = new WebDavClient(backend)
    // 键域=全 key（WebDavClient 仅在 objectPath 内拼 rootPath，list 回全 key，同 S3 契约），树根=空串
    rootPrefix = ''
  } else {
    // S3 分支（现行行为逐字节不变）：§4.3 时钟偏移校准（Lane F3 审计接线：calibrateClock
    // 此前为死代码）。该方法只声明在具体类 S3SigV4Client 上（S3Client 接口未声明），且需要
    // 原始 Response 的 Date 头——故经注入 fetcher 从真实响应 best-effort 校准（零额外探测
    // 请求，首个响应起签名自动携带偏移）；单次校准异常静默：校准只优化签名时钟，失败不得影响业务请求本身。
    const s3 = new S3SigV4Client(backend, async (url, init) => {
      const res = await fetch(url, init)
      try {
        s3.calibrateClock(res)
      } catch {
        // best-effort：时钟校准失败不拦截请求
      }
      return res
    })
    client = s3
    rootPrefix = backend.prefix
  }
  const tree = createFileTree({
    client,
    rootPrefix,
    // ui.initialPath（复审 #7 消费）：相对 backend.prefix 的初始目录（口径同 ui.defaultOpen，JSSDK §五注记①）
    initialPath: config.ui?.initialPath ? joinKey(rootPrefix, config.ui.initialPath) : undefined,
    onFileChanged: (payload) => emit('fileChanged', payload),
  })
  const hooks = createUploadHooks(emit)
  // §W4②：整包上限仅 WebDAV 整包降级模式（multipartStrategy='none'）被队列消费
  // （undefined=队列缺省 1GB）；S3 分支不传（multipart 无整包上限闸）。单向判别纪律：
  // 只做 ==='webdav' 收窄，缺省形状不被吃掉。
  const webdavMaxUploadSize = backend.type === 'webdav' ? backend.maxUploadSize : undefined
  const queue = new UploadQueue({
    client,
    params: {
      uploadMaxBytes: config.params?.uploadMaxBytes,
      uploadConcurrency: config.params?.uploadConcurrency,
      denyExts: config.permissions?.denyExts,
      // WebDAV §W4② 整包上限透传（S3 分支为 undefined=不传，与既有行为等价）
      maxUploadSize: webdavMaxUploadSize,
      // 跨会话断点续传（IDB store，与 tree/client 同装配作用域）
      checkpointStore: createIdbCheckpointStore(),
    },
    hooks: {
      ...hooks,
      // F6：上传终态接树刷新——强拉当前目录（force 绕缓存），新文件免手动刷新即可见。
      // 刷新 currentPath 而非 key 父目录：宿主无 prefix 的 uploadFiles 落 bucket 根时不得劫持树导航。
      onDone: (id, key) => {
        hooks.onDone?.(id, key)
        void tree.loadDir(tree.currentPath, { force: true })
      },
    },
  })
  singleton = { client, tree, queue }
  return singleton
}

/** workspace 模式装配 store；file 模式（或重复调用）按契约返回 null / 同一实例 */
export function setupWorkspace(handle: BootHandle): WorkspaceStores | null {
  if (handle.config.mode !== 'workspace') return null
  return setupStores(handle.config, (evt, payload) => handle.bus.emit(evt, payload))
}

/**
 * 渲染器侧只读取口：返回已装配单例（未装配/file 模式=null）。只读不构造——装配链仍由
 * boot/main.ts 驱动，本函数不产生副作用。消费方：apps/renderers/zip.ts 的 extract 队列链
 * （store 可得 → 逐条入队 UploadQueue；null → 渲染器内置直连 putObject 兜底）。
 */
export function peekWorkspaceStores(): WorkspaceStores | null {
  return singleton
}

/** 清单例（仅测试/强制重装配用；生产勿调） */
export function resetWorkspaceSetup(): void {
  singleton = null
}
