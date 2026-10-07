import { Anchor, AppShell, Burger, Container, Group, NavLink as MantineNavLink, Stack, Text, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router'
import classes from './App.module.css'
import CardPage from './cards/CardPage'
import CardSearch from './cards/CardSearch'

const Styleguide = lazy(() => import('./styleguide/Styleguide'))

const navigation = [{ to: '/cards', label: 'Cards' }]

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
    <Container size="lg" py="xl">
      <Stack gap="md" maw={640}>
        <Title order={1}>Scan, collect, build and share your Magic cards.</Title>
        <Text size="lg" c="dimmed">
          Decks, binders and your wishlist, all in one place. Coming soon. For now,{' '}
          <Anchor component={Link} to="/cards">
            browse the card catalogue
          </Anchor>
          .
        </Text>
      </Stack>
    </Container>
  )
}

function Shell() {
  const [menuOpen, menu] = useDisclosure()
  const apiStatus = useApiStatus()
  const { pathname } = useLocation()

  const closeMenu = menu.close
  useEffect(() => closeMenu(), [pathname, closeMenu])

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 280, breakpoint: 'sm', collapsed: { desktop: true, mobile: !menuOpen } }}
      padding={0}
    >
      <AppShell.Header className={classes.header}>
        <Container size="lg" h="100%">
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Group gap="xl" wrap="nowrap">
              <Link to="/" className={classes.brand} aria-label="Deckino home">
                <img src="/logo.svg" alt="Deckino" height={26} />
              </Link>
              <nav aria-label="Main" className={classes.desktopNav}>
                {navigation.map((item) => (
                  <NavLink key={item.to} to={item.to} className={classes.navLink}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </Group>
            <Burger opened={menuOpen} onClick={menu.toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
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
              active={pathname.startsWith(item.to)}
            />
          ))}
        </nav>
      </AppShell.Navbar>

      <AppShell.Main className={classes.main}>
        <div className={classes.page}>
          <Suspense>
            <Routes>
              <Route path="/cards" element={<CardSearch />} />
              <Route path="/cards/:id" element={<CardPage />} />
              <Route path="/styleguide" element={<Styleguide />} />
              <Route path="*" element={<Home />} />
            </Routes>
          </Suspense>
        </div>

        <footer className={classes.footer}>
          <Container size="lg">
            <Text size="xs" c="dimmed">
              Deckino is unofficial Fan Content permitted under the{' '}
              <Anchor href="https://company.wizards.com/en/legal/fancontentpolicy" size="xs">
                Fan Content Policy
              </Anchor>
              . Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of
              the Coast. ©Wizards of the Coast LLC.
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              Card data and images courtesy of{' '}
              <Anchor href="https://scryfall.com" size="xs">
                Scryfall
              </Anchor>
              . <span data-testid="api-status">API: {apiStatus}</span>
            </Text>
          </Container>
        </footer>
      </AppShell.Main>
    </AppShell>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}
