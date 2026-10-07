import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { logIn, newUser, registerVerified } from './accounts'

// Steps shared by the deck and binder tests.

export async function signedIn(page: Page) {
  const user = newUser()
  await registerVerified(page.request, user)
  await logIn(page, user.email, user.password)
  await expect(page).toHaveURL(/\/$/) // the dashboard
  return user
}

export async function choose(page: Page, combobox: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: combobox }).click()
  await page.getByRole('option', { name: option }).click()
}

// The card's default printing, with a finish it's printed in.
export async function findCard(request: APIRequestContext, name: string) {
  const { cards } = await (await request.get(`/api/cards?q=${encodeURIComponent(name)}`)).json()
  const id: string = cards.find((c: { name: string }) => c.name === name).id
  const { finishes } = await (await request.get(`/api/cards/${id}`)).json()
  return { id, finish: (finishes.includes('nonfoil') ? 'nonfoil' : finishes[0]) as string }
}

export async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}
