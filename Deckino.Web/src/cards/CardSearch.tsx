import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Container,
  Group,
  Select,
  Text,
  TextInput,
  Title,
  type ComboboxItem,
  type OptionsFilter,
} from '@mantine/core'
import { IconAdjustmentsHorizontal, IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { EmptyState } from '../components/EmptyState'
import { symbolUrl } from '../components/ManaSymbols'
import { getJson } from '../api'
import { type CardSearchResult, type CardSet } from './api'
import { QuickAdd } from './QuickAdd'
import classes from './CardSearch.module.css'

const colorOptions = [
  ['W', 'White'],
  ['U', 'Blue'],
  ['B', 'Black'],
  ['R', 'Red'],
  ['G', 'Green'],
  ['C', 'Colorless'],
] as const

const manaValues = ['0', '1', '2', '3', '4', '5', '6', '7']
const rarities = [
  ['common', 'Common'],
  ['uncommon', 'Uncommon'],
  ['rare', 'Rare'],
  ['mythic', 'Mythic'],
] as const

// Searching by name sorts best match first; browsing without a name starts with the most valuable cards, which are
// the ones people look up (sorted by name, the catalogue opens on oddities like "_____").
const sorts = [
  { value: 'name', label: 'Best match' },
  { value: 'price', label: 'Most valuable' },
  { value: 'mv', label: 'Mana value' },
  { value: 'newest', label: 'Newest' },
]
const defaultSort = (params: URLSearchParams) => (params.get('q') ? 'name' : 'price')

// Typing a set code ("lea") should find that set before every set whose name happens to contain the letters.
const setFilter: OptionsFilter = ({ options, search }) => {
  const query = search.trim().toLowerCase()
  const items = options as ComboboxItem[]
  if (!query) return items
  const exact = items.filter((o) => o.value === query)
  return [...exact, ...items.filter((o) => o.value !== query && o.label.toLowerCase().includes(query))]
}

// Every filter applies as soon as it changes; the name and type wait for a pause in typing (or Enter).
function SearchForm({ params, sets, onSearch }: { params: URLSearchParams; sets: CardSet[]; onSearch: (next: URLSearchParams) => void }) {
  const [name, setName] = useState(params.get('q') ?? '')
  const [type, setType] = useState(params.get('type') ?? '')
  const setOptions = useMemo(() => sets.map((s) => ({ value: s.code, label: `${s.name} (${s.code.toUpperCase()})` })), [sets])
  const colors = (params.get('colors') ?? '').split('').filter(Boolean)
  const [showFilters, setShowFilters] = useState(false)
  const active = ['colors', 'mv', 'rarity', 'type', 'set', 'sort', 'extras'].filter((k) => params.get(k)).length

  // Another search arrived from outside (back, forward, a link): show it.
  const q = params.get('q') ?? ''
  const t = params.get('type') ?? ''
  const [shown, setShown] = useState({ q, t })
  if (shown.q !== q || shown.t !== t) {
    setShown({ q, t })
    if (name.trim() !== q) setName(q)
    if (type.trim() !== t) setType(t)
  }

  // Built from the address as it is now, not from this render's params: the name's delayed search runs from an
  // older render, and must not undo a filter clicked while it waited. (React Router's functional update doesn't
  // help: it starts from the params of the render that made it.)
  function change(key: string, value: string | null) {
    const next = new URLSearchParams(window.location.search)
    next.delete('page')
    if (value) next.set(key, value)
    else next.delete(key)
    // A new name search sorts by best match again.
    if (key === 'q') next.delete('sort')
    onSearch(next)
  }

  useEffect(() => {
    if (name.trim() === q) return
    const wait = setTimeout(() => change('q', name.trim()), 350)
    return () => clearTimeout(wait)
  }, [name]) // eslint-disable-line react-hooks/exhaustive-deps -- only a change of the typed name searches
  useEffect(() => {
    if (type.trim() === t) return
    const wait = setTimeout(() => change('type', type.trim()), 400)
    return () => clearTimeout(wait)
  }, [type]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form
      role="search"
      className={classes.filters}
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() !== q) change('q', name.trim())
      }}
    >
      <TextInput
        aria-label="Card name"
        placeholder="Search every Magic card"
        leftSection={<IconSearch size={20} stroke={1.75} />}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        size="lg"
        autoFocus={params.size === 0} // a fresh visit; after a search, focus stays where the user left it
        className={classes.name}
      />

      {/* Phones: the filters fold away behind a button, so the results start on the first screen. */}
      <Button
        variant="default"
        hiddenFrom="xs"
        leftSection={<IconAdjustmentsHorizontal size={18} />}
        onClick={() => setShowFilters(!showFilters)}
        aria-expanded={showFilters}
      >
        Filters{active > 0 ? ` (${active})` : ''}
      </Button>

      <div className={classes.more} data-open={showFilters || undefined}>
        <div className={classes.filterRow}>
          <div className={classes.filter}>
            <Text size="xs" fw={600} c="dimmed" id="color-filter">
              Colours
            </Text>
            <Chip.Group
              multiple
              value={colors}
              onChange={(next) => change('colors', colorOptions.map(([c]) => c).filter((c) => next.includes(c)).join(''))}
            >
              <Group gap={4} role="group" aria-labelledby="color-filter">
                {colorOptions.map(([code, label]) => (
                  <Chip key={code} value={code} size="sm" variant="outline" className={classes.iconChip}>
                    <img src={symbolUrl(code)} alt={label} className={classes.colorSymbol} />
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </div>

          <div className={classes.filter}>
            <Text size="xs" fw={600} c="dimmed" id="mv-filter">
              Mana value
            </Text>
            <Chip.Group value={params.get('mv') ?? ''} onChange={(v) => change('mv', v === params.get('mv') ? null : v)}>
              <Group gap={4} role="group" aria-labelledby="mv-filter">
                {manaValues.map((mv) => (
                  <Chip
                    key={mv}
                    value={mv}
                    size="sm"
                    variant="outline"
                    className={classes.iconChip}
                    onClick={() => params.get('mv') === mv && change('mv', null)} // a second click clears it
                  >
                    <span className={classes.mv} aria-label={mv === '7' ? '7 or more' : mv}>
                      {mv === '7' ? '7+' : mv}
                    </span>
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </div>

          <div className={classes.filter}>
            <Text size="xs" fw={600} c="dimmed" id="rarity-filter">
              Rarity
            </Text>
            <Chip.Group value={params.get('rarity') ?? ''} onChange={(v) => change('rarity', v)}>
              <Group gap={4} role="group" aria-labelledby="rarity-filter">
                {rarities.map(([value, label]) => (
                  <Chip
                    key={value}
                    value={value}
                    size="sm"
                    variant="outline"
                    className={classes.iconChip}
                    onClick={() => params.get('rarity') === value && change('rarity', null)}
                  >
                    <span className={classes.rarity} data-rarity={value} aria-label={label}>
                      {label[0]}
                    </span>
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </div>
        </div>

        <div className={classes.filterRow}>
          <TextInput label="Type" placeholder="Creature, Instant, Dragon…" value={type} onChange={(e) => setType(e.currentTarget.value)} className={classes.select} />
          <Select
            label="Set"
            placeholder="Any set"
            data={setOptions}
            value={params.get('set')}
            onChange={(v) => change('set', v)}
            filter={setFilter}
            searchable
            clearable
            selectFirstOptionOnChange
            limit={50}
            nothingFoundMessage="No set matches"
            className={classes.select}
          />
          <Select
            label="Sort by"
            data={sorts}
            value={params.get('sort') ?? defaultSort(params)}
            allowDeselect={false}
            onChange={(v) => change('sort', v === defaultSort(params) ? null : v)}
            className={classes.sort}
          />
          <Checkbox
            label="Include tokens and art cards"
            checked={params.get('extras') === 'true'}
            onChange={(e) => change('extras', e.currentTarget.checked ? 'true' : null)}
            className={classes.extras}
          />
        </div>
      </div>
    </form>
  )
}

// The search lives in the URL (?q=&colors=&type=&set=&mv=&rarity=&sort=&extras=), so results can be linked and
// back works.
export default function CardSearch() {
  const [params, setParams] = useSearchParams()
  const query = params.toString()
  const [currency, setCurrency] = useCurrency()
  // The results answer the search and the currency (it orders "Most valuable"): a change of either is a new search.
  const key = `${query}|${currency}`
  const [sets, setSets] = useState<CardSet[]>([])
  const [result, setResult] = useState<CardSearchResult & { page: number; query: string }>()
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)

  // The API sorts by name unless told otherwise; without a name the browser starts with the most valuable cards.
  // "Most valuable" sorts by the prices shown.
  const request = (p: URLSearchParams) => {
    const next = new URLSearchParams(p)
    if (!next.has('sort')) next.set('sort', defaultSort(p))
    if (currency === 'eur') next.set('currency', 'eur')
    return `/api/cards?${next}`
  }

  useEffect(() => {
    getJson<CardSet[]>('/api/sets')
      .then(setSets)
      .catch(() => setSets([]))
  }, [])

  useEffect(() => {
    let current = true // superseded searches are ignored, not aborted (see CardPage)
    getJson<CardSearchResult>(request(new URLSearchParams(query)))
      .then((r) => {
        if (!current) return
        setFailed(false)
        setLoadMoreFailed(false)
        setResult({ ...r, page: 1, query: key })
      })
      .catch(() => current && setFailed(true))
    return () => {
      current = false
    }
  }, [query, currency]) // eslint-disable-line react-hooks/exhaustive-deps -- request only reads its argument and the currency

  async function loadMore() {
    if (!result) return
    const page = result.page + 1
    const next = new URLSearchParams(params)
    next.set('page', String(page))
    setLoadingMore(true)
    setLoadMoreFailed(false)
    try {
      const more = await getJson<CardSearchResult>(request(next))
      // Only append if the user hasn't searched for something else meanwhile.
      setResult((current) =>
        current?.query === key && current.page === page - 1
          ? { cards: [...current.cards, ...more.cards], hasMore: more.hasMore, page, query: key }
          : current,
      )
    } catch {
      setLoadMoreFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }

  const loading = !failed && result?.query !== key

  return (
    <>
      <ArtHeader>
        <Group justify="space-between" align="flex-end" gap="md">
          <div>
            <Title order={1}>Cards</Title>
            <Text c="dimmed" mt="xs">
              Every paper Magic card, with each printing and its price.
            </Text>
          </div>
          <CurrencyToggle currency={currency} onChange={setCurrency} />
        </Group>
      </ArtHeader>

      <Container size="lg">
        <SearchForm params={params} sets={sets} onSearch={setParams} />

        {failed && (
          <Alert color="red" title="Card search is unavailable" role="alert" mt="lg">
            The catalogue didn't respond. Try again in a moment.
          </Alert>
        )}

        {loading && !result && (
          <ul className={classes.grid} aria-label="Loading results" aria-busy="true">
            {Array.from({ length: 12 }, (_, i) => (
              <li key={i}>
                <CardImage placeholder alt="" />
              </li>
            ))}
          </ul>
        )}

        {!loading && result?.cards.length === 0 && (
          <EmptyState title="No cards found">Check the spelling, or remove a filter to widen the search.</EmptyState>
        )}

        {result && result.cards.length > 0 && (
          <>
            <ul className={classes.grid} aria-label={loading ? 'Loading results' : 'Search results'} aria-busy={loading || undefined} data-stale={loading || undefined}>
              {result.cards.map((card) => (
                <li key={card.id} className={classes.item}>
                  <Link to={`/cards/${card.id}`} className={classes.result}>
                    <CardImage src={card.image} alt={card.name} lazy />
                    <span className={classes.resultName}>{card.name}</span>
                    <span className={classes.resultPrice}>{formatPrice(card[currency], currency)}</span>
                  </Link>
                  <span className={classes.quickAdd}>
                    <QuickAdd cardId={card.id} cardName={card.name} />
                  </span>
                </li>
              ))}
            </ul>
            {loadMoreFailed && (
              <Alert color="red" role="alert" mt="lg">
                More results didn't load. Try again.
              </Alert>
            )}
            {!loading && result.hasMore && (
              <Group justify="center" mt="xl">
                <Button variant="default" onClick={loadMore} loading={loadingMore}>
                  Load more
                </Button>
              </Group>
            )}
          </>
        )}
      </Container>
    </>
  )
}
