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

async function addCard(page: Page, search: string, name: string, to = 'Mainboard') {
  await page.getByRole('combobox', { name: 'Add a card' }).fill(search)
  await page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click()
  await expect(row(page, to, name)).toBeVisible()
}

async function moveTo(page: Page, card: string, to: string) {
  await page.getByRole('button', { name: `More actions for ${card}` }).click()
  await page.getByRole('menuitem', { name: `Move to ${to}` }).click()
}

// Decks save themselves shortly after each change.
async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 })
}

async function rename(page: Page, name: string) {
  await page.getByRole('button', { name: 'Rename deck' }).click()
  await page.getByLabel('Deck name').fill(name)
  await page.getByLabel('Deck name').press('Enter')
}

// The legality chip opens into its reasons.
async function legalityReasons(page: Page) {
  const legality = page.getByRole('region', { name: /legal in/i })
  await legality.getByRole('button', { expanded: false }).click()
  return legality.getByRole('listitem')
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

  // A Commander deck starts with its commander: the search offers only cards that can lead a deck.
  await expect(page.getByRole('combobox', { name: 'Add a card' })).toHaveAttribute('placeholder', 'Search for your commander')
  await page.getByRole('combobox', { name: 'Add a card' }).fill('lightning bolt')
  await expect(page.getByText('No commanders found')).toBeVisible()
  await addCard(page, 'atraxa', "Atraxa, Praetors' Voice", 'Commander')
  // A commander is one card: no quantity to change.
  await expect(page.getByLabel("Quantity of Atraxa, Praetors' Voice")).toHaveCount(0)

  // Then the rest of the deck goes to the mainboard.
  await expect(page.getByRole('combobox', { name: 'Add a card' })).toHaveAttribute('placeholder', 'Search cards to add to the mainboard')
  // Commander is singleton, the commander included: a second Atraxa doesn't go in.
  await page.getByRole('combobox', { name: 'Add a card' }).fill('atraxa')
  await page.getByRole('option').filter({ has: page.getByText("Atraxa, Praetors' Voice", { exact: true }) }).click()
  await expect(page.getByText("Atraxa, Praetors' Voice is already in the deck: this format allows one copy.")).toBeVisible()
  await expect(row(page, 'Mainboard', "Atraxa, Praetors' Voice")).toHaveCount(0)
  await addCard(page, 'lightning bolt', 'Lightning Bolt')
  await addCard(page, 'forest', 'Forest')
  await addCard(page, 'forest', 'Forest') // the same card again adds a copy
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('2')
  // "3 forest" adds three at once.
  await addCard(page, '3 forest', 'Forest')
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('5')
  // Commander is singleton: Lightning Bolt has no quantity to raise, and adding it again says so.
  await expect(page.getByLabel('Quantity of Lightning Bolt: 1')).toBeVisible()
  await page.getByRole('combobox', { name: 'Add a card' }).fill('lightning bolt')
  await page.getByRole('option').filter({ has: page.getByText('Lightning Bolt', { exact: true }) }).click()
  await expect(page.getByText('Lightning Bolt is already in the deck: this format allows one copy.')).toBeVisible()

  // Enter adds the top result, never one left over from the previous search (Forest here).
  const search = page.getByRole('combobox', { name: 'Add a card' })
  await search.fill('black lotus')
  await search.press('Enter')
  await expect(page.getByRole('option').filter({ hasText: 'Black Lotus' })).toBeVisible()
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('5')
  await search.press('Enter')
  await expect(row(page, 'Mainboard', 'Black Lotus')).toBeVisible()

  // In Commander the sideboard is a maybeboard; Black Lotus can't lead a deck, so it can't be set as commander.
  await page.getByRole('button', { name: 'More actions for Black Lotus' }).click()
  await expect(page.getByRole('menuitem', { name: 'Set as commander' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await moveTo(page, 'Black Lotus', 'maybeboard')
  await expect(row(page, 'Maybeboard', 'Black Lotus')).toBeVisible()

  await page.getByLabel('Quantity of Forest').fill('30')
  await choose(page, 'Finish of Forest', 'Foil')
  await choose(page, 'Printing of Lightning Bolt', /^Limited Edition Alpha \(LEA\) #161/)
  await expect(page.getByRole('combobox', { name: 'Printing of Lightning Bolt' })).toHaveValue('Limited Edition Alpha (LEA) #161')

  await expect(page.getByTestId('deck-count')).toHaveText('32 / 100 cards + 1 maybeboard')
  await saved(page)
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
  await expect(row(page, 'Maybeboard', 'Black Lotus')).toBeVisible()
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('30')
  await expect(page.getByRole('combobox', { name: 'Finish of Forest' })).toHaveValue('Foil')
  await expect(page.getByRole('combobox', { name: 'Printing of Lightning Bolt' })).toHaveValue('Limited Edition Alpha (LEA) #161')

  // The stats strip and the stacks view.
  await expect(page.getByRole('region', { name: 'Deck stats' }).getByRole('listitem', { name: '1 spell at mana value 1' })).toBeVisible()
  await page.getByRole('radiogroup', { name: 'View' }).getByText('Stacks').click()
  await expect(section(page, 'Mainboard').getByRole('img', { name: 'Forest' })).toBeVisible()
  await milestone(page, testInfo, '21-deck-stacks')
  await section(page, 'Mainboard').getByRole('button', { name: 'Actions for Forest' }).click()
  await page.getByRole('menuitem', { name: 'Remove a copy' }).click()
  // The gallery: whole cards, − and + on hover, and the same actions on a right-click.
  await page.getByRole('radiogroup', { name: 'View' }).getByText('Gallery').click()
  const galleryForest = section(page, 'Mainboard').getByRole('listitem', { name: 'Forest', exact: true })
  await expect(galleryForest).toContainText('29×')
  await galleryForest.hover()
  await galleryForest.getByRole('button', { name: 'Add a copy of Forest' }).click()
  await expect(galleryForest).toContainText('30×')
  await galleryForest.getByRole('link', { name: 'Forest' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove a copy' }).click()
  await expect(galleryForest).toContainText('29×')
  // The same menu from the card's ⋯ (touch screens have no right-click on a link).
  await galleryForest.hover()
  await galleryForest.getByRole('button', { name: 'More actions for Forest' }).click()
  await expect(page.getByRole('menuitem', { name: 'Change printing…' })).toBeVisible()
  await page.keyboard.press('Escape')
  // A singleton card offers no + at all.
  await expect(section(page, 'Mainboard').getByRole('button', { name: 'Add a copy of Lightning Bolt' })).toHaveCount(0)
  // Bigger cards: every step up to the largest makes them wider, and back down again.
  const width = async () => (await galleryForest.boundingBox())!.width
  const larger = page.getByRole('button', { name: 'Larger cards' })
  const start = await width()
  let previous = start
  while (await larger.isEnabled()) {
    await larger.click()
    await expect.poll(width).toBeGreaterThan(previous)
    previous = await width()
  }
  const smaller = page.getByRole('button', { name: 'Smaller cards' })
  for (let i = 0; i < 3; i++) await smaller.click() // the three steps up from the default
  await expect.poll(width).toBeCloseTo(start, 0)
  await milestone(page, testInfo, '21-deck-gallery')
  // Change a printing from the right-click: every printing as its picture; back to the default Bolt.
  const defaultBolt = await (await page.request.get(`/api/cards/${(await findCard(page.request, 'Lightning Bolt')).id}`)).json()
  const defaultLabel = `${defaultBolt.setName} (${defaultBolt.setCode.toUpperCase()}) #${defaultBolt.collectorNumber}`
  await section(page, 'Mainboard').getByRole('link', { name: 'Lightning Bolt' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Change printing…' }).click()
  const picker = page.getByRole('dialog', { name: 'Choose a printing of Lightning Bolt' })
  await expect(picker.getByRole('button', { name: 'Limited Edition Alpha (LEA) #161' })).toHaveAttribute('aria-current', 'true')
  await picker.getByLabel('Filter printings by set').fill(defaultBolt.setCode)
  await milestone(page, testInfo, '21-printing-picker')
  await picker.getByRole('button', { name: defaultLabel }).click()
  await expect(picker).toBeHidden()
  await page.getByRole('radiogroup', { name: 'View' }).getByText('List').click()
  await expect(page.getByRole('combobox', { name: 'Printing of Lightning Bolt' })).toHaveValue(defaultLabel)
  await page.getByRole('radiogroup', { name: 'View' }).getByText('Gallery').click()
  // A left click opens the card's page.
  await section(page, 'Mainboard').getByRole('link', { name: 'Lightning Bolt' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Lightning Bolt' })).toBeVisible()
  await page.goBack()
  await expect(galleryForest).toContainText('29×')
  await page.getByRole('radiogroup', { name: 'View' }).getByText('List').click()
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('29')

  // A change saves even when the page is left straight away.
  await rename(page, 'Atraxa Counters')
  await page.getByLabel('Quantity of Forest').fill('35')
  await page.getByRole('link', { name: 'Your decks' }).click()
  await expect(page).toHaveURL(/\/decks$/)
  await page.goBack()
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
  await page.getByRole('button', { name: 'Deck actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete deck' }).click()
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

test('edits made while a save runs are saved next, and a failed load is not "not found"', async ({ page, request }) => {
  const user = newUser()
  await registerVerified(request, user)
  const deckId = await createDeckByApi(request, user)
  await logIn(page, user.email, user.password)
  await expect(page).toHaveURL(/\/$/) // the dashboard

  // A slow save: the quantity typed while it runs is kept, and saved after it.
  await page.route(`**/api/decks/${deckId}`, async (route) => {
    if (route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.continue()
  })
  await page.goto(`/decks/${deckId}`)
  await rename(page, 'Renamed while saving')
  await expect(page.getByTestId('save-status')).toHaveText('Saving…')
  await page.getByLabel('Quantity of Forest').fill('7')
  await saved(page)
  await expect(page.getByLabel('Quantity of Forest')).toHaveValue('7')
  const deck = await (await page.request.get(`/api/decks/${deckId}`)).json()
  expect(deck).toMatchObject({ name: 'Renamed while saving' })
  expect(deck.mainboard[0].quantity).toBe(7)
  await page.unroute(`**/api/decks/${deckId}`)

  // A failed save says so, and keeps the change to try again.
  await page.route(`**/api/decks/${deckId}`, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500 }) : route.continue()))
  await page.getByLabel('Quantity of Forest').fill('8')
  await expect(page.getByTestId('save-status')).toHaveText(/Not saved/)
  await page.unroute(`**/api/decks/${deckId}`)
  await page.getByTestId('save-status').getByRole('button', { name: 'Try again' }).click()
  await saved(page)
  expect((await (await page.request.get(`/api/decks/${deckId}`)).json()).mainboard[0].quantity).toBe(8)

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
  await expect(await legalityReasons(page)).toHaveText([
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
  await milestone(page, testInfo, '26-deck-legal')

  // Another format, other rules: Atraxa isn't legal in Modern (and counts as mainboard there).
  await choose(page, 'Format', 'Modern')
  await expect(legality).toContainText('Not legal in Modern')
  await expect(await legalityReasons(page)).toHaveText(["Atraxa, Praetors' Voice isn't legal in Modern."])
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

test('cards go into a deck, a binder and the wishlist straight from the card browser', async ({ page }) => {
  await signedIn(page)
  const deckId = (await (await page.request.post('/api/decks', { data: { name: 'Burn', format: 'modern', cards: {} } })).json()).id
  const binderId = (await (await page.request.post('/api/binders', { data: { name: 'Trades' } })).json()).id

  await page.goto('/cards?q=lightning bolt')
  const bolt = page.getByRole('list', { name: 'Search results' }).getByRole('listitem').filter({ has: page.getByText('Lightning Bolt', { exact: true }) })
  for (const place of ['Burn', 'Burn', 'Trades', 'Wishlist']) {
    await bolt.hover()
    await bolt.getByRole('button', { name: 'Add Lightning Bolt to…' }).click()
    await page.getByRole('menuitem', { name: place }).click()
    await expect(page.getByText(place === 'Wishlist' ? 'Added Lightning Bolt to your wishlist.' : `Added Lightning Bolt to ${place}.`).last()).toBeVisible()
  }

  const deck = await (await page.request.get(`/api/decks/${deckId}`)).json()
  expect(deck.mainboard).toEqual([expect.objectContaining({ quantity: 2 })])
  const binder = await (await page.request.get(`/api/binders/${binderId}`)).json()
  expect(binder.cards).toEqual([expect.objectContaining({ condition: 'NM', language: 'en' })])
  const wishlist = await (await page.request.get('/api/wishlist')).json()
  expect(wishlist).toEqual([expect.objectContaining({ quantity: 1 })])
})
