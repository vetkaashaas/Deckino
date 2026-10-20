import { useEffect, useRef, type ReactNode } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { signOut, useAccount, useProfileSummary } from '@/api/account';
import { useBinders } from '@/api/binders';
import { API_URL, APP_VERSION } from '@/api/client';
import { useSignedIn } from '@/api/session';
import { formatPrice } from '@/components/card-visuals';
import { ListRow, Skeleton, SwitchRow, type Icon } from '@/components/ui';
import { choiceLabel, setPreferences, usePreferences, type ChoiceKey } from '@/preferences';
import { modelInfo, useModelUpdateStatus, type ModelKind } from '@/scan/model-store';
import { colors, fonts, radius, type } from '@/theme';

// The style guide ships in development and E2E builds only.
const showStyleGuide = __DEV__ || process.env.EXPO_PUBLIC_E2E === '1';

// The account and the app's settings (AppPlan, Phase A3). Signed out, a row to sign in sits above the same settings
// (the welcome screen is the main way in).
export default function ProfileScreen() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const preferences = usePreferences();
  const binders = useBinders().data;
  // Signing in or out swaps the top of the page: show it, not whatever was scrolled to.
  const scroll = useRef<ScrollView>(null);
  useEffect(() => scroll.current?.scrollTo({ y: 0, animated: false }), [signedIn]);

  const choice = (key: ChoiceKey, title: string) => (
    <ListRow
      title={title}
      trailing={<Value text={choiceLabel(key, preferences, binders)} />}
      onPress={() => router.push(`/preference/${key}`)}
    />
  );

  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.content}>
      {signedIn ? <AccountHeader /> : <SignInPanel />}

      {signedIn ? (
        <Section title="Account">
          <AccountRows />
        </Section>
      ) : null}

      <Section title="Preferences">
        {choice('currency', 'Currency')}
        {signedIn ? choice('defaultBinderId', 'Default binder') : null}
        {choice('condition', 'Condition')}
        {choice('language', 'Language')}
        {choice('finish', 'Finish')}
        <SwitchRow title="Vibrate on scan" value={preferences.haptics} onChange={(haptics) => setPreferences({ haptics })} />
      </Section>

      <Section title="Scanner">
        <SwitchRow title="Scan sound" value={preferences.scanSound} onChange={(scanSound) => setPreferences({ scanSound })} />
      </Section>

      <Section title="Privacy">
        {signedIn ? (
          <SwitchRow
            title="Help improve recognition"
            value={preferences.trainingPhotosAsked && preferences.trainingPhotos}
            onChange={(trainingPhotos) => setPreferences({ trainingPhotos, trainingPhotosAsked: true })}
          />
        ) : null}
        <Text style={[type.caption, styles.note]}>
          While you're signed in, sends the photos you scan, with what the scanner thought they were, so we can train it.
          Nothing else leaves your phone: scanning happens on it, and Deckino keeps no scan history. Your settings stay
          on this phone.
        </Text>
      </Section>

      <Section title="About">
        <View style={styles.brand}>
          <Image source={require('../../assets/images/icon.png')} style={styles.icon} accessibilityIgnoresInvertColors />
          <View style={styles.flex}>
            <Text style={type.heading}>Deckino</Text>
            <Text style={type.label}>Version {APP_VERSION}</Text>
          </View>
        </View>
        <View style={styles.divider} />
        <ModelRow kind="extractor" title="Card finder" icon={{ ios: 'viewfinder', android: 'document_scanner' }} />
        <ModelRow kind="artwork" title="Card recognizer" icon={{ ios: 'sparkles', android: 'auto_awesome' }} />
        <View style={styles.divider} />
        {showStyleGuide ? (
          <ListRow title="Server" trailing={<Value text={API_URL.replace(/^https?:\/\//, '')} />} />
        ) : null}
        <ListRow title="Deckino on the web" trailing={<Chevron />} onPress={() => void Linking.openURL('https://deckino.com')} />
        <ListRow
          title="Send feedback"
          trailing={<Chevron />}
          onPress={() => void Linking.openURL(`mailto:support@deckino.com?subject=${encodeURIComponent(`Deckino app ${APP_VERSION}`)}`)}
        />
        {showStyleGuide ? (
          <ListRow title="Style guide" trailing={<Chevron />} onPress={() => router.push('/styleguide')} />
        ) : null}
      </Section>

      <Text style={type.caption}>
        Card data and images courtesy of Scryfall. Deckino is unofficial Fan Content permitted under the Fan Content
        Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast.
        ©Wizards of the Coast LLC.
      </Text>
    </ScrollView>
  );
}

function SignInPanel() {
  const router = useRouter();
  return (
    <View style={styles.panel}>
      <ListRow
        leading={
          <View style={styles.badge}>
            <SymbolView name={{ ios: 'person', android: 'person' }} size={24} tintColor={colors.lavender} />
          </View>
        }
        title="Sign in or create an account"
        detail="Keep your binders and decks"
        trailing={<Chevron />}
        onPress={() => router.push('/sign-in')}
      />
    </View>
  );
}

function AccountHeader() {
  const account = useAccount().data;
  const { currency } = usePreferences();
  const summary = useProfileSummary(currency);
  const since = account && new Date(account.createdAt).toLocaleDateString('en', { month: 'long', year: 'numeric' });
  return (
    <View style={styles.panel}>
      <View style={styles.identity}>
        <View style={styles.initial}>
          <Text style={styles.initialText}>{account?.username.slice(0, 1).toUpperCase() ?? ''}</Text>
        </View>
        <View style={styles.flex}>
          {account ? (
            <>
              <Text style={type.heading} numberOfLines={1}>
                {account.username}
              </Text>
              <Text style={type.label}>Member since {since}</Text>
            </>
          ) : (
            <Skeleton style={styles.nameSkeleton} />
          )}
        </View>
      </View>
      <View style={styles.stats}>
        <Stat label="cards" value={summary.cards?.toLocaleString()} />
        <Stat label="decks" value={summary.decks?.toLocaleString()} />
        <Stat label="value" value={summary.value === undefined ? undefined : formatPrice(summary.value, currency)} />
      </View>
    </View>
  );
}

function AccountRows() {
  const router = useRouter();
  const account = useAccount().data;
  return (
    <>
      <ListRow title="Username" trailing={<Value text={account?.username ?? ''} chevron />} onPress={() => router.push('/account/username')} />
      <ListRow title="Email" trailing={<Value text={account?.email ?? ''} />} />
      <ListRow title="Change password" trailing={<Chevron />} onPress={() => router.push('/account/password')} />
      <ListRow title="Sign out" onPress={signOut} />
      <ListRow
        title="Delete account"
        trailing={<Chevron color={colors.danger} />}
        onPress={() => router.push('/account/delete')}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={value === undefined ? `${label} loading` : `${value} ${label}`}>
      {value === undefined ? <Skeleton style={styles.statSkeleton} /> : <Text style={styles.statValue}>{value}</Text>}
      <Text style={type.label}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <Text style={[type.label, styles.section]} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.panel}>{children}</View>
    </>
  );
}

// A scanning model: the day it was trained (its version, in plain words), and a note once an update came.
function ModelRow({ kind, title, icon }: { kind: ModelKind; title: string; icon: Icon }) {
  useModelUpdateStatus(); // read again once a check or download moves on
  const model = modelInfo(kind);
  const note = model.next ? 'Newer version ready for next time' : model.updated ? 'Updated over Wi-Fi' : null;
  return (
    <View style={styles.model}>
      <SymbolView name={icon} size={18} tintColor={colors.lavender} />
      <View style={styles.flex}>
        <Text style={type.body}>{title}</Text>
        {note ? <Text style={type.caption}>{note}</Text> : null}
      </View>
      <Text style={type.label}>{trainedOn(model.version)}</Text>
    </View>
  );
}

// Versions are `<kind>-run-<UTC timestamp>` (scan/model-version.ts).
function trainedOn(version: string) {
  const match = /-run-(\d{4})(\d{2})(\d{2})T/.exec(version);
  if (!match) return version;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return day.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Value({ text, chevron }: { text: string; chevron?: boolean }) {
  return (
    <View style={styles.value}>
      <Text style={[type.label, styles.valueText]} numberOfLines={1}>
        {text}
      </Text>
      {chevron ? <Chevron /> : null}
    </View>
  );
}

const Chevron = ({ color = colors.textDim }: { color?: string }) => (
  <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={18} tintColor={color} />
);

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 48 },
  flex: { flex: 1, gap: 2 },
  panel: {
    gap: 8,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  initial: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(121, 17, 203, 0.35)',
    borderWidth: 1,
    borderColor: colors.lavender,
  },
  initialText: { fontFamily: fonts.heading, fontSize: 24, fontWeight: '800', color: colors.text },
  nameSkeleton: { height: 24, width: '60%' },
  stats: { flexDirection: 'row', marginTop: 8 },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '700', color: colors.text },
  statSkeleton: { height: 24, width: 56 },
  section: { marginTop: 12, textTransform: 'uppercase', letterSpacing: 1 },
  note: { paddingHorizontal: 4 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: radius.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder },
  model: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  value: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '55%' },
  valueText: { flexShrink: 1 },
});
