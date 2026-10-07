import { useEffect, useRef, useState, type PointerEvent } from 'react'
import classes from './CardImage.module.css'

interface CardImageProps {
  src?: string | null // null or missing: the card has no image
  placeholder?: boolean // a slot for a card that is still loading
  alt: string
  foil?: boolean
  lazy?: boolean
  className?: string
}

// A card at a real card's proportions and corner radius, with a placeholder while it loads.
// Never cropped: Scryfall's terms require the artist and copyright line to stay visible.
// Foil cards get a sheen that follows the pointer (and stays still with reduced motion).
export function CardImage({ src, placeholder = false, alt, foil = false, lazy = false, className }: CardImageProps) {
  const image = useRef<HTMLImageElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setLoaded(Boolean(image.current?.complete && image.current.naturalWidth > 0))
    setBroken(false)
  }, [src])

  function moveSheen(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--sheen-x', `${((event.clientX - box.left) / box.width) * 100}%`)
    event.currentTarget.style.setProperty('--sheen-y', `${((event.clientY - box.top) / box.height) * 100}%`)
  }

  return (
    <div
      className={[classes.frame, className].filter(Boolean).join(' ')}
      data-loaded={loaded || undefined}
      data-loading={placeholder || (src && !loaded && !broken) || undefined}
      onPointerMove={foil ? moveSheen : undefined}
    >
      {placeholder ? null : src && !broken ? (
        <img
          ref={image}
          className={classes.image}
          src={src}
          alt={alt}
          loading={lazy ? 'lazy' : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
        />
      ) : (
        <span className={classes.missing}>{alt}</span>
      )}
      {foil && <span className={classes.foil} aria-hidden="true" />}
    </div>
  )
}
