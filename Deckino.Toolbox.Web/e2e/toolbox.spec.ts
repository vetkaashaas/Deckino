import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseURL, token } from './server.ts'

// Screenshots of every page land in e2e-results/screenshots, for a look after each run.
const screenshots = join(import.meta.dirname, '..', 'e2e-results', 'screenshots')
const imports = join(process.env.E2E_DATA!, 'training', 'camera', 'imports', 'e2e')

const pages = [
  'Scryfall Sync',
  'Dataset Sync',
  'Video Import',
  'Corner Annotator',
  'Card Identification',
  'Photo Library',
  'Card Extraction',
  'Model Training',
]

test.describe.configure({ mode: 'serial' })
let page: Page

// After the images in view have loaded (or failed), so a screenshot shows the page as a person sees it.
const shot = async (name: string) => {
  await page.waitForFunction(() =>
    [...document.images].every((image) => {
      const box = image.getBoundingClientRect()
      return image.complete || box.bottom < 0 || box.top > window.innerHeight
    }),
  )
  await page.screenshot({ path: join(screenshots, `${name}.png`), animations: 'disabled' })
}
const open = async (name: string) => {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
}

test.beforeAll(async ({ browser }) => {
  // Two "photos" of a card on a table, drawn by the browser, as a phone import would leave them.
  mkdirSync(imports, { recursive: true })
  const studio = await browser.newPage({ viewport: { width: 1600, height: 1200 } })
  for (const [name, angle] of [['card-1', -7], ['card-2', 5]] as const) {
    await studio.setContent(`
      <body style="margin:0;height:100vh;display:grid;place-items:center;
                   background:radial-gradient(circle at 30% 20%, #5a4632, #2a1f16)">
        <div style="width:504px;height:704px;border-radius:26px;transform:rotate(${angle}deg);
                    background:linear-gradient(135deg, #7911CB, #440780);box-shadow:0 30px 60px rgba(0,0,0,.6);
                    display:grid;place-items:center">
          <div style="width:88%;height:92%;border-radius:14px;border:6px solid #f4ecdf;background:#1b1022"></div>
        </div>
      </body>`)
    await studio.screenshot({ path: join(imports, `${name}.png`) })
  }
  await studio.close()

  const context = await browser.newContext({ baseURL, viewport: { width: 1600, height: 940 } })
  page = await context.newPage()
  await page.goto(`/api/session?token=${token}`)
  // No model on a throwaway data root: corner suggestions would only report that.
  const reply = await page.request.patch('/api/workspaces/annotator', { data: { useModelSuggestions: false } })
  expect(reply.ok()).toBeTruthy()
})

test('every page renders', async () => {
  for (const [index, name] of pages.entries()) {
    await open(name)
    await shot(`${index + 1}-${name.toLowerCase().replaceAll(' ', '-')}`)
  }
})

test('the API refuses callers without the window token', async ({ request }) => {
  expect((await request.get(`${baseURL}/api/workspaces/shell`)).status()).toBe(401)
})

test('corner annotator places, edits and saves four corners', async () => {
  await open('Corner Annotator')
  const photo = page.locator('img[class*="photo"]')
  await expect(photo).toBeVisible()
  await expect(page.getByText('Loading workspace…')).toBeHidden()

  // A switch keeps the focus after a click, and the shortcuts still work.
  const newestFirst = page.getByRole('switch', { name: 'Newest first' })
  const checked = await newestFirst.isChecked()
  await newestFirst.click()
  await expect(newestFirst).toBeChecked({ checked: !checked })
  await newestFirst.click()
  await expect(newestFirst).toBeChecked({ checked })
  await expect(newestFirst).toBeFocused()
  await expect(page.getByText('Loading workspace…')).toBeHidden()
  await page.keyboard.press('+')
  await expect(page.getByText('120%')).toBeVisible()
  await page.keyboard.press('0')
  await expect(page.getByText('100%')).toBeVisible()
  const box = (await photo.boundingBox())!
  const at = (x: number, y: number) => page.mouse.click(box.x + box.width * x, box.y + box.height * y)
  await at(0.36, 0.22)
  await at(0.64, 0.22)
  await at(0.64, 0.78)
  await at(0.36, 0.78)

  const save = page.getByRole('button', { name: 'Save & next' })
  await expect(save).toBeEnabled()
  await expect(page.getByRole('img', { name: 'The card, straightened' })).toBeVisible()

  // Clicking a marker only selects it: undo still takes back the last corner placed.
  await at(0.36, 0.22)
  await page.keyboard.press('Control+z')
  await expect(save).toBeDisabled()
  await at(0.36, 0.78)
  await expect(save).toBeEnabled()

  // Drag the third marker a little, rotate the labels and undo the rotation, all from the keyboard and mouse.
  await page.mouse.move(box.x + box.width * 0.64, box.y + box.height * 0.78)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.8, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.press('r')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('+')
  await expect(page.getByText('120%')).toBeVisible()
  await page.keyboard.press('0')
  await shot('annotator-four-corners')

  await page.keyboard.press('Enter')
  await expect(page.getByText(/Saved card-\d\.png/)).toBeVisible()
  await expect(page.getByText(/Pending\s+1/)).toBeVisible()
})

test('photo library selects and confirms before deleting', async () => {
  await open('Photo Library')
  const tiles = page.getByRole('checkbox')
  await expect(tiles).toHaveCount(2)
  await expect.poll(() => tiles.first().locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await page.getByText('Annotated', { exact: true }).first().click()
  await expect(tiles).toHaveCount(1)
  await tiles.first().click()
  await expect(tiles.first()).toBeChecked()
  await expect(page.getByText('1 selected')).toBeVisible()

  await page.getByRole('button', { name: 'Delete annotations', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Permanently delete 1 annotation files?')
  // A stray Enter never confirms a deletion.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await shot('photo-library-confirm-delete')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test('a failed call says why and is logged; an item that is gone is never another one', async () => {
  const readOnly = await page.request.patch('/api/workspaces/sync', { data: { displayName: 'x' } })
  expect(readOnly.status()).toBe(500)
  expect(await readOnly.text()).toBe('displayName cannot be changed.')
  // What breaks in the window (PageErrorBoundary) lands in the same log.
  expect((await page.request.post('/api/log', { data: { message: 'A page broke (e2e).', detail: 'at Page' } })).status()).toBe(204)
  const logs = join(process.env.E2E_DATA!, 'training', 'logs')
  const log = readdirSync(logs).map((name) => readFileSync(join(logs, name), 'utf8')).join('')
  expect(log).toContain('PATCH /api/workspaces/sync failed.')
  expect(log).toContain('A page broke (e2e).')

  const gone = await page.request.post('/api/workspaces/photoLibrary/commands/toggleSelected', {
    data: { $ref: 'pageItems', where: { relativePath: 'e2e/no-such-photo.png' } },
  })
  expect(gone.status()).toBe(404)
  expect(await gone.text()).toBe('That item is no longer in pageItems.')
  expect((await page.request.get('/api/no-such-endpoint')).status()).toBe(404)
})

test('narrow windows collapse the sidebar to icons', async () => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await open('Scryfall Sync')
  await shot('compact-sidebar')
})
