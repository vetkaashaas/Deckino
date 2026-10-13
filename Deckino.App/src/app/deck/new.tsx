import { useState } from 'react';
import { useRouter } from 'expo-router';

import { createDeck } from '@/api/decks';
import { Field, FormMessage, FormScreen, useSubmit } from '@/components/form';
import { FormatChoice } from '@/components/format-choice';
import { Button } from '@/components/ui';

// A new deck needs a name and a format (Commander unless you pick another).
export default function NewDeckScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [format, setFormat] = useState('commander');
  const form = useSubmit();

  async function submit() {
    let id = '';
    if (await form.submit(async () => void (id = (await createDeck(name.trim(), format)).id))) {
      router.replace({ pathname: '/deck/[id]', params: { id } });
    }
  }

  return (
    <FormScreen actions={<Button label={form.busy ? 'Creating…' : 'Create deck'} onPress={() => void submit()} />}>
      <FormMessage message={form.message} />
      <Field
        label="Deck name"
        value={name}
        onChangeText={setName}
        error={form.fields.name}
        autoCapitalize="sentences"
        autoFocus
        maxLength={100}
      />
      <FormatChoice value={format} onChange={setFormat} />
    </FormScreen>
  );
}
