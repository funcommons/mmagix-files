import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import pkg from './package.json'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'pinia', 'vue-i18n'],
      dts: 'auto-imports.d.ts',
      eslintrc: { enabled: false },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || '0.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      /* element-plus peer 断链补桥：pnpm 严格隔离下 element-plus@2.14.7 自身无 @vue/shared，
         rollup 从其目录解析必炸（锁文件重算遗留坑，同 xlsx-viewer 线 vitest 断链同源）——
         alias 直连本仓根级 @vue/shared（版本恒随 vue@3.5.44） */
      '@vue/shared': resolve(__dirname, 'node_modules/@vue/shared')
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/styles/variables.scss" as *;`
      }
    }
  },
  server: {
    port: 9330,
    open: true,
    // 纯前端 0 后端架构 (S3 直连), 默认无代理;
    // iframe 嵌入/OEM 多租户联调时允许生产域名 Host 头穿透
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.lhs11.com'
    ]
  },
  build: {
    // 拆分大依赖到独立 chunk, 避免 500kB 警告
    rollupOptions: {
      output: {
        manualChunks: {
          // Vue 运行时 + 路由 + 状态管理
          'vue-vendor': ['vue', 'vue-router', 'pinia', 'vue-i18n'],
          // UI 库
          'element-plus': ['element-plus', '@element-plus/icons-vue'],
          // R2-06: monaco(≈4MB, 仅代码渲染器 import() 拉起) 单列命名。
          // 此前该 chunk 默认命名为 index-*.js, 与真入口同名同前缀, 构建日志里被
          // 误读成「主包 4.07MB」; 命名后日志自证其是懒加载 monaco, 不再混淆。
          'monaco-editor': ['monaco-editor'],
        },
      },
    },
    // 单 chunk 报警阈值 (kB); element-plus 完整包约 1MB, 业务依赖都在此阈值之下
    chunkSizeWarningLimit: 1100,
  }
  // ── R2-06 首载体积口径（实测 sourcemap 逐模块归因, 2026-10-10）──────────────
  // 真入口 = index.html 加载的 index-*.js ≈293kB(全业务码+markdown-it/viewerjs/papaparse)
  //   首载 JS ≈ 入口 293 + vue-vendor 174 + element-plus 1071 ≈ 1.54MB(gzip≈0.5MB)
  //   → 达标「主入口 <2000kB」。>1100kB 警告的 monaco/heic2any/elk 均为按需懒加载
  //   单体库（sourcemap 证明 monaco chunk 100% 是 monaco-editor）, 不在首载路径上,
  //   硬拆只会把一个特性切成多个仍同批下载的碎片——保留警告作为懒 chunk 观察位。
  // 已确认不入主包的动态重依赖: monaco/mermaid/katex/cytoscape(elk)/xlsx/pdfjs/
  //   docx-preview/heic2any（各自独立 chunk, 见 dist/assets 清单）。

})
