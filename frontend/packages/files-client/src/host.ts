/**
 * 裸 postMessage 宿主端实现（框架无关核心，协议 §一/§三/§七）：
 *  1. withHostOrigin 注入宿主 origin → buildConfigUrl/buildFileUrl 拼 fragment → 写 iframe.src
 *  2. window.addEventListener('message')，只认 ns=mmagix-files 且 event.origin===iframe origin
 *  3. 等 evt ready（10s 超时）；reply 按 cmd id 匹配；事件派发给订阅者 + onEvent 总回调
 *
 * 发送 targetOrigin 一律取 iframe 的精确 origin，禁 '*'（协议 §一双向强制）。
 * 握手：iframe boot 完成即发 evt ready；宿主等 ready（默认 10s 超时）后才能发 cmd。
 */
import { DEFAULT_FILES_BASE, DEFAULT_TIMEOUT_MS, NS, PROTOCOL_VERSION } from "./constants";
import { MmxError } from "./error";
import { buildConfigUrl, buildFileUrl, originOf, withHostOrigin } from "./url";
import type { MmxAppConfig, MmxEventHandler, MmxEventName, MmxReadyPayload } from "./types";

/** 信封（镜像 sdk/types Envelope——只读镜像，漂移由 frontend 套件内漂移测试拦截） */
export interface MmxEnvelope {
  ns: typeof NS;
  v: number;
  kind: "cmd" | "evt" | "reply";
  id: string;
  name: string;
  payload: unknown;
  ok?: boolean;
  code?: number;
}

let seq = 0;
function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  seq += 1;
  return `${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MmagixFilesHostOptions {
  /** 已存在的 <iframe> 元素（src 由本工厂写入） */
  iframe: HTMLIFrameElement;
  /** SPA 基址（缺省 http://localhost:5199/）；决定 iframe origin 与 targetOrigin */
  baseUrl?: string;
  /** 工作台或单文件配置（会原地注入宿主 origin 到 security.allowedOrigins） */
  config: MmxAppConfig;
  /** 命令超时（缺省 10s，与 iframe 侧 DEFAULT_TIMEOUT_MS 同口径） */
  timeoutMs?: number;
  /** 每条协议事件都会回调（含 ready；用于日志面板） */
  onEvent?: (name: MmxEventName, payload: unknown) => void;
  /** 非致命诊断（origin 不符的入站消息等） */
  onLog?: (text: string, ok: boolean) => void;
}

export interface MmagixFilesHost {
  /** 实际装载的 iframe src（#config/#file fragment 全文） */
  readonly url: string;
  /** iframe 精确 origin（= 收包 event.origin 白名单 + 发包 targetOrigin） */
  readonly iframeOrigin: string;
  /** ready 握手 Promise（10s 超时 reject MmxError(4004)） */
  readonly ready: Promise<MmxReadyPayload>;
  /** 是否已握手（ready 已到） */
  readonly isReady: () => boolean;
  /** 是否已终态（expired 已到 / destroy 完成） */
  readonly isDestroyed: () => boolean;
  /** 发命令并等 reply（按 id 匹配；ok=false reject MmxError(code)） */
  call<T = unknown>(name: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  /** 订阅事件（与 onEvent 日志回调互不影响），返回解绑函数 */
  on(name: MmxEventName, handler: MmxEventHandler): () => void;
  /** 发 destroy 命令并拆除监听（幂等） */
  destroy(): Promise<void>;
}

export function createMmagixFilesHost(options: MmagixFilesHostOptions): MmagixFilesHost {
  const { iframe, onEvent, onLog } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? DEFAULT_FILES_BASE;
  const iframeOrigin = originOf(baseUrl);
  const config = withHostOrigin(options.config);
  const url = config.mode === "workspace" ? buildConfigUrl(baseUrl, config) : buildFileUrl(baseUrl, config);

  const handlers = new Map<MmxEventName, Set<MmxEventHandler>>();
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: MmxError): void; timer: ReturnType<typeof setTimeout> }>();
  let readyResolve: ((p: MmxReadyPayload) => void) | null = null;
  let readyReject: ((e: MmxError) => void) | null = null;
  let readyFlag = false;
  let destroyed = false;

  const ready = new Promise<MmxReadyPayload>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    setTimeout(() => {
      if (!readyFlag && !destroyed) {
        reject(
          new MmxError(
            4004,
            `等待 ready 超时（${timeoutMs}ms）——若连 ready 都收不到，检查 baseUrl 是否正确、` +
              `iframe 页是否启动；若 ready 收到但命令全超时，才是 allowedOrigins 白名单问题`,
          ),
        );
      }
    }, timeoutMs);
  });

  function dispatch(name: MmxEventName, payload: unknown): void {
    onEvent?.(name, payload);
    const set = handlers.get(name);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[mmx] 事件 ${name} 处理器异常`, err);
      }
    }
  }

  function teardown(): void {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener("message", onMessage);
    const err = new MmxError(5000, "会话已销毁");
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    handlers.clear();
  }

  const onMessage = (e: MessageEvent): void => {
    // 双闸之一：来源必须是 iframe 的精确 origin（协议 §一；targetOrigin 对偶校验在发送侧）
    if (e.origin !== iframeOrigin) {
      onLog?.(`忽略来自 ${e.origin} 的非 iframe 消息`, true);
      return;
    }
    const data = e.data as Partial<MmxEnvelope> | null;
    if (typeof data !== "object" || data === null) return;
    if (data.ns !== NS || data.v !== PROTOCOL_VERSION) return; // 非本命名空间一律忽略
    if (data.kind === "reply") {
      const entry = pending.get(data.id as string);
      if (!entry) return; // 迟到/未知 id 的 reply，忽略
      pending.delete(data.id as string);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.payload);
      else {
        const code = typeof data.code === "number" ? data.code : 5000;
        entry.reject(new MmxError(code, `命令 ${data.name} 失败（code=${code}）`, data.payload));
      }
      return;
    }
    if (data.kind === "evt") {
      const name = data.name as MmxEventName;
      if (name === "ready") {
        readyFlag = true;
      }
      if (name === "expired") {
        // 终态（§三）：ttl 到点或 destroy 完成——之后零消息，拆除监听
        dispatch(name, data.payload);
        teardown();
        return;
      }
      dispatch(name, data.payload);
      if (name === "ready") readyResolve?.(data.payload as MmxReadyPayload);
    }
  };

  // 发送 targetOrigin 一律为 iframe 精确 origin，禁 '*'（协议 §一）
  iframe.src = url;
  window.addEventListener("message", onMessage);

  const host: MmagixFilesHost = {
    url,
    iframeOrigin,
    ready,
    isReady: () => readyFlag,
    isDestroyed: () => destroyed,

    call<T = unknown>(name: string, payload?: unknown, perCallTimeout?: number): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (destroyed) {
          reject(new MmxError(5000, "会话已销毁，命令拒绝"));
          return;
        }
        if (!readyFlag) {
          // iframe 侧对 ready 前命令有 50 条队列，但宿主侧直接拒绝更直观（§三 4303 同码）
          reject(new MmxError(4303, "尚未握手（未收到 ready），命令拒绝"));
          return;
        }
        const win = iframe.contentWindow;
        if (!win) {
          reject(new MmxError(4005, "iframe.contentWindow 不可用"));
          return;
        }
        const id = uuid();
        const env: MmxEnvelope = {
          ns: NS,
          v: PROTOCOL_VERSION,
          kind: "cmd",
          id,
          name,
          payload: payload ?? {},
        };
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(
              new MmxError(
                4004,
                `命令 ${name} 超时（${perCallTimeout ?? timeoutMs}ms）——` +
                  `若所有命令都超时，优先检查 #config 的 security.allowedOrigins 是否含宿主 origin`,
              ),
            );
          }
        }, perCallTimeout ?? timeoutMs);
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });
        win.postMessage(env, iframeOrigin);
      });
    },

    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler);
      return () => {
        const s = handlers.get(name);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) handlers.delete(name);
      };
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      try {
        // §三：先 reply(ack) 后 evt expired——ack 后稍候一拍，让 expired 落进日志再拆
        await host.call("destroy", {}, 3_000);
        await sleep(150);
      } catch {
        // 已终态/超时都视为结束；仍要拆监听
      }
      teardown();
    },
  };

  return host;
}
