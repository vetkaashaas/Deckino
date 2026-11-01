import { useRouter } from 'expo-router';

import { CardSheet } from '@/components/card-sheet';
import { importEdit } from '@/components/import-edit';

// The card sheet for a line of an import being reviewed (the same sheet as a deck row): printing, finish, copies and
// which part of the deck. Nothing is saved until the deck is made.
export default function ImportCardScreen() {
  const router = useRouter();
  const edit = importEdit();
  if (!edit?.line.card) return null;
  const { line } = edit;
  return (
    <CardSheet
      initial={{ printing: line.card!, finish: line.finish, copies: line.quantity, section: edit.section }}
      unchecked={false}
      removeLabel="Remove from list"
      sections={edit.sections}
      maxCopies={(values) => (values.section === 'commander' ? 1 : 99)}
      onSave={(values) => {
        edit.save(values);
        router.back();
      }}
      onRemove={() => {
        router.back();
        edit.remove();
      }}
    />
  );
}
