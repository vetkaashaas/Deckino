import { Anchor, Badge, Button, Container, Group, List, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import {
  IconAlbum,
  IconBrandApple,
  IconBrandGooglePlay,
  IconCards,
  IconChartLine,
  IconCheck,
  IconHeart,
  IconScan,
  IconShare,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../account/auth'
import { Ambient } from '../components/Ambient'
import { CommanderOfTheDay } from './CommanderOfTheDay'
import classes from './Landing.module.css'

const features = [
  {
    icon: IconScan,
    title: 'Scan your cards',
    text: 'Point the Deckino app at a card and it recognises it from the artwork. Coming to iOS and Android.',
  },
  {
    icon: IconCards,
    title: 'Build decks',
    text: 'Search every paper printing, pick your commander and see legality warnings as you build. Import from Moxfield, Archidekt and more.',
  },
  {
    icon: IconAlbum,
    title: 'Keep binders',
    text: 'One record for every physical card, with its exact printing, condition, finish and language.',
  },
  {
    icon: IconHeart,
    title: 'Track a wishlist',
    text: 'Note the cards you want, and add everything a deck is missing from your collection in one click.',
  },
  {
    icon: IconChartLine,
    title: 'Follow prices',
    text: 'Daily prices in USD and EUR, 90 days of history, and the cards moving your collection’s value.',
  },
  {
    icon: IconShare,
    title: 'Share by link',
    text: 'Make a deck or binder public and send the link. It shows a proper preview in Discord and WhatsApp.',
  },
]

function Section({ id, title, intro, children }: { id: string; title: ReactNode; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className={classes.section} aria-labelledby={`${id}-title`}>
      <Container size="lg">
        <Stack gap="xs" align="center" ta="center" mb={48}>
          <Title order={2} id={`${id}-title`} className={classes.sectionTitle}>
            {title}
          </Title>
          {intro && (
            <Text c="dimmed" size="lg" maw={560}>
              {intro}
            </Text>
          )}
        </Stack>
        {children}
      </Container>
    </section>
  )
}

function StoreButton({ icon, small, name }: { icon: ReactNode; small: string; name: string }) {
  return (
    // ponytail: no store listings yet; point these at the real ones once the app is published.
    <a href="#" className={classes.store} onClick={(e) => e.preventDefault()} aria-disabled="true">
      {icon}
      <span>
        <span className={classes.storeSmall}>{small}</span>{' '}
        <span className={classes.storeName}>{name}</span>
      </span>
    </a>
  )
}

// The home page for visitors (and /about for everyone): what Deckino is, and the Commander of the Day.
export default function Landing() {
  const { account } = useAuth()
  // While the session loads, sign-up buttons keep their space but stay invisible (and out of the accessibility
  // tree): signed-in users never see them flash, and nothing shifts for visitors when they appear.
  const pending = account === undefined ? { visibility: 'hidden' as const } : undefined

  return (
    <div className={classes.root}>
      <section className={classes.hero} aria-labelledby="hero-title">
        <Ambient />
        <Container size="lg" className={classes.heroInner}>
          <Stack gap="lg" className={classes.heroText}>
            <Badge variant="light" size="lg" className={classes.pill}>
              Free for Magic: The Gathering players
            </Badge>
            <Title order={1} id="hero-title" className={classes.heroTitle}>
              Your Magic collection, <span className={classes.foilText}>all in one place.</span>
            </Title>
            <Text size="xl" c="dimmed" maw={520} className={classes.heroLead}>
              Scan your cards, keep your binders, build decks and follow what they’re worth. Then share them with a
              link.
            </Text>
            <Group gap="sm">
              {account ? (
                <Button component={Link} to="/" size="lg" variant="gradient">
                  Go to your dashboard
                </Button>
              ) : (
                <Button component={Link} to="/register" size="lg" variant="gradient" style={pending}>
                  Create a free account
                </Button>
              )}
              <Button component={Link} to="/cards" size="lg" variant="default">
                Browse cards
              </Button>
            </Group>
            {account === null && (
              <Text size="sm" c="dimmed">
                Already have an account?{' '}
                <Anchor component={Link} to="/login" size="sm">
                  Log in
                </Anchor>
              </Text>
            )}
          </Stack>
          <div className={classes.heroCard}>
            <CommanderOfTheDay />
          </div>
        </Container>
      </section>

      <Section id="features" title="Everything your collection needs" intro="From the card in your hand to the deck you’re proud of.">
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="lg">
          {features.map(({ icon: Icon, title, text }) => (
            <article key={title} className={classes.feature}>
              <span className={classes.featureIcon}>
                <Icon size={22} stroke={1.75} />
              </span>
              <Title order={3} mt="md" mb={6}>
                {title}
              </Title>
              <Text c="dimmed" size="sm" lh={1.6}>
                {text}
              </Text>
            </article>
          ))}
        </SimpleGrid>
      </Section>

      <section id="app" className={classes.section} aria-labelledby="app-title">
        <Container size="lg">
          <div className={classes.app}>
            <Stack gap="sm" maw={520}>
              <Title order={2} id="app-title" className={classes.sectionTitle}>
                Deckino in your pocket
              </Title>
              <Text c="dimmed" size="lg">
                The app scans cards straight into your binders, right on your phone. It’s on its way to the App Store
                and Google Play.
              </Text>
            </Stack>
            <Group gap="sm">
              <StoreButton icon={<IconBrandApple size={28} />} small="Coming soon to the" name="App Store" />
              <StoreButton icon={<IconBrandGooglePlay size={26} />} small="Coming soon to" name="Google Play" />
            </Group>
          </div>
        </Container>
      </section>

      <Section id="pricing" title="Pricing" intro="Deckino is free. A supporter plan is on the way.">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg" maw={760} mx="auto">
          <article className={classes.plan} aria-label="Free plan">
            <Text fw={600}>Free</Text>
            <Text className={classes.price}>
              $0<span>/month</span>
            </Text>
            <List spacing="xs" size="sm" icon={<IconCheck size={16} className={classes.check} />} mb="xl">
              <List.Item>Unlimited decks and binders</List.Item>
              <List.Item>Wishlist and collection comparison</List.Item>
              <List.Item>Prices and 90-day history</List.Item>
              <List.Item>Public links for decks and binders</List.Item>
            </List>
            {account ? (
              <Button component={Link} to="/" variant="default" fullWidth mt="auto">
                Your current plan
              </Button>
            ) : (
              <Button component={Link} to="/register" variant="default" fullWidth mt="auto" style={pending}>
                Create a free account
              </Button>
            )}
          </article>
          <article className={`${classes.plan} ${classes.planFeatured}`} aria-label="Supporter plan">
            <Group justify="space-between">
              <Text fw={600}>Supporter</Text>
              <Badge variant="gradient">Coming soon</Badge>
            </Group>
            <Text className={classes.price}>
              $1<span>/month</span>
            </Text>
            <List spacing="xs" size="sm" icon={<IconCheck size={16} className={classes.check} />} mb="xl">
              <List.Item>Everything in Free</List.Item>
              <List.Item>Early access to new features</List.Item>
              <List.Item>Helps keep Deckino running</List.Item>
            </List>
            <Button variant="gradient" fullWidth mt="auto" disabled>
              Coming soon
            </Button>
          </article>
        </SimpleGrid>
      </Section>

      {account === null && (
        <section className={`${classes.section} ${classes.closing}`} aria-labelledby="closing-title">
          <Container size="sm" ta="center">
            <Title order={2} id="closing-title" className={classes.sectionTitle}>
              Ready to sort your collection?
            </Title>
            <Text c="dimmed" size="lg" mt="xs" mb="xl">
              It’s free, and your decks and binders stay private until you share them.
            </Text>
            <Button component={Link} to="/register" size="lg" variant="gradient">
              Create a free account
            </Button>
          </Container>
        </section>
      )}
    </div>
  )
}
