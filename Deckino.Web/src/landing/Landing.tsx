import { Anchor, Badge, Button, Container, Group, List, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../account/auth'
import { CardImage } from '../components/CardImage'
import { CommanderOfTheDay, useCommanderOfTheDay } from './CommanderOfTheDay'
import { BinderPreview, DeckPreview, PricePreview, useShowcase } from './Showcase'
import classes from './Landing.module.css'
import { Icon } from '../components/Icon'

// One feature: what it does in a sentence, a few specifics, and a working preview beside it.
function Feature({ title, children, points, preview, flip = false }: { title: string; children: ReactNode; points: string[]; preview: ReactNode; flip?: boolean }) {
  return (
    <article className={classes.feature} data-flip={flip || undefined}>
      <div className={classes.featureText}>
        <Title order={3} className={classes.featureTitle}>
          {title}
        </Title>
        <Text c="dimmed" size="lg" lh={1.6}>
          {children}
        </Text>
        <List spacing={6} size="sm" mt="md" icon={<Icon name="check" size={16} className={classes.check} />}>
          {points.map((p) => (
            <List.Item key={p}>{p}</List.Item>
          ))}
        </List>
      </div>
      <div className={classes.featurePreview}>{preview}</div>
    </article>
  )
}

// Not a link yet: a flat, dimmed badge until the app is in the stores (then make these the stores' own buttons).
function StoreBadge({ icon, small, name }: { icon: ReactNode; small: string; name: string }) {
  return (
    <span className={classes.store}>
      {icon}
      <span>
        <span className={classes.storeSmall}>{small}</span> <span className={classes.storeName}>{name}</span>
      </span>
    </span>
  )
}

// Two cards fanned out behind the Commander of the Day: the showcase binder's first, else the priciest cards.
function HeroFan() {
  const data = useShowcase()
  const fan = data ? [...data.binder.filter((c) => c !== null), ...data.valuable].slice(0, 2) : []
  return (
    <div className={classes.fan} aria-hidden="true">
      {fan.map((c, i) => (
        <div key={c.id} className={classes.fanCard} data-side={i ? 'right' : 'left'}>
          <CardImage src={c.image} alt="" />
        </div>
      ))}
    </div>
  )
}

// The phone app, scanning today's commander.
function PhonePreview() {
  const card = useCommanderOfTheDay()
  return (
    <div className={classes.phone} aria-hidden="true">
      <div className={classes.phoneScreen}>
        <div className={classes.scanCard}>
          <CardImage src={card?.images[0]} placeholder={!card} alt="" lazy />
          <span className={classes.reticle} />
        </div>
        <span className={classes.scanChip}>
          <Icon name="check" size={14} /> <span className={classes.scanName}>{card ? card.name : 'Recognised'}</span>
        </span>
      </div>
    </div>
  )
}

// The home page for visitors (and /about for everyone): what Deckino is, and the Commander of the Day.
export default function Landing() {
  const { account } = useAuth()
  // The header's section links (/#features…): scroll there, again on every click of the same link.
  const { hash, key } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' })
  }, [hash, key])
  // While the session loads, sign-up buttons keep their space but stay invisible (and out of the accessibility
  // tree): signed-in users never see them flash, and nothing shifts for visitors when they appear.
  const pending = account === undefined ? { visibility: 'hidden' as const } : undefined

  return (
    <div className={classes.root}>
      <section className={classes.hero} aria-labelledby="hero-title">
        {/* Deckino's own backdrop, the same every day: a slowly drifting glow. */}
        <div className={classes.backdrop} aria-hidden="true">
          <span className={classes.glow} />
        </div>
        <Container size="lg" className={classes.heroInner}>
          <Stack gap="lg" className={classes.heroText}>
            <Title order={1} id="hero-title" className={classes.heroTitle}>
              Your Magic collection, sleeved and sorted.
            </Title>
            <Text size="xl" className={classes.heroLead}>
              Scan your cards into binders, build decks with any version of a card, and follow what it’s all worth.
              Free, and private until you share it.
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
              <Button component={Link} to="/cards" size="lg" variant="default" className={classes.glassButton}>
                Browse cards
              </Button>
            </Group>
            {account === null && (
              <Text size="sm" className={classes.heroSmall}>
                Already have an account?{' '}
                <Anchor component={Link} to="/login" size="sm">
                  Log in
                </Anchor>
              </Text>
            )}
          </Stack>
          <div className={classes.heroCard}>
            <HeroFan />
            <CommanderOfTheDay />
          </div>
        </Container>
      </section>

      <section id="features" className={classes.section} aria-labelledby="features-title">
        <Container size="lg">
          <Stack gap="xs" align="center" ta="center" mb={64}>
            <Title order={2} id="features-title" className={classes.sectionTitle}>
              Everything your collection needs
            </Title>
            <Text c="dimmed" size="lg" maw={560}>
              From the card in your hand to the deck you’re proud of.
            </Text>
          </Stack>

          <div className={classes.features}>
            <Feature
              title="Build decks"
              preview={<DeckPreview />}
              points={[
                'Every version of every card, foil included',
                'Legality warnings while you build',
                'Mana curve, colours and visual stacks',
                'Import from Moxfield, Archidekt, TappedOut and ManaBox',
              ]}
            >
              Pick your commander, search the whole catalogue and type “sol ring” to drop it straight into the deck. Your
              deck saves as you go.
            </Feature>
            <Feature
              title="Keep binders"
              flip
              preview={<BinderPreview />}
              points={['Which set, condition, foil and language', 'Mark a binder for sale and share its link', 'Compare a deck with everything you own']}
            >
              One record for every physical card, so you always know what you have and where it is.
            </Feature>
            <Feature
              title="Follow prices"
              preview={<PricePreview />}
              points={['Daily prices in USD and EUR', '90 days of price history for every card', 'The cards moving your collection’s value']}
            >
              See what your binders, decks and wishlist are worth, and which cards moved this week.
            </Feature>
          </div>

          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg" mt={72}>
            {([
              { icon: 'document_scanner', title: 'Scan your cards', text: 'Point the Deckino app at a card and it recognises it from the artwork. Coming to iOS and Android.' },
              { icon: 'favorite', title: 'Track a wishlist', text: 'Note the cards you want, and add everything a deck is missing from your collection in one click.' },
              { icon: 'share', title: 'Share by link', text: 'Make a deck or binder public and send the link. It shows a proper preview in Discord and WhatsApp.' },
            ] as const).map(({ icon, title, text }) => (
              <div key={title} className={classes.small}>
                <Icon name={icon} size={22} className={classes.smallIcon} />
                <Title order={3} size="h4" mt="sm" mb={6}>
                  {title}
                </Title>
                <Text c="dimmed" size="sm" lh={1.6}>
                  {text}
                </Text>
              </div>
            ))}
          </SimpleGrid>
        </Container>
      </section>

      <section id="app" className={classes.section} aria-labelledby="app-title">
        <Container size="lg">
          <div className={classes.app}>
            <Stack gap="sm" maw={500}>
              <Title order={2} id="app-title" className={classes.sectionTitle}>
                Deckino in your pocket
              </Title>
              <Text c="dimmed" size="lg">
                Hold a card up to your phone and it lands in your binder, set and all. The app is on its way to the
                App Store and Google Play.
              </Text>
              <Group gap="sm" mt="md">
                <StoreBadge icon={<Icon name="app_store" size={28} />} small="Coming soon to the" name="App Store" />
                <StoreBadge icon={<Icon name="google_play" size={26} />} small="Coming soon to" name="Google Play" />
              </Group>
            </Stack>
            <PhonePreview />
          </div>
        </Container>
      </section>

      <section id="pricing" className={classes.section} aria-labelledby="pricing-title">
        <Container size="lg">
          <Stack gap="xs" align="center" ta="center" mb={48}>
            <Title order={2} id="pricing-title" className={classes.sectionTitle}>
              Pricing
            </Title>
            <Text c="dimmed" size="lg" maw={560}>
              Deckino is free. A supporter plan is on the way.
            </Text>
          </Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg" maw={760} mx="auto">
            <article className={classes.plan} aria-label="Free plan">
              <Text fw={600}>Free</Text>
              <Text className={classes.price}>
                $0<span>/month</span>
              </Text>
              <List spacing="xs" size="sm" icon={<Icon name="check" size={16} className={classes.check} />} mb="xl">
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
              <List spacing="xs" size="sm" icon={<Icon name="check" size={16} className={classes.check} />} mb="xl">
                <List.Item>Everything in Free</List.Item>
                <List.Item>Early access to new features</List.Item>
                <List.Item>Helps keep Deckino running</List.Item>
              </List>
              <Button variant="gradient" fullWidth mt="auto" disabled>
                Coming soon
              </Button>
            </article>
          </SimpleGrid>
        </Container>
      </section>

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
