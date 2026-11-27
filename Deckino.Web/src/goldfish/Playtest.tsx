import { ActionIcon, Anchor, Button, Checkbox, Group, Kbd, Menu, Modal, Text, TextInput, Tooltip } from '@mantine/core'
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { getJson, sendJson } from '../api'
import type { CardSummary } from '../cards/api'
import { CardImage } from '../components/CardImage'
import { CardPreview } from '../components/CardPreview'
import { Icon, type IconName } from '../components/Icon'
import { useRemembered } from '../components/useRemembered'
import { deckLook, formatLabel, toDeckCard, type DeckCard } from '../decks/deck'
import {
  apply,
  applyHistory,
  canPlaytest,
  fingerprint,
  handSize,
  newGame,
  newSeed,
  sampleHand,
  shownImage,
  shownType,
  toBottom,
  zoneOf,
  type Game,
  type GameCard,
  type History,
  type HistoryAction,
  type PlayDeck,
  type Zone,
} from './engine'
import { OpeningOdds } from './OpeningOdds'
import classes from './Playtest.module.css'

// The playtest is open while the address has ?playtest: Back closes it, and a refresh keeps it.
export function usePlaytest() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  return {
    isOpen: params.has('playtest'),
    seed: Number(params.get('seed')) || undefined, // a fixed shuffle, for repeatable E2E screenshots
    open() {
      if (params.has('playtest')) return // already in the address (a refresh with no list kept): don't push it twice
      // Marked in the history entry (it survives a refresh), so closing goes back rather than adding an entry.
      setParams(
        (p) => {
          p.set('playtest', '')
          return p
        },
        { state: { playtest: true } },
      )
    },
    close() {
      if ((location.state as { playtest?: boolean } | null)?.playtest) navigate(-1)
      else
        setParams(
          (p) => {
            p.delete('playtest')
            p.delete('seed')
            return p
          },
          { replace: true },
        )
    },
  }
}

// The Playtest button on a deck page, and the playtest itself. `storageKey` names the game in sessionStorage, so a
// refresh picks it up again. `href` is the deck's page, which the playtest's title opens in a new tab.
export function Playtest({ deck, storageKey, href }: { deck: PlayDeck; storageKey: string; href?: string }) {
  const playtest = usePlaytest()
  const ready = canPlaytest(deck)
  return (
    <>
      <Tooltip label={`Needs at least ${handSize} cards in the mainboard`} disabled={ready}>
        {/* data-disabled, not disabled: a disabled button never fires the events that show and hide its tooltip. */}
        <Button
          variant="default"
          leftSection={<Icon name="playing_cards" size={18} />}
          data-disabled={!ready || undefined}
          aria-disabled={!ready || undefined}
          onClick={() => ready && playtest.open()}
        >
          Playtest
        </Button>
      </Tooltip>
      {ready && playtest.isOpen && <PlaytestTable deck={deck} storageKey={storageKey} href={href} seed={playtest.seed} onClose={playtest.close} />}
    </>
  )
}

const zoneNames: Record<Zone, string> = {
  library: 'Library',
  hand: 'Hand',
  battlefield: 'Battlefield',
  graveyard: 'Graveyard',
  exile: 'Exile',
  command: 'Command zone',
  sideboard: 'Sideboard',
}

// Faint light from the deck's colours behind the battlefield.
const colourLight: Record<string, string> = { W: '248 236 196', U: '74 144 226', B: '139 111 168', R: '226 85 61', G: '63 163 91' }

// Card sizes on the table, remembered in this browser.
const zoomLevels = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2] as const

type Drawer =
  | { kind: 'graveyard' | 'exile' | 'sideboard' | 'search' | 'tokens' | 'stats' }
  | { kind: 'top'; uids: string[] }
  | { kind: 'sample'; cards: DeckCard[] }

interface Saved {
  fingerprint: string
  game: Game
}

function load(key: string, deck: PlayDeck): Game | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Saved | null
    return saved?.fingerprint === fingerprint(deck) ? saved.game : null
  } catch {
    return null
  }
}

export function PlaytestTable({
  deck,
  storageKey,
  href,
  seed,
  onClose,
}: {
  deck: PlayDeck
  storageKey: string
  href?: string
  seed?: number
  onClose: () => void
}) {
  const key = `deckino.playtest:${storageKey}`
  // Remembered apart for Commander (draws on turn 1 by default) and the two-player formats (don't).
  const commander = deck.format === 'commander'
  const [drawFirst, setDrawFirst] = useRemembered(`deckino.playtestDrawFirstTurn.${commander ? 'commander' : 'other'}`, ['yes', 'no'], commander ? 'yes' : 'no')
  const [h, dispatch] = useReducer(applyHistory, null, (): History => ({
    past: [],
    present: (seed === undefined && load(key, deck)) || newGame(deck, seed ?? newSeed(), drawFirst === 'yes'),
    future: [],
  }))
  const g = h.present
  const [drawer, setDrawer] = useState<Drawer | null>(null)
  // However a search ends (its ×, Escape, a click elsewhere, another drawer), the library is shuffled.
  const searchOpen = drawer?.kind === 'search'
  const searching = useRef(false)
  const searchFrom = useRef(0) // Game.topped when the search opened: cards it then puts on top stay there
  useEffect(() => {
    if (searching.current && !searchOpen) dispatch({ type: 'shuffle', keepToppedAfter: searchFrom.current })
    searching.current = searchOpen
  }, [searchOpen])
  const closeDrawer = () => setDrawer(null)
  const [menu, setMenu] = useState<{ uid: string; x: number; y: number } | null>(null)
  const [attaching, setAttaching] = useState<string | null>(null) // an aura or equipment waiting for a click on what it goes on
  const [help, setHelp] = useState(false)
  const [selected, setSelected] = useState<string[]>([]) // cards picked to go to the bottom after a mulligan
  // The picks belong to this bottoming: an undo, a mulligan, a new game or the bottoming itself drops them.
  const [pickedIn, setPickedIn] = useState(g.phase)
  if (pickedIn !== g.phase) {
    setPickedIn(g.phase)
    setSelected([])
  }
  const [tokens, setTokens] = useState<DeckCard[] | 'failed' | null>(null)
  const [count, setCount] = useState(3) // X for the library's draw / mill / look
  const [libraryMenu, setLibraryMenu] = useState(false)
  const hovered = useRef<string | null>(null)
  const [zoom, setZoom] = useRemembered('deckino.playtestZoom', zoomLevels, 1)
  // The biggest zoom the battlefield has room for (cards stop growing once the rows in use fill its height), read off a
  // hidden probe that is as wide as that limit and as tall as a card at 100%. The zoom steps never go past it.
  const probe = useRef<HTMLSpanElement>(null)
  const [room, setRoom] = useState(Infinity)
  useLayoutEffect(() => {
    const el = probe.current
    if (!el) return
    const measure = () => setRoom(el.offsetHeight ? el.offsetWidth / el.offsetHeight : Infinity)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const shown = Math.min(zoom, room) // how big the cards really are
  const canGrow = zoom < zoomLevels[zoomLevels.length - 1] && zoom < room - 0.005
  const canShrink = shown > zoomLevels[0] + 0.005
  const zoomBy = (step: 1 | -1) => {
    if (step > 0 ? !canGrow : !canShrink) return
    setZoom(step > 0 ? zoomLevels[zoomLevels.indexOf(zoom) + 1] : [...zoomLevels].reverse().find((l) => l < shown - 0.005)!)
  }

  // Remember the game for a refresh.
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ fingerprint: fingerprint(deck), game: g } satisfies Saved))
    } catch {
      // No storage: the game lasts for this page only.
    }
  }, [g]) // eslint-disable-line react-hooks/exhaustive-deps -- deck and key are fixed while the table is open

  // The table takes the focus, so Enter is Next turn rather than another press of the Playtest button underneath.
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => tableRef.current?.focus(), [])

  // The page underneath doesn't scroll while the table is up.
  useEffect(() => {
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = before
    }
  }, [])

  // The deck's tokens, for the token tray.
  useEffect(() => {
    const cardIds = [...new Set([...deck.commander, ...deck.mainboard, ...deck.sideboard].map((e) => e.scryfallId))].slice(0, 250) // the API's MaxTokenCards
    sendJson('POST', '/api/cards/tokens', { cardIds })
      .then(setTokens)
      .catch(() => setTokens('failed'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- once per table

  const restart = (sameSeed: boolean) => {
    searching.current = false // a new deal, not the end of a search: no shuffle on top of it
    setDrawer(null)
    setAttaching(null)
    dispatch({ type: 'reset', game: newGame(deck, sameSeed ? g.seed : newSeed(), g.drawFirstTurn) })
  }

  const playing = g.phase === 'playing'
  const card = (uid: string) => g.cards[uid]

  // A click (or Enter) on a card: what it means depends on where the card is.
  function activate(uid: string, target: Element) {
    const zone = zoneOf(g, uid)
    if (g.phase === 'bottoming' && zone === 'hand') {
      setSelected((s) => (s.includes(uid) ? s.filter((u) => u !== uid) : s.length < toBottom(g) ? [...s, uid] : s))
      return
    }
    if (!playing) return
    if (attaching) {
      // Picking what it goes on: a permanent takes it; anything else calls it off.
      setAttaching(null)
      if (zone === 'battlefield' && uid !== attaching) dispatch({ type: 'attach', uid: attaching, to: uid })
      return
    }
    const box = target.getBoundingClientRect()
    if (target.closest('[data-drawer]')) return setMenu({ uid, x: box.left + box.width / 2, y: box.top + box.height / 2 })
    // An emblem parked in the command zone stays there; only a commander is cast from it by a click.
    // An aura is cast onto something: pick it first (a click on the battlefield's empty space casts it on its own).
    if (zone === 'hand' && shownType(card(uid)).includes('Aura') && g.zones.battlefield.length) setAttaching(uid)
    else if (zone === 'hand' || (zone === 'command' && card(uid).commander)) dispatch({ type: 'play', uid })
    else if (zone === 'battlefield') dispatch({ type: 'tap', uid })
    else if (zone === 'graveyard' || zone === 'exile') setDrawer({ kind: zone })
  }

  function drop(uid: string, to: Zone, bottom: boolean, onto: string | null) {
    const from = zoneOf(g, uid)
    if (onto) return dispatch({ type: 'attach', uid, to: onto })
    // Dragged off what it was on, onto the battlefield's empty space: on its own again.
    if (from === 'battlefield' && to === 'battlefield' && card(uid).attachedTo) return dispatch({ type: 'attach', uid })
    // Within the library only Shift (to the bottom) moves anything: a looked-at card sent under.
    if (!from || (from === to && !(to === 'library' && bottom)) || !playing) return
    if (to === 'battlefield' && (from === 'hand' || from === 'command')) dispatch({ type: 'play', uid })
    else dispatch({ type: 'move', uid, to, bottom })
  }

  // Dragging: pointer events, a picture of the card under the pointer, and the zone under it lit up.
  const drag = useRef<{ uid: string; x: number; y: number; moved: boolean } | null>(null)
  const justDragged = useRef(false)
  const [ghost, setGhost] = useState<{ uid: string; x: number; y: number; w: number } | null>(null)
  const ghostEl = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<Zone | null>(null)
  const [onto, setOnto] = useState<string | null>(null) // the permanent a dragged aura or equipment would go on
  useEffect(() => {
    const zoneAt = (x: number, y: number) =>
      (document.elementFromPoint(x, y)?.closest('[data-zone]')?.getAttribute('data-zone') as Zone | undefined) ?? null
    const ontoAt = (x: number, y: number, uid: string) => {
      const c = card(uid)
      if (c.faceDown || !/\b(Aura|Equipment|Fortification)\b/.test(shownType(c))) return null // anything else lands beside it
      const host = document.elementFromPoint(x, y)?.closest('[data-zone="battlefield"] [data-uid]')?.getAttribute('data-uid')
      return host && host !== uid && card(host).attachedTo !== uid ? host : null
    }
    function move(e: PointerEvent) {
      const d = drag.current
      if (!d) return
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return
        d.moved = true
        // The ghost is as big as the card picked up (its shorter side: a tapped card lies on its side).
        const box = document.querySelector(`[data-uid="${d.uid}"]`)?.getBoundingClientRect()
        setGhost({ uid: d.uid, x: e.clientX, y: e.clientY, w: box ? Math.min(box.width, box.height) : 96 })
      } else if (ghostEl.current) {
        // Moved in place, so the table doesn't render again on every pointer move (only when the zone under it changes).
        ghostEl.current.style.translate = `calc(${e.clientX}px - 50%) calc(${e.clientY}px - 50%)`
      }
      const host = ontoAt(e.clientX, e.clientY, d.uid)
      setOnto(host)
      setOver(host ? null : zoneAt(e.clientX, e.clientY))
    }
    function up(e: PointerEvent) {
      const d = drag.current
      drag.current = null
      if (!d?.moved) return
      justDragged.current = true
      setTimeout(() => (justDragged.current = false))
      setGhost(null)
      setOver(null)
      setOnto(null)
      const zone = e.type === 'pointercancel' ? null : zoneAt(e.clientX, e.clientY) // a cancelled drag drops nothing
      if (zone) drop(d.uid, zone, e.shiftKey, ontoAt(e.clientX, e.clientY, d.uid))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  })

  // Keyboard shortcuts (not while typing, and not on top of a menu or dialog's own keys).
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      const k = e.key.toLowerCase()
      // Escape still works from the search box (it has the focus), so it ends a search.
      // A checkbox (Draw on turn 1) keeps the shortcuts: K right after ticking it should keep.
      if (k !== 'escape' && t.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return
      // A menu or dialog closes itself on Escape. Undo waits too: undoing the card a menu is for would leave the menu
      // state set with nothing shown, and every shortcut dead.
      if (menu || help || document.querySelector('[role="menu"]')) return
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        e.preventDefault()
        dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' })
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (k === 'escape') return attaching ? setAttaching(null) : drawer ? closeDrawer() : onClose()
      // Enter presses a button the keyboard focused; one focused by a mouse click (Undo, the library) leaves Enter as Next turn.
      if (k === 'enter' && t.closest('button, [role="button"], a') && t.matches(':focus-visible')) return
      const shortcut: Record<string, () => void> = {
        d: () => playing && dispatch({ type: 'draw' }),
        enter: () => playing && dispatch({ type: 'nextTurn' }),
        u: () => playing && dispatch({ type: 'untapAll' }),
        s: () => playing && dispatch({ type: 'shuffle' }),
        m: () => dispatch({ type: 'mulligan' }),
        k: () => dispatch({ type: 'keep' }),
        r: () => restart(true),
        n: () => restart(false),
        t: () => playing && setDrawer((d) => (d?.kind === 'tokens' ? null : { kind: 'tokens' })),
        h: () => setDrawer({ kind: 'sample', cards: sampleHand(deck) }),
        f: () => {
          const uid = hovered.current
          if (uid && card(uid)?.card.backImage && zoneOf(g, uid) === 'battlefield') dispatch({ type: 'flip', uid })
        },
        '?': () => setHelp(true),
        '+': () => zoomBy(1),
        '=': () => zoomBy(1),
        '-': () => zoomBy(-1),
      }
      if (shortcut[k]) {
        e.preventDefault()
        shortcut[k]()
      }
    }
    // Capture: a focused button's tooltip swallows Escape before it would bubble up.
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  const look = deckLook(deck)
  const light = look.colors.length ? look.colors : ['W', 'U', 'B', 'R', 'G']
  const wash = light
    .map((c, i) => `radial-gradient(circle at ${light.length === 1 ? 50 : (i / (light.length - 1)) * 100}% 0%, rgb(${colourLight[c]} / 0.10), transparent 55%)`)
    .join(', ')

  // The battlefield in rows: creatures, other permanents, lands. Untapped copies of the same land with nothing on
  // them stack into one pile.
  const rows: Record<'creatures' | 'other' | 'lands', { uid: string; pile: number }[]> = { creatures: [], other: [], lands: [] }
  const piles = new Map<string, { uid: string; pile: number }>()
  const attached = new Map<string, string[]>() // host -> what's on it, in the order they came into play
  for (const uid of g.zones.battlefield) {
    const host = card(uid).attachedTo
    if (host && g.zones.battlefield.includes(host)) attached.set(host, [...(attached.get(host) ?? []), uid])
  }
  for (const uid of g.zones.battlefield) {
    if (attached.has(card(uid).attachedTo ?? '')) continue // drawn with its host
    const c = card(uid)
    const type = c.faceDown ? 'Creature' : shownType(c)
    const row = type.includes('Land') ? 'lands' : type.includes('Creature') ? 'creatures' : 'other'
    const stackable = row === 'lands' && !c.tapped && !c.token && !c.backFace && Object.keys(c.counters).length === 0 && !attached.has(uid)
    const pile = stackable ? piles.get(c.card.id) : undefined
    if (pile) {
      pile.pile++
      pile.uid = uid // the newest copy on top, so a click taps the one played last
      continue
    }
    const slot = { uid, pile: 1 }
    if (stackable) piles.set(c.card.id, slot)
    rows[row].push(slot)
  }

  const landsInPlay = g.zones.battlefield.filter((u) => !card(u).faceDown && shownType(card(u)).includes('Land')).length
  const libraryTop = g.zones.library[0]

  const slot = (uid: string, options: { pile?: number; size?: 'small' | 'hand' | 'big'; style?: CSSProperties } = {}) => (
    <Slot
      key={uid}
      c={card(uid)}
      pile={options.pile}
      size={options.size}
      selected={selected.includes(uid) || attaching === uid}
      commanderTax={g.zones.command.includes(uid)}
      host={card(uid).attachedTo && card(card(uid).attachedTo!)?.card.name}
      target={onto === uid}
      style={options.style}
    />
  )

  // A permanent with auras or equipment: they peek out above it, behind it.
  const fieldSlot = (s: { uid: string; pile: number }) => {
    const on = attached.get(s.uid)
    if (!on) return slot(s.uid, { pile: s.pile })
    return (
      <div key={s.uid} className={classes.attached}>
        {on.map((u, i) => slot(u, { style: { '--i': i } as CSSProperties }))}
        {slot(s.uid, { style: { '--i': on.length } as CSSProperties })}
      </div>
    )
  }

  // Over the board, or during the opening hand over its scrim (the board's drawer would sit under it).
  const drawerPanel = drawer && (
    <DrawerPanel
      key={drawer.kind} // a search's filter doesn't carry over to the graveyard
      drawer={drawer}
      g={g}
      tokens={tokens}
      mainboard={deck.mainboard}
      format={deck.format}
      onDeal={() => setDrawer({ kind: 'sample', cards: sampleHand(deck) })}
      slot={(uid) => slot(uid, { size: 'small' })}
      onToken={(c, n) => dispatch({ type: 'token', card: c, count: n })}
      onClose={closeDrawer}
    />
  )

  return createPortal(
    <div
      ref={tableRef}
      tabIndex={-1}
      className={classes.table}
      role="dialog"
      aria-modal="true"
      aria-label={`Playtest: ${deck.name}`}
      style={{ '--wash': wash, '--zoom': zoom } as CSSProperties}
      data-attaching={attaching ? '' : undefined}
      onPointerDown={(e) => {
        // A click on the table (the battlefield, the hand, the command zone) puts the side drawer away. The header, the
        // piles that open drawers and the drawer itself keep it, as do menus and dialogs (portaled outside the table).
        const t = e.target as Element
        if (drawer && t.closest('[role="dialog"]') === e.currentTarget && !t.closest('[data-drawer], header, [data-zone="graveyard"], [data-zone="exile"], [data-zone="library"]')) closeDrawer()
        if (e.button !== 0) return
        const el = (e.target as Element).closest('[data-uid]')
        if (el && playing) drag.current = { uid: el.getAttribute('data-uid')!, x: e.clientX, y: e.clientY, moved: false }
      }}
      onPointerOver={(e) => (hovered.current = (e.target as Element).closest('[data-uid]')?.getAttribute('data-uid') ?? null)}
      onClick={(e) => {
        if (justDragged.current) return
        const el = (e.target as Element).closest('[data-uid]')
        if (!el && attaching) {
          // Not a card: the battlefield's empty space casts the aura on its own; anywhere else calls it off.
          if ((e.target as Element).closest('[data-zone="battlefield"]') && zoneOf(g, attaching) === 'hand') dispatch({ type: 'play', uid: attaching })
          setAttaching(null)
        }
        if (!el) return
        activate(el.getAttribute('data-uid')!, el)
        // A mouse click focuses the card; give the focus back, or the next Enter taps it again instead of Next turn.
        if (e.detail) tableRef.current?.focus({ preventScroll: true })
      }}
      onKeyDown={(e) => {
        const el = (e.target as Element).closest('[data-uid]')
        if (el && (e.key === 'Enter' || e.key === ' ') && e.target === el) {
          e.preventDefault()
          activate(el.getAttribute('data-uid')!, el)
        }
      }}
      onContextMenu={(e) => {
        const el = (e.target as Element).closest('[data-uid]')
        if (!el || !playing) return
        e.preventDefault()
        setMenu({ uid: el.getAttribute('data-uid')!, x: e.clientX, y: e.clientY })
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      <header className={classes.bar}>
        <Group gap="sm" wrap="nowrap" className={classes.title}>
          <Tooltip label="Close (Esc)">
            <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Close playtest" onClick={onClose}>
              <Icon name="close" size={20} />
            </ActionIcon>
          </Tooltip>
          <div className={classes.name}>
            {href ? (
              <Anchor href={href} target="_blank" rel="noopener" fw={700} c="inherit" truncate display="block" title="Open the deck in a new tab">
                {deck.name}
              </Anchor>
            ) : (
              <Text fw={700} truncate>
                {deck.name}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {formatLabel(deck.format)}
              {g.mulligans > 0 && ` · Mulligans: ${g.mulligans}`}
            </Text>
          </div>
        </Group>

        <Group gap="lg" wrap="nowrap" className={classes.status}>
          <span className={classes.turn} data-testid="turn">
            {playing ? `Turn ${g.turn}` : 'Opening hand'}
          </span>
          <Group gap={4} wrap="nowrap" onWheel={(e) => Math.abs(e.deltaY) >= 40 && dispatch({ type: 'life', delta: e.deltaY < 0 ? 1 : -1 })}>
            <ActionIcon variant="subtle" color="gray" aria-label="Lose 1 life" onClick={() => dispatch({ type: 'life', delta: -1 })}>
              <Icon name="remove" size={18} />
            </ActionIcon>
            <span className={classes.lifeTotal} data-testid="life" aria-label={`Life: ${g.life}`}>
              <Icon name="favorite" size={16} /> {g.life}
            </span>
            <ActionIcon variant="subtle" color="gray" aria-label="Gain 1 life" onClick={() => dispatch({ type: 'life', delta: 1 })}>
              <Icon name="add" size={18} />
            </ActionIcon>
          </Group>
        </Group>

        <Group gap="xs" wrap="nowrap" className={classes.actions}>
          <div className={classes.zoom} role="group" aria-label="Card size">
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Smaller cards" disabled={!canShrink} onClick={() => zoomBy(-1)}>
              <Icon name="zoom_out" size={16} />
            </ActionIcon>
            <span className={classes.zoomValue} data-testid="zoom">
              {Math.round(shown * 100)}%
            </span>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Bigger cards" disabled={!canGrow} onClick={() => zoomBy(1)}>
              <Icon name="zoom_in" size={16} />
            </ActionIcon>
          </div>
          <Tooltip label="Untap, then draw (Enter)">
            <Button variant="gradient" leftSection={<Icon name="skip_next" size={18} />} disabled={!playing} onClick={() => dispatch({ type: 'nextTurn' })}>
              Next turn
            </Button>
          </Tooltip>
          <BarButton icon="rotate_right" label="Untap all (U)" disabled={!playing} onClick={() => dispatch({ type: 'untapAll' })} />
          <BarButton icon="token" label="Tokens (T)" disabled={!playing} onClick={() => setDrawer(drawer?.kind === 'tokens' ? null : { kind: 'tokens' })} />
          <BarButton icon="bar_chart" label="Opening-hand odds" onClick={() => setDrawer(drawer?.kind === 'stats' ? null : { kind: 'stats' })} />
          <BarButton icon="undo" label="Undo (Ctrl+Z)" disabled={!h.past.length} onClick={() => dispatch({ type: 'undo' })} />
          <BarButton icon="redo" label="Redo (Ctrl+Shift+Z)" disabled={!h.future.length} onClick={() => dispatch({ type: 'redo' })} />
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="default" size="lg" aria-label="Game">
                <Icon name="more_horiz" size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<Icon name="replay" size={16} />} rightSection={<Kbd size="xs">R</Kbd>} onClick={() => restart(true)}>
                Replay this shuffle
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="refresh" size={16} />} rightSection={<Kbd size="xs">N</Kbd>} onClick={() => restart(false)}>
                New game
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="front_hand" size={16} />} rightSection={<Kbd size="xs">H</Kbd>} onClick={() => setDrawer({ kind: 'sample', cards: sampleHand(deck) })}>
                Deal a sample hand
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="layers" size={16} />} onClick={() => setDrawer({ kind: 'sideboard' })} disabled={!g.zones.sideboard.length}>
                Sideboard ({g.zones.sideboard.length})
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<Icon name="keyboard" size={16} />} rightSection={<Kbd size="xs">?</Kbd>} onClick={() => setHelp(true)}>
                Keyboard shortcuts
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </header>

      <div className={classes.board}>
        <section className={classes.side} aria-label="Command zone" data-zone="command" data-over={over === 'command' || undefined}>
          <span className={classes.zoneLabel}>Command</span>
          <div className={classes.stackList}>{g.zones.command.map((uid) => slot(uid, { size: 'small' }))}</div>
        </section>

        <div className={classes.field}>
          {attaching && card(attaching) && (
            <p className={classes.pickHint} role="status">
              Choose what {card(attaching).card.name} goes on{zoneOf(g, attaching) === 'hand' && ' · empty space casts it on its own'} · Esc cancels
            </p>
          )}
          <section className={classes.battlefield} aria-label="Battlefield" data-zone="battlefield" data-over={over === 'battlefield' || undefined}>
            <span ref={probe} className={classes.probe} aria-hidden />
            {(['creatures', 'other', 'lands'] as const).map((row) => (
              <div key={row} className={classes.row} data-row={row} aria-label={row === 'creatures' ? 'Creatures' : row === 'lands' ? 'Lands' : 'Other permanents'} role="group">
                {rows[row].map(fieldSlot)}
              </div>
            ))}
            {g.zones.battlefield.length === 0 && playing && (
              <p className={classes.emptyHint}>Click a card in your hand to play it, or drag it here.</p>
            )}
          </section>
        </div>

        <aside className={classes.side} aria-label="Library and graveyard">
          <div className={classes.pileZone} data-zone="library" data-over={over === 'library' || undefined}>
            <span className={classes.zoneLabel}>
              Library <b data-testid="library-count">{g.zones.library.length}</b>
            </span>
            {/* Click draws; right-click (or the menu key) opens the rest. The menu only opens from there. */}
            <Menu position="left-start" withinPortal closeOnItemClick returnFocus={false} opened={libraryMenu} onChange={(o) => !o && setLibraryMenu(false)}>
              <Menu.Target>
                <button
                  type="button"
                  className={classes.libraryButton}
                  aria-label={`Library, ${g.zones.library.length} cards`}
                  title="Click to draw · right-click for more"
                  disabled={!playing}
                  onClick={() => dispatch({ type: 'draw' })}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setLibraryMenu(true)
                  }}
                >
                  {libraryTop ? <CardBack /> : <span className={classes.emptyPile}>Empty</span>}
                </button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<Icon name="add" size={16} />} rightSection={<Kbd size="xs">D</Kbd>} onClick={() => dispatch({ type: 'draw' })}>
                  Draw a card
                </Menu.Item>
                <Menu.Label>
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <span>Cards: {count}</span>
                    <Group gap={2} wrap="nowrap">
                      <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Fewer" onClick={() => setCount((c) => Math.max(1, c - 1))}>
                        <Icon name="remove" size={14} />
                      </ActionIcon>
                      <ActionIcon size="sm" variant="subtle" color="gray" aria-label="More" onClick={() => setCount((c) => Math.min(99, c + 1))}>
                        <Icon name="add" size={14} />
                      </ActionIcon>
                    </Group>
                  </Group>
                </Menu.Label>
                <Menu.Item onClick={() => dispatch({ type: 'draw', count })}>Draw {count}</Menu.Item>
                <Menu.Item onClick={() => dispatch({ type: 'mill', count })}>Mill {count}</Menu.Item>
                <Menu.Item
                  onClick={() => {
                    // Ending a search shuffles (the effect above) after this: look at the top of that same seeded shuffle.
                    const library = (searchOpen ? apply(g, { type: 'shuffle', keepToppedAfter: searchFrom.current }) : g).zones.library
                    setDrawer({ kind: 'top', uids: library.slice(0, count) })
                  }}
                >
                  Look at the top {count}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item leftSection={<Icon name="search" size={16} />} onClick={() => {
                    searchFrom.current = g.topped ?? 0
                    setDrawer({ kind: 'search' })
                  }}
                >
                  Search the library
                </Menu.Item>
                <Menu.Item leftSection={<Icon name="shuffle" size={16} />} rightSection={<Kbd size="xs">S</Kbd>} onClick={() => dispatch({ type: 'shuffle' })}>
                  Shuffle
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
          <PileZone zone="graveyard" over={over} uids={g.zones.graveyard} card={card} onOpen={() => setDrawer({ kind: 'graveyard' })} />
          <PileZone zone="exile" over={over} uids={g.zones.exile} card={card} onOpen={() => setDrawer({ kind: 'exile' })} />
        </aside>

        {playing && drawerPanel}
      </div>

      <section className={classes.hand} aria-label="Hand" data-zone="hand" data-over={over === 'hand' || undefined}>
        <div
          className={classes.handCards}
          // A mouse wheel scrolls a hand wider than the screen sideways (a trackpad's own sideways swipe still works).
          onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 40 : 1)
          }}
        >{playing && g.zones.hand.map((uid) => slot(uid, { size: 'hand' }))}</div>
        <dl className={classes.handFacts}>
          <div>
            <dt>Hand</dt>
            <dd>{g.zones.hand.length}</dd>
          </div>
          <div data-warn={g.landsThisTurn >= 2 || undefined} title={g.landsThisTurn >= 2 ? 'More than one land this turn' : undefined}>
            <dt>Lands this turn</dt>
            <dd data-testid="lands-this-turn">{g.landsThisTurn}</dd>
          </div>
          <div>
            <dt>Lands in play</dt>
            <dd>{landsInPlay}</dd>
          </div>
        </dl>
      </section>

      {!playing && (
        <OpeningHand
          g={g}
          selected={selected}
          slot={(uid) => slot(uid, { size: 'big' })}
          drawFirstTurn={g.drawFirstTurn}
          setDrawFirstTurn={(value) => {
            setDrawFirst(value ? 'yes' : 'no')
            dispatch({ type: 'setDrawFirstTurn', value })
          }}
          onMulligan={(free) => dispatch({ type: 'mulligan', free })}
          onKeep={() => dispatch({ type: 'keep' })}
          onBottom={() => dispatch({ type: 'bottom', uids: selected })}
        >
          {drawerPanel}
        </OpeningHand>
      )}

      {menu && card(menu.uid) && (
        <CardMenu key={`${menu.uid}:${menu.x}:${menu.y}`} at={menu} g={g} dispatch={dispatch} onAttach={() => setAttaching(menu.uid)} onClose={() => setMenu(null)} />
      )}

      {ghost && card(ghost.uid) && (
        <div ref={ghostEl} className={classes.ghost} style={{ width: ghost.w, translate: `calc(${ghost.x}px - 50%) calc(${ghost.y}px - 50%)` }} aria-hidden="true">
          {card(ghost.uid).faceDown ? <CardBack /> : <CardImage src={shownImage(card(ghost.uid))} alt="" />}
        </div>
      )}

      <Modal opened={help} onClose={() => setHelp(false)} title="Keyboard shortcuts" centered zIndex={400}>
        <dl className={classes.keys}>
          {[
            ['D', 'Draw a card'],
            ['Enter', 'Next turn: untap, then draw'],
            ['U', 'Untap all'],
            ['S', 'Shuffle the library'],
            ['T', 'Tokens'],
            ['H', 'Deal a sample hand (the game is untouched)'],
            ['F', 'Flip the card under the pointer'],
            ['M / K', 'Mulligan / keep (opening hand)'],
            ['Ctrl+Z', 'Undo'],
            ['Ctrl+Shift+Z', 'Redo'],
            ['R', 'Replay the same shuffle'],
            ['N', 'New game'],
            ['+ / −', 'Bigger / smaller cards'],
            ['Esc', 'Close'],
          ].map(([k, what]) => (
            <div key={k}>
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <Text size="sm" c="dimmed" mt="md">
          Click a card in hand to play it, click a permanent to tap it, click the library to draw, drag cards between zones (hold Shift to put one on
          the bottom of the library), drag an aura or equipment onto a permanent to attach it, and right-click for everything else.
        </Text>
      </Modal>
    </div>,
    document.body,
  )
}

function BarButton({ icon, label, disabled, onClick }: { icon: IconName; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <ActionIcon variant="default" size="lg" aria-label={label.replace(/ \(.*\)$/, '')} disabled={disabled} onClick={onClick}>
        <Icon name={icon} size={18} />
      </ActionIcon>
    </Tooltip>
  )
}

export function CardBack() {
  return (
    <span className={classes.back} aria-hidden="true">
      <img src="/favicon.svg" alt="" />
    </span>
  )
}

// A negative +1/+1 count shows as -1/-1 counters.
const counterKind = (kind: string, n: number) => (kind === '+1/+1' && n < 0 ? '-1/-1' : kind)

function counterLabel(kind: string, n: number) {
  if (kind === '+1/+1') return n < 0 ? `−${-n}/−${-n}` : `+${n}/+${n}`
  return `${kind === 'loyalty' ? 'Loyalty' : 'Counters'} ${n}`
}

function Slot(props: {
  c: GameCard
  pile?: number
  size?: 'small' | 'hand' | 'big'
  selected: boolean
  commanderTax: boolean
  host?: string // the name of what it's attached to
  target?: boolean // a dragged aura or equipment would go on it
  style?: CSSProperties
}) {
  const { c, pile = 1, size, selected, commanderTax } = props
  const src = c.faceDown ? null : shownImage(c)
  const name = c.faceDown ? 'Face-down card' : c.card.name
  const preview = src && size !== 'big' // the opening hand is big enough without the hover preview
  return (
    <div
      className={classes.slot}
      data-uid={c.uid}
      data-size={size}
      data-tapped={c.tapped || undefined}
      data-selected={selected || undefined}
      data-target={props.target || undefined}
      data-preview={preview ? '' : undefined}
      style={props.style}
      role="button"
      tabIndex={0}
      aria-label={`${name}${c.tapped ? ', tapped' : ''}${pile > 1 ? `, ${pile} copies` : ''}${props.host ? `, on ${props.host}` : ''}`}
      aria-pressed={selected || undefined}
    >
      <div className={classes.card}>{c.faceDown ? <CardBack /> : <CardImage src={src} alt={name} />}</div>
      {pile > 1 && <span className={classes.pileCount}>×{pile}</span>}
      {(Object.keys(c.counters).length > 0 || c.token || (commanderTax && c.casts > 0)) && (
        <span className={classes.badges}>
          {c.token && <span className={classes.badge}>Token</span>}
          {commanderTax && c.casts > 0 && <span className={classes.badge}>Tax +{c.casts * 2}</span>}
          {Object.entries(c.counters).map(([kind, n]) => (
            <span key={kind} className={classes.badge} data-kind={counterKind(kind, n)}>
              {counterLabel(kind, n)}
            </span>
          ))}
        </span>
      )}
      {preview && <CardPreview src={src} name={name} delay={350} />}
    </div>
  )
}

function PileZone({ zone, over, uids, card, onOpen }: { zone: 'graveyard' | 'exile'; over: Zone | null; uids: string[]; card: (uid: string) => GameCard; onOpen: () => void }) {
  const top = uids[uids.length - 1]
  return (
    <div className={classes.pileZone} data-zone={zone} data-over={over === zone || undefined}>
      <span className={classes.zoneLabel}>
        {zoneNames[zone]} <b>{uids.length}</b>
      </span>
      {top ? (
        <Slot c={card(top)} size="small" selected={false} commanderTax={false} />
      ) : (
        <button type="button" className={classes.emptyPile} onClick={onOpen} aria-label={`${zoneNames[zone]}, empty`}>
          Empty
        </button>
      )}
    </div>
  )
}

function OpeningHand(props: {
  g: Game
  selected: string[]
  slot: (uid: string) => ReactNode
  drawFirstTurn: boolean
  setDrawFirstTurn: (value: boolean) => void
  onMulligan: (free: boolean) => void
  onKeep: () => void
  onBottom: () => void
  children?: ReactNode
}) {
  const { g, selected } = props
  const bottoming = g.phase === 'bottoming'
  const need = toBottom(g)
  const nextSize = handSize - toBottom({ ...g, mulligans: g.mulligans + 1 })
  return (
    <div className={classes.openingScrim}>
      <div className={classes.opening} role="group" aria-label="Opening hand">
        <h2 className={classes.openingTitle}>
          {bottoming ? `Choose ${need} ${need === 1 ? 'card' : 'cards'} to put on the bottom` : g.mulligans ? `Opening hand · mulligan ${g.mulligans}` : 'Opening hand'}
        </h2>
        <div className={classes.openingCards}>{g.zones.hand.map(props.slot)}</div>
        <Group justify="center" gap="md" mt="lg">
          {bottoming ? (
            <Button variant="gradient" size="md" disabled={selected.length !== need} onClick={props.onBottom}>
              Put {need === 1 ? 'it' : 'them'} on the bottom
            </Button>
          ) : (
            <>
              <Checkbox
                label="Draw on turn 1"
                checked={props.drawFirstTurn}
                onChange={(e) => props.setDrawFirstTurn(e.currentTarget.checked)}
              />
              <Button variant="default" size="md" onClick={() => props.onMulligan(true)}>
                Free mulligan
              </Button>
              <Button variant="default" size="md" onClick={() => props.onMulligan(false)}>
                Mulligan (to {nextSize})
              </Button>
              <Button variant="gradient" size="md" onClick={props.onKeep}>
                Keep
              </Button>
            </>
          )}
        </Group>
      </div>
      {props.children}
    </div>
  )
}

const moves: { to: Zone; label: string; bottom?: boolean }[] = [
  { to: 'battlefield', label: 'Battlefield' },
  { to: 'hand', label: 'Hand' },
  { to: 'library', label: 'Top of library' },
  { to: 'library', label: 'Bottom of library', bottom: true },
  { to: 'graveyard', label: 'Graveyard' },
  { to: 'exile', label: 'Exile' },
  { to: 'command', label: 'Command zone' },
]

function CardMenu(props: { at: { uid: string; x: number; y: number }; g: Game; dispatch: (a: HistoryAction) => void; onAttach: () => void; onClose: () => void }) {
  const { at, g, dispatch, onClose } = props
  const c = g.cards[at.uid]
  const zone = zoneOf(g, at.uid)
  const onField = zone === 'battlefield'
  const playable = zone === 'hand' || zone === 'command'
  const counterKinds = ['+1/+1', ...(shownType(c).includes('Planeswalker') ? ['loyalty'] : []), 'counter']
  return (
    <Menu opened onChange={(o) => !o && onClose()} position="bottom-start" withinPortal zIndex={350}>
      <Menu.Target>
        <div style={{ position: 'fixed', left: at.x, top: at.y, width: 1, height: 1 }} />
      </Menu.Target>
      <Menu.Dropdown aria-label={c.card.name}>
        <Menu.Label>{c.faceDown ? 'Face-down card' : c.card.name}</Menu.Label>
        {playable && (
          <Menu.Item onClick={() => dispatch({ type: 'play', uid: at.uid })}>{zone === 'command' ? 'Cast' : shownType(c).includes('Land') ? 'Play' : 'Cast'}</Menu.Item>
        )}
        {playable && c.card.backImage && <Menu.Item onClick={() => dispatch({ type: 'play', uid: at.uid, backFace: true })}>Play the back face</Menu.Item>}
        {onField && <Menu.Item onClick={() => dispatch({ type: 'tap', uid: at.uid })}>{c.tapped ? 'Untap' : 'Tap'}</Menu.Item>}
        {(onField || playable) && g.zones.battlefield.some((u) => u !== at.uid) && (
          <Menu.Item leftSection={<Icon name="link" size={16} />} onClick={props.onAttach}>
            {c.attachedTo ? 'Move onto another permanent' : 'Attach to a permanent'}
          </Menu.Item>
        )}
        {onField && c.attachedTo && (
          <Menu.Item leftSection={<Icon name="link_off" size={16} />} onClick={() => dispatch({ type: 'attach', uid: at.uid })}>
            Detach
          </Menu.Item>
        )}
        {onField && c.card.backImage && (
          <Menu.Item leftSection={<Icon name="flip" size={16} />} rightSection={<Kbd size="xs">F</Kbd>} onClick={() => dispatch({ type: 'flip', uid: at.uid })}>
            Flip
          </Menu.Item>
        )}
        {onField && (
          <Menu.Item leftSection={<Icon name="visibility_off" size={16} />} onClick={() => dispatch({ type: 'faceDown', uid: at.uid })}>
            {c.faceDown ? 'Turn face up' : 'Turn face down'}
          </Menu.Item>
        )}
        {onField && (
          <Menu.Item leftSection={<Icon name="content_copy" size={16} />} onClick={() => dispatch({ type: 'copy', uid: at.uid })}>
            Make a token copy
          </Menu.Item>
        )}
        {onField && (
          <>
            <Menu.Divider />
            <Menu.Label>Counters</Menu.Label>
            {counterKinds.map((kind) => (
              <Group key={kind} justify="space-between" wrap="nowrap" px="sm" py={4} gap="md">
                <Text size="sm">{kind === 'counter' ? 'Other' : kind === 'loyalty' ? 'Loyalty' : counterKind(kind, c.counters[kind] ?? 0).replaceAll('-', '−')}</Text>
                <Group gap={4} wrap="nowrap">
                  <ActionIcon size="sm" variant="default" aria-label={kind === '+1/+1' && (c.counters[kind] ?? 0) <= 0 ? 'Add a -1/-1 counter' : `Remove a ${kind} counter`} onClick={() => dispatch({ type: 'counter', uid: at.uid, kind, delta: -1 })}>
                    <Icon name="remove" size={14} />
                  </ActionIcon>
                  <Text size="sm" w={20} ta="center">
                    {Math.abs(c.counters[kind] ?? 0)}
                  </Text>
                  <ActionIcon size="sm" variant="default" aria-label={kind === '+1/+1' && (c.counters[kind] ?? 0) < 0 ? 'Remove a -1/-1 counter' : `Add a ${kind} counter`} onClick={() => dispatch({ type: 'counter', uid: at.uid, kind, delta: 1 })}>
                    <Icon name="add" size={14} />
                  </ActionIcon>
                </Group>
              </Group>
            ))}
          </>
        )}
        <Menu.Divider />
        <Menu.Label>{c.token ? 'Move (a token leaving play is gone)' : 'Move to'}</Menu.Label>
        {moves
          .filter((m) => !(m.to === zone && m.to !== 'library'))
          .filter((m) => m.to !== 'command' || c.commander || shownType(c).startsWith('Emblem'))
          .map((m) => (
            <Menu.Item key={m.label} onClick={() => dispatch(m.to === 'battlefield' && playable ? { type: 'play', uid: at.uid } : { type: 'move', uid: at.uid, to: m.to, bottom: m.bottom })}>
              {m.label}
            </Menu.Item>
          ))}
      </Menu.Dropdown>
    </Menu>
  )
}

function DrawerPanel(props: {
  drawer: Drawer
  g: Game
  tokens: DeckCard[] | 'failed' | null
  mainboard: PlayDeck['mainboard']
  format: string
  onDeal: () => void
  slot: (uid: string) => ReactNode
  onToken: (card: DeckCard, count: number) => void
  onClose: () => void
}) {
  const { drawer, g } = props
  const [filter, setFilter] = useState('')
  let title: string
  let uids: string[] = []
  let note: string | null = null
  if (drawer.kind === 'top') {
    title = `Top of the library`
    // The cards looked at, while they're still on top (one sent to the bottom drops out of view), in the library's
    // current order: one put back on top shows first.
    uids = g.zones.library.slice(0, drawer.uids.length).filter((u) => drawer.uids.includes(u))
    note = 'In order, top first. Right-click or click a card to send it to the bottom, the graveyard or your hand.'
  } else if (drawer.kind === 'search') {
    title = 'Search the library'
    uids = [...g.zones.library].sort((a, b) => g.cards[a].card.name.localeCompare(g.cards[b].card.name))
    note = 'Closing shuffles the library.'
  } else if (drawer.kind === 'tokens') {
    title = 'Tokens'
  } else if (drawer.kind === 'stats') {
    title = 'How it runs'
  } else if (drawer.kind === 'sample') {
    title = 'Sample hand'
    note = 'A fresh 7 from the whole mainboard. Your game is untouched.'
  } else {
    title = zoneNames[drawer.kind]
    uids = [...g.zones[drawer.kind]].reverse() // newest first
    if (drawer.kind === 'sideboard') note = 'For wishes and companions: move a card to your hand.'
  }
  let shown = filter ? uids.filter((u) => g.cards[u].card.name.toLowerCase().includes(filter.toLowerCase())) : uids
  // A search shows each card once, with how many copies are left.
  const copies = new Map<string, number>()
  if (drawer.kind === 'search') {
    const first = new Map<string, string>()
    for (const u of shown) {
      const name = g.cards[u].card.name
      copies.set(name, (copies.get(name) ?? 0) + 1)
      if (!first.has(name)) first.set(name, u)
    }
    shown = [...first.values()]
  }
  return (
    <aside className={classes.drawer} data-drawer aria-label={title}>
      <header className={classes.drawerHead}>
        <Text fw={700}>
          {title}
          {(drawer.kind === 'graveyard' || drawer.kind === 'exile' || drawer.kind === 'sideboard' || drawer.kind === 'search' || drawer.kind === 'top') && (
            <span className={classes.drawerCount}> {uids.length}</span>
          )}
        </Text>
        <ActionIcon variant="subtle" color="gray" aria-label={`Close ${title.toLowerCase()}`} onClick={props.onClose}>
          <Icon name="close" size={18} />
        </ActionIcon>
      </header>
      {note && (
        <Text size="xs" c="dimmed" px="md" pb="xs">
          {note}
        </Text>
      )}
      {drawer.kind === 'search' && (
        <TextInput mx="md" mb="sm" size="xs" placeholder="Card name" aria-label="Filter by name" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} autoFocus />
      )}
      {drawer.kind === 'tokens' ? (
        <TokenTray tokens={props.tokens} onToken={props.onToken} />
      ) : drawer.kind === 'stats' ? (
        <OpeningOdds mainboard={props.mainboard} format={props.format} stacked />
      ) : drawer.kind === 'sample' ? (
        <>
          <div className={classes.drawerCards} data-testid="sample-hand">
            {drawer.cards.map((c, i) => (
              <div key={i} className={classes.sampleCard}>
                <CardImage src={c.image} alt={c.name} />
              </div>
            ))}
          </div>
          <Group px="md" pb="md">
            <Button variant="default" size="xs" leftSection={<Icon name="refresh" size={16} />} onClick={props.onDeal}>
              Deal another (H)
            </Button>
          </Group>
        </>
      ) : (
        <div className={classes.drawerCards}>
          {shown.length ? (
            shown.map((u) => {
              const n = copies.get(g.cards[u].card.name) ?? 1
              return n > 1 ? (
                <div key={u} className={classes.copies}>
                  {props.slot(u)}
                  <span className={classes.copiesCount}>×{n}</span>
                </div>
              ) : (
                props.slot(u)
              )
            })
          ) : (
            <Text size="sm" c="dimmed">
              Nothing here.
            </Text>
          )}
        </div>
      )}
    </aside>
  )
}

// The deck's own tokens, and a search for any other.
function TokenTray({ tokens, onToken }: { tokens: DeckCard[] | 'failed' | null; onToken: (card: DeckCard, count: number) => void }) {
  const [q, setQ] = useState('')
  const name = q.trim()
  // Results with the name they're for, so a token from an earlier search can't be picked while the next one loads.
  const [found, setFound] = useState<{ name: string; cards: CardSummary[] }>({ name: '', cards: [] })
  useEffect(() => {
    if (name.length < 2) return
    let current = true
    const wait = setTimeout(() => {
      getJson(`/api/cards?q=${encodeURIComponent(name)}&extras=true&type=token`)
        .then((r) => current && setFound({ name, cards: r.cards }))
        .catch(() => current && setFound({ name, cards: [] }))
    }, 250)
    return () => {
      current = false
      clearTimeout(wait)
    }
  }, [name])

  const [many, setMany] = useState(1)
  const pickFound = async (id: string) => {
    try {
      onToken(toDeckCard(await getJson(`/api/cards/${id}`)), many)
    } catch {
      // The card didn't load; nothing is made.
    }
  }

  return (
    <div className={classes.tokenTray}>
      <Group justify="space-between" px="md" pb="xs" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Click a token to make {many === 1 ? 'one' : many}.
        </Text>
        <Group gap={4} wrap="nowrap">
          <ActionIcon size="sm" variant="default" aria-label="Fewer tokens" onClick={() => setMany((n) => Math.max(1, n - 1))}>
            <Icon name="remove" size={14} />
          </ActionIcon>
          <Text size="sm" w={20} ta="center" data-testid="token-count">
            {many}
          </Text>
          <ActionIcon size="sm" variant="default" aria-label="More tokens" onClick={() => setMany((n) => Math.min(20, n + 1))}>
            <Icon name="add" size={14} />
          </ActionIcon>
        </Group>
      </Group>
      <div className={classes.drawerCards}>
        {tokens === null && <Text size="sm" c="dimmed">Loading…</Text>}
        {tokens === 'failed' && <Text size="sm" c="dimmed">The deck's tokens didn't load. Search for one below.</Text>}
        {tokens?.length === 0 && <Text size="sm" c="dimmed">This deck's cards don't make tokens. Search for one below.</Text>}
        {Array.isArray(tokens) && tokens.map((t) => (
          <button key={t.id} type="button" className={classes.tokenButton} aria-label={`Make a ${t.name} token`} onClick={() => onToken(t, many)}>
            <CardImage src={t.image} alt={t.name} />
          </button>
        ))}
      </div>
      <TextInput mx="md" my="sm" size="xs" placeholder="Search all tokens" aria-label="Search all tokens" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <div className={classes.drawerCards}>
        {(found.name === name ? found.cards : []).map((t) => (
          <button key={t.id} type="button" className={classes.tokenButton} aria-label={`Make a ${t.name} token`} onClick={() => pickFound(t.id)}>
            <CardImage src={t.image} alt={t.name} />
          </button>
        ))}
      </div>
    </div>
  )
}
