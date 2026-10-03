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
