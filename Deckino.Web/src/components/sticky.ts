import { useEffect, useState } from 'react'
import classes from './Sticky.module.css'

// A bar that sticks under the header (give it `sticky`), and, once stuck, gets the header's backing so what scrolls
// under it doesn't show through: put `data-stuck={stuck || undefined}` on it.
export const sticky = classes.sticky

// A callback ref, so a bar that appears later (the import review's) is watched from when it does.
export function useStuck<T extends HTMLElement>() {
  const [el, ref] = useState<T | null>(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    if (!el) return setStuck(false)
    const top = parseFloat(getComputedStyle(el).top) || 0
    const watch = new IntersectionObserver(([e]) => setStuck(e.intersectionRatio < 1), {
      rootMargin: `${-top - 1}px 0px 0px 0px`,
      threshold: 1,
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [el])
  return [ref, stuck] as const
}
