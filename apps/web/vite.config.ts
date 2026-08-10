import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // C12 — keep the first paint lean: heavyweights load on demand or
        // as parallel vendor chunks instead of one monolith
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
          motion: ['gsap'],
          ui: ['@radix-ui/react-dialog', '@radix-ui/react-popover', '@radix-ui/react-tooltip', 'cmdk', 'sonner', 'vaul', 'lucide-react'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
      '/preview': { target: 'http://localhost:3001', changeOrigin: false },
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
})
