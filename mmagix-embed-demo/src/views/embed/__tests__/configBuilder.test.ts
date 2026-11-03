/**
 * configBuilder 单测（EmbedPlay 表单 → #config 纯逻辑，零 Vue 依赖 → node 环境）。
 *
 * 基建两注记：
 * - node 环境无 window，而依赖链上 @/config/oem 模块顶层读 window.location.origin——
 *   用 vi.hoisted 在任何 import 求值前桩好（vi.hoisted 先于静态 import 执行）。
 * - vitest.config.ts 存在时整体取代 vite.config.ts，@ 与 @mmagix/files-client alias
 *   须在 vitest.config.ts resolve.alias 显式镜像（本套件依赖该配置解析 import）。
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(globalThis, { window: { location: { origin: "http://localhost:5200" } } });
});

import {
  buildWorkspaceConfig,
  FEATURE_KEYS,
  maskConfigForPreview,
  validateForm,
  type DemoFormFields,
} from "@/views/embed/configBuilder";

/** 全量合法 S3 表单（各用例按需覆写） */
function form(overrides: Partial<DemoFormFields> = {}): DemoFormFields {
  return {
    backendType: "s3",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "demo-bucket",
    accessKeyId: "AKID-example",
    accessKeySecret: "secret-example",
    sessionToken: "token-example",
    prefix: "docs/",
    webdavUsername: "",
    webdavPassword: "",
    webdavRootPath: "",
    webdavChunkedWrite: false,
    ttl: 900,
    theme: "light",
    locale: "zh-CN",
    initialPath: "",
    treeMode: "sidebar",
    treeTitle: "",
    disabledFeatures: [],
    univerPlugin: false,
    pdfAnnotator: false,
    mdPlugin: false,
    artplayerPlugin: false,
    filerobotPlugin: false,
    htmlPlugin: false,
    pptxPlugin: false,
    mdInitialMode: "",
    mdDefaultMode: "",
    ...overrides,
  };
}

describe("buildWorkspaceConfig · S3 分支（向后兼容铁律）", () => {
  it("全量字段表单：backend 无 type 键，S3 字段齐全", () => {
    const cfg = buildWorkspaceConfig(form());
    expect("type" in cfg.backend).toBe(false); // 不带 type=向后兼容既有 #config 消费点
    expect(cfg.backend).toEqual({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "demo-bucket",
      prefix: "docs/",
      credentials: {
        accessKeyId: "AKID-example",
        accessKeySecret: "secret-example",
        sessionToken: "token-example",
      },
      ttlSeconds: 900,
    });
  });

  it("region 空串缺省 us-east-1；ttl=0 序列化后无 ttlSeconds 键", () => {
    const cfg = buildWorkspaceConfig(form({ region: "   ", ttl: 0 }));
    const backend = cfg.backend as Record<string, unknown>;
    expect(backend.region).toBe("us-east-1");
    // 实现保留抽离前形态：ttl 非正时键位在但值为 undefined（'ttlSeconds' in backend 为 true），
    // JSON.stringify 丢 undefined——消费点（序列化后的 #config）可见契约即「无该键」
    expect(backend.ttlSeconds).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain('"ttlSeconds"');
  });

  it("plugins 全关无 plugins 键；仅 mdPlugin 开 → markdown-editor 入口（非 lazy）带 initialMode options", () => {
    expect("plugins" in buildWorkspaceConfig(form())).toBe(false);

    const cfg = buildWorkspaceConfig(form({ mdPlugin: true, mdInitialMode: "split" }));
    expect(cfg.plugins).toHaveLength(1);
    const [entry] = cfg.plugins!;
    expect(entry.url.endsWith("/plugins/markdown-editor.js")).toBe(true);
    expect(entry.lazy).toBe(false); // lazy 必须 false：md 有内置默认应用，lazy 在打开链永远轮不到
    expect(entry.options).toEqual({ initialMode: "split" });
  });

  it("disabledFeatures=['upload'] 只关 upload 其余全开；空数组无 features 键", () => {
    const { features } = buildWorkspaceConfig(form({ disabledFeatures: ["upload"] }));
    expect(features!.upload).toBe(false);
    for (const key of FEATURE_KEYS.filter((k) => k !== "upload")) {
      expect(features![key]).toBe(true);
    }
    expect("features" in buildWorkspaceConfig(form({ disabledFeatures: [] }))).toBe(false);
  });

  it("初始态全缺省无 ui 键；treeMode='drawer' 时 ui.treeMode 存在", () => {
    expect("ui" in buildWorkspaceConfig(form())).toBe(false);

    const cfg = buildWorkspaceConfig(form({ treeMode: "drawer" }));
    expect(cfg.ui).toEqual({ treeMode: "drawer" }); // initialPath/treeTitle 空 → ui 只带 treeMode
  });
});

describe("buildWorkspaceConfig · WebDAV 分支", () => {
  it("endpoint+成对凭证+rootPath+chunkedWrite：可选键齐全", () => {
    const cfg = buildWorkspaceConfig(
      form({
        backendType: "webdav",
        endpoint: "https://dav.example.com",
        webdavUsername: "alice",
        webdavPassword: "w3bd4v",
        webdavRootPath: "/dav",
        webdavChunkedWrite: true,
        ttl: 0,
      }),
    );
    expect(cfg.backend).toEqual({
      type: "webdav",
      endpoint: "https://dav.example.com",
      username: "alice",
      password: "w3bd4v",
      rootPath: "/dav",
      chunkedWrite: true,
    });
  });

  it("rootPath 空格串 → 无 rootPath 键", () => {
    const backend = buildWorkspaceConfig(
      form({ backendType: "webdav", webdavRootPath: "   ", ttl: 0 }),
    ).backend as Record<string, unknown>;
    expect("rootPath" in backend).toBe(false);
  });

  it("半凭证纪律：只填其一时 username/password 两键都不带；都空同理", () => {
    const onlyUsername = buildWorkspaceConfig(
      form({ backendType: "webdav", webdavUsername: "alice", ttl: 0 }),
    ).backend as Record<string, unknown>;
    expect("username" in onlyUsername).toBe(false);
    expect("password" in onlyUsername).toBe(false);

    const onlyPassword = buildWorkspaceConfig(
      form({ backendType: "webdav", webdavPassword: "w3bd4v", ttl: 0 }),
    ).backend as Record<string, unknown>;
    expect("username" in onlyPassword).toBe(false);
    expect("password" in onlyPassword).toBe(false);

    const neither = buildWorkspaceConfig(form({ backendType: "webdav", ttl: 0 })).backend as Record<string, unknown>;
    expect("username" in neither).toBe(false);
    expect("password" in neither).toBe(false);
  });

  it("匿名最小形：仅 endpoint → backend 恰为 {type, endpoint}", () => {
    const cfg = buildWorkspaceConfig(
      form({ backendType: "webdav", endpoint: "https://dav.example.com", ttl: 0 }),
    );
    expect(cfg.backend).toEqual({ type: "webdav", endpoint: "https://dav.example.com" });
  });

  it("ttl>0 → ttlSeconds 透传", () => {
    const backend = buildWorkspaceConfig(form({ backendType: "webdav", ttl: 120 })).backend;
    expect((backend as { ttlSeconds?: number }).ttlSeconds).toBe(120);
  });
});

describe("validateForm", () => {
  it("endpoint 空 → endpointRequired（S3 与 WebDAV 两态）", () => {
    expect(validateForm(form({ endpoint: "" }))).toBe("demo.embed.validate.endpointRequired");
    expect(validateForm(form({ endpoint: "   " }))).toBe("demo.embed.validate.endpointRequired");
    expect(validateForm(form({ backendType: "webdav", endpoint: "" }))).toBe(
      "demo.embed.validate.endpointRequired",
    );
  });

  it("S3：bucket 空 → needEndpoint；bucket 有 → null", () => {
    expect(validateForm(form({ bucket: "" }))).toBe("demo.embed.msg.needEndpoint");
    expect(validateForm(form({ bucket: "demo-bucket" }))).toBeNull();
  });

  it("WebDAV：endpoint 须合法 http(s) URL", () => {
    const v = (endpoint: string) => validateForm(form({ backendType: "webdav", endpoint, bucket: "" }));
    expect(v("not a url")).toBe("demo.embed.validate.endpointInvalid"); // new URL 解析失败
    expect(v("ftp://x")).toBe("demo.embed.validate.endpointInvalid"); // protocol ∉ http/https
    expect(v("https://dav.example.com/home")).toBeNull();
    expect(v("http://localhost:5240/dav")).toBeNull();
  });
});

describe("maskConfigForPreview", () => {
  it("S3：凭证三键非空各打码 ***；空串键保持空串（非 ***）", () => {
    const masked = JSON.parse(maskConfigForPreview(buildWorkspaceConfig(form()))) as {
      backend: { credentials: Record<string, string> };
    };
    expect(masked.backend.credentials).toEqual({
      accessKeyId: "***",
      accessKeySecret: "***",
      sessionToken: "***",
    });

    const emptyMasked = JSON.parse(
      maskConfigForPreview(
        buildWorkspaceConfig(form({ accessKeyId: "", accessKeySecret: "", sessionToken: "" })),
      ),
    ) as { backend: { credentials: Record<string, string> } };
    expect(emptyMasked.backend.credentials).toEqual({ accessKeyId: "", accessKeySecret: "", sessionToken: "" });
  });

  it("WebDAV：password 非空打码 ***、username 明文保留；password 空 → ''", () => {
    const masked = JSON.parse(
      maskConfigForPreview(
        buildWorkspaceConfig(
          form({ backendType: "webdav", webdavUsername: "alice", webdavPassword: "w3bd4v" }),
        ),
      ),
    ) as { backend: { username?: string; password: string } };
    expect(masked.backend.password).toBe("***");
    expect(masked.backend.username).toBe("alice");

    const anonMasked = JSON.parse(
      maskConfigForPreview(buildWorkspaceConfig(form({ backendType: "webdav", ttl: 0 }))),
    ) as { backend: { password: string } };
    expect(anonMasked.backend.password).toBe("");
  });
});

describe("FEATURE_KEYS", () => {
  it("与实现导出一致（8 键）", () => {
    expect(FEATURE_KEYS).toEqual([
      "upload",
      "mkdir",
      "rename",
      "delete",
      "download",
      "multiTab",
      "openWithMenu",
      "plugins",
    ]);
  });
});
