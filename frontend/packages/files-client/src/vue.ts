/**
 * Vue 3 组合式层：useMmagixFilesClient——状态机 idle/mounting/ready/error + 日志 + 演示动作。
 * 核心（createMmagixFilesHost）与本层解耦：非 Vue 宿主直接用核心入口 `@mmagix/files-client`。
 * 组件卸载自动 destroy。
 */
import { onBeforeUnmount, ref, shallowRef } from "vue";
import { DEFAULT_FILES_BASE } from "./constants";
import { MmxError } from "./error";
import { createMmagixFilesHost, type MmagixFilesHost } from "./host";
import { originOf } from "./url";
import type { MmxAppConfig, MmxEventHandler, MmxEventName, MmxReadyPayload } from "./types";

export type EmbedStatus = "idle" | "mounting" | "ready" | "error";

export interface LogEntry {
  time: string;
  text: string;
  ok: boolean;
}

/** 日志上限（同 opencut-embed-demo 形态） */
const LOG_LIMIT = 200;
/** uploadProgress 日志节流间隔：每 500ms 至多一条，防刷屏 */
const PROGRESS_LOG_INTERVAL_MS = 500;
/** 日志里 payload 摘要截断长度 */
const PAYLOAD_PREVIEW_LEN = 160;

/**
 * Vue 封装：状态机 + 日志面板 + 动作包装。
 * EmbedPlay（工作台）/FilePlay（单文件）共用；组件卸载自动 destroy。
 */
export function useMmagixFilesClient() {
  const iframeRef = ref<HTMLIFrameElement | null>(null);
  const status = ref<EmbedStatus>("idle");
  const errorText = ref("");
  const logs = ref<LogEntry[]>([]);
  const readyInfo = shallowRef<MmxReadyPayload | null>(null);
  let host: MmagixFilesHost | null = null;
  let lastProgressLogAt = 0;

  function log(text: string, ok = true): void {
    logs.value.push({ time: new Date().toLocaleTimeString(), text, ok });
    if (logs.value.length > LOG_LIMIT) {
      logs.value.splice(0, logs.value.length - LOG_LIMIT);
    }
  }

  /** payload 摘要：截断过深对象，保日志可读 */
  function preview(payload: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(payload) ?? "";
    } catch {
      text = String(payload);
    }
    return text.length > PAYLOAD_PREVIEW_LEN ? `${text.slice(0, PAYLOAD_PREVIEW_LEN)}…` : text;
  }

  /** 事件总回调：全部事件到达即记录；uploadProgress 500ms 节流 */
  function handleEvent(name: MmxEventName, payload: unknown): void {
    if (name === "uploadProgress") {
      const now = Date.now();
      if (now - lastProgressLogAt < PROGRESS_LOG_INTERVAL_MS) return;
      lastProgressLogAt = now;
      log(`evt uploadProgress（节流500ms）${preview(payload)}`);
      return;
    }
    log(`evt ${name} ${preview(payload)}`);
  }

  /**
   * 装载 iframe 并等待 ready 握手。
   * @param config 工作台/单文件配置（自动注入宿主 origin 到 allowedOrigins）
   * @param baseUrl SPA 基址（缺省 http://localhost:5199/）
   */
  async function mount(config: MmxAppConfig, baseUrl?: string): Promise<MmxReadyPayload> {
    if (!iframeRef.value) throw new Error("iframe 元素未就绪");
    if (host) {
      await host.destroy(); // 重装前先拆旧会话
      host = null;
      // ⚠️ 重装坑：新旧 src 若逐字节相同（仅 fragment、配置未变），对 iframe 写 src 不触发
      // 导航——旧文档原地不动、永不发新 ready，mount 必 4004 超时。先归位 about:blank 强制
      // 下一次 src 写入成为真实跨文档导航（等一拍让归位导航先提交）。
      iframeRef.value.src = "about:blank";
      await sleep(150);
    }
    status.value = "mounting";
    errorText.value = "";
    log(`mounting iframe → ${originOf(baseUrl ?? DEFAULT_FILES_BASE)} …`);
    try {
      const h = createMmagixFilesHost({
        iframe: iframeRef.value,
        config,
        baseUrl,
        onEvent: handleEvent,
        onLog: (t, ok) => log(t, ok),
      });
      host = h;
      log(`iframe.src = ${h.url.length > 120 ? `${h.url.slice(0, 120)}…` : h.url}`);
      const info = await h.ready;
      readyInfo.value = info;
      status.value = "ready";
      log(`ready ✓ sdk=${info.sdkVersion} protocol=v${info.protocolVersion}`);
      return info;
    } catch (err) {
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : String(err);
      log(`mount failed: ${errorText.value}`, false);
      throw err;
    }
  }

  /** 动作统一包装：结果/失败进日志，失败抛 MmxError 供调用方提示 */
  async function run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      log(`${name} ✓ ${result === undefined || result === null ? "" : preview(result)}`);
      return result;
    } catch (err) {
      const code = err instanceof MmxError ? `（code=${err.code}）` : "";
      const msg = err instanceof Error ? err.message : String(err);
      log(`${name} ✗${code} ${msg}`, false);
      throw err;
    }
  }

  function requireHost(): MmagixFilesHost {
    if (!host) throw new MmxError(4005, "尚未装载 iframe");
    return host;
  }

  /** 便捷：发命令（未装载/未握手直接失败并记日志） */
  function call<T = unknown>(name: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    return run(name, () => requireHost().call<T>(name, payload, timeoutMs));
  }

  /** 订阅 iframe 事件（与日志并行的业务订阅位） */
  function on(name: MmxEventName, handler: MmxEventHandler): () => void {
    return host?.on(name, handler) ?? (() => {});
  }

  /** 会话销毁：发 destroy 命令、拆监听、状态回 idle */
  async function destroy(): Promise<void> {
    if (!host) return;
    const h = host;
    host = null;
    readyInfo.value = null;
    await h.destroy();
    status.value = "idle";
    log("destroy ✓ 监听已拆除，状态回 idle");
  }

  onBeforeUnmount(() => {
    void host?.destroy();
    host = null;
  });

  return {
    iframeRef,
    status,
    errorText,
    logs,
    readyInfo,
    log,
    mount,
    run,
    call,
    on,
    destroy,
    /** 当前是否可发命令（ready 后可用） */
    isReady: () => host?.isReady() === true,
    /** 当前宿主句柄（高级用法） */
    getHost: () => host,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
