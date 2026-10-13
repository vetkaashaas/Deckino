import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';

import type { ScanTone } from '@/components/scan-frame';
import { colors, fonts, gradients, radius } from '@/theme';

const TONE_STYLE: Record<
  ScanTone,
  { eyebrow: string; eyebrowColor: string; badge: string }
> = {
  idle: { eyebrow: 'Ready', eyebrowColor: colors.lavender, badge: gradients.brandDiagonal },
  detecting: { eyebrow: 'Card found', eyebrowColor: colors.pink, badge: gradients.brandDiagonal },
  locked: { eyebrow: 'Identified', eyebrowColor: colors.success, badge: gradients.success },
  rejected: { eyebrow: 'Hold on', eyebrowColor: colors.danger, badge: gradients.danger },
};

function Badge({ tone }: { tone: ScanTone }) {
  if (tone === 'detecting') {
    return <ActivityIndicator color={colors.text} />;
  }
  if (tone === 'locked') {
    return (
      <SymbolView
        name={{ ios: 'checkmark', android: 'check' }}
        size={26}
        tintColor={colors.text}
        weight="bold"
      />
    );
  }
  if (tone === 'rejected') {
    return (
      <SymbolView
        name={{ ios: 'exclamationmark.triangle.fill', android: 'warning' }}
        size={22}
        tintColor={colors.text}
      />
    );
  }
  return (
    <Image
      source={require('../../assets/images/brand/icon-white.svg')}
      style={styles.brandIcon}
    />
  );
}

export interface ResultBadge {
  label: string;
  tone: 'have' | 'want' | 'deck' | 'none';
}

const BADGE_COLORS: Record<ResultBadge['tone'], string> = {
  have: colors.success,
  want: colors.pink,
  deck: colors.lavender,
  none: colors.textMuted,
};

/** Glass result panel at the bottom of the scanner. `confidence` is 0-1. */
export function ScanResultCard({
  tone,
  title,
  detail,
  confidence,
  action,
  badges,
}: {
  tone: ScanTone;
  title: string;
  detail: string;
  confidence?: number;
  /** A button under the result, e.g. "View card" once the printing is known. */
  action?: { label: string; onPress: () => void };
  /** What you have of the card: "You have 2", "On your wishlist", "In Goblins" (AppPlan, Phase A7). */
  badges?: ResultBadge[];
}) {
  const style = TONE_STYLE[tone];
  const fill =
    confidence === undefined ? null : Math.max(0.04, Math.min(1, confidence));
  return (
    <View style={styles.card} pointerEvents="box-none">
      <View style={styles.result} pointerEvents="none">
        <View style={[styles.badge, { experimental_backgroundImage: style.badge }]}>
          <Badge tone={tone} />
        </View>
        <View style={styles.text}>
          <Text style={[styles.eyebrow, { color: style.eyebrowColor }]}>
            {style.eyebrow}
          </Text>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
          {fill !== null ? (
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${fill * 100}%`,
                    experimental_backgroundImage:
                      tone === 'locked' ? gradients.success : gradients.brand,
                  },
                ]}
              />
            </View>
          ) : null}
        </View>
      </View>
      {badges && badges.length > 0 ? (
        <View style={styles.badges} pointerEvents="none">
          {badges.map((badge) => (
            <Text key={badge.label} style={[styles.pill, { color: BADGE_COLORS[badge.tone], borderColor: BADGE_COLORS[badge.tone] }]}>
              {badge.label}
            </Text>
          ))}
        </View>
      ) : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Text style={styles.actionLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  action: {
    minHeight: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    experimental_backgroundImage: gradients.brand,
  },
  actionPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  actionLabel: {
    fontFamily: fonts.body,
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: radius.md + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandIcon: {
    width: 40,
    height: 40,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  detail: {
    color: colors.textMuted,
    fontSize: 13,
  },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    fontFamily: fonts.body,
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    overflow: 'hidden',
  },
  track: {
    height: 4,
    marginTop: 8,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});
