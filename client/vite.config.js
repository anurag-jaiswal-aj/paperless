import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const targetPort = process.env.BACKEND_PORT || process.env.VITE_BACKEND_PORT || 5001

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': `http://localhost:${targetPort}`
    }
  }
})
