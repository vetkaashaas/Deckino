import { Combobox, Group, Text, TextInput, useCombobox } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { getJson } from '../api'
import { ManaSymbols } from '../components/ManaSymbols'
import type { CardSearchResult, CardSummary } from './api'

const noCards: CardSummary[] = [] // one array, so the effect below only runs when the shown results change

// Searches the catalogue as the user types; picking a result (or Enter for the top one) hands over its default printing.
export function CardPicker({
  label,
  placeholder,
  onPick,
}: {
  label: string
  placeholder: string
  onPick: (scryfallId: string) => void
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<{ query: string; cards: CardSummary[] }>({ query: '', cards: [] })

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) return
    let current = true
    const wait = setTimeout(() => {
      getJson<CardSearchResult>(`/api/cards?q=${encodeURIComponent(q)}`)
        .then((r) => current && setResults({ query: q, cards: r.cards.slice(0, 20) }))
        .catch(() => current && setResults({ query: q, cards: [] }))
    }, 200)
    return () => {
      current = false
      clearTimeout(wait)
    }
  }, [search])

  // Only the results for what's typed now, so Enter never adds a card from an earlier search.
  const shown = results.query === search.trim() ? results.cards : noCards
  const combobox = useCombobox()
  // Enter adds the top result: highlight it as soon as the results for the current text arrive.
  useEffect(() => {
    if (shown.length) combobox.selectFirstOption()
  }, [shown]) // eslint-disable-line react-hooks/exhaustive-deps -- not on combobox: a new object every render, and re-selecting would undo arrow-key moves

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(id) => {
        onPick(id)
        setSearch('')
        combobox.closeDropdown()
      }}
    >
      <Combobox.Target withExpandedAttribute>
        <TextInput
          aria-label={label}
          placeholder={placeholder}
          leftSection={<IconSearch size={18} stroke={1.75} />}
          size="md"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value)
            combobox.openDropdown()
          }}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
        />
      </Combobox.Target>
      <Combobox.Dropdown hidden={search.trim().length < 2 || results.query !== search.trim()}>
        <Combobox.Options aria-label={label}>
          {shown.length === 0 && <Combobox.Empty>No cards found</Combobox.Empty>}
          {shown.map((card) => (
            <Combobox.Option key={card.id} value={card.id}>
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <div>
                  <Text size="sm">{card.name}</Text>
                  <Text size="xs" c="dimmed">
                    {card.typeLine}
                  </Text>
                </div>
                <span style={{ whiteSpace: 'nowrap' }}>
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
