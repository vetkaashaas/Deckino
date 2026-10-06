// Builds cards.jsonl.gz, the small Scryfall catalogue the E2E tests sync from.
// Usage: node make-cards-fixture.mjs <default-cards-*.jsonl.gz from https://api.scryfall.com/bulk-data>
import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip, gzipSync } from 'node:zlib'

const allPrintings = new Set([
  'Lightning Bolt',
  'Delver of Secrets // Insectile Aberration', // transform: two images
  'Valki, God of Lies // Tibalt, Cosmic Impostor', // modal_dfc
  'Fire // Ice', // split: one image, two faces
  'Bonecrusher Giant // Stomp', // adventure
  'Ghalta, Primal Hunger // Ghalta, Primal Hunger', // reversible_card: no top-level oracle_id
  'Black Lotus',
  'Thalia, Guardian of Thraben',
  "Atraxa, Praetors' Voice",
])
const limited = { Forest: 40, Goblin: 5 } // many printings; tests the grouping and default printing
const byLayout = { art_series: 3, emblem: 1 }

const picked = []
const forests = []
const lines = createInterface({ input: createReadStream(process.argv[2]).pipe(createGunzip()) })
for await (const line of lines) {
  if (!line.trim()) continue
  const card = JSON.parse(line)
  if (allPrintings.has(card.name)) picked.push(line) // digital printings too: tests the paper-only rule
  else if (card.digital) continue
  else if (card.name === 'Forest' && card.layout === 'normal') forests.push(card)
  else if (limited[card.name] > 0 && card.layout === 'token') {
    limited[card.name]--
    picked.push(line)
  } else if (byLayout[card.layout] > 0) {
    byLayout[card.layout]--
    picked.push(line)
  }
}

// Newest Forests (full-art, Secret Lair and promos among them) plus Alpha's.
forests.sort((a, b) => b.released_at.localeCompare(a.released_at))
const forestPick = [...forests.slice(0, limited.Forest - 2), ...forests.filter((f) => f.set === 'lea')]
picked.push(...forestPick.map((f) => JSON.stringify(f)))

writeFileSync(new URL('./cards.jsonl.gz', import.meta.url), gzipSync(picked.join('\n') + '\n'))
console.log(`wrote ${picked.length} printings`)
