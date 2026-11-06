import { expect, test, type Page } from '@playwright/test'
import { pickCurrency, signedIn } from './pages'
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
  results(page).filter({ has: page.getByText(name, { exact: true }) })
// The printing a card page shows: its set's name, then "CODE #number · Rarity · year".
async function expectPrinting(page: Page, setName: string, number: string) {
  const set = page.getByTestId('card-set')
  await expect(set.getByText(setName, { exact: true })).toBeVisible()
  await expect(set).toContainText(`${number} · `)
}

test('sync imports paper printings only and a rerun changes nothing', async ({ request }) => {
  test.skip(!local, 'the sync trigger is development-only')
  const rerun = await (await request.post('/api/dev/catalogue/sync')).json()
  expect(rerun).toMatchObject({
    error: null,
    cardsRead: 501, // includes the cards of the provider decks in e2e/fixtures (add-deck-cards.mjs)
    digitalSkipped: 20,
    inserted: 0,
    updated: 0,
  })
  // Printings dropped from the fixture stay in a reused E2E database, flagged rather than deleted (user data may
  // point at them): 0 on a fresh database, at most the 2 foil-only printings add-deck-cards.mjs once swapped out,
  // and the same on every rerun. More would mean real fixture cards wrongly flagged.
  expect(rerun.missingUpstream).toBeLessThanOrEqual(2)
  const again = await (await request.post('/api/dev/catalogue/sync')).json()
  expect(again.missingUpstream).toBe(rerun.missingUpstream)
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

test('the search stays on screen while the results scroll, and the card size switch is remembered', async ({ page }, testInfo) => {
  await page.goto('/cards')
  await expect(results(page).first()).toBeVisible()
  const grid = page.getByRole('list', { name: 'Search results' })
  const across = () => grid.evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(' ').length)
  // A wide screen starts on Medium, 6 across; the switch goes Small (8), Large (4), and back.
  const size = page.getByRole('button', { name: /^Card size/ })
  await expect(size).toHaveAccessibleName('Card size: Medium')
  expect(await across()).toBe(6)
  await size.click()
  await expect(size).toHaveAccessibleName('Card size: Small')
  expect(await across()).toBe(8)
  await size.click()
  await expect(size).toHaveAccessibleName('Card size: Large')
  expect(await across()).toBe(4)
  await page.reload()
  await expect(size).toHaveAccessibleName('Card size: Large')
  await expect(results(page).first()).toBeVisible()

  // Far down the results the name is still there to change, under the header.
  await page.mouse.wheel(0, 2000)
  const bar = page.getByRole('search')
  await expect(bar).toHaveAttribute('data-stuck', 'true')
  await expect(page.getByLabel('Card name')).toBeInViewport()
  await expect(page.getByRole('group', { name: 'Colours' })).not.toBeInViewport() // the filters stay at the top
  await milestone(page, testInfo, '82-card-search-scrolled', 'screen')
  await search(page, 'lightning bolt')
  await expect(named(page, 'Lightning Bolt')).toHaveCount(1)
  // The ✕ empties the name, and that searches again.
  await page.getByRole('button', { name: 'Clear the name' }).click()
  await expect(page.getByLabel('Card name')).toHaveValue('')
  await expect(page).toHaveURL(/\/cards$/)
})

test('tokens and art cards are hidden unless asked for', async ({ page }) => {
  await page.goto('/cards?q=goblin')
  await expect(page.getByRole('list', { name: 'Search results' }).or(page.getByText('No cards found'))).toBeVisible()
  await expect(named(page, 'Goblin')).toHaveCount(0)
  await page.getByLabel('Include tokens and art cards').click()
  await expect(page).toHaveURL(/extras=true/)
  await expect(page.getByLabel('Include tokens and art cards')).toBeChecked()
  await expect(named(page, 'Goblin').first()).toBeVisible() // the full catalogue has several Goblin tokens
})

test('search filters by color, type, mana value and set, as soon as they change', async ({ page }) => {
  await page.goto('/cards?q=lightning')
  await page.getByLabel('Type').fill('instant')
  await expect(page).toHaveURL(/type=instant/)
  await page.getByAltText('Red').click()
  await expect(page.getByRole('checkbox', { name: 'Red' })).toBeChecked()
  await expect(page).toHaveURL((url) => url.searchParams.get('type') === 'instant' && url.searchParams.get('colors') === 'R')
  await expect(named(page, 'Lightning Bolt')).toHaveCount(1)
  await page.getByLabel('Type').fill('creature')
  await expect(page).toHaveURL(/type=creature/)
  await expect(named(page, 'Lightning Bolt')).toHaveCount(0)

  // Mana value: Lightning Bolt costs one; a second click clears the filter.
  await page.goto('/cards?q=lightning bolt')
  await page.getByRole('group', { name: 'Mana value' }).getByText('3', { exact: true }).click()
  await expect(page).toHaveURL(/mv=3/)
  await expect(page.getByText('No cards found')).toBeVisible()
  await page.getByRole('group', { name: 'Mana value' }).getByText('1', { exact: true }).click()
  await expect(named(page, 'Lightning Bolt')).toHaveCount(1)
  await page.getByRole('group', { name: 'Mana value' }).getByText('1', { exact: true }).click()
  await expect(page).not.toHaveURL(/mv=/)

  // Without a name, the browser starts with the most valuable cards.
  await page.goto('/cards')
  await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('Most valuable')
  await expect(results(page).first()).toContainText('$')
  const prices = await results(page).locator('span').filter({ hasText: /^\$/ }).allTextContents()
  const values = prices.map((p) => Number(p.replace(/[$,]/g, '')))
  expect(values.length).toBeGreaterThan(1)
  expect(values).toEqual([...values].sort((x, y) => y - x))

  // In euros, it sorts by the euro prices shown.
  await pickCurrency(page, 'eur')
  await expect(results(page).first()).toContainText('€')
  const euros = (await results(page).locator('span').filter({ hasText: /€$/ }).allTextContents()).map((p) =>
    Number(p.replace(/[^\d,]/g, '').replace(',', '.')),
  )
  expect(euros.length).toBeGreaterThan(1)
  expect(euros).toEqual([...euros].sort((x, y) => y - x))
  await pickCurrency(page, 'usd')

  // A filter clicked while the typed name waits to search is kept when the search goes.
  await page.getByLabel('Card name').fill('bolt')
  await page.getByRole('group', { name: 'Colours' }).getByAltText('Red', { exact: true }).click()
  await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'bolt' && url.searchParams.get('colors') === 'R')
  await page.waitForTimeout(500)
  await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'bolt' && url.searchParams.get('colors') === 'R')

  await page.goto('/cards')
  await page.getByRole('combobox', { name: 'Set' }).fill('lea')
  await page.getByRole('option', { name: 'Limited Edition Alpha (LEA)' }).click()
  await search(page, 'forest')
  await results(page).first().click()
  await expect(page.getByTestId('card-set')).toContainText(/^Limited Edition AlphaLEA #/)
})

test('card page shows both faces, details, and switches printings', async ({ page }, testInfo) => {
  await page.goto('/cards?q=delver of secrets')
  await results(page).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delver of Secrets // Insectile Aberration')
  await expect(page.getByRole('img', { name: 'Delver of Secrets // Insectile Aberration', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '(back face)' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Insectile Aberration', exact: true })).toBeVisible()
  await expect(page.getByText('Creature — Human Insect')).toBeVisible()
  await expect(page.getByTestId('card-set')).toContainText('Common', { ignoreCase: true }) // capitalized by CSS
  await expect(page.getByText('Illustrated by Nils Hamm')).toBeVisible()
  await milestone(page, testInfo, '03-card-page-double-faced')

  const printings = page.getByRole('region', { name: 'Printings' })
  if (local) await expect(printings.getByRole('heading')).toHaveText('8 printings')
  const before = page.url()
  await printings.getByRole('link', { name: /^Innistrad ISD #51 / }).click()
  await expectPrinting(page, 'Innistrad', 'ISD #51')
  expect(page.url()).not.toBe(before)
  await expect(printings.getByRole('link', { name: /^Innistrad ISD #51 / })).toHaveAttribute('aria-current', 'page')
  await milestone(page, testInfo, '04-printing-switched')

  // Under the card, every printing as its picture: picking one opens it.
  await page.getByRole('button', { name: 'See all 8 printings' }).click()
  const picker = page.getByRole('dialog', { name: /Choose a printing/ })
  await picker.getByRole('button', { name: /Innistrad: Midnight Hunt/ }).click()
  await expect(picker).toBeHidden()
  await expectPrinting(page, 'Innistrad: Midnight Hunt', 'MID #47')
})

test('a card without a chosen printing opens its default printing', async ({ page }) => {
  test.skip(!local, 'the default printing depends on the fixture')
  // Latest released printing that is English, not full art, not Secret Lair, not a promo. The fixture's newest
  // Forest and Bolt come out in November 2026, so until then the one before them is the default.
  const released = (date: string) => Date.now() >= Date.parse(date)
  await page.goto('/cards?q=forest')
  await named(page, 'Forest').click()
  if (released('2026-11-13')) await expectPrinting(page, 'Star Trek', 'TRK #325')
  else await expectPrinting(page, 'Reality Fracture', 'FRA #289')

  await page.goto('/cards?q=lightning bolt')
  await results(page).first().click()
  if (released('2026-11-09')) await expectPrinting(page, 'The List', 'PLST #CLB-187')
  else await expectPrinting(page, 'Foundations Commander', 'FDC #163')
  await expect(page.getByRole('heading', { name: '68 printings' })).toBeVisible() // 77 in the file, 9 digital
})

test('the currency is chosen on the account page and remembered', async ({ page }, testInfo) => {
  test.skip(!local, 'creates accounts')
  await signedIn(page)
  await page.goto('/cards?q=delver of secrets')
  await results(page).first().click()
  const card = page.url()
  const prices = page.getByRole('region', { name: 'Prices' })
  await expect(prices.getByTestId('prices')).toContainText(/Normal\s*\$\d/)
  await expect(page.getByRole('radiogroup', { name: 'Currency' })).toHaveCount(0) // only on the account page

  await page.goto('/account')
  await page.getByRole('region', { name: 'Currency' }).getByText('EUR').click()
  await page.goto(card)
  await expect(prices.getByTestId('prices')).toContainText(/Normal\s*\d+,\d\d\s€/)
  await page.reload()
  await expect(prices.getByTestId('prices')).toContainText('€')
  await milestone(page, testInfo, '05-prices-eur')
  await page.goto('/account')
  await expect(page.getByRole('radio', { name: 'EUR' })).toBeChecked()
})

test('an unknown card is a 404', async ({ page, request }) => {
  const missing = '00000000-0000-0000-0000-000000000000'
  expect((await request.get(`/api/cards/${missing}`)).status()).toBe(404)
  await page.goto(`/cards/${missing}`)
  await expect(page.getByRole('alert')).toContainText('Card not found')
})

test('an out-of-range search page is empty, not an error', async ({ request }) => {
  const response = await request.get('/api/cards?q=bolt&page=2147483647')
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ cards: [], hasMore: false })
})

test('a reversible card shows both of its same-named faces', async ({ page }) => {
  await page.goto('/cards/0489be0d-2117-46a8-97ab-31fe480685e2') // Ghalta, Primal Hunger's Secret Lair reversible printing
  await expectPrinting(page, 'Secret Lair Drop', 'SLD #1124')
  await expect(page.getByRole('heading', { level: 2, name: 'Ghalta, Primal Hunger' })).toHaveCount(2)
})

// The mobile app's scanner recognizes the artwork and the card; the API turns that into printings to start on.
test('a scanned artwork gives its printings, the one to start on first', async ({ request }) => {
  test.skip(!local, 'fixture printings')
  const bolt = '4457ed35-7c10-48c8-9776-456485fdf070'
  const printings = (await (await request.get(`/api/cards/by-artwork?oracleId=${bolt}&illustrationId=013e7eda-ef8e-44cd-9832-4033d9de1c34`)).json()) as { id: string; setCode: string; image: string }[]
  expect(printings).toHaveLength(15) // every paper printing with Christopher Moeller's art
  expect(printings[0]).toMatchObject({ id: '0852f9f3-d7ef-4d31-93e3-93bc7c5a4ec9', setCode: 'fdc' }) // newest English non-promo
  expect(printings.every((p) => p.image)).toBe(true)

  // A double-faced card's artwork is per face.
  const giant = (await (await request.get('/api/cards/by-artwork?oracleId=d6d72f5f-8f5d-4180-b514-f22ff5482902&illustrationId=c7f49422-def6-4502-bc02-38aee9924371')).json()) as unknown[]
  expect(giant).toHaveLength(5)

  // An artwork the catalogue doesn't have, or none, falls back to the card's default printing.
  for (const query of [`oracleId=${bolt}&illustrationId=00000000-0000-0000-0000-000000000001`, `oracleId=${bolt}`]) {
    const fallback = (await (await request.get(`/api/cards/by-artwork?${query}`)).json()) as { isDefault: boolean }[]
    expect(fallback).toEqual([expect.objectContaining({ isDefault: true })])
  }
  // Another card's artwork is not this card's printing.
  const other = (await (await request.get(`/api/cards/by-artwork?oracleId=5089ec1a-f881-4d55-af14-5d996171203b&illustrationId=013e7eda-ef8e-44cd-9832-4033d9de1c34`)).json()) as { setCode: string }[]
  expect(other).toEqual([expect.objectContaining({ isDefault: true })])
  expect((await request.get('/api/cards/by-artwork?oracleId=00000000-0000-0000-0000-000000000000')).status()).toBe(404)
})
