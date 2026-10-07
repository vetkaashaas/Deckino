import { expect, type APIRequestContext } from '@playwright/test'
import { local, test } from './accounts'
import { findCard, signedIn } from './pages'
import { milestone } from './screenshot'

// Price history needs the development endpoint that writes past days (the fixture only has today's prices).
test.skip(!local, 'writes price history')

test.beforeAll(async ({ playwright }, testInfo) => {
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true) // also writes today's snapshot
  await api.dispose()
})

const usd = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

async function cardPrices(request: APIRequestContext, name: string) {
  const card = await findCard(request, name)
  const detail = await (await request.get(`/api/cards/${card.id}`)).json()
  return { ...card, prices: detail.prices as { usd: number | null; usdFoil: number | null } }
}

async function writeHistory(request: APIRequestContext, scryfallId: string, points: object[]) {
  expect((await request.post(`/api/dev/prices/${scryfallId}`, { data: points })).status()).toBe(204)
}

test('a card shows its 90-day price chart and how its price moved', async ({ page }, testInfo) => {
  const fireIce = await cardPrices(page.request, 'Fire // Ice')
  const now = fireIce.prices.usd!
  expect(now).toBeGreaterThan(0)
  // Half today's price 30 days ago, a quarter 7 days ago, today's price yesterday.
  await writeHistory(page.request, fireIce.id, [
    { date: daysAgo(30), usd: now / 2 },
    { date: daysAgo(7), usd: now / 4 },
    { date: daysAgo(1), usd: now },
  ])
  const history = await (await page.request.get(`/api/cards/${fireIce.id}/prices`)).json()
  expect(history.map((p: { date: string }) => p.date)).toEqual([daysAgo(30), daysAgo(7), daysAgo(1), daysAgo(0)])

  await page.goto(`/cards/${fireIce.id}`)
  const section = page.getByRole('region', { name: 'Price history' })
  await expect(section.getByTestId('move-30d')).toContainText(`+${usd(now / 2)} (+100.0%)`)
  await expect(section.getByTestId('move-7d')).toContainText(`+${usd((now * 3) / 4)} (+300.0%)`)
  await expect(section.getByTestId('move-24h')).toContainText('±$0.00 (±0.0%)')
  const chart = section.getByRole('img', { name: /Normal price in USD/ })
  await expect(chart).toBeVisible()

  // Hovering finds the nearest day; the same values are in the table view.
  await chart.hover({ position: { x: 70, y: 100 } })
  await expect(section.getByRole('status')).toContainText(usd(now / 2))
  await milestone(page, testInfo, '60-price-chart')
  await page.mouse.move(0, 0)
  await section.getByText('Show as table').click()
  await expect(section.getByRole('row')).toHaveCount(5) // header + 4 days

  await page.getByRole('radiogroup', { name: 'Currency' }).getByText('EUR').click()
  await expect(section.getByRole('img', { name: /in EUR/ }).or(section.getByText('No price history yet.'))).toBeVisible()
})

test('binders, the wishlist and the whole collection show their value and movers', async ({ page }, testInfo) => {
  await signedIn(page)
  const api = page.request
  const atraxa = await cardPrices(api, "Atraxa, Praetors' Voice") // foil only
  const thalia = await cardPrices(api, 'Thalia, Guardian of Thraben') // no history written for it anywhere
  const thaliaNow = thalia.finish === 'foil' ? thalia.prices.usdFoil! : thalia.prices.usd!
  const atraxaNow = atraxa.finish === 'foil' ? atraxa.prices.usdFoil! : atraxa.prices.usd!
  const priceKey = atraxa.finish === 'foil' ? 'usdFoil' : 'usd'
  await writeHistory(api, atraxa.id, [{ date: daysAgo(7), [priceKey]: atraxaNow / 2 }])

  const binder = (await (await api.post('/api/binders', { data: { name: 'Value binder', isPublic: true } })).json()).id
  const add = (card: { id: string; finish: string }, copies: number) =>
    api.post(`/api/binders/${binder}/cards`, { data: { card: { scryfallId: card.id, finish: card.finish, condition: 'NM', language: 'en' }, copies } })
  await add(atraxa, 2)
  await add(thalia, 3)
  const binderValue = 2 * atraxaNow + 3 * thaliaNow

  // The binder, privately and publicly.
  await page.goto(`/binders/${binder}`)
  await expect(page.getByTestId('binder-value')).toHaveText(`≈ ${usd(binderValue)}`)
  await page.goto(`/binder/${binder}`)
  await expect(page.getByTestId('binder-value')).toHaveText(`≈ ${usd(binderValue)}`)

  // The collection: its value, the week's change and the mover behind it.
  await page.goto('/binders')
  const panel = page.getByRole('region', { name: 'Collection value' })
  await expect(panel.getByTestId('collection-value')).toHaveText(usd(binderValue))
  await expect(panel.getByTestId('collection-change')).toHaveText(`Your binders are up ${usd(atraxaNow)} this week.`)
  const mover = panel.getByRole('listitem', { name: "Atraxa, Praetors' Voice" })
  await expect(mover).toContainText(`+100.0% · +${usd(atraxaNow)}`)
  await expect(mover).toContainText('×2')
  // The tile shows the binder's first card's art.
  const tile = page.getByRole('list', { name: 'Binders' }).getByRole('link', { name: /Value binder/ })
  await expect(tile.locator('span[aria-hidden="true"]').first()).toHaveAttribute('style', /background-image: url\("https:\/\/cards\.scryfall\.io\//)
  await milestone(page, testInfo, '61-collection-value')

  // The wishlist.
  await api.post('/api/wishlist', { data: { scryfallId: thalia.id, quantity: 2 } })
  await page.goto('/wishlist')
  await expect(page.getByTestId('wishlist-value')).toHaveText(`≈ ${usd(2 * thaliaNow)} to buy it all`)
  await milestone(page, testInfo, '62-wishlist-value')
})

test('collection prices need a signed-in user', async ({ request }) => {
  expect((await request.get('/api/collection/prices')).status()).toBe(401)
})
