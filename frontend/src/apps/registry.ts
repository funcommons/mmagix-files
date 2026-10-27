/**
 * AppRegistry——内置/插件同一注册表，零特判
 * 契约：《docs/design/solution-design.md》V1.2 §4.6、《docs/design/plugin-system.md》V1.1 §一/§二
 * matcher：字段间 AND、同字段内 OR；ext 归一化=忽略大小写与前导点，命中要求点分隔
 * （`a.todo` 命中 `todo`，裸名 `todo` 无扩展名不命中）；mime 无把握时只用 ext
 */
import { ERROR_CODES, SdkError } from '../sdk/errorCodes'
import { PROTOCOL_VERSION } from '../sdk/constants'
import type { AppDefinition, AppMatcher } from '../sdk/types'

export interface FileRef {
  name: string
  mime?: string
  size?: number
}

export function normalizeExt(ext: string): string {
  return ext.trim().replace(/^\./, '').toLowerCase()
}

export function normalizeMime(mime: string): string {
  return (mime.trim().split(';')[0] ?? '').toLowerCase()
}

function matchField<T>(values: T[] | undefined, hit: (v: T) => boolean): boolean | undefined {
  if (!values || values.length === 0) return undefined
  return values.some(hit)
}

/** 单个 matcher 判定：字段间 AND，同字段内 OR；无任何字段=不命中（防误吞所有类型） */
export function matches(matcher: AppMatcher, file: FileRef): boolean {
  const extHit = matchField(matcher.ext, (e) => {
    const ne = normalizeExt(e)
    if (!ne) return false
    const name = file.name.toLowerCase()
    // 扩展名命中必须带点分隔：裸名（无扩展名）即使与 ext 同字面也不命中
    return name.endsWith(`.${ne}`)
  })
  const mimeHit = matchField(
    matcher.mime === undefined ? undefined : Array.isArray(matcher.mime) ? matcher.mime : [matcher.mime],
    (m) => file.mime !== undefined && normalizeMime(file.mime) === normalizeMime(m),
  )
  const probeHit = matcher.probe ? matcher.probe(file) : undefined
  const fields = [extHit, mimeHit, probeHit].filter((v): v is boolean => v !== undefined)
  return fields.length > 0 && fields.every((v) => v === true)
}

export interface RegisterResult {
  ok: boolean
  reason?: 'duplicate-id' | 'sdk-version'
}

export class AppRegistry {
  private apps = new Map<string, AppDefinition>()

  /** 注册序=默认应用优先级（同 matcher 首个命中者为默认） */
  register(def: AppDefinition): RegisterResult {
    if (def.requiresSdk !== undefined && def.requiresSdk !== PROTOCOL_VERSION) {
      return { ok: false, reason: 'sdk-version' }
    }
    if (this.apps.has(def.id)) {
      // 去重：同 id 重复注册=后者拒载并 warn
      console.warn(`[mmagic] app id 冲突，拒载：${def.id}`)
      return { ok: false, reason: 'duplicate-id' }
    }
    this.apps.set(def.id, def)
    return { ok: true }
  }

  get(id: string): AppDefinition | undefined {
    return this.apps.get(id)
  }

  list(): AppDefinition[] {
    return [...this.apps.values()]
  }

  /** 全部命中应用（「打开方式」菜单序=注册序） */
  listMatches(file: FileRef): AppDefinition[] {
    return this.list().filter((def) => matches(def.matcher, file))
  }

  /** 默认应用=注册序第一个命中 */
  resolveDefault(file: FileRef): AppDefinition | null {
    return this.listMatches(file)[0] ?? null
  }

  /** 按 id 取或抛（openFile {appId} 指定不存在时 4102） */
  require(id: string): AppDefinition {
    const def = this.apps.get(id)
    if (!def) throw new SdkError(ERROR_CODES.NOT_FOUND, `app 不存在：${id}`)
    return def
  }

  unregister(id: string): boolean {
    return this.apps.delete(id)
  }
}
