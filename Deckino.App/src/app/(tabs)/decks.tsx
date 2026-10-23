import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { cardCount } from '@/api/binders';
import { FORMATS, formatLabel, updated, useDecks, usePublicDecks, type DeckSummary } from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { ManaCost } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { Button, Chip, EmptyState, ErrorState, ListRow, Screen, SearchBox, Skeleton, usePullToRefresh } from '@/components/ui';
import { colors, radius } from '@/theme';

// Your decks, newest change first (AppPlan, Phase A6), and everyone's public decks (A8). Signed out it opens on
// Public: browsing needs no account. The view is in the route (/decks?view=yours), so a link can ask for one.
export default function DecksScreen() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const { view: chosen } = useLocalSearchParams<{ view?: 'yours' | 'public' }>();
  const view = chosen ?? (signedIn ? 'yours' : 'public'); // until one is chosen, follows signing in
  const setView = (next: 'yours' | 'public') => router.setParams({ view: next });
  return (
    <Screen title="Decks">
      <View style={styles.views}>
        <Chip label="Yours" selected={view === 'yours'} onPress={() => setView('yours')} />
        <Chip label="Public" selected={view === 'public'} onPress={() => setView('public')} />
      </View>
      {view === 'public' ? <PublicDecks /> : signedIn ? <Decks /> : <SignedOut />}
    </Screen>
  );
}

function SignedOut() {
  const router = useRouter();
  return (
    <EmptyState
      icon="style"
      title="Build decks on the go"
      body="Sign in to build decks, scan cards into them and check they're legal."
      action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
    />
  );
}

function Decks() {
  const router = useRouter();
  const decks = useDecks();
  const refreshControl = usePullToRefresh(decks.refetch);
  if (decks.isPending) return <Loading />;
  if (decks.isError && !decks.data) return <ErrorState message={decks.error.message} onRetry={() => void decks.refetch()} />;
  return (
    <FlatList
      data={decks.data}
      keyExtractor={(deck) => deck.id}
      contentContainerStyle={styles.content}
      refreshControl={refreshControl}
      ListHeaderComponent={
        <View style={styles.actions}>
          <Button
            label="New deck"
            icon="add"
            onPress={() => router.push('/deck/new')}
            style={styles.flex}
          />
          <Button
            label="Import a list"
            variant="secondary"
            icon="download"
            onPress={() => router.push('/import')}
            style={styles.flex}
          />
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          icon="style"
          title="Make your first deck"
          body="Pick a format, then add cards by scanning them or by name. Or import a list you already have."
        />
      }
      renderItem={({ item }) => <DeckRow deck={item} detail={`${formatLabel(item.format)} · ${cardCount(item.cardCount)} · ${updated(item.updatedAt)}`} />}
    />
  );
}

function PublicDecks() {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [format, setFormat] = useState('');
  const search = usePublicDecks(q, format);
  const refreshControl = usePullToRefresh(search.refetch);
  // Pages are by newest change: a deck edited while scrolling moves to an earlier page and would come twice.
  // ponytail: one may be skipped the same way; keyset paging on the API if that matters.
  const seen = new Set<string>();
  const decks = (search.data?.pages.flatMap((page) => page.decks) ?? []).filter(({ deck }) => !seen.has(deck.id) && !!seen.add(deck.id));
  // Searches after a pause in typing, as the Cards tab does.
  useEffect(() => {
    const wait = setTimeout(() => setQ(name.trim()), 350);
    return () => clearTimeout(wait);
  }, [name]);

  return (
    <>
      <SearchBox
        value={name}
        onChangeText={setName}
        onSubmit={() => setQ(name.trim())}
        placeholder="Search public decks"
        label="Deck name"
        style={{ marginHorizontal: 20 }}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.formats}
        keyboardShouldPersistTaps="handled"
        style={styles.formatsScroll}
      >
        <Chip label="Any format" selected={format === ''} onPress={() => setFormat('')} />
        {FORMATS.map((f) => (
          <Chip key={f.value} label={f.label} selected={format === f.value} onPress={() => setFormat(f.value)} />
        ))}
      </ScrollView>
      {search.isPending ? (
        <Loading />
      ) : search.isError && decks.length === 0 ? (
        <ErrorState message={search.error.message} onRetry={() => void search.refetch()} />
      ) : (
        <FlatList
          data={decks}
          keyExtractor={({ deck }) => deck.id}
          contentContainerStyle={styles.content}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Public decks"
          refreshControl={refreshControl}
          renderItem={({ item: { deck, owner } }) => (
            <DeckRow
              deck={deck}
              detail={`by ${owner} · ${formatLabel(deck.format)} · ${cardCount(deck.cardCount)} · ${updated(deck.updatedAt)}`}
              href={{ pathname: '/public/deck/[id]', params: { id: deck.id } }}
            />
          )}
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            // Not while the last search's pages stand in for the new one's: its first page is still coming.
            if (search.hasNextPage && !search.isFetchingNextPage && !search.isPlaceholderData) void search.fetchNextPage();
          }}
          ListEmptyComponent={
            <EmptyState
              icon="search_off"
              title="No public decks found"
              body={q || format ? 'Try another name or format.' : 'Nobody has made a deck public yet.'}
            />
          }
          ListFooterComponent={
            search.isFetchingNextPage ? (
              <ActivityIndicator color={colors.lavender} style={styles.more} />
            ) : search.isFetchNextPageError ? (
              <Button label="Couldn't load more. Try again" variant="secondary" onPress={() => void search.fetchNextPage()} style={styles.more} />
            ) : null
          }
        />
      )}
    </>
  );
}

function Loading() {
  return (
    <View style={styles.content}>
      <Skeleton style={{ height: 56 }} />
      <Skeleton style={{ height: 56 }} />
      <Skeleton style={{ height: 56 }} />
    </View>
  );
}

function DeckRow({ deck, detail, href = `/deck/${deck.id}` }: { deck: DeckSummary; detail: string; href?: Href }) {
  const router = useRouter();
  return (
    <ListRow
      leading={
        <View style={styles.art}>
          {deck.cover ? (
            <Image source={{ uri: deck.cover }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <Icon name="style" size={22} tintColor={colors.lavender} />
          )}
        </View>
      }
      title={deck.name}
      detail={detail}
      trailing={<ManaCost cost={deck.colorIdentity.map((c) => `{${c}}`).join('')} size={16} />}
      onPress={() => {
        Keyboard.dismiss();
        router.push(href);
      }}
    />
  );
}

const styles = StyleSheet.create({
  views: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingBottom: 12 },
  content: { paddingHorizontal: 20, paddingBottom: 140, gap: 4 },
  actions: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  flex: { flex: 1 },
  formatsScroll: { flexGrow: 0, flexShrink: 0 }, // a ScrollView shrinks by default: the list below would squeeze it
  formats: { gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  more: { marginVertical: 16 },
  art: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
    overflow: 'hidden',
  },
});
