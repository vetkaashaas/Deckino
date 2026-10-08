import { expect, type APIRequestContext } from '@playwright/test'
import { local, newUser, registerVerified, test } from './accounts'
import { choose, expectNoSidewaysScroll, findCard, signedIn } from './pages'
import { milestone } from './screenshot'

test.beforeAll(async ({ playwright }, testInfo) => {
  if (!local) return
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

// A word in every deck name this run makes, so searches only see this run's decks.
const tag = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function createDeck(request: APIRequestContext, name: string, format: string, isPublic: boolean) {
  const bolt = await findCard(request, 'Lightning Bolt')
  const atraxa = await findCard(request, "Atraxa, Praetors' Voice")
  const entry = (card: { id: string; finish: string }, quantity: number) => ({ scryfallId: card.id, quantity, finish: card.finish })
  const cards = format === 'commander' ? { commander: [entry(atraxa, 1)] } : { mainboard: [entry(bolt, 4)] }
  const created = await request.post('/api/decks', { data: { name, format, cards } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  if (isPublic) expect((await request.put(`/api/decks/${id}/visibility`, { data: { isPublic: true } })).status()).toBe(200)
  return id
}

test('anyone can find a public deck, open it and share it; private decks stay hidden', async ({ page, browser }, testInfo) => {
  test.skip(!local, 'creates accounts')
  const run = tag()
  const owner = await signedIn(page)
  const bolts = await createDeck(page.request, `Mono Red Bolts ${run}`, 'modern', false)
  await createDeck(page.request, `Atraxa Counters ${run}`, 'commander', true)
  const secret = await createDeck(page.request, `Secret Brew ${run}`, 'modern', false)

  // The owner makes a deck public from the deck page.
  await page.goto(`/decks/${bolts}`)
  await page.getByRole('switch', { name: 'Public' }).click()
  await expect(page.getByRole('switch', { name: 'Public' })).toBeChecked()
  await expect(page.getByRole('link', { name: 'Public page' })).toHaveAttribute('href', `/deck/${bolts}`)
  await expect(page.getByRole('status')).toHaveText('All changes saved') // not an unsaved edit

  // A logged-out visitor searches by name and by format.
  const visitor = await browser.newContext()
  const anonymous = await visitor.newPage()
  const baseURL = testInfo.project.use.baseURL!
  await anonymous.goto(new URL('/browse', baseURL).href)
  await anonymous.getByRole('textbox', { name: 'Deck name' }).fill(run)
  const results = anonymous.getByRole('list', { name: 'Public decks' }).getByRole('link')
  await expect(results).toHaveCount(2)
  await expect(results.filter({ hasText: `Secret Brew ${run}` })).toHaveCount(0)
  await expect(results.first()).toContainText(`by ${owner.username}`)
  await choose(anonymous, 'Format', 'Commander')
  await expect(results).toHaveCount(1)
  await expect(results).toContainText(`Atraxa Counters ${run}`)
  await expect(anonymous).toHaveURL((url) => url.searchParams.get('q') === run && url.searchParams.get('format') === 'commander')
  await milestone(anonymous, testInfo, '50-browse-decks')

  await anonymous.getByRole('textbox', { name: 'Deck name' }).fill(`Secret Brew ${run}`)
  await expect(anonymous.getByRole('heading', { name: 'No public decks found' })).toBeVisible()

  // The public deck page: cards, owner, value and legality.
  await anonymous.goto(new URL(`/browse?q=${run}&format=modern`, baseURL).href)
  await results.filter({ hasText: `Mono Red Bolts ${run}` }).click()
  await expect(anonymous).toHaveURL(new RegExp(`/deck/${bolts}$`))
  await expect(anonymous.getByRole('heading', { level: 1, name: `Mono Red Bolts ${run}` })).toBeVisible()
  await expect(anonymous.getByText(`by ${owner.username}`, { exact: true })).toBeVisible()
  await expect(anonymous.getByRole('region', { name: 'Mainboard' }).getByRole('listitem', { name: 'Lightning Bolt' })).toContainText('4×')
  await expect(anonymous.getByTestId('deck-count')).toHaveText('4 cards')
  await expect(anonymous.getByTestId('deck-value')).toContainText('≈')
  await expect(anonymous.getByRole('region', { name: 'Not legal in Modern' })).toContainText(
    'A Modern deck needs at least 60 mainboard cards. This one has 4.',
  )
  await milestone(anonymous, testInfo, '51-public-deck')

  // Shared links carry a preview; the API never gives out the owner's email.
  const html = await (await visitor.request.get(new URL(`/deck/${bolts}`, baseURL).href)).text()
  expect(html).toContain(`<meta property="og:title" content="Mono Red Bolts ${run} by ${owner.username}" />`)
  expect(html).toContain('<meta property="og:description" content="Modern deck · 4 cards · Deckino" />')
  expect(html).toContain('og:image')
  const json = await (await visitor.request.get(new URL(`/api/public/decks/${bolts}`, baseURL).href)).text()
  expect(json).not.toContain(owner.email)
  const secretHtml = await (await visitor.request.get(new URL(`/deck/${secret}`, baseURL).href)).text()
  expect(secretHtml).toContain('<meta property="og:title" content="Deckino: your Magic collection, decks and binders" />') // the site's own
  expect(secretHtml).not.toContain('Secret Brew')
  expect(secretHtml).toContain('<div id="root"></div>')
  expect((await visitor.request.get(new URL(`/api/public/decks/${secret}`, baseURL).href)).status()).toBe(404)
  await anonymous.goto(new URL(`/deck/${secret}`, baseURL).href)
  await expect(anonymous.getByRole('alert').filter({ hasText: 'Deck not found' })).toBeVisible()

  // Made private again: gone from the link and from search.
  await page.getByRole('switch', { name: 'Public' }).click()
  await expect(page.getByRole('switch', { name: 'Public' })).not.toBeChecked()
  await anonymous.goto(new URL(`/deck/${bolts}`, baseURL).href)
  await expect(anonymous.getByRole('alert').filter({ hasText: 'Deck not found' })).toBeVisible()
  const search = await (await visitor.request.get(new URL(`/api/public/decks?q=${run}`, baseURL).href)).json()
  expect(search.decks.map((d: { deck: { name: string } }) => d.deck.name)).toEqual([`Atraxa Counters ${run}`])
  await visitor.close()
})

test('only the owner can make a deck public, and previews are escaped', async ({ page, request }) => {
  test.skip(!local, 'creates accounts')
  const run = tag()
  const owner = newUser()
  await registerVerified(request, owner)
  expect((await request.post('/api/account/login', { data: owner })).status()).toBe(200)
  const deck = await createDeck(request, `"<b>Tricky</b>" & co ${run}`, 'modern', false)

  await signedIn(page)
  expect((await page.request.put(`/api/decks/${deck}/visibility`, { data: { isPublic: true } })).status()).toBe(404)
  expect((await page.request.get(`/api/public/decks/${deck}`)).status()).toBe(404)

  await request.put(`/api/decks/${deck}/visibility`, { data: { isPublic: true } })
  // Public is read-only for others: the owner's API still answers 404.
  expect((await page.request.get(`/api/decks/${deck}`)).status()).toBe(404)
  expect((await page.request.put(`/api/decks/${deck}`, { data: { name: 'Mine', format: 'modern', cards: {} } })).status()).toBe(404)
  const html = await (await page.request.get(`/deck/${deck}`)).text()
  expect(html).toContain(`content="&quot;&lt;b&gt;Tricky&lt;/b&gt;&quot; &amp; co ${run} by ${owner.username}"`)
  expect(html).not.toContain('<b>Tricky</b>')

  // A public binder's link has a preview too.
  const binder = (await (await request.post('/api/binders', { data: { name: `Trades ${run}`, isPublic: true, isSelling: true } })).json()).id
  const binderHtml = await (await page.request.get(`/binder/${binder}`)).text()
  expect(binderHtml).toContain(`<meta property="og:title" content="Trades ${run}" />`)
  expect(binderHtml).toContain(`content="Cards for sale by ${owner.username} · 0 cards · Deckino"`)
})

test('search pages through public decks, newest first', async ({ request }) => {
  test.skip(!local, 'creates accounts')
  const run = tag()
  const user = newUser()
  await registerVerified(request, user)
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
  for (let i = 1; i <= 25; i++) await createDeck(request, `Deck ${i} ${run}`, 'modern', true)

  const first = await (await request.get(`/api/public/decks?q=${run}`)).json()
  expect(first.decks).toHaveLength(24)
  expect(first.hasMore).toBe(true)
  expect(first.decks[0].deck.name).toBe(`Deck 25 ${run}`)
  const second = await (await request.get(`/api/public/decks?q=${run}&page=2`)).json()
  expect(second.decks.map((d: { deck: { name: string } }) => d.deck.name)).toEqual([`Deck 1 ${run}`])
  expect(second.hasMore).toBe(false)
  // % and _ are literal, not wildcards.
  expect((await (await request.get('/api/public/decks?q=%25%25%25_zz')).json()).decks).toEqual([])
})

test('the browse page works logged out', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Browse decks' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Browse decks' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Public decks' }).or(page.getByRole('heading', { name: 'No public decks found' }))).toBeVisible()
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the public deck page fits the screen', async ({ page, request }, testInfo) => {
    test.skip(!local, 'creates accounts')
    const user = newUser()
    await registerVerified(request, user)
    expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
    const deck = await createDeck(request, `Phone deck ${tag()}`, 'commander', true)
    await page.goto(`/deck/${deck}`)
    await expect(page.getByRole('region', { name: 'Commander', exact: true })).toBeVisible()
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '52-phone-public-deck')
  })
})

test('Back and Forward on the deck search show the search they return to', async ({ page }) => {
  await page.goto('/browse')
  const box = page.getByRole('textbox', { name: 'Deck name' })
  await box.fill('alpha')
  await expect(page).toHaveURL(/q=alpha/)
  await choose(page, 'Format', 'Modern') // a new history entry
  await expect(page).toHaveURL(/format=modern/)
  await box.fill('beta')
  await expect(page).toHaveURL(/q=beta/)

  await page.goBack()
  await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'alpha' && !url.searchParams.has('format'))
  await expect(box).toHaveValue('alpha')
  await page.waitForTimeout(600) // longer than the typing delay: nothing pushes "beta" back
  await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'alpha')
})
