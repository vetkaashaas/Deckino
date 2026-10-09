import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { local, logIn, newUser, registerVerified, test, type User } from './accounts'
import { choose, expectNoSidewaysScroll, findCard, signedIn } from './pages'
import { milestone } from './screenshot'

// Binders need verified accounts, which only the local API (with its development email endpoint) can make.
test.skip(!local, 'creates accounts')

test.beforeAll(async ({ playwright }, testInfo) => {
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

const rows = (page: Page, card: string) => page.getByRole('list', { name: 'Cards' }).getByRole('listitem', { name: card, exact: true })

// Rows of one condition (the badge text; "LP" alone would also match "Alpha").
const inCondition = (row: ReturnType<typeof rows>, condition: string) =>
  row.filter({ has: row.page().getByText(condition, { exact: true }) })

// The switches save first and flip when the API answers.
async function toggle(page: Page, name: string, on: boolean) {
  await page.getByRole('switch', { name }).click()
  await expect(page.getByRole('switch', { name })).toBeChecked({ checked: on })
}

async function menu(row: ReturnType<typeof rows>, card: string, item: string) {
  await row.getByRole('button', { name: `More actions for ${card}` }).click()
  await row.page().getByRole('menuitem', { name: item }).click()
}

async function createBinderByApi(request: APIRequestContext, user: User, name = 'Private binder') {
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
  const created = await request.post('/api/binders', { data: { name } })
  expect(created.status()).toBe(201)
  return (await created.json()).id as string
}

test('a user keeps physical cards in binders, moves them, and shares a selling binder', async ({ page, browser }, testInfo) => {
  const user = await signedIn(page)
  const forSale = (await (await page.request.post('/api/binders', { data: { name: 'For Sale' } })).json()).id

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Binders' }).click()
  await page.getByRole('link', { name: /For Sale/ }).waitFor()
  await page.getByRole('button', { name: 'New binder' }).click()
  const dialog = page.getByRole('dialog', { name: 'New binder' })
  await dialog.getByLabel('Binder name').fill('Trade Binder')
  await dialog.getByRole('button', { name: 'Create binder' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Trade Binder' })).toBeVisible()
  await expect(page.getByText('This binder is empty')).toBeVisible()

  // Four Japanese Alpha Bolts, lightly played, with a note: picking the printing and notes opens the full form.
  await page.getByText('Pick printing & notes').click()
  await page.getByRole('combobox', { name: 'Add a card' }).fill('lightning bolt')
  await page.getByRole('option').filter({ has: page.getByText('Lightning Bolt', { exact: true }) }).click()
  const add = page.getByRole('dialog', { name: 'Add to binder' })
  await choose(add, 'Printing', /^Limited Edition Alpha \(LEA\) #161/)
  await choose(add, 'Condition', 'Lightly Played')
  await choose(add, 'Language', 'Japanese')
  await add.getByLabel('Copies').fill('4')
  await add.getByLabel('Notes').fill('From my first booster')
  await add.getByRole('button', { name: 'Add' }).click()
  await expect(add).toBeHidden()
  const bolts = rows(page, 'Lightning Bolt')
  await expect(bolts).toHaveCount(1)
  await expect(bolts).toContainText('4×')
  await expect(bolts).toContainText('Limited Edition Alpha (LEA) #161 · From my first booster')
  await expect(inCondition(bolts, 'LP')).toHaveCount(1)
  await expect(bolts).toContainText('Japanese')

  // Two foil Forests (default printing), quick-added: they go straight in, as Near Mint English foils.
  await page.getByText('Pick printing & notes').click()
  await page.getByText('Foil', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Add a card' }).fill('2 forest')
  await page.getByRole('option').filter({ has: page.getByText('Forest', { exact: true }) }).click()
  await expect(add).toBeHidden()
  await expect(rows(page, 'Forest')).toContainText('2×')
  await expect(inCondition(rows(page, 'Forest'), 'NM')).toHaveCount(1)
  await expect(rows(page, 'Forest')).toContainText('Foil')
  await expect(page.getByTestId('binder-count')).toHaveText('6 cards')

  // Edit one Bolt: it becomes its own row.
  await menu(bolts, 'Lightning Bolt', 'Edit one copy')
  const edit = page.getByRole('dialog', { name: 'Edit Lightning Bolt' })
  await choose(edit, 'Condition', 'Near Mint')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeHidden()
  await expect(bolts).toHaveCount(2)
  const nmBolt = inCondition(bolts, 'NM')
  const lpBolts = inCondition(bolts, 'LP')
  await expect(nmBolt).toContainText('1×')
  await expect(lpBolts).toContainText('3×')

  // Remove one Forest; add one back from the menu; remove one again.
  await menu(rows(page, 'Forest'), 'Forest', 'Remove one copy')
  await expect(rows(page, 'Forest')).toContainText('1×')
  await menu(rows(page, 'Forest'), 'Forest', 'Add a copy')
  await expect(rows(page, 'Forest')).toContainText('2×')
  await menu(rows(page, 'Forest'), 'Forest', 'Remove one copy')
  await expect(rows(page, 'Forest')).toContainText('1×')
  await milestone(page, testInfo, '30-binder')

  // Move the near-mint Bolt singly, then the other three as a selection.
  await menu(nmBolt, 'Lightning Bolt', 'For Sale')
  await expect(bolts).toHaveCount(1)
  await lpBolts.getByRole('checkbox', { name: 'Select Lightning Bolt' }).check()
  const selection = page.getByRole('region', { name: 'Selection' })
  await expect(selection).toContainText('3 cards selected')
  await choose(page, 'Move selected cards to', 'For Sale')
  await selection.getByRole('button', { name: 'Move' }).click()
  await expect(bolts).toHaveCount(0)
  await expect(page.getByTestId('binder-count')).toHaveText('1 card')

  // The selling binder: mark it Selling and Public, then share the link.
  await page.getByRole('link', { name: 'Your binders' }).click()
  await page.getByRole('list', { name: 'Binders' }).getByRole('link', { name: /For Sale/ }).click()
  await expect(page.getByTestId('binder-count')).toHaveText('4 cards')
  await toggle(page, 'Selling', true)
  await toggle(page, 'Public', true)
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await milestone(page, testInfo, '31-selling-binder')

  // A logged-out visitor opens the link: cards and counts, never the owner's notes or email.
  const visitor = await browser.newContext()
  const anonymous = await visitor.newPage()
  await anonymous.goto(new URL(`/binder/${forSale}`, testInfo.project.use.baseURL).href)
  await expect(anonymous.getByRole('heading', { level: 1, name: 'For Sale' })).toBeVisible()
  await expect(anonymous.getByText(`Cards for sale by ${user.username}`)).toBeVisible()
  await expect(anonymous.getByText(`by ${user.username}`, { exact: true })).toBeVisible()
  const publicBolts = anonymous.getByRole('list', { name: 'Cards' }).getByRole('listitem', { name: 'Lightning Bolt' })
  await expect(publicBolts).toHaveCount(2)
  await expect(publicBolts.filter({ has: anonymous.getByText('LP', { exact: true }) })).toContainText('3×')
  await expect(publicBolts.filter({ has: anonymous.getByText('NM', { exact: true }) })).toContainText('1×')
  await expect(anonymous.getByTestId('binder-count')).toHaveText('4 cards')
  const body = await (await visitor.request.get(new URL(`/api/public/binders/${forSale}`, testInfo.project.use.baseURL).href)).text()
  expect(body).not.toContain('From my first booster')
  expect(body).not.toContain(user.email)
  await milestone(anonymous, testInfo, '32-public-binder')

  // Made private again: the link stops working.
  await toggle(page, 'Public', false)
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeHidden()
  await anonymous.reload()
  await expect(anonymous.getByRole('alert').filter({ hasText: 'Binder not found' })).toBeVisible()
  await visitor.close()

  // Delete the trade binder.
  await page.getByRole('link', { name: 'Your binders' }).click()
  await page.getByRole('list', { name: 'Binders' }).getByRole('link', { name: /Trade Binder/ }).click()
  await page.getByRole('button', { name: 'Binder actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete binder' }).click()
  await page.getByRole('dialog', { name: 'Delete Trade Binder?' }).getByRole('button', { name: 'Delete binder' }).click()
  await expect(page).toHaveURL(/\/binders$/)
  await expect(page.getByRole('list', { name: 'Binders' }).getByRole('link')).toHaveCount(1)
})

test("another user can't see, change or take cards from a private binder", async ({ page, request }, testInfo) => {
  const owner = newUser()
  await registerVerified(request, owner)
  const binderId = await createBinderByApi(request, owner)
  const bolt = await findCard(request, 'Lightning Bolt')
  const card = { scryfallId: bolt.id, finish: bolt.finish, condition: 'NM', language: 'en' }
  const added = await request.post(`/api/binders/${binderId}/cards`, { data: { card, copies: 2 } })
  const ownerCardId = (await added.json()).cards[0].id

  const other = await signedIn(page)
  const otherBinder = (await (await page.request.post('/api/binders', { data: { name: 'Mine' } })).json()).id
  const otherCardId = (await (await page.request.post(`/api/binders/${otherBinder}/cards`, { data: { card } })).json()).cards[0].id
  const otherBinder2 = (await (await page.request.post('/api/binders', { data: { name: 'Mine too' } })).json()).id
  const api = page.request
  for (const [label, response] of [
    ['get', await api.get(`/api/binders/${binderId}`)],
    ['rename', await api.put(`/api/binders/${binderId}`, { data: { name: 'Mine now', isPublic: true } })],
    ['add', await api.post(`/api/binders/${binderId}/cards`, { data: { card } })],
    ['edit card', await api.put(`/api/binders/${binderId}/cards/${ownerCardId}`, { data: card })],
    ['edit card via own binder', await api.put(`/api/binders/${otherBinder}/cards/${ownerCardId}`, { data: card })],
    ['remove card', await api.delete(`/api/binders/${binderId}/cards/${ownerCardId}`)],
    ['take cards', await api.post(`/api/binders/${binderId}/cards/move`, { data: { cardIds: [ownerCardId], toBinderId: otherBinder } })],
    ['take via own binder', await api.post(`/api/binders/${otherBinder}/cards/move`, { data: { cardIds: [ownerCardId], toBinderId: otherBinder2 } })],
    ['push cards in', await api.post(`/api/binders/${otherBinder}/cards/move`, { data: { cardIds: [otherCardId], toBinderId: binderId } })],
    ['delete', await api.delete(`/api/binders/${binderId}`)],
    ['public link', await api.get(`/api/public/binders/${binderId}`)],
  ] as const) {
    expect(response.status(), label).toBe(404)
  }
  expect((await (await api.get('/api/binders')).json()).map((b: { name: string }) => b.name).sort()).toEqual(['Mine', 'Mine too'])
  expect((await (await api.get(`/api/binders/${otherBinder}`)).json()).cards).toHaveLength(1) // the failed push moved nothing

  await page.goto(`/binders/${binderId}`)
  await expect(page.getByRole('alert').filter({ hasText: 'Binder not found' })).toBeVisible()
  await page.goto(`/binder/${binderId}`)
  await expect(page.getByRole('alert').filter({ hasText: 'Binder not found' })).toBeVisible()
  await milestone(page, testInfo, '33-binder-not-found')

  // The owner's binder is untouched. Made public, others can read it but still not change it.
  const binder = await (await request.get(`/api/binders/${binderId}`)).json()
  expect(binder).toMatchObject({ name: 'Private binder', isPublic: false })
  expect(binder.cards).toHaveLength(2)
  await request.put(`/api/binders/${binderId}`, { data: { isPublic: true } })
  expect((await api.get(`/api/public/binders/${binderId}`)).status()).toBe(200)
  expect((await api.put(`/api/binders/${binderId}`, { data: { name: 'Mine now' } })).status()).toBe(404)
  expect(other.username).not.toBe(owner.username)
})

test('binders need a signed-in user, and every card is checked', async ({ request }) => {
  expect((await request.get('/api/binders')).status()).toBe(401)
  expect((await request.post('/api/binders', { data: { name: 'x' } })).status()).toBe(401)

  const user = newUser()
  await registerVerified(request, user)
  const binderId = await createBinderByApi(request, user)
  const bolt = await findCard(request, 'Lightning Bolt') // nonfoil only
  const card = (change: object = {}) => ({ scryfallId: bolt.id, finish: 'nonfoil', condition: 'NM', language: 'en', ...change })

  const cases: [string, object, Record<string, string[]>][] = [
    ['no copies', { card: card(), copies: 0 }, { copies: ['Add 1 to 100 copies at a time.'] }],
    ['too many copies', { card: card(), copies: 101 }, { copies: ['Add 1 to 100 copies at a time.'] }],
    ['no card', { copies: 1 }, { card: ['Choose a card.'] }],
    ['unknown card', { card: card({ scryfallId: '00000000-0000-0000-0000-000000000000' }) }, { scryfallId: ["That card doesn't exist."] }],
    ['finish not printed', { card: card({ finish: 'foil' }) }, { finish: ["This printing doesn't come in that finish."] }],
    ['unknown condition', { card: card({ condition: 'Mint' }) }, { condition: ['Choose a condition.'] }],
    ['unknown language', { card: card({ language: 'xx' }) }, { language: ['Choose a language.'] }],
    ['long notes', { card: card({ notes: 'x'.repeat(501) }) }, { notes: ['Use at most 500 characters.'] }],
  ]
  for (const [label, data, errors] of cases) {
    const response = await request.post(`/api/binders/${binderId}/cards`, { data })
    expect(response.status(), label).toBe(400)
    expect((await response.json()).errors, label).toMatchObject(errors)
  }
  expect((await request.put(`/api/binders/${binderId}`, { data: { name: ' ' } })).status()).toBe(400)
  expect((await request.post(`/api/binders/${binderId}/cards/move`, { data: { cardIds: [], toBinderId: binderId } })).status()).toBe(400)
  expect((await (await request.get(`/api/binders/${binderId}`)).json()).cards).toEqual([])
})

test('card menus wait while a change saves, so changes never overlap', async ({ page }) => {
  await signedIn(page)
  const binder = (await (await page.request.post('/api/binders', { data: { name: 'Slow' } })).json()).id
  const bolt = await findCard(page.request, 'Lightning Bolt')
  await page.request.post(`/api/binders/${binder}/cards`, {
    data: { card: { scryfallId: bolt.id, finish: bolt.finish, condition: 'NM', language: 'en' }, copies: 3 },
  })
  await page.route(`**/api/binders/${binder}/cards/*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })
  await page.goto(`/binders/${binder}`)
  const bolts = rows(page, 'Lightning Bolt')
  await menu(bolts, 'Lightning Bolt', 'Remove one copy')
  await expect(bolts.getByRole('button', { name: 'More actions for Lightning Bolt' })).toBeDisabled()
  await expect(bolts.getByRole('button', { name: 'More actions for Lightning Bolt' })).toBeEnabled({ timeout: 5_000 })
  await expect(bolts).toContainText('2×')
  expect((await (await page.request.get(`/api/binders/${binder}`)).json()).cards).toHaveLength(2)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the binder page fits the screen', async ({ page, request }, testInfo) => {
    const user = newUser()
    await registerVerified(request, user)
    const binderId = await createBinderByApi(request, user)
    const bolt = await findCard(request, 'Lightning Bolt')
    await request.post(`/api/binders/${binderId}/cards`, {
      data: { card: { scryfallId: bolt.id, finish: bolt.finish, condition: 'LP', language: 'ja', notes: 'A long note about where this card came from' }, copies: 3 },
    })
    await request.put(`/api/binders/${binderId}`, { data: { isPublic: true, isSelling: true } })
    await logIn(page, user.email, user.password)
    await expect(page).toHaveURL(/\/$/) // the dashboard

    await page.goto(`/binders/${binderId}`)
    await expect(rows(page, 'Lightning Bolt')).toBeVisible()
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '34-phone-binder')
    await page.goto(`/binder/${binderId}`)
    await expect(page.getByText(`Cards for sale by ${user.username}`)).toBeVisible()
    await expectNoSidewaysScroll(page)
  })
})
