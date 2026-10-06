import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The build is served by Deckino.Api; in dev, /api is proxied to it.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../Deckino.Api/wwwroot',
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': 'http://localhost:5880' },
  },
})
