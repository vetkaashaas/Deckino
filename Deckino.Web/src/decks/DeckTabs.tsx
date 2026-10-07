import { SegmentedControl } from '@mantine/core'
import { useLocation, useNavigate } from 'react-router'

// Decks has two lists: the user's own and everyone's public ones.
export function DeckTabs() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (
    <SegmentedControl
      aria-label="Decks"
      mt="md"
      value={pathname.startsWith('/browse') ? '/browse' : '/decks'}
      onChange={(to) => navigate(to)}
      data={[
        { label: 'Your decks', value: '/decks' },
        { label: 'Browse public decks', value: '/browse' },
      ]}
    />
  )
}
