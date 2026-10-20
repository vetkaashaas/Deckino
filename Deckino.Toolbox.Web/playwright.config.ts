import { defineConfig, devices } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { baseURL, token } from './e2e/server.ts'

// The runner sets this once; its workers inherit it (and must not wipe the data the run just seeded).
if (!process.env.E2E_DATA) {
  process.env.E2E_DATA = join(import.meta.dirname, 'e2e-results', 'data')
  rmSync(process.env.E2E_DATA, { recursive: true, force: true })
}

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-results/test-output',
  reporter: [['list'], ['html', { outputFolder: './e2e-results/report', open: 'never' }]],
  timeout: 60_000,
  use: { baseURL, viewport: { width: 1600, height: 940 }, trace: 'retain-on-failure' },
  // Edge: the engine WebView2 runs the window with, already on every Windows PC.
  projects: [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1600, height: 940 } } }],
  webServer: {
    command:
      'npm run build && dotnet build ../Deckino.Toolbox -nologo -v q && ' +
      `"../Deckino.Toolbox/bin/Debug/net10.0-windows/Deckino.Toolbox.exe" --serve --urls ${baseURL}`,
    url: `${baseURL}/`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { DECKINO_TOOLBOX_TOKEN: token, DECKINO_TOOLBOX_DATA: process.env.E2E_DATA, ASPNETCORE_ENVIRONMENT: 'Production' },
  },
})
