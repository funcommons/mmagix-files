/**
 * diagnostics.ts 单测（site2 /guide S05 连接诊断纯函数，零 UI 依赖 → node 环境够用）。
 *
 * 断言口径：一律按实现实际行为（含其文件头「诚实降级」注释交代的口径），不按想象中的理想语义。
 * fetch 用 vi.stubGlobal 桩掉——本套件不发真实网络请求。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyProbe, probeWebDav } from "../diagnostics";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("classifyProbe · 五步 verdict 分类器（喂 status 即可）", () => {
  it("207 multistatus（WebDAV 列目录成功码）→ ok + done，无 reason/message", () => {
    expect(classifyProbe(207)).toEqual({ ok: true, step: "done" });
  });

  it("200 → ok + done（2xx 全绿含 200/204）", () => {
    expect(classifyProbe(200)).toEqual({ ok: true, step: "done" });
    expect(classifyProbe(204)).toEqual({ ok: true, step: "done" });
  });

  it("401 → auth（请求已穿过预检、到达鉴权层）", () => {
    expect(classifyProbe(401)).toEqual({ ok: false, step: "auth", reason: "auth" });
  });

  it("403 → auth（按实现：docstring 把 401/403 一并归 auth；WebDAV 语义里 403 更近「权限禁止」而非凭证失效，此归并张力见报告，断言从实现）", () => {
    expect(classifyProbe(403)).toEqual({ ok: false, step: "auth", reason: "auth" });
  });

  it("404 → address（服务在、路径/资源不对 → 列目录步失败，reason=address）", () => {
    expect(classifyProbe(404)).toEqual({ ok: false, step: "list", reason: "address" });
  });

  it("400/429 等其余 4xx → address（实现口径：非 2xx 非 401/403 且 <500 一律地址不可达）", () => {
    expect(classifyProbe(400)).toEqual({ ok: false, step: "list", reason: "address" });
    expect(classifyProbe(429)).toEqual({ ok: false, step: "list", reason: "address" });
  });

  it("5xx（500/503）→ server", () => {
    expect(classifyProbe(500)).toEqual({ ok: false, step: "list", reason: "server" });
    expect(classifyProbe(503)).toEqual({ ok: false, step: "list", reason: "server" });
  });

  it("status=null 无 err → preflight + network，message 如实含「跨域」——浏览器无法区分网络不通与 CORS（fetch 两种情况都 reject 同一种 TypeError），验证 message 诚实归并", () => {
    const v = classifyProbe(null);
    expect(v.ok).toBe(false);
    expect(v.step).toBe("preflight");
    expect(v.reason).toBe("network");
    expect(v.message).toContain("跨域");
    expect(v.message).toContain("CORS");
    expect(v.message).not.toContain("探测超时");
  });

  it("status=null + AbortError → network，message 补注「探测超时」（仍含跨域字样）", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const v = classifyProbe(null, err);
    expect(v.reason).toBe("network");
    expect(v.step).toBe("preflight");
    expect(v.message).toContain("跨域");
    expect(v.message).toContain("探测超时");
  });

  it("status=null + 非 Abort 的 Error（如 fetch 的 TypeError）→ 普通 network message，不误标超时", () => {
    const v = classifyProbe(null, new TypeError("Failed to fetch"));
    expect(v.reason).toBe("network");
    expect(v.message).not.toContain("探测超时");
  });
});

describe("probeWebDav · PROPFIND Depth:0 真实探测（fetch 全桩）", () => {
  type FetchInit = { method?: string; headers?: Record<string, string>; signal?: AbortSignal };

  function stubFetch(status: number): { calls: { url: string; init: FetchInit }[] } {
    const calls: { url: string; init: FetchInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: FetchInit = {}) => {
        calls.push({ url, init });
        return { status } as Response;
      }),
    );
    return { calls };
  }

  it("成对凭证：Authorization=Basic btoa('user:pass') + Depth:0 + PROPFIND", async () => {
    const { calls } = stubFetch(207);
    const v = await probeWebDav("http://x:1/dav/", { username: "user", password: "pass" });
    expect(v).toEqual({ ok: true, step: "done" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://x:1/dav/");
    expect(calls[0]!.init.method).toBe("PROPFIND");
    expect(calls[0]!.init.headers?.Depth).toBe("0");
    expect(calls[0]!.init.headers?.Authorization).toBe(`Basic ${btoa("user:pass")}`);
    expect(calls[0]!.init.signal?.aborted).toBe(false); // 正常返回，计时器被清理、信号未触发
  });

  it("半凭证纪律：只填 username → 不带 Authorization 头（匿名探测，与 configBuilder 半凭证同口径）", async () => {
    const { calls } = stubFetch(401);
    const v = await probeWebDav("http://x:1/dav/", { username: "user", password: "" });
    expect(v).toEqual({ ok: false, step: "auth", reason: "auth" });
    expect(calls[0]!.init.headers?.Authorization).toBeUndefined();
    expect(calls[0]!.init.headers?.Depth).toBe("0");
  });

  it("只填 password 同理无 Authorization；完全不传 auth 亦无", async () => {
    const a = stubFetch(401);
    await probeWebDav("http://x:1/dav/", { username: "", password: "pass" });
    expect(a.calls[0]!.init.headers?.Authorization).toBeUndefined();

    const b = stubFetch(401);
    await probeWebDav("http://x:1/dav/");
    expect(b.calls[0]!.init.headers?.Authorization).toBeUndefined();
  });

  it("username 首尾空白被 trim 后再进 Basic（按实现：auth.username.trim()）", async () => {
    const { calls } = stubFetch(207);
    await probeWebDav("http://x:1/dav/", { username: "  user  ", password: "pass" });
    expect(calls[0]!.init.headers?.Authorization).toBe(`Basic ${btoa("user:pass")}`);
  });

  it("endpoint 首尾空白被 trim 后再发请求", async () => {
    const { calls } = stubFetch(207);
    await probeWebDav("  http://x:1/dav/  ");
    expect(calls[0]!.url).toBe("http://x:1/dav/");
  });

  it("207 → ok；401 → auth（状态码统一交给 classifyProbe）", async () => {
    stubFetch(207);
    expect(await probeWebDav("http://x:1/dav/")).toEqual({ ok: true, step: "done" });

    stubFetch(401);
    expect(await probeWebDav("http://x:1/dav/")).toEqual({ ok: false, step: "auth", reason: "auth" });
  });

  it("非法 URL / 非 http(s) 协议 → parse + address（本地判定，fetch 不发）", async () => {
    const { calls } = stubFetch(207);
    const bad = await probeWebDav("not a url");
    expect(bad).toEqual({ ok: false, step: "parse", reason: "address", message: "地址不是合法 URL" });
    const ftp = await probeWebDav("ftp://x:1/dav");
    expect(ftp).toEqual({ ok: false, step: "parse", reason: "address", message: "协议须为 http(s)" });
    expect(calls).toHaveLength(0);
  });

  it("fetch reject（网络不通 / CORS 未放行）→ preflight + network，message 如实含「跨域」", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const v = await probeWebDav("http://x:1/dav/");
    expect(v.ok).toBe(false);
    expect(v.step).toBe("preflight");
    expect(v.reason).toBe("network");
    expect(v.message).toContain("跨域");
    expect(v.message).not.toContain("探测超时");
  });

  it("超时路径（mock reject AbortError）→ network 且 message 注明「探测超时」", async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(err)));
    const v = await probeWebDav("http://x:1/dav/");
    expect(v.reason).toBe("network");
    expect(v.message).toContain("探测超时");
  });

  it("超时路径（AbortController 到点真触发）：信号 aborted → network + 探测超时", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit = {}) =>
          new Promise<Response>((_resolve, reject) => {
            calls.push(init);
            init.signal!.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      ),
    );
    vi.useFakeTimers();
    const pending = probeWebDav("http://x:1/dav/", undefined, 50);
    await vi.advanceTimersByTimeAsync(60);
    const v = await pending;
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("network");
    expect(v.step).toBe("preflight");
    expect(v.message).toContain("探测超时");
    expect(calls[0]!.signal?.aborted).toBe(true);
  });
});
