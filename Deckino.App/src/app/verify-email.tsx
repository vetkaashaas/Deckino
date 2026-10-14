import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { resendVerification, verifyEmail } from '@/api/account';
import { ApiError } from '@/api/client';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';

// Opened from the emailed link (deckino.com/verify-email?userId=…&token=…). Verifying twice is harmless.
export default function VerifyEmailScreen() {
  const { userId = '', token = '' } = useLocalSearchParams<{ userId?: string; token?: string }>();
  const router = useRouter();
  const [state, setState] = useState<'verifying' | 'verified' | 'failed' | 'unreachable'>('verifying');
  const [problem, setProblem] = useState('');
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(false);
  const form = useSubmit();

  // Offline, too many tries or a server error says nothing about the link: try again rather than ask for a new one.
  const verify = useCallback(() => {
    setState('verifying');
    verifyEmail(userId, token).then(
      () => setState('verified'),
      (error) => {
        const unreachable = error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
        setProblem(error instanceof Error ? error.message : String(error));
        setState(unreachable ? 'unreachable' : 'failed');
      },
    );
  }, [userId, token]);
  useEffect(verify, [verify]);

  if (state === 'unreachable') {
    return <FormScreen brand={{ title: "Couldn't verify your email", subtitle: problem }} actions={<Button label="Try again" onPress={verify} />} />;
  }

  if (state === 'failed') {
    return (
      <FormScreen
        brand={{ title: "This link didn't work", subtitle: 'It may have expired. Enter your email and we’ll send a new one.' }}
        actions={
          <Button
            label={resent ? 'Sent' : form.busy ? 'Sending…' : 'Send a new link'}
            onPress={() => !resent && void form.submit(() => resendVerification(email.trim())).then(setResent)}
          />
        }
      >
        <FormMessage message={resent ? 'Sent. Open the link in the email.' : form.message} tone={resent ? 'info' : 'error'} />
        <Field label="Email" value={email} onChangeText={setEmail} error={form.fields.email} keyboardType="email-address" autoComplete="email" />
      </FormScreen>
    );
  }
  return (
    <FormScreen
      brand={
        state === 'verified'
          ? { title: 'Email verified', subtitle: 'Your account is ready. Sign in to start.' }
          : { title: 'Verifying your email…' }
      }
      actions={state === 'verified' ? <Button label="Sign in" onPress={() => router.replace('/sign-in')} /> : null}
    />
  );
}
