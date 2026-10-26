/**
 * useMmagixFilesClient（Vue 层）单测：状态机流转/日志上限/run 包装/destroy 复位/uploadProgress 节流。
 * onBeforeUnmount 在无组件实例时仅告警（不影响行为）——统一静默。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMmagixFilesClient } from "../vue";
import { MmxError } from "../error";
import { IFRAME_ORIGIN, captureListener, fromIframe, makeIframeStub, type IframeStub } from "./harness";

describe("useMmagixFilesClient", () => {
  let iframe: IframeStub;
  let cap: ReturnType<typeof captureListener>;

  beforeEach(() => {
    iframe = makeIframeStub();
    vi.spyOn(console, "warn").mockImplementation(() => {}); // onBeforeUnmount 无实例告警
    cap = captureListener();
  });

  afterEach(() => {
    cap.restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 建客户端并完成一次 mount（喂 ready），返回客户端（listener 用 beforeEach 捕获的 cap） */
  async function makeReady() {
    const client = useMmagixFilesClient();
    client.iframeRef.value = iframe as unknown as HTMLIFrameElement;
    const mounting = client.mount({ mode: "file", v: 1, source: { url: "https://a/b" } });
    await vi.waitFor(() => expect(cap.listeners.length).toBeGreaterThan(0));
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "evt", id: "e1", name: "ready", payload: { sdkVersion: "1.1.0", protocolVersion: 1, configSummary: {} } });
    await mounting;
    return client;
  }

  it("mount：idle→mounting→ready，日志含 iframe.src 与 ready 摘要", async () => {
    const client = await makeReady();
    expect(client.status.value).toBe("ready");
    expect(client.readyInfo.value?.sdkVersion).toBe("1.1.0");
    expect(client.isReady()).toBe(true);
    const logText = client.logs.value.map((l) => l.text).join("\n");
    expect(logText).toContain("mounting iframe");
    expect(logText).toContain("#file=");
    expect(logText).toContain("ready ✓");
  });

  it("未装载 call：4005 拒绝 + 日志 ✗；装载后 call：回包 ✓", async () => {
    const client = useMmagixFilesClient();
    client.iframeRef.value = iframe as unknown as HTMLIFrameElement;
    await expect(client.call("getInfo")).rejects.toMatchObject({ code: 4005 });
    expect(client.logs.value.at(-1)?.ok).toBe(false);

    const ready = await makeReady();
    const p = ready.call<number>("count", {});
    const sent = iframe.postMessages[0]!;
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "reply", id: sent.env.id, name: "count", ok: true, payload: 7 });
    await expect(p).resolves.toBe(7);
    expect(ready.logs.value.at(-1)?.text).toContain("count ✓ 7");
  });

  it("run 包装：成功记 ✓、失败记 ✗（MmxError 带 code）并上抛", async () => {
    const client = await makeReady();
    await client.run("ok-action", async () => 42);
    expect(client.logs.value.at(-1)?.text).toContain("ok-action ✓ 42");
    const boom = new MmxError(4002, "denied");
    await expect(client.run("bad-action", async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(client.logs.value.at(-1)?.text).toContain("bad-action ✗（code=4002）");
  });

  it("destroy：状态回 idle + 日志；getHost 复位", async () => {
    const client = await makeReady();
    await client.destroy();
    expect(client.status.value).toBe("idle");
    expect(client.readyInfo.value).toBeNull();
    expect(client.getHost()).toBeNull();
    expect(client.logs.value.at(-1)?.text).toContain("destroy ✓");
  });

  it("日志上限：超过 LOG_LIMIT 截断保留最新", async () => {
    const client = await makeReady();
    for (let i = 0; i < 260; i++) client.log(`line-${i}`);
    expect(client.logs.value.length).toBeLessThanOrEqual(200);
    expect(client.logs.value[0]!.text).not.toBe("line-0");
    expect(client.logs.value.at(-1)?.text).toBe("line-259");
  });

  it("uploadProgress 节流：500ms 内至多一条（走真实事件泵→onEvent→handleEvent）", async () => {
    const client = await makeReady();
    vi.useFakeTimers({ now: 1_000_000 });
    const fire = () => fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "evt", id: `u${Math.random()}`, name: "uploadProgress", payload: { loaded: 1 } });
    const countOf = () => client.logs.value.filter((l) => l.text.includes("uploadProgress")).length;

    fire();
    fire();
    fire();
    expect(countOf()).toBe(1); // 同拍三发只记一条
    vi.advanceTimersByTime(500);
    fire();
    expect(countOf()).toBe(2); // 过 500ms 节流窗口：再记一条
  });

  it("重装坑：mount 两次——旧会话 destroy、src 先归位 about:blank 再写新 fragment", async () => {
    const client = useMmagixFilesClient();
    client.iframeRef.value = iframe as unknown as HTMLIFrameElement;
    const m1 = client.mount({ mode: "file", v: 1, source: { url: "https://a/1" } });
    await vi.waitFor(() => expect(cap.listeners.length).toBeGreaterThan(0));
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "evt", id: "e1", name: "ready", payload: { sdkVersion: "1", protocolVersion: 1, configSummary: {} } });
    await m1;

    const m2 = client.mount({ mode: "file", v: 1, source: { url: "https://a/2" } });
    // 重装路径：destroy 旧会话（发 destroy cmd→ack）→ about:blank 归位 → sleep(150) → 新 src
    const destroySent = iframe.postMessages.find((m) => m.env.name === "destroy");
    if (destroySent) {
      fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "reply", id: destroySent.env.id, name: "destroy", ok: true, payload: {} });
    }
    await vi.waitFor(() => expect(cap.listeners.length).toBeGreaterThanOrEqual(2)); // 新宿主已注册
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "evt", id: "e2", name: "ready", payload: { sdkVersion: "2", protocolVersion: 1, configSummary: {} } });
    await m2;
    expect(iframe.src).toContain("a%2F2");
    expect(client.readyInfo.value?.sdkVersion).toBe("2");
  });
});
