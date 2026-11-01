import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Stack, useLocalSearchParams, useNavigation, type NativeStackNavigationProp } from 'expo-router';

import {
  prefetchPrinting,
  useCard,
  usePriceHistory,
  usePrintings,
  type CardDetail,
  type CardFace,
  type Printing,
} from '@/api/cards';
import { finishLabel } from '@/components/card-sheet';
import { CardImage, formatPrice, ManaCost, RulesText, SetSymbol } from '@/components/card-visuals';
import { PriceChart } from '@/components/price-chart';
import { PrintingButton } from '@/components/printing-picker';
import { Backdrop, Button, ErrorState, Skeleton } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

export default function CardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const card = useCard(id);

  return (
    <View style={styles.screen}>
      <Backdrop />
      <Stack.Screen options={{ title: card.data?.name ?? '' }} />
      {card.isPending ? (
        <View style={styles.content}>
          <Skeleton style={styles.heroSkeleton} />
          <Skeleton style={{ height: 28, width: '60%' }} />
          <Skeleton style={{ height: 80 }} />
        </View>
      ) : card.isError && !card.data ? (
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
  const { currency } = usePreferences();
  const navigation = useNavigation<NativeStackNavigationProp<{ 'card/[id]': { id: string } }>>();
  const priced = (
    [
      [finishLabel('nonfoil'), currency === 'usd' ? card.prices.usd : card.prices.eur],
      [finishLabel('foil'), currency === 'usd' ? card.prices.usdFoil : card.prices.eurFoil],
    ] as const
  ).filter(([, value]) => value !== null);

  const showPrinting = (id: string) => navigation.setParams({ id });

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Carousel card={card} face={face} onTurn={turn} onShow={showPrinting} />
      {card.images.length > 1 ? (
        <Button
          label="Turn over"
          variant="secondary"
          icon="flip"
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
        <View style={styles.setInfo}>
          <View style={styles.setRow}>
            <Text style={[type.body, styles.setName]}>{card.setName}</Text>
            {/* The picked printing replaces this one on the page (not a new page, so Back still leaves the card). */}
            <PrintingButton id={card.id} compact onChoose={(printing) => showPrinting(printing.id)} />
          </View>
          <SetSymbol
            setCode={card.setCode}
            rarity={card.rarity}
            withCode
            detail={`#${card.collectorNumber} · ${capitalize(card.rarity)} · ${year}`}
          />
          {card.artist ? <Text style={type.label}>Illustrated by {card.artist}</Text> : null}
        </View>
        {/* Only the prices this printing has, in the chosen currency; none at all, no price section. */}
        {priced.length > 0 ? (
          <>
            <View style={styles.rule} />
            <View style={styles.prices}>
              {priced.map(([label, value]) => (
                <Price key={label} label={label} value={formatPrice(value, currency)} />
              ))}
            </View>
            {prices.data ? (
              <PriceChart points={prices.data} currency={currency} />
            ) : (
              <Skeleton style={{ height: 120 }} />
            )}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

/**
 * The card's picture, with its other printings beside it (newest first) to swipe through: the one a swipe lands on is
 * shown on the page. The neighbours fade and shrink with the swipe itself (on the UI thread), so it follows the finger.
 * Tapping the middle one turns a two-faced card; tapping a neighbour brings it in. The "4 printings" grid does the
 * same, for jumping further.
 */
function Carousel({
  card,
  face,
  onTurn,
  onShow,
}: {
  card: CardDetail;
  face: number;
  onTurn: () => void;
  onShow: (id: string) => void;
}) {
  const { id } = useLocalSearchParams<{ id: string }>(); // ahead of `card`, which stays until the new one arrives
  const printings = usePrintings(card.id).data ?? [];
  const { width } = useWindowDimensions();
  const list = useRef<Animated.FlatList<Printing>>(null);
  const itemWidth = Math.round(width * 0.64); // the neighbours peek in at the sides
  const interval = itemWidth + GAP;
  const index = printings.findIndex((p) => p.id === id);
  const scrollX = useSharedValue(Math.max(0, index) * interval);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollX.value = event.contentOffset.x;
    },
  });

  // The printing in the middle: set as a swipe lands, and when the grid picks one.
  const [shown, setShown] = useState(index);
  const [lastIndex, setLastIndex] = useState(index);
  if (index !== lastIndex) {
    setLastIndex(index);
    setShown(index);
  }
  const centered = useRef(index);
  const spacing = useRef(interval);
  useEffect(() => {
    // Picked in the grid, the list just arrived, or the screen got wider: bring it to the middle. A swipe has put
    // it there already.
    if (index >= 0 && (centered.current !== index || spacing.current !== interval)) {
      centered.current = index;
      spacing.current = interval;
      scrollX.value = index * interval;
      list.current?.scrollToOffset({ offset: index * interval, animated: false });
    }
  }, [index, interval, scrollX]);
  useEffect(() => {
    // The neighbours of the middle one, so the next swipe lands on a page that's already there.
    for (const near of [printings[shown - 1], printings[shown + 1]]) if (near) prefetchPrinting(near.id, printings);
  }, [shown, printings]);

  const turnable = card.images.length > 1;
  if (printings.length < 2 || index < 0) {
    return (
      <Pressable
        onPress={onTurn}
        disabled={!turnable}
        accessibilityRole={turnable ? 'button' : 'image'}
        accessibilityLabel={turnable ? `${card.name}, turn over` : card.name}
        style={[styles.hero, styles.single]}
      >
        <CardImage uri={card.images[face] ?? card.image} name={card.name} transition={250} />
      </Pressable>
    );
  }

  const show = (next: number) => {
    centered.current = next;
    setShown(next);
    if (printings[next].id !== id) onShow(printings[next].id);
  };

  return (
    <View style={styles.carousel}>
      <Animated.FlatList
        ref={list}
        horizontal
        data={printings}
        extraData={`${shown} ${card.id} ${face}`} // the items' labels and pictures depend on these, not only on `data`
        keyExtractor={(p) => p.id}
        showsHorizontalScrollIndicator={false}
        snapToInterval={interval}
        decelerationRate="fast" // a flick carries on through several printings, then snaps to one
        initialScrollIndex={index}
        // ponytail: offsets leave out the side padding, so initialScrollIndex and the snap points land a printing in
        // the middle rather than at the left edge
        getItemLayout={(_, i) => ({ length: interval, offset: interval * i, index: i })}
        contentContainerStyle={[styles.carouselItems, { paddingHorizontal: (width - itemWidth) / 2 }]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(event) =>
          show(Math.min(printings.length - 1, Math.max(0, Math.round(event.nativeEvent.contentOffset.x / interval))))
        }
        renderItem={({ item, index: i }) => {
          const middle = i === shown;
          const current = item.id === card.id; // its details are on the page (its faces turn)
          return (
            <CarouselCard
              index={i}
              interval={interval}
              scrollX={scrollX}
              width={itemWidth}
              uri={item.image}
              sharp={current ? card.images[face] : undefined}
              name={card.name}
              printing={item}
              place={`${i + 1} of ${printings.length}`}
              label={
                middle
                  ? `${card.name}, ${item.setName}${current && turnable ? ', turn over' : ''}`
                  : `${item.setName} #${item.collectorNumber}, show this printing`
              }
              disabled={middle && !(current && turnable)}
              onPress={() => {
                if (middle) {
                  onTurn();
                } else {
                  list.current?.scrollToOffset({ offset: i * interval, animated: true });
                  show(i);
                }
              }}
            />
          );
        }}
      />
    </View>
  );
}

function CarouselCard({
  index,
  interval,
  scrollX,
  width,
  uri,
  sharp,
  name,
  printing,
  place,
  label,
  disabled,
  onPress,
}: {
  index: number;
  interval: number;
  scrollX: SharedValue<number>;
  width: number;
  uri: string | null;
  /** The page's own picture (sharper, or the face turned up), laid over the list's once it has loaded. */
  sharp?: string;
  name: string;
  printing: Printing;
  /** "3 of 4": with the set under each card, it moves with the swipe and is right before it lands. */
  place: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  // 0 in the middle, 1 a whole place to the side.
  const look = useAnimatedStyle(() => {
    const away = Math.min(1, Math.abs(scrollX.value / interval - index));
    return { opacity: 1 - 0.55 * away, transform: [{ scale: 1 - 0.08 * away }] };
  });
  // The caption is only the middle card's: the neighbours' would peek in, cut off, at the edges.
  const captionLook = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, 1.5 * Math.abs(scrollX.value / interval - index)),
  }));
  return (
    <Animated.View style={[{ width }, look]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole={disabled ? 'image' : 'button'}
        accessibilityLabel={label}
        style={styles.hero}
      >
        {/* The list's picture stays underneath, so landing on a card never blanks it while the sharper one loads. */}
        <CardImage uri={uri} name={name} transition={0} />
        {sharp ? <CardImage uri={sharp} name={name} transition={200} style={styles.sharp} /> : null}
      </Pressable>
      <Animated.View style={[styles.caption, captionLook]}>
        <SetSymbol
          setCode={printing.setCode}
          rarity={printing.rarity}
          size={28}
          withCode
          detail={`#${printing.collectorNumber} · ${place}`}
        />
      </Animated.View>
    </Animated.View>
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

const GAP = 12;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 16, paddingBottom: 48 },
  hero: { boxShadow: '0 16px 40px rgba(121, 17, 203, 0.35)', borderRadius: radius.sm },
  single: { width: '72%', alignSelf: 'center' },
  // Full width (out of the page's padding), with room for the cards' glow, which a horizontal list would clip.
  carousel: { marginHorizontal: -20, marginTop: -12, gap: 4 },
  carouselItems: { gap: GAP, paddingTop: 12, paddingBottom: 24 },
  caption: { alignItems: 'center', marginTop: 14 },
  sharp: { ...StyleSheet.absoluteFill, backgroundColor: 'transparent' },
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
  setInfo: { gap: 6 },
  setRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  setName: { flex: 1, fontWeight: '500' },
  rule: { height: 1, backgroundColor: colors.glassBorder },
  prices: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
  price: { width: '50%', gap: 2 },
  priceValue: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '700', color: colors.text },
});
