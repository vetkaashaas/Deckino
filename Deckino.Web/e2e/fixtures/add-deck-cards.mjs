// Adds the cards of a decklist to cards.jsonl.gz from Scryfall's card API (no bulk file): the exact printing when
// the line gives set and collector number ("1 Dress Down (PLST) MH2-39"), otherwise one paper printing of the name.
// Usage: node add-deck-cards.mjs tappedout-commander.txt
// Re-running make-cards-fixture.mjs rebuilds the file without them: run this again afterwards.
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'

const fixture = new URL('./cards.jsonl.gz', import.meta.url)
const lines = gunzipSync(readFileSync(fixture)).toString().trim().split('\n')
const cards = lines.map((l) => JSON.parse(l))
const names = new Set(cards.flatMap((c) => [c.name, c.name.split(' // ')[0]]))
const printings = new Set(cards.map((c) => `${c.set}|${c.collector_number}`.toLowerCase()))

// "1x Name (SET) 123 *F*" -> { name, set, number }, without Archidekt's [Category] and ^Tag^. Moxfield writes "A / B" for Scryfall's "A // B".
const wanted = readFileSync(new URL(process.argv[2], import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.replace(/\[[^\]]*\]|\^[^^]*\^/g, '').trim().match(/^\d+x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+([^\s*]+))?)?(?:\s+\*[A-Za-z]+\*)*$/))
  .filter(Boolean)
  .map(([, name, set, number]) => ({ name: name.replaceAll(' / ', ' // '), set: set?.toLowerCase(), number }))
  .filter((w) => (w.set && w.number ? !printings.has(`${w.set}|${w.number}`.toLowerCase()) : !names.has(w.name)))
const identifiers = wanted.map((w) => (w.set && w.number ? { set: w.set, collector_number: w.number } : { name: w.name }))

// Scryfall asks for an identifying User-Agent and Accept header, and about 10 requests a second at most.
const headers = { 'User-Agent': 'Deckino/1.0 (E2E fixture)', Accept: 'application/json', 'Content-Type': 'application/json' }
const pause = () => new Promise((resolve) => setTimeout(resolve, 150))

// The newest printing matching a Scryfall search, or undefined when there is none (Scryfall answers 404).
async function newestPrinting(query) {
  await pause()
  const response = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released`, { headers })
  return response.ok ? (await response.json()).data[0] : undefined
}

const added = []
for (let i = 0; i < identifiers.length; i += 75) {
  const response = await fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers,
    body: JSON.stringify({ identifiers: identifiers.slice(i, i + 75) }),
  })
  const { data, not_found } = await response.json()
  if (not_found?.length) throw new Error(`Not on Scryfall: ${JSON.stringify(not_found)}`)
  for (let card of data) {
    // The catalogue skips digital printings, and a name-only line means an ordinary printing, as the catalogue's
    // default would be: for those, take the newest paper printing that comes in nonfoil.
    // Card names have no set of their own here: a name-only line is one whose set + number weren't asked for.
    const byName = !identifiers.some(
      (id) => id.set === card.set && id.collector_number?.toLowerCase() === card.collector_number.toLowerCase(),
    )
    if (card.digital || (byName && !card.finishes.includes('nonfoil'))) {
      // Nonfoil paper first; a card only ever printed in foil keeps its paper foil printing.
      const paper = (await newestPrinting(`!"${card.name}" -is:digital is:nonfoil`)) ?? (await newestPrinting(`!"${card.name}" -is:digital`))
      if (!paper) throw new Error(`No paper printing of ${card.name} on Scryfall`)
      card = paper
    }
    added.push(JSON.stringify(card))
  }
  await pause()
}

writeFileSync(fixture, gzipSync([...lines, ...added].join('\n') + '\n'))
console.log(`added ${added.length} printings: ${added.map((l) => JSON.parse(l).name).join(', ')}`)
