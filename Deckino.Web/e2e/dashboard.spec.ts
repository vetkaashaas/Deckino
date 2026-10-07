import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { local, test } from './accounts'
import { expectNoSidewaysScroll, findCard, signedIn } from './pages'
import { milestone } from './screenshot'

test.beforeAll(async ({ playwright }, testInfo) => {
  if (!local) return
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

// A deck (public), a binder with cards (public) and a wishlist entry. Returns their ids.
async function fillAccount(request: APIRequestContext) {
  const bolt = await findCard(request, 'Lightning Bolt')
  const atraxa = await findCard(request, "Atraxa, Praetors' Voice")
  const deck = (await (await request.post('/api/decks', {
    data: { name: 'Atraxa Superfriends', format: 'commander', cards: { commander: [{ scryfallId: atraxa.id, quantity: 1, finish: atraxa.finish }] } },
  })).json()).id
  await request.put(`/api/decks/${deck}/visibility`, { data: { isPublic: true } })
  const binder = (await (await request.post('/api/binders', { data: { name: 'Trade binder', isPublic: true } })).json()).id
  await request.post(`/api/binders/${binder}/cards`, {
    data: { card: { scryfallId: atraxa.id, finish: atraxa.finish, condition: 'NM', language: 'en', notes: 'Signed' }, copies: 2 },
  })
  await request.post('/api/wishlist', { data: { scryfallId: bolt.id, quantity: 4 } })
  return { deck, binder, bolt }
}

test('a signed-in user lands on a dashboard of their decks, binders, wishlist and collection', async ({ page }, testInfo) => {
  test.skip(!local, 'creates accounts')
  const user = await signedIn(page) // logging in lands on the dashboard
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 2, name: 'Your decks' })).toBeVisible()
  await expect(page.getByText(/^No decks yet/)).toBeVisible()
  await expect(page.getByText(/^No binders yet/)).toBeVisible()
  await expect(page.getByTestId('dashboard-wishlist')).toHaveText(/^Nothing on your wishlist/)

  await fillAccount(page.request)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: `Welcome back, ${user.username}` })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Collection value' }).getByTestId('collection-value')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Recent decks' }).getByRole('link', { name: /Atraxa Superfriends/ })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Recent binders' }).getByRole('link', { name: /Trade binder/ })).toContainText('2 cards')
  await expect(page.getByTestId('dashboard-wishlist')).toHaveText(/^4 cards wanted · ≈ /)
  await milestone(page, testInfo, '80-dashboard')

  // Every section links on.
  await page.getByRole('link', { name: 'Your binders' }).click()
  await expect(page).toHaveURL(/\/binders$/)
  await page.goto('/')
  await page.getByRole('list', { name: 'Recent decks' }).getByRole('link').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Atraxa Superfriends' })).toBeVisible()
})

test('Decks covers your decks and browsing; unknown pages say so', async ({ page }) => {
  test.skip(!local, 'creates accounts')
  await signedIn(page)
  const decks = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Decks', exact: true })
  await decks.click()
  await page.getByRole('radiogroup', { name: 'Decks' }).getByText('Browse public decks').click()
  await expect(page).toHaveURL(/\/browse$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Browse decks' })).toBeVisible()
  await expect(decks).toHaveClass(/active/)
  await page.getByRole('radiogroup', { name: 'Decks' }).getByText('Your decks').click()
  await expect(page).toHaveURL(/\/decks$/)

  await page.goto('/no/such/page')
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  async function checkPages(page: Page, paths: string[], ready: (path: string) => Promise<void>) {
    for (const path of paths) {
      await page.goto(path)
      await ready(path)
      await expect.soft(async () => expectNoSidewaysScroll(page), path).toPass({ timeout: 2_000 })
    }
  }

  test('every page fits the screen', async ({ page }, testInfo) => {
    test.skip(!local, 'creates accounts')
    await signedIn(page)
    const { deck, binder, bolt } = await fillAccount(page.request)
    const signedInPages = [
      '/',
      '/decks',
      `/decks/${deck}`,
      '/decks/import',
      `/deck/${deck}`,
      '/browse',
      '/binders',
      `/binders/${binder}`,
      '/binders/import',
      `/binder/${binder}`,
      '/wishlist',
      '/cards',
      `/cards/${bolt.id}`,
      '/account',
      '/no/such/page',
    ]
    await checkPages(page, signedInPages, async () => {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    })
    await page.goto('/')
    await expect(page.getByRole('list', { name: 'Recent decks' })).toBeVisible()
    await milestone(page, testInfo, '81-phone-dashboard')

    await page.context().clearCookies()
    await checkPages(page, ['/', '/login', '/register', '/forgot-password', '/browse', `/binder/${binder}`], async () => {
      await expect(page.getByRole('heading').first()).toBeVisible()
    })
  })
})
