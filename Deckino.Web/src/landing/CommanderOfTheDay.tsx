import { ActionIcon, Text, Tooltip } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { IconRotate } from '@tabler/icons-react'
import { useEffect, useState, type HTMLAttributes, type PointerEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { getJson } from '../api'
import { CardImage } from '../components/CardImage'
import classes from './CommanderOfTheDay.module.css'

// GET /api/commander-of-the-day. Images: one, or one per face (front first).
export interface CommanderCard {
  id: string
  name: string
  typeLine: string | null
  images: string[]
  artCrop: string | null
  artist: string | null
}

// One request per UTC day, shared by every widget (landing, then log in, then register…). A failed one is retried.
let today: { day: string; card: Promise<CommanderCard> } | undefined
function fetchCommander() {
  const day = new Date().toISOString().slice(0, 10)
  if (today?.day !== day) {
    const card = getJson<CommanderCard>('/api/commander-of-the-day')
    card.catch(() => today?.card === card && (today = undefined))
    today = { day, card }
  }
  return today.card
}

// undefined while loading, null when there is none (an empty catalogue).
export function useCommanderOfTheDay() {
  const [card, setCard] = useState<CommanderCard | null>()
  useEffect(() => {
    let current = true
    fetchCommander()
      .then((c) => current && setCard(c))
      .catch(() => current && setCard(null))
    return () => {
      current = false
    }
  }, [])
  return card
}

// The card page once the card has loaded; until then the placeholder links nowhere.
function CardLink({ card, children, ...pointer }: { card?: CommanderCard; children: ReactNode } & Pick<HTMLAttributes<HTMLElement>, 'onPointerMove' | 'onPointerLeave'>) {
  return card ? (
    <Link to={`/cards/${card.id}`} className={classes.link} aria-label={`${card.name}, Commander of the Day`} {...pointer}>
      {children}
    </Link>
  ) : (
    <div className={classes.link}>{children}</div>
  )
}

// The full card, floating gently and tilting towards the pointer, with a soft glare; on touch screens it sways
// on its own. Still with reduced motion. Never cropped: the artist and copyright line stay visible.
export function CommanderOfTheDay({ caption = true }: { caption?: boolean }) {
  const card = useCommanderOfTheDay()
  const still = useReducedMotion(false, { getInitialValueInEffect: false }) // known on the first render, before any pointer move
  const [flipped, setFlipped] = useState(false)

  if (card === null) return null

  function tilt(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse') return // touch gets the idle sway instead
    const box = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width // 0..1
    const y = (event.clientY - box.top) / box.height
    const style = event.currentTarget.style
    style.setProperty('--ry', `${(x - 0.5) * 18}deg`)
    style.setProperty('--rx', `${(0.5 - y) * 14}deg`)
    style.setProperty('--gx', `${x * 100}%`)
    style.setProperty('--gy', `${y * 100}%`)
    event.currentTarget.dataset.active = ''
  }

  function settle(event: PointerEvent<HTMLElement>) {
    const style = event.currentTarget.style
    style.removeProperty('--rx')
    style.removeProperty('--ry')
    delete event.currentTarget.dataset.active
  }

  const [front, back] = card?.images ?? []
  return (
    <figure className={classes.root} data-testid="commander-of-the-day" aria-busy={card === undefined || undefined}>
      <div className={classes.stage}>
        {card?.artCrop && <img className={classes.halo} src={card.artCrop} alt="" aria-hidden="true" />}
        <CardLink card={card} onPointerMove={still ? undefined : tilt} onPointerLeave={still ? undefined : settle}>
          <div className={classes.float} data-testid="commander-card">
            <div className={classes.tilt}>
              <div className={classes.faces} data-flipped={flipped || undefined}>
                <div className={classes.face}>
                  <CardImage src={front} placeholder={!card} alt={card?.name ?? ''} />
                </div>
                {back && (
                  <div className={`${classes.face} ${classes.back}`}>
                    <CardImage src={back} alt={`${card!.name} (back face)`} lazy />
                  </div>
                )}
              </div>
              <span className={classes.glare} aria-hidden="true" />
            </div>
          </div>
        </CardLink>
        <span className={classes.shadow} aria-hidden="true" />
        {back && (
          <Tooltip label={flipped ? 'Show front face' : 'Show back face'}>
            <ActionIcon
              className={classes.flip}
              variant="default"
              radius="xl"
              size="lg"
              aria-label="Show back face" // a toggle: one label, and aria-pressed says whether it's showing
              aria-pressed={flipped}
              onClick={() => setFlipped(!flipped)}
            >
              <IconRotate size={18} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>
      {caption && (
        <figcaption className={classes.caption}>
          <Text size="sm" fw={700} className={classes.eyebrow}>
            Commander of the Day
          </Text>
          <Text fw={600} size="lg" lh={1.2}>
            {card?.name ?? ' '}
          </Text>
          <Text size="sm" c="dimmed">
            {card?.typeLine ?? ' '}
          </Text>
        </figcaption>
      )}
    </figure>
  )
}
