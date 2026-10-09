import { Alert, Badge, Modal, Skeleton, Text, TextInput, UnstyledButton } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { getJson } from '../api'
import { CardImage } from '../components/CardImage'
import { formatPrice, type Currency } from '../components/currency'
import { languageLabel } from '../binders/binder'
import type { Printing } from './api'
import classes from './PrintingPicker.module.css'

// Every printing of a card, as its picture: the way to choose which version of a card you play. The set filter
// matches a set's name or code; the current printing is marked. Printings load when the picker opens.
export function PrintingPicker({
  opened,
  onClose,
  scryfallId,
  cardName,
  currency,
  onPick,
}: {
  opened: boolean
  onClose: () => void
  scryfallId: string
  cardName: string
  currency: Currency
  onPick: (scryfallId: string) => void
}) {
  // undefined while loading, null when they didn't load.
  const [printings, setPrintings] = useState<Printing[] | null>()
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!opened) return
    let current = true
    getJson<Printing[]>(`/api/cards/${scryfallId}/printings`)
      .then((p) => current && setPrintings(p))
      .catch(() => current && setPrintings(null))
    return () => {
      current = false
    }
  }, [opened, scryfallId])

  const query = filter.trim().toLowerCase()
  const shown = printings?.filter((p) => !query || p.setName.toLowerCase().includes(query) || p.setCode === query)

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Choose a printing of ${cardName}`}
      size="xl"
      centered
      classNames={{ body: classes.body }}
    >
      <TextInput
        aria-label="Filter printings by set"
        placeholder={printings ? `Filter ${printings.length} printings by set name or code` : 'Filter by set'}
        leftSection={<IconSearch size={16} />}
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        data-autofocus
        mb="md"
      />
      {printings === null && <Alert color="red" role="alert">The printings didn't load. Close this and try again.</Alert>}
      {printings === undefined && (
        <div className={classes.grid} aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className={classes.skeleton} />
          ))}
        </div>
      )}
      {shown?.length === 0 && <Text c="dimmed">No printing in a set like that.</Text>}
      {shown && shown.length > 0 && (
        <ul className={classes.grid} aria-label="Printings">
          {shown.map((p) => {
            const current = p.id === scryfallId
            return (
              <li key={p.id}>
                <UnstyledButton
                  className={classes.printing}
                  data-current={current || undefined}
                  aria-label={`${p.setName} (${p.setCode.toUpperCase()}) #${p.collectorNumber}`}
                  aria-current={current || undefined}
                  onClick={() => {
                    if (!current) onPick(p.id)
                    onClose()
                  }}
                >
                  <CardImage src={p.image} alt={`${p.setName} #${p.collectorNumber}`} lazy />
                  {current && (
                    <Badge size="sm" variant="gradient" className={classes.badge}>
                      Current
                    </Badge>
                  )}
                  <span className={classes.set}>{p.setName}</span>
                  <span className={classes.meta}>
                    {p.setCode.toUpperCase()} #{p.collectorNumber} · {p.releasedAt.slice(0, 4)}
                    {p.lang !== 'en' && ` · ${languageLabel(p.lang)}`}
                  </span>
                  <span className={classes.price}>{formatPrice(currency === 'usd' ? p.usd : p.eur, currency)}</span>
                </UnstyledButton>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
