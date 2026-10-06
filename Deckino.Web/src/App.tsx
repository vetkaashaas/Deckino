import { useEffect, useState } from 'react'

function useApiStatus() {
  const [status, setStatus] = useState('Checking…')
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((body: { status: string }) => setStatus(body.status))
      .catch(() => setStatus('Unreachable'))
  }, [])
  return status
}

export default function App() {
  const apiStatus = useApiStatus()

  return (
    <div className="shell">
      <header className="header">
        <a href="/" className="brand" aria-label="Deckino home">
          <img src="/logo.svg" alt="Deckino" height={32} />
        </a>
        <nav aria-label="Main">
          <a href="/">Home</a>
        </nav>
      </header>

      <main className="main">
        <h1>Scan, collect, build and share your Magic cards.</h1>
        <p>Decks, binders and your wishlist, all in one place. Coming soon.</p>
      </main>

      <footer className="footer">
        <p>
          Deckino is unofficial Fan Content permitted under the{' '}
          <a href="https://company.wizards.com/en/legal/fancontentpolicy">Fan Content Policy</a>. Not
          approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the
          Coast. ©Wizards of the Coast LLC.
        </p>
        <p>
          Card data and images courtesy of <a href="https://scryfall.com">Scryfall</a>.{' '}
          <span data-testid="api-status">API: {apiStatus}</span>
        </p>
      </footer>
    </div>
  )
}
