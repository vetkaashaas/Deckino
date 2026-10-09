import { Anchor, Badge, Button, Container, Group, List, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { IconBrandApple, IconBrandGooglePlay, IconCheck, IconHeart, IconScan, IconShare } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../account/auth'
import { CardImage } from '../components/CardImage'
import { CommanderOfTheDay, useCommanderOfTheDay } from './CommanderOfTheDay'
import { BinderPreview, DeckPreview, PricePreview } from './Showcase'
import classes from './Landing.module.css'

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
        <List spacing={6} size="sm" mt="md" icon={<IconCheck size={16} className={classes.check} />}>
          {points.map((p) => (
            <List.Item key={p}>{p}</List.Item>
          ))}
        </List>
      </div>
      <div className={classes.featurePreview}>{preview}</div>
    </article>
  )
}

function StoreButton({ icon, small, name }: { icon: ReactNode; small: string; name: string }) {
  return (
    // ponytail: no store listings yet; point these at the real ones once the app is published.
    <a href="#" className={classes.store} onClick={(e) => e.preventDefault()} aria-disabled="true">
      {icon}
      <span>
        <span className={classes.storeSmall}>{small}</span> <span className={classes.storeName}>{name}</span>
      </span>
    </a>
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
          <IconCheck size={14} /> {card ? card.name : 'Recognised'}
        </span>
      </div>
    </div>
  )
}

// The home page for visitors (and /about for everyone): what Deckino is, and the Commander of the Day.
export default function Landing() {
  const { account } = useAuth()
  const commander = useCommanderOfTheDay()
  // While the session loads, sign-up buttons keep their space but stay invisible (and out of the accessibility
  // tree): signed-in users never see them flash, and nothing shifts for visitors when they appear.
  const pending = account === undefined ? { visibility: 'hidden' as const } : undefined

  return (
    <div className={classes.root}>
      <section className={classes.hero} aria-labelledby="hero-title">
        {/* Today's commander's art, full bleed: slowly drifting, darkened towards the words. */}
        <div className={classes.backdrop} aria-hidden="true">
          {commander?.artCrop && <img src={commander.artCrop} alt="" className={classes.backdropArt} />}
        </div>
        <Container size="lg" className={classes.heroInner}>
          <Stack gap="lg" className={classes.heroText}>
            <Title order={1} id="hero-title" className={classes.heroTitle}>
              Your Magic collection, sleeved and sorted.
            </Title>
            <Text size="xl" className={classes.heroLead}>
              Scan your cards into binders, build decks from every printing, and follow what it’s all worth. Free, and
              private until you share it.
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
                'Every paper printing, foil and etched',
                'Legality warnings while you build',
                'Mana curve, colours and visual stacks',
                'Import from Moxfield, Archidekt, TappedOut and ManaBox',
              ]}
            >
              Pick your commander, search the whole catalogue and type “4 lightning bolt” to add a playset. Your deck saves
              as you go.
            </Feature>
            <Feature
              title="Keep binders"
              flip
              preview={<BinderPreview />}
              points={['Exact printing, condition, finish and language', 'Mark a binder for sale and share its link', 'Compare a deck with everything you own']}
            >
              One record for every physical card, so you always know what you have and where it is.
            </Feature>
            <Feature
              title="Follow prices"
              preview={<PricePreview />}
              points={['Daily prices in USD and EUR', '90 days of history for every printing', 'The cards moving your collection’s value']}
            >
              See what your binders, decks and wishlist are worth, and which cards moved this week.
            </Feature>
          </div>

          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg" mt={72}>
            {[
              { icon: IconScan, title: 'Scan your cards', text: 'Point the Deckino app at a card and it recognises it from the artwork. Coming to iOS and Android.' },
              { icon: IconHeart, title: 'Track a wishlist', text: 'Note the cards you want, and add everything a deck is missing from your collection in one click.' },
              { icon: IconShare, title: 'Share by link', text: 'Make a deck or binder public and send the link. It shows a proper preview in Discord and WhatsApp.' },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className={classes.small}>
                <Icon size={22} stroke={1.75} className={classes.smallIcon} />
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
                Hold a card up to your phone and it lands in your binder, printing and all. The app is on its way to the
                App Store and Google Play.
              </Text>
              <Group gap="sm" mt="md">
                <StoreButton icon={<IconBrandApple size={28} />} small="Coming soon to the" name="App Store" />
                <StoreButton icon={<IconBrandGooglePlay size={26} />} small="Coming soon to" name="Google Play" />
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
