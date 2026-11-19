// The goldfish (playtest) game: a deck played alone. Pure state and a reducer, no React or DOM, so the app can
// port it later (GoldfishPlan.md). The player moves the cards; this keeps zones, turns, tapping, counters and life.
import { countCards, type DeckCard, type DeckEntry } from '../decks/deck'

export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command' | 'sideboard'

// What can be playtested: a saved deck, the builder's draft, a public deck or a pasted list.
export interface PlayDeck {
  name: string
  format: string
  commander: DeckEntry[]
  mainboard: DeckEntry[]
  sideboard: DeckEntry[]
}

export interface GameCard {
  uid: string // one per physical copy
  card: DeckCard
  tapped: boolean
  faceDown: boolean
  backFace: boolean // a double-faced card showing its back
  counters: Record<string, number>
  token: boolean
  commander: boolean
  casts: number // from the command zone; the tax is 2 per cast
  topped?: number // when it was last put on top of the library (Game.topped then)
  attachedTo?: string // an aura or equipment on another permanent (never on one that is itself attached)
}

export interface Game {
  seed: number
  rng: number
  format: string
  phase: 'mulligan' | 'bottoming' | 'playing'
  mulligans: number
  drawFirstTurn: boolean // multiplayer Commander draws on turn 1; a two-player game going first doesn't
  turn: number
  life: number
  landsThisTurn: number
  zones: Record<Zone, string[]> // library[0] is the top; graveyard and exile newest last
  cards: Record<string, GameCard>
  nextUid: number
  topped?: number // counts the cards put on top of the library, so a search can keep the ones it tutored there
}

export type Action =
  | { type: 'mulligan'; free?: boolean } // a free one is a fresh 7 that doesn't count
  | { type: 'keep' }
  | { type: 'bottom'; uids: string[] }
  | { type: 'setDrawFirstTurn'; value: boolean }
  | { type: 'draw'; count?: number }
  | { type: 'mill'; count: number }
  | { type: 'nextTurn' }
  | { type: 'play'; uid: string; backFace?: boolean }
  | { type: 'move'; uid: string; to: Zone; bottom?: boolean }
  | { type: 'tap'; uid: string }
  | { type: 'untapAll' }
  | { type: 'flip'; uid: string }
  | { type: 'faceDown'; uid: string }
  | { type: 'counter'; uid: string; kind: string; delta: number }
  | { type: 'life'; delta: number }
  | { type: 'shuffle'; keepToppedAfter?: number } // the cards on top that were put there after that count stay on top
  | { type: 'copy'; uid: string }
  | { type: 'token'; card: DeckCard; count?: number }
  | { type: 'attach'; uid: string; to?: string } // onto a permanent (played first if it isn't in play); no `to` takes it off

export const handSize = 7
export const canPlaytest = (deck: PlayDeck) => countCards(deck.mainboard) >= handSize
export const startingLife = (format: string) => (format === 'commander' ? 40 : 20)

// Commander's first mulligan is free (multiplayer rules); otherwise one card to the bottom per mulligan, down to none kept.
export const toBottom = (game: Pick<Game, 'format' | 'mulligans'>) =>
  Math.min(handSize, Math.max(0, game.mulligans - (game.format === 'commander' ? 1 : 0)))

// mulberry32: small, fast and seedable, so the same seed deals the same game (Replay, and repeatable E2E screenshots).
function random(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) | 0
  let t = next
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next]
}

export function newSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

// Fisher–Yates with the game's generator.
function shuffled(list: string[], rng: number): [string[], number] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const [r, next] = random(rng)
    rng = next
    const j = Math.floor(r * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return [out, rng]
}

// The face a card shows: its back when flipped (if it has one).
export const shownImage = (c: GameCard) => (c.backFace && c.card.backImage ? c.card.backImage : c.card.image)

// The type line of the face that's up, for sorting the battlefield into rows.
export function shownType(c: GameCard) {
  const faces = c.card.typeLine?.split(' // ') ?? []
  return (c.backFace ? faces[1] : faces[0]) ?? faces[0] ?? ''
}

export const fingerprint = (deck: PlayDeck) =>
  JSON.stringify([deck.format, ...(['commander', 'mainboard', 'sideboard'] as const).map((s) => deck[s].map((e) => [e.scryfallId, e.quantity]))])

// A fresh game: the commanders in the command zone, the mainboard shuffled, an opening hand of 7.
export function newGame(deck: PlayDeck, seed: number, drawFirstTurn = deck.format === 'commander'): Game {
  const cards: Record<string, GameCard> = {}
  let n = 0
  const make = (card: DeckCard, commander = false) => {
    const uid = `c${++n}`
    cards[uid] = { uid, card, tapped: false, faceDown: false, backFace: false, counters: {}, token: false, commander, casts: 0 }
    return uid
  }
  const copies = (entries: DeckEntry[], commander = false) => entries.flatMap((e) => Array.from({ length: e.quantity }, () => make(e.card, commander)))
  const command = copies(deck.commander, true)
  const [library, rng] = shuffled(copies(deck.mainboard), seed)
  const sideboard = copies(deck.sideboard)
  return {
    seed,
    rng,
    format: deck.format,
    phase: 'mulligan',
    mulligans: 0,
    drawFirstTurn,
    turn: 0,
    life: startingLife(deck.format),
    landsThisTurn: 0,
    zones: { library: library.slice(handSize), hand: library.slice(0, handSize), battlefield: [], graveyard: [], exile: [], command, sideboard },
    cards,
    nextUid: n + 1,
  }
}

// Seven cards from a fresh shuffle, without touching the game: "would I keep this?"
export function sampleHand(deck: PlayDeck) {
  const game = newGame(deck, newSeed())
  return game.zones.hand.map((uid) => game.cards[uid].card)
}

export const zoneOf = (game: Game, uid: string) => (Object.keys(game.zones) as Zone[]).find((z) => game.zones[z].includes(uid))

function draw(game: Game, count: number): Game {
  const drawn = game.zones.library.slice(0, count)
  if (!drawn.length) return game // an empty library: no undo step for nothing
  return { ...game, zones: { ...game.zones, library: game.zones.library.slice(count), hand: [...game.zones.hand, ...drawn] } }
}

// A card leaving the battlefield forgets its state; a token leaving it ceases to exist.
function moveCard(game: Game, uid: string, to: Zone, bottom = false): Game {
  const from = zoneOf(game, uid)
  const card = game.cards[uid]
  if (!from || !card) return game
  if (from === 'battlefield' && to !== 'battlefield') {
    // What was on it: an aura goes to the graveyard (the rules), anything else (equipment) stays in play on its own.
    const on = game.zones.battlefield.filter((u) => game.cards[u].attachedTo === uid)
    if (on.length) {
      let next = game
      for (const u of on) next = shownType(next.cards[u]).includes('Aura') ? moveCard(next, u, 'graveyard') : update(next, u, (c) => ({ ...c, attachedTo: undefined }))
      return moveCard(next, uid, to, bottom)
    }
  }
  const zones = { ...game.zones, [from]: game.zones[from].filter((u) => u !== uid) }
  const cards = { ...game.cards }
  // The command zone keeps it: that's where an emblem (made from the token tray) belongs.
  if (card.token && to !== 'battlefield' && to !== 'command') {
    delete cards[uid]
    return { ...game, zones, cards }
  }
  if (from === 'battlefield' && to !== 'battlefield') {
    cards[uid] = { ...card, tapped: false, counters: {}, faceDown: false, backFace: false, attachedTo: undefined }
  }
  // Only a commander pays tax; anything else parked in the command zone (an emblem, a companion) doesn't.
  if (from === 'command' && to === 'battlefield' && card.commander) cards[uid] = { ...cards[uid], casts: card.casts + 1 }
  zones[to] = to === 'library' && !bottom ? [uid, ...zones[to]] : [...zones[to], uid]
  const topped = to === 'library' && !bottom ? (game.topped ?? 0) + 1 : game.topped
  if (topped !== game.topped) cards[uid] = { ...cards[uid], topped }
  // The face that went down: a spell // land card cast as its spell isn't a land drop, played as its land it is.
  const landPlayed = from === 'hand' && to === 'battlefield' && shownType(cards[uid]).includes('Land')
  return { ...game, zones, cards, topped, landsThisTurn: game.landsThisTurn + (landPlayed ? 1 : 0) }
}

const update = (game: Game, uid: string, change: (c: GameCard) => GameCard): Game =>
  game.cards[uid] ? { ...game, cards: { ...game.cards, [uid]: change(game.cards[uid]) } } : game

function addToken(game: Game, card: DeckCard, from?: GameCard): Game {
  const uid = `t${game.nextUid}`
  const token: GameCard = from
    ? { ...from, uid, token: true, commander: false, casts: 0, tapped: false, counters: {}, attachedTo: undefined }
    : { uid, card, tapped: false, faceDown: false, backFace: false, counters: {}, token: true, commander: false, casts: 0 }
  return {
    ...game,
    nextUid: game.nextUid + 1,
    cards: { ...game.cards, [uid]: token },
    zones: { ...game.zones, battlefield: [...game.zones.battlefield, uid] },
  }
}

export function apply(game: Game, action: Action): Game {
  switch (action.type) {
    case 'mulligan': {
      if (game.phase !== 'mulligan') return game
      const [library, rng] = shuffled([...game.zones.library, ...game.zones.hand], game.rng)
      return {
        ...game,
        rng,
        mulligans: game.mulligans + (action.free ? 0 : 1),
        zones: { ...game.zones, library: library.slice(handSize), hand: library.slice(0, handSize) },
      }
    }
    case 'keep':
      if (game.phase !== 'mulligan') return game
      return toBottom(game) > 0 ? { ...game, phase: 'bottoming' } : begin(game)
    case 'bottom': {
      if (game.phase !== 'bottoming' || action.uids.length !== toBottom(game)) return game
      // Only distinct cards from this hand: a pick left over from an undone hand would duplicate a library card.
      if (new Set(action.uids).size !== action.uids.length || !action.uids.every((u) => game.zones.hand.includes(u))) return game
      const hand = game.zones.hand.filter((u) => !action.uids.includes(u))
      return begin({ ...game, zones: { ...game.zones, hand, library: [...game.zones.library, ...action.uids] } })
    }
    case 'setDrawFirstTurn':
      return game.phase === 'playing' ? game : { ...game, drawFirstTurn: action.value }
    case 'draw':
      return draw(game, action.count ?? 1)
    case 'mill': {
      const milled = game.zones.library.slice(0, action.count)
      if (!milled.length) return game
      return { ...game, zones: { ...game.zones, library: game.zones.library.slice(action.count), graveyard: [...game.zones.graveyard, ...milled] } }
    }
    case 'nextTurn':
      return draw(apply({ ...game, turn: game.turn + 1, landsThisTurn: 0 }, { type: 'untapAll' }), 1)
    case 'play': {
      const flipped = action.backFace ? update(game, action.uid, (c) => ({ ...c, backFace: true })) : game
      return moveCard(flipped, action.uid, 'battlefield')
    }
    case 'move':
      return moveCard(game, action.uid, action.to, action.bottom)
    case 'tap':
      return update(game, action.uid, (c) => ({ ...c, tapped: !c.tapped }))
    case 'untapAll': {
      const tapped = game.zones.battlefield.filter((uid) => game.cards[uid].tapped)
      if (!tapped.length) return game // nothing to untap: no undo step, and redo survives
      const cards = { ...game.cards }
      for (const uid of tapped) cards[uid] = { ...cards[uid], tapped: false }
      return { ...game, cards }
    }
    case 'flip':
      return update(game, action.uid, (c) => ({ ...c, backFace: !c.backFace }))
    case 'faceDown':
      return update(game, action.uid, (c) => ({ ...c, faceDown: !c.faceDown }))
    case 'counter':
      // Nothing to remove (+1/+1 goes negative as -1/-1 instead): no undo step, and redo survives.
      if (action.kind !== '+1/+1' && action.delta < 0 && !game.cards[action.uid]?.counters[action.kind]) return game
      return update(game, action.uid, (c) => {
        const counters = { ...c.counters, [action.kind]: (c.counters[action.kind] ?? 0) + action.delta }
        // +1/+1 is a net count: below zero it's -1/-1 counters (the two cancel out, as in the rules).
        if (action.kind === '+1/+1' ? counters[action.kind] === 0 : counters[action.kind] <= 0) delete counters[action.kind]
        return { ...c, counters }
      })
    case 'life':
      return { ...game, life: game.life + action.delta }
    case 'shuffle': {
      // A tutor like Vampiric's: the card put on top during the search stays there after the search's shuffle.
      const after = action.keepToppedAfter
      let kept = 0
      while (after !== undefined && kept < game.zones.library.length && (game.cards[game.zones.library[kept]].topped ?? 0) > after) kept++
      const [rest, rng] = shuffled(game.zones.library.slice(kept), game.rng)
      return { ...game, rng, zones: { ...game.zones, library: [...game.zones.library.slice(0, kept), ...rest] } }
    }
    case 'copy':
      return game.phase === 'playing' && game.cards[action.uid] ? addToken(game, game.cards[action.uid].card, game.cards[action.uid]) : game
    case 'token': {
      // The token tray can still be open after an undo back to the opening hand: no tokens before the game starts.
      if (game.phase !== 'playing') return game
      let next = game
      for (let i = 0; i < (action.count ?? 1); i++) next = addToken(next, action.card)
      return next
    }
    case 'attach': {
      if (game.phase !== 'playing' || !game.cards[action.uid]) return game
      if (!action.to) return game.cards[action.uid].attachedTo ? update(game, action.uid, (c) => ({ ...c, attachedTo: undefined })) : game
      const host = game.cards[action.to]?.attachedTo ?? action.to // onto an aura: onto what that's on
      if (host === action.uid || game.cards[action.uid].attachedTo === host || !game.zones.battlefield.includes(host)) return game
      const next = zoneOf(game, action.uid) === 'battlefield' ? game : moveCard(game, action.uid, 'battlefield')
      // What was on it comes along: one level of attachments, so the battlefield draws each host with all of its own.
      const cards = { ...next.cards }
      for (const u of next.zones.battlefield) if (u === action.uid || cards[u].attachedTo === action.uid) cards[u] = { ...cards[u], attachedTo: host }
      return { ...next, cards }
    }
  }
}

// Turn 1 starts once the hand is kept, with a draw if the game draws on turn 1.
function begin(game: Game): Game {
  const started = { ...game, phase: 'playing' as const, turn: 1 }
  return game.drawFirstTurn ? draw(started, 1) : started
}

// Undo/redo: every action keeps the state before it. Cards are shared between snapshots, so they're cheap.
export interface History {
  past: Game[]
  present: Game
  future: Game[]
}

const maxHistory = 300

export type HistoryAction = Action | { type: 'undo' } | { type: 'redo' } | { type: 'reset'; game: Game }

export function applyHistory(h: History, action: HistoryAction): History {
  switch (action.type) {
    case 'undo':
      return h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h
    case 'redo':
      return h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h
    case 'reset': // a new game or a replay; undo goes back to the game before it
      return { past: [...h.past, h.present].slice(-maxHistory), present: action.game, future: [] }
    default: {
      const next = apply(h.present, action)
      return next === h.present ? h : { past: [...h.past, h.present].slice(-maxHistory), present: next, future: [] }
    }
  }
}
