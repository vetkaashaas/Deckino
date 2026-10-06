import type { Page, TestInfo } from '@playwright/test'

// Saves a milestone screenshot to e2e-results/screenshots and attaches it to the HTML report.
export async function milestone(page: Page, testInfo: TestInfo, name: string) {
  const path = `e2e-results/screenshots/${name}.png`
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
