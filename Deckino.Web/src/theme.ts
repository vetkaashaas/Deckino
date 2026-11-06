import { ActionIcon, Badge, Button, Chip, createTheme, SegmentedControl, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core'

// Deckino's colours, from STYLEGUIDE.md (the same values as Deckino.App/src/theme.ts): one deep purple, dark only.
// Each scale puts the guide's own values where Mantine reads them; the shades between are only steps.

// Mantine's dark scheme reads these slots: 0 text, 2 dimmed text, 3 placeholders, 4 borders,
// 5 hover, 6 surfaces and inputs, 7 page background.
const dark: MantineColorsTuple = [
  '#FFFFFF', // text
  '#DCD5E3',
  '#B9AFC4', // textMuted
  '#7D7287', // textDim
  '#2D2535', // glassBorder over surface
  '#221730',
  '#160D1F', // surface
  '#0B0610', // background
  '#07040A',
  '#030205',
]

// 3 is lavender (links, icons, counts), 4 violet (selected borders, bright accents), 6 the brand purple (fills),
// 9 purpleDeep (the gradient's dark end).
const purple: MantineColorsTuple = [
  '#F4EAFE',
  '#E5CFFB',
  '#D5B4F7',
  '#C79BF2', // lavender
  '#B059FF', // violet
  '#9532E6',
  '#7911CB', // purple
  '#620DA8',
  '#520A93',
  '#440780', // purpleDeep
]

// Status colours. Mantine's dark scheme writes a colour's text in 4 (the guide's value), fills in 6 (the dark end
// of the guide's gradient), light backgrounds from 9 and light text in 0.
const success: MantineColorsTuple = [
  '#E3FBEF',
  '#C2F5DC',
  '#96EDC3',
  '#78E8B2',
  '#5BE3A1', // success
  '#45CC8D',
  '#2FB57A',
  '#25965F',
  '#1C774C',
  '#24533F',
]

const danger: MantineColorsTuple = [
  '#FFE3E9',
  '#FFC2CE',
  '#FF96AB',
  '#FF7891',
  '#FF5A7A', // danger
  '#E8466A',
  '#C2304F',
  '#A82843',
  '#8C2038',
  '#602640',
]

const warning: MantineColorsTuple = [
  '#FDF7E4',
  '#FAEDC4',
  '#F7E3A6',
  '#F4DA8F',
  '#F2D27A', // warning
  '#D9B65C',
  '#B8963E',
  '#977A30',
  '#765F25',
  '#5C4A2E',
]

export const theme = createTheme({
  colors: { dark, purple, success, danger, warning },
  primaryColor: 'purple',
  primaryShade: 6,
  // The brand gradient: purple to purpleDeep.
  defaultGradient: { from: 'purple.6', to: 'purple.9', deg: 90 },
  fontFamily: "'Lexend Variable', system-ui, -apple-system, 'Segoe UI', sans-serif",
  headings: {
    fontFamily: "'Bricolage Grotesque Variable', 'Lexend Variable', system-ui, sans-serif",
    fontWeight: '760',
    sizes: {
      h1: { fontSize: 'clamp(2rem, 1.4rem + 2.6vw, 3.25rem)', lineHeight: '1.04' },
      h2: { fontSize: '1.5rem', lineHeight: '1.15' },
      h3: { fontSize: '1.1875rem', lineHeight: '1.25' },
      h4: { fontSize: '1rem', lineHeight: '1.3' },
    },
  },
  defaultRadius: 'md',
  radius: { xs: '4px', sm: '6px', md: '10px', lg: '14px', xl: '22px' },
  cursorType: 'pointer',
  components: {
    Badge: Badge.extend({ styles: { root: { textTransform: 'none', fontWeight: 600 } } }),
    // The app's shapes: buttons and chips fully round, selectable chips outlined (filled once chosen).
    Button: Button.extend({ defaultProps: { radius: 'xl' } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { radius: 'xl' } }),
    Chip: Chip.extend({ defaultProps: { variant: 'outline', radius: 'xl' } }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: 'xl' } }),
  },
})

// Links in lavender (the guide's link colour) and form errors in the guide's danger.
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {},
  dark: {
    '--mantine-color-anchor': 'var(--mantine-color-purple-3)',
    '--mantine-color-error': 'var(--mantine-color-danger-4)',
  },
})
