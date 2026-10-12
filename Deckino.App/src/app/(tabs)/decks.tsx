import { useRouter } from 'expo-router';

import { EmptyState, Screen } from '@/components/ui';

export default function DecksScreen() {
  const router = useRouter();
  return (
    <Screen title="Decks">
      <EmptyState
        icon={{ ios: 'square.stack.3d.up', android: 'stacks' }}
        title="Build decks on the go"
        body="Your decks arrive here in an update soon. Until then, look up any card in the catalogue."
        action={{ label: 'Browse cards', onPress: () => router.navigate('/cards') }}
      />
    </Screen>
  );
}
