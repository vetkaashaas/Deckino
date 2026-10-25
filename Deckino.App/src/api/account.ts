import { useQuery } from '@tanstack/react-query';

import { useBinders, useCollectionPrices } from './binders';
import { send } from './client';
import type * as Api from './generated';
import { queryClient } from './query-client';
import { setTokens, useSignedIn } from './session';

// The account endpoints the website uses (Deckino.Api/Accounts), plus the app's token sign-in.

export type Account = Api.AccountResponse;

export function useAccount() {
  return useQuery({ queryKey: ['account'], queryFn: () => send('GET', '/api/account/me'), enabled: useSignedIn() });
}

/** The profile header's numbers, from the endpoints the website's dashboard uses. */
export function useProfileSummary(currency: 'usd' | 'eur') {
  const enabled = useSignedIn();
  const binders = useBinders(currency);
  const decks = useQuery({ queryKey: ['decks'], queryFn: () => send('GET', '/api/decks'), enabled });
  const value = useCollectionPrices(currency);
  return {
    binders: binders.data?.length,
    cards: binders.data?.reduce((sum, binder) => sum + binder.cardCount, 0),
    decks: decks.data?.length,
    value: value.data?.value,
  };
}

export async function signIn(email: string, password: string): Promise<void> {
  setTokens(await send('POST', '/api/auth/token', { body: { email, password } }));
}

export function signOut(): void {
  setTokens(null); // bearer tokens can't be revoked; they're simply forgotten (AppPlan, Authentication)
}

export function register(email: string, username: string, password: string): Promise<void> {
  return send('POST', '/api/account/register', { body: { email, username, password } });
}

export function resendVerification(email: string): Promise<void> {
  return send('POST', '/api/account/resend-verification', { body: { email } });
}

export function forgotPassword(email: string): Promise<void> {
  return send('POST', '/api/account/forgot-password', { body: { email } });
}

// The emailed links (deckino.com/verify-email and /reset-password), opened in the app through App Links (A8). A bad or
// expired link is a 400 without field errors.
export function verifyEmail(userId: string, token: string): Promise<void> {
  return send('POST', '/api/account/verify-email', { body: { userId, token } });
}

export function resetPassword(userId: string, token: string, password: string): Promise<void> {
  return send('POST', '/api/account/reset-password', { body: { userId, token, password } });
}

// A new username or password ends every other session; this one gets a fresh token pair back.
export async function changeUsername(username: string): Promise<void> {
  const answer = await send('PUT', '/api/account/username', { body: { username } });
  if ('accessToken' in answer) setTokens(answer); // the website gets its account back instead
  await queryClient.invalidateQueries({ queryKey: ['account'] });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const answer = await send('PUT', '/api/account/password', { body: { currentPassword, newPassword } });
  if (answer) setTokens(answer); // the website gets 204
}

export async function deleteAccount(password: string): Promise<void> {
  await send('DELETE', '/api/account', { body: { password } });
}
