import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { API_URL, APP_VERSION } from '@/api/client';
import { ListRow } from '@/components/ui';
import { colors, radius, type } from '@/theme';

// The style guide ships in development and E2E builds only.
const showStyleGuide = __DEV__ || process.env.EXPO_PUBLIC_E2E === '1';

// Signed out until A3 adds accounts: what the app is, and where its card data comes from.
export default function ProfileScreen() {
  const router = useRouter();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.panel}>
        <View style={styles.badge}>
          <SymbolView name={{ ios: 'person', android: 'person' }} size={30} tintColor={colors.lavender} />
        </View>
        <Text style={type.heading}>Not signed in</Text>
        <Text style={[type.body, { color: colors.textMuted }]}>
          Signing in to your Deckino account arrives in an update soon, along with your settings.
        </Text>
      </View>

      <Text style={[type.label, styles.section]}>About</Text>
      <View style={styles.panel}>
        <ListRow title="Version" trailing={<Text style={type.label}>{APP_VERSION}</Text>} />
        <ListRow title="Server" trailing={<Text style={type.label}>{API_URL.replace(/^https?:\/\//, '')}</Text>} />
        <ListRow
          title="Deckino on the web"
          trailing={<Chevron />}
          onPress={() => void Linking.openURL('https://deckino.com')}
        />
        {showStyleGuide ? (
          <ListRow title="Style guide" trailing={<Chevron />} onPress={() => router.push('/styleguide')} />
        ) : null}
      </View>

      <Text style={type.caption}>
        Card data and images courtesy of Scryfall. Deckino is unofficial Fan Content permitted under the Fan Content
        Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast.
        ©Wizards of the Coast LLC.
      </Text>
    </ScrollView>
  );
}

const Chevron = () => (
  <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={18} tintColor={colors.textDim} />
);

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 48 },
  panel: {
    gap: 8,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
  },
  section: { marginTop: 12, textTransform: 'uppercase', letterSpacing: 1 },
});
