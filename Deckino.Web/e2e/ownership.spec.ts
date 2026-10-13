import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { local, newUser, registerVerified, test, type User } from './accounts'
import { findCard } from './pages'

// App Phase A7: the scanner's "do I own this?" (POST /api/collection/lookup) and the app's wishlist batch, which the
// scan tray and every undo use (POST /api/wishlist/batch). Writes every call's status and the answers (names, no ids)
// to e2e-results/ownership/lookup.txt, so two runs diff clean.
test.skip(!local, 'creates accounts')

test.beforeAll(async ({ playwright }, testInfo) => {
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

async function bearer(request: APIRequestContext, user: User) {
  const response = await request.post('/api/auth/token', { data: { email: user.email, password: user.password } })
  expect(response.status()).toBe(200)
  return { Authorization: `Bearer ${(await response.json()).accessToken}` }
}

interface Ownership {
  oracleId: string
  owned: number
  wanted: number
  decks: { id: string; name: string }[]
}

test('the lookup counts owned, wanted and deck copies by Oracle card, only for the owner; the batch undoes exactly', async ({ request }) => {
  const lines: string[] = []
  const call = async (label: string, response: Promise<APIResponse>) => {
    const answer = await response
    lines.push(`${label} -> ${answer.status()}`)
    return answer
  }
  const owner = newUser()
  const stranger = newUser()
  await registerVerified(request, owner)
  await registerVerified(request, stranger)
  const mine = await bearer(request, owner)
  const theirs = await bearer(request, stranger)

  const bolt = await findCard(request, 'Lightning Bolt')
  const forest = await findCard(request, 'Forest')
  const krenko = await findCard(request, 'Krenko, Mob Boss')
  const oracle = async (id: string) => ((await (await request.get(`/api/cards/${id}`)).json()) as { oracleId: string }).oracleId
  const names = new Map([[await oracle(bolt.id), 'Lightning Bolt'], [await oracle(forest.id), 'Forest'], [await oracle(krenko.id), 'Krenko, Mob Boss']])
  const oracleIds = [...names.keys()]

  // Owned: two Bolts in a binder. Wanted: three Forests. A Burn deck plays the Bolt; its maybeboard Krenko doesn't count.
  const binder = (await (await call('create binder', request.post('/api/binders', { headers: mine, data: { name: 'Trades' } }))).json()).id
  const copy = { scryfallId: bolt.id, finish: bolt.finish, condition: 'NM', language: 'en' }
  await call('add 2 Bolts', request.post(`/api/binders/${binder}/cards/batch`, { headers: mine, data: { cards: [{ card: copy, copies: 2 }] } }))
  const wanted = await call('want 3 Forests', request.post('/api/wishlist/batch', { headers: mine, data: { cards: [{ scryfallId: forest.id, quantity: 3 }] } }))
  expect((await wanted.json()).applied).toEqual([{ scryfallId: forest.id, quantity: 3 }])
  const cards = {
    commander: [],
    mainboard: [{ scryfallId: bolt.id, quantity: 1, finish: bolt.finish }],
    sideboard: [{ scryfallId: krenko.id, quantity: 1, finish: krenko.finish }],
  }
  await call('create Burn deck', request.post('/api/decks', { headers: mine, data: { name: 'Burn', format: 'commander', cards } }))

  const describe = (answer: Ownership[]) =>
    answer.map((o) => `${names.get(o.oracleId)}: owned ${o.owned}, wanted ${o.wanted}, decks [${o.decks.map((d) => d.name).join(', ')}]`)
  const looked = await call('look up 3 cards', request.post('/api/collection/lookup', { headers: mine, data: { oracleIds } }))
  const answer = describe(await looked.json())
  lines.push(...answer)
  expect(answer).toEqual([
    'Lightning Bolt: owned 2, wanted 0, decks [Burn]',
    'Forest: owned 0, wanted 3, decks []',
    'Krenko, Mob Boss: owned 0, wanted 0, decks []',
  ])

  // Someone else sees only their own (nothing); signed out, nothing at all.
  const strangers = describe(await (await call('look up as someone else', request.post('/api/collection/lookup', { headers: theirs, data: { oracleIds } }))).json())
  expect(strangers.every((line) => line.endsWith('owned 0, wanted 0, decks []'))).toBe(true)
  expect((await call('look up signed out', request.post('/api/collection/lookup', { data: { oracleIds } }))).status()).toBe(401)
  expect((await call('look up nothing', request.post('/api/collection/lookup', { headers: mine, data: { oracleIds: [] } }))).status()).toBe(400)
  const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID())
  expect((await call('look up 101 cards', request.post('/api/collection/lookup', { headers: mine, data: { oracleIds: tooMany } }))).status()).toBe(400)

  // The batch keeps to 1-99 a printing and answers what really changed, so undo (the opposite) is exact.
  const full = await call('want 98 more Forests', request.post('/api/wishlist/batch', { headers: mine, data: { cards: [{ scryfallId: forest.id, quantity: 98 }] } }))
  const applied = (await full.json()).applied as { scryfallId: string; quantity: number }[]
  lines.push(`applied: ${applied.map((a) => a.quantity).join(', ')}`)
  expect(applied).toEqual([{ scryfallId: forest.id, quantity: 96 }])
  const undo = applied.map((a) => ({ scryfallId: a.scryfallId, quantity: -a.quantity }))
  const undone = await call('undo', request.post('/api/wishlist/batch', { headers: mine, data: { cards: undo } }))
  expect((await undone.json()).cards).toMatchObject([{ scryfallId: forest.id, quantity: 3 }])
  const gone = await call('take all 3 away', request.post('/api/wishlist/batch', { headers: mine, data: { cards: [{ scryfallId: forest.id, quantity: -3 }] } }))
  expect((await gone.json()).cards).toEqual([])
  expect((await call('an empty batch', request.post('/api/wishlist/batch', { headers: mine, data: { cards: [] } }))).status()).toBe(400)
  expect((await call('a card that does not exist', request.post('/api/wishlist/batch', {
    headers: mine, data: { cards: [{ scryfallId: crypto.randomUUID(), quantity: 1 }] },
  }))).status()).toBe(400)

  mkdirSync('e2e-results/ownership', { recursive: true })
  writeFileSync('e2e-results/ownership/lookup.txt', lines.join('\n') + '\n')
  await test.info().attach('lookup', { body: lines.join('\n'), contentType: 'text/plain' })
})
