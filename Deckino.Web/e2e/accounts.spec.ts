import { expect, type Page } from '@playwright/test'
import { emailLink, local, logIn, newUser, registerVerified, test } from './accounts'
import { milestone } from './screenshot'

const header = (page: Page) => page.getByRole('banner')

test('a visitor registers, verifies, manages and deletes their account', async ({ page }, testInfo) => {
  test.skip(!local, 'needs the development email endpoint')
  const user = newUser()

  // Register
  await page.goto('/')
  await header(page).getByRole('link', { name: 'Create account' }).click()
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Username').fill(user.username)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await milestone(page, testInfo, '10-registered')

  // Can't log in before verifying
  await logIn(page, user.email, user.password)
  await expect(page.getByRole('alert').filter({ hasText: 'Verify your email first' })).toBeVisible()

  // Verify, then log in
  await page.goto(await emailLink(page.request, user.email, 'Verify your email'))
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()
  await milestone(page, testInfo, '11-email-verified')
  await page.getByRole('link', { name: 'Log in' }).last().click()
  await logIn(page, user.email, user.password)
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/account') // logging in lands on the dashboard
  await expect(page.getByText(`Signed in as ${user.username}`)).toBeVisible()
  await expect(header(page).getByRole('link', { name: user.username })).toBeVisible()
  await milestone(page, testInfo, '12-account')

  // Change username and password
  const renamed = `${user.username.slice(0, 17)}_v2`
  await page.getByRole('textbox', { name: 'Username' }).fill(renamed)
  await page.getByRole('button', { name: 'Save username' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Username saved' })).toBeVisible()
  await expect(header(page).getByRole('link', { name: renamed })).toBeVisible()

  const newPassword = 'second horse battery'
  await page.getByLabel('Current password').fill(user.password)
  await page.getByLabel('New password').fill(newPassword)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible()

  // Log out, then back in with the new password
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(header(page).getByRole('link', { name: 'Log in' })).toBeVisible()
  await logIn(page, user.email, user.password)
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.')
  await logIn(page, user.email, newPassword)
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/account') // logging in lands on the dashboard
  await page.getByRole('button', { name: 'Log out' }).click()

  // Reset the password by email
  await page.goto('/login')
  await page.getByRole('link', { name: 'Forgot your password?' }).click()
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
  await page.getByLabel('Email').fill(user.email)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.goto(await emailLink(page.request, user.email, 'Reset your password'))
  const resetPassword = 'third horse battery'
  await page.getByLabel('New password').fill(resetPassword)
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible()
  await milestone(page, testInfo, '13-password-reset')
  await logIn(page, user.email, resetPassword)
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/account') // logging in lands on the dashboard

  // Delete the account
  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
  await dialog.getByLabel('Enter your password to confirm').fill('not my password')
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(dialog.getByText('Password is incorrect.')).toBeVisible()
  await milestone(page, testInfo, '14-delete-account')
  await dialog.getByLabel('Enter your password to confirm').fill(resetPassword)
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(header(page).getByRole('link', { name: 'Log in' })).toBeVisible()
  await logIn(page, user.email, resetPassword)
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.')
})

test('registering with an email that has an account looks the same and changes nothing', async ({ page, request }) => {
  test.skip(!local, 'needs the development email endpoint')
  const owner = newUser()
  await registerVerified(request, owner)

  await page.goto('/register')
  await page.getByLabel('Email').fill(owner.email.toUpperCase())
  await page.getByLabel('Username').fill(newUser().username)
  await page.getByLabel('Password', { exact: true }).fill('attacker password')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  // The owner is told, their password still works, and the attacker's doesn't.
  expect(await emailLink(request, owner.email, 'You already have a Deckino account')).toBe('/login')
  expect((await request.post('/api/account/login', { data: { email: owner.email, password: 'attacker password' } })).status()).toBe(401)
  expect((await request.post('/api/account/login', { data: { email: owner.email, password: owner.password } })).status()).toBe(200)
})

test('usernames follow the rules and are unique regardless of case', async ({ page, request }) => {
  test.skip(!local, 'creates accounts')
  const owner = newUser()
  await registerVerified(request, owner)

  for (const [username, message] of [
    ['ab', 'Use 3 to 20 letters, digits, _ or -.'],
    ['has space', 'Use 3 to 20 letters, digits, _ or -.'],
    ['a'.repeat(21), 'Use 3 to 20 letters, digits, _ or -.'],
    ['Admin', 'That username is reserved. Choose another.'],
    [owner.username.toUpperCase(), `Username '${owner.username.toUpperCase()}' is already taken.`],
  ]) {
    const response = await request.post('/api/account/register', { data: { ...newUser(), username } })
    expect(response.status(), username).toBe(400)
    expect((await response.json()).errors.username, username).toEqual([message])
  }

  // The form shows the server's answer next to the field.
  await page.goto('/register')
  await page.getByLabel('Email').fill(newUser().email)
  await page.getByLabel('Username').fill(owner.username)
  await page.getByLabel('Password', { exact: true }).fill('long enough password')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText(`Username '${owner.username}' is already taken.`)).toBeVisible()
})

test('responses never reveal whether an email has an account', async ({ request }) => {
  test.skip(!local, 'creates an account')
  const owner = newUser()
  await registerVerified(request, owner)
  const unknown = newUser().email

  for (const path of ['/api/account/forgot-password', '/api/account/resend-verification']) {
    expect((await request.post(path, { data: { email: owner.email } })).status()).toBe(204)
    expect((await request.post(path, { data: { email: unknown } })).status()).toBe(204)
  }

  const wrongPassword = await request.post('/api/account/login', { data: { email: owner.email, password: 'wrong password' } })
  const noAccount = await request.post('/api/account/login', { data: { email: unknown, password: 'wrong password' } })
  expect(wrongPassword.status()).toBe(401)
  expect(noAccount.status()).toBe(401)
  expect((await wrongPassword.json()).detail).toBe((await noAccount.json()).detail)
})

test('repeated wrong passwords lock the account, and a password reset unlocks it', async ({ request }) => {
  test.skip(!local, 'needs the development email endpoint')
  const user = newUser()
  await registerVerified(request, user)

  for (let i = 0; i < 5; i++) {
    expect((await request.post('/api/account/login', { data: { email: user.email, password: 'wrong password' } })).status()).toBe(401)
  }
  const locked = await request.post('/api/account/login', { data: user })
  expect(locked.status()).toBe(401)
  expect((await locked.json()).detail).toBe('Email or password is incorrect.') // same answer as a wrong password

  await request.post('/api/account/forgot-password', { data: { email: user.email } })
  const params = new URL(await emailLink(request, user.email, 'Reset your password'), 'http://x').searchParams
  const reset = await request.post('/api/account/reset-password', {
    data: { userId: params.get('userId'), token: params.get('token'), password: 'unlocked horse battery' },
  })
  expect(reset.status()).toBe(204)
  expect((await request.post('/api/account/login', { data: { email: user.email, password: 'unlocked horse battery' } })).status()).toBe(200)
})

test('login attempts are rate limited per client', async ({ request }) => {
  test.skip(!local, 'only locally can a test be its own client IP')
  const attempt = () => request.post('/api/account/login', { data: { email: 'nobody@example.com', password: 'wrong password' } })
  for (let i = 0; i < 10; i++) expect((await attempt()).status()).toBe(401)
  const limited = await attempt()
  expect(limited.status()).toBe(429)
  expect((await limited.json()).title).toBe('Too many attempts. Wait a few minutes, then try again.')
})

test('account pages and API calls need a signed-in user', async ({ page, request }) => {
  expect((await request.get('/api/account/me')).status()).toBe(401)
  expect((await request.put('/api/account/username', { data: { username: 'someone' } })).status()).toBe(401)
  expect((await request.delete('/api/account', { data: { password: 'x' } })).status()).toBe(401)

  await page.goto('/account')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount$/)
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
})

test('after logging in, only same-site return addresses are followed', async ({ page, request }) => {
  test.skip(!local, 'creates an account')
  const user = newUser()
  await registerVerified(request, user)
  await page.goto('/login?returnTo=//evil.example/steal')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test("deleting an account ends that account's other sessions", async ({ browser, request }) => {
  test.skip(!local, 'creates an account')
  const user = newUser()
  await registerVerified(request, user)
  const options = { baseURL: test.info().project.use.baseURL, extraHTTPHeaders: { 'X-Real-IP': '10.200.0.1' } }
  const [first, second] = await Promise.all([browser.newContext(options), browser.newContext(options)])
  for (const context of [first, second]) {
    expect((await context.request.post('/api/account/login', { data: user })).status()).toBe(200)
  }

  expect((await first.request.delete('/api/account', { data: { password: user.password } })).status()).toBe(204)
  expect((await second.request.get('/api/account/me')).status()).toBe(401)
  await Promise.all([first.close(), second.close()])
})

test('re-entering the password on a signed-in account counts towards lockout', async ({ request }) => {
  test.skip(!local, 'creates an account')
  const user = newUser()
  await registerVerified(request, user)
  expect((await request.post('/api/account/login', { data: user })).status()).toBe(200)

  for (let i = 0; i < 5; i++) {
    const wrong = await request.delete('/api/account', { data: { password: 'guess number ' + i } })
    expect(wrong.status()).toBe(400)
  }
  const locked = await request.delete('/api/account', { data: { password: user.password } })
  expect(locked.status()).toBe(400)
  expect((await locked.json()).errors.password).toEqual(['Too many wrong passwords. Try again in 15 minutes.'])
  expect((await request.get('/api/account/me')).status()).toBe(200) // not deleted
})
