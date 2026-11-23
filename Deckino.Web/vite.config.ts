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
    port: 5870, // Vite's default 5173 is inside Windows' Hyper-V reserved range (see AGENTS.md)
    strictPort: true,
    // /signin-google: Google's callback to the API (ExternalLogins.cs). Apple can't call back to localhost.
    proxy: { '/api': 'http://localhost:5880', '/signin-google': 'http://localhost:5880' },
  },
})
