import { expect, test, type Page } from '@playwright/test'
import { milestone } from './screenshot'

// Locally the API syncs from e2e/fixtures/cards.jsonl.gz; against a deployment (BASE_URL) it has the full
// Scryfall catalogue, so fixture-specific counts and printings are only asserted locally.
const local = !process.env.BASE_URL

test.beforeAll(async ({ playwright }, testInfo) => {
  if (!local) return
  // Waits for the startup sync and forces a full import of the fixture, so every test sees it.
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

async function search(page: Page, name: string) {
  await page.getByLabel('Card name').fill(name)
  await page.getByLabel('Card name').press('Enter')
}

const results = (page: Page) => page.getByRole('list', { name: 'Search results' }).getByRole('listitem')
// Results for exactly this card name (the full catalogue also has e.g. "Emeritus of Conflict // Lightning Bolt").
const named = (page: Page, name: string) =>
  results(page).filter({ has: page.locator('.card-name').getByText(name, { exact: true }) })

test('sync imports paper printings only and a rerun changes nothing', async ({ request }) => {
  test.skip(!local, 'the sync trigger is development-only')
  const rerun = await (await request.post('/api/dev/catalogue/sync')).json()
  expect(rerun).toMatchObject({
    error: null,
    cardsRead: 192,
    digitalSkipped: 20,
    inserted: 0,
    updated: 0,
    missingUpstream: 0,
  })
})

test('visitor searches cards and every printing of a card is one result', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Cards' }).click()
  await search(page, 'lightning bolt')
  await expect(named(page, 'Lightning Bolt')).toHaveCount(1)
  await expect(page).toHaveURL(/\/cards\?q=lightning\+bolt$/)
  await milestone(page, testInfo, '02-card-search')

  await search(page, 'forest')
  await expect(named(page, 'Forest')).toHaveCount(1)

  await search(page, 'lightnig bolt') // typo-tolerant
  await expect(named(page, 'Lightning Bolt')).toHaveCount(1)
})

test('tokens and art cards are hidden unless asked for', async ({ page }) => {
  await page.goto('/cards?q=goblin')
  await expect(page.getByText(/No cards found\.|Load more|Goblin/).first()).toBeVisible()
  await expect(named(page, 'Goblin')).toHaveCount(0)
  await page.getByLabel('Include tokens and art cards').check()
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(named(page, 'Goblin').first()).toBeVisible() // the full catalogue has several Goblin tokens
})

test('search filters by color, type and set', async ({ page }) => {
  await page.goto('/cards?q=lightning')
  await page.getByLabel('Type').fill('instant')
  await page.getByRole('checkbox', { name: 'Red' }).check({ force: true })
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page).toHaveURL(/type=instant&colors=R/)
  await expect(named(page, 'Lightning Bolt')).toHaveCount(1)
  await page.getByLabel('Type').fill('creature')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page).toHaveURL(/type=creature&colors=R/)
  await expect(named(page, 'Lightning Bolt')).toHaveCount(0)

  await page.goto('/cards')
  await page.getByLabel('Set').fill('lea')
  await search(page, 'forest')
  await results(page).first().click()
  await expect(page.getByTestId('card-set')).toContainText('Limited Edition Alpha (LEA)')
})

test('card page shows both faces, details, and switches printings', async ({ page }, testInfo) => {
  await page.goto('/cards?q=delver of secrets')
  await results(page).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delver of Secrets // Insectile Aberration')
  await expect(page.getByRole('img', { name: 'Delver of Secrets // Insectile Aberration', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '(back face)' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Insectile Aberration', exact: true })).toBeVisible()
  await expect(page.getByText('Creature — Human Insect')).toBeVisible()
  await expect(page.getByText('Rarity')).toBeVisible()
  await expect(page.getByText('Artist')).toBeVisible()
  await milestone(page, testInfo, '03-card-page-double-faced')

  const printings = page.getByRole('region', { name: 'Printings' })
  if (local) await expect(printings.getByRole('heading')).toHaveText('Printings (8)')
  const before = page.url()
  await printings.getByRole('link', { name: /Innistrad \(ISD\) #51/ }).click()
  await expect(page.getByTestId('card-set')).toHaveText('Innistrad (ISD) #51')
  expect(page.url()).not.toBe(before)
  await expect(printings.getByRole('link', { name: /Innistrad \(ISD\) #51/ })).toHaveAttribute('aria-current', 'page')
  await milestone(page, testInfo, '04-printing-switched')
})

test('a card without a chosen printing opens its default printing', async ({ page }) => {
  test.skip(!local, 'the default printing depends on the fixture')
  // Latest printing that is English, not full art, not Secret Lair, not a promo.
  await page.goto('/cards?q=forest')
  await named(page, 'Forest').click()
  await expect(page.getByTestId('card-set')).toHaveText('Star Trek (TRK) #325')

  await page.goto('/cards?q=lightning bolt')
  await results(page).first().click()
  await expect(page.getByTestId('card-set')).toHaveText('The List (PLST) #CLB-187')
  await expect(page.getByRole('heading', { name: 'Printings (68)' })).toBeVisible() // 77 in the file, 9 digital
})

test('prices toggle between USD and EUR and the choice is remembered', async ({ page }, testInfo) => {
  await page.goto('/cards?q=delver of secrets')
  await results(page).first().click()
  const prices = page.getByRole('region', { name: 'Prices' })
  await expect(prices.getByTestId('prices')).toContainText(/Normal\s*\$\d/)
  await prices.getByRole('button', { name: 'EUR' }).click()
  await expect(prices.getByTestId('prices')).toContainText(/Normal\s*\d+,\d\d\s€/)
  await page.reload()
  await expect(prices.getByRole('button', { name: 'EUR' })).toHaveAttribute('aria-pressed', 'true')
  await expect(prices.getByTestId('prices')).toContainText('€')
  await milestone(page, testInfo, '05-prices-eur')
})

test('an unknown card is a 404', async ({ page, request }) => {
  const missing = '00000000-0000-0000-0000-000000000000'
  expect((await request.get(`/api/cards/${missing}`)).status()).toBe(404)
  await page.goto(`/cards/${missing}`)
  await expect(page.getByRole('alert')).toHaveText('Card not found.')
})

test('an out-of-range search page is empty, not an error', async ({ request }) => {
  const response = await request.get('/api/cards?q=bolt&page=2147483647')
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ cards: [], hasMore: false })
})
