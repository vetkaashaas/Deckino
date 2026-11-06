import { Anchor, AppShell, Burger, Button, Container, Group, NavLink as MantineNavLink, Stack, Text, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { lazy, Suspense, useEffect } from 'react'
import { createBrowserRouter, Link, Navigate, NavLink, Route, RouterProvider, Routes, useLocation } from 'react-router'
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
import Collection from './binders/Collection'
import PublicBinderPage from './binders/PublicBinderPage'
import Dashboard from './Dashboard'
import DeckPage from './decks/DeckPage'
import ImportPage from './import/ImportPage'
import DeckSearch from './decks/DeckSearch'
import PublicDeckPage from './decks/PublicDeckPage'
import Landing from './landing/Landing'
import { FanContentNotice } from './components/FanContentNotice'
import MyDecks from './decks/MyDecks'
import { Icon, type IconName } from './components/Icon'

// Dev and E2E builds only (`vite build --mode e2e`), like the app's.
const Styleguide = import.meta.env.MODE === 'production' ? null : lazy(() => import('./styleguide/Styleguide'))
const AdminPage = lazy(() => import('./admin/AdminPage'))

interface Section {
  to: string
  label: string
  also: string[] // other addresses that belong to it (Decks covers your decks, browsing and public decks)
  icon?: IconName // in the phone's tab bar
}

const publicNavigation: Section[] = [
  { to: '/browse', label: 'Browse decks', also: ['/deck/'] },
  { to: '/cards', label: 'Cards', also: [] },
]
// For visitors: the landing page's sections (ids in Landing.tsx), before the pages above.
const landingSections = [
  { hash: '#features', label: 'Features' },
  { hash: '#app', label: 'Mobile app' },
  { hash: '#pricing', label: 'Pricing' },
]
// The app's tabs, in its order (Scan aside: that needs the phone's camera).
const accountNavigation: (Section & { icon: IconName })[] = [
  { to: '/', label: 'Home', also: [], icon: 'home' },
  { to: '/cards', label: 'Cards', also: [], icon: 'web_stories' },
  { to: '/collection', label: 'Collection', also: ['/binders', '/binder/', '/wishlist'], icon: 'collections_bookmark' },
  { to: '/decks', label: 'Decks', also: ['/browse', '/deck/'], icon: 'style' },
]
// Only for admins (users.is_admin).
const adminNavigation: (Section & { icon: IconName })[] = [{ to: '/admin', label: 'Admin', also: [], icon: 'tune' }]
// Full-page account pages, outside the header and footer.
const accountPages = ['/register', '/verify-email', '/login', '/forgot-password', '/reset-password']

const inSection = (pathname: string, item: Section) =>
  item.to === '/' ? pathname === '/' : pathname.startsWith(item.to) || item.also.some((path) => pathname.startsWith(path))

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

// Signed in: the app's round avatar (the username's initial), opening the account page. Named by the username.
function AccountAvatar({ username }: { username: string }) {
  return (
    <Link to="/account" className={classes.avatar} aria-label={username} title={username}>
      {username.slice(0, 1).toUpperCase()}
    </Link>
  )
}

// Visitors: log in or sign up.
function AccountLinks() {
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

// The site footer: the Fan Content notice and Scryfall credit.
function Footer() {
  return (
    <footer className={classes.footer}>
      <Container size="lg">
        <FanContentNotice />
        <Text size="xs" c="dimmed" mt={4}>
          Card data and images courtesy of{' '}
          <Anchor href="https://scryfall.com" size="xs">
            Scryfall
          </Anchor>
          {' '}·{' '}
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
  const tabs = account ? [...accountNavigation, ...(account.isAdmin ? adminNavigation : [])] : []
  const navigation = account ? tabs : publicNavigation
  // Matched like the routes are: a trailing slash or other casing is still the same page.
  const path = pathname.replace(/\/+$/, '').toLowerCase() || '/'
  // Logged out (or not yet known) on the home page, or /about: the header sits translucent over the hero.
  const landing = path === '/about' || (path === '/' && !account)
  // Section links stay on /about when there; from anywhere else they lead to the home page's sections.
  const sections = account === null ? landingSections.map((s) => ({ ...s, to: (path === '/about' ? '/about' : '/') + s.hash })) : []

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
        <Route path="/collection" element={<Collection />} />
        <Route path="/collection/prices" element={<Collection />} />
        <Route path="/binders" element={<Navigate to="/collection" replace />} />
        <Route path="/binders/import" element={<ImportPage key="binder" kind="binder" />} />
        <Route path="/binders/:id" element={<BinderPage />} />
        <Route path="/binder/:id" element={<PublicBinderPage />} />
        <Route path="/wishlist" element={<Collection />} />
        <Route path="/about" element={<Landing />} />
        {Styleguide && <Route path="/styleguide" element={<Styleguide />} />}
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/" element={account ? <Dashboard account={account} /> : account === null ? <Landing /> : null} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
  if (accountPages.includes(path)) return pages

  return (
    <AppShell
      header={{ height: 72 }}
      navbar={{ width: 280, breakpoint: 'sm', collapsed: { desktop: true, mobile: !menuOpen || Boolean(account) } }}
      padding={0}
    >
      <AppShell.Header className={classes.header} data-over-hero={landing || undefined}>
        <Container size="lg" h="100%">
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Group gap="xl" wrap="nowrap">
              <Link to="/" className={classes.brand} aria-label="Deckino home" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                <img src="/logo.svg" alt="Deckino" height={44} />
              </Link>
              <nav aria-label="Main" className={classes.desktopNav}>
                {sections.map((s) => (
                  <Link key={s.hash} to={s.to} className={`${classes.navLink} ${classes.sectionLink}`}>
                    {s.label}
                  </Link>
                ))}
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
            {account ? (
              <AccountAvatar username={account.username} />
            ) : (
              <Group gap="sm" wrap="nowrap">
                {account === null && (
                  <Group visibleFrom="sm">
                    <AccountLinks />
                  </Group>
                )}
                <Burger opened={menuOpen} onClick={menu.toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
              </Group>
            )}
          </Group>
        </Container>
      </AppShell.Header>

      {!account && (
      <AppShell.Navbar p="md" className={classes.mobileNav}>
        <nav aria-label="Menu">
          {sections.map((s) => (
            <MantineNavLink key={s.hash} component={Link} to={s.to} label={s.label} onClick={menu.close} />
          ))}
          {navigation.map((item) => (
            <MantineNavLink
              key={item.to}
              component={NavLink}
              to={item.to}
              label={item.label}
              active={inSection(pathname, item)}
            />
          ))}
          {account === null && (
            <>
              <MantineNavLink component={Link} to="/login" label="Log in" active={pathname === '/login'} />
              <MantineNavLink component={Link} to="/register" label="Create account" active={pathname === '/register'} />
            </>
          )}
        </nav>
      </AppShell.Navbar>
      )}

      <AppShell.Main className={classes.main} data-tab-bar={account ? true : undefined}>
        <div className={classes.page}>
          {pages}
        </div>

        <Footer />
      </AppShell.Main>

      {/* Signed in on a phone: the app's tab bar instead of the header's links (the header keeps the avatar). */}
      {account && (
        <nav aria-label="Main" className={classes.tabBar}>
          {tabs.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={classes.tab}
              data-active={inSection(pathname, item) || undefined}
              aria-current={inSection(pathname, item) ? 'page' : undefined}
            >
              <span className={classes.tabIcon}>
                <Icon name={item.icon} size={22} />
              </span>
              {item.label}
            </Link>
          ))}
        </nav>
      )}
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
