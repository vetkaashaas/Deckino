import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { forgotPassword } from '@/api/account';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';

// The reset link opens reset-password.tsx on this phone (App Links, A8), or the website anywhere else.
export default function ForgotPasswordScreen() {
  const router = useRouter();
  // Sign in passes what was typed there, so it needn't be typed twice.
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email ?? '');
  const [sent, setSent] = useState(false);
  const form = useSubmit();

  async function submit() {
    const ok = await form.submit(async () => {
      // The server answers "sent" for any address (so it can't tell which have accounts), an empty one too.
      if (!email.trim()) throw new Error('Enter your email.');
      await forgotPassword(email.trim());
    });
    if (ok) setSent(true);
  }

  return (
    <FormScreen
      brand={{
        title: sent ? 'Check your email' : 'Reset your password',
        subtitle: sent
          ? `If ${email.trim()} has a Deckino account, a link to choose a new password is on its way. Open it on this phone, or on any computer.`
          : "Enter your account's email and we'll send you a link to choose a new password.",
      }}
      actions={
        sent ? (
          <Button label="Back to sign in" onPress={() => router.back()} />
        ) : (
          <Button label={form.busy ? 'Sending…' : 'Send reset link'} onPress={() => void submit()} />
        )
      }
    >
      <FormMessage message={form.message} />
      {sent ? null : (
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          placeholder="name@example.com"
          returnKeyType="send"
          onSubmitEditing={() => void submit()}
        />
      )}
    </FormScreen>
  );
}
