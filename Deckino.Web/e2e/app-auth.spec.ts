import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { emailLink, local, newUser, registerVerified, test, type User } from './accounts'

// App Phase A3: the mobile app signs in with bearer tokens (POST /api/auth/token) next to the website's cookie.
// API-only tests; each writes the status of every call to e2e-results/app-auth/<test>.txt (no ids, so two runs
// diff clean) and attaches it to the report.
test.skip(!local, 'creates accounts')

interface Tokens {
  tokenType: string
  accessToken: string
  expiresIn: number
  refreshToken: string
}

function transcript(name: string) {
  const lines: string[] = []
  return {
    async call(label: string, response: Promise<APIResponse>) {
      const answer = await response
      lines.push(`${label} -> ${answer.status()}`)
      return answer
    },
    save() {
      mkdirSync('e2e-results/app-auth', { recursive: true })
      writeFileSync(`e2e-results/app-auth/${name}.txt`, lines.join('\n') + '\n')
      return test.info().attach(name, { body: lines.join('\n'), contentType: 'text/plain' })
    },
  }
}

const bearer = (tokens: Tokens) => ({ Authorization: `Bearer ${tokens.accessToken}` })

async function token(request: APIRequestContext, user: User, password = user.password): Promise<Tokens> {
  const response = await request.post('/api/auth/token', { data: { email: user.email, password } })
  expect(response.status()).toBe(200)
  return response.json()
}

test('the app logs in with the website rules, refreshes, and its token works everywhere the cookie does', async ({ request }) => {
  const log = transcript('token-login')
  const user = newUser()
  expect((await request.post('/api/account/register', { data: user })).status()).toBe(204)

  // Before verifying: only the right password learns that the email needs verifying, as on the website.
  const unverified = await log.call('token before verifying', request.post('/api/auth/token', { data: user }))
  expect(unverified.status()).toBe(403)
  const wrong = await log.call('token, wrong password',
    request.post('/api/auth/token', { data: { email: user.email, password: 'not the password' } }))
  const unknown = await log.call('token, unknown email',
    request.post('/api/auth/token', { data: { email: `nobody-${user.email}`, password: user.password } }))
  expect(wrong.status()).toBe(401)
  expect(unknown.status()).toBe(401)
  expect((await wrong.json()).detail).toBe((await unknown.json()).detail)

  const link = new URL(await emailLink(request, user.email, 'Verify your email'), 'http://x').searchParams
  expect((await request.post('/api/account/verify-email', {
    data: { userId: link.get('userId'), token: link.get('token') },
  })).status()).toBe(204)

  const tokens = await token(request, user)
  expect(tokens.tokenType).toBe('Bearer')
  expect(tokens.expiresIn).toBe(3600)
  // No cookie: the app never gets one.
  expect((await request.storageState()).cookies.find((c) => c.name === 'deckino.auth')).toBeUndefined()

  const me = await log.call('me with the token', request.get('/api/account/me', { headers: bearer(tokens) }))
  expect(await me.json()).toMatchObject({ username: user.username, email: user.email, createdAt: expect.any(String) })
  expect((await log.call('me without it', request.get('/api/account/me'))).status()).toBe(401)
  expect((await log.call('binders with the token',
    request.post('/api/binders', { headers: bearer(tokens), data: { name: 'App binder' } }))).status()).toBe(201)
  expect((await log.call('me with a forged token',
    request.get('/api/account/me', { headers: { Authorization: 'Bearer not-a-token' } }))).status()).toBe(401)

  // Refresh: a new pair; the refresh token can't be used as an access token, nor junk as a refresh token.
  const refreshed = await log.call('refresh', request.post('/api/auth/refresh', { data: { refreshToken: tokens.refreshToken } }))
  expect(refreshed.status()).toBe(200)
  const next: Tokens = await refreshed.json()
  expect((await log.call('me with the refreshed token', request.get('/api/account/me', { headers: bearer(next) }))).status()).toBe(200)
  expect((await log.call('refresh token as access token',
    request.get('/api/account/me', { headers: { Authorization: `Bearer ${tokens.refreshToken}` } }))).status()).toBe(401)
  expect((await log.call('refresh with junk', request.post('/api/auth/refresh', { data: { refreshToken: 'junk' } }))).status()).toBe(401)
  expect((await log.call('refresh with nothing', request.post('/api/auth/refresh', { data: {} }))).status()).toBe(401)
  await log.save()
})

test("a password change on the website ends the app's session at once; the app's own changes keep it", async ({ request, playwright, baseURL }) => {
  const log = transcript('password-change')
  const user = newUser()
  await registerVerified(request, user)
  const app = await token(request, user)

  // The website (cookie) changes the password: the app's access and refresh tokens stop working.
  const site = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Real-IP': `10.250.0.${Math.floor(Math.random() * 254) + 1}` } })
  expect((await site.post('/api/account/login', { data: user })).status()).toBe(200)
  const newPassword = 'second horse battery'
  expect((await log.call('website changes the password', site.put('/api/account/password',
    { data: { currentPassword: user.password, newPassword } }))).status()).toBe(204)
  expect((await log.call('app token after it', request.get('/api/account/me', { headers: bearer(app) }))).status()).toBe(401)
  expect((await log.call('app refresh after it',
    request.post('/api/auth/refresh', { data: { refreshToken: app.refreshToken } }))).status()).toBe(401)
  expect((await log.call('website still signed in', site.get('/api/account/me'))).status()).toBe(200)

  // The app changes the username and password itself: it gets a fresh pair, and the website is signed out.
  const signedIn = await token(request, user, newPassword)
  const renamed = await log.call('app changes the username', request.put('/api/account/username',
    { headers: bearer(signedIn), data: { username: `${user.username.slice(0, 17)}_v2` } }))
  expect(renamed.status()).toBe(200)
  const afterRename: Tokens = await renamed.json()
  expect((await log.call('old token after the rename', request.get('/api/account/me', { headers: bearer(signedIn) }))).status()).toBe(401)
  expect(await (await request.get('/api/account/me', { headers: bearer(afterRename) })).json())
    .toMatchObject({ username: `${user.username.slice(0, 17)}_v2` })

  const changed = await log.call('app changes the password', request.put('/api/account/password',
    { headers: bearer(afterRename), data: { currentPassword: newPassword, newPassword: 'third horse battery' } }))
  expect(changed.status()).toBe(200)
  const afterChange: Tokens = await changed.json()
  expect((await log.call('me with the new pair', request.get('/api/account/me', { headers: bearer(afterChange) }))).status()).toBe(200)
  expect((await log.call('refresh the new pair',
    request.post('/api/auth/refresh', { data: { refreshToken: afterChange.refreshToken } }))).status()).toBe(200)
  await site.dispose()
  await log.save()
})

test("one account's token can't reach another's data, and a deleted account's token is refused", async ({ request }) => {
  const log = transcript('ownership')
  const [a, b] = [newUser(), newUser()]
  await registerVerified(request, a)
  await registerVerified(request, b)
  const [tokenA, tokenB] = [await token(request, a), await token(request, b)]

  const binder = await (await request.post('/api/binders', { headers: bearer(tokenB), data: { name: "B's binder" } })).json()
  const deck = await (await request.post('/api/decks', { headers: bearer(tokenB), data: { name: "B's deck", format: 'commander' } })).json()
  expect((await log.call("A reads B's binder", request.get(`/api/binders/${binder.id}`, { headers: bearer(tokenA) }))).status()).toBe(404)
  expect((await log.call("A renames B's binder",
    request.put(`/api/binders/${binder.id}`, { headers: bearer(tokenA), data: { name: 'Mine now' } }))).status()).toBe(404)
  expect((await log.call("A reads B's deck", request.get(`/api/decks/${deck.id}`, { headers: bearer(tokenA) }))).status()).toBe(404)
  expect(await (await request.get('/api/binders', { headers: bearer(tokenA) })).json()).toEqual([])
  expect((await log.call('B reads its binder', request.get(`/api/binders/${binder.id}`, { headers: bearer(tokenB) }))).status()).toBe(200)

  // B deletes the account from the app: its token, an hour from expiring, is refused, and can't create rows.
  expect((await log.call('B deletes the account',
    request.delete('/api/account', { headers: bearer(tokenB), data: { password: b.password } }))).status()).toBe(204)
  expect((await log.call('B token after deleting', request.get('/api/account/me', { headers: bearer(tokenB) }))).status()).toBe(401)
  expect((await log.call('B creates a binder after deleting',
    request.post('/api/binders', { headers: bearer(tokenB), data: { name: 'Orphan' } }))).status()).toBe(401)
  expect((await log.call('B refresh after deleting',
    request.post('/api/auth/refresh', { data: { refreshToken: tokenB.refreshToken } }))).status()).toBe(401)
  await log.save()
})

test('training captures and app logs need a signed-in account; the shared key is gone', async ({ request }) => {
  const log = transcript('training-uploads')
  const user = newUser()
  await registerVerified(request, user)
  const tokens = await token(request, user)
  const batch = { session: 'e2e', device: 'Playwright', entries: [{ time: Date.now(), level: 'log', message: 'hello' }] }

  expect((await log.call('app logs signed out', request.post('/api/app-logs', { data: batch }))).status()).toBe(401)
  expect((await log.call('app logs with the old key',
    request.post('/api/app-logs', { data: batch, headers: { 'X-Deckino-Upload-Key': 'anything' } }))).status()).toBe(401)
  expect((await log.call('app logs signed in', request.post('/api/app-logs', { data: batch, headers: bearer(tokens) }))).status()).toBe(200)
  expect((await log.call('training capture signed out', request.post('/api/training-captures', { data: {} }))).status()).toBe(401)
  expect((await log.call('old training capture path', request.post('/api/dev/training-captures', { data: {} }))).status()).toBe(404)
  await log.save()
})
