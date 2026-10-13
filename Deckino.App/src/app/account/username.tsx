import { useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';

import { changeUsername, useAccount } from '@/api/account';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';
import { colors, type } from '@/theme';

export default function UsernameScreen() {
  const router = useRouter();
  const account = useAccount().data;
  const [edited, setUsername] = useState<string | null>(null);
  const username = edited ?? account?.username ?? ''; // the current name until it's edited, once it has loaded
  const form = useSubmit();

  async function submit() {
    if (await form.submit(() => changeUsername(username.trim()))) router.back();
  }

  return (
    <FormScreen actions={<Button label={form.busy ? 'Saving…' : 'Save username'} onPress={() => void submit()} />}>
      <Text style={[type.body, { color: colors.textMuted }]}>
        Your username shows on your public decks and binders. Changing it signs you out of Deckino on your other devices.
      </Text>
      <FormMessage message={form.message} />
      <Field
        label="Username"
        value={username}
        onChangeText={setUsername}
        error={form.fields.username}
        autoComplete="username"
        onSubmitEditing={() => void submit()}
      />
    </FormScreen>
  );
}
