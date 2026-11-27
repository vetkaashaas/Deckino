import { readFileSync } from 'node:fs'
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { local, test } from './accounts'
import { expectNoSidewaysScroll, signedIn } from './pages'
import { milestone } from './screenshot'

// The goldfish playtest (GoldfishPlan.md): a fixed ?seed= deals the same game every run, so the screenshots repeat.

test.beforeAll(async ({ playwright }, testInfo) => {
  if (!local) return
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  expect((await api.post('/api/dev/catalogue/sync')).ok()).toBe(true) // also fills the cards' tokens
  await api.dispose()
})

type Line = { section: string; quantity: number; finish: string; card: { id: string; name: string; typeLine: string | null } | null }

// The ManaBox Ovika list (Krenko makes Goblins, the fixture's one token) saved as a public Commander deck.
async function publicDeck(request: APIRequestContext) {
  const text = readFileSync(`${import.meta.dirname}/fixtures/manabox-ovika.txt`, 'utf8')
  const lines: Line[] = (await (await request.post('/api/import/deck', { data: { text } })).json()).lines
  const entries = (section: string) =>
    lines.filter((l) => l.card && l.section === section).map((l) => ({ scryfallId: l.card!.id, quantity: l.quantity, finish: l.finish }))
  const created = await request.post('/api/decks', {
    data: { name: 'Ovika Goldfish', format: 'commander', cards: { commander: entries('commander'), mainboard: entries('mainboard'), sideboard: [] } },
  })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  expect((await request.put(`/api/decks/${id}/visibility`, { data: { isPublic: true } })).status()).toBe(200)
  const lands = new Set(lines.filter((l) => l.card?.typeLine?.includes('Land')).map((l) => l.card!.name))
  return { id, lands }
}

const table = (page: Page) => page.getByRole('dialog', { name: /^Playtest/ })
const hand = (page: Page) => table(page).getByRole('region', { name: 'Hand' }).locator('[data-uid]')
const battlefield = (page: Page) => table(page).getByRole('region', { name: 'Battlefield' })
const labels = (cards: Locator) => cards.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))

test('anyone can goldfish a public deck: mulligans, lands, tapping, undo, tokens and the commander', async ({ page, browser }, testInfo) => {
  test.skip(!local, 'creates accounts')
  await signedIn(page)
  const { id, lands } = await publicDeck(page.request)

  const visitor = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  const anonymous = await visitor.newPage()
  await anonymous.goto(`/deck/${id}`)
  await anonymous.getByRole('button', { name: 'Playtest' }).click()
  await expect(anonymous).toHaveURL(/\?playtest/)
  await expect(table(anonymous)).toBeVisible()
  // The deck's name opens its page in a new tab.
  const name = table(anonymous).getByRole('link', { name: 'Ovika Goldfish' })
  await expect(name).toHaveAttribute('href', `/deck/${id}`)
  await expect(name).toHaveAttribute('target', '_blank')
  await anonymous.goBack() // Back closes it
  await expect(table(anonymous)).toBeHidden()

  // A fixed shuffle from here on.
  await anonymous.goto(`/deck/${id}?playtest&seed=42`)
  const opening = table(anonymous).getByRole('group', { name: 'Opening hand' })
  await expect(opening.locator('[data-uid]')).toHaveCount(7)
  await expect(table(anonymous).getByTestId('life')).toHaveText('40')
  await expect(opening.getByRole('checkbox', { name: 'Draw on turn 1' })).toBeChecked() // multiplayer Commander draws on turn 1
  await milestone(anonymous, testInfo, '60-playtest-opening-hand', 'screen')
  await anonymous.setViewportSize({ width: 2000, height: 960 }) // the hand grows with the screen
  await milestone(anonymous, testInfo, '60b-playtest-opening-hand-large', 'screen')
  await anonymous.setViewportSize({ width: 1280, height: 720 })

  // Free mulligans: a fresh 7 as often as you like, never counted.
  const first = await labels(opening.locator('[data-uid]'))
  await opening.getByRole('button', { name: 'Free mulligan' }).click()
  await opening.getByRole('button', { name: 'Free mulligan' }).click()
  await expect(opening.getByRole('heading')).toHaveText('Opening hand')
  expect(await labels(opening.locator('[data-uid]'))).not.toEqual(first)

  // Commander's first mulligan is free; the second costs a card, chosen after keeping.
  await opening.getByRole('button', { name: 'Mulligan (to 7)' }).click()
  await opening.getByRole('button', { name: 'Mulligan (to 6)' }).click()
  await opening.getByRole('button', { name: 'Keep' }).click()
  await expect(opening.getByRole('heading')).toHaveText('Choose 1 card to put on the bottom')
  await expect(opening.getByRole('button', { name: 'Put it on the bottom' })).toBeDisabled()
  await opening.locator('[data-uid]').first().click()
  await opening.getByRole('button', { name: 'Put it on the bottom' }).click()

  await expect(table(anonymous).getByTestId('turn')).toHaveText('Turn 1')
  await expect(hand(anonymous)).toHaveCount(7) // 6 kept, then the turn-1 draw
  await expect(table(anonymous).getByTestId('library-count')).toHaveText('92') // 99 cards between library and hand
  await expect(table(anonymous).getByText('Mulligans: 2')).toBeVisible()

  // Replay goes back to the kept hand, mulligans done, not to a new opening hand.
  const kept = await labels(hand(anonymous))
  await table(anonymous).getByRole('button', { name: 'Next turn' }).click()
  await expect(table(anonymous).getByTestId('turn')).toHaveText('Turn 2')
  await anonymous.keyboard.press('r')
  await expect(table(anonymous).getByTestId('turn')).toHaveText('Turn 1')
  expect(await labels(hand(anonymous))).toEqual(kept)
  await expect(table(anonymous).getByTestId('library-count')).toHaveText('92')
  await expect(table(anonymous).getByText('Mulligans: 2')).toBeVisible()
  await anonymous.keyboard.press('r') // and again: the replayed game keeps its start
  await expect(table(anonymous).getByTestId('turn')).toHaveText('Turn 1')
  expect(await labels(hand(anonymous))).toEqual(kept)

  // Play a land from hand, tap it, undo the tap.
  const land = (await labels(hand(anonymous))).find((l) => lands.has(l))
  expect(land, 'the seeded hand has a land').toBeTruthy()
  await table(anonymous).getByRole('region', { name: 'Hand' }).getByRole('button', { name: land!, exact: true }).first().click()
  const lands0 = battlefield(anonymous).getByRole('group', { name: 'Lands' })
  await expect(lands0.getByRole('button', { name: land!, exact: true })).toBeVisible()
  await expect(table(anonymous).getByTestId('lands-this-turn')).toHaveText('1')
  await lands0.getByRole('button', { name: land!, exact: true }).click()
  await expect(lands0.getByRole('button', { name: `${land}, tapped` })).toBeVisible()
  await table(anonymous).getByRole('button', { name: 'Undo' }).click()
  await expect(lands0.getByRole('button', { name: land!, exact: true })).toBeVisible()

  // Next turn: untap, draw.
  await table(anonymous).getByRole('button', { name: 'Next turn' }).click()
  await expect(table(anonymous).getByTestId('turn')).toHaveText('Turn 2')
  await expect(table(anonymous).getByTestId('library-count')).toHaveText('91')
  await expect(table(anonymous).getByTestId('lands-this-turn')).toHaveText('0')

  // Clicking the library draws a card (undone here); right-clicking it opens its menu: mill three.
  await table(anonymous).getByRole('button', { name: /^Library,/ }).click()
  await expect(table(anonymous).getByTestId('library-count')).toHaveText('90')
  await expect(anonymous.getByRole('menu')).toHaveCount(0)
  await table(anonymous).getByRole('button', { name: 'Undo' }).click()
  await expect(table(anonymous).getByTestId('library-count')).toHaveText('91')
  await table(anonymous).getByRole('button', { name: /^Library,/ }).click({ button: 'right' })
  await anonymous.getByRole('menuitem', { name: 'Mill 3' }).click()
  await expect(table(anonymous).getByTestId('library-count')).toHaveText('88')
  await expect(table(anonymous).getByText(/^Graveyard\s*3$/)).toBeVisible()

  // The graveyard opens in a side drawer; a click back on the table puts it away.
  await table(anonymous).locator('[data-zone="graveyard"] [data-uid]').click()
  const graveyard = table(anonymous).getByRole('complementary', { name: 'Graveyard', exact: true })
  await expect(graveyard).toBeVisible()
  await battlefield(anonymous).click({ position: { x: 600, y: 200 } })
  await expect(graveyard).toHaveCount(0)

  // Tokens: the deck's own (Krenko makes Goblins); a token leaving play is gone.
  await table(anonymous).getByRole('button', { name: 'Tokens' }).click()
  await table(anonymous).getByRole('button', { name: 'Make a Goblin token' }).click()
  const goblin = battlefield(anonymous).getByRole('button', { name: 'Goblin', exact: true })
  await expect(goblin).toContainText('Token')
  await table(anonymous).getByRole('button', { name: 'Close tokens' }).click()
  await goblin.click({ button: 'right' })
  await anonymous.getByRole('menuitem', { name: 'Graveyard' }).click()
  await expect(goblin).toHaveCount(0)
  await expect(table(anonymous).getByText(/^Graveyard\s*3$/)).toBeVisible()

  // The commander: cast from the command zone, back again with its tax.
  const command = table(anonymous).getByRole('region', { name: 'Command zone' })
  await command.getByRole('button', { name: 'Ovika, Enigma Goliath' }).click()
  await expect(battlefield(anonymous).getByRole('button', { name: 'Ovika, Enigma Goliath' })).toBeVisible()
  await battlefield(anonymous).getByRole('button', { name: 'Ovika, Enigma Goliath' }).click({ button: 'right' })
  await anonymous.getByRole('menuitem', { name: 'Command zone' }).click()
  await expect(command.getByRole('button', { name: 'Ovika, Enigma Goliath' })).toContainText('Tax +2')
  await command.getByRole('button', { name: 'Ovika, Enigma Goliath' }).click()
  await table(anonymous).getByRole('button', { name: 'Tokens' }).click()
  await table(anonymous).getByRole('button', { name: 'More tokens' }).click()
  await table(anonymous).getByRole('button', { name: 'Make a Goblin token' }).click()
  await expect(battlefield(anonymous).getByRole('button', { name: 'Goblin', exact: true })).toHaveCount(2)
  await table(anonymous).getByRole('button', { name: 'Close tokens' }).click()

  // +1/+1 counters go below zero as -1/-1 counters; the two cancel out.
  const ovika = battlefield(anonymous).getByRole('button', { name: 'Ovika, Enigma Goliath' })
  await ovika.click({ button: 'right' })
  const counters = anonymous.getByRole('menu')
  await counters.getByRole('button', { name: 'Add a -1/-1 counter' }).click()
  await counters.getByRole('button', { name: 'Add a -1/-1 counter' }).click()
  await expect(ovika).toContainText('−2/−2')
  await expect(counters).toContainText('−1/−1')
  await counters.getByRole('button', { name: 'Remove a -1/-1 counter' }).click()
  await counters.getByRole('button', { name: 'Remove a -1/-1 counter' }).click()
  await expect(ovika).not.toContainText('/')
  await counters.getByRole('button', { name: 'Add a +1/+1 counter' }).click()
  await expect(ovika).toContainText('+1/+1')
  await anonymous.keyboard.press('Escape')
  await expect(counters).toHaveCount(0)
  await milestone(anonymous, testInfo, '61-playtest-board', 'screen')

  // Bigger cards for tired eyes: the zoom grows every card on the table and is remembered.
  const width = () => battlefield(anonymous).getByRole('button', { name: 'Ovika, Enigma Goliath' }).evaluate((e) => e.getBoundingClientRect().width)
  await anonymous.setViewportSize({ width: 2000, height: 960 })
  await expect.poll(width).toBeCloseTo(96, 0) // 100%, settled after the resize
  const before = await width()
  await table(anonymous).getByRole('button', { name: 'Bigger cards' }).click()
  await table(anonymous).getByRole('button', { name: 'Bigger cards' }).click()
  await expect(table(anonymous).getByTestId('zoom')).toHaveText('130%')
  await expect.poll(width).toBeGreaterThan(before * 1.25) // about 30% bigger, as far as the battlefield's height allows

  // All the way up, the cards stop growing where the lands would leave the battlefield, and the hand stays clear of it.
  // Every step grows them until the rows in use (here creatures and lands; the empty row folds away) fill the
  // battlefield's height. Then "Bigger cards" turns off, and the size shows what the cards really are.
  const bigger = table(anonymous).getByRole('button', { name: 'Bigger cards' })
  while (await bigger.isEnabled()) {
    const smaller = await width()
    await bigger.click()
    await expect.poll(width).toBeGreaterThan(smaller + 2)
  }
  await expect(table(anonymous).getByRole('button', { name: 'Smaller cards' })).toBeEnabled()
  const label = async () => parseInt((await table(anonymous).getByTestId('zoom').textContent())!)
  await expect.poll(async () => Math.abs((await width()) / 0.96 - (await label()))).toBeLessThan(1.5) // once settled
  const most = await width()
  const landsRow = battlefield(anonymous).getByRole('group', { name: 'Lands' })
  await expect
    .poll(async () => (await landsRow.boundingBox())!.y + (await landsRow.boundingBox())!.height)
    .toBeLessThanOrEqual((await battlefield(anonymous).boundingBox())!.y + (await battlefield(anonymous).boundingBox())!.height)
  await milestone(anonymous, testInfo, '61b-playtest-zoomed', 'screen')
  // Turning a land doesn't flash a scrollbar: no frame of the animation pokes out of the battlefield.
  const overflow = () =>
    battlefield(anonymous).evaluate((field) => {
      const w = window as unknown as { overflowed: number }
      w.overflowed = 0
      const end = performance.now() + 600
      const sample = () => {
        w.overflowed = Math.max(w.overflowed, field.scrollHeight - field.clientHeight)
        if (performance.now() < end) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
  const overflowed = () => anonymous.evaluate(() => (window as unknown as { overflowed: number }).overflowed)
  for (const turn of ['tap', 'untap']) {
    await overflow()
    await landsRow.getByRole('button').first().click()
    await anonymous.waitForTimeout(700)
    expect(await overflowed(), `${turn} at the biggest size`).toBe(0)
  }
  // Smaller always shrinks them, straight to the next step down.
  await table(anonymous).getByRole('button', { name: 'Smaller cards' }).click()
  await expect.poll(width).toBeLessThan(most - 2)
  while ((await table(anonymous).getByTestId('zoom').textContent()) !== '115%') await table(anonymous).getByRole('button', { name: 'Smaller cards' }).click()
  await anonymous.setViewportSize({ width: 1280, height: 720 })

  // The big preview waits until the pointer rests on a card, so crossing the table doesn't flicker.
  const preview = anonymous.locator('[data-delayed]')
  await battlefield(anonymous).getByRole('button', { name: 'Ovika, Enigma Goliath' }).hover()
  await expect(preview).toHaveCount(0)
  await expect(preview).toHaveCount(1) // after about a third of a second
  await anonymous.mouse.move(0, 0)
  await expect(preview).toHaveCount(0)

  // A refresh keeps the game; Escape closes it.
  await anonymous.goto(`/deck/${id}?playtest`)
  await expect(table(anonymous).getByTestId('turn')).toHaveText('Turn 2')
  await expect(table(anonymous).getByTestId('zoom')).toHaveText('115%')
  await anonymous.keyboard.press('-')
  await expect(table(anonymous).getByTestId('zoom')).toHaveText('100%')
  await anonymous.keyboard.press('?')
  await expect(anonymous.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await milestone(anonymous, testInfo, '62-playtest-shortcuts', 'screen')
  await anonymous.keyboard.press('Escape')
  await expect(anonymous.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden()
  await anonymous.keyboard.press('Escape')
  await expect(table(anonymous)).toBeHidden()
  await expect(anonymous).toHaveURL(new RegExp(`/deck/${id}$`))
  await visitor.close()
})

test('the builder playtests its deck in place, and its stats show the opening-hand odds', async ({ page }, testInfo) => {
  test.skip(!local, 'creates accounts')
  await signedIn(page)
  const { id } = await publicDeck(page.request)
  await page.goto(`/decks/${id}`)
  await page.getByRole('button', { name: 'Playtest' }).click()
  await expect(table(page)).toBeVisible()
  await expect(table(page).getByRole('link', { name: 'Ovika Goldfish' })).toHaveAttribute('href', `/decks/${id}`)
  await page.keyboard.press('Escape')
  await expect(table(page)).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/decks/${id}$`)) // still on the builder

  await page.getByRole('button', { name: 'Show stats' }).click()
  const odds = page.getByTestId('opening-odds')
  await expect(odds).toContainText(/2–5 lands: \d+%/)
  // Commander draws on turn 1, so that row leads.
  await expect(odds.getByRole('row').nth(1).getByRole('rowheader')).toHaveText('Draw on turn 1')
  await expect(odds.getByRole('row', { name: /^Draw on turn 1/ }).getByRole('cell')).toHaveCount(6)
  await expect(odds.getByRole('row', { name: /^No draw on turn 1/ })).toBeVisible()
  await expect(odds).toContainText('Mulligans, keeping hands of 2–5 lands')
  await odds.scrollIntoViewIfNeeded()
  await milestone(page, testInfo, '63-deck-opening-odds', 'screen')
})

test('a pasted list plays without saving: unknown lines left out, double-faced cards flip, sample hands', async ({ page }, testInfo) => {
  await page.goto('/playtest?seed=7')
  await page.getByLabel('Decklist').fill('4 Delver of Secrets\n4 Lightning Bolt\n16 Island\n1 Not A Real Card\n')
  await page.getByRole('button', { name: 'Playtest' }).click()
  await expect(table(page)).toBeVisible()
  await expect(table(page).getByTestId('life')).toHaveText('20') // casual: not a Commander list
  await expect(table(page).getByRole('checkbox', { name: 'Draw on turn 1' })).not.toBeChecked()
  await table(page).getByRole('button', { name: 'Keep' }).click()
  await expect(table(page).getByTestId('library-count')).toHaveText('17')

  // Search the library for Delver and put it onto the battlefield; closing the search shuffles.
  await table(page).getByRole('button', { name: /^Library,/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Search the library' }).click()
  const search = table(page).getByRole('complementary', { name: 'Search the library' })
  // The name box has focus, so typing filters at once.
  await expect(search.getByRole('textbox', { name: 'Filter by name' })).toBeFocused()
  await page.keyboard.type('island')
  // Each card once, with the copies left.
  await expect(search.getByRole('button', { name: 'Island' })).toHaveCount(1)
  await expect(search.getByText(/^×\d+$/)).toBeVisible()
  await search.getByRole('textbox', { name: 'Filter by name' }).fill('delver')
  await expect(search.getByRole('button', { name: /^(?!Delver of Secrets)/ })).toHaveCount(1) // only the drawer's close button
  await expect(search.getByRole('button', { name: 'Delver of Secrets' })).toHaveCount(1)
  await search.getByRole('button', { name: 'Delver of Secrets' }).click()
  await page.getByRole('menuitem', { name: 'Battlefield' }).click()
  await table(page).getByRole('button', { name: 'Close search the library' }).click()
  const delver = battlefield(page).getByRole('button', { name: 'Delver of Secrets' })
  const front = await delver.locator('img').getAttribute('src')
  await delver.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Flip' }).click()
  await expect(delver.locator('img')).not.toHaveAttribute('src', front!)

  // A tutor to the top (Vampiric Tutor): a card put on top during a search stays there through its shuffle.
  const bolts = table(page).getByRole('region', { name: 'Hand' }).getByRole('button', { name: 'Lightning Bolt' })
  const boltsInHand = await bolts.count()
  await table(page).getByRole('button', { name: /^Library,/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Search the library' }).click()
  await search.getByRole('textbox', { name: 'Filter by name' }).fill('bolt')
  await search.getByRole('button', { name: 'Lightning Bolt' }).click()
  await page.getByRole('menuitem', { name: 'Top of library' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0) // closed (it fades out): Escape is the menu's own until then
  await page.keyboard.press('Escape') // ends the search: shuffles under the Bolt
  await expect(search).toHaveCount(0)
  await table(page).getByRole('button', { name: /^Library,/ }).click() // draws the top card
  await expect(bolts).toHaveCount(boltsInHand + 1)

  // Drag a card from the hand to the graveyard: a ghost follows the pointer and the graveyard lights up under it.
  const dragged = table(page).getByRole('region', { name: 'Hand' }).locator('[data-uid]').first()
  const from = (await dragged.boundingBox())!
  const to = (await table(page).locator('[data-zone="graveyard"]').boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  const ghostBox = (await table(page).locator('[class*="ghost"]').boundingBox())!
  expect(Math.abs(ghostBox.x + ghostBox.width / 2 - (to.x + to.width / 2))).toBeLessThan(2) // centred on the pointer
  expect(Math.abs(ghostBox.width - from.width)).toBeLessThan(from.width * 0.15) // the size of the card picked up (tilted a little)
  await expect(table(page).locator('[data-zone="graveyard"]')).toHaveAttribute('data-over', 'true')
  await page.mouse.up()
  await expect(table(page).getByText(/^Graveyard\s*1$/)).toBeVisible()
  await expect(table(page).locator('[class*="ghost"]')).toHaveCount(0)

  // A sample hand, and the odds beside the game.
  await page.keyboard.press('h')
  await expect(table(page).getByTestId('sample-hand').locator('img')).toHaveCount(7)
  await table(page).getByRole('button', { name: 'Opening-hand odds' }).click()
  await expect(table(page).getByTestId('opening-odds')).toContainText(/2–5 lands: \d+%/)
  await expect(table(page).getByTestId('opening-odds').getByRole('rowheader', { name: 'On the play' })).toBeVisible() // two players: play or draw
  await milestone(page, testInfo, '64-playtest-pasted-list', 'screen')

  await page.keyboard.press('Escape') // the panel
  await expect(table(page).getByTestId('opening-odds')).toBeHidden()

  // A phone's width: the zones move above the battlefield, nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 })
  await milestone(page, testInfo, '65-playtest-phone', 'screen')
  await expectNoSidewaysScroll(page)
  await page.keyboard.press('Escape') // the table
  await expect(table(page)).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: '1 line was left out' })).toContainText('Not A Real Card')
})

test('auras and equipment go on a permanent: cast onto it, dragged onto it, detached, and an aura follows it out', async ({ page }, testInfo) => {
  await page.goto('/playtest?seed=11')
  await page.getByLabel('Decklist').fill('4 Delver of Secrets\n4 Snake Umbra\n4 Goldvein Pick\n12 Island\n')
  await page.getByRole('button', { name: 'Playtest' }).click()
  await table(page).getByRole('button', { name: 'Keep' }).click()

  // Delver and the Pick onto the battlefield, an Umbra to the hand.
  await table(page).getByRole('button', { name: /^Library,/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Search the library' }).click()
  const search = table(page).getByRole('complementary', { name: 'Search the library' })
  for (const [name, to] of [['Delver of Secrets', 'Battlefield'], ['Goldvein Pick', 'Battlefield'], ['Snake Umbra', 'Hand']]) {
    await search.getByRole('textbox', { name: 'Filter by name' }).fill(name)
    await search.getByRole('button', { name }).click()
    await page.getByRole('menuitem', { name: to }).click()
  }
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.keyboard.press('Escape') // ends the search
  await expect(search).toHaveCount(0)

  // A click on an aura in hand asks what it goes on; a click on Delver casts it there.
  await table(page).getByRole('region', { name: 'Hand' }).getByRole('button', { name: 'Snake Umbra' }).first().click()
  await expect(table(page).getByRole('status').filter({ hasText: 'Choose what Snake Umbra goes on' })).toBeVisible()
  const delver = battlefield(page).getByRole('button', { name: 'Delver of Secrets // Insectile Aberration', exact: true })
  await delver.click()
  const umbra = battlefield(page).getByRole('button', { name: 'Snake Umbra, on Delver of Secrets // Insectile Aberration' })
  await expect(umbra).toBeVisible()
  await expect(delver).not.toHaveAttribute('aria-label', /tapped/) // the click picked it, it didn't tap it
  // The aura peeks out above Delver, behind it.
  expect((await umbra.boundingBox())!.y).toBeLessThan((await delver.boundingBox())!.y - 10)

  // Drag the Pick onto Delver: Delver lights up under it.
  const pick = battlefield(page).getByRole('button', { name: /^Goldvein Pick/ })
  const from = (await pick.boundingBox())!
  const to = (await delver.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.75, { steps: 8 })
  await expect(delver).toHaveAttribute('data-target', 'true')
  await page.mouse.up()
  await expect(pick).toHaveAttribute('aria-label', 'Goldvein Pick, on Delver of Secrets // Insectile Aberration')
  await milestone(page, testInfo, '66-playtest-attached', 'screen')

  // Detach the Pick; then Delver dies and the Umbra follows it to the graveyard.
  await pick.click({ button: 'right', position: { x: 20, y: 8 } }) // its strip above Delver
  await page.getByRole('menuitem', { name: 'Detach' }).click()
  await expect(pick).toHaveAttribute('aria-label', 'Goldvein Pick')
  await delver.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Graveyard' }).click()
  await expect(table(page).getByText(/^Graveyard\s*2$/)).toBeVisible()
  await expect(pick).toBeVisible()
  // Undo brings both back, still attached.
  await page.keyboard.press('Control+z')
  await expect(umbra).toBeVisible()

  // A hand wider than the screen scrolls sideways under the mouse wheel.
  for (let i = 0; i < 8; i++) await page.keyboard.press('d')
  const handCards = table(page).getByRole('region', { name: 'Hand' }).locator('[class*="handCards"]')
  await handCards.hover()
  await page.mouse.wheel(0, 300)
  await expect.poll(() => handCards.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0)
})
