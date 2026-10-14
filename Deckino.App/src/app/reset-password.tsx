import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { resetPassword } from '@/api/account';
import { ApiError } from '@/api/client';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';

// Opened from the emailed link (deckino.com/reset-password?userId=…&token=…): choose a new password, then sign in.
export default function ResetPasswordScreen() {
  const { userId = '', token = '' } = useLocalSearchParams<{ userId?: string; token?: string }>();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'form' | 'done' | 'badLink'>('form');
  const form = useSubmit();

  async function submit() {
    const saved = await form.submit(async () => {
      try {
        await resetPassword(userId, token, password);
      } catch (error) {
        if (error instanceof ApiError && error.status === 400 && Object.keys(error.fields).length === 0) setState('badLink');
        throw error;
      }
    });
    if (saved) setState('done');
  }

  if (state === 'done') {
    return (
      <FormScreen
        brand={{ title: 'Password changed', subtitle: 'Sign in with your new password.' }}
        actions={<Button label="Sign in" onPress={() => router.replace('/sign-in')} />}
      />
    );
  }
  if (state === 'badLink') {
    return (
      <FormScreen
        brand={{ title: "This link didn't work", subtitle: 'The reset link is invalid or has expired. Ask for a new one.' }}
        actions={<Button label="Send a new link" onPress={() => router.replace('/forgot-password')} />}
      />
    );
  }
  return (
    <FormScreen
      brand={{ title: 'Choose a new password', subtitle: 'At least 8 characters.' }}
      actions={<Button label={form.busy ? 'Saving…' : 'Save password'} onPress={() => void submit()} />}
    >
      <FormMessage message={form.message} />
      <Field
        label="New password"
        value={password}
        onChangeText={setPassword}
        error={form.fields.password}
        secret
        autoComplete="new-password"
        textContentType="newPassword"
        autoFocus
        onSubmitEditing={() => void submit()}
      />
    </FormScreen>
  );
}
