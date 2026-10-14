import { expect, test } from '@playwright/test'
import { local } from './accounts'
import { milestone } from './screenshot'

test('health endpoint reports the API, database and catalogue sync as healthy', async ({ request }) => {
  const response = await request.get('/api/health')
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ status: 'Healthy', checks: { database: 'Healthy', catalogue: 'Healthy' } })
})

test('the mobile app learns the minimum app version it must have', async ({ request }) => {
  const response = await request.get('/api/app/config', { headers: { 'X-Deckino-App-Version': '0.1.0' } })
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ minimumVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) })
})

test('Android App Links: assetlinks.json names the app packages and their signing keys', async ({ request }) => {
  const response = await request.get('/.well-known/assetlinks.json')
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/json')
  const target = (name: string) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: name,
      // The local API's test fingerprints; a deployment has its real SHA-256 ones.
      sha256_cert_fingerprints: local
        ? ['AA:BB:CC', 'DD:EE:FF']
        : expect.arrayContaining([expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)]),
    },
  })
  expect(await response.json()).toEqual([target('com.deckino.app'), target('com.deckino.app.preview')])
})

test('unknown API routes return 404 ProblemDetails', async ({ request }) => {
  const response = await request.get('/api/does-not-exist')
  expect(response.status()).toBe(404)
  expect(response.headers()['content-type']).toContain('application/problem+json')
})

test('visitor sees the application shell', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Deckino' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(page.getByText('Deckino is unofficial Fan Content')).toBeVisible()
  await expect(page.getByTestId('api-status')).toHaveText('API: Healthy')
  await milestone(page, testInfo, '01-application-shell')
})

test('deep links fall back to the SPA', async ({ page }) => {
  const response = await page.goto('/some/deep/link')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('img', { name: 'Deckino' })).toBeVisible()
})
