import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, type Icon } from '@/components/ui';
import { setPreferences } from '@/preferences';
import { ambient, colors, radius, type } from '@/theme';

// Asked once, the first time a signed-in user opens the scanner: whether their scan photos may be sent to train
// the recognizer. Nothing uploads before an answer; Profile, Privacy changes it later.
export default function HelpImproveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const answer = (yes: boolean) => {
    setPreferences({ trainingPhotos: yes, trainingPhotosAsked: true });
    router.back();
  };
  return (
    <View style={[styles.backdrop, { paddingBottom: 16 + insets.bottom }]}>
      <View style={styles.card} accessibilityViewIsModal>
        <View style={styles.glow} pointerEvents="none" />
        <View style={styles.badge}>
          <SymbolView name={{ ios: 'sparkles', android: 'auto_awesome' }} size={30} tintColor={colors.lavender} />
        </View>
        <Text style={type.heading} accessibilityRole="header">
          Help the scanner get better?
        </Text>
        <Text style={[type.body, { color: colors.textMuted }]}>
          Every card you scan can teach Deckino to recognise cards faster and more reliably, for you and everyone else.
        </Text>
        <View style={styles.points}>
          <Point icon={{ ios: 'photo', android: 'photo_camera' }} text="We'd receive the photo of the card you scanned and what the scanner thought it was." />
          <Point icon={{ ios: 'lock', android: 'lock' }} text="Nothing else from your phone, and the photos are only used to train the scanner." />
          <Point icon={{ ios: 'gearshape', android: 'settings' }} text="Change your mind any time in Profile, under Privacy." />
        </View>
        <Button label="Yes, share my scans" onPress={() => answer(true)} />
        <Button label="No thanks" variant="secondary" onPress={() => answer(false)} />
      </View>
    </View>
  );
}

function Point({ icon, text }: { icon: Icon; text: string }) {
  return (
    <View style={styles.point}>
      <SymbolView name={icon} size={20} tintColor={colors.lavender} />
      <Text style={[type.body, styles.pointText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', padding: 16, backgroundColor: 'rgba(5, 2, 8, 0.72)' },
  card: {
    gap: 14,
    padding: 22,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
  },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
  },
  points: { gap: 10, marginBottom: 6 },
  point: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  pointText: { flex: 1, color: colors.text },
});
