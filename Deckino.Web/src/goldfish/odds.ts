// How a deck's opening hands and early land drops are likely to go: exact odds (hypergeometric) for the mainboard
// shuffled into a library, so they're the same on every load. A commander is never in the library.
import { countCards, isLand, type DeckEntry } from '../decks/deck'

function choose(n: number, k: number) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r
}

// The chance that n cards drawn from N, K of them hits, hold exactly k hits.
const exactly = (N: number, K: number, n: number, k: number) => (choose(K, k) * choose(N - K, n - k)) / choose(N, n)

function atLeast(N: number, K: number, n: number, k: number) {
  let p = 0
  for (let j = k; j <= Math.min(n, K); j++) p += exactly(N, K, n, j)
  return p
}

export const turns = [1, 2, 3, 4, 5, 6]

export function openingOdds(mainboard: DeckEntry[]) {
  const N = countCards(mainboard)
  const lands = countCards(mainboard.filter((e) => isLand(e.card)))
  const cheap = countCards(mainboard.filter((e) => !isLand(e.card) && e.card.manaValue <= 2))
  const hand = Math.min(7, N)
  // Cards seen by the start of turn t: the opening 7, plus a draw each turn after the first (and on turn 1 too on the draw).
  const seen = (t: number, onThePlay: boolean) => Math.min(N, 7 + t - (onThePlay ? 1 : 0))
  const landsInHand = Array.from({ length: 8 }, (_, k) => (N ? exactly(N, lands, hand, k) : 0))
  const keepable = landsInHand.slice(2, 6).reduce((a, b) => a + b, 0)
  return {
    cards: N,
    lands,
    landsInHand,
    keepable, // 2 to 5 lands in the opening 7
    // About how many mulligans a game takes when only 2–5 land hands are kept (each try is a fresh 7).
    mulligans: keepable > 0 ? (1 - keepable) / keepable : null,
    // The chance of having seen at least t lands by turn t (not of having hit every earlier drop too).
    onCurve: (onThePlay: boolean) => turns.map((t) => (N ? atLeast(N, lands, seen(t, onThePlay), t) : 0)),
    // A spell of mana value 2 or less in hand by turn 2.
    earlyPlay: (onThePlay: boolean) => (N ? atLeast(N, cheap, seen(2, onThePlay), 1) : 0),
  }
}

export const percent = (p: number) => `${Math.round(p * 100)}%`
