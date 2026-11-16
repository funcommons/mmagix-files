import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // site2 路由冒烟的 push 会真实 import .vue 懒加载组件（组件级用例也要挂载 .vue）——
  // vitest.config.ts 存在时整体取代 vite.config.ts（插件同样不继承），vue 插件须在此显式镜像
  plugins: [vue()],
  // vitest.config.ts 存在时整体取代 vite.config.ts（alias 不继承），须镜像三条件：
  // `/vue` 必须排在裸名前（rollup alias 语义是前缀匹配，顺序即优先级）
  resolve: {
    alias: [
      {
        // 宿主客户端包（源码直连——发布形态为 npm install @mmagix/files-client）
        find: '@mmagix/files-client/vue',
        replacement: fileURLToPath(new URL('../frontend/packages/files-client/src/vue.ts', import.meta.url)),
      },
      {
        find: '@mmagix/files-client',
        replacement: fileURLToPath(new URL('../frontend/packages/files-client/src/index.ts', import.meta.url)),
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
  },
  test: {
    // demo 侧测试以纯逻辑（utils/composables）为主，默认 node 环境；
    // 需要 DOM 的用例在文件头加 // @vitest-environment jsdom
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // 当前尚无用例（基建先行，测试后续接入），空跑不报错
    passWithNoTests: true,
  },
})
