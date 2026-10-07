import { expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { local, newUser, registerVerified, test } from './accounts'
import { choose, findCard, signedIn } from './pages'
import { milestone } from './screenshot'

// Imports create decks and binders, which need verified accounts (local API only).
test.skip(!local, 'creates accounts')

test.beforeAll(async ({ playwright }, testInfo) => {
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

// The exported files, kept as this run's artifact (and diffable between runs).
function keep(name: string, content: string) {
  mkdirSync('e2e-results/exports', { recursive: true })
  writeFileSync(`e2e-results/exports/${name}`, content)
}

const review = (page: Page) => page.getByRole('list', { name: 'Import review' })
const line = (page: Page, n: number) => review(page).getByRole('listitem', { name: `Line ${n}`, exact: true })

test('a user imports a pasted decklist, fixes what did not match, and exports it', async ({ page }, testInfo) => {
  await signedIn(page)
  await page.goto('/decks')
  await page.getByRole('link', { name: 'Import' }).click()
  await page.getByLabel('Deck name').fill('Imported Atraxa')
  await page.getByLabel('Decklist').fill(
    [
      'Commander',
      "1 Atraxa, Praetors' Voice",
      '',
      'Deck',
      '4 Lightning Bolt (LEA) 161',
      '30 Forest *F*',
      '1x Thalia, Guardian of Thraben [Creature]',
      '2 Black Lotus (XYZ) 999',
      '1 Delver of Secret',
      'hello world',
      '',
      'Sideboard',
      '1 Fire // Ice',
    ].join('\n'),
  )
  await page.getByRole('button', { name: 'Review import' }).click()

  await expect(page.getByRole('status')).toHaveText('39 cards ready · 2 lines need a card or dropping')
  await expect(line(page, 2)).toContainText("This printing isn't made in nonfoil, so it's foil.") // Atraxa's default printing is foil-only
  await expect(line(page, 2)).toContainText('Commander')
  await expect(line(page, 5)).toContainText('Limited Edition Alpha (LEA) #161')
  await expect(line(page, 6)).toContainText('Foil')
  await expect(line(page, 7)).toContainText('Mainboard') // an Archidekt category that isn't a section
  await expect(line(page, 8)).toContainText('No printing XYZ #999, so the usual printing is used.')
  await expect(line(page, 9)).toContainText('Line 9: No card is named "Delver of Secret".')
  await expect(line(page, 13)).toContainText('Sideboard')
  await expect(page.getByRole('button', { name: 'Create deck' })).toBeDisabled()
  await milestone(page, testInfo, '70-import-review')

  // Fix the misspelt card, drop the junk line.
  await page.getByRole('combobox', { name: 'Card for line 9' }).fill('delver')
  await page.getByRole('option').filter({ hasText: 'Delver of Secrets' }).click()
  await expect(line(page, 9)).toContainText('Delver of Secrets // Insectile Aberration')
  await line(page, 10).getByRole('button', { name: 'Drop' }).click()
  await expect(page.getByRole('status')).toHaveText('40 cards ready')
  await page.getByRole('button', { name: 'Create deck' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Imported Atraxa' })).toBeVisible()
  await expect(page.getByTestId('deck-count')).toHaveText('39 cards + 1 sideboard')
  await expect(page.getByRole('region', { name: 'Commander', exact: true }).getByRole('listitem', { name: "Atraxa, Praetors' Voice" })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Printing of Lightning Bolt' })).toHaveValue('Limited Edition Alpha (LEA) #161')
  await expect(page.getByRole('combobox', { name: 'Finish of Forest' })).toHaveValue('Foil')
  await expect(page.getByRole('region', { name: 'Sideboard' }).getByRole('listitem', { name: 'Fire // Ice' })).toBeVisible()

  // Export: the download, and the same text read back in matches every printing exactly.
  const deckId = page.url().split('/').at(-1)
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export' }).click()
  expect((await download).suggestedFilename()).toBe('Imported Atraxa.txt')
  const exported = await (await page.request.get(`/api/decks/${deckId}/export`)).text()
  keep('deck.txt', exported)
  expect(exported).toContain("Commander\n1 Atraxa, Praetors' Voice (MUL) 163 *F*\n")
  expect(exported).toContain('4 Lightning Bolt (LEA) 161\n')
  expect(exported).toContain('1 Delver of Secrets (INR) 457\n') // a double-faced card by its front name
  expect(exported).toMatch(/\nSideboard\n1 Fire \/\/ Ice \(DMR\) 215\n$/)
  const again = (await (await page.request.post('/api/import/deck', { data: { text: exported } })).json()).lines
  expect(again.every((l: { card: unknown; note: unknown }) => l.card && !l.note)).toBe(true)
  const deck = await (await page.request.get(`/api/decks/${deckId}`)).json()
  const ids = (list: { scryfallId: string; quantity: number; finish: string }[]) => list.map((e) => `${e.quantity} ${e.scryfallId} ${e.finish}`).sort()
  const reread = again.map((l: { quantity: number; card: { id: string }; finish: string; section: string }) => ({ ...l, scryfallId: l.card.id }))
  expect(ids(reread.filter((l: { section: string }) => l.section === 'mainboard'))).toEqual(ids(deck.mainboard))
})

test('a deck imports from a Moxfield export file', async ({ page }) => {
  await signedIn(page)
  await page.goto('/decks/import')
  await page.locator('input[type=file]').setInputFiles({
    name: 'moxfield-export.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from("1 Atraxa, Praetors' Voice (MUL) 163 *F*\n4 Lightning Bolt\n1 Fire // Ice (DMR) 215\n\nSIDEBOARD:\n1 Black Lotus\n"),
  })
  await expect(page.getByLabel('Deck name')).toHaveValue('moxfield-export')
  await choose(page, 'Format', 'Legacy')
  await page.getByRole('button', { name: 'Review import' }).click()
  await expect(page.getByRole('status')).toHaveText('7 cards ready')
  await page.getByRole('button', { name: 'Create deck' }).click()
  await expect(page.getByTestId('deck-count')).toHaveText('6 cards + 1 sideboard')
  await expect(page.getByRole('region', { name: 'Sideboard' }).getByRole('listitem', { name: 'Black Lotus' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Not legal in Legacy' })).toContainText('Black Lotus is banned in Legacy.')
})

test('a user imports a ManaBox CSV into a binder and exports it as CSV', async ({ page }, testInfo) => {
  await signedIn(page)
  const atraxa = await findCard(page.request, "Atraxa, Praetors' Voice")
  const csv = [
    'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency',
    'Lightning Bolt,lea,Limited Edition Alpha,161,normal,common,2,1,,0.5,false,false,lightly_played,ja,USD',
    `"Atraxa, Praetors' Voice",,,,foil,mythic,1,2,${atraxa.id},0,false,false,near_mint,en,USD`,
    'Black Lotus,,,,normal,rare,1,3,,0,false,false,Mint,English,USD',
    'Fire // Ice,dmr,Dominaria Remastered,215,normal,uncommon,3,4,,0,false,false,good,Klingon,USD',
    'Not A Card,xyz,,1,normal,,1,5,,,,,near_mint,en,USD',
  ].join('\r\n')

  await page.goto('/binders')
  await page.getByRole('link', { name: 'Import' }).click()
  await page.getByLabel('Binder name').fill('From ManaBox')
  await page.getByLabel('CSV').fill(csv)
  await page.getByRole('button', { name: 'Review import' }).click()
  await expect(page.getByRole('status')).toHaveText('7 cards ready · 1 line needs a card or dropping')
  await expect(line(page, 2)).toContainText('LP')
  await expect(line(page, 2)).toContainText('Japanese')
  await expect(line(page, 3)).toContainText('Foil')
  await expect(line(page, 4)).toContainText('NM')
  await expect(line(page, 5)).toContainText('Language "Klingon" isn\'t one Deckino knows.')
  await expect(line(page, 6)).toContainText('No card is named "Not A Card".')
  await milestone(page, testInfo, '71-binder-import-review')
  await line(page, 6).getByRole('button', { name: 'Drop' }).click()
  await page.getByRole('button', { name: 'Create binder' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'From ManaBox' })).toBeVisible()
  await expect(page.getByTestId('binder-count')).toHaveText('7 cards')
  const bolts = page.getByRole('list', { name: 'Cards' }).getByRole('listitem', { name: 'Lightning Bolt' })
  await expect(bolts).toContainText('2×')
  await expect(bolts).toContainText('Limited Edition Alpha (LEA) #161')

  // Export, then read it back: the same cards, conditions and languages.
  const binderId = page.url().split('/').at(-1)
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export CSV' }).click()
  expect((await download).suggestedFilename()).toBe('From ManaBox.csv')
  const exported = await (await page.request.get(`/api/binders/${binderId}/export`)).text()
  keep('binder.csv', exported)
  expect(exported.split('\n')[0]).toBe('Name,Set code,Set name,Collector number,Scryfall ID,Foil,Quantity,Condition,Language,Notes')
  expect(exported).toContain('Lightning Bolt,lea,Limited Edition Alpha,161,')
  expect(exported).toContain(',nonfoil,2,LP,ja,\n')
  expect(exported).toContain(`"Atraxa, Praetors' Voice",`)
  const again = (await (await page.request.post('/api/import/binder', { data: { text: exported } })).json()).lines
  expect(again.map((l: { quantity: number; condition: string; language: string; finish: string; card: { name: string } }) =>
    `${l.quantity} ${l.card.name} ${l.finish} ${l.condition} ${l.language}`).sort()).toEqual([
    "1 Atraxa, Praetors' Voice foil NM en",
    '1 Black Lotus nonfoil NM en',
    '2 Lightning Bolt nonfoil LP ja',
    '3 Fire // Ice nonfoil LP en',
  ])
})

test("imports need a signed-in user, and exports are the owner's only", async ({ page, request }) => {
  expect((await request.post('/api/import/deck', { data: { text: '1 Forest' } })).status()).toBe(401)
  const owner = newUser()
  await registerVerified(request, owner)
  expect((await request.post('/api/account/login', { data: owner })).status()).toBe(200)
  const deck = (await (await request.post('/api/decks', { data: { name: 'Mine', format: 'casual', cards: {} } })).json()).id
  const binder = (await (await request.post('/api/binders', { data: { name: 'Mine' } })).json()).id

  await signedIn(page)
  expect((await page.request.get(`/api/decks/${deck}/export`)).status()).toBe(404)
  expect((await page.request.get(`/api/binders/${binder}/export`)).status()).toBe(404)
  expect((await page.request.post('/api/import/deck', { data: { text: ' ' } })).status()).toBe(400)
  const bad = await page.request.post('/api/binders/import', {
    data: { name: 'Bad', cards: [{ card: { scryfallId: '00000000-0000-0000-0000-000000000000', finish: 'nonfoil', condition: 'NM', language: 'en' }, copies: 1 }] },
  })
  expect(bad.status()).toBe(400)
  expect((await (await page.request.get('/api/binders')).json())).toEqual([]) // nothing half-created
})

test('decklist sections follow MTGO only in its exact shape, and names prefer real cards', async ({ request }) => {
  const user = newUser()
  await registerVerified(request, user)
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
  const preview = async (text: string) =>
    (await (await request.post('/api/import/deck', { data: { text } })).json()).lines as {
      section: string
      card: { name: string } | null
      problem: string | null
    }[]

  // MTGO: main deck, one blank line, a sideboard of up to 15.
  expect((await preview('4 Lightning Bolt\n20 Forest\n\n2 Black Lotus\n')).map((l) => l.section)).toEqual(['mainboard', 'mainboard', 'sideboard'])
  // Grouped by type with blank lines, or a long second group: all mainboard.
  expect((await preview("1 Thalia, Guardian of Thraben\n\n4 Lightning Bolt\n\n20 Forest\n")).map((l) => l.section)).toEqual([
    'mainboard',
    'mainboard',
    'mainboard',
  ])
  expect((await preview('4 Lightning Bolt\n\n20 Forest\n')).map((l) => l.section)).toEqual(['mainboard', 'mainboard'])

  // Arena's "About" and "Name" lines describe the deck; they aren't cards.
  const arena = await preview('About\nName Mono Red\n\nDeck\n4 Lightning Bolt\n')
  expect(arena.map((l) => [l.section, l.card?.name])).toEqual([['mainboard', 'Lightning Bolt']])

  // The test catalogue has Hushwood Verge only as an art card: a decklist line doesn't mean that, its full name does.
  const [plain, full] = await preview('1 Hushwood Verge\n1 Hushwood Verge // Hushwood Verge\n')
  expect(plain.card).toBeNull()
  expect(plain.problem).toBe('No card is named "Hushwood Verge".')
  expect(full.card?.name).toBe('Hushwood Verge // Hushwood Verge')
})

test('notes that look like formulas survive a CSV export and import', async ({ request }) => {
  const user = newUser()
  await registerVerified(request, user)
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)
  const bolt = await findCard(request, 'Lightning Bolt')
  const binder = (await (await request.post('/api/binders', { data: { name: 'Notes' } })).json()).id
  for (const notes of ['-signed by the artist', '=SUM(A1:A9)', "'=quoted on purpose"]) {
    await request.post(`/api/binders/${binder}/cards`, { data: { card: { scryfallId: bolt.id, finish: bolt.finish, condition: 'NM', language: 'en', notes } } })
  }
  const exported = await (await request.get(`/api/binders/${binder}/export`)).text()
  expect(exported).toContain(",'-signed by the artist\n") // a spreadsheet shows it as text
  expect(exported).toContain(",'=SUM(A1:A9)\n")
  const lines = (await (await request.post('/api/import/binder', { data: { text: exported } })).json()).lines
  expect(lines.map((l: { notes: string }) => l.notes).sort()).toEqual(["'=quoted on purpose", '-signed by the artist', '=SUM(A1:A9)'])
})

test('a deck import over 99 copies of a printing says so instead of cutting it', async ({ page }) => {
  await signedIn(page)
  await page.goto('/decks/import')
  await page.getByLabel('Deck name').fill('Too many')
  await page.getByLabel('Decklist').fill('60 Forest\n60 Forest\n')
  await page.getByRole('button', { name: 'Review import' }).click()
  await expect(page.getByRole('status')).toHaveText('120 cards ready')
  await page.getByRole('button', { name: 'Create deck' }).click()
  await expect(page.getByRole('alert')).toContainText('A deck holds at most 99 copies of a printing in one finish: Forest has 120.')
  await expect(page).toHaveURL(/\/decks\/import$/) // nothing created
  expect(await (await page.request.get('/api/decks')).json()).toEqual([])
})
