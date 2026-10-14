import { useState } from 'react';
import { useRouter } from 'expo-router';

import { forgotPassword } from '@/api/account';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';

// The reset link opens reset-password.tsx on this phone (App Links, A8), or the website anywhere else.
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const form = useSubmit();

  async function submit() {
    if (await form.submit(() => forgotPassword(email.trim()))) setSent(true);
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
          onSubmitEditing={() => void submit()}
        />
      )}
    </FormScreen>
  );
}
