import { useEffect, useState } from 'react'
import { getJson } from '../api'
import classes from './SetSymbol.module.css'

// Scryfall's set symbols, by the icon each set uses (a set's tokens and promos share their parent's). The set list
// loads once per page; until then, or for a set it doesn't know, the code is the guess.
let icons: Promise<Map<string, string>> | undefined
const loadIcons = () =>
  (icons ??= getJson('/api/sets')
    .then((sets) => new Map(sets.flatMap((s) => (s.icon ? [[s.code, s.icon] as const] : []))))
    .catch(() => new Map()))

// A set's symbol in its rarity's colour (or the text's, without one), as the app's SetSymbol. Decorative: the set's
// name or code is always written next to it.
export function SetSymbol({ setCode, rarity, size = 22 }: { setCode: string; rarity?: string; size?: number }) {
  const [icon, setIcon] = useState(setCode)
  useEffect(() => {
    let current = true
    void loadIcons().then((map) => current && setIcon(map.get(setCode) ?? setCode))
    return () => {
      current = false
    }
  }, [setCode])
  return (
    <span
      className={classes.symbol}
      data-rarity={rarity}
      style={{ width: size, height: size, maskImage: `url(https://svgs.scryfall.io/sets/${icon}.svg)` }}
      aria-hidden
    />
  )
}
