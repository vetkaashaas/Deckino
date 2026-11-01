import { useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { colors, fonts, gradients } from '@/theme';

// Views side by side, each the screen's width (Home's Rising/Falling, Collection's Binders/Prices, Decks' Yours/Public):
// a sideways drag moves them with the finger and snaps to one, and `x` follows it so the tabs can.

/** Where the pager is scrolled to (`x`, for its tabs), starting on `page`. */
export function usePager(page: number) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(page * width);
  const onScroll = useAnimatedScrollHandler((event) => {
    x.value = event.contentOffset.x;
  });
  return { x, onScroll };
}

export function Pager({
  page,
  onPage,
  position,
  onDragStart,
  style,
  children,
}: {
  page: number;
  onPage: (page: number) => void;
  position: ReturnType<typeof usePager>;
  onDragStart?: () => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode[];
}) {
  const { width } = useWindowDimensions();
  const pager = useAnimatedRef<Animated.ScrollView>();
  // A tab (or a link) changes the page: the pager goes there.
  useEffect(() => {
    pager.current?.scrollTo({ x: page * width, animated: true });
  }, [page, width, pager]);
  return (
    <Animated.ScrollView
      ref={pager}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      onScroll={position.onScroll}
      scrollEventThrottle={16}
      onLayout={() => pager.current?.scrollTo({ x: page * width, animated: false })} // opens on `page`
      onScrollBeginDrag={onDragStart}
      onMomentumScrollEnd={(event) => onPage(Math.round(event.nativeEvent.contentOffset.x / width))}
      style={style}
    >
      {children.map((child, i) => (
        <View key={i} style={{ width }}>
          {child}
        </View>
      ))}
    </Animated.ScrollView>
  );
}

/** The row of tabs over a pager, with room on the right for something of the page's own (a filter, a New link). */
export function PagerTabs({ children }: { children: ReactNode }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {children}
    </View>
  );
}

// Bright with its line while its page is on screen, dimming as the next one slides in.
export function PagerTab({ label, at, selected, x, onPress }: { label: string; at: number; selected: boolean; x: SharedValue<number>; onPress: () => void }) {
  const { width } = useWindowDimensions();
  const text = useAnimatedStyle(() => ({
    color: interpolateColor(x.value / width, [at - 1, at, at + 1], [colors.textMuted, colors.text, colors.textMuted]),
  }));
  const line = useAnimatedStyle(() => ({
    opacity: interpolate(x.value / width, [at - 1, at, at + 1], [0, 1, 0], Extrapolation.CLAMP),
  }));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      hitSlop={8}
      style={({ pressed }) => [styles.tab, pressed && { opacity: 0.7 }]}
    >
      <Animated.Text style={[styles.label, text]}>{label}</Animated.Text>
      <Animated.View style={[styles.line, line]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    marginHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  tab: { paddingTop: 8, gap: 8 },
  label: { fontFamily: fonts.body, fontSize: 16, fontWeight: '600', color: colors.textMuted, paddingHorizontal: 2 },
  line: { height: 3, borderRadius: 2, marginBottom: -1, experimental_backgroundImage: gradients.brand }, // over the row's own line
});
