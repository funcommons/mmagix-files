import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // SDK 自测环境:注册空 i18n / pinia / Element Plus / matchMedia(见该文件)
    setupFiles: ['src/components/sdk/__tests__/setup.ts'],
    // **/ 前缀盖住 plugins/*/node_modules（根级 node_modules/** 匹配不到嵌套路径，vendored spec 会混进全量）
    exclude: ['e2e/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      // 覆盖率口径=src 源码（测试文件不进分子分母）
      // 只收代码扩展名（src/** 裸前缀会把 .md 文档抓进插桩 → PARSE_ERROR + 垃圾分母）
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.d.ts',
        'src/**/types.ts',
        // AppLayout.vue=已归档 scaffold 死代码（R2-01 确证 router/App 均未挂载，文件头自证
        // 「勿在此新增功能」）——移出门禁口径；日后接线时移回并补挂载测试
        'src/layout/**',
      ],
      thresholds: { lines: 80 }, // 全局行覆盖 ≥80%（质量门，防回退）
    },
  },
})