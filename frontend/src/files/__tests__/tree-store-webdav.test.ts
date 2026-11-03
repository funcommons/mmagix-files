/**
 * tree-store 目录语义分流测试（M3 §W2）
 * 契约锚：《docs/design/webdav-support-design.md》§W2（M3）：
 *  - client 新增可选成员 directorySemantics?: 'marker-object' | 'collection' 与
 *    createDirectory?(key)（确保完整祖先链——WebDAV 实现内部逐级 MKCOL、405=已存在容忍）；
 *  - tree-store 三分流点（判别 = client.createDirectory 存在性 + directorySemantics==='collection'；
 *    S3 路径零改动）：
 *    ① mkdir → 有 createDirectory 走之（不发 0 字节标记 put）；else 现行 0 字节标记；
 *    ② remove 目录键 → collection 语义单发 client.remove([dirKey])（RFC 4918 DELETE 递归删——
 *      collection 不是 key，平铺删完子对象后本体永远删不���）；else 现行 flatList 平铺展开；
 *    ③ renameDir → collection 语义先对每个目标对象的中间目录链 createDirectory（幂等补建），
 *      逐对象 COPY 照旧，收尾单发 remove([from])；else 现行逐对象 copy + 批量 remove。
 * 手法：金标准照既有 tree-store.test.ts 的内存 Fake——webdav fake 按协议现实校准：
 *  - list 忽略 delimiter（webdav/client.ts M1-V1 注记：delimiter:'' 在 WebDAV 塌缩为
 *    PROPFIND Depth:1，flatList 不是递归列举——递归语义由 collection COPY/DELETE 兜底）；
 *  - 目录是一等 collection：fake 以 collections 集合承载目录状态（createDirectory 登记整条
 *    祖先链、'/' 结尾 remove 递归删、'/' 结尾 copy 递归搬），不落 0 字节标记对象；
 *  - ⑤ 另置无 M3 新成员的 S3 fake 作回归锚：0 字节标记 put / 平铺展开 / 标记对象搬运仍在。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { ERROR_CODES, SdkError } from '@/sdk/errorCodes'
import type { S3Client, S3ListResult, S3ObjectSummary } from '@/sdk/types'
import { createFileTree } from '@/files/tree-store'
import type { FileChangedEvent } from '@/files/tree-store'

/**
 * WebDAV 形态的内存树客户端：directorySemantics='collection' + createDirectory spy。
 * calls 单一日志流（createDirectory:/put:/list:/copy:/remove:）保序——三分流点的调用形状断言全走它。
 */
class FakeWebDavTreeClient implements S3Client {
  /** M3 契约可选成员：目录语义声明（§W2 分流判别之一） */
  readonly directorySemantics = 'collection' as const
  /** M3 契约可选成员：createDirectory 收到的 key（保序 spy） */
  readonly createdDirs: string[] = []

  objects = new Map<string, { size: number; etag: string }>()
  /** 一等 collection（WebDAV 目录本体；collection 语义不落 0 字节标记对象） */
  collections = new Set<string>()
  calls: string[] = []

  /** 契约：确保 key 的完整祖先链（真实现内部逐级 MKCOL；fake 等价登记整链） */
  async createDirectory(key: string): Promise<void> {
    this.calls.push(`createDirectory:${key}`)
    this.createdDirs.push(key)
    const segs = key.replace(/\/+$/, '').split('/')
    for (let i = 1; i <= segs.length; i += 1) this.collections.add(`${segs.slice(0, i).join('/')}/`)
  }

  async put(key: string): Promise<{ etag: string }> {
    this.calls.push(`put:${key}`)
    this.objects.set(key, { size: 0, etag: `etag-${key}` })
    return { etag: `etag-${key}` }
  }

  /** PROPFIND Depth:1 语义：只回直接子级；delimiter/continuationToken 忽略（M1-V1 塌缩口径） */
  async list(prefix: string, opts?: { continuationToken?: string; delimiter?: string }): Promise<S3ListResult> {
    this.calls.push(`list:${prefix}|${opts?.delimiter ?? '/'}|${opts?.continuationToken ?? '-'}`)
    const dirs = new Map<string, S3ObjectSummary>()
    const files: S3ObjectSummary[] = []
    const dirOf = (rest: string): string | null => {
      const slash = rest.indexOf('/')
      return slash >= 0 ? prefix + rest.slice(0, slash + 1) : null
    }
    for (const k of [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k !== prefix).sort()) {
      const rest = k.slice(prefix.length)
      const dk = dirOf(rest)
      if (dk) {
        if (!dirs.has(dk)) dirs.set(dk, { key: dk, name: dk.slice(prefix.length, -1), size: 0, isDir: true })
      } else {
        files.push({ key: k, name: rest, size: this.objects.get(k)?.size ?? 0, isDir: false })
      }
    }
    for (const c of [...this.collections].filter((c) => c.startsWith(prefix) && c !== prefix).sort()) {
      const dk = dirOf(c.slice(prefix.length)) ?? c
      if (!dirs.has(dk)) dirs.set(dk, { key: dk, name: dk.slice(prefix.length, -1), size: 0, isDir: true })
    }
    return { prefix, dirs: [...dirs.values()], files, continuationToken: undefined }
  }

  async copy(from: string, to: string): Promise<void> {
    this.calls.push(`copy:${from}->${to}`)
    if (from.endsWith('/')) {
      // collection COPY 递归搬（RFC 4918）：子对象 + 子 collection 整体迁移
      for (const k of [...this.objects.keys()]) {
        if (k.startsWith(from)) this.objects.set(to + k.slice(from.length), this.objects.get(k)!)
      }
      for (const c of [...this.collections]) {
        if (c.startsWith(from)) {
          this.collections.add(to + c.slice(from.length))
          this.collections.delete(c)
        }
      }
      return
    }
    const src = this.objects.get(from)
    if (!src) throw new SdkError(ERROR_CODES.NOT_FOUND, `源不存在：${from}`)
    this.objects.set(to, { ...src })
  }

  async remove(keys: string[]): Promise<void> {
    this.calls.push(`remove:${keys.join(',')}`)
    for (const k of keys) {
      if (k.endsWith('/')) {
        // collection DELETE 递归删内部成员（RFC 4918，§W2 目录删除分流面）
        for (const o of [...this.objects.keys()]) if (o.startsWith(k)) this.objects.delete(o)
        for (const c of [...this.collections]) if (c.startsWith(k)) this.collections.delete(c)
        this.collections.delete(k)
      } else {
        this.objects.delete(k)
      }
    }
  }

  async head(key: string): Promise<{ exists: boolean; size?: number }> {
    return { exists: this.objects.has(key) || this.collections.has(key), size: this.objects.get(key)?.size }
  }
  async get(): Promise<Response> {
    throw new Error('未实现')
  }
  async createMultipart(): Promise<{ uploadId: string }> {
    throw new Error('未实现')
  }
  async uploadPart(): Promise<{ etag: string }> {
    throw new Error('未实现')
  }
  async completeMultipart(): Promise<void> {
    throw new Error('未实现')
  }
  async abortMultipart(): Promise<void> {
    throw new Error('未实现')
  }

  /** 测试种子：登记目录链（不落标记对象——collection 语义无标记） */
  seedDir(key: string): void {
    const segs = key.replace(/\/+$/, '').split('/')
    for (let i = 1; i <= segs.length; i += 1) this.collections.add(`${segs.slice(0, i).join('/')}/`)
  }
  seed(key: string, size = 1): void {
    this.objects.set(key, { size, etag: `e-${key}` })
  }
}

/** 只声明 collection 语义、缺 createDirectory 能力的假想客户端（M3-V1 评审：判别成对性守卫的触发面） */
class CollectionSansCreateDir implements S3Client {
  readonly directorySemantics = 'collection' as const
  // （不实现 createDirectory——守卫触发面）
  async list(prefix: string): Promise<S3ListResult> {
    return { prefix, dirs: [], files: [], continuationToken: undefined }
  }
  async get(): Promise<Response> {
    throw new Error('未实现')
  }
  async put(): Promise<{ etag: string }> {
    throw new Error('未实现')
  }
  async head(): Promise<{ exists: boolean }> {
    return { exists: false }
  }
  async copy(): Promise<void> {}
  async remove(): Promise<void> {}
  async createMultipart(): Promise<{ uploadId: string }> {
    throw new Error('未实现')
  }
  async uploadPart(): Promise<{ etag: string }> {
    throw new Error('未实现')
  }
  async completeMultipart(): Promise<void> {
    throw new Error('未实现')
  }
  async abortMultipart(): Promise<void> {
    throw new Error('未实现')
  }
}

describe('tree-store collection 语义分流（§W2：directorySemantics+createDirectory）', () => {
  let client: FakeWebDavTreeClient
  let events: FileChangedEvent[]
  const makeTree = () => createFileTree({ client, onFileChanged: (e) => events.push(e) })

  beforeEach(() => {
    client = new FakeWebDavTreeClient()
    events = []
  })

  it('① mkdir 走 createDirectory（不发 0 字节标记 put）+ 父目录刷新 + fileChanged(put)', async () => {
    client.seed('a/old.txt')
    client.seedDir('a/')
    const tree = makeTree()
    await tree.loadDir('a/')
    client.calls.length = 0
    const key = await tree.mkdir('a/', 'new')
    expect(key).toBe('a/new/')
    expect(client.createdDirs).toEqual(['a/new/']) // 走 createDirectory(key)（MKCOL）
    expect(client.calls.filter((c) => c.startsWith('put:'))).toEqual([]) // 无 0 字节标记对象
    expect(client.calls).toContain('list:a/|/|-') // 父目录仍被强制刷新
    expect(tree.nodes.get('a/')?.dirs.map((d) => d.name)).toContain('new') // collection 入树模型
    expect(events).toEqual([{ key: 'a/new/', action: 'put' }])
  })

  it('② remove 目录键=单发 remove([dirKey])（DELETE 递归删；不 flatList 平铺展开）', async () => {
    client.seed('a/c/d.txt', 3)
    client.seedDir('a/c/')
    const tree = makeTree()
    await tree.loadDir('a/')
    client.calls.length = 0
    await tree.remove(['a/c/'])
    expect(client.calls.filter((c) => c.startsWith('remove:'))).toEqual(['remove:a/c/']) // 单发 DELETE
    expect(client.calls.filter((c) => c.startsWith('list:a/c/'))).toEqual([]) // 无平铺列举
    expect(client.calls.filter((c) => c.startsWith('list'))).toEqual(['list:a/|/|-']) // 仅父目录刷新
    expect(client.objects.has('a/c/d.txt')).toBe(false) // 子对象随 collection DELETE 递归删
    expect(tree.nodes.has('a/c/')).toBe(false) // 子树缓存失效
    expect(events).toEqual([{ key: 'a/c/', action: 'delete' }])
  })

  it('③ renameDir=目标祖先链 createDirectory 补建 + 逐对象 COPY 照旧 + 收尾单发 remove([from])', async () => {
    client.seed('a/c/d.txt', 2)
    client.seed('a/c/e/f.txt', 4)
    client.seedDir('a/c/')
    const tree = makeTree()
    await tree.loadDir('a/')
    client.calls.length = 0
    await tree.rename('a/c/', 'x/')
    // 补建链：to 前缀 'x/' + 目录条目 'a/c/e/' 的目标本体 'x/e/'（MKCOL 幂等已存在容忍，先建后
    // COPY Overwrite:T 覆盖语义不变）；文件条目无中间层；嵌套对象不在 Depth:1 塌缩清单内
    expect([...new Set(client.createdDirs)].sort()).toEqual(['x/', 'x/e/'])
    const firstCreate = client.calls.findIndex((c) => c.startsWith('createDirectory:'))
    const firstCopy = client.calls.findIndex((c) => c.startsWith('copy:'))
    expect(firstCreate).toBeGreaterThanOrEqual(0)
    expect(firstCopy).toBeGreaterThan(firstCreate) // 先补链、后 COPY（父缺失 COPY 必 409）
    // 逐对象 COPY 照旧（对象清单=Depth:1 塌缩列举：直接子文件 + 子 collection）
    expect(client.calls).toContain('copy:a/c/d.txt->x/d.txt')
    expect(client.calls).toContain('copy:a/c/e/->x/e/') // 子 collection 整体 COPY（递归语义兜嵌套）
    expect(client.calls).not.toContain('copy:a/c/e/f.txt->x/e/f.txt') // 嵌套对象不单独 COPY（塌缩口径）
    // 收尾单发 remove([from])——替代 S3 平铺批删（collection 本体平铺永远删不掉）
    expect(client.calls.filter((c) => c.startsWith('remove:'))).toEqual(['remove:a/c/'])
    // 对象清单来自对 from 的一次列举（Depth:1 塌缩——delimiter 形态不钉）
    expect(client.calls.filter((c) => c.startsWith('list:a/c/'))).toHaveLength(1)
    // 状态：collection COPY/DELETE 递归语义
    expect(client.objects.has('x/d.txt')).toBe(true)
    expect(client.objects.has('x/e/f.txt')).toBe(true)
    expect(client.objects.has('a/c/d.txt')).toBe(false)
    // 缓存失效 + fileChanged
    expect(tree.nodes.has('a/c/')).toBe(false)
    expect(tree.nodes.get('a/')?.dirs.map((d) => d.name)).toEqual([]) // 父目录已刷新（c 消失）
    expect(events).toEqual([{ key: 'x/', action: 'rename', from: 'a/c/' }])
  })

  it('④ 文件 rename/remove 与 S3 路径共用语义（copy+单发 remove / 单发 remove）', async () => {
    client.seed('a/b.txt', 7)
    const tree = makeTree()
    await tree.loadDir('a/')
    client.calls.length = 0
    await tree.rename('a/b.txt', 'a/z.txt')
    expect(client.calls).toContain('copy:a/b.txt->a/z.txt')
    expect(client.calls.filter((c) => c.startsWith('remove:'))).toEqual(['remove:a/b.txt'])
    expect(client.objects.has('a/z.txt')).toBe(true)
    expect(client.objects.has('a/b.txt')).toBe(false)
    expect(events).toEqual([{ key: 'a/z.txt', action: 'rename', from: 'a/b.txt' }])

    client.calls.length = 0
    events.length = 0
    await tree.remove(['a/z.txt'])
    expect(client.calls.filter((c) => c.startsWith('remove:'))).toEqual(['remove:a/z.txt'])
    expect(client.objects.has('a/z.txt')).toBe(false)
    expect(events).toEqual([{ key: 'a/z.txt', action: 'delete' }])
  })

  it('②+ 混合键批删（M3-V1）：文件键批量删先行、目录键单发 DELETE 收尾（调用序钉死）', async () => {
    client.seed('a/b.txt', 2)
    client.seed('a/x.txt', 5)
    client.seedDir('a/c/')
    const tree = makeTree()
    await tree.loadDir('a/')
    client.calls.length = 0
    await tree.remove(['a/b.txt', 'a/c/', 'a/x.txt'])
    // 顺序契约（同一 remove 调用内）：victims（文件键）批量删先行 → collection 目录键单发
    // DELETE 收尾。目录内部成员由递归 DELETE 裹挟，与文件批删的先后无观察差——评审口径只钉
    // 调用序，不钉递归面内部顺序
    expect(client.calls.filter((c) => c.startsWith('remove:'))).toEqual(['remove:a/b.txt,a/x.txt', 'remove:a/c/'])
    expect(client.calls.filter((c) => c.startsWith('list:a/c/'))).toEqual([]) // 目录键不平铺展开
    expect(client.objects.has('a/b.txt')).toBe(false)
    expect(client.objects.has('a/x.txt')).toBe(false)
    expect(client.collections.has('a/c/')).toBe(false) // 递归 DELETE 连目录本体
    expect(events).toEqual([
      { key: 'a/b.txt', action: 'delete' },
      { key: 'a/c/', action: 'delete' },
      { key: 'a/x.txt', action: 'delete' },
    ])
  })

  it('判别守卫（M3-V1）：collection 语义声明但无 createDirectory → 入口即抛 BAD_PARAM（fail-fast）', () => {
    // 成对性缺口面：只声明语义、无 MKCOL 能力的假想客户端会让 mkdir/remove/renameDir 三处分流
    // 各走各形（潜伏分叉）——入口早抛，不给半 capability 客户端进入分流面的机会
    const attempt = (): unknown => createFileTree({ client: new CollectionSansCreateDir() })
    expect(attempt).toThrowError(SdkError)
    let err: unknown
    try {
      attempt()
    } catch (e) {
      err = e
    }
    expect((err as SdkError).code).toBe(ERROR_CODES.BAD_PARAM)
    expect((err as SdkError).message).toContain('createDirectory')
    // 对称锚：声明+能力成对的正常 collection 客户端不受守卫误伤
    expect(() => createFileTree({ client })).not.toThrow()
  })
})

// ───────────────────── S3 现行语义回归锚（§W2：S3 路径零改动） ─────────────────────

/** S3 marker-object 形态 fake（无 M3 新成员）——delimiter:'' 平铺 + 目录标记对象照旧 */
class FakeS3MarkerClient implements S3Client {
  objects = new Map<string, { size: number; etag: string }>()
  calls: string[] = []

  async put(key: string): Promise<{ etag: string }> {
    this.calls.push(`put:${key}`)
    this.objects.set(key, { size: 0, etag: `etag-${key}` })
    return { etag: `etag-${key}` }
  }
  async list(prefix: string, opts?: { continuationToken?: string; delimiter?: string }): Promise<S3ListResult> {
    this.calls.push(`list:${prefix}|${opts?.delimiter ?? '/'}|${opts?.continuationToken ?? '-'}`)
    const flat = opts?.delimiter === ''
    const dirs = new Map<string, S3ObjectSummary>()
    const files: S3ObjectSummary[] = []
    for (const k of [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()) {
      const rest = k.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (!flat && slash >= 0) {
        const dirKey = prefix + rest.slice(0, slash + 1)
        if (!dirs.has(dirKey)) dirs.set(dirKey, { key: dirKey, name: rest.slice(0, slash), size: 0, isDir: true })
        continue
      }
      files.push({ key: k, name: rest, size: this.objects.get(k)?.size ?? 0, isDir: false })
    }
    const all = [...dirs.values(), ...files]
    return { prefix, dirs: all.filter((s) => s.isDir), files: all.filter((s) => !s.isDir), continuationToken: undefined }
  }
  async copy(from: string, to: string): Promise<void> {
    this.calls.push(`copy:${from}->${to}`)
    const src = this.objects.get(from)
    if (!src) throw new SdkError(ERROR_CODES.NOT_FOUND, `源不存在：${from}`)
    this.objects.set(to, { ...src })
  }
  async remove(keys: string[]): Promise<void> {
    this.calls.push(`remove:${keys.join(',')}`)
    for (const k of keys) this.objects.delete(k)
  }
  async head(key: string): Promise<{ exists: boolean; size?: number }> {
    return { exists: this.objects.has(key), size: this.objects.get(key)?.size }
  }
  async get(): Promise<Response> {
    throw new Error('未实现')
  }
  async createMultipart(): Promise<{ uploadId: string }> {
    throw new Error('未实现')
  }
  async uploadPart(): Promise<{ etag: string }> {
    throw new Error('未实现')
  }
  async completeMultipart(): Promise<void> {
    throw new Error('未实现')
  }
  async abortMultipart(): Promise<void> {
    throw new Error('未实现')
  }
  seed(key: string, size = 1): void {
    this.objects.set(key, { size, etag: `e-${key}` })
  }
}

describe('S3 marker-object 回归锚（无 M3 新成员 → 现行路径零改动）', () => {
  it('mkdir：0 字节标记对象照旧（无 createDirectory 概念）', async () => {
    const client = new FakeS3MarkerClient()
    client.seed('a/old.txt')
    const events: FileChangedEvent[] = []
    const tree = createFileTree({ client, onFileChanged: (e) => events.push(e) })
    await tree.loadDir('a/')
    client.calls.length = 0
    await tree.mkdir('a/', 'new')
    expect(client.calls).toContain('put:a/new/') // 标记对象仍在
    expect(events).toEqual([{ key: 'a/new/', action: 'put' }])
  })

  it('remove 目录键：flatList 平铺展开逐对象批删照旧', async () => {
    const client = new FakeS3MarkerClient()
    client.seed('a/b.txt', 2)
    client.seed('a/c/', 0)
    client.seed('a/c/d.txt', 3)
    const tree = createFileTree({ client })
    await tree.remove(['a/b.txt', 'a/c/'])
    expect(client.calls).toContain('remove:a/b.txt,a/c/,a/c/d.txt') // 平铺展开（含标记）仍在
    expect(client.objects.has('a/c/d.txt')).toBe(false)
  })

  it('renameDir：标记对象搬运 + 平铺逐对象 copy + 批量 remove 照旧', async () => {
    const client = new FakeS3MarkerClient()
    client.seed('a/c/', 0)
    client.seed('a/c/d.txt', 2)
    client.seed('a/c/e/f.txt', 4)
    const tree = createFileTree({ client })
    await tree.rename('a/c/', 'x/')
    expect(client.calls).toContain('copy:a/c/->x/') // 目录标记一并搬运（空目录语义）
    expect(client.calls).toContain('copy:a/c/e/f.txt->x/e/f.txt') // 平铺逐对象（嵌套单独 copy）
    expect(client.calls).toContain('remove:a/c/,a/c/d.txt,a/c/e/f.txt') // 批量 remove（非单发）
    expect(client.objects.has('x/e/f.txt')).toBe(true)
    expect(client.objects.has('a/c/d.txt')).toBe(false)
  })
})
