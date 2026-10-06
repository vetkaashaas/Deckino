import { useEffect, useState } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router'
import CardPage from './cards/CardPage'
import CardSearch from './cards/CardSearch'

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

function Home() {
  return (
    <>
      <h1>Scan, collect, build and share your Magic cards.</h1>
      <p>
        Decks, binders and your wishlist, all in one place. Coming soon. For now,{' '}
        <Link to="/cards">browse the card catalogue</Link>.
      </p>
    </>
  )
}

export default function App() {
  const apiStatus = useApiStatus()

  return (
    <BrowserRouter>
      <div className="shell">
        <header className="header">
          <Link to="/" className="brand" aria-label="Deckino home">
            <img src="/logo.svg" alt="Deckino" height={32} />
          </Link>
          <nav aria-label="Main">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/cards">Cards</NavLink>
          </nav>
        </header>

        <main className="main">
          <Routes>
            <Route path="/cards" element={<CardSearch />} />
            <Route path="/cards/:id" element={<CardPage />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </main>

        <footer className="footer">
          <p>
            Deckino is unofficial Fan Content permitted under the{' '}
            <a href="https://company.wizards.com/en/legal/fancontentpolicy">Fan Content Policy</a>.
            Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards
            of the Coast. ©Wizards of the Coast LLC.
          </p>
          <p>
            Card data and images courtesy of <a href="https://scryfall.com">Scryfall</a>.{' '}
            <span data-testid="api-status">API: {apiStatus}</span>
          </p>
        </footer>
      </div>
    </BrowserRouter>
  )
}
