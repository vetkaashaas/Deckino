import { useState } from 'react'

// A choice remembered in this browser (localStorage), one of a fixed set of values; anything else stored, or no
// storage at all (private mode), falls back. Without storage the choice lasts for the page only.
export function useRemembered<T extends string | number>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      return allowed.find((a) => String(a) === saved) ?? fallback
    } catch {
      return fallback
    }
  })
  const choose = (next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, String(next))
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  }
  return [value, choose] as const
}
