// Deckino brand tokens. Purple and pink come from the client logo gradient.
export const colors = {
  purple: '#981DCE',
  pink: '#DE4190',
  lavender: '#C79BF2',

  background: '#0B0610',
  surface: '#160D1F',
  glass: 'rgba(20, 11, 28, 0.78)',
  glassBorder: 'rgba(255, 255, 255, 0.10)',

  text: '#FFFFFF',
  textMuted: '#B9AFC4',
  textDim: '#7D7287',

  success: '#5BE3A1',
  danger: '#FF5A7A',
} as const;

export const gradients = {
  brand: `linear-gradient(90deg, ${colors.purple} 0%, ${colors.pink} 100%)`,
  brandDiagonal: `linear-gradient(135deg, ${colors.purple} 0%, ${colors.pink} 100%)`,
  success: `linear-gradient(135deg, #2FB57A 0%, ${colors.success} 100%)`,
  danger: `linear-gradient(135deg, #C2304F 0%, ${colors.danger} 100%)`,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 22,
  pill: 999,
} as const;

// Embedded by the expo-font plugin (app.json): Lexend for text, Bricolage Grotesque for headings, as on the website.
export const fonts = {
  body: 'Lexend',
  heading: 'Bricolage',
} as const;

export const type = {
  title: { fontFamily: fonts.heading, fontSize: 28, fontWeight: '800', color: colors.text },
  heading: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '700', color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22, color: colors.text },
  label: { fontFamily: fonts.body, fontSize: 13, fontWeight: '500', color: colors.textMuted },
  caption: { fontFamily: fonts.body, fontSize: 12, color: colors.textDim },
} as const;

// Set symbols in Scryfall's rarity colours.
export const rarityColors: Record<string, string> = {
  common: '#D8D2DE',
  uncommon: '#A9C4D6',
  rare: '#E3C46D',
  mythic: '#F07A2E',
  special: '#B28FE0',
  bonus: '#B28FE0',
};

// Every page's ambient glow: the website's restrained orbs.
export const ambient =
  'radial-gradient(circle at 15% 0%, rgba(152, 29, 206, 0.28) 0%, rgba(11, 6, 16, 0) 55%), ' +
  'radial-gradient(circle at 100% 30%, rgba(222, 65, 144, 0.14) 0%, rgba(11, 6, 16, 0) 45%)';
