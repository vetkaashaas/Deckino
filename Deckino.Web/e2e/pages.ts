import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { logIn, newUser, registerVerified } from './accounts'

// Steps shared by the deck and binder tests.

export async function signedIn(page: Page) {
  const user = newUser()
  await registerVerified(page.request, user)
  await logIn(page, user.email, user.password)
  await expect(page).toHaveURL(/\/$/) // the dashboard
  return user
}

// Picks an option of a select, found in the page or within one part of it (a dialog, say).
export async function choose(scope: Page | Locator, combobox: string, option: string | RegExp) {
  await scope.getByRole('combobox', { name: combobox }).click()
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page)
  await page.getByRole('option', { name: option }).click()
}

// The card's default printing, with a finish it's printed in.
export async function findCard(request: APIRequestContext, name: string) {
  const { cards } = await (await request.get(`/api/cards?q=${encodeURIComponent(name)}`)).json()
  const id: string = cards.find((c: { name: string }) => c.name === name).id
  const { finishes } = await (await request.get(`/api/cards/${id}`)).json()
  return { id, finish: (finishes.includes('nonfoil') ? 'nonfoil' : finishes[0]) as string }
}

// Sets the currency as the account page does (it is remembered in the browser) and reloads the page.
export async function pickCurrency(page: Page, currency: 'usd' | 'eur') {
  await page.evaluate((c) => localStorage.setItem('deckino.currency', c), currency)
  await page.reload()
}

// Against the screen's width: a phone (isMobile) widens window.innerWidth to fit content that overflows.
export async function expectNoSidewaysScroll(page: Page) {
  const width = page.viewportSize()!.width
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(overflow - width).toBeLessThanOrEqual(0)
}
