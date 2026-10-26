/**
 * 测试 harness：jsdom 下的 iframe 桩 + iframe 侧消息泵。
 * MessageEvent 用构造器注入 origin/source（jsdom 允许 init 覆写）——宿主双闸校验照常生效。
 */
import { vi } from "vitest";
import type { MmxEnvelope } from "../host";

export const FILES_BASE = "http://localhost:5199/";
export const IFRAME_ORIGIN = "http://localhost:5199";

export interface IframeStub extends HTMLIFrameElement {
  postMessages: Array<{ env: MmxEnvelope; targetOrigin: string }>;
}

/** iframe 桩：src 可写、contentWindow.postMessage 记录调用 */
export function makeIframeStub(): IframeStub {
  const postMessages: Array<{ env: MmxEnvelope; targetOrigin: string }> = [];
  const stub = {
    src: "",
    contentWindow: {
      postMessage: vi.fn((env: MmxEnvelope, targetOrigin: string) => {
        postMessages.push({ env, targetOrigin });
      }),
    },
    postMessages,
  };
  return stub as unknown as IframeStub;
}

type Listener = (e: MessageEvent) => void;

/** 抓宿主注册的 message 监听（createMmagixFilesHost 恰好注册一个） */
export function captureListener(): { listeners: Listener[]; restore: () => void } {
  const listeners: Listener[] = [];
  const orig = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, "addEventListener").mockImplementation(((type: string, fn: EventListenerOrEventListenerObject) => {
    if (type === "message") listeners.push(fn as Listener);
    return orig(type, fn);
  }) as typeof window.addEventListener);
  return {
    listeners,
    restore: () => spy.mockRestore(),
  };
}

/** 以 iframe 的名义向 window 派发协议消息 */
export function fromIframe(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { origin, data }));
}

/** 等握手：先造宿主再喂 ready */
export async function pumpReady(origin = IFRAME_ORIGIN, payload: unknown = { sdkVersion: "1.1.0", protocolVersion: 1, configSummary: {} }): Promise<void> {
  fromIframe(origin, { ns: "mmagix-files", v: 1, kind: "evt", id: "evt-1", name: "ready", payload });
  await Promise.resolve();
}
