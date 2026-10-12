import { useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useCard, usePriceHistory, usePrintings, type CardDetail, type CardFace } from '@/api/cards';
import { CardImage, formatPrice, ManaCost, RulesText, SetSymbol } from '@/components/card-visuals';
import { PriceChart } from '@/components/price-chart';
import { Button, ErrorState, Skeleton } from '@/components/ui';
import { ambient, colors, fonts, radius, type } from '@/theme';

export default function CardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const card = useCard(id);

  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      <Stack.Screen options={{ title: card.data?.name ?? '' }} />
      {card.isPending ? (
        <View style={styles.content}>
          <Skeleton style={styles.heroSkeleton} />
          <Skeleton style={{ height: 28, width: '60%' }} />
          <Skeleton style={{ height: 80 }} />
        </View>
      ) : card.isError ? (
        <ErrorState message={card.error.message} onRetry={() => void card.refetch()} />
      ) : (
        <CardDetails card={card.data} />
      )}
    </View>
  );
}

function CardDetails({ card }: { card: CardDetail }) {
  // Back to the front when another printing is shown (the page stays, so the scroll position does too).
  const [turned, setTurned] = useState({ id: card.id, face: 0 });
  const face = turned.id === card.id ? turned.face : 0;
  const turn = () => setTurned({ id: card.id, face: (face + 1) % card.images.length });
  const faces: CardFace[] = card.faces.length > 0 ? card.faces : [card];
  const prices = usePriceHistory(card.id);
  const year = card.releasedAt.slice(0, 4);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable
        onPress={turn}
        disabled={card.images.length < 2}
        accessibilityRole={card.images.length > 1 ? 'button' : 'image'}
        accessibilityLabel={card.images.length > 1 ? `${card.name}, turn over` : card.name}
        style={styles.hero}
      >
        <CardImage uri={card.images[face] ?? card.image} name={card.name} transition={250} />
      </Pressable>
      {card.images.length > 1 ? (
        <Button
          label="Turn over"
          variant="secondary"
          icon={{ ios: 'arrow.triangle.2.circlepath', android: 'flip' }}
          onPress={turn}
          style={styles.turn}
        />
      ) : null}

      {faces.map((side, index) => (
        // Reversible cards have two faces with the same name.
        <View key={index} style={styles.face}>
          <View style={styles.nameRow}>
            <Text style={[type.heading, styles.name]} accessibilityRole="header">
              {side.name}
            </Text>
            <ManaCost cost={side.manaCost} />
          </View>
          {side.typeLine ? <Text style={type.label}>{side.typeLine}</Text> : null}
          {side.oracleText ? <RulesText text={side.oracleText} /> : null}
          {side.flavorText ? <Text style={[type.body, styles.flavor]}>{side.flavorText}</Text> : null}
          {side.power !== null && side.toughness !== null ? (
            <Text style={styles.stat}>
              {side.power}/{side.toughness}
            </Text>
          ) : side.loyalty !== null ? (
            <Text style={styles.stat}>Loyalty {side.loyalty}</Text>
          ) : null}
        </View>
      ))}

      <View style={styles.panel}>
        <View style={styles.setRow}>
          <SetSymbol setCode={card.setCode} rarity={card.rarity} />
          <View style={styles.flex}>
            <Text style={[type.body, { fontWeight: '500' }]}>{card.setName}</Text>
            <Text style={type.label}>
              {card.setCode.toUpperCase()} #{card.collectorNumber} · {capitalize(card.rarity)} · {year}
            </Text>
          </View>
        </View>
        {card.artist ? <Text style={type.label}>Illustrated by {card.artist}</Text> : null}
      </View>

      <View style={styles.panel}>
        <View style={styles.prices}>
          <Price label="USD" value={formatPrice(card.prices.usd, 'usd')} />
          <Price label="USD foil" value={formatPrice(card.prices.usdFoil, 'usd')} />
          <Price label="EUR" value={formatPrice(card.prices.eur, 'eur')} />
          <Price label="EUR foil" value={formatPrice(card.prices.eurFoil, 'eur')} />
        </View>
        {prices.data ? <PriceChart points={prices.data} /> : <Skeleton style={{ height: 120 }} />}
      </View>

      <Printings card={card} />
    </ScrollView>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.price}>
      <Text style={type.caption}>{label}</Text>
      <Text style={styles.priceValue}>{value}</Text>
    </View>
  );
}

// Every printing as a picture, newest first; tapping one shows that printing here.
function Printings({ card }: { card: CardDetail }) {
  const router = useRouter();
  const printings = usePrintings(card.id);
  if (!printings.data || printings.data.length < 2) return null;
  return (
    <View style={styles.printings}>
      <Text style={type.heading}>{printings.data.length} printings</Text>
      <FlatList
        horizontal
        data={printings.data}
        keyExtractor={(printing) => printing.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.printingList}
        initialScrollIndex={Math.max(0, printings.data.findIndex((p) => p.id === card.id))}
        getItemLayout={(_, index) => ({ length: PRINTING_WIDTH + 12, offset: (PRINTING_WIDTH + 12) * index, index })}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.setParams({ id: item.id })}
            accessibilityRole="button"
            accessibilityState={{ selected: item.id === card.id }}
            accessibilityLabel={`${item.setName} ${item.releasedAt.slice(0, 4)}, ${formatPrice(item.usd, 'usd')}`}
            style={[styles.printing, item.id === card.id && styles.printingSelected]}
          >
            <CardImage uri={item.image} name={item.setName} />
            <Text style={type.caption} numberOfLines={1}>
              {item.setCode.toUpperCase()} · {item.releasedAt.slice(0, 4)}
            </Text>
            <Text style={type.label}>{formatPrice(item.usd, 'usd')}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const PRINTING_WIDTH = 104;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  content: { padding: 20, gap: 16, paddingBottom: 48 },
  hero: { width: '72%', alignSelf: 'center', boxShadow: '0 16px 40px rgba(152, 29, 206, 0.35)', borderRadius: radius.sm },
  heroSkeleton: { width: '72%', alignSelf: 'center', aspectRatio: 63 / 88 },
  turn: { alignSelf: 'center', minHeight: 44 },
  face: { gap: 8 },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  name: { flex: 1 },
  flavor: { fontStyle: 'italic', color: colors.textMuted },
  stat: { fontFamily: fonts.heading, fontSize: 18, fontWeight: '700', color: colors.text, alignSelf: 'flex-end' },
  panel: {
    gap: 12,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  setRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  prices: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
  price: { width: '50%', gap: 2 },
  priceValue: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '700', color: colors.text },
  printings: { gap: 12 },
  printingList: { gap: 12 },
  printing: { width: PRINTING_WIDTH, gap: 4, padding: 4, borderRadius: radius.md, borderWidth: 2, borderColor: 'transparent' },
  printingSelected: { borderColor: colors.pink },
});
