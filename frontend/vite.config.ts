import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_TARGET = process.env.API_TARGET ?? 'http://localhost:8000'
const DEV_PUBLIC_HOST = process.env.DEV_PUBLIC_HOST

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['olf-transfer.bxota.test'],
    hmr: DEV_PUBLIC_HOST
      ? { host: DEV_PUBLIC_HOST, protocol: 'wss', clientPort: 443 }
      : { clientPort: 5173 },
    watch: { usePolling: true },
    proxy: {
      '/auth': { target: API_TARGET, changeOrigin: true },
      '/transfers': { target: API_TARGET, changeOrigin: true },
      '/uploads': { target: API_TARGET, changeOrigin: true },
      '/admin/': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      '/requests': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
})
