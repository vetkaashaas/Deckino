import { Button, Group, ScrollArea, SimpleGrid, Stack, Switch, Text, Title, Tooltip } from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconEyeOff,
  IconPlayerSkipForward,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconX,
} from '@tabler/icons-react'
import { useEffect } from 'react'
import { ref, useWorkspace } from '../bridge'
import { BoundTextInput, ImageWell, isTyping, PageHeader, RetryImage, Section } from '../components'
import classes from './pages.module.css'
import styles from './CardIdentification.module.css'

type Choice = { oracleId: string; name: string; artUrl: string | null; scoreText: string; isSelected: boolean }
type Printing = { printingId: string; label: string; setName: string | null; artUrl: string | null }

type CardIdentification = {
  displayName: string
  description: string
  candidates: Choice[]
  searchResults: Choice[]
  printings: Printing[]
  cardCropUrl: string | null
  selected: Choice | null
  selectedPrinting: Printing | null
  printingFilter: string
  currentFileName: string
  captureDetails: string
  status: string
  searchText: string
  isBusy: boolean
  newestFirst: boolean
  hasPhoto: boolean
  hasPrintingChoice: boolean
  savedArtUrl: string | null
  savedPrintingText: string
  queueSummary: string
}

export default function CardIdentificationPage() {
  const { state, can, run, set } = useWorkspace<CardIdentification>('cardIdentification')

  // Enter saves, ← → browse; not while typing, and a held Enter never saves photo after photo unseen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event)) return
      if (event.key === 'Enter') {
        if (event.repeat || (event.target as HTMLElement).closest('button')) return
        event.preventDefault()
        if (can('confirm')) run('confirm')
      } else if (event.key === 'ArrowRight' && can('moveNext')) run('moveNext')
      else if (event.key === 'ArrowLeft' && can('movePrevious')) run('movePrevious')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [can, run])

  if (!state) return null

  const choiceList = (choices: Choice[], path: string) =>
    choices.map((choice) => (
      <div
        key={`${path}-${choice.oracleId}`}
        className={styles.choice}
        data-selected={choice.isSelected || undefined}
        onClick={() => run('select', ref(path, { oracleId: choice.oracleId }))}
      >
        <div className={styles.choiceArt}>{choice.artUrl && <RetryImage src={choice.artUrl} alt="" loading="lazy" retry />}</div>
        <Stack gap={2} miw={0}>
          <Text fw={600} size="sm" lineClamp={2}>
            {choice.name}
          </Text>
          {choice.scoreText && (
            <Text ff="monospace" size="xs" c="dimmed">
              {choice.scoreText}
            </Text>
          )}
        </Stack>
      </div>
    ))

  return (
    <div className={`${classes.page} ${classes.fit}`}>
      <PageHeader title={state.displayName} subtitle={state.description}>
        <Switch label="Newest first" checked={state.newestFirst} onChange={(event) => set({ newestFirst: event.currentTarget.checked })} mr="xs" />
        <Button variant="subtle" color="gray" leftSection={<IconRefresh size={18} />} onClick={() => run('refresh')} disabled={!can('refresh')}>
          Refresh queue
        </Button>
        <Tooltip label="Show the current artwork model's guesses for this photo. Saving keeps the phone's guesses too.">
          <Button variant="default" leftSection={<IconSparkles size={18} />} onClick={() => run('suggestCards')} disabled={!can('suggestCards')}>
            Suggest cards
          </Button>
        </Tooltip>
      </PageHeader>

      <div className={classes.info}>
        <Text fw={600}>{state.currentFileName}</Text>
        <Text ff="monospace" size="xs" c="dimmed" style={{ flex: 1 }} truncate data-selectable>
          {state.captureDetails}
        </Text>
        <Text fw={600} size="sm" c="var(--deckino-violet)">
          {state.queueSummary}
        </Text>
      </div>

      <div className={styles.layout}>
        <Section fill title="In the photo">
          <ImageWell src={state.cardCropUrl} alt="The card in the photo" placeholder="No photo to identify" fill />
        </Section>

        <Section fill title="Will be saved as">
          <ImageWell src={state.savedArtUrl} alt="The chosen card" placeholder={state.selected ? 'Card image not downloaded yet' : 'Pick a card'} fill retry />
          <Stack gap={2} align="center" my="sm">
            <Title order={2} ta="center">
              {state.selected?.name ?? 'Pick a card'}
            </Title>
            <Text ff="monospace" size="xs" c="dimmed">
              {state.savedPrintingText}
            </Text>
          </Stack>
          {state.hasPrintingChoice && (
            <>
              <BoundTextInput
                size="xs"
                radius="xl"
                placeholder="Filter printings by set or number"
                leftSection={<IconSearch size={14} />}
                value={state.printingFilter}
                onCommit={(value) => set({ printingFilter: value })}
              />
              <ScrollArea h={230} mt="xs" type="auto">
                <SimpleGrid cols={4} spacing={6} verticalSpacing={6} pr={8}>
                  {state.printings.map((printing) => (
                    <Tooltip key={printing.printingId} label={printing.setName ?? printing.label}>
                      <div
                        className={styles.printing}
                        data-selected={state.selectedPrinting?.printingId === printing.printingId || undefined}
                        onClick={() => set({ selectedPrinting: ref('printings', { printingId: printing.printingId }) })}
                      >
                        <div className={styles.printingArt}>
                          {printing.artUrl && <RetryImage src={printing.artUrl} alt="" loading="lazy" decoding="async" retry />}
                        </div>
                        <Text ff="monospace" size="10px" c="dimmed" ta="center" truncate>
                          {printing.label}
                        </Text>
                      </div>
                    </Tooltip>
                  ))}
                </SimpleGrid>
              </ScrollArea>
            </>
          )}
        </Section>

        <div className={styles.side}>
          <Section fill>
            <ScrollArea className={styles.choices} type="auto">
              <Stack gap={6} pr={8}>
                <Text className={styles.eyebrow}>Model candidates</Text>
                {choiceList(state.candidates, 'candidates')}
                <Text className={styles.eyebrow} mt="sm">
                  Not listed? Search by name
                </Text>
                <BoundTextInput
                  radius="xl"
                  placeholder="Card name, then Enter"
                  leftSection={<IconSearch size={14} />}
                  value={state.searchText}
                  onCommit={(value) => set({ searchText: value })}
                  onKeyDown={async (event) => {
                    if (event.key !== 'Enter') return
                    await set({ searchText: event.currentTarget.value })
                    run('search')
                  }}
                />
                {choiceList(state.searchResults, 'searchResults')}
              </Stack>
            </ScrollArea>
          </Section>

          <Stack gap={8}>
            <Button variant="gradient" size="md" leftSection={<IconCheck size={18} />} onClick={() => run('confirm')} disabled={!can('confirm')}>
              Save card &amp; next
            </Button>
            <Group grow gap={8}>
              <Button variant="default" leftSection={<IconX size={16} />} onClick={() => run('notACard')} disabled={!can('notACard')}>
                Not a card
              </Button>
              <Tooltip label="Too blurry or covered to tell which card it is">
                <Button variant="default" leftSection={<IconEyeOff size={16} />} onClick={() => run('unreadable')} disabled={!can('unreadable')}>
                  Unreadable
                </Button>
              </Tooltip>
            </Group>
            <Group grow gap={4}>
              <Button variant="subtle" color="gray" px="xs" leftSection={<IconArrowLeft size={16} />} onClick={() => run('movePrevious')} disabled={!can('movePrevious')}>
                Previous
              </Button>
              <Button variant="subtle" color="gray" px="xs" leftSection={<IconPlayerSkipForward size={16} />} onClick={() => run('skip')} disabled={!can('skip')}>
                Skip
              </Button>
              <Button variant="subtle" color="gray" px="xs" rightSection={<IconArrowRight size={16} />} onClick={() => run('moveNext')} disabled={!can('moveNext')}>
                Next
              </Button>
            </Group>
            <Text size="xs" c="dimmed" lineClamp={3}>
              {state.status}
            </Text>
          </Stack>
        </div>
      </div>

      <Text className={classes.hint}>
        Click a card to select it · <span className={classes.kbd}>Enter</span> save &amp; next ·{' '}
        <span className={classes.kbd}>←</span>
        <span className={classes.kbd}>→</span> browse queue
      </Text>
    </div>
  )
}
