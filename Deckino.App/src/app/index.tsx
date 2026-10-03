import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { colors, gradients, radius } from '@/theme';

const TIPS = [
  {
    icon: { ios: 'rectangle.portrait', android: 'style' },
    title: 'Fill the frame',
    detail: 'Line the card up inside the guide corners.',
  },
  {
    icon: { ios: 'sun.max', android: 'light_mode' },
    title: 'Good light, no glare',
    detail: 'Tilt the card slightly if the foil reflects.',
  },
  {
    icon: { ios: 'checkmark.seal', android: 'verified' },
    title: 'Hold steady',
    detail: 'The name locks in after a few agreeing frames.',
  },
] as const;

export default function HomeScreen() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <View style={styles.glow} pointerEvents="none" />
      <SafeAreaView style={styles.content} edges={['top']}>
        <View style={styles.hero}>
          <Image
            source={require('../../assets/images/brand/logo-original.svg')}
            style={styles.logo}
            contentFit="contain"
            accessibilityLabel="Deckino"
          />
          <Text style={styles.tagline}>
            Identify Magic: The Gathering cards in real time.
          </Text>
        </View>

        <View style={styles.tips}>
          {TIPS.map((tip) => (
            <View key={tip.title} style={styles.tip}>
              <View style={styles.tipIcon}>
                <SymbolView name={tip.icon} size={20} tintColor={colors.lavender} />
              </View>
              <View style={styles.tipText}>
                <Text style={styles.tipTitle}>{tip.title}</Text>
                <Text style={styles.tipDetail}>{tip.detail}</Text>
              </View>
            </View>
          ))}
        </View>

        <Pressable
          style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
          onPress={() => router.navigate('/scan')}
        >
          <SymbolView
            name={{ ios: 'viewfinder', android: 'document_scanner' }}
            size={22}
            tintColor={colors.text}
          />
          <Text style={styles.ctaLabel}>Start scanning</Text>
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  glow: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: `radial-gradient(circle at 50% 18%, rgba(152, 29, 206, 0.35) 0%, rgba(222, 65, 144, 0.10) 40%, rgba(11, 6, 16, 0) 70%)`,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingBottom: 24,
    justifyContent: 'space-between',
  },
  hero: {
    alignItems: 'center',
    gap: 16,
    paddingTop: 56,
  },
  // The SVG viewBox is 1200 x 396.58, including its own padding.
  logo: {
    width: 300,
    height: 300 * (396.58 / 1200),
  },
  tagline: {
    color: colors.textMuted,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
    maxWidth: 280,
  },
  tips: {
    gap: 10,
  },
  tip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  tipIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
  },
  tipText: {
    flex: 1,
    gap: 2,
  },
  tipTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  tipDetail: {
    color: colors.textMuted,
    fontSize: 13,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 56,
    borderRadius: radius.pill,
    experimental_backgroundImage: gradients.brand,
    boxShadow: '0 8px 24px rgba(152, 29, 206, 0.45)',
  },
  ctaPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  ctaLabel: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
