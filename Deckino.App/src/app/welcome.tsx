import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getTokens } from '@/api/session';
import { Button } from '@/components/ui';
import { setPreferences } from '@/preferences';
import { colors, fonts, gradients, type } from '@/theme';

// Shown on first launch and after signing out (the tabs layout opens it), until "Not now" or signing in. Everything
// that doesn't need an account (scanning, card search) works without one, so this invites rather than blocks.
// One screen, never a scroll: the card fan shrinks to the room the rest leaves.
export default function WelcomeScreen() {
  const router = useRouter();
  const [heroHeight, setHeroHeight] = useState(0);
  // Back here from sign-in or registration, signed in: the welcome is done.
  useFocusEffect(
    useCallback(() => {
      if (getTokens() !== null) router.back();
    }, [router]),
  );
  const notNow = () => {
    setPreferences({ welcomeSeen: true });
    router.back();
  };

  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      <SafeAreaView style={styles.content}>
        <Animated.View entering={FadeIn.duration(600)} style={styles.center}>
          <Image
            source={require('../../assets/images/brand/logo-original.svg')}
            style={styles.logo}
            contentFit="contain"
            accessibilityLabel="Deckino"
          />
        </Animated.View>
        <View style={styles.hero} onLayout={(event) => setHeroHeight(event.nativeEvent.layout.height)}>
          {heroHeight > 0 ? (
            <Animated.View entering={FadeInDown.duration(700).delay(100)}>
              <Fan scale={Math.min(1, heroHeight / FAN_HEIGHT)} />
            </Animated.View>
          ) : null}
        </View>
        <Animated.View entering={FadeInDown.duration(600).delay(250)} style={styles.copy}>
          <Text style={[type.title, styles.text]} accessibilityRole="header">
            Every card, one scan away
          </Text>
          <Text style={[type.body, styles.text, { color: colors.textMuted }]}>
            Scan your Magic cards, sort them into binders and build decks.
          </Text>
        </Animated.View>
        <Animated.View entering={FadeInDown.duration(600).delay(400)} style={styles.actions}>
          <Button label="Create account" onPress={() => router.push('/register')} />
          <Button label="Sign in" variant="secondary" onPress={() => router.push('/sign-in')} />
          <Pressable onPress={notNow} accessibilityRole="button" style={styles.notNow} hitSlop={8}>
            <Text style={styles.link}>Not now</Text>
          </Pressable>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const CARD_WIDTH = 116;
const CARD_HEIGHT = CARD_WIDTH * (88 / 63); // a Magic card's proportions, 63 x 88 mm
const FAN_HEIGHT = CARD_HEIGHT + 40; // the tilted side cards and the glow beneath

// Three cards fanned out like a hand, Deckino's mark on the front one.
function Fan({ scale }: { scale: number }) {
  const mark = require('../../assets/images/brand/icon-white.svg');
  return (
    <View
      style={[styles.fan, { transform: [{ scale }] }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.card, styles.back, { transform: [{ translateX: -74 }, { translateY: 14 }, { rotate: '-14deg' }] }]}>
        <Image source={mark} style={styles.backMark} contentFit="contain" />
      </View>
      <View style={[styles.card, styles.back, { transform: [{ translateX: 74 }, { translateY: 14 }, { rotate: '14deg' }] }]}>
        <Image source={mark} style={styles.backMark} contentFit="contain" />
      </View>
      <View style={[styles.card, styles.front]}>
        <View style={styles.frame}>
          <Image source={mark} style={styles.frontMark} contentFit="contain" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage:
      'radial-gradient(circle at 50% 38%, rgba(152, 29, 206, 0.42) 0%, rgba(11, 6, 16, 0) 58%), ' +
      'radial-gradient(circle at 95% 80%, rgba(222, 65, 144, 0.14) 0%, rgba(11, 6, 16, 0) 45%)',
  },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 12, gap: 24 },
  center: { alignItems: 'center' },
  // The SVG viewBox is 1200 x 396.58, including its own padding.
  logo: { width: 240, height: 240 * (396.58 / 1200) },
  hero: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center' },
  fan: { width: 300, height: FAN_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  card: { position: 'absolute', width: CARD_WIDTH, height: CARD_HEIGHT, borderRadius: 10 },
  back: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(199, 155, 242, 0.35)',
  },
  backMark: { width: 40, height: 40, opacity: 0.25 },
  front: {
    padding: 6,
    experimental_backgroundImage: gradients.brandDiagonal,
    boxShadow: '0 14px 36px rgba(222, 65, 144, 0.45)',
  },
  frame: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.45)',
  },
  frontMark: { width: 60, height: 60 },
  copy: { gap: 8 },
  text: { textAlign: 'center' },
  actions: { gap: 12 },
  notNow: { alignItems: 'center', paddingVertical: 8 },
  link: { fontFamily: fonts.body, fontSize: 15, color: colors.lavender, fontWeight: '600' },
});
