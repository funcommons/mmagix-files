import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      /* element-plus peer 断链补桥：pnpm 严格隔离下 element-plus@2.14.7 自身无 @vue/shared，
         rollup 从其目录解析必炸（锁文件重算遗留坑，同 xlsx-viewer 线 vitest 断链同源）——
         alias 直连本仓根级 @vue/shared（版本恒随 vue@3.5.44）。
         vitest 链路同样需要：vitest 独立配置不继承 vite.config.ts 的 alias，
         缺桥时 151 个测试文件全在收集阶段炸 Cannot find package '@vue/shared' */
      '@vue/shared': resolve(__dirname, 'node_modules/@vue/shared')
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // SDK 自测环境:注册空 i18n / pinia / Element Plus / matchMedia(见该文件)
    setupFiles: ['src/components/sdk/__tests__/setup.ts'],
    // element-plus 裸导入 @vue/shared 在 Node 原生外部解析下必炸（pnpm 严格隔离、
    // 其 package.json 不声明该 peer）；下方 resolve.alias 桥只覆盖 vite 处理面，
    // external 化模块走 Node 原生 ESM 解析、不经过 alias——inline 让 vitest 改走
    // vite transform，桥才生效（vite dev=optimizeDeps / build=rollup 天然绿的原因）
    server: {
      deps: {
        inline: ['element-plus'],
      },
    },
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