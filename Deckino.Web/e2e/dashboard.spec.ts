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

// Default printings worth over $3 in the fixture, each a little cheaper 8 days ago (still above the movers' $2 floor
// on both days), so the market has more risers than Home shows at once. The fixture only has today's prices; the
// development endpoint writes the past.
const risers = [
  'Artificer Class',
  "An Offer You Can't Refuse",
  "Blue Sun's Zenith",
  'Boundless Realms',
  'Braids, Arisen Nightmare',
  'Case of the Locked Hothouse',
]
async function risingCards(request: APIRequestContext) {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  for (const [i, name] of risers.entries()) {
    const detail = await (await request.get(`/api/cards/${(await findCard(request, name)).id}`)).json()
    const then = detail.prices.usd * (0.9 - i * 0.04) // a different rise for each
    expect(then).toBeGreaterThanOrEqual(2)
    expect((await request.post(`/api/dev/prices/${detail.id}`, { data: [{ date: daysAgo(8), usd: then }] })).status()).toBe(204)
  }
}

test('a signed-in user lands on Home: their collection value and the market movers, or the first cards to add', async ({ page }, testInfo) => {
  test.skip(!local, 'creates accounts')
  const user = await signedIn(page) // logging in lands on Home
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: `Hi, ${user.username}` })).toBeVisible()
  // No cards yet: adding the first ones is the one thing to do.
  const first = page.getByRole('region', { name: 'Add your first cards' })
  await expect(first).toBeVisible()
  await milestone(page, testInfo, '79-home-first-cards')
  await first.getByRole('link', { name: 'Add cards' }).click()
  await expect(page).toHaveURL(/\/collection$/)

  const { binder } = await fillAccount(page.request)
  await risingCards(page.request)
  // Some of the risers are in the binder too: the user's own movers.
  for (const [name, copies] of [['Braids, Arisen Nightmare', 1], ['Boundless Realms', 3], ['Case of the Locked Hothouse', 1]] as const) {
    const card = await findCard(page.request, name)
    await page.request.post(`/api/binders/${binder}/cards`, { data: { card: { scryfallId: card.id, finish: 'nonfoil', condition: 'NM', language: 'en' }, copies } })
  }
  await page.goto('/')
  await expect(first).toBeHidden()
  const value = page.getByRole('region', { name: 'Collection value' })
  await expect(value.getByTestId('collection-value')).toBeVisible()
  // Under it, the user's three cards that rose most this week (Atraxa first: +$60), and a way to all.
  const yours = value.getByRole('list', { name: 'Your biggest movers' })
  await expect(yours.getByRole('listitem')).toHaveCount(3)
  await expect(yours.getByRole('listitem').first()).toHaveAccessibleName("Atraxa, Praetors' Voice")
  await expect(value.getByRole('link', { name: 'See all' })).toHaveAttribute('href', '/collection/prices')
  // The market's movers this week, Rising or Falling.
  const movers = page.getByRole('region', { name: 'Market movers this week' })
  const rising = movers.getByRole('list', { name: 'Rising cards' })
  await expect(rising.getByRole('listitem')).not.toHaveCount(0)
  // A few show and the rest scroll in the movers' own box, so Home stays one screen tall.
  expect(await rising.evaluate((list) => list.parentElement!.scrollHeight > list.parentElement!.clientHeight)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(page.viewportSize()!.height + 200)
  await milestone(page, testInfo, '80-dashboard')
  await movers.getByRole('radiogroup', { name: 'Market movers' }).getByText('Falling').click()
  await expect(movers.getByRole('list', { name: 'Rising cards' })).toBeHidden() // Falling's own list, or "nothing fell"
  // The user's own movers turn the same way, on their own: none of theirs fell.
  await value.getByRole('radiogroup', { name: 'Your movers' }).getByText('Falling').click()
  await expect(value.getByText('None of your cards fell this week.')).toBeVisible()
  await expect(movers.getByRole('radiogroup', { name: 'Market movers' }).getByRole('radio', { name: 'Falling' })).toBeChecked()

  // The value opens Collection; the decks, binders and wishlist live there and on Decks, not on Home.
  await expect(page.getByRole('heading', { name: 'Your decks' })).toHaveCount(0)
  await value.getByRole('link', { name: 'Collection value · 7 cards' }).click()
  await expect(page).toHaveURL(/\/collection$/)
})

test('Decks covers your decks and browsing; unknown pages say so', async ({ page }) => {
  test.skip(!local, 'creates accounts')
  await signedIn(page)
  const decks = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Decks', exact: true })
  await decks.click()
  const tabs = page.getByRole('navigation', { name: 'Decks' })
  await tabs.getByRole('link', { name: 'Public' }).click()
  await expect(page).toHaveURL(/\/browse$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Decks' })).toBeVisible()
  await expect(tabs.getByRole('link', { name: 'Public' })).toHaveClass(/active/)
  await expect(decks).toHaveClass(/active/)
  await tabs.getByRole('link', { name: 'Yours' }).click()
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
      '/collection',
      '/collection/prices',
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
    await expect(page.getByRole('region', { name: 'Market movers this week' })).toBeVisible()
    await milestone(page, testInfo, '81-phone-dashboard')

    await page.context().clearCookies()
    await checkPages(page, ['/', '/login', '/register', '/forgot-password', '/browse', `/binder/${binder}`], async () => {
      await expect(page.getByRole('heading').first()).toBeVisible()
    })
  })
})
