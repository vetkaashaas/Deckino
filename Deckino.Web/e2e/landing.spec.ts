import { expect, type Page } from '@playwright/test'
import { local, test } from './accounts'
import { expectNoSidewaysScroll, signedIn } from './pages'
import { milestone } from './screenshot'

test.beforeAll(async ({ playwright }, testInfo) => {
  if (!local) return
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true)
  await api.dispose()
})

interface Commander {
  id: string
  name: string
  images: string[]
}

const card = (page: Page) => page.getByTestId('commander-card')
const style = (page: Page, selector: string, property: 'animationName' | 'transform') =>
  page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], property)
const untilted = (transform: string) => transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)'
const tilt = (page: Page) => style(page, '[data-testid="commander-card"] > div', 'transform')

test('a visitor sees the landing page, and the Commander of the Day opens its card page', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: /Your Magic collection/ })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: 'Create a free account' }).first()).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: 'Browse cards' })).toBeVisible()
  for (const name of ['Everything your collection needs', 'Deckino in your pocket', 'Pricing']) {
    await expect(page.getByRole('region', { name })).toBeVisible()
  }
  for (const name of ['Scan your cards', 'Build decks', 'Keep binders', 'Track a wishlist', 'Follow prices', 'Share by link']) {
    await expect(page.getByRole('heading', { level: 3, name })).toBeVisible()
  }
  await expect(page.getByRole('link', { name: 'Coming soon to the App Store' })).toHaveAttribute('href', '#')
  await expect(page.getByRole('link', { name: 'Coming soon to Google Play' })).toHaveAttribute('href', '#')
  await expect(page.getByRole('article', { name: 'Supporter plan' })).toContainText('$1/month')

  const commander: Commander = await (await page.request.get('/api/commander-of-the-day')).json()
  const widget = page.getByTestId('commander-of-the-day')
  await expect(widget).toContainText('Commander of the Day')
  await expect(widget).toContainText(commander.name)
  await expect(widget.getByRole('img', { name: commander.name, exact: true })).toHaveAttribute('src', commander.images[0])

  // It floats, and tilts towards the pointer.
  expect(await style(page, '[data-testid="commander-card"]', 'animationName')).not.toBe('none')
  const box = (await card(page).boundingBox())!
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.2)
  await expect.poll(async () => untilted(await tilt(page))).toBe(false)
  await milestone(page, testInfo, '90-landing')

  await widget.getByRole('link', { name: `${commander.name}, Commander of the Day` }).click()
  await expect(page).toHaveURL(new RegExp(`/cards/${commander.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: commander.name })).toBeVisible()
})

test('the home page has a link preview with an absolute image', async ({ request, baseURL }) => {
  const html = await (await request.get('/')).text()
  expect(html).toContain('<meta property="og:title" content="Deckino: your Magic collection, decks and binders" />')
  expect(html).toContain(`<meta property="og:image" content="${baseURL}/og-image.png" />`)
  expect(html).toContain(`<meta property="og:url" content="${baseURL}/" />`)
  const indexHtml = await (await request.get('/index.html')).text() // the same page, not the raw file
  expect(indexHtml).toContain(`<meta property="og:image" content="${baseURL}/og-image.png" />`)
  const image = await request.get('/og-image.png')
  expect(image.status()).toBe(200)
  expect(image.headers()['content-type']).toBe('image/png')
})

test('the Commander of the Day is commander-legal and the same across requests', async ({ page }) => {
  test.skip(!local, 'creates accounts')
  const first: Commander = await (await page.request.get('/api/commander-of-the-day')).json()
  const second: Commander = await (await page.request.get('/api/commander-of-the-day')).json()
  expect(second).toEqual(first)
  // Not just the cache: picked again from the catalogue, it is the same card.
  expect((await page.request.delete('/api/dev/commander-of-the-day')).status()).toBe(204)
  const recomputed: Commander = await (await page.request.get('/api/commander-of-the-day')).json()
  expect(recomputed).toEqual(first)

  // The deck legality rules accept it as a Commander deck's commander.
  await signedIn(page)
  const { finishes } = await (await page.request.get(`/api/cards/${first.id}`)).json()
  const warnings: string[] = await (await page.request.post('/api/decks/legality', {
    data: { format: 'commander', cards: { commander: [{ scryfallId: first.id, quantity: 1, finish: finishes[0] }] } },
  })).json()
  expect(warnings.filter((w) => w.includes(first.name))).toEqual([])
  expect(warnings).not.toContainEqual(expect.stringContaining("can't be your commander"))
})

test('with reduced motion the Commander of the Day stays still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(card(page).getByRole('img').first()).toBeVisible()
  expect(await style(page, '[data-testid="commander-card"]', 'animationName')).toBe('none')
  const box = (await card(page).boundingBox())!
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.2)
  await page.waitForTimeout(200)
  expect(untilted(await tilt(page))).toBe(true)
})

test('the landing page keeps its translucent header at /about/ too', async ({ page }) => {
  await page.goto('/About/')
  await expect(page.getByRole('heading', { level: 1, name: /Your Magic collection/ })).toBeVisible()
  await expect(page.getByRole('banner')).toHaveAttribute('data-over-hero', 'true')
})

test('account pages are full-page, without the site header', async ({ page }, testInfo) => {
  for (const path of ['/login', '/register', '/forgot-password']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('banner')).toHaveCount(0)
    await expect(page.getByText('Deckino is unofficial Fan Content')).toBeVisible()
  }
  await page.goto('/login')
  await expect(page.getByTestId('commander-of-the-day')).toBeVisible()
  await milestone(page, testInfo, '91-login-page')
  await page.getByRole('link', { name: 'Deckino home' }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: /Your Magic collection/ })).toBeVisible()
})

test('a signed-in user reaches the landing page from the footer', async ({ page }) => {
  test.skip(!local, 'creates accounts')
  await signedIn(page)
  await page.getByRole('link', { name: 'About Deckino' }).click()
  await expect(page).toHaveURL(/\/about$/)
  await expect(page.getByRole('heading', { level: 1, name: /Your Magic collection/ })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: 'Go to your dashboard' })).toBeVisible()
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the landing and login pages fit the screen', async ({ page }, testInfo) => {
    await page.goto('/')
    await expect(page.getByTestId('commander-of-the-day')).toBeVisible()
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '92-phone-landing')

    await page.goto('/login')
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible()
    await expect(page.getByTestId('commander-of-the-day')).toBeHidden()
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '93-phone-login')
  })
})
