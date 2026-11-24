import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@bui': fileURLToPath(new URL('./src/bui', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4319,
    proxy: {
      '/v1': 'http://127.0.0.1:4317',
      '/healthz': 'http://127.0.0.1:4317',
      '/readyz': 'http://127.0.0.1:4317',
    },
  },
})
