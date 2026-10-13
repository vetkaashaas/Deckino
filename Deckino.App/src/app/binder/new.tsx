import { useState } from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { createBinder } from '@/api/binders';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { Button } from '@/components/ui';
import { setPreferences } from '@/preferences';
import { colors, type } from '@/theme';

// A new binder needs only a name. `then`: open it (from Collection), go back (from Move), or make it where the
// scanner saves (from the scan tray).
export default function NewBinderScreen() {
  const { then = 'open' } = useLocalSearchParams<{ then?: 'open' | 'back' | 'scan' }>();
  const router = useRouter();
  const [name, setName] = useState('');
  const form = useSubmit();

  async function submit() {
    let id = '';
    const created = await form.submit(async () => {
      id = (await createBinder(name.trim())).id;
    });
    if (!created) return;
    if (then === 'open') {
      router.replace({ pathname: '/binder/[id]', params: { id } });
      return;
    }
    if (then === 'scan') {
      setPreferences({ defaultBinderId: id });
      router.dismiss(2); // and the binder list it came from: back to the scanned cards
      return;
    }
    router.back();
  }

  return (
    <FormScreen actions={<Button label={form.busy ? 'Creating…' : 'Create binder'} onPress={() => void submit()} />}>
      <Text style={[type.body, { color: colors.textMuted }]}>Name it after what’s in it, like Trades or Red deck.</Text>
      <FormMessage message={form.message} />
      <Field
        label="Binder name"
        value={name}
        onChangeText={setName}
        error={form.fields.name}
        autoCapitalize="sentences"
        autoFocus
        maxLength={100}
        onSubmitEditing={() => void submit()}
      />
    </FormScreen>
  );
}
