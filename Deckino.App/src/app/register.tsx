import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import { register, resendVerification } from '@/api/account';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';
import { colors, fonts, type } from '@/theme';

export default function RegisterScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);
  const form = useSubmit();

  async function submit() {
    if (await form.submit(() => register(email.trim(), username.trim(), password))) setSent(true);
  }

  // The API answers the same whether or not the address already has an account; the email says which.
  if (sent) {
    return (
      <FormScreen
        brand
        actions={
          <>
            <Button label="Sign in" onPress={() => router.replace('/sign-in')} />
            <Button
              label={resent ? 'Sent again' : 'Send the email again'}
              variant="secondary"
              onPress={() => void form.submit(() => resendVerification(email.trim())).then((ok) => setResent(ok))}
            />
          </>
        }
      >
        <View style={styles.badge}>
          <SymbolView name={{ ios: 'envelope', android: 'mail' }} size={30} tintColor={colors.lavender} />
        </View>
        <Text style={type.title} accessibilityRole="header">
          Check your email
        </Text>
        <Text style={[type.body, { color: colors.textMuted }]}>
          We sent a link to {email.trim()}. Open it to verify your address, then sign in here.
        </Text>
        <FormMessage message={form.message} />
      </FormScreen>
    );
  }

  return (
    <FormScreen
      brand
      actions={
        <>
          <Button label={form.busy ? 'Creating account…' : 'Create account'} onPress={() => void submit()} />
          <Pressable onPress={() => router.replace('/sign-in')} accessibilityRole="button" style={styles.switch}>
            <Text style={[type.body, styles.center, { color: colors.textMuted }]}>
              Have an account? <Text style={styles.link}>Sign in</Text>
            </Text>
          </Pressable>
        </>
      }
    >
      <Text style={type.title} accessibilityRole="header">
        Join Deckino
      </Text>
      <Text style={[type.body, { color: colors.textMuted }]}>
        Save your scans to binders, build decks and follow what your collection is worth, here and on deckino.com.
      </Text>
      <FormMessage message={form.message} />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        error={form.fields.email}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        placeholder="name@example.com"
      />
      <Field
        label="Username"
        value={username}
        onChangeText={setUsername}
        error={form.fields.username}
        autoComplete="username-new"
        placeholder="Shown on your public decks"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        error={form.fields.password}
        secret
        autoComplete="new-password"
        textContentType="newPassword"
        placeholder="At least 8 characters"
        onSubmitEditing={() => void submit()}
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  switch: { paddingVertical: 8 },
  center: { textAlign: 'center' },
  link: { fontFamily: fonts.body, fontSize: 15, color: colors.lavender, fontWeight: '600' },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
  },
});
