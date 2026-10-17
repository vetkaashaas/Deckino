import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, type TextInput } from 'react-native';
import { useRouter } from 'expo-router';

import { resendVerification, signIn } from '@/api/account';
import { ApiError } from '@/api/client';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';
import { colors, fonts, type } from '@/theme';

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const form = useSubmit();

  async function submit() {
    setUnverified(false);
    setResent(false);
    const ok = await form.submit(async () => {
      // Say what's missing rather than send an empty form, which the server calls a wrong password.
      const missing = [email.trim() ? null : 'email', password ? null : 'password'].filter(Boolean);
      if (missing.length > 0) throw new Error(`Enter your ${missing.join(' and ')}.`);
      try {
        await signIn(email.trim(), password);
      } catch (error) {
        // The right password for an address that still needs verifying.
        if (error instanceof ApiError && error.status === 403) setUnverified(true);
        throw error;
      }
    });
    if (ok) router.back();
  }

  async function resend() {
    if (await form.submit(() => resendVerification(email.trim()))) setResent(true);
  }

  return (
    <FormScreen
      brand={{ title: 'Welcome back', subtitle: 'Sign in to your collection and decks.' }}
      actions={
        <>
          <Button label={form.busy ? 'Signing in…' : 'Sign in'} onPress={() => void submit()} />
          <Pressable onPress={() => router.replace('/register')} accessibilityRole="button" style={styles.switch}>
            <Text style={[type.body, styles.center, { color: colors.textMuted }]}>
              New here? <Text style={styles.link}>Create account</Text>
            </Text>
          </Pressable>
        </>
      }
    >
      <FormMessage
        message={resent ? 'Sent. Open the link in the email, then sign in.' : form.message}
        tone={resent ? 'info' : 'error'}
      />
      {unverified && !resent ? (
        <Button label="Send the verification email again" variant="secondary" onPress={() => void resend()} />
      ) : null}
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        placeholder="name@example.com"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secret
        autoComplete="current-password"
        textContentType="password"
        ref={passwordRef}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Pressable onPress={() => router.push({ pathname: '/forgot-password', params: { email: email.trim() } })} accessibilityRole="button" hitSlop={8}>
        <Text style={styles.link}>Forgot your password?</Text>
      </Pressable>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  switch: { paddingVertical: 8 },
  center: { textAlign: 'center' },
  link: { fontFamily: fonts.body, fontSize: 15, color: colors.lavender, fontWeight: '600' },
});
