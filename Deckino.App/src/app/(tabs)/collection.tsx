import { useRouter } from 'expo-router';

import { EmptyState, Screen } from '@/components/ui';

export default function CollectionScreen() {
  const router = useRouter();
  return (
    <Screen title="Collection">
      <EmptyState
        icon={{ ios: 'books.vertical', android: 'collections_bookmark' }}
        title="Your binders, in your pocket"
        body="Signing in to see and fill your binders arrives in an update soon. Until then, scan a card to find out what it is."
        action={{ label: 'Scan a card', onPress: () => router.navigate('/scan') }}
      />
    </Screen>
  );
}
