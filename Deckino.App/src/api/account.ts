import { useQuery } from '@tanstack/react-query';

import { send } from './client';
import { queryClient } from './query-client';
import { setTokens, useSignedIn, type Tokens } from './session';

// The account endpoints the website uses (Deckino.Api/Accounts), plus the app's token sign-in.

export interface Account {
  id: string;
  username: string;
  email: string;
  createdAt: string;
}

export interface BinderSummary {
  id: string;
  name: string;
  cardCount: number;
}
interface CollectionPrices {
  currency: 'usd' | 'eur';
  value: number;
}

export function useAccount() {
  return useQuery({ queryKey: ['account'], queryFn: () => send<Account>('GET', '/api/account/me'), enabled: useSignedIn() });
}

export function useBinders() {
  return useQuery({
    queryKey: ['binders'],
    queryFn: () => send<BinderSummary[]>('GET', '/api/binders'),
    enabled: useSignedIn(),
  });
}

/** The profile header's numbers, from the endpoints the website's dashboard uses. */
export function useProfileSummary(currency: 'usd' | 'eur') {
  const enabled = useSignedIn();
  const binders = useBinders();
  const decks = useQuery({ queryKey: ['decks'], queryFn: () => send<unknown[]>('GET', '/api/decks'), enabled });
  const value = useQuery({
    queryKey: ['collection-prices', currency],
    queryFn: () => send<CollectionPrices>('GET', `/api/collection/prices?currency=${currency}`),
    enabled,
  });
  return {
    binders: binders.data?.length,
    cards: binders.data?.reduce((sum, binder) => sum + binder.cardCount, 0),
    decks: decks.data?.length,
    value: value.data?.value,
  };
}

export async function signIn(email: string, password: string): Promise<void> {
  setTokens(await send<Tokens>('POST', '/api/auth/token', { body: { email, password } }));
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

// A new username or password ends every other session; this one gets a fresh token pair back.
export async function changeUsername(username: string): Promise<void> {
  setTokens(await send<Tokens>('PUT', '/api/account/username', { body: { username } }));
  await queryClient.invalidateQueries({ queryKey: ['account'] });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  setTokens(await send<Tokens>('PUT', '/api/account/password', { body: { currentPassword, newPassword } }));
}

export async function deleteAccount(password: string): Promise<void> {
  await send('DELETE', '/api/account', { body: { password } });
}
