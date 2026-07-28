import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'wallet-reown',
              test: /node_modules\/@reown\//,
              priority: 20,
              includeDependenciesRecursively: true,
              entriesAware: true,
              minSize: 20_000,
              maxSize: 400_000,
            },
          ],
        },
      },
    },
  },
  plugins: [react()],
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
})
