// @vitest-environment jsdom
// site2 路由冒烟 + site2 段 locale parity（en-US.ts 头注释口径：键集与 zh-CN 一一对应）。
//
// 基建注记（vi.hoisted 先于静态 import 求值）：
// - Node ≥22 实验性 webstorage 遮蔽 jsdom Storage——本组合（Node 26 + vitest 4 + jsdom 29）探针实测
//   globalThis.localStorage 与 window.localStorage 均为 undefined（诊断：Node 把同名访问器属性钉在
//   globalThis 上，未给 --localstorage-file 时求值为 undefined）。而 @/locales/index.ts 顶层读
//   localStorage.getItem，故必须在任何 import 求值前用 defineProperty 钉上 Map 后端的最小 Storage 桩
//   （备选 NODE_OPTIONS=--localstorage-file 会外溢到运行环境，不宜进测试文件）。
// - import router from '@/router' 会连带求值 @/locales（createI18n 读 storage）与 createWebHistory
//   （读 window.location——jsdom 已提供）；不做 app.install、不等 router.isReady()（无 app 时永等），
//   路由匹配用 resolve、重定向用 push + currentRoute 验证真实导航结果。
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  function makeStorage(): Storage {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
    };
  }
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: makeStorage() });
  }
});

import router from "@/router";
import zhCN from "@/locales/zh-CN";
import enUS from "@/locales/en-US";

/** 递归拍平：叶子（非 null 对象/数组）进 Map，键为点分全路径 */
function flatten(prefix: string, node: unknown, out: Map<string, string>): void {
  if (typeof node !== "object" || node === null) {
    out.set(prefix, String(node));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    flatten(prefix ? `${prefix}.${k}` : k, v, out);
  }
}

describe("locale parity · site2 段（zh-CN ↔ en-US 双向 0 缺）", () => {
  const zh = new Map<string, string>();
  const en = new Map<string, string>();
  flatten("site2", (zhCN as Record<string, unknown>).site2, zh);
  flatten("site2", (enUS as Record<string, unknown>).site2, en);

  it("两词典都有 site2 段且非空", () => {
    expect(zh.size).toBeGreaterThan(0);
    expect(en.size).toBeGreaterThan(0);
  });

  it("zh 有而 en 无的键 = 0（en 缺键只会回落 zh， parity 口径要求 0 缺）", () => {
    const missingInEn = [...zh.keys()].filter((k) => !en.has(k));
    expect(missingInEn).toEqual([]);
  });

  it("en 有而 zh 无的键 = 0（en 漂移出幽灵键同属失 parity）", () => {
    const missingInZh = [...en.keys()].filter((k) => !zh.has(k));
    expect(missingInZh).toEqual([]);
  });

  it("双向叶子均非空串（空翻译比缺键更隐蔽，一并拦）", () => {
    for (const [k, v] of [...zh, ...en]) {
      expect(v.trim(), `空翻译: ${k}`).not.toBe("");
    }
  });

  it("抽查锚点键（nav/diag/triage 各取一，钉住段形状不被整体误删）", () => {
    for (const key of ["site2.nav.home", "site2.guide.diag.msgNetwork", "site2.guide.triage.address"]) {
      expect(zh.has(key), `zh 缺锚点 ${key}`).toBe(true);
      expect(en.has(key), `en 缺锚点 ${key}`).toBe(true);
    }
  });
});

describe("路由冒烟 · import router from '@/router'（不 install app、不等 isReady）", () => {
  it("resolve：11 条静态路径命中预期命名组件（含 /docs 可选参数两个形态）", () => {
    const cases: [string, string][] = [
      ["/", "Home2"],
      ["/guide", "Guide2"],
      ["/sources", "Sources2"],
      ["/docs/readme", "Docs2"],
      ["/docs", "Docs2"],
      ["/workspace", "Workspace2"],
      ["/singlefile", "Singlefile2"],
      ["/legacy", "LegacyHome"],
      ["/legacy/docs/readme", "LegacyDocs"],
      ["/play/workspace", "EmbedPlay"],
      ["/play/overview", "Overview"],
      ["/play/file", "FilePlay"],
    ];
    for (const [path, name] of cases) {
      expect(router.resolve(path).name, `resolve(${path})`).toBe(name);
    }
  });

  it("resolve：/workspace、/singlefile 挂 SiteNav2 壳（matched 两层）并复用原 demo 页组件（懒加载同一文件，非复制）", async () => {
    type LazyComp = () => Promise<{ default: unknown }>;
    const load = async (c: unknown) => await (c as LazyComp)();

    const ws = router.resolve("/workspace");
    expect(ws.matched).toHaveLength(2); // [壳 /, 页 workspace]
    expect(ws.meta.embed).toBe(true); // SiteNav2 布局判全高的标记
    const [wsShell, wsPage] = await Promise.all([load(ws.matched[0].components.default), load(ws.matched[1].components.default)]);
    expect(wsShell.default).toBe((await import("@/layout/SiteNav2.vue")).default);
    expect(wsPage.default).toBe((await import("@/views/embed/EmbedPlay.vue")).default);

    const sf = router.resolve("/singlefile");
    expect(sf.matched).toHaveLength(2);
    expect(sf.meta.embed).toBe(true);
    const sfPage = await load(sf.matched[1].components.default);
    expect(sfPage.default).toBe((await import("@/views/embed/FilePlay.vue")).default);
  });

  it("push 导航：/workspace → Workspace2（SiteNav2 壳，meta.embed 落到 currentRoute 供布局消费）", async () => {
    await router.push("/workspace");
    expect(router.currentRoute.value.path).toBe("/workspace");
    expect(router.currentRoute.value.name).toBe("Workspace2");
    expect(router.currentRoute.value.meta.embed).toBe(true);
  });

  it("push 导航：/singlefile → Singlefile2（SiteNav2 壳，meta.embed）", async () => {
    await router.push("/singlefile");
    expect(router.currentRoute.value.path).toBe("/singlefile");
    expect(router.currentRoute.value.name).toBe("Singlefile2");
    expect(router.currentRoute.value.meta.embed).toBe(true);
  });

  it("push 导航：/home → /（旧首页路径兼容，落地 Home2）", async () => {
    await router.push("/home");
    expect(router.currentRoute.value.path).toBe("/");
    expect(router.currentRoute.value.name).toBe("Home2");
  });

  it("push 导航：/overview → /play/overview（旧 demo 深链兼容）", async () => {
    await router.push("/overview");
    expect(router.currentRoute.value.path).toBe("/play/overview");
    expect(router.currentRoute.value.name).toBe("Overview");
  });

  it("push 导航：/embed/play → /play/workspace（name EmbedPlay）", async () => {
    await router.push("/embed/play");
    expect(router.currentRoute.value.path).toBe("/play/workspace");
    expect(router.currentRoute.value.name).toBe("EmbedPlay");
  });

  it("push 导航：/embed/file → /play/file（name FilePlay）", async () => {
    await router.push("/embed/file");
    expect(router.currentRoute.value.path).toBe("/play/file");
    expect(router.currentRoute.value.name).toBe("FilePlay");
  });

  it("push 导航：catch-all /nope → /（未知 URL 回新站首页，不渲染空白）", async () => {
    await router.push("/nope");
    expect(router.currentRoute.value.path).toBe("/");
    expect(router.currentRoute.value.name).toBe("Home2");
  });

  it("afterEach 契约：document.title = i18n(meta.title) + ' · mmagix-files'（词典缺省 zh-CN）", async () => {
    await router.push("/guide");
    expect(document.title).toBe("演示 · mmagix-files");
  });
});
