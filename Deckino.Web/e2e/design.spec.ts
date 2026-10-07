import { expect, test, type Page } from '@playwright/test'
import { milestone } from './screenshot'

const sections = ['Colour', 'Type', 'Buttons', 'Form fields', 'Feedback', 'Dialog', 'Cards']

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test('the style guide shows every component, and the dialog opens and closes', async ({ page }, testInfo) => {
  await page.goto('/styleguide')
  for (const name of sections) await expect(page.getByRole('region', { name })).toBeVisible()

  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep account' }).click()
  await expect(dialog).toBeHidden()

  await milestone(page, testInfo, '06-styleguide-desktop')
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('the menu replaces the header links and navigates', async ({ page }, testInfo) => {
    await page.goto('/')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Cards' }).click()
    await expect(page).toHaveURL(/\/cards$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Cards' })).toBeVisible()

    await page.getByLabel('Card name').fill('lightning bolt')
    await page.getByLabel('Card name').press('Enter')
    await expect(page.getByRole('list', { name: 'Search results' })).toBeVisible()
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '07-phone-card-search')
  })

  test('the card page fits the screen', async ({ page }, testInfo) => {
    await page.goto('/cards?q=delver of secrets')
    await page.getByRole('list', { name: 'Search results' }).getByRole('link').first().click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delver of Secrets // Insectile Aberration')
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '08-phone-card-page')
  })

  test('the style guide fits the screen', async ({ page }, testInfo) => {
    await page.goto('/styleguide')
    await expect(page.getByRole('region', { name: 'Cards' })).toBeVisible()
    await expectNoSidewaysScroll(page)
    await milestone(page, testInfo, '09-styleguide-phone')
  })
})
