import { expect, test } from '@playwright/test'
import { milestone } from './screenshot'

test('health endpoint reports the API and database as healthy', async ({ request }) => {
  const response = await request.get('/api/health')
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ status: 'Healthy', checks: { database: 'Healthy' } })
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
