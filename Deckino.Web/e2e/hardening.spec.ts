import { expect, type Page } from '@playwright/test'
import { local, logIn, newUser, registerVerified, test } from './accounts'
import { milestone } from './screenshot'

// Phase 15: the production hardening that sits around every endpoint and page.

// Records Content-Security-Policy violations, so a page that loads something the policy blocks fails the test.
async function watchPolicy(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = ((window as unknown as { cspViolations: string[] }).cspViolations = [])
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)

test('pages and API responses carry the security headers', async ({ request }) => {
  const page = await request.get('/cards')
  expect(page.headers()['content-security-policy']).toContain("script-src 'self'")
  expect(page.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  for (const response of [page, await request.get('/api/health')]) {
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['x-frame-options']).toBe('DENY')
    expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
  }
})

test('the site works under its content security policy, signed out and signed in', async ({ page, request }, testInfo) => {
  test.skip(!local, 'creates an account')
  await watchPolicy(page) // the record starts again with each page load, so each page is checked before the next
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await violations(page), '/').toEqual([])
  await page.goto('/cards')
  await page.getByLabel('Card name').fill('lightning bolt')
  await page.getByLabel('Card name').press('Enter')
  await page.getByRole('list', { name: 'Search results' }).getByRole('link').first().click()
  await expect(page.getByRole('img').first()).toBeVisible()
  expect(await violations(page), 'card search and card page').toEqual([])
  await page.goto('/browse')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await violations(page), '/browse').toEqual([])

  const user = newUser()
  await registerVerified(request, user)
  await logIn(page, user.email, user.password)
  await expect(page).toHaveURL(/\/$/)
  for (const path of ['/decks', '/binders', '/wishlist', '/account']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(await violations(page), path).toEqual([])
  }
  await milestone(page, testInfo, '96-hardening-account-under-csp')
})

test('changes from another site are refused, same-site ones and apps are not', async ({ request }) => {
  const crossSite = await request.post('/api/account/logout', { headers: { 'Sec-Fetch-Site': 'cross-site' } })
  expect(crossSite.status()).toBe(403)
  const otherOrigin = await request.post('/api/account/logout', { headers: { Origin: 'https://evil.example' } })
  expect(otherOrigin.status()).toBe(403)
  expect((await request.post('/api/account/logout', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status()).toBe(204)
  expect((await request.post('/api/account/logout')).status()).toBe(204) // no browser headers: the mobile app, curl
  // Reading is never refused, so shared links and previews keep working.
  expect((await request.get('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status()).toBe(200)
})

test('oversized requests are refused before they are read', async ({ request }) => {
  // Kestrel answers 413 as soon as it sees the size and closes the connection, which can reach the client while
  // it is still sending: a reset is the same refusal.
  const outcome = await request
    .post('/api/account/login', { data: { email: 'a@example.com', password: 'x'.repeat(5_000_000) } })
    .then(
      (response) => response.status(),
      (error: Error) => (/ECONNRESET|EPIPE/.test(error.message) ? 'connection reset' : Promise.reject(error)),
    )
  expect([413, 'connection reset']).toContain(outcome)
})

test('one client gets at most 600 API calls a minute', async ({ request }) => {
  const client = { 'X-Real-IP': `10.251.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254) + 1}` }
  const statuses: number[] = []
  for (let batch = 0; batch < 601; batch += 50) {
    const sent = Array.from({ length: Math.min(50, 601 - batch) }, () => request.get('/api/sets', { headers: client }))
    statuses.push(...(await Promise.all(sent)).map((r) => r.status()))
  }
  expect(statuses.filter((s) => s === 200)).toHaveLength(600)
  expect(statuses.filter((s) => s === 429)).toHaveLength(1)
})

test('a server error answers with a reference for the logs and no details', async ({ request }) => {
  test.skip(!local, 'needs the development failure endpoint')
  const response = await request.get('/api/dev/throw')
  expect(response.status()).toBe(500)
  expect(response.headers()['content-type']).toContain('application/problem+json')
  const body = await response.text()
  expect(JSON.parse(body).traceId).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
  expect(body).not.toContain('secret detail')
  expect(body).not.toContain('InvalidOperationException')
})

test('the www address redirects to the main one, keeping the path', async ({ request, baseURL }) => {
  test.skip(!local, 'the local site stands in for www')
  const site = new URL(baseURL!)
  const response = await request.get('/cards?q=bolt', { headers: { Host: `www.${site.host}` }, maxRedirects: 0 })
  expect(response.status()).toBe(308)
  expect(response.headers()['location']).toBe(`${site.origin}/cards?q=bolt`)
})
