# Deckino style guide

The brand's colours, type and shapes, for the app and the website. This file is the reference; the app's copy lives in
`Deckino.App/src/theme.ts` (its Profile → Style guide screen, in dev and E2E builds, shows every component in its
states), the website's in `Deckino.Web/src/theme.ts`. Change a value here first, then in both.

## Colours

The brand is one deep, vivid purple, taken from the app icon. No pink: it was the old brand (`#981DCE` → `#DE4190`).

### Brand

| Token | Value | Use |
| --- | --- | --- |
| `purple` | `#7911CB` | The brand colour. Fills: main buttons, the active tab, toggles, the front of the welcome card fan. |
| `purpleDeep` | `#440780` | The dark end of the brand gradient. Never alone on the dark background (it disappears there). |
| `violet` | `#B059FF` | The bright accent, for what must stand out on the dark background: selected borders, the scanner's "reading" frame, "on your wishlist", the wordmark's light end. 5:1 on `background`. |
| `lavender` | `#C79BF2` | Links, icons beside list rows, counts, spinners. Calmer than violet. |

### Surfaces and text

| Token | Value | Use |
| --- | --- | --- |
| `background` | `#0B0610` | Every page. The app is dark only. |
| `surface` | `#160D1F` | Cards, rows, sheets on the background. |
| `glass` | `rgba(20, 11, 28, 0.78)` | Bars and sheets over content or the camera. |
| `glassBorder` | `rgba(255, 255, 255, 0.10)` | Hairlines and outlines. |
| `text` | `#FFFFFF` | Headings and body text. |
| `textMuted` | `#B9AFC4` | Secondary text, labels. |
| `textDim` | `#7D7287` | Captions, inactive tab labels. |

### Status

| Token | Value | Use |
| --- | --- | --- |
| `success` | `#5BE3A1` | Done, identified, owned. |
| `danger` | `#FF5A7A` | Errors, delete. |
| `warning` | `#F2D27A` | Something to check, not an error. |

Set symbols use Scryfall's rarity colours: common `#D8D2DE`, uncommon `#A9C4D6`, rare `#E3C46D`, mythic `#F07A2E`,
special and bonus `#B28FE0`.

### Tints

Brand tints are the brand colours at low opacity over the background, not new colours:

- Icon tiles and info boxes: `rgba(121, 17, 203, 0.18)` (purple), a little stronger (`0.22`–`0.35`) for a selected item.
- Coloured shadows under brand fills: `rgba(121, 17, 203, 0.40)`.

## Gradients and glows

| Name | Value | Use |
| --- | --- | --- |
| Brand | `linear-gradient(90deg, #7911CB, #440780)` | Main buttons, bars. |
| Brand diagonal | `linear-gradient(135deg, #7911CB, #440780)` | Tiles and cards (the welcome card, scan badges). |
| Wordmark | `linear-gradient(90deg, #B059FF, #7911CB)` | The DECKINO logo only: the brand gradient is too dark for type on the background. |
| Success | `linear-gradient(135deg, #2FB57A, #5BE3A1)` | |
| Danger | `linear-gradient(135deg, #C2304F, #FF5A7A)` | |

Every page has a quiet ambient glow behind it:

```css
radial-gradient(circle at 15% 0%, rgba(121, 17, 203, 0.28) 0%, rgba(11, 6, 16, 0) 55%),
radial-gradient(circle at 100% 30%, rgba(176, 89, 255, 0.14) 0%, rgba(11, 6, 16, 0) 45%)
```

## Logo and icon

- **Wordmark**: `Deckino.App/assets/images/brand/logo-original.svg`, filled with the wordmark gradient.
  `logo-white.svg` is the all-white version, for over the camera (the Scan screen), photos or brand fills.
- **Mark** (the four-pointed star): `icon-white.svg`, always white, on a brand fill or as a faint watermark.
- **App icon**: the white mark on `linear-gradient(135deg, #7911CB, #440780)` with a soft `#8D2BDB` glow behind the
  mark (centre at 50% across, 45% down, fading out by 60% of the way to the far corner). Files:
  `assets/images/icon.png`, `android-icon-background.png` (the background alone) and `android-icon-foreground.png`
  (the mark, with its shadow). The splash screen and the adaptive icon's fallback use `#7911CB` (`app.json`).

## Type

| Role | Font | App size / weight |
| --- | --- | --- |
| Title | Bricolage Grotesque | 28 / 800 |
| Heading | Bricolage Grotesque | 20 / 700 |
| Body | Lexend | 15 / 400, line height 22 |
| Label | Lexend | 13 / 500, `textMuted` |
| Caption | Lexend | 12 / 400, `textDim` |

Links and text buttons: Lexend 15 / 600–700 in `lavender`.

## Shape

Corner radius: small `10`, medium `14`, large `22`, pills and buttons fully round. Cards in pictures keep a Magic
card's proportions, 63 × 88.

## Words

Plain words, no internals, codes or scores; errors say what happened and what to do. See "Simplicity comes first" in
`Deckino.App/AGENTS.md`.
