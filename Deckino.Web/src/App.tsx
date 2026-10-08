import { Anchor, AppShell, Burger, Button, Container, Group, NavLink as MantineNavLink, Stack, Text, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconUserCircle } from '@tabler/icons-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { createBrowserRouter, Link, NavLink, Route, RouterProvider, Routes, useLocation } from 'react-router'
import AccountPage from './account/AccountPage'
import { useAuth } from './account/auth'
import { AuthProvider } from './account/AuthProvider'
import LoginPage from './account/LoginPage'
import { ForgotPasswordPage, ResetPasswordPage } from './account/PasswordPages'
import RegisterPage from './account/RegisterPage'
import VerifyEmailPage from './account/VerifyEmailPage'
import classes from './App.module.css'
import CardPage from './cards/CardPage'
import CardSearch from './cards/CardSearch'
import BinderPage from './binders/BinderPage'
import MyBinders from './binders/MyBinders'
import PublicBinderPage from './binders/PublicBinderPage'
import Dashboard from './Dashboard'
import DeckPage from './decks/DeckPage'
import ImportPage from './import/ImportPage'
import DeckSearch from './decks/DeckSearch'
import PublicDeckPage from './decks/PublicDeckPage'
import WishlistPage from './wishlist/WishlistPage'
import Landing from './landing/Landing'
import { FanContentNotice } from './components/FanContentNotice'
import MyDecks from './decks/MyDecks'

const Styleguide = lazy(() => import('./styleguide/Styleguide'))

// `also`: other addresses that belong to the same section (Decks covers your decks, browsing and public decks).
const publicNavigation = [
  { to: '/browse', label: 'Browse decks', also: ['/deck/'] },
  { to: '/cards', label: 'Cards', also: [] },
]
const accountNavigation = [
  { to: '/decks', label: 'Decks', also: ['/browse', '/deck/'] },
  { to: '/binders', label: 'Binders', also: ['/binder/'] },
  { to: '/wishlist', label: 'Wishlist', also: [] },
  { to: '/cards', label: 'Cards', also: [] },
]
// Full-page account pages, outside the header and footer.
const accountPages = ['/register', '/verify-email', '/login', '/forgot-password', '/reset-password']

const inSection = (pathname: string, item: { to: string; also: string[] }) =>
  pathname.startsWith(item.to) || item.also.some((path) => pathname.startsWith(path))

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

function NotFound() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="md" maw={560}>
        <Title order={1}>Page not found</Title>
        <Text c="dimmed">
          Nothing lives at this address. Try the{' '}
          <Anchor component={Link} to="/cards">
            card catalogue
          </Anchor>{' '}
          or{' '}
          <Anchor component={Link} to="/">
            the home page
          </Anchor>
          .
        </Text>
      </Stack>
    </Container>
  )
}

// Log in / sign up, or the signed-in username linking to the account page.
function AccountLinks() {
  const { account } = useAuth()
  if (account === undefined) return null
  if (account) {
    return (
      <Button component={Link} to="/account" variant="subtle" color="gray" leftSection={<IconUserCircle size={18} />}>
        {account.username}
      </Button>
    )
  }
  return (
    <Group gap="xs" wrap="nowrap">
      <Button component={Link} to="/login" variant="subtle" color="gray">
        Log in
      </Button>
      <Button component={Link} to="/register" variant="default">
        Create account
      </Button>
    </Group>
  )
}

// The site footer: the Fan Content notice, Scryfall credit and API status.
function Footer() {
  const apiStatus = useApiStatus()
  return (
    <footer className={classes.footer}>
      <Container size="lg">
        <FanContentNotice />
        <Text size="xs" c="dimmed" mt={4}>
          Card data and images courtesy of{' '}
          <Anchor href="https://scryfall.com" size="xs">
            Scryfall
          </Anchor>
          . <span data-testid="api-status">API: {apiStatus}</span> ·{' '}
          <Anchor component={Link} to="/about" size="xs">
            About Deckino
          </Anchor>
        </Text>
      </Container>
    </footer>
  )
}

function Shell() {
  const { account } = useAuth()
  const [menuOpen, menu] = useDisclosure()
  const { pathname } = useLocation()
  const navigation = account ? accountNavigation : publicNavigation
  // Matched like the routes are: a trailing slash or other casing is still the same page.
  const path = pathname.replace(/\/+$/, '').toLowerCase() || '/'
  // Logged out (or not yet known) on the home page, or /about: the header sits translucent over the hero.
  const landing = path === '/about' || (path === '/' && !account)

  const closeMenu = menu.close
  useEffect(() => closeMenu(), [pathname, closeMenu])

  const pages = (
    <Suspense>
      <Routes>
        <Route path="/cards" element={<CardSearch />} />
        <Route path="/cards/:id" element={<CardPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/decks" element={<MyDecks />} />
        <Route path="/decks/import" element={<ImportPage key="deck" kind="deck" />} />
        <Route path="/decks/:id" element={<DeckPage />} />
        <Route path="/deck/:id" element={<PublicDeckPage />} />
        <Route path="/browse" element={<DeckSearch />} />
        <Route path="/binders" element={<MyBinders />} />
        <Route path="/binders/import" element={<ImportPage key="binder" kind="binder" />} />
        <Route path="/binders/:id" element={<BinderPage />} />
        <Route path="/binder/:id" element={<PublicBinderPage />} />
        <Route path="/wishlist" element={<WishlistPage />} />
        <Route path="/about" element={<Landing />} />
        <Route path="/styleguide" element={<Styleguide />} />
        <Route path="/" element={account ? <Dashboard account={account} /> : account === null ? <Landing /> : null} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
  if (accountPages.includes(path)) return pages

  return (
    <AppShell
      header={{ height: 72 }}
      navbar={{ width: 280, breakpoint: 'sm', collapsed: { desktop: true, mobile: !menuOpen } }}
      padding={0}
    >
      <AppShell.Header className={classes.header} data-over-hero={landing || undefined}>
        <Container size="lg" h="100%">
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Group gap="xl" wrap="nowrap">
              <Link to="/" className={classes.brand} aria-label="Deckino home">
                <img src="/logo.svg" alt="Deckino" height={44} />
              </Link>
              <nav aria-label="Main" className={classes.desktopNav}>
                {navigation.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => `${classes.navLink}${isActive || inSection(pathname, item) ? ' active' : ''}`}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </Group>
            <Group gap="sm" wrap="nowrap">
              <Group visibleFrom="sm">
                <AccountLinks />
              </Group>
              <Burger opened={menuOpen} onClick={menu.toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <AppShell.Navbar p="md" className={classes.mobileNav}>
        <nav aria-label="Menu">
          {navigation.map((item) => (
            <MantineNavLink
              key={item.to}
              component={NavLink}
              to={item.to}
              label={item.label}
              active={inSection(pathname, item)}
            />
          ))}
          {account ? (
            <MantineNavLink component={Link} to="/account" label="Your account" active={pathname === '/account'} />
          ) : account === null ? (
            <>
              <MantineNavLink component={Link} to="/login" label="Log in" active={pathname === '/login'} />
              <MantineNavLink component={Link} to="/register" label="Create account" active={pathname === '/register'} />
            </>
          ) : null}
        </nav>
      </AppShell.Navbar>

      <AppShell.Main className={classes.main}>
        <div className={classes.page}>
          {pages}
        </div>

        <Footer />
      </AppShell.Main>
    </AppShell>
  )
}

// A data router, so pages with unsaved changes can block navigation (useBlocker). Routes stay in Shell.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AuthProvider>
        <Shell />
      </AuthProvider>
    ),
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
