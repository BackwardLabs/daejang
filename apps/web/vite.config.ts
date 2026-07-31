import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

import {
  reportsPageEntry,
  resolveReportsUiMode,
} from './reports-ui-mode.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const reportsUiMode = resolveReportsUiMode(
    process.env.VITE_REPORTS_UI_MODE ?? env.VITE_REPORTS_UI_MODE,
  )
  const reportsEntry = fileURLToPath(
    new URL(reportsPageEntry(reportsUiMode), import.meta.url),
  )

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@reports-page': reportsEntry,
      },
    },
    server: {
      proxy: {
        '/api': {
          target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
