import { defineConfig, devices } from '@playwright/test'

// Runs against a local API + PostgreSQL (database deckino_e2e) unless BASE_URL points at a deployment.
// E2E_PORT moves the local API when Windows (Hyper-V) has reserved 5890: netsh int ipv4 show excludedportrange tcp.
const baseURL = process.env.BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 5890}`

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
          App__BaseUrl: baseURL, // links in account emails
          Mailgun__ApiKey: '', // never real email from tests, even with a local Mailgun user secret
          App__AndroidCertFingerprints: 'AA:BB:CC, DD:EE:FF', // assetlinks.json (foundation.spec.ts)
          ConnectionStrings__Deckino:
            'Host=localhost;Port=55432;Database=deckino_e2e;Username=deckino;Password=deckino',
          // A few hundred real printings, imported through the same sync code as the full Scryfall file.
          Catalogue__BulkFile: `${import.meta.dirname}/e2e/fixtures/cards.jsonl.gz`,
        },
      },
})
