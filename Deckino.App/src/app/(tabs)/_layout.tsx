import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs';
import * as Haptics from 'expo-haptics';
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useSignedIn } from '@/api/session';
import { Icon, type IconName } from '@/components/icon';
import { usePreferences } from '@/preferences';
import { colors, gradients, radius } from '@/theme';

export default function TabsLayout() {
  const router = useRouter();
  // Signed out and no "Look around first" yet (first launch, or after signing out): the welcome screen, once. Only over the
  // tabs: a shared photo or list, or a link (a deck, a password reset) that cold-started the app, comes first, and
  // the welcome follows once that is closed.
  const signedIn = useSignedIn();
  const { welcomeSeen } = usePreferences();
  const welcome = !signedIn && !welcomeSeen;
  const onTabs = useSegments()[0] === '(tabs)';
  const shown = useRef(false);
  useEffect(() => {
    if (!welcome) shown.current = false;
    else if (onTabs && !shown.current) {
      shown.current = true;
      router.push('/welcome');
    }
  }, [welcome, onTabs, router]);

  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, animation: 'fade', sceneStyle: { backgroundColor: colors.background } }}
    >
      {/* The order here is the order in the bar; Scan sits in the middle, raised (TabBar). */}
      {Object.keys(TABS).map((name) => (
        <Tabs.Screen key={name} name={name} />
      ))}
    </Tabs>
  );
}

const TABS: Record<string, { label: string; icon: IconName }> = {
  index: { label: 'Home', icon: 'home' },
  cards: { label: 'Cards', icon: 'web_stories' },
  scan: { label: 'Scan', icon: 'center_focus_weak' },
  collection: { label: 'Collection', icon: 'collections_bookmark' },
  decks: { label: 'Decks', icon: 'style' },
};

// A floating bar with Scan, the app's main action, raised in the middle (AGENTS.md: one main action, big and obvious).
function TabBar({ state, navigation, insets }: BottomTabBarProps) {
  const { haptics } = usePreferences();
  const keyboard = useKeyboardShown();

  // One highlight that slides to the selected tab, under the Scan button on the way past it (and hidden on Scan).
  // withTiming follows the system's reduce-motion setting.
  const [tabWidth, setTabWidth] = useState(0);
  const scanIndex = state.routes.findIndex((route) => route.name === 'scan');
  const position = useSharedValue(state.index);
  useEffect(() => {
    position.value = withTiming(state.index, { duration: 220, easing: Easing.out(Easing.cubic) });
  }, [state.index, position]);
  const highlight = useAnimatedStyle(
    () => ({
      opacity: tabWidth ? interpolate(Math.abs(position.value - scanIndex), [0, 0.6], [0, 1], 'clamp') : 0,
      transform: [{ translateX: position.value * tabWidth + (tabWidth - HIGHLIGHT) / 2 }],
    }),
    [tabWidth, scanIndex],
  );

  // Android resizes the screen for the keyboard, which would lift the bar onto it while typing (a search).
  if (keyboard && Platform.OS === 'android') return null;

  return (
    <View style={[styles.outer, { paddingBottom: insets.bottom + 8 }]}>
      {/* Divided by the drawn tabs: a route without a TABS entry gets no button (and comes after the declared ones). */}
      <View style={styles.bar} accessibilityRole="tablist" onLayout={(event) => setTabWidth((event.nativeEvent.layout.width - 2) / Object.keys(TABS).length)}>
        <Animated.View style={[styles.highlight, highlight]} pointerEvents="none" />
        {state.routes.map((route, index) => {
          const tab = TABS[route.name];
          if (!tab) return null;
          const focused = state.index === index;
          const scan = route.name === 'scan';
          const onPress = () => {
            if (haptics) void (scan ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium) : Haptics.selectionAsync());
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={scan ? tab.label : undefined} // the others' visible label names them (AGENTS.md)
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
            >
              {scan ? (
                // No label: the big glowing button speaks for itself (screen readers still hear "Scan").
                <View style={styles.scan}>
                  <Icon name={tab.icon} size={28} tintColor={colors.text} />
                </View>
              ) : (
                <>
                  <View style={styles.icon}>
                    <Icon name={tab.icon} size={22} tintColor={focused ? colors.text : colors.textDim} />
                  </View>
                  <Text style={[styles.label, focused && styles.labelFocused]} numberOfLines={1}>
                    {tab.label}
                  </Text>
                </>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return; // only Android lifts the bar onto the keyboard (TabBar)
    const show = Keyboard.addListener('keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

const SCAN = 58;
const HIGHLIGHT = 52;
// The icons' distance from the top of the bar, shared by the sliding highlight behind them.
const ICON_TOP = 8;

const styles = StyleSheet.create({
  outer: { backgroundColor: colors.background, paddingHorizontal: 12, paddingTop: 8 },
  bar: {
    flexDirection: 'row',
    minHeight: 64,
    paddingBottom: 8,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4, paddingTop: ICON_TOP },
  pressed: { opacity: 0.8, transform: [{ scale: 0.94 }] },
  icon: { width: HIGHLIGHT, height: 30, alignItems: 'center', justifyContent: 'center' },
  highlight: {
    position: 'absolute',
    top: ICON_TOP,
    left: 0,
    width: HIGHLIGHT,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(121, 17, 203, 0.24)',
  },
  // Pokes a little out of the bar; the background-coloured ring cuts it out of the bar's edge.
  scan: {
    width: SCAN,
    height: SCAN,
    marginTop: -ICON_TOP - 4,
    borderRadius: SCAN / 2,
    borderWidth: 4,
    borderColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    experimental_backgroundImage: gradients.brandDiagonal,
    boxShadow: '0 6px 20px rgba(121, 17, 203, 0.55)',
  },
  label: { color: colors.textDim, fontSize: 11, fontWeight: '500' },
  labelFocused: { color: colors.text, fontWeight: '600' },
});
