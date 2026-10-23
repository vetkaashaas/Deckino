import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { deleteAccount, signOut, useAccount, useProfileSummary } from '@/api/account';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';
import { usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

// Google Play requires deleting the account in the app, behind a confirmation that names what goes.
export default function DeleteAccountScreen() {
  const router = useRouter();
  const account = useAccount().data;
  const summary = useProfileSummary(usePreferences().currency);
  const [password, setPassword] = useState('');
  const form = useSubmit();

  async function submit() {
    // Leave first, then sign out: the welcome screen that signing out opens comes on top of Profile.
    if (await form.submit(() => deleteAccount(password))) {
      router.dismissTo('/profile');
      signOut();
    }
  }

  const count = (n: number | undefined, one: string, many: string) =>
    n === undefined ? many : `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const gone = [
    `Your account${account ? `, ${account.username} (${account.email})` : ''}`,
    `${count(summary.binders, 'binder', 'binders')} with ${count(summary.cards, 'card', 'cards')}`,
    `${count(summary.decks, 'deck', 'decks')}, public ones too`,
    'Your wishlist',
  ];

  return (
    <FormScreen
      actions={
        <Button
          label={form.busy ? 'Deleting…' : 'Delete my account'}
          onPress={() => void submit()}
          variant="danger"
        />
      }
    >
      <Text style={type.title} accessibilityRole="header">
        Delete your account?
      </Text>
      <Text style={[type.body, { color: colors.textMuted }]}>This can't be undone. Deleted for good, here and on deckino.com:</Text>
      <View style={styles.list}>
        {gone.map((line) => (
          <Text key={line} style={styles.item}>
            •  {line}
          </Text>
        ))}
      </View>
      <Text style={type.caption}>
        Scan photos you shared to improve recognition are kept as photos of cards, no longer linked to anyone.
      </Text>
      <FormMessage message={form.message} />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        error={form.fields.password}
        secret
        autoComplete="current-password"
        textContentType="password"
        placeholder="Enter your password to confirm"
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: 6,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255, 90, 122, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255, 90, 122, 0.30)',
  },
  item: { fontFamily: fonts.body, fontSize: 15, color: colors.text },
});
