import {
  ActionIcon,
  Badge,
  Button,
  Card,
  createTheme,
  Modal,
  Paper,
  Progress,
  Switch,
  Tooltip,
  type MantineColorsTuple,
} from '@mantine/core'

// The app's tokens (STYLEGUIDE.md, Deckino.App/src/theme.ts): one deep purple, violet for what must stand out on the
// dark background, lavender for calm accents. Only token colours: Mantine's shade slots reuse them.
export const colors = {
  purple: '#7911CB',
  purpleDeep: '#440780',
  violet: '#B059FF',
  lavender: '#C79BF2',
  background: '#0B0610',
  surface: '#160D1F',
  glass: 'rgba(20, 11, 28, 0.78)',
  glassBorder: 'rgba(255, 255, 255, 0.10)',
  tint: 'rgba(121, 17, 203, 0.18)',
  text: '#FFFFFF',
  textMuted: '#B9AFC4',
  textDim: '#7D7287',
  success: '#5BE3A1',
  danger: '#FF5A7A',
  warning: '#F2D27A',
} as const

export const gradients = {
  brand: `linear-gradient(90deg, ${colors.purple} 0%, ${colors.purpleDeep} 100%)`,
  brandDiagonal: `linear-gradient(135deg, ${colors.purple} 0%, ${colors.purpleDeep} 100%)`,
}

// Light to dark: lavender, violet, purple, purpleDeep. Filled = 6, hover = 7, light text = 4.
const purple: MantineColorsTuple = [
  colors.lavender,
  colors.lavender,
  colors.lavender,
  colors.violet,
  colors.violet,
  colors.violet,
  colors.purple,
  colors.purple,
  colors.purpleDeep,
  colors.purpleDeep,
]

// Mantine's dark scheme reads these slots: 0 text, 2 dimmed text, 3 placeholders, 4 borders, 5 hover,
// 6 surfaces and inputs, 7 page background.
const dark: MantineColorsTuple = [
  colors.text,
  colors.textMuted,
  colors.textMuted,
  colors.textDim,
  colors.glassBorder,
  colors.tint,
  colors.surface,
  colors.background,
  colors.background,
  colors.background,
]

const single = (color: string): MantineColorsTuple =>
  [color, color, color, color, color, color, color, color, color, color]

export const theme = createTheme({
  colors: { dark, purple, green: single(colors.success), red: single(colors.danger), yellow: single(colors.warning) },
  primaryColor: 'purple',
  primaryShade: 6,
  defaultGradient: { from: colors.purple, to: colors.purpleDeep, deg: 90 },
  fontFamily: "'Lexend Variable', system-ui, 'Segoe UI', sans-serif",
  fontFamilyMonospace: "'Cascadia Mono', Consolas, ui-monospace, monospace",
  headings: {
    fontFamily: "'Bricolage Grotesque Variable', 'Lexend Variable', system-ui, sans-serif",
    fontWeight: '800',
    sizes: {
      h1: { fontSize: '28px', lineHeight: '1.15' },
      h2: { fontSize: '20px', lineHeight: '1.25' },
      h3: { fontSize: '16px', lineHeight: '1.3' },
    },
  },
  fontSizes: { xs: '12px', sm: '13px', md: '15px', lg: '17px', xl: '20px' },
  radius: { xs: '10px', sm: '10px', md: '14px', lg: '22px', xl: '999px' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    Button: Button.extend({ defaultProps: { radius: 'xl' }, styles: { root: { fontWeight: 600 } } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { radius: 'xl' } }),
    Badge: Badge.extend({ defaultProps: { radius: 'xl' }, styles: { root: { textTransform: 'none', fontWeight: 600 } } }),
    Card: Card.extend({ defaultProps: { radius: 'lg', padding: 'lg' } }),
    Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
    Modal: Modal.extend({ defaultProps: { radius: 'lg', centered: true, overlayProps: { blur: 3 } } }),
    Progress: Progress.extend({ defaultProps: { radius: 'xl' } }),
    Switch: Switch.extend({ defaultProps: { color: 'purple' } }),
    Tooltip: Tooltip.extend({ defaultProps: { openDelay: 400, multiline: true, maw: 320, withArrow: true } }),
  },
})
