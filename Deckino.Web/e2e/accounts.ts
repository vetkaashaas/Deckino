import { expect, type APIRequestContext, type Page, test as base } from '@playwright/test'

// Account emails are only logged (until Phase 14); locally the API also exposes them at /api/dev/account-emails,
// which is how these tests follow verification and reset links. Against a deployment that endpoint doesn't
// exist, so the flows that need email are local-only.
export const local = !process.env.BASE_URL

// Every test is its own client IP (the API takes it from X-Real-IP, as Railway's edge sets it), so rate limits don't leak
// between tests.
export const test = base.extend({
  extraHTTPHeaders: async ({}, use) => {
    const byte = () => Math.floor(Math.random() * 254) + 1
    await use({ 'X-Real-IP': `10.${byte()}.${byte()}.${byte()}` })
  },
})

export function newUser() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return { email: `e2e-${id}@example.com`, username: `u_${id}`.slice(0, 20), password: 'correct horse battery' }
}
export type User = ReturnType<typeof newUser>

// The newest emailed link with this subject, as a path on the site under test.
export async function emailLink(request: APIRequestContext, to: string, subject: string) {
  let link: string | undefined
  await expect(async () => {
    const emails: { subject: string; link: string }[] = await (
      await request.get(`/api/dev/account-emails?to=${encodeURIComponent(to)}`)
    ).json()
    link = emails.filter((e) => e.subject === subject).at(-1)?.link
    expect(link).toBeTruthy()
  }).toPass({ timeout: 5_000 })
  const url = new URL(link!.split(' ')[0])
  return url.pathname + url.search
}

export async function registerVerified(request: APIRequestContext, user: User) {
  expect((await request.post('/api/account/register', { data: user })).status()).toBe(204)
  const params = new URL(await emailLink(request, user.email, 'Verify your email'), 'http://x').searchParams
  const verified = await request.post('/api/account/verify-email', {
    data: { userId: params.get('userId'), token: params.get('token') },
  })
  expect(verified.status()).toBe(204)
}

export async function logIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
}
