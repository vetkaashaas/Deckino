import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { local, newUser, registerVerified, test, type User } from './accounts'
import { findCard, signedIn } from './pages'
import { milestone } from './screenshot'

// App Phases A4 and A5: the app saves a scan tray to a binder in one request (POST /cards/batch), undoes it
// (POST /cards/remove), and cards whose printing nobody checked say so on the website. The API test writes every
// call's status to e2e-results/scan-to-binder/<test>.txt (no ids, so two runs diff clean).
test.skip(!local, 'creates accounts')

test.beforeAll(async ({ playwright }, testInfo) => {
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

function transcript(name: string) {
  const lines: string[] = []
  return {
    async call(label: string, response: Promise<APIResponse>) {
      const answer = await response
      lines.push(`${label} -> ${answer.status()}`)
      return answer
    },
    note(line: string) {
      lines.push(line)
    },
    save() {
      mkdirSync('e2e-results/scan-to-binder', { recursive: true })
      writeFileSync(`e2e-results/scan-to-binder/${name}.txt`, lines.join('\n') + '\n')
      return test.info().attach(name, { body: lines.join('\n'), contentType: 'text/plain' })
    },
  }
}

async function bearer(request: APIRequestContext, user: User) {
  const response = await request.post('/api/auth/token', { data: { email: user.email, password: user.password } })
  expect(response.status()).toBe(200)
  return { Authorization: `Bearer ${(await response.json()).accessToken}` }
}

interface Detail {
  cards: { id: string; printingConfirmed: boolean; card: { name: string; rarity: string } }[]
}

test('the app adds a scan tray in one request, undoes it, and only its own binders', async ({ request }) => {
  const log = transcript('batch')
  const owner = newUser()
  const stranger = newUser()
  await registerVerified(request, owner)
  await registerVerified(request, stranger)
  const mine = await bearer(request, owner)
  const theirs = await bearer(request, stranger)

  const created = await log.call('create binder', request.post('/api/binders', { headers: mine, data: { name: 'Trades' } }))
  const binder: string = (await created.json()).id
  const bolt = await findCard(request, 'Lightning Bolt')
  const forest = await findCard(request, 'Forest')
  const card = (c: { id: string; finish: string }, printingConfirmed?: boolean) =>
    ({ scryfallId: c.id, finish: c.finish, condition: 'NM', language: 'en', printingConfirmed })

  // A tray: two unchecked Bolts, one Forest the user checked, one card website-style (no flag: checked).
  const tray = {
    cards: [
      { card: card(bolt, false), copies: 2 },
      { card: card(forest, true), copies: 1 },
      { card: card(bolt), copies: 1 },
    ],
  }
  const saved = await log.call('add the tray', request.post(`/api/binders/${binder}/cards/batch`, { headers: mine, data: tray }))
  expect(saved.status()).toBe(200)
  const { binder: detail, added } = (await saved.json()) as { binder: Detail; added: string[] }
  expect(added).toHaveLength(4)
  const unchecked = detail.cards.filter((c) => !c.printingConfirmed).map((c) => c.card.name)
  log.note(`unchecked after adding: ${unchecked.join(', ')}`)
  expect(unchecked).toEqual(['Lightning Bolt', 'Lightning Bolt'])
  expect(detail.cards[0].card.rarity).toBeTruthy() // the set strip's symbol colour

  // The binder list has each binder's value, in the currency asked for.
  const list = await (await log.call('list binders in EUR', request.get('/api/binders?currency=eur', { headers: mine }))).json()
  expect(list[0]).toMatchObject({ name: 'Trades', cardCount: 4, value: expect.any(Number) })

  // All or nothing: one bad line (a finish the printing isn't made in) adds none of them.
  const bad = { cards: [{ card: card(bolt, false), copies: 1 }, { card: { ...card(forest), finish: 'etched' }, copies: 1 }] }
  const refused = await log.call('a tray with a bad line', request.post(`/api/binders/${binder}/cards/batch`, { headers: mine, data: bad }))
  expect(refused.status()).toBe(400)
  expect((await refused.json()).errors.cards[0]).toMatch(/^Card 2: /)
  expect((await log.call('an empty tray', request.post(`/api/binders/${binder}/cards/batch`, { headers: mine, data: { cards: [] } }))).status()).toBe(400)

  // Another user's token: the binder doesn't exist for them.
  expect((await log.call("add to someone else's binder",
    request.post(`/api/binders/${binder}/cards/batch`, { headers: theirs, data: tray }))).status()).toBe(404)
  expect((await log.call("remove from someone else's binder",
    request.post(`/api/binders/${binder}/cards/remove`, { headers: theirs, data: { cardIds: added } }))).status()).toBe(404)

  // Undo: a list with a card that isn't in the binder removes nothing; the tray's own ids remove exactly those.
  expect((await log.call('remove with a stranger id',
    request.post(`/api/binders/${binder}/cards/remove`, { headers: mine, data: { cardIds: [...added, crypto.randomUUID()] } }))).status()).toBe(404)
  const undone = await log.call('undo the tray', request.post(`/api/binders/${binder}/cards/remove`, { headers: mine, data: { cardIds: added } }))
  expect(((await undone.json()) as Detail).cards).toHaveLength(0)
  await log.save()
})

test('the website flags scanned cards whose printing nobody checked, and one click confirms them', async ({ page }, testInfo) => {
  await signedIn(page)
  const created = await page.request.post('/api/binders', { data: { name: 'Scanned' } })
  const binder: string = (await created.json()).id
  const bolt = await findCard(page.request, 'Lightning Bolt')
  const scanned = { scryfallId: bolt.id, finish: bolt.finish, condition: 'NM', language: 'en', printingConfirmed: false }
  expect((await page.request.post(`/api/binders/${binder}/cards/batch`, { data: { cards: [{ card: scanned, copies: 2 }] } })).status()).toBe(200)

  await page.goto(`/binders/${binder}`)
  await expect(page.getByText('2 scanned cards might be a different printing')).toBeVisible()
  const row = page.getByRole('list', { name: 'Cards' }).getByRole('listitem', { name: 'Lightning Bolt', exact: true })
  await expect(row.getByText('Check printing')).toBeVisible()
  await milestone(page, testInfo, 'a5-01-website-check-printing')

  await row.getByRole('button', { name: 'More actions for Lightning Bolt' }).click()
  await page.getByRole('menuitem', { name: 'Printing is right' }).click()
  await expect(page.getByText('might be a different printing')).toBeHidden()
  await expect(row.getByText('Check printing')).toBeHidden()
  const detail = (await (await page.request.get(`/api/binders/${binder}`)).json()) as Detail
  expect(detail.cards.every((c) => c.printingConfirmed)).toBe(true)
})
