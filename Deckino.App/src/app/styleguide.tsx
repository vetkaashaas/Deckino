import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CardSummary, PricePoint } from '@/api/cards';
import { CardImage, CardTile, ManaCost, RulesText, SetSymbol } from '@/components/card-visuals';
import { PriceChart } from '@/components/price-chart';
import { ScanResultCard } from '@/components/scan-result-card';
import { Button, Chip, EmptyState, ErrorState, ListRow, Skeleton } from '@/components/ui';
import { colors, radius, rarityColors, type } from '@/theme';

// Every component in its states (dev and E2E builds only): the reference later screens are built from, and the
// screens Maestro photographs at a small and a large phone size.

const bolt: CardSummary = {
  id: '0852f9f3-d7ef-4d31-93e3-93bc7c5a4ec9',
  name: 'Lightning Bolt',
  manaCost: '{R}',
  manaValue: 1,
  typeLine: 'Instant',
  setCode: 'fdc',
  setName: 'Foundations Commander',
  rarity: 'uncommon',
  image: 'https://cards.scryfall.io/normal/front/0/8/0852f9f3-d7ef-4d31-93e3-93bc7c5a4ec9.jpg',
  smallImage: null,
  usd: 1.2,
  eur: 0.95,
};

// 90 days of a gently rising price.
const history: PricePoint[] = Array.from({ length: 90 }, (_, day) => ({
  date: `day-${day}`,
  usd: Math.round((1 + day / 120 + Math.sin(day / 6) * 0.08) * 100) / 100,
  usdFoil: null,
  eur: null,
  eurFoil: null,
}));

const noop = () => {};

export default function StyleGuideScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content} accessibilityLabel="Style guide">
      <Section title="Colours">
        <View style={styles.wrap}>
          {Object.entries(colors).map(([name, value]) => (
            <View key={name} style={styles.swatch}>
              <View style={[styles.swatchColor, { backgroundColor: value }]} />
              <Text style={type.caption}>{name}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Type">
        <Text style={type.title}>Title</Text>
        <Text style={type.heading}>Heading</Text>
        <Text style={type.body}>Body text, in Lexend.</Text>
        <Text style={type.label}>Label</Text>
        <Text style={type.caption}>Caption</Text>
      </Section>

      <Section title="Buttons and chips">
        <Button label="Primary" onPress={noop} icon={{ ios: 'viewfinder', android: 'document_scanner' }} />
        <Button label="Secondary" variant="secondary" onPress={noop} />
        <View style={styles.wrap}>
          <Chip label="Rarity" selected={false} onPress={noop} />
          <Chip label="Mythic" selected onPress={noop} />
        </View>
      </Section>

      <Section title="Cards">
        <View style={styles.row}>
          <CardTile card={bolt} onPress={noop} />
          <CardTile card={{ ...bolt, id: 'no-image', name: 'Card without an image', image: null, usd: null }} onPress={noop} />
        </View>
        <View style={styles.row}>
          <View style={styles.flex}>
            <CardImage uri={bolt.image} name={bolt.name} />
          </View>
          <View style={styles.flex}>
            <Skeleton style={styles.cardSkeleton} />
          </View>
        </View>
      </Section>

      <Section title="Symbols">
        <View style={styles.wrap}>
          <ManaCost cost="{2}{W}{U}{B}{R}{G}{C}" />
          <ManaCost cost="{X}{W/U}{2/B}{G/P}" />
        </View>
        <RulesText text="{T}: Add {R}. Lightning Bolt deals 3 damage to any target." />
        <View style={styles.wrap}>
          {Object.keys(rarityColors).map((rarity) => (
            <View key={rarity} style={styles.symbol}>
              <SetSymbol setCode="m11" rarity={rarity} size={28} />
              <Text style={type.caption}>{rarity}</Text>
            </View>
          ))}
          <View style={styles.symbol}>
            <SetSymbol setCode="no-such-set" rarity="rare" size={28} />
            <Text style={type.caption}>fallback</Text>
          </View>
        </View>
      </Section>

      <Section title="Prices">
        <PriceChart points={history} />
        <PriceChart points={history.slice(0, 1)} />
      </Section>

      <Section title="Rows">
        <ListRow
          leading={<CardImage uri={bolt.image} name={bolt.name} style={styles.thumbnail} />}
          title="Lightning Bolt"
          detail="Foundations Commander · FDC #149"
          trailing={<Text style={type.label}>$1.20</Text>}
          onPress={noop}
        />
        <ListRow title="Plain row" detail="With a detail line" />
      </Section>

      <Section title="Scan results">
        <ScanResultCard tone="idle" title="Scanning for cards…" detail="Hold a card inside the frame" />
        <ScanResultCard tone="detecting" title="Identifying card…" detail="Reading the artwork…" confidence={0.4} />
        <ScanResultCard
          tone="locked"
          title="Lightning Bolt"
          detail="Foundations Commander · $1.20"
          confidence={0.92}
          action={{ label: 'View card', onPress: noop }}
        />
        <ScanResultCard tone="rejected" title="No safe card quad" detail="too close to the edge" />
      </Section>

      <Section title="States">
        <EmptyState
          icon={{ ios: 'magnifyingglass', android: 'search_off' }}
          title="No cards match"
          body="Check the spelling, or loosen a filter."
          action={{ label: 'Clear filters', onPress: noop }}
        />
        <ErrorState message="Can't reach Deckino. Check your connection and try again." onRetry={noop} />
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={type.heading} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 28, paddingBottom: 64 },
  section: { gap: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' },
  row: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  swatch: { width: 72, gap: 4 },
  swatchColor: { height: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.glassBorder },
  symbol: { alignItems: 'center', gap: 4, width: 76 },
  cardSkeleton: { aspectRatio: 63 / 88 },
  thumbnail: { width: 44 },
});
