import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { local, newUser, registerVerified, test } from './accounts'
import { expectNoSidewaysScroll, findCard, signedIn } from './pages'
import { milestone } from './screenshot'

// Wishlists need verified accounts, which only the local API (with its development email endpoint) can make.
test.skip(!local, 'creates accounts')

test.beforeAll(async ({ playwright }, testInfo) => {
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

const wishlistRow = (page: Page, card: string) =>
  page.getByRole('list', { name: 'Wishlist' }).getByRole('listitem', { name: card, exact: true })
const quantity = (page: Page, card: string) => wishlistRow(page, card).getByTestId('quantity')

// A binder holding 2 Alpha Lightning Bolts and 10 Forests, and a Modern deck wanting 4 Bolts (the default printing),
// 20 Forests, 2 Thalias and a Fire // Ice in the sideboard.
async function collectionAndDeck(request: APIRequestContext) {
  const [bolt, forest, thalia, fireIce] = await Promise.all(
    ['Lightning Bolt', 'Forest', 'Thalia, Guardian of Thraben', 'Fire // Ice'].map((name) => findCard(request, name)),
  )
  const alphaBolt = (await (await request.get(`/api/cards/${bolt.id}`)).json()).printings.find((p: { setCode: string }) => p.setCode === 'lea').id
  const binder = (await (await request.post('/api/binders', { data: { name: 'Collection' } })).json()).id
  const copy = (scryfallId: string, finish: string, copies: number) =>
    request.post(`/api/binders/${binder}/cards`, { data: { card: { scryfallId, finish, condition: 'NM', language: 'en' }, copies } })
  expect((await copy(alphaBolt, 'nonfoil', 2)).ok()).toBe(true)
  expect((await copy(forest.id, forest.finish, 10)).ok()).toBe(true)

  const entry = (card: { id: string; finish: string }, quantity: number) => ({ scryfallId: card.id, quantity, finish: card.finish })
  const deck = await request.post('/api/decks', {
    data: {
      name: 'Boros Bolts',
      format: 'modern',
      cards: { mainboard: [entry(bolt, 4), entry(forest, 20), entry(thalia, 2)], sideboard: [entry(fireIce, 1)] },
    },
  })
  expect(deck.status()).toBe(201)
  return { deckId: (await deck.json()).id as string, bolt, forest, thalia }
}

test('a user keeps a wishlist and fills it with what a deck is missing', async ({ page }, testInfo) => {
  await signedIn(page)
  const { deckId } = await collectionAndDeck(page.request)

  // The wishlist: add, change quantity and printing, remove.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Collection' }).click()
  await page.getByRole('link', { name: /^Wishlist/ }).click()
  await expect(page.getByRole('heading', { name: 'Nothing on your wishlist' })).toBeVisible()
  const search = page.getByRole('combobox', { name: 'Add a card' })
  for (const [text, name] of [
    ['black lotus', 'Black Lotus'],
    ['thalia', 'Thalia, Guardian of Thraben'],
    ['2 black lotus', 'Black Lotus'], // "2 …" wants two more
  ]) {
    await search.fill(text)
    await page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click()
  }
  await expect(quantity(page, 'Black Lotus')).toHaveText('3×') // added twice: one entry
  // The card panel: one more, then the Alpha printing.
  await wishlistRow(page, 'Black Lotus').getByRole('button', { name: 'Edit Black Lotus' }).click()
  const panel = page.getByRole('dialog', { name: 'Black Lotus' })
  await panel.getByRole('button', { name: 'One more copy' }).click()
  await panel.getByRole('button', { name: 'Change printing' }).click()
  const picker = page.getByRole('dialog', { name: 'Choose a printing of Black Lotus' })
  await picker.getByLabel('Filter printings by set').fill('lea')
  await picker.getByRole('button', { name: /^Limited Edition Alpha \(LEA\)/ }).click()
  await expect(panel.getByTestId('panel-printing')).toHaveText(/^Limited Edition Alpha \(LEA\)/)
  await panel.getByRole('button', { name: 'Save' }).click()
  await expect(panel).toBeHidden()
  await page.reload()
  await expect(quantity(page, 'Black Lotus')).toHaveText('4×')
  await expect(wishlistRow(page, 'Black Lotus').getByTestId('printing')).toHaveText(/^Limited Edition Alpha \(LEA\)/)
  // Removed, then back with Undo, then removed for good.
  for (const undo of [true, false]) {
    await wishlistRow(page, 'Black Lotus').getByRole('button', { name: 'Edit Black Lotus' }).click()
    await panel.getByRole('button', { name: 'Remove from wishlist' }).click()
    await expect(wishlistRow(page, 'Black Lotus')).toBeHidden()
    if (undo) {
      await page.getByRole('button', { name: 'Undo' }).click()
      await expect(quantity(page, 'Black Lotus')).toHaveText('4×')
    }
  }
  await expect(quantity(page, 'Thalia, Guardian of Thraben')).toHaveText('1×')

  // The deck against the binder: any printing counts, so the Alpha Bolts cover two of the four.
  await page.goto(`/decks/${deckId}`)
  await page.getByRole('button', { name: 'Compare with my collection' }).click()
  const dialog = page.getByRole('dialog', { name: 'Compared with your binders' })
  await expect(dialog.getByTestId('collection-totals')).toHaveText('Owned 12Missing 15')
  const compared = (name: string) => dialog.getByRole('listitem', { name, exact: true })
  await expect(compared('Lightning Bolt')).toContainText('2 of 4 owned')
  await expect(compared('Lightning Bolt')).toContainText('2 missing')
  await expect(compared('Forest')).toContainText('10 of 20 owned')
  await expect(compared('Thalia, Guardian of Thraben')).toContainText('0 of 2 owned')
  await expect(compared('Fire // Ice')).toContainText('1 missing') // the sideboard counts in Modern
  await milestone(page, testInfo, '40-deck-vs-collection')

  // One click puts the missing cards on the wishlist; Thalia was wanted once and is now wanted twice. A second
  // click adds nothing.
  await dialog.getByRole('button', { name: 'Add missing to wishlist' }).click()
  await expect(dialog.getByRole('status')).toContainText('Added 14 cards to your wishlist.')
  await dialog.getByRole('button', { name: 'Add missing to wishlist' }).click()
  await expect(dialog.getByRole('status')).toContainText('Your wishlist already has every missing card.')

  await dialog.getByRole('link', { name: 'See your wishlist' }).click()
  await expect(page).toHaveURL(/\/wishlist$/)
  for (const [card, count] of [
    ['Lightning Bolt', '2'],
    ['Forest', '10'],
    ['Thalia, Guardian of Thraben', '2'],
    ['Fire // Ice', '1'],
  ]) {
    await expect(quantity(page, card)).toHaveText(`${count}×`)
  }
  await expect(page.getByTestId('wishlist-count')).toHaveText('15 cards wanted')
  await page.mouse.move(0, 0) // no card preview in the screenshot
  await milestone(page, testInfo, '41-wishlist')

  // The filter narrows the list by name or set, and says so when nothing matches.
  const list = page.getByRole('list', { name: 'Wishlist' }).getByRole('listitem')
  const filter = page.getByRole('textbox', { name: 'Filter your wishlist' })
  await filter.fill('thal')
  await expect(list).toHaveCount(1)
  await expect(wishlistRow(page, 'Thalia, Guardian of Thraben')).toBeVisible()
  await filter.fill('FDC')
  await expect(wishlistRow(page, 'Lightning Bolt')).toBeVisible()
  await filter.fill('black lotus')
  await expect(page.getByText('Nothing on your wishlist matches “black lotus”.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear the filter' }).click()
  await expect(list).toHaveCount(4)
})

test("wishlists and comparisons are private, and only count the user's own binders", async ({ page, request }) => {
  const owner = newUser()
  await registerVerified(request, owner)
  expect((await request.post('/api/account/login', { data: owner })).status()).toBe(200)
  const { deckId, bolt } = await collectionAndDeck(request)
  const entryId = (await (await request.post('/api/wishlist', { data: { scryfallId: bolt.id, quantity: 3 } })).json())[0].id

  await signedIn(page)
  const api = page.request
  // The other user owns plenty of Forests; that doesn't change the owner's comparison.
  const theirs = (await (await api.post('/api/binders', { data: { name: 'Lands' } })).json()).id
  const forest = await findCard(api, 'Forest')
  await api.post(`/api/binders/${theirs}/cards`, { data: { card: { scryfallId: forest.id, finish: forest.finish, condition: 'NM', language: 'en' }, copies: 30 } })

  for (const [label, response] of [
    ['change', await api.put(`/api/wishlist/${entryId}`, { data: { quantity: 9 } })],
    ['remove', await api.delete(`/api/wishlist/${entryId}`)],
    ['compare', await api.get(`/api/decks/${deckId}/collection`)],
    ['add missing', await api.post(`/api/decks/${deckId}/collection/wishlist`)],
  ] as const) {
    expect(response.status(), label).toBe(404)
  }
  expect(await (await api.get('/api/wishlist')).json()).toEqual([])

  const wishlist = await (await request.get('/api/wishlist')).json()
  expect(wishlist).toHaveLength(1)
  expect(wishlist[0]).toMatchObject({ id: entryId, quantity: 3 })
  expect((await (await request.get(`/api/decks/${deckId}/collection`)).json()).owned).toBe(12)
})

test('the wishlist needs a signed-in user, and checks what it is given', async ({ request }) => {
  expect((await request.get('/api/wishlist')).status()).toBe(401)
  expect((await request.post('/api/wishlist', { data: {} })).status()).toBe(401)

  const user = newUser()
  await registerVerified(request, user)
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
  const bolt = await findCard(request, 'Lightning Bolt')
  const cases: [string, object, Record<string, string[]>][] = [
    ['quantity 0', { scryfallId: bolt.id, quantity: 0 }, { quantity: ['Want 1 to 99 copies.'] }],
    ['quantity 100', { scryfallId: bolt.id, quantity: 100 }, { quantity: ['Want 1 to 99 copies.'] }],
    ['no card', { quantity: 1 }, { scryfallId: ["That card doesn't exist."] }],
    ['unknown card', { scryfallId: '00000000-0000-0000-0000-000000000000' }, { scryfallId: ["That card doesn't exist."] }],
  ]
  for (const [label, data, errors] of cases) {
    const response = await request.post('/api/wishlist', { data })
    expect(response.status(), label).toBe(400)
    expect((await response.json()).errors, label).toMatchObject(errors)
  }

  // Quantities stop at 99 when entries merge.
  await request.post('/api/wishlist', { data: { scryfallId: bolt.id, quantity: 60 } })
  const merged = await (await request.post('/api/wishlist', { data: { scryfallId: bolt.id, quantity: 60 } })).json()
  expect(merged).toHaveLength(1)
  expect(merged[0].quantity).toBe(99)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the wishlist fits the screen', async ({ page }, testInfo) => {
    await signedIn(page)
    for (const name of ['Lightning Bolt', 'Thalia, Guardian of Thraben', 'Fire // Ice']) {
      await page.request.post('/api/wishlist', { data: { scryfallId: (await findCard(page.request, name)).id, quantity: 2 } })
    }
    await page.goto('/wishlist')
    await expect(wishlistRow(page, 'Fire // Ice')).toBeVisible()
    await expectNoSidewaysScroll(page)
    // Two short lines a card, with the whole name on the first.
    const thalia = wishlistRow(page, 'Thalia, Guardian of Thraben')
    expect((await thalia.boundingBox())!.height).toBeLessThan(80)
    await expect(thalia.getByTestId('printing')).toHaveText(/^[A-Z0-9]+ #\d+$/, { useInnerText: true })
    const name = thalia.getByText('Thalia, Guardian of Thraben')
    expect(await name.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    await milestone(page, testInfo, '42-phone-wishlist')
  })
})
