import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, type TextInput } from 'react-native';
import { useRouter } from 'expo-router';

import { register, resendVerification } from '@/api/account';
import { ApiError } from '@/api/client';
import { Field, FormMessage, FormScreen, OAuthButtons, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';
import { colors, fonts, type } from '@/theme';

export default function RegisterScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);
  const usernameRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const form = useSubmit();

  async function submit() {
    const ok = await form.submit(async () => {
      // Every empty or short field at once: the server stops at the first bad one (the email), so it would take a
      // round trip per field. Shaped like its validation answer, so the fields show these as they show its own.
      const fields: Record<string, string[]> = {};
      if (!email.trim()) fields.email = ['Enter your email.'];
      if (!username.trim()) fields.username = ['Choose a username.'];
      if (password.length < 8) fields.password = [password ? 'Use at least 8 characters.' : 'Choose a password.'];
      if (Object.keys(fields).length > 0) throw new ApiError(400, 'Check the fields below.', fields);
      await register(email.trim(), username.trim(), password);
    });
    if (ok) setSent(true);
  }

  // The API answers the same whether or not the address already has an account; the email says which.
  if (sent) {
    return (
      <FormScreen
        brand={{
          title: 'Check your email',
          subtitle: `We sent a link to ${email.trim()}. Open it to verify your address, then sign in here.`,
        }}
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
        <FormMessage message={form.message} />
      </FormScreen>
    );
  }

  return (
    <FormScreen
      brand={{ title: 'Join Deckino', subtitle: 'Keep your collection and decks, here and on deckino.com.' }}
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
      <OAuthButtons />
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
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => usernameRef.current?.focus()}
      />
      <Field
        label="Username"
        value={username}
        onChangeText={setUsername}
        error={form.fields.username}
        autoComplete="username-new"
        placeholder="Shown on your public decks"
        ref={usernameRef}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
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
        ref={passwordRef}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  switch: { paddingVertical: 8 },
  center: { textAlign: 'center' },
  link: { fontFamily: fonts.body, fontSize: 15, color: colors.lavender, fontWeight: '600' },
});
