import { expect, test } from '@playwright/test'
import { milestone } from './screenshot'

// Phase 14: every account email, rendered with sample data by the development-only preview endpoint. The
// screenshots (desktop and phone width) are the repeatable artifact of the templates. Real sending (Mailgun) is
// never exercised here: the E2E API blanks Mailgun:ApiKey, so the account tests keep reading the logged links.
const emails = [
  { name: 'verify-email', heading: 'Welcome to Deckino, Jace_Beleren', button: 'Verify my email', link: /\/verify-email\?userId=.*&token=sample-token$/ },
  { name: 'reset-password', heading: 'Reset your password', button: 'Choose a new password', link: /\/reset-password\?userId=.*&token=sample-token$/ },
  { name: 'already-registered', heading: 'You already have an account', button: 'Log in to Deckino', link: /\/login$/ },
]

for (const [index, email] of emails.entries()) {
  test(`the ${email.name} email renders as HTML and plain text`, async ({ page, request }, testInfo) => {
    await page.goto(`/api/dev/emails/${email.name}`)
    await expect(page.getByRole('heading', { level: 1, name: email.heading })).toBeVisible()
    const button = page.getByRole('link', { name: email.button })
    await expect(button).toHaveAttribute('href', email.link)
    // The fallback repeats the button's link as text, for clients that break the button.
    await expect(page.getByRole('link', { name: (await button.getAttribute('href'))! })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Deckino' })).toHaveJSProperty('complete', true)
    expect(await page.getByRole('img', { name: 'Deckino' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await expect(page.getByRole('link', { name: 'support@deckino.com' })).toHaveAttribute('href', 'mailto:support@deckino.com')
    expect(await page.content()).not.toContain('{{')
    await milestone(page, testInfo, `95-email-${index + 1}-${email.name}`)

    await page.setViewportSize({ width: 375, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await milestone(page, testInfo, `95-email-${index + 1}-${email.name}-phone`)

    const text = await (await request.get(`/api/dev/emails/${email.name}?format=text`)).text()
    expect(text).toMatch(new RegExp((await button.getAttribute('href'))!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    expect(text).toContain('support@deckino.com')
    expect(text).not.toContain('{{')
    expect(text).not.toContain('<')
  })
}

test('an unknown email preview is a 404', async ({ request }) => {
  expect((await request.get('/api/dev/emails/nope')).status()).toBe(404)
})
