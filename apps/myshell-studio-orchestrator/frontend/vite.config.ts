import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Inlined at build time — exposes the miniapp build version to tracking.ts
// so every event payload carries `app_version`. `npm_package_version` is
// populated by npm whenever a script runs through `npm run ...`.
const APP_VERSION = process.env.npm_package_version || '0.0.0'
const ORCHESTRATOR_PROXY_TARGET =
  process.env.VITE_DREAMY_ORCHESTRATOR_PROXY_TARGET ||
  process.env.STUDIO_ORCHESTRATOR_PROXY_TARGET ||
  'http://127.0.0.1:8090'
const AI_CANVASPRO_DIRECT_PROXY_TARGET =
  process.env.VITE_AI_CANVASPRO_PROXY_TARGET ||
  ''
const AI_CANVASPRO_PROXY_TARGET = AI_CANVASPRO_DIRECT_PROXY_TARGET || ORCHESTRATOR_PROXY_TARGET
const AI_CANVASPRO_PROXY_DIRECT = Boolean(AI_CANVASPRO_DIRECT_PROXY_TARGET)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router/') ||
            id.includes('/react-router-dom/') ||
            id.includes('/@remix-run/router/') ||
            id.includes('/scheduler/') ||
            id.includes('/@telegram-apps/sdk-react/')
          ) {
            return 'react-vendor'
          }
          if (id.includes('/i18next/') || id.includes('/react-i18next/') || id.includes('/i18next-browser-languagedetector/')) {
            return 'i18n-vendor'
          }
          if (id.includes('/lucide-react/')) {
            return 'icons-vendor'
          }
          return 'vendor'
        },
      },
    },
  },
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../..', import.meta.url)),
      ],
    },
    proxy: {
      '/api': {
        target: ORCHESTRATOR_PROXY_TARGET,
        changeOrigin: true,
      },
      '/ai-canvaspro-api': {
        target: AI_CANVASPRO_PROXY_TARGET,
        changeOrigin: true,
        ...(AI_CANVASPRO_PROXY_DIRECT
          ? { rewrite: (path) => path.replace(/^\/ai-canvaspro-api/, '') }
          : {}),
      },
    },
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
})
