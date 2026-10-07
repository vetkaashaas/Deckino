import classes from './ManaSymbols.module.css'

export function symbolUrl(symbol: string) {
  return `https://svgs.scryfall.io/card-symbols/${symbol.replace('/', '')}.svg`
}

// Renders {R}, {2}, {W/U}, {T} etc. as Scryfall's hotlinked symbol images, everything else as text.
export function ManaSymbols({ text }: { text: string | null }) {
  if (!text) return null
  return text.split(/(\{[^}]+\})/).map((part, i) =>
    /^\{[^}]+\}$/.test(part) ? (
      <img key={i} className={classes.symbol} src={symbolUrl(part.slice(1, -1))} alt={part} />
    ) : (
      part
    ),
  )
}
