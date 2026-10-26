import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      {
        // 宿主客户端包（源码直连——发布形态为 npm install @mmagix/files-client）
        // /vue 必须先于裸名（rollup alias 语义是前缀匹配，顺序即优先级）
        find: "@mmagix/files-client/vue",
        replacement: fileURLToPath(new URL("../frontend/packages/files-client/src/vue.ts", import.meta.url)),
      },
      {
        find: "@mmagix/files-client",
        replacement: fileURLToPath(new URL("../frontend/packages/files-client/src/index.ts", import.meta.url)),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  server: {
    // 固定 5200：demo 是宿主页，mmagix-files（frontend/，vite 默认 9330）联调时
    // 用 `pnpm exec vite --port 5199 --strictPort` 起在 5199（与本仓 playwright e2e 同端口口径）。
    // 宿主 5200 ≠ iframe 5199 是刻意的跨源形态——逼出 origin 白名单这条真实约束。
    port: 5200,
    strictPort: true,
  },
});
