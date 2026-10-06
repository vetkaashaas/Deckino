import type { Page, TestInfo } from '@playwright/test'

// Saves a milestone screenshot to e2e-results/screenshots and attaches it to the HTML report.
export async function milestone(page: Page, testInfo: TestInfo, name: string) {
  // Card images are hotlinked from Scryfall: give the visible ones a moment, but never fail a test on the CDN.
  await page
    .waitForFunction(
      () =>
        [...document.images]
          .filter((img) => img.getBoundingClientRect().top < window.innerHeight)
          .every((img) => img.complete && img.naturalWidth > 0),
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {})
  const path = `e2e-results/screenshots/${name}.png`
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
