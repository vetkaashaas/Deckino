import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { Backdrop, Button } from '@/components/ui';
import { setPreferences } from '@/preferences';
import { colors, radius, type } from '@/theme';

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
    // Scrolls when it doesn't fit (a small phone at a large font size), so the question at the top stays reachable.
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.backdrop, { paddingTop: 16 + insets.top, paddingBottom: 16 + insets.bottom }]}
    >
      <View style={styles.card} accessibilityViewIsModal>
        <Backdrop />
        <View style={styles.badge}>
          <Icon name="auto_awesome" size={30} tintColor={colors.lavender} />
        </View>
        <Text style={type.heading} accessibilityRole="header">
          Help the scanner get better?
        </Text>
        <Text style={[type.body, { color: colors.textMuted }]}>
          Every card you scan can teach Deckino to recognise cards faster and more reliably, for you and everyone else.
        </Text>
        <View style={styles.points}>
          <Point icon="photo_camera" text="We'd receive the photo of the card you scanned and what the scanner thought it was." />
          <Point icon="lock" text="Nothing else from your phone, and the photos are only used to train the scanner." />
          <Point icon="settings" text="Change your mind any time in Profile, under Privacy." />
        </View>
        <Button label="Yes, share my scans" onPress={() => answer(true)} />
        <Button label="No thanks" variant="secondary" onPress={() => answer(false)} />
      </View>
    </ScrollView>
  );
}

function Point({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.point}>
      <Icon name={icon} size={20} tintColor={colors.lavender} />
      <Text style={[type.body, styles.pointText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'rgba(5, 2, 8, 0.72)' },
  backdrop: { flexGrow: 1, justifyContent: 'flex-end', padding: 16 },
  card: {
    gap: 14,
    padding: 22,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
  },
  points: { gap: 10, marginBottom: 6 },
  point: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  pointText: { flex: 1, color: colors.text },
});
