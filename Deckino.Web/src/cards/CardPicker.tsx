import { Combobox, Group, Text, TextInput, useCombobox } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { getJson } from '../api'
import { ManaSymbols } from '../components/ManaSymbols'
import type { CardSearchResult, CardSummary } from './api'
import classes from './CardPicker.module.css'

const noCards: CardSummary[] = [] // one array, so the effect below only runs when the shown results change

// "4 lightning bolt" or "4x lightning bolt": a quantity, then the name to search for.
function parse(text: string) {
  const match = /^(\d{1,2})\s*x?\s+(.+)$/i.exec(text.trim())
  return match ? { quantity: Math.max(1, Number(match[1])), name: match[2].trim() } : { quantity: 1, name: text.trim() }
}

// Searches the catalogue as the user types; picking a result (or Enter for the top one) hands over its default
// printing, and the quantity typed in front of the name, if any. commander: only cards that can lead a deck.
export function CardPicker({
  label,
  placeholder,
  onPick,
  commander = false,
  size = 'md',
  rightSection,
  autoFocus,
  quantities = true,
}: {
  label: string
  placeholder: string
  onPick: (scryfallId: string, quantity: number) => void
  commander?: boolean
  size?: 'sm' | 'md' | 'lg'
  rightSection?: ReactNode
  autoFocus?: boolean
  quantities?: boolean // false: a leading number is part of the name, not a count (picking one card for a line)
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<{ query: string; cards: CardSummary[] }>({ query: '', cards: [] })
  const { quantity, name } = quantities ? parse(search) : { quantity: 1, name: search.trim() }
  const query = `${name}|${commander}`

  useEffect(() => {
    const [q] = query.split('|')
    if (q.length < 2) return
    let current = true
    const wait = setTimeout(() => {
      getJson<CardSearchResult>(`/api/cards?q=${encodeURIComponent(q)}${commander ? '&commander=true' : ''}`)
        .then((r) => current && setResults({ query, cards: r.cards.slice(0, 20) }))
        .catch(() => current && setResults({ query, cards: [] }))
    }, 200)
    return () => {
      current = false
      clearTimeout(wait)
    }
  }, [query, commander])

  // Only the results for what's typed now, so Enter never adds a card from an earlier search.
  const shown = results.query === query ? results.cards : noCards
  const combobox = useCombobox()
  // Enter adds the top result: highlight it as soon as the results for the current text arrive.
  useEffect(() => {
    if (shown.length) combobox.selectFirstOption()
  }, [shown]) // eslint-disable-line react-hooks/exhaustive-deps -- not on combobox: a new object every render, and re-selecting would undo arrow-key moves

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(id) => {
        onPick(id, quantity)
        setSearch('')
        combobox.closeDropdown()
      }}
    >
      <Combobox.Target withExpandedAttribute>
        <TextInput
          aria-label={label}
          placeholder={placeholder}
          leftSection={<IconSearch size={18} stroke={1.75} />}
          rightSection={rightSection}
          rightSectionWidth={rightSection ? 'auto' : undefined}
          rightSectionPointerEvents="all"
          size={size}
          value={search}
          autoFocus={autoFocus}
          onChange={(e) => {
            setSearch(e.currentTarget.value)
            combobox.openDropdown()
          }}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
        />
      </Combobox.Target>
      <Combobox.Dropdown hidden={name.length < 2 || results.query !== query} className={classes.dropdown}>
        <Combobox.Options aria-label={label} mah={420} style={{ overflowY: 'auto' }}>
          {shown.length === 0 && <Combobox.Empty>{commander ? 'No commanders found' : 'No cards found'}</Combobox.Empty>}
          {shown.map((card) => (
            <Combobox.Option key={card.id} value={card.id} className={classes.option}>
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Group gap="sm" wrap="nowrap" miw={0}>
                  {card.image ? (
                    <img className={classes.thumb} src={card.smallImage ?? card.image} alt="" loading="lazy" />
                  ) : (
                    <span className={classes.thumb} />
                  )}
                  {quantity > 1 && <span className={classes.quantity}>{quantity}×</span>}
                  <div className={classes.text}>
                    <Text size="sm" fw={500} truncate>
                      {card.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {card.typeLine}
                    </Text>
                  </div>
                </Group>
                <span className={classes.mana}>
                  <ManaSymbols text={card.manaCost} />
                </span>
              </Group>
            </Combobox.Option>
          ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  )
}
