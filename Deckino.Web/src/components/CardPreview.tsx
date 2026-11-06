import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CardImage } from './CardImage'
import classes from './CardPreview.module.css'

const width = 250
const height = Math.round((width * 88) / 63) // a card's proportions
const gap = 24 // from the pointer
const margin = 8 // from the window's edges

// Beside the pointer (on its left near the right edge), inside the window.
function place(box: HTMLElement, x: number, y: number) {
  const left = x + gap + width > window.innerWidth - margin ? x - gap - width : x + gap
  const top = Math.min(Math.max(margin, y - height / 2), window.innerHeight - height - margin)
  box.style.translate = `${Math.max(margin, left)}px ${top}px`
}

// The big picture of a card while a mouse is over the parts of its row marked `data-preview` (the picture and name,
// the cost and price): put it inside the row, which it listens to. It follows the pointer, goes on a click (the row
// opens the card panel), and never shows for touch.
export function CardPreview({ src, name, foil = false }: { src?: string | null; name: string; foil?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const at = useRef({ x: 0, y: 0 })
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const row = anchor.current?.parentElement
    if (!row || !src) return
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons) return
      if (!(e.target instanceof Element) || !e.target.closest('[data-preview]')) return setShown(false)
      at.current = { x: e.clientX, y: e.clientY }
      if (box.current) place(box.current, e.clientX, e.clientY)
      else setShown(true)
    }
    const hide = () => setShown(false)
    row.addEventListener('pointerenter', move)
    row.addEventListener('pointermove', move)
    row.addEventListener('pointerleave', hide)
    row.addEventListener('pointerdown', hide)
    return () => {
      row.removeEventListener('pointerenter', move)
      row.removeEventListener('pointermove', move)
      row.removeEventListener('pointerleave', hide)
      row.removeEventListener('pointerdown', hide)
      setShown(false)
    }
  }, [src])

  return (
    <>
      <span ref={anchor} hidden />
      {shown &&
        src &&
        createPortal(
          <div
            ref={(el) => {
              box.current = el
              if (el) place(el, at.current.x, at.current.y)
            }}
            className={classes.preview}
            style={{ width }}
            aria-hidden="true"
          >
            <CardImage src={src} alt={name} foil={foil} />
          </div>,
          document.body,
        )}
    </>
  )
}
