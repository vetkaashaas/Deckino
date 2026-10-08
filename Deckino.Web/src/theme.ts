import { Badge, createTheme, type MantineColorsTuple } from '@mantine/core'

// Deckino's "Foil" direction: a quiet plum-grey interface where card art supplies the colour and the
// brand gradient (purple to pink, from the logo; same values as Deckino.App/src/theme.ts) only appears as foil.

// Mantine's dark scheme reads these slots: 0 text, 2 dimmed text, 3 placeholders, 4 borders,
// 5 hover, 6 surfaces and inputs, 7 page background.
const plum: MantineColorsTuple = [
  '#ECE6F2',
  '#CFC6D8',
  '#A69BB2',
  '#7D7287',
  '#3A2F46',
  '#2A1F36',
  '#1D1428',
  '#130B1B',
  '#0E0814',
  '#050207',
]

const purple: MantineColorsTuple = [
  '#F6E9FD',
  '#E8CDF9',
  '#D6A7F3',
  '#C27DEC',
  '#B05BE6',
  '#A43FDC',
  '#981DCE', // brand purple
  '#8117B0',
  '#6A1291',
  '#520D70',
]

const pink: MantineColorsTuple = [
  '#FDE9F2',
  '#F8C9DE',
  '#F1A2C6',
  '#EA7AAE',
  '#E45C9D',
  '#DE4190', // brand pink
  '#C73580',
  '#A82B6C',
  '#882257',
  '#681842',
]

export const theme = createTheme({
  colors: { dark: plum, purple, pink },
  primaryColor: 'purple',
  primaryShade: 6,
  defaultGradient: { from: 'purple.6', to: 'pink.5', deg: 100 },
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
  },
})
