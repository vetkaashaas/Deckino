import { PageTabs } from '../components/PageTabs'

// Decks has two lists, as in the app: the user's own and everyone's public ones.
export function DeckTabs() {
  return (
    <PageTabs
      label="Decks"
      tabs={[
        { to: '/decks', label: 'Yours' },
        { to: '/browse', label: 'Public' },
      ]}
    />
  )
}
