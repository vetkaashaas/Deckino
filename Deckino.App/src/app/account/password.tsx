import { useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';

import { changePassword } from '@/api/account';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';
import { colors, type } from '@/theme';

export default function PasswordScreen() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const form = useSubmit();

  async function submit() {
    if (await form.submit(() => changePassword(current, next))) router.back();
  }

  return (
    <FormScreen actions={<Button label={form.busy ? 'Saving…' : 'Change password'} onPress={() => void submit()} />}>
      <Text style={[type.body, { color: colors.textMuted }]}>
        This phone stays signed in. Everywhere else, Deckino signs you out.
      </Text>
      <FormMessage message={form.message} />
      <Field
        label="Current password"
        value={current}
        onChangeText={setCurrent}
        error={form.fields.currentPassword}
        secret
        autoComplete="current-password"
        textContentType="password"
      />
      <Field
        label="New password"
        value={next}
        onChangeText={setNext}
        error={form.fields.newPassword}
        secret
        autoComplete="new-password"
        textContentType="newPassword"
        placeholder="At least 8 characters"
        onSubmitEditing={() => void submit()}
      />
    </FormScreen>
  );
}
