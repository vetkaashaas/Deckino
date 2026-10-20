import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The build is served by Deckino.Toolbox from its wwwroot; in dev (F5 in Visual Studio) the window shows this dev
// server and /api goes to the Toolbox's own server.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../Deckino.Toolbox/wwwroot',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1024, // read from disk by the window, not downloaded
  },
  server: {
    port: 5875, // outside Windows' Hyper-V reserved ranges (see AGENTS.md)
    strictPort: true,
    // The Toolbox says where its server is when it starts Vite (DevServer.cs); started by hand, its dev port.
    proxy: { '/api': process.env.DECKINO_TOOLBOX_API ?? 'http://localhost:5885' },
  },
})
