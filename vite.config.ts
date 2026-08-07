import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'web/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/openai': 'http://127.0.0.1:3000',
      '/anthropic': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'web/dist',
    emptyOutDir: true,
  },
})