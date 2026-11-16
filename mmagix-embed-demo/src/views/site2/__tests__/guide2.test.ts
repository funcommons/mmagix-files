// @vitest-environment jsdom
// Guide2 组件级用例（prefill 手递手契约）：仓库未装 @vue/test-utils（补装须动 package.json，
// 越出「只动测试文件与 vitest 配置」的边界），故用 vue 原生 createApp 手工挂载——
// app.use(pinia) + app.use(createI18n({legacy:false})) + app.use(ElementPlus) 全量注册。
//
// 基建注记（同 src/site2/__tests__/site2.test.ts，两套件独立自足不互相依赖）：
// - Node ≥22 实验性 webstorage 遮蔽 jsdom Storage（探针实测 globalThis/window 的 localStorage、
//   sessionStorage 均为 undefined）——须在任何 import 求值前 defineProperty 钉 Map 后端 Storage 桩，
//   否则连 element-plus 的 dark 主题工具链与后续 OEM 模块都可能在 storage 上炸。
// - jsdom 缺 ResizeObserver / matchMedia（Element Plus 弹层与 collapse 链路会探到）——防御性补桩。
// - Guide2 顶层零副作用（不引 iframe 客户端；步骤 4 交接页只写 sessionStorage 键、不 mount），
//   且 prefill 用例止步步骤 2——挂载安全。
import { describe, expect, it, beforeEach, vi } from "vitest";
import { nextTick } from "vue";

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
  if (typeof (globalThis as Record<string, unknown>).ResizeObserver === "undefined") {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

import { createApp, type App } from "vue";
import ElementPlus from "element-plus";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import Guide2 from "@/views/site2/Guide2.vue";
import zhCN from "@/locales/zh-CN";
import enUS from "@/locales/en-US";

/** 与 Guide2.vue 内 PREFILL_KEY 同值（该常量未导出，漂移由组件头注释契约与用例拦截） */
const PREFILL_KEY = "mmagic.site2.prefill";

async function mountGuide2(prefill?: unknown): Promise<{ el: HTMLElement; app: App }> {
  if (prefill !== undefined) sessionStorage.setItem(PREFILL_KEY, JSON.stringify(prefill));
  const el = document.createElement("div");
  document.body.appendChild(el);
  const app = createApp(Guide2);
  app.use(createPinia());
  app.use(
    createI18n({
      legacy: false,
      locale: "zh-CN",
      fallbackLocale: "zh-CN",
      messages: { "zh-CN": zhCN, "en-US": enUS },
    }),
  );
  app.use(ElementPlus);
  app.mount(el);
  await nextTick(); // onMounted（prefill 读取）在 post-flush 微任务里跑，须等一拍再断言
  return { el, app };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("Guide2 · prefill 手递手契约（sessionStorage['mmagic.site2.prefill']）", () => {
  it("合法 webdav 预填：跳过步骤 1 直接进步骤 2，endpoint 输入框=预填值，预填键用完即移除", async () => {
    const { el, app } = await mountGuide2({
      backendType: "webdav",
      fields: { endpoint: "http://x:1" },
    });
    try {
      // 步骤判定：步骤 1 的类型卡（.type-card）不再渲染；面板标题为「第 2 步 · 填最小必需项」
      expect(el.querySelectorAll(".type-card")).toHaveLength(0);
      expect(el.querySelector(".phead h2")?.textContent?.trim()).toBe("第 2 步 · 填最小必需项");
      // WebDAV 形态：endpoint 输入框值 = 预填值（.field.wide 首格即 endpoint）
      const endpoint = el.querySelector(".fgrid .field.wide input") as HTMLInputElement | null;
      expect(endpoint, "步骤 2 面板应有 endpoint 输入框").toBeTruthy();
      expect(endpoint!.value).toBe("http://x:1");
      // 凭证字段永不采纳：webdavUsername/password 输入框为空
      const inputs = [...el.querySelectorAll<HTMLInputElement>(".fgrid input")];
      expect(inputs.every((i) => i.value !== "alice")).toBe(true);
      // 预填键用完立即移除（解析成功也移除，避免残留重放）
      expect(sessionStorage.getItem(PREFILL_KEY)).toBeNull();
    } finally {
      app.unmount();
      el.remove();
    }
  });

  it("无预填挂载：停在步骤 1（两张类型卡在场），预填键不残留", async () => {
    const { el, app } = await mountGuide2();
    try {
      expect(el.querySelectorAll(".type-card")).toHaveLength(2);
      expect(el.querySelector(".phead h2")?.textContent?.trim()).toBe("第 1 步 · 选存储类型");
      expect(el.querySelector(".fgrid")).toBeNull(); // 步骤 2 的表单格未渲染
      expect(sessionStorage.getItem(PREFILL_KEY)).toBeNull();
    } finally {
      app.unmount();
      el.remove();
    }
  });
});
