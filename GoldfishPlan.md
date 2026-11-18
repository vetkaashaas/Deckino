# Deckino Goldfish (Playtest) Plan

> **Status: G1–G4 built (2026-11-18), waiting for review; phases get ticked when committed.** See [As built](#as-built) for where the build differs from the plan below. Choices made so far are under [Decisions](#decisions), and the questions still open are under [Open Decisions](#open-decisions).
>
> **Before starting each phase:** re-read it and check that every part still makes sense given what earlier phases taught us. Update this plan before writing code.

## Goal

**Goldfish any deck on the website:** your own (including unsaved builder edits), any public Deckino deck (even signed out), or a pasted decklist. Shuffle, draw an opening hand, mulligan, then play turns alone to see how the deck runs. It should feel quick and polished, like TappedOut's playtester or Archidekt's "Playtest", but with Deckino's look, and with undo, replayable shuffles and keyboard shortcuts on top.

There is no opponent, no rules engine and no multiplayer. The player moves cards, and Deckino keeps track of zones, turns, tapping, counters and life.

**Website only.** This plan makes no app changes. The app version comes much later, built from the polished web version (`AppPlan.md`, Future Work).

## Where We Start (2026-11-18)

- `GET /api/decks/{id}` (owner) and `GET /api/public/decks/{id}` (anyone) both return `DeckDetail`: commander, mainboard and sideboard entries, each with a `DeckCard` (name, mana cost, mana value, type line, front image, art crop). That is everything G1 needs, so **G1 needs no API changes**.
- The importer (`POST /api/import/deck`) already parses Arena, MTGO, Moxfield, Archidekt, TappedOut and ManaBox text into sections and resolves every line to a `DeckCard`. That is most of G3, but the endpoint requires sign-in.
- What's missing: back-face images for double-faced cards (`DeckCard` has the front only), and tokens. The catalogue already holds token cards (Scryfall's `default_cards` includes them), but it doesn't keep `all_parts`, so it can't tell which tokens a card makes.
- Web: `DeckPage` (the builder, which keeps unsaved state in memory) and `PublicDeckPage`. `CardPreview` already shows the large card on hover. Mantine is the only UI library, and there's no drag-and-drop library.

---

# The Engine (shared by every phase)

One pure TypeScript module, `Deckino.Web/src/goldfish/engine.ts`. It has no React and no DOM: a `Game` state and a reducer `(Game, Action) => Game`. The UI renders from it. Keeping it free of React is what will make the later app version a port rather than a rewrite.

## Input

The engine takes the same shape whatever the source: `{ name, format, commander, mainboard, sideboard }` as `DeckEntryDetail` lists. A saved deck, a public deck, the builder's unsaved state and a resolved pasted list (G3) all produce it.

## State

```ts
type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'

interface GameCard {
  uid: string            // one per physical copy (4× Island = 4 uids)
  card: DeckCard
  tapped: boolean
  faceDown: boolean      // morph/manifest, or hidden
  backFace: boolean      // double-faced card showing its back (G2)
  counters: Record<string, number>  // '+1/+1', 'loyalty', anything the player names
  token: boolean
  commanderCasts: number // drives the tax badge (+2 per cast from the command zone)
}

interface Game {
  seed: number; rng: number          // seeded PRNG state; same seed = same shuffles
  format: string
  phase: 'mulligan' | 'bottoming' | 'playing'
  mulligans: number
  onThePlay: boolean                 // no draw on turn 1 when on the play
  turn: number
  life: number                       // 40 for commander, 20 otherwise
  landsThisTurn: number
  zones: Record<Zone, string[]>      // ordered uids; library[0] is the top
  cards: Record<string, GameCard>
}
```

## Actions

`start`, `mulligan`, `keep`, `bottom(uids)`, `draw(n)`, `mill(n)`, `nextTurn` (untap all, turn+1, draw), `move(uid, zone, position?)` (`position` is top or bottom for the library), `tap(uid)`, `untapAll`, `flip(uid)`, `counter(uid, kind, delta)`, `life(delta)`, `shuffle`, `createToken(card)`, `copy(uid)` (a token copy), `restart` (new seed), `replay` (same seed).

Rules the engine does keep, because they make goldfishing feel right:

- **London mulligan:** shuffle and draw 7 again, then put one card per mulligan on the bottom. In Commander the first mulligan is free.
- **A token that leaves the battlefield ceases to exist.**
- **Commander:** casting from the command zone adds 1 to `commanderCasts`, and the card shows "Tax +2/+4…". A commander that goes to the graveyard or exile offers "Return to command zone".
- **Lands:** playing a land from hand adds 1 to `landsThisTurn`. The UI shows a soft hint at 2+, never a block.

Everything else (mana, the stack, combat, triggers) is left to the player, as on TappedOut and Archidekt.

## Undo, Replay, Randomness

- **Undo/redo:** the game keeps its past states (capped at 300). Cards are shared references, so a snapshot costs little.
- **Seeded shuffles:** mulberry32 seeded from `crypto.getRandomValues`. "Replay" restarts with the same seed (the same opening hand and draws), so a player can retry a line of play. A `?seed=` URL parameter makes E2E screenshots repeatable.
- **Refresh-safe:** the current game is saved to `sessionStorage` under its source (deck id, or the pasted list), and a refresh picks it up again.

## What's In the Library

The **commander** goes to the command zone, the **mainboard** is shuffled into the library, and the **sideboard** stays out (but can be looked through from the side panel and "wished" into hand, for wish effects and companions).

---

# Phase G1: Web Playtest

## Goal

A full goldfish for owned decks (including unsaved builder edits) and public Deckino decks.

## API

None.

## Entry Points

- A **Playtest** button in the header of `DeckPage` and `PublicDeckPage`, next to the existing actions, shown to signed-out visitors too. A one-click "try it out" is a good reason to sign up.
- It opens a **full-screen overlay** on top of the deck page, not a new page:
  - On the builder, the overlay plays the deck **as it is in the builder**, saved or not, so the user can tweak, test and tweak again without saving each time.
  - The overlay is tied to `?playtest` in the URL: Back closes it and a refresh reopens it.
- Disabled, with a tooltip, when the deck has fewer than 7 cards in the library.

## Layout (desktop, ≥ 1024px)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ◀ Deck name · Commander   Turn 3 · ♥ 40   [Next turn ⏎]  ↶ ↷  ⟳ Replay  ✕     │
├──────────┬────────────────────────────────────────────────────────┬───────────┤
│ COMMAND  │  BATTLEFIELD                                           │ LIBRARY   │
│ [cmdr]   │   creatures ▸ [▢][▢][▢]                                │  [card    │
│  Tax +2  │   other     ▸ [▢][▢]                                   │   back]   │
│          │   lands     ▸ [Forest ×3][Island ×2][▢]                │   87      │
│          │                                                        ├───────────┤
│          │                                                        │ GRAVEYARD │
│          │                                                        │ [top] 4   │
│          │                                                        ├───────────┤
│          │                                                        │ EXILE  1  │
├──────────┴────────────────────────────────────────────────────────┴───────────┤
│ HAND (6)   [▢] [▢] [▢] [▢] [▢] [▢]           lands this turn: 1 · in play: 5  │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **The battlefield arranges itself** into three rows: creatures, other permanents, and lands. There's no freeform placement. Identical untapped lands stack ("Forest ×3") and spread out when one is tapped. Tapped cards turn 90° with a spring.
- **Hand** along the bottom, lifting on hover. The big preview is the existing `CardPreview`.
- **Graveyard / exile / library** open a side drawer listing their cards (graveyard and exile in order, newest first). Every card in the drawer has the same move menu.
- Below 1024px the layout reflows: the zone column moves to a top strip, and the hand scrolls sideways. It stays usable on a phone browser, but desktop is the target.
- Ambient orbs, Bricolage Grotesque for the header, and the deck's colour identity as a faint wash behind the battlefield (from `deckLook`). Motion respects reduced-motion.

## Interactions

| Do | Result |
|---|---|
| Click a card in hand | Play it: lands go to the land row, everything else to the battlefield |
| Click a card on the battlefield | Tap / untap |
| Drag any card | Move it to any zone. Dropping on the library puts it on top; hold Shift for the bottom |
| Right-click (or `⋯`) | Move to hand / top / bottom / graveyard / exile / command zone, flip, counters ±, copy, face-down |
| Click the library | Draw 1. Right-click for its menu: draw X, mill X, look at top X (scry/surveil: each card to top, bottom or graveyard), search (pick any, then shuffle; a card put on top during the search, as with Vampiric Tutor, stays on top), shuffle |
| Life ± | Click or scroll on the life total |

Dragging uses pointer events with drop zones, and no new dependency.

**Keyboard:** `D` draw · `Enter` next turn · `U` untap all · `Ctrl+Z` / `Ctrl+Shift+Z` undo / redo · `S` shuffle · `M` mulligan (opening hand only) · `R` replay · `?` shows the list.

## Opening Hand Flow

1. The overlay opens on a centred **opening hand** of 7 cards, with a **Draw on turn 1** checkbox (ticked for Commander, where the first player draws in multiplayer; unticked for two-player formats; remembered for each in `localStorage`) and **Keep**, **Mulligan (to 6)** or **Free mulligan** (a fresh 7 as often as you like, never counted). The cards scale with the screen, with no hover preview.
2. After a mulligan, Keep asks the player to pick N cards to put on the bottom ("Choose 1 card to put on the bottom"), then the game starts.
3. The header keeps a small "Mulligans: 1" note for the rest of the game.

## E2E

Playwright: open a public fixture deck with `?playtest&seed=42`, mulligan once, bottom a card, play a land, pass two turns, tap, undo, open the graveyard. A screenshot after each step goes in `e2e-results/screenshots`. With a fixed seed, every run produces the same images. The same test also covers the builder: add a card, don't save, playtest, and check the card is in the library ("search").

## Visible Milestone

A signed-out visitor opens a public Commander deck, clicks Playtest, mulligans to 6 and plays five turns with undo and replay. The deck owner tests an unsaved edit without saving.

---

# Phase G2: Double-Faced Cards and Tokens

## Goal

Flip DFCs/MDFCs to their back, and make a deck's tokens in one click.

## API

- `DeckCard.BackImage` (additive): the second face's normal image for double-faced layouts, or null. The web's `toDeckCard` fills it from `CardDetail.Images[1]`.
- `Card.TokenIds`: Scryfall's `all_parts` entries with `component: "token"` (plus emblems), stored by `CatalogueSync`. This needs a migration, and the next sync fills it in.
- `POST /api/cards/tokens` with a body of card IDs: returns the distinct tokens those cards make, as `DeckCard`s. It takes card IDs rather than a deck id, so it works for every playtest source alike. Anonymous and capped at 250 IDs; the API's global per-client limit covers it.

## Playtest

- **Flip** in the card menu, and `F` on a hovered card. Transform cards show their back face. MDFCs can be played as either face from hand ("Play back face").
- A **Tokens** button in the header opens a tray of this deck's tokens (from the endpoint above). Click one to make a token on the battlefield; a stepper sets how many. A search box covers any other token in the catalogue (the existing card search, filtered to `layout = token`).
- **Copy** (from G1) makes a token copy of any permanent.

## Visible Milestone

A Commander deck with token makers (e.g. Treasure/Clue/Soldier) shows them in the tray, and a Delver flips.

---

# Phase G3: Playtest a Pasted List

## Goal

Goldfish a deck that isn't saved on Deckino by pasting its decklist (an export from Moxfield, Archidekt, TappedOut, Arena, MTGO…).

## Page

- A new page, `/playtest`, linked from My Decks and Browse ("Playtest a list"). It has one box for the pasted list.
- Unmatched lines are listed as they are on the import page ("3 lines not found"), and the playtest starts without them.
- The list plays in place: click **Playtest** and it starts. Nothing is stored.
- Signed-in users get **Save as a deck**, which hands the resolved list to the existing import flow.

## API

No new endpoint: the importer's deck preview (`POST /api/import/deck`) becomes anonymous, since it only reads the catalogue. The page turns its lines into the engine's input and lists the unmatched ones. The importer's line and length limits and the API's global per-client limit apply. The binder preview stays sign-in only.

## E2E

Playwright: paste a fixture list with a few unknown lines, check they're listed, playtest with a fixed seed, and screenshot each step.

## Visible Milestone

A signed-out visitor pastes a Moxfield export and goldfishes it.

---

# Phase G4: "How It Runs" (Opening-Hand Stats)

## Goal

Numbers next to the hands you play by hand, so a player can see how consistent a deck is.

## Playtest

- A **Stats** side panel in the playtest (and a section on the deck's Stats tab), worked out in the browser as exact odds (hypergeometric) rather than a simulation, so they're instant and the same on every load:
  - Lands in the opening 7 (a histogram), and the % of hands with 2–5 lands.
  - The chance of making each land drop on curve, turns 1–6, on the play and on the draw (for Commander: drawing on turn 1 first, then without).
  - The chance of having at least one card of mana value ≤ 2 by turn 2.
  - Average mulligans under a simple keep rule (2–5 lands).
- **Sample hands:** `H` deals a fresh 7 next to the board without touching the game, for quick "would I keep this?" checks.

## API

None.

## Visible Milestone

A deck's Stats tab shows its land-drop curve, and changing the land count in the builder updates it live.

---

# As built (2026-11-18)

- **Files:** `Deckino.Web/src/goldfish/` holds the engine (`engine.ts`), the table (`Playtest.tsx`), the pasted-list page (`PlaytestPage.tsx`) and the odds (`odds.ts`, `OpeningOdds.tsx`). The deck pages only add the Playtest button, and the deck Stats panel adds the odds.
- **API:** `DeckCard.BackImage`, `Card.TokenIds` (migration `PlaytestTokens`, filled by the next catalogue sync), `POST /api/cards/tokens`, and the deck import preview opened to signed-out visitors. The app's `generated.ts` wasn't regenerated (no app changes in this plan); `BackImage` is additive, so the app is unaffected until its next `gen:api`.
- **Keyboard:** `D` draw, `Enter` next turn, `U` untap all, `S` shuffle, `T` tokens, `H` sample hand, `F` flip, `M`/`K` mulligan/keep, `R` replay, `N` new game, `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `?` help, `Esc` close. Replay and New game can be undone too.
- **Comfort:** a zoom control in the header, beside Next turn (80%–200%, `+`/`−`, remembered in this browser; hidden on phones, where pinching zooms) scales every card on the table, up to what still fits: battlefield cards stop growing once the rows in use (empty ones fold away) would overflow its height, so the lands row is never under the hand; past that point the `+` step turns off, `−` always shrinks the cards, and the size shown is the cards' real one, the library, graveyard and exile columns likewise, and the hand stays within about a fifth of the screen. The opening hand sizes itself to the screen instead. The big card preview waits until the pointer has rested on a card for 350ms, then fades in (elsewhere on the site it stays instant).
- **E2E:** `e2e/playtest.spec.ts`, screenshots `60`–`65` (opening hand, board, shortcuts, deck odds, pasted list, phone width). The test catalogue gained Krenko's Goblin token, so the token tray has something to show. Re-running `make-cards-fixture.mjs` drops it, as it does `add-deck-cards.mjs`'s cards.

# Development Sequence

When the user asks to commit and push, tick (with the date) every phase that work completes.

- [x] G1. Web playtest (engine, overlay on builder + public deck, mulligans, undo/replay, shortcuts) (2026-11-18)
- [x] G2. Double-faced cards + tokens (`BackImage`, `TokenIds`, token tray) (2026-11-18)
- [x] G3. Playtest a pasted list (`/playtest`, anonymous deck preview) (2026-11-18)
- [x] G4. "How it runs" stats + sample hands (2026-11-18)

# Decisions

- Website only. No app changes in this plan; the app version comes much later, ported from the polished web version.
- One pure TypeScript engine, a reducer with snapshot undo. No rules engine and no opponent.
- The battlefield arranges itself into rows; there's no freeform placement.
- The deck-page playtest is an overlay tied to `?playtest`. On the builder it plays unsaved edits.
- Public decks and pasted lists can be playtested signed out.
- No playtesting from another site's link (dropped 2026-11-18); pasting the site's export covers it.
- Seeded shuffles: Replay, plus repeatable E2E screenshots.
- G1 needs no API changes. Tokens come from Scryfall's `all_parts`, kept in the catalogue.

# Open Decisions

None.
