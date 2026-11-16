/**
 * 连接诊断纯函数（site2 /guide 步骤 3，S05 连接诊断）：零 UI 依赖，可单测。
 *
 * 浏览器端探测的「诚实降级」口径（与 Guide2 的分工）：
 * - S3 不做浏览器端预探测——SigV4 签名复杂易错，且 AK/SK 进前端签名等于凭证裸奔；
 *   S3 源一律交给工作台 mount 验证（/guide 步骤 4 交接 /play/workspace），本模块不涉 S3。
 * - WebDAV 用一条 PROPFIND Depth:0 走完五步：解析地址（本地 URL 解析）→ 安全预检
 *   （CORS/网络）→ 身份验证（Authorization Basic）→ 列目录（207 multistatus）→ 完成。
 *   网络不通（DNS/端口/服务未起）与 CORS 未放行在浏览器里不可分——fetch 两种情况都
 *   reject 同一种 TypeError，verdict.reason 归并为 "network"，message 如实写明不可分。
 */

export type ProbeVerdict = {
  ok: boolean;
  step: "parse" | "preflight" | "auth" | "list" | "done";
  reason?: "network" | "cors" | "auth" | "address" | "server";
  message?: string;
};

/**
 * 探测结果 → 五步 verdict 分类器（fetch 层无关，喂 status 即可，mount 抛错映射亦复用）：
 * - status=null（fetch reject：网络不通 / CORS 未放行 / 超时）→ preflight + network。
 *   AbortController 超时的 AbortError 在 message 里补注「探测超时」。
 * - 401/403 → auth（请求已穿过预检、到达鉴权层）。
 * - 2xx（含 WebDAV 的 207 multistatus）→ ok，五步全绿。
 * - 其余 4xx → 地址不可达（服务在、路径/资源不对）；5xx → server（服务端错误）。
 */
export function classifyProbe(status: number | null, err?: unknown): ProbeVerdict {
  if (status === null) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      step: "preflight",
      reason: "network",
      message: aborted
        ? "网络不通或跨域（CORS）未放行（探测超时）——浏览器无法区分二者"
        : "网络不通或跨域（CORS）未放行——浏览器无法区分二者",
    };
  }
  if (status === 401 || status === 403) return { ok: false, step: "auth", reason: "auth" };
  if (status >= 200 && status < 300) return { ok: true, step: "done" };
  return status >= 500
    ? { ok: false, step: "list", reason: "server" }
    : { ok: false, step: "list", reason: "address" };
}

/**
 * WebDAV 真实探测：PROPFIND Depth:0，8s 超时（AbortController）。
 * - Authorization Basic 仅在凭证成对且非空时携带（与 configBuilder.buildWebDavBackend 的
 *   半凭证纪律同口径：username 与 password 只填其一时按匿名处理——匿名 401 与「凭证无效」
 *   不混淆）。
 * - 解析失败/协议非 http(s) → parse + address（本地判定，不发请求）。
 * - fetch reject（网络/CORS/超时）与 HTTP 状态码统一交给 classifyProbe。
 */
export async function probeWebDav(
  endpoint: string,
  auth?: { username: string; password: string },
  timeoutMs = 8_000,
): Promise<ProbeVerdict> {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return { ok: false, step: "parse", reason: "address", message: "地址不是合法 URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, step: "parse", reason: "address", message: "协议须为 http(s)" };
  }

  const headers: Record<string, string> = { Depth: "0" };
  const username = auth?.username.trim() ?? "";
  const password = auth?.password ?? "";
  if (auth && username !== "" && password !== "") {
    // Basic 值须 latin1 安全：TextEncoder 先转 UTF-8 字节再逐字节拼串（非 ASCII 凭证不崩）
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let raw = "";
    for (const b of bytes) raw += String.fromCharCode(b);
    headers.Authorization = `Basic ${btoa(raw)}`;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { method: "PROPFIND", headers, signal: ctl.signal });
    return classifyProbe(res.status);
  } catch (err) {
    return classifyProbe(null, err);
  } finally {
    clearTimeout(timer);
  }
}
