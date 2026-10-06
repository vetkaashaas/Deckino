import { defineConfig, devices } from '@playwright/test'

// Runs against a local API + PostgreSQL (database deckino_e2e) unless BASE_URL points at a deployment.
const baseURL = process.env.BASE_URL ?? 'http://localhost:5890'

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-results/test-output',
  reporter: [['list'], ['html', { outputFolder: './e2e-results/report', open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'npm run build && dotnet run --project ../Deckino.Api --no-launch-profile',
        url: `${baseURL}/api/health`,
        timeout: 180_000,
        reuseExistingServer: false,
        env: {
          ASPNETCORE_ENVIRONMENT: 'Development',
          ASPNETCORE_URLS: baseURL,
          ConnectionStrings__Deckino:
            'Host=localhost;Port=55432;Database=deckino_e2e;Username=deckino;Password=deckino',
        },
      },
})
