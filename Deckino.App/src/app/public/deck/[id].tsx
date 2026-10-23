import { useEffect, useState } from 'react';
import { Pressable, SectionList, Share, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccount } from '@/api/account';
import { ApiError } from '@/api/client';
import { copyDeck, exportPublicDeck, publicDeckUrl, useDecks, usePublicDeck, type DeckDetail } from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { DeckFacts, deckParts, EntryRow, PartTitle } from '@/components/deck-parts';
import { Icon } from '@/components/icon';
import { fileName, shareFile } from '@/components/share-file';
import { attempt, showToast } from '@/components/toast';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { ambient, colors, fonts, type } from '@/theme';

// Someone's public deck, from Decks › Public or a deckino.com/deck link (AppPlan, Phase A8): read-only, with one main
// action, Copy to my decks. The owner is sent on to their own deck screen.
export default function PublicDeckScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const found = usePublicDeck(id);
  const account = useAccount();
  const username = account.data?.username;
  // Theirs even when it's private now (a 404 here, so only then): their own deck list has it.
  const gone = found.error instanceof ApiError && found.error.status === 404;
  const mineQuery = useDecks(gone);
  const mine = mineQuery.data;
  const own = (found.data !== undefined && found.data.owner === username) || (mine?.some((d) => d.id === id) ?? false);
  useEffect(() => {
    if (own) router.replace(`/deck/${id}`);
  }, [own, id, router]);

  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      <Stack.Screen
        options={{
          title: found.data?.deck.name ?? '',
          headerRight: () =>
            found.data ? (
              <Pressable
                onPress={() => void Share.share({ message: publicDeckUrl(id) })}
                accessibilityRole="button"
                accessibilityLabel="Share link"
                hitSlop={12}
              >
                <Icon name="share" size={22} tintColor={colors.text} />
              </Pressable>
            ) : null,
        }}
      />
      {found.isPending || own || mineQuery.isLoading || account.isLoading ? (
        <View style={styles.list}>
          <Skeleton style={{ height: 120 }} />
          <Skeleton style={{ height: 56 }} />
          <Skeleton style={{ height: 56 }} />
        </View>
      ) : found.isError && !found.data ? (
        found.error instanceof ApiError && found.error.status === 404 ? (
          <EmptyState
            icon="visibility_off"
            title="Deck not found"
            body="There's no public deck here. Its owner may have made it private."
          />
        ) : (
          <ErrorState message={found.error.message} onRetry={() => void found.refetch()} />
        )
      ) : (
        <Deck id={id} owner={found.data.owner} legality={found.data.legality} deck={found.data.deck} />
      )}
    </View>
  );
}

function Deck({ id, owner, legality, deck }: { id: string; owner: string; legality: string[]; deck: DeckDetail }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const signedIn = useSignedIn();
  const [copying, setCopying] = useState(false);

  async function copy() {
    if (copying) return;
    setCopying(true);
    let created: Awaited<ReturnType<typeof copyDeck>> | undefined;
    if (await attempt(async () => void (created = await copyDeck(deck)))) {
      router.replace(`/deck/${created!.id}`);
      showToast({ message: `Copied to your decks as ${created!.name}` });
    }
    setCopying(false);
  }

  async function shareList() {
    await attempt(async () =>
      shareFile(fileName(deck.name, 'txt'), await exportPublicDeck(id), 'text/plain'),
    );
  }

  return (
    <>
      <SectionList
        sections={deckParts(deck)}
        keyExtractor={(entry) => `${entry.scryfallId}-${entry.finish}`}
        contentContainerStyle={[styles.list, { paddingBottom: 120 + insets.bottom }]}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <DeckFacts deck={deck} warnings={legality} />
            <View style={styles.row}>
              <Text style={[type.body, styles.flex, { color: colors.textMuted }]}>by {owner}</Text>
              <Pressable onPress={() => void shareList()} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.link}>Share the decklist</Text>
              </Pressable>
            </View>
          </View>
        }
        renderSectionHeader={({ section }) => <PartTitle title={section.title} />}
        renderItem={({ item }) => <EntryRow entry={item} onPress={() => router.push(`/card/${item.scryfallId}`)} />}
      />
      <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
        {signedIn ? (
          <Button
            label={copying ? 'Copying…' : 'Copy to my decks'}
            icon="library_add"
            onPress={() => void copy()}
          />
        ) : (
          <Button label="Sign in to copy this deck" onPress={() => router.push('/sign-in')} />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  list: { padding: 20, gap: 4 },
  header: { gap: 12, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  link: { fontFamily: fonts.body, fontSize: 15, fontWeight: '700', color: colors.lavender },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: 'rgba(11, 6, 16, 0.94)',
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
});
