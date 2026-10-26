/**
 * 客户端包协议漂移哨兵：@mmagix/files-client 的协议常量/信封形状必须与宿主 sdk 正本逐字段一致。
 * 本测试挂在 frontend 套件内（离 sdk 正本最近）——任一侧改动不同步即红。
 */
import { describe, expect, it } from "vitest";
import { NS as SdkNS, PROTOCOL_VERSION as SdkPV, CONFIG_VERSION as SdkCV } from "../../sdk/constants";
import { NS, PROTOCOL_VERSION, CONFIG_VERSION, DEFAULT_TIMEOUT_MS, DEFAULT_FILES_BASE } from "../../../packages/files-client/src/constants";
import { MmxError } from "../../../packages/files-client/src/error";

describe("@mmagix/files-client 协议漂移哨兵", () => {
  it("NS/PROTOCOL_VERSION/CONFIG_VERSION 与 sdk/constants 正本一致", () => {
    expect(NS).toBe(SdkNS);
    expect(PROTOCOL_VERSION).toBe(SdkPV);
    expect(CONFIG_VERSION).toBe(SdkCV);
    expect(NS).toBe("mmagix-files");
  });

  it("MmxError 形状与宿主侧错误语义对齐（name/code/detail 三件套）", () => {
    const e = new MmxError(4004, "timeout", { extra: 1 });
    expect(e.name).toBe("MmxError");
    expect(e.code).toBe(4004);
    expect(e.detail).toEqual({ extra: 1 });
    expect(e instanceof Error).toBe(true);
  });

  it("缺省口径：10s 超时、dev 基址 5199（与 sdk DEFAULT_TIMEOUT_MS 同源口径）", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_FILES_BASE).toBe("http://localhost:5199/");
  });
});
