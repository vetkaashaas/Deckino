import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Container,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  type ComboboxItem,
  type OptionsFilter,
} from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArtHeader } from '../components/ArtHeader'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { EmptyState } from '../components/EmptyState'
import { symbolUrl } from '../components/ManaSymbols'
import { getJson, type CardSearchResult, type CardSet } from './api'
import classes from './CardSearch.module.css'

const colorOptions = [
  ['W', 'White'],
  ['U', 'Blue'],
  ['B', 'Black'],
  ['R', 'Red'],
  ['G', 'Green'],
  ['C', 'Colorless'],
] as const

// Typing a set code ("lea") should find that set before every set whose name happens to contain the letters.
const setFilter: OptionsFilter = ({ options, search }) => {
  const query = search.trim().toLowerCase()
  const items = options as ComboboxItem[]
  if (!query) return items
  const exact = items.filter((o) => o.value === query)
  return [...exact, ...items.filter((o) => o.value !== query && o.label.toLowerCase().includes(query))]
}

interface SearchFormProps {
  params: URLSearchParams
  sets: CardSet[]
  onSearch: (next: URLSearchParams) => void
}

// Keyed on the search, so it starts from the URL again after every search and on back/forward.
function SearchForm({ params, sets, onSearch }: SearchFormProps) {
  const [name, setName] = useState(params.get('q') ?? '')
  const [colors, setColors] = useState((params.get('colors') ?? '').split('').filter(Boolean))
  const [type, setType] = useState(params.get('type') ?? '')
  const [set, setSet] = useState(params.get('set'))
  const [extras, setExtras] = useState(params.get('extras') === 'true')
  const setOptions = useMemo(
    () => sets.map((s) => ({ value: s.code, label: `${s.name} (${s.code.toUpperCase()})` })),
    [sets],
  )

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = new URLSearchParams()
    if (name.trim()) next.set('q', name.trim())
    if (type.trim()) next.set('type', type.trim())
    if (set) next.set('set', set)
    if (colors.length) next.set('colors', colorOptions.map(([c]) => c).filter((c) => colors.includes(c)).join(''))
    if (extras) next.set('extras', 'true')
    onSearch(next)
  }

  return (
    <form role="search" onSubmit={search} className={classes.filters}>
      <Group gap="sm" wrap="nowrap" align="flex-end">
        <TextInput
          className={classes.name}
          aria-label="Card name"
          placeholder="Lightning Bolt"
          leftSection={<IconSearch size={18} stroke={1.75} />}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          size="md"
          autoFocus={params.size === 0} // a fresh visit; after a search, focus stays where the user left it
        />
        <Button type="submit" variant="gradient" size="md">
          Search
        </Button>
      </Group>

      <Group gap="lg" align="flex-end" mt="md">
        <Stack gap={6}>
          <Text size="sm" fw={500} id="color-filter">
            Colors
          </Text>
          <Chip.Group multiple value={colors} onChange={setColors}>
            <Group gap={6} role="group" aria-labelledby="color-filter">
              {colorOptions.map(([code, label]) => (
                <Chip key={code} value={code} size="sm" variant="outline" className={classes.colorChip}>
                  <img src={symbolUrl(code)} alt={label} className={classes.colorSymbol} />
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </Stack>
        <TextInput
          label="Type"
          placeholder="Instant"
          value={type}
          onChange={(e) => setType(e.currentTarget.value)}
          w={180}
        />
        <Select
          label="Set"
          placeholder="Any set"
          data={setOptions}
          value={set}
          onChange={setSet}
          filter={setFilter}
          searchable
          clearable
          selectFirstOptionOnChange
          limit={50}
          nothingFoundMessage="No set matches"
          w={260}
        />
        <Checkbox
          label="Include tokens and art cards"
          checked={extras}
          onChange={(e) => setExtras(e.currentTarget.checked)}
          mb={8}
        />
      </Group>
    </form>
  )
}

// The search lives in the URL (?q=&colors=&type=&set=&extras=), so results can be linked and go back works.
export default function CardSearch() {
  const [params, setParams] = useSearchParams()
  const query = params.toString()
  const [currency, setCurrency] = useCurrency()
  const [sets, setSets] = useState<CardSet[]>([])
  const [result, setResult] = useState<CardSearchResult & { page: number; query: string }>()
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)

  useEffect(() => {
    getJson<CardSet[]>('/api/sets')
      .then(setSets)
      .catch(() => setSets([]))
  }, [])

  useEffect(() => {
    let current = true // superseded searches are ignored, not aborted (see CardPage)
    getJson<CardSearchResult>(`/api/cards?${query}`)
      .then((r) => {
        if (!current) return
        setFailed(false)
        setLoadMoreFailed(false)
        setResult({ ...r, page: 1, query })
      })
      .catch(() => current && setFailed(true))
    return () => {
      current = false
    }
  }, [query])

  async function loadMore() {
    if (!result) return
    const page = result.page + 1
    const next = new URLSearchParams(params)
    next.set('page', String(page))
    setLoadingMore(true)
    setLoadMoreFailed(false)
    try {
      const more = await getJson<CardSearchResult>(`/api/cards?${next}`)
      // Only append if the user hasn't searched for something else meanwhile.
      setResult((current) =>
        current?.query === query && current.page === page - 1
          ? { cards: [...current.cards, ...more.cards], hasMore: more.hasMore, page, query }
          : current,
      )
    } catch {
      setLoadMoreFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }

  const loading = !failed && result?.query !== query

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
        <SearchForm
          key={query}
          params={params}
          sets={sets}
          onSearch={setParams}
        />

        {failed && (
          <Alert color="red" title="Card search is unavailable" role="alert" mt="lg">
            The catalogue didn't respond. Try again in a moment.
          </Alert>
        )}

        {loading && (
          <ul className={classes.grid} aria-label="Loading results" aria-busy="true">
            {Array.from({ length: 12 }, (_, i) => (
              <li key={i}>
                <CardImage placeholder alt="" />
              </li>
            ))}
          </ul>
        )}

        {!loading && result?.cards.length === 0 && (
          <EmptyState title="No cards found">
            Check the spelling, or remove a filter to widen the search.
          </EmptyState>
        )}

        {!loading && result && result.cards.length > 0 && (
          <>
            <ul className={classes.grid} aria-label="Search results">
              {result.cards.map((card) => (
                <li key={card.id}>
                  <Link to={`/cards/${card.id}`} className={classes.result}>
                    <CardImage src={card.image} alt={card.name} lazy />
                    <span className={classes.resultName}>{card.name}</span>
                    <span className={classes.resultPrice}>{formatPrice(card[currency], currency)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {loadMoreFailed && (
              <Alert color="red" role="alert" mt="lg">
                More results didn't load. Try again.
              </Alert>
            )}
            {result.hasMore && (
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
