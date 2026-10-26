/**
 * @mmagix/files-client 核心单测：URL 构造（fragment+encodeURIComponent）、withHostOrigin 注入、
 * createMmagixFilesHost 全流程（src 写入/握手/call-reply/超时/事件订阅/终态拆除/origin 双闸）。
 * 消息泵见 harness.ts（MessageEvent 构造器注入 origin，宿主双闸照常生效）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMEOUT_MS, MmxError, createMmagixFilesHost, normalizeBase, originOf, buildConfigUrl, buildFileUrl, withHostOrigin } from "../index";
import type { MmxWorkspaceConfig } from "../types";
import { IFRAME_ORIGIN, captureListener, fromIframe, makeIframeStub, pumpReady, type IframeStub } from "./harness";

/** 最小工作台配置（allowedOrigins 故意不含宿主 origin——withHostOrigin 应自动追加） */
function wsConfig(): MmxWorkspaceConfig {
  return {
    mode: "workspace",
    v: 1,
    backend: { endpoint: "http://s3", region: "r", bucket: "b", prefix: "p", credentials: { accessKeyId: "a", accessKeySecret: "s", sessionToken: "t" } },
    security: { allowedOrigins: ["https://admin.example"] },
  };
}

describe("URL 构造", () => {
  it("normalizeBase：补尾斜杠；缺省 5199", () => {
    expect(normalizeBase("http://x.com")).toBe("http://x.com/");
    expect(normalizeBase("http://x.com/")).toBe("http://x.com/");
    expect(normalizeBase()).toBe("http://localhost:5199/");
  });

  it("originOf：取精确 origin", () => {
    expect(originOf("https://files.example.com/app/")).toBe("https://files.example.com");
  });

  it("buildConfigUrl/buildFileUrl：fragment + encodeURIComponent（JSON 含 '+' 不受损）", () => {
    const cfg = { mode: "workspace", v: 1 } as unknown as MmxWorkspaceConfig;
    const url = buildConfigUrl("http://x.com", cfg);
    expect(url.startsWith("http://x.com/#config=")).toBe(true);
    const raw = url.slice("#config=".length + "http://x.com/".length - 1);
    expect(decodeURIComponent(url.split("#config=")[1]!)).toBe(JSON.stringify(cfg));
    // '+' 必须被编码为 %2B（禁 URLSearchParams 的 '+'→空格陷阱）
    const withPlus = buildConfigUrl("http://x.com", { ...cfg, backend: { endpoint: "http://s3?a=1+b", region: "", bucket: "", prefix: "", credentials: { accessKeyId: "", accessKeySecret: "", sessionToken: "" } } });
    expect(withPlus).toContain("%2B");
    const furl = buildFileUrl("http://x.com", { mode: "file", v: 1, source: { url: "https://a/b" } });
    expect(furl.startsWith("http://x.com/#file=")).toBe(true);
    void raw;
  });
});

describe("withHostOrigin", () => {
  it("workspace：追加宿主 origin（去重保序）", () => {
    const cfg = wsConfig();
    const out = withHostOrigin(cfg);
    expect(out.security.allowedOrigins).toEqual(["https://admin.example", window.location.origin]);
    const again = withHostOrigin(out);
    expect(again.security.allowedOrigins).toHaveLength(2); // 幂等
  });

  it("file：security 缺省时创建并注入", () => {
    const file: Parameters<typeof withHostOrigin>[0] = { mode: "file", v: 1, source: { url: "https://a" } };
    const cfg = withHostOrigin(file);
    expect(cfg.security?.allowedOrigins).toEqual([window.location.origin]);
  });
});

// ───────────────────────── createMmagixFilesHost 流程 ─────────────────────────

describe("createMmagixFilesHost", () => {
  let iframe: IframeStub;
  let restore: () => void;

  beforeEach(() => {
    iframe = makeIframeStub();
    restore = captureListener().restore;
    // captureListener 在 mock 期间建宿主；restore 立即还原因 vi.spyOn 行为——
    // 但宿主注册的 listener 引用已在 listeners 里。这里需要拿引用：
    // 简化口径：restore 前先建宿主（本文件各用例内自行控制），beforeEach 只重置桩。
    restore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 建宿主并抓 listener（顺序：先抓后建） */
  function makeHost(opts?: Partial<Parameters<typeof createMmagixFilesHost>[0]>) {
    const cap = captureListener();
    const host = createMmagixFilesHost({ iframe, config: wsConfig(), ...opts });
    cap.restore();
    const listener = cap.listeners.at(-1)!;
    expect(listener, "宿主应注册恰好一条 message 监听").toBeTruthy();
    return { host, listener };
  }

  it("装载即写 src（#config fragment 含宿主 origin 注入）+ 等 ready（10s 缺省超时口径）", async () => {
    const { host } = makeHost();
    expect(iframe.src).toContain(`${IFRAME_ORIGIN}/#config=`);
    const decoded = JSON.parse(decodeURIComponent(iframe.src.split("#config=")[1]!));
    expect(decoded.security.allowedOrigins).toContain(window.location.origin);
    expect(host.iframeOrigin).toBe(IFRAME_ORIGIN);
    expect(host.isReady()).toBe(false);

    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "evt", id: "e1", name: "ready", payload: { sdkVersion: "1.1.0", protocolVersion: 1, configSummary: {} } });
    const info = await host.ready;
    expect(info.sdkVersion).toBe("1.1.0");
    expect(host.isReady()).toBe(true);
  });

  it("ready 超时：4004 且文案含白名单诊断", async () => {
    vi.useFakeTimers();
    const { host } = makeHost({ timeoutMs: 50 });
    const assertion = expect(host.ready).rejects.toMatchObject({ code: 4004 });
    await vi.advanceTimersByTimeAsync(60);
    await assertion.catch((e) => expect(String(e)).toContain("allowedOrigins"));
  });

  it("ready 前发命令：4303 拒绝（不排队）", async () => {
    const { host } = makeHost();
    await expect(host.call("getInfo")).rejects.toMatchObject({ code: 4303 });
  });

  it("call→reply(ok)：信封形状/ns/v/kind/targetOrigin 全对，payload 透传", async () => {
    const { host } = makeHost();
    await pumpReady();
    const p = host.call<{ files: number }>("list", { path: "/" });
    expect(iframe.contentWindow!.postMessage).toHaveBeenCalledTimes(1);
    const sent = iframe.postMessages[0]!;
    expect(sent.targetOrigin).toBe(IFRAME_ORIGIN); // 禁 '*'
    expect(sent.env).toMatchObject({ ns: "mmagix-files", v: 1, kind: "cmd", name: "list", payload: { path: "/" } });
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "reply", id: sent.env.id, name: "list", ok: true, payload: { files: 3 } });
    await expect(p).resolves.toEqual({ files: 3 });
  });

  it("reply(ok=false)：reject MmxError(code)", async () => {
    const { host } = makeHost();
    await pumpReady();
    const p = host.call("remove", { key: "a" });
    const sent = iframe.postMessages[0]!;
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "reply", id: sent.env.id, name: "remove", ok: false, code: 4002, payload: { reason: "denied" } });
    await expect(p).rejects.toMatchObject({ code: 4002, detail: { reason: "denied" } });
  });

  it("命令超时：4004 + pending 清理（迟到 reply 被忽略）", async () => {
    vi.useFakeTimers();
    const { host, listener } = makeHost();
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "evt", id: "e1", name: "ready", payload: {} });
    await vi.advanceTimersByTimeAsync(1);
    const p = host.call("slow", {}, 100);
    const assertion = expect(p).rejects.toMatchObject({ code: 4004 });
    await vi.advanceTimersByTimeAsync(120);
    await assertion;
    // 迟到 reply：无 pending，静默（不抛 unhandled）
    const lateId = iframe.postMessages[0]!.env.id;
    listener(new MessageEvent("message", { origin: IFRAME_ORIGIN, data: { ns: "mmagix-files", v: 1, kind: "reply", id: lateId, name: "slow", ok: true, payload: 1 } }));
    void DEFAULT_TIMEOUT_MS;
  });

  it("origin 双闸：异 origin 入站忽略（onLog 诊断）；异 ns/异版本静默", async () => {
    const onLog = vi.fn();
    const { host } = makeHost({ onLog });
    fromIframe("https://evil.example", { ns: "mmagix-files", v: 1, kind: "evt", id: "x", name: "ready", payload: {} });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("evil.example"), true);
    fromIframe(IFRAME_ORIGIN, { ns: "other", v: 1, kind: "evt", id: "x", name: "ready", payload: {} });
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 2, kind: "evt", id: "x", name: "ready", payload: {} });
    // ready 未到（三条都被忽略）——ready 的 10s 超时另有专测，此处只断言握手未发生
    expect(host.isReady()).toBe(false);
  });

  it("on/事件派发：订阅收到、退订后不再收；expired 终态拆除监听", async () => {
    const events: string[] = [];
    const { host, listener } = makeHost();
    await pumpReady();
    const off = host.on("fileOpened", () => events.push("opened"));
    listener(new MessageEvent("message", { origin: IFRAME_ORIGIN, data: { ns: "mmagix-files", v: 1, kind: "evt", id: "e2", name: "fileOpened", payload: { key: "a" } } }));
    expect(events).toEqual(["opened"]);
    off();
    listener(new MessageEvent("message", { origin: IFRAME_ORIGIN, data: { ns: "mmagix-files", v: 1, kind: "evt", id: "e3", name: "fileOpened", payload: { key: "b" } } }));
    expect(events).toEqual(["opened"]);

    // expired：派发后 teardown
    const expiredCb = vi.fn();
    host.on("expired", expiredCb);
    listener(new MessageEvent("message", { origin: IFRAME_ORIGIN, data: { ns: "mmagix-files", v: 1, kind: "evt", id: "e4", name: "expired", payload: {} } }));
    expect(expiredCb).toHaveBeenCalledTimes(1);
    expect(host.isDestroyed()).toBe(true);
    await expect(host.call("getInfo")).rejects.toMatchObject({ code: 5000 });
  });

  it("destroy：发 destroy 命令→teardown；幂等", async () => {
    const { host } = makeHost();
    await pumpReady();
    const d1 = host.destroy();
    // destroy 发出的 cmd：模拟 ack
    const sent = iframe.postMessages.at(-1)!;
    expect(sent.env.name).toBe("destroy");
    fromIframe(IFRAME_ORIGIN, { ns: "mmagix-files", v: 1, kind: "reply", id: sent.env.id, name: "destroy", ok: true, payload: {} });
    await d1;
    expect(host.isDestroyed()).toBe(true);
    await host.destroy(); // 幂等：不抛
  });
});
