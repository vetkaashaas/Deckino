import { Alert, Button, Container, Group, Select, Skeleton, Text, TextInput, Title } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { getJson } from '../api'
import { ArtHeader } from '../components/ArtHeader'
import { EmptyState } from '../components/EmptyState'
import { formats, type PublicDeckSearchResult } from './deck'
import { tileGrid } from '../components/Tile'
import { useAuth } from '../account/auth'
import { DeckTabs } from './DeckTabs'
import { DeckTile } from './DeckTile'

// Public decks by name and format, newest updated first. The search lives in the address, so it can be shared.
export default function DeckSearch() {
  const { account } = useAuth()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const format = params.get('format') ?? ''
  const [text, setText] = useState(q)
  const [results, setResults] = useState<{ key: string; decks: PublicDeckSearchResult['decks']; hasMore: boolean; page: number } | null>()
  const [loadingMore, setLoadingMore] = useState(false)
  const key = `${q}|${format}`

  // Typing updates the address a moment after the last key. `pushed` is the query this page last put there,
  // so an address changed from outside (Back, Forward, a link) is copied into the box instead of overwritten.
  const pushed = useRef(q)
  useEffect(() => {
    if (q !== pushed.current) {
      pushed.current = q
      setText(q)
    }
  }, [q])
  useEffect(() => {
    const wait = setTimeout(() => {
      if (text.trim() === q) return
      pushed.current = text.trim()
      setParams((p) => {
        const next = new URLSearchParams(p)
        if (text.trim()) next.set('q', text.trim())
        else next.delete('q')
        return next
      }, { replace: true })
    }, 250)
    return () => clearTimeout(wait)
  }, [text, q, setParams])

  useEffect(() => {
    let current = true
    getJson<PublicDeckSearchResult>(`/api/public/decks?q=${encodeURIComponent(q)}&format=${encodeURIComponent(format)}`)
      .then((r) => current && setResults({ key, decks: r.decks, hasMore: r.hasMore, page: 1 }))
      .catch(() => current && setResults(null))
    return () => {
      current = false
    }
  }, [q, format, key])

  async function loadMore() {
    if (!results) return
    setLoadingMore(true)
    try {
      const page = results.page + 1
      const r = await getJson<PublicDeckSearchResult>(
        `/api/public/decks?q=${encodeURIComponent(q)}&format=${encodeURIComponent(format)}&page=${page}`,
      )
      setResults((prev) => (prev && prev.key === key ? { key, decks: [...prev.decks, ...r.decks], hasMore: r.hasMore, page } : prev))
    } catch {
      setResults(null)
    } finally {
      setLoadingMore(false)
    }
  }

  const shown = results && results.key === key ? results : undefined

  return (
    <>
      <ArtHeader>
        <Title order={1}>Browse decks</Title>
        <Text c="dimmed" mt="xs">
          Decks players have made public.
        </Text>
        {account && <DeckTabs />}
      </ArtHeader>

      <Container size="lg">
        <Group gap="md" mb="lg" align="flex-end">
          <TextInput
            label="Deck name"
            placeholder="Search public decks"
            leftSection={<IconSearch size={18} stroke={1.75} />}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            style={{ flex: '1 1 280px', maxWidth: 480 }}
          />
          <Select
            label="Format"
            placeholder="Any format"
            data={formats}
            value={format || null}
            clearable
            onChange={(f) =>
              setParams((p) => {
                const next = new URLSearchParams(p)
                if (f) next.set('format', f)
                else next.delete('format')
                return next
              })
            }
            w={180}
          />
        </Group>

        {results === null && (
          <Alert color="red" title="The search didn't load" role="alert">
            Deckino didn't respond. Reload the page to try again.
          </Alert>
        )}
        {results !== null && !shown && (
          <div className={tileGrid} aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} height={180} radius="lg" />
            ))}
          </div>
        )}
        {shown?.decks.length === 0 && (
          <EmptyState title="No public decks found">
            {q || format ? 'Try another name or format.' : 'Nobody has made a deck public yet.'}
          </EmptyState>
        )}
        {shown && shown.decks.length > 0 && (
          <>
            <ul className={tileGrid} aria-label="Public decks">
              {shown.decks.map(({ deck, owner }) => (
                <li key={deck.id}>
                  <DeckTile deck={deck} to={`/deck/${deck.id}`} meta={`by ${owner} · Updated ${new Date(deck.updatedAt).toLocaleDateString()}`} />
                </li>
              ))}
            </ul>
            {shown.hasMore && (
              <Group justify="center" my="xl">
                <Button variant="default" loading={loadingMore} onClick={loadMore}>
                  Show more decks
                </Button>
              </Group>
            )}
          </>
        )}
      </Container>
    </>
  )
}
