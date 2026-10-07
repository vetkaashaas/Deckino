import { Select } from '@mantine/core'
import { useState } from 'react'
import { getJson } from '../api'
import { printingLabel, type CardDetail, type Printing } from './api'

// An entry's printing. The card's printings load when the list first opens.
export function PrintingSelect({
  entry,
  className,
  onPick,
}: {
  entry: { scryfallId: string; card: { name: string; setName: string; setCode: string; collectorNumber: string } }
  className?: string
  onPick: (scryfallId: string) => void
}) {
  const [printings, setPrintings] = useState<Printing[]>()
  const data = printings
    ? printings.map((p) => ({ value: p.id, label: printingLabel(p) + (p.lang !== 'en' ? `, ${p.lang.toUpperCase()}` : '') }))
    : [{ value: entry.scryfallId, label: printingLabel(entry.card) }]

  return (
    <Select
      aria-label={`Printing of ${entry.card.name}`}
      size="xs"
      className={className}
      data={data}
      value={entry.scryfallId}
      allowDeselect={false}
      searchable
      nothingFoundMessage={printings ? 'No printing matches' : 'Loading printings…'}
      onDropdownOpen={() => {
        // A failed load leaves the list unloaded, so opening it again retries.
        if (!printings) getJson<CardDetail>(`/api/cards/${entry.scryfallId}`).then((d) => setPrintings(d.printings), () => {})
      }}
      onChange={(id) => id && id !== entry.scryfallId && onPick(id)}
      comboboxProps={{ width: 340, position: 'bottom-start' }}
    />
  )
}
