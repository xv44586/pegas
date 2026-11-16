import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react()],
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
