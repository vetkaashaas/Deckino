// Renders scripts/og-image.html to public/og-image.png, the 1200×630 link-preview image. Run after branding changes.
import { chromium } from '@playwright/test'
import { pathToFileURL } from 'node:url'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.goto(pathToFileURL(`${import.meta.dirname}/og-image.html`).href)
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: `${import.meta.dirname}/../public/og-image.png` })
await browser.close()
