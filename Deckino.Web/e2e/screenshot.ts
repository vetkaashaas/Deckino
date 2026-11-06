import type { Page, TestInfo } from '@playwright/test'

// Saves a milestone screenshot to e2e-results/screenshots and attaches it to the HTML report: the whole page, or with
// `where: 'screen'` just what's on screen where the page is scrolled to.
export async function milestone(page: Page, testInfo: TestInfo, name: string, where: 'page' | 'screen' = 'page') {
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
  await page.waitForTimeout(300) // let images finish fading in
  if (where === 'page') {
    await page.evaluate(() => window.scrollTo(0, 0)) // the fixed header belongs at the top of the capture
    await page.waitForTimeout(150) // and sticky bars notice they're back in place (components/sticky.ts)
  }
  const path = `e2e-results/screenshots/${name}.png`
  await page.screenshot({ path, fullPage: where === 'page' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
