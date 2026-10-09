import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Chip,
  Container,
  Group,
  Modal,
  PasswordInput,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import type { ReactNode } from 'react'
import { ArtHeader } from '../components/ArtHeader'
import { LegalityAlert } from '../decks/DeckParts'
import { CardImage } from '../components/CardImage'
import { formatPrice, useCurrency } from '../components/currency'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { EmptyState } from '../components/EmptyState'
import { ManaSymbols, symbolUrl } from '../components/ManaSymbols'
import classes from './Styleguide.module.css'

// Every shared component in its states: the reference for building pages. Not linked from the site.

const delver = '871c4ccc-5a14-4583-b4c7-6f2d2aeb8253.jpg?1783907992'
const image = (size: string, face = 'front') => `https://cards.scryfall.io/${size}/${face}/8/7/${delver}`

const swatches = [
  ['Page', 'var(--mantine-color-dark-7)'],
  ['Surface', 'var(--mantine-color-dark-6)'],
  ['Raised / hover', 'var(--mantine-color-dark-5)'],
  ['Hairline', 'var(--mantine-color-dark-4)'],
  ['Dimmed text', 'var(--mantine-color-dark-2)'],
  ['Text', 'var(--mantine-color-dark-0)'],
  ['Brand purple', 'var(--mantine-color-purple-6)'],
  ['Brand pink', 'var(--mantine-color-pink-5)'],
  ['Foil', 'var(--deckino-foil)'],
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={classes.section} aria-label={title}>
      <Title order={2} mb="lg">
        {title}
      </Title>
      {children}
    </section>
  )
}

export default function Styleguide() {
  const [confirmOpen, confirm] = useDisclosure()
  const [currency, setCurrency] = useCurrency()

  return (
    <>
      <ArtHeader art={image('art_crop')}>
        <Title order={1}>Style guide</Title>
        <Text c="dimmed" mt="xs" maw={560}>
          Deckino's components in every state. Pages are built from these, so a change here changes the
          whole site.
        </Text>
      </ArtHeader>

      <Container size="lg">
        <Section title="Colour">
          <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="md">
            {swatches.map(([name, value]) => (
              <div key={name}>
                <div className={classes.swatch} style={{ background: value }} />
                <Text size="sm" mt={6}>
                  {name}
                </Text>
              </div>
            ))}
          </SimpleGrid>
        </Section>

        <Section title="Type">
          <Stack gap="sm">
            <Title order={1}>Delver of Secrets</Title>
            <Title order={2}>Printings</Title>
            <Title order={3}>Insectile Aberration</Title>
            <Title order={4}>Sideboard</Title>
            <Text maw={620}>
              At the beginning of your upkeep, look at the top card of your library. You may reveal that
              card. If an instant or sorcery card is revealed this way, transform this creature.
            </Text>
            <Text c="dimmed" size="sm">
              Dimmed text for supporting details, like a release year or an empty price.
            </Text>
          </Stack>
        </Section>

        <Section title="Buttons">
          <Stack gap="md">
            <Group>
              <Button variant="gradient">Add to deck</Button>
              <Button variant="default">Load more</Button>
              <Button variant="light">Compare</Button>
              <Button variant="subtle">Cancel</Button>
              <Button color="red">Delete deck</Button>
            </Group>
            <Group>
              <Button variant="gradient" loading>
                Saving
              </Button>
              <Button variant="default" disabled>
                Unavailable
              </Button>
              <Button variant="default" size="xs">
                Small
              </Button>
              <Tooltip label="Opens the card on Scryfall">
                <Button variant="default">With tooltip</Button>
              </Tooltip>
            </Group>
            <Text size="sm" c="dimmed">
              One gradient button per view, for its main action.
            </Text>
          </Stack>
        </Section>

        <Section title="Form fields">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg" maw={720}>
            <TextInput label="Username" description="3 to 20 letters, digits, _ or -" placeholder="bolt_the_bird" />
            <TextInput label="Email" placeholder="you@example.com" error="Enter a valid email address" />
            <PasswordInput label="Password" placeholder="At least 8 characters" />
            <Select label="Format" placeholder="Choose a format" data={['Standard', 'Modern', 'Commander']} />
            <Checkbox label="Make this deck public" />
            <Checkbox label="Include tokens and art cards" defaultChecked />
          </SimpleGrid>
          <Group mt="lg" gap="lg" align="center">
            <Chip.Group multiple defaultValue={['U', 'R']}>
              <Group gap={6}>
                {['W', 'U', 'B', 'R', 'G'].map((c) => (
                  <Chip key={c} value={c} variant="outline" size="sm">
                    <img src={symbolUrl(c)} alt={c} width={20} height={20} style={{ display: 'block' }} />
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
            <CurrencyToggle currency={currency} onChange={setCurrency} />
          </Group>
        </Section>

        <Section title="Feedback">
          <Stack gap="md" maw={720}>
            <Alert color="purple" title="Catalogue updated">
              New printings from today's Scryfall data are in.
            </Alert>
            <Alert color="green" title="Deck saved">
              Your changes are saved.
            </Alert>
            <Alert color="red" title="Card search is unavailable">
              The catalogue didn't respond. Try again in a moment.
            </Alert>
            <Group gap="xs">
              <Badge variant="light">Commander</Badge>
              <Badge variant="light" color="green">
                Legal
              </Badge>
              <Badge variant="light" color="red">
                Banned
              </Badge>
              <Badge variant="outline" color="gray">
                Private
              </Badge>
            </Group>
            <Group align="flex-start" gap="lg">
              <Skeleton height={14} width={180} />
              <Skeleton height={14} width={120} />
            </Group>
            <EmptyState title="Build your first deck" action={<Button variant="gradient">Create deck</Button>}>
              Decks you create show up here.
            </EmptyState>
            <Group gap="sm" align="flex-start">
              <LegalityAlert format="commander" warnings={[]} />
              <LegalityAlert format="modern" warnings={['A Modern deck needs at least 60 mainboard cards. This one has 4.']} defaultOpen />
            </Group>
          </Stack>
        </Section>

        <Section title="Dialog">
          <Button color="red" variant="light" onClick={confirm.open}>
            Delete account
          </Button>
          <Modal opened={confirmOpen} onClose={confirm.close} title="Delete your account?" centered>
            <Text>This permanently deletes your account, decks, binders and wishlist. It can't be undone.</Text>
            <Group justify="flex-end" mt="lg">
              <Button variant="default" onClick={confirm.close}>
                Keep account
              </Button>
              <Button color="red" onClick={confirm.close}>
                Delete account
              </Button>
            </Group>
          </Modal>
        </Section>

        <Section title="Cards">
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg" maw={760}>
            <Stack gap={6}>
              <CardImage src={image('normal')} alt="Delver of Secrets" />
              <Text size="sm">Card</Text>
            </Stack>
            <Stack gap={6}>
              <CardImage src={image('normal', 'back')} alt="Insectile Aberration" foil />
              <Text size="sm">Foil (move the pointer over it)</Text>
            </Stack>
            <Stack gap={6}>
              <CardImage placeholder alt="" />
              <Text size="sm">Loading</Text>
            </Stack>
            <Stack gap={6}>
              <CardImage src={undefined} alt="Image unavailable" />
              <Text size="sm">No image</Text>
            </Stack>
          </SimpleGrid>
          <Group mt="xl" gap="xl">
            <Text size="lg">
              <ManaSymbols text="{2}{W/U}{G}" />
            </Text>
            <Text>
              <ManaSymbols text="{T}: Add {G}." />
            </Text>
            <Text className={classes.price}>{formatPrice(1.59, currency)}</Text>
            <Text c="dimmed">{formatPrice(null, currency)}</Text>
          </Group>
        </Section>
      </Container>
    </>
  )
}
