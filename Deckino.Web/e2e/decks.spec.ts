import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { local, logIn, newUser, registerVerified, test, type User } from './accounts'
import { choose, expectNoSidewaysScroll, findCard, signedIn } from './pages'
import { milestone } from './screenshot'

// Decks need verified accounts, which only the local API (with its development email endpoint) can make.
test.skip(!local, 'creates accounts')

test.beforeAll(async ({ playwright }, testInfo) => {
  // Waits for the startup sync, so the fixture catalogue is there to add cards from.
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

const section = (page: Page, name: string) => page.getByRole('region', { name })
const row = (page: Page, sectionName: string, card: string) =>
  section(page, sectionName).getByRole('listitem', { name: card, exact: true })

async function addCard(page: Page, search: string, name: string) {
  await page.getByRole('combobox', { name: 'Add a card' }).fill(search)
  await page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click()
  await expect(row(page, 'Mainboard', name)).toBeVisible()
}

async function moveTo(page: Page, card: string, to: string) {
  await page.getByRole('button', { name: `More actions for ${card}` }).click()
  await page.getByRole('menuitem', { name: `Move to ${to}` }).click()
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible()
}

async function createDeckByApi(request: APIRequestContext, user: User) {
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
  const forest = (await (await request.get('/api/cards?q=forest')).json()).cards[0].id
  const created = await request.post('/api/decks', {
    data: { name: 'Private deck', format: 'modern', cards: { mainboard: [{ scryfallId: forest, quantity: 20, finish: 'nonfoil' }] } },
  })
  expect(created.status()).toBe(201)
  return (await created.json()).id as string
}

test('a user builds, saves, edits and deletes a deck', async ({ page }, testInfo) => {
  await signedIn(page)

  // My Decks starts empty; create a Commander deck.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Decks', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No decks yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Build your first deck' }).click()
  const dialog = page.getByRole('dialog', { name: 'New deck' })
  await dialog.getByLabel('Deck name').fill('Atraxa Superfriends')
  await expect(dialog.getByRole('combobox', { name: 'Format' })).toHaveValue('Commander')
  await dialog.getByRole('button', { name: 'Create deck' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Atraxa Superfriends' })).toBeVisible()
  await expect(page.getByText('This deck is empty')).toBeVisible()

  // Add cards, set a commander, quantities, printings, a finish and a sideboard card.
  await addCard(page, 'atraxa', "Atraxa, Praetors' Voice")
  await addCard(page, 'lightning bolt', 'Lightning Bolt')
  await addCard(page, 'forest', 'Forest')
  await addCard(page, 'forest', 'Forest') // the same card again adds a copy
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('2')

  // Enter adds the top result, never one left over from the previous search (Forest here).
  const search = page.getByRole('combobox', { name: 'Add a card' })
  await search.fill('black lotus')
  await search.press('Enter')
  await expect(page.getByRole('option').filter({ hasText: 'Black Lotus' })).toBeVisible()
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('2')
  await search.press('Enter')
  await expect(row(page, 'Mainboard', 'Black Lotus')).toBeVisible()

  await moveTo(page, "Atraxa, Praetors' Voice", 'commander')
  await expect(row(page, 'Commander', "Atraxa, Praetors' Voice")).toBeVisible()
  await moveTo(page, 'Black Lotus', 'sideboard')
  await expect(row(page, 'Sideboard', 'Black Lotus')).toBeVisible()

  await page.getByLabel('Quantity of Forest').fill('30')
  await choose(page, 'Finish of Forest', 'Foil')
  await choose(page, 'Printing of Lightning Bolt', /^Limited Edition Alpha \(LEA\) #161/)
  await expect(page.getByRole('combobox', { name: 'Printing of Lightning Bolt' })).toHaveValue('Limited Edition Alpha (LEA) #161')

  await expect(page.getByTestId('deck-count')).toHaveText('32 cards + 1 sideboard')
  await expect(page.getByRole('status')).toHaveText('Unsaved changes')
  await save(page)
  await milestone(page, testInfo, '20-deck-builder')

  // Cards added without choosing a printing got the default printing.
  const deckId = page.url().split('/').at(-1)!
  const deck = await (await page.request.get(`/api/decks/${deckId}`)).json()
  const forestEntry = deck.mainboard.find((e: { card: { name: string } }) => e.card.name === 'Forest')
  const forest = await (await page.request.get(`/api/cards/${forestEntry.scryfallId}`)).json()
  expect(forest.printings.find((p: { id: string }) => p.id === forestEntry.scryfallId).isDefault).toBe(true)
  expect(forestEntry).toMatchObject({ quantity: 30, finish: 'foil' })

  // Everything is still there after a reload.
  await page.reload()
  await expect(row(page, 'Commander', "Atraxa, Praetors' Voice")).toBeVisible()
  await expect(row(page, 'Sideboard', 'Black Lotus')).toBeVisible()
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('30')
  await expect(page.getByRole('combobox', { name: 'Finish of Forest' })).toHaveValue('Foil')
  await expect(page.getByRole('combobox', { name: 'Printing of Lightning Bolt' })).toHaveValue('Limited Edition Alpha (LEA) #161')

  await page.getByRole('radiogroup', { name: 'View' }).getByText('Gallery').click()
  await expect(section(page, 'Mainboard').getByRole('img', { name: 'Forest' })).toBeVisible()
  await milestone(page, testInfo, '21-deck-gallery')
  await page.getByRole('radiogroup', { name: 'View' }).getByText('List').click()

  // Leaving with unsaved changes asks first.
  await page.getByLabel('Deck name').fill('Atraxa Counters')
  await page.getByLabel('Quantity of Forest').fill('35')
  await page.getByRole('link', { name: 'Your decks' }).click()
  const leave = page.getByRole('dialog', { name: 'Leave without saving?' })
  await expect(leave).toBeVisible()
  await leave.getByRole('button', { name: 'Stay' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Atraxa Counters' })).toBeVisible()
  await save(page)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Atraxa Counters' })).toBeVisible()
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('35')

  // My Decks lists it.
  await page.getByRole('link', { name: 'Your decks' }).click()
  const tile = page.getByRole('list', { name: 'Decks' }).getByRole('link', { name: /Atraxa Counters/ })
  await expect(tile).toContainText('Commander')
  await expect(tile).toContainText('37 cards')
  await milestone(page, testInfo, '22-my-decks')

  // Delete it.
  await tile.click()
  await page.getByRole('button', { name: 'Delete deck' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete Atraxa Counters?' })
  await confirm.getByRole('button', { name: 'Delete deck' }).click()
  await expect(page).toHaveURL(/\/decks$/)
  await expect(page.getByRole('heading', { name: 'No decks yet' })).toBeVisible()
  expect((await page.request.get(`/api/decks/${deckId}`)).status()).toBe(404)
})

test("another user can't see, change or delete a private deck", async ({ page, request }, testInfo) => {
  const owner = newUser()
  await registerVerified(request, owner)
  const deckId = await createDeckByApi(request, owner)

  await signedIn(page)
  for (const response of [
    await page.request.get(`/api/decks/${deckId}`),
    await page.request.put(`/api/decks/${deckId}`, { data: { name: 'Mine now', format: 'modern', cards: {} } }),
    await page.request.delete(`/api/decks/${deckId}`),
  ]) {
    expect(response.status()).toBe(404)
  }
  expect(await (await page.request.get('/api/decks')).json()).toEqual([])

  await page.goto(`/decks/${deckId}`)
  await expect(page.getByRole('alert').filter({ hasText: 'Deck not found' })).toBeVisible()
  await milestone(page, testInfo, '23-deck-not-found')

  // The owner's deck is untouched.
  const deck = await (await request.get(`/api/decks/${deckId}`)).json()
  expect(deck).toMatchObject({ name: 'Private deck', format: 'modern' })
  expect(deck.mainboard[0].quantity).toBe(20)
})

test('edits made while saving stay, and a failed load is not "not found"', async ({ page, request }) => {
  const user = newUser()
  await registerVerified(request, user)
  const deckId = await createDeckByApi(request, user)
  await logIn(page, user.email, user.password)
  await expect(page).toHaveURL(/\/$/) // the dashboard

  // A slow save: the quantity typed while it runs is kept, and still counts as unsaved.
  await page.route(`**/api/decks/${deckId}`, async (route) => {
    if (route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.continue()
  })
  await page.goto(`/decks/${deckId}`)
  await page.getByLabel('Deck name').fill('Renamed while saving')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByLabel('Quantity of Forest').fill('7')
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 5_000 }) // the save finished
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('7')
  await expect(page.getByRole('status')).toHaveText('Unsaved changes')
  expect(await (await page.request.get(`/api/decks/${deckId}`)).json()).toMatchObject({ name: 'Renamed while saving' })
  await page.unroute(`**/api/decks/${deckId}`)

  // A server error while loading says so, rather than "Deck not found".
  await page.route(`**/api/decks/${deckId}`, (route) => route.fulfill({ status: 500 }))
  await page.goto(`/decks/${deckId}`)
  await expect(page.getByRole('alert').filter({ hasText: "Your deck didn't load" })).toBeVisible()
})

test('decks need a signed-in user', async ({ page, request }) => {
  expect((await request.get('/api/decks')).status()).toBe(401)
  expect((await request.post('/api/decks/legality', { data: { format: 'modern' } })).status()).toBe(401)
  expect((await request.post('/api/decks', { data: { name: 'x', format: 'modern' } })).status()).toBe(401)
  await page.goto('/decks')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fdecks$/)
})

test('saving a deck checks every card entry', async ({ request }) => {
  const user = newUser()
  await registerVerified(request, user)
  const deckId = await createDeckByApi(request, user)
  const bolt = (await (await request.get('/api/cards?q=lightning bolt')).json()).cards[0].id // nonfoil only
  const entry = (quantity = 1, finish = 'nonfoil', scryfallId = bolt) => ({ scryfallId, quantity, finish })

  const cases: [string, object, Record<string, string[]>][] = [
    ['no name', { name: ' ', format: 'modern' }, { name: ['Use 1 to 100 characters.'] }],
    ['long name', { name: 'x'.repeat(101), format: 'modern' }, { name: ['Use 1 to 100 characters.'] }],
    ['unknown format', { name: 'Deck', format: 'brawl' }, { format: ['Choose a format.'] }],
    ['quantity 0', { mainboard: [entry(0)] }, { cards: ['Quantities must be between 1 and 99.'] }],
    ['quantity 100', { mainboard: [entry(100)] }, { cards: ['Quantities must be between 1 and 99.'] }],
    ['unknown finish', { mainboard: [entry(1, 'shiny')] }, { cards: ['Finish must be nonfoil, foil or etched.'] }],
    ['finish not printed', { mainboard: [entry(1, 'etched')] }, { cards: [`Card ${bolt} isn't printed in etched.`] }],
    [
      'unknown card',
      { mainboard: [entry(1, 'nonfoil', '00000000-0000-0000-0000-000000000000')] },
      { cards: ["Card 00000000-0000-0000-0000-000000000000 doesn't exist."] },
    ],
    ['duplicate entry', { sideboard: [entry(), entry(2)] }, { cards: ['The same card and finish appears twice in the sideboard.'] }],
    ['three commanders', { commander: [entry(), entry(), entry()] }, { cards: ['A deck has at most 2 commanders.'] }],
    ['too many entries', { mainboard: Array.from({ length: 501 }, () => entry()) }, { cards: ['A deck holds at most 500 entries.'] }],
  ]
  for (const [label, change, errors] of cases) {
    const { name = 'Deck', format = 'modern', ...sections } = change as { name?: string; format?: string }
    const response = await request.put(`/api/decks/${deckId}`, { data: { name, format, cards: sections } })
    expect(response.status(), label).toBe(400)
    const body = await response.json()
    for (const [field, messages] of Object.entries(errors)) {
      expect(body.errors[field], label).toEqual(expect.arrayContaining(messages))
    }
  }

  // Nothing was changed by the rejected saves.
  expect(await (await request.get(`/api/decks/${deckId}`)).json()).toMatchObject({ name: 'Private deck' })
})

test('the deck page says why a deck is not legal, before it is saved', async ({ page }, testInfo) => {
  await signedIn(page)
  const entry = async (name: string, quantity = 1) => {
    const { id, finish } = await findCard(page.request, name)
    return { scryfallId: id, quantity, finish }
  }
  const created = await page.request.post('/api/decks', {
    data: {
      name: 'Atraxa Rules Lawyer',
      format: 'commander',
      cards: {
        commander: [await entry("Atraxa, Praetors' Voice")],
        mainboard: [
          await entry('Black Lotus'),
          await entry('Lightning Bolt'),
          await entry('Thalia, Guardian of Thraben', 2),
          await entry('Forest', 90),
        ],
      },
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  await page.goto(`/decks/${(await created.json()).id}`)

  const legality = page.getByRole('region', { name: /legal in/i })
  await expect(legality).toContainText('Not legal in Commander')
  await expect(legality.getByRole('listitem')).toHaveText([
    'Black Lotus is banned in Commander.',
    'Thalia, Guardian of Thraben: 2 copies, but Commander allows only 1.',
    'A Commander deck has exactly 100 cards, including the commander. This one has 95.',
    "Lightning Bolt is outside the commander's colour identity.",
  ])
  await milestone(page, testInfo, '25-deck-not-legal')

  // Fixing the deck in the page (unsaved) updates the verdict straight away.
  for (const card of ['Black Lotus', 'Lightning Bolt']) {
    await page.getByRole('button', { name: `More actions for ${card}` }).click()
    await page.getByRole('menuitem', { name: 'Remove' }).click()
  }
  await page.getByLabel('Quantity of Thalia, Guardian of Thraben').fill('1')
  await page.getByLabel('Quantity of Forest').fill('98')
  await expect(legality).toHaveText('Legal in Commander')
  await expect(page.getByRole('status')).toHaveText('Unsaved changes')
  await milestone(page, testInfo, '26-deck-legal')

  // Another format, other rules: Atraxa isn't legal in Modern (and counts as mainboard there).
  await choose(page, 'Format', 'Modern')
  await expect(legality.getByRole('listitem')).toHaveText(["Atraxa, Praetors' Voice isn't legal in Modern."])
  await choose(page, 'Format', 'Casual')
  await expect(legality).toBeHidden()
})

test('legality rules, format by format', async ({ request }) => {
  const user = newUser()
  await registerVerified(request, user)
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
  const [atraxa, thalia, ghalta, bolt, lotus, forest] = await Promise.all(
    [
      "Atraxa, Praetors' Voice",
      'Thalia, Guardian of Thraben',
      'Ghalta, Primal Hunger // Ghalta, Primal Hunger',
      'Lightning Bolt',
      'Black Lotus',
      'Forest',
    ].map((name) => findCard(request, name)),
  )
  const alphaBolt = {
    id: (await (await request.get(`/api/cards/${bolt.id}`)).json()).printings.find((p: { setCode: string }) => p.setCode === 'lea').id,
    finish: 'nonfoil',
  }
  const e = (card: { id: string; finish: string }, quantity = 1) => ({ scryfallId: card.id, quantity, finish: card.finish })

  const cases: [string, string, object, string[]][] = [
    [
      'no commander',
      'commander',
      { mainboard: [e(forest, 60)] },
      ['A Commander deck has exactly 100 cards, including the commander. This one has 60.', 'Choose a commander.'],
    ],
    [
      'an instant as commander',
      'commander',
      { commander: [e(bolt)], mainboard: [e(forest, 99)] },
      ["Lightning Bolt can't be your commander.", "Forest is outside the commander's colour identity."],
    ],
    [
      'a two-faced legendary creature commands, basics are exempt from singleton',
      'commander',
      { commander: [e(ghalta)], mainboard: [e(forest, 99)] },
      [],
    ],
    [
      'two commanders without partner',
      'commander',
      { commander: [e(atraxa), e(thalia)], mainboard: [e(forest, 98)] },
      ["Atraxa, Praetors' Voice and Thalia, Guardian of Thraben can't be commanders together."],
    ],
    [
      'copies count across printings, finishes and the sideboard; sideboard size; deck size',
      'modern',
      { mainboard: [e(bolt, 2), e(alphaBolt, 2)], sideboard: [e(bolt, 1), e(forest, 15)] },
      [
        'Lightning Bolt: 5 copies, but Modern allows up to 4.',
        'A Modern deck needs at least 60 mainboard cards. This one has 4.',
        'A Modern sideboard holds at most 15 cards. This one has 16.',
      ],
    ],
    ['restricted is one copy', 'vintage', { mainboard: [e(lotus, 2), e(forest, 58)] }, ['Black Lotus: 2 copies, but Vintage allows only 1.']],
    ['restricted, one copy is fine', 'vintage', { mainboard: [e(lotus), e(forest, 59)] }, []],
    ['banned', 'legacy', { sideboard: [e(lotus)], mainboard: [e(forest, 60)] }, ['Black Lotus is banned in Legacy.']],
    [
      'the same card twice as commander warns once',
      'commander',
      { commander: [e(bolt), e(alphaBolt)], mainboard: [e(forest, 98)] },
      [
        'Lightning Bolt: 2 copies, but Commander allows only 1.',
        "Lightning Bolt and Lightning Bolt can't be commanders together.",
        "Lightning Bolt can't be your commander.",
        "Forest is outside the commander's colour identity.",
      ],
    ],
    ['casual has no rules', 'casual', { commander: [e(bolt)], mainboard: [e(lotus, 9)] }, []],
  ]
  for (const [label, format, cards, warnings] of cases) {
    const response = await request.post('/api/decks/legality', { data: { format, cards } })
    expect(response.status(), `${label} ${await response.text()}`).toBe(200)
    expect(await response.json(), label).toEqual(warnings)
  }

  // The check uses the same entry validation as saving.
  const bad = await request.post('/api/decks/legality', { data: { format: 'modern', cards: { mainboard: [e(bolt, 0)] } } })
  expect(bad.status()).toBe(400)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the deck page and deck list fit the screen', async ({ page, request }, testInfo) => {
    const user = newUser()
    await registerVerified(request, user)
    const deckId = await createDeckByApi(request, user)
    await logIn(page, user.email, user.password)
    await expect(page).toHaveURL(/\/$/) // the dashboard

    await page.goto(`/decks/${deckId}`)
    await expect(row(page, 'Mainboard', 'Forest')).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Printing of Forest' })).toBeVisible()
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '24-phone-deck-page')

    await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Decks', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Decks' })).toBeVisible()
    await expectNoSidewaysScroll(page)
  })
})
