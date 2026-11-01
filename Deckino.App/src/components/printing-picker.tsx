import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';

import { usePrintings, type Printing } from '@/api/cards';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui';
import { colors, fonts, radius } from '@/theme';

// The one way to change a printing (AGENTS.md): the card page and the card sheet both open the "Choose a printing"
// grid (app/card/printings.tsx), which hands the tapped printing back here.

// ponytail: one pick at a time (the grid is a modal), so one pending callback is enough
let pending: ((printing: Printing) => void) | null = null;

/** The grid's side: hands the tapped printing to whoever opened it. */
export function finishPick(printing: Printing) {
  const done = pending;
  pending = null;
  done?.(printing);
}

/**
 * "See all 4 printings", opening the grid for `id`; nothing when it has no other printing. `compact` is a small pill
 * ("4 printings") for beside other text.
 */
export function PrintingButton({
  id,
  onChoose,
  compact,
}: {
  id: string;
  onChoose: (printing: Printing) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const count = usePrintings(id).data?.length ?? 0;
  if (count < 2) return null;
  const open = () => {
    pending = onChoose;
    router.push({ pathname: '/card/printings', params: { id } });
  };
  if (!compact) return <Button label={`See all ${count} printings`} variant="secondary" icon="layers" onPress={open} />;
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`See all ${count} printings`}
      hitSlop={6}
      style={({ pressed }) => [styles.pill, pressed && { opacity: 0.7 }]}
    >
      <Icon name="layers" size={18} tintColor={colors.lavender} />
      <Text style={styles.pillLabel}>{count} printings</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center', // when it's stretched, as under the card sheet's picture
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.background,
  },
  pillLabel: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.lavender },
});
