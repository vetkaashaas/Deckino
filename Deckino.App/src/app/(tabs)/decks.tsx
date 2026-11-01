import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { SlideInLeft, SlideInRight } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { FORMATS, formatLabel, updated, useDecks, usePublicDecks } from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { ART, DeckTile } from '@/components/deck-tile';
import { Icon } from '@/components/icon';
import { Button, Chip, EmptyState, ErrorState, Screen, SearchBox, Sheet, Skeleton, usePullToRefresh } from '@/components/ui';
import { colors, fonts, gradients } from '@/theme';

const GAP = 12;
const SIDE = 20;

// Your decks, newest change first (AppPlan, Phase A6), and everyone's public decks (A8), both as tiles of their cover
// art. Signed out it opens on Public: browsing needs no account. The view is in the route (/decks?view=yours), so a
// link can ask for one. Two tabs, and a swipe across the list goes to the other one.
export default function DecksScreen() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const { view: chosen } = useLocalSearchParams<{ view?: 'yours' | 'public' }>();
  const view = chosen ?? (signedIn ? 'yours' : 'public'); // until one is chosen, follows signing in
  const [moved, setMoved] = useState(false); // by a tab or a swipe: the view slides in from its side
  const setView = (next: 'yours' | 'public') => {
    if (next === view) return;
    setMoved(true);
    router.setParams({ view: next });
  };
  // Sideways only: an up-and-down drag stays the list's scroll.
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-20, 20])
    .failOffsetY([-12, 12])
    .onEnd(({ translationX }) => {
      if (translationX < -60) setView('public');
      else if (translationX > 60) setView('yours');
    });
  // One format for both views, chosen in a sheet as the Cards tab's filters are.
  const [format, setFormat] = useState('');
  const [choosing, setChoosing] = useState(false);
  const label = format ? formatLabel(format) : 'Format';
  return (
    <Screen title="Decks">
      <View style={styles.views} accessibilityRole="tablist">
        {(['yours', 'public'] as const).map((v) => (
          <Pressable
            key={v}
            onPress={() => setView(v)}
            accessibilityRole="tab"
            accessibilityState={{ selected: view === v }}
            hitSlop={8}
            style={({ pressed }) => [styles.tab, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.tabLabel, view === v && styles.tabLabelSelected]}>{v === 'yours' ? 'Yours' : 'Public'}</Text>
            <View style={[styles.tabLine, view === v && styles.tabLineSelected]} />
          </Pressable>
        ))}
        {view === 'public' || signedIn ? (
          <View style={styles.filter}>
            <Chip
              label={
                <>
                  <Icon name="filter_list" size={18} tintColor={format ? colors.text : colors.textMuted} />
                  <Text style={[styles.filterLabel, format !== '' && styles.filterLabelSelected]}>{label}</Text>
                </>
              }
              selected={format !== ''}
              accessibilityLabel={`Format: ${format ? label : 'any'}`}
              onPress={() => {
                Keyboard.dismiss();
                setChoosing(true);
              }}
            />
          </View>
        ) : null}
      </View>
      <Sheet visible={choosing} title="Format" onClose={() => setChoosing(false)}>
        <View style={styles.options}>
          <Chip label="Any format" selected={format === ''} onPress={() => setFormat('')} />
          {FORMATS.map((f) => (
            <Chip key={f.value} label={f.label} selected={format === f.value} onPress={() => setFormat(f.value)} />
          ))}
        </View>
      </Sheet>
      <GestureDetector gesture={swipe}>
        <Animated.View
          key={view}
          style={styles.flex}
          entering={moved ? (view === 'public' ? SlideInRight : SlideInLeft).duration(220) : undefined}
        >
          {view === 'public' ? <PublicDecks format={format} /> : signedIn ? <Decks format={format} /> : <SignedOut />}
        </Animated.View>
      </GestureDetector>
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

function Decks({ format }: { format: string }) {
  const router = useRouter();
  const decks = useDecks();
  const refreshControl = usePullToRefresh(decks.refetch);
  const width = useTileWidth();
  if (decks.isPending) return <Loading />;
  if (decks.isError && !decks.data) return <ErrorState message={decks.error.message} onRetry={() => void decks.refetch()} />;
  const shown = format ? decks.data.filter((deck) => deck.format === format) : decks.data;
  return (
    <FlatList
      data={shown}
      keyExtractor={(deck) => deck.id}
      numColumns={2}
      columnWrapperStyle={styles.row}
      contentContainerStyle={styles.content}
      refreshControl={refreshControl}
      ListHeaderComponent={
        <View style={styles.actions}>
          <Button label="New deck" icon="add" onPress={() => router.push('/deck/new')} style={styles.flex} />
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
        decks.data.length > 0 ? (
          <EmptyState icon="search_off" title={`No ${formatLabel(format)} decks`} body="Pick another format." />
        ) : (
          <EmptyState
            icon="style"
            title="Make your first deck"
            body="Pick a format, then add cards by scanning them or by name. Or import a list you already have."
          />
        )
      }
      renderItem={({ item }) => <DeckTile deck={item} width={width} byline={updated(item.updatedAt)} />}
    />
  );
}

function PublicDecks({ format }: { format: string }) {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const search = usePublicDecks(q, format);
  const refreshControl = usePullToRefresh(search.refetch);
  const width = useTileWidth();
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
        style={{ marginHorizontal: SIDE, marginTop: 12 }}
      />
      {search.isPending ? (
        <Loading />
      ) : search.isError && decks.length === 0 ? (
        <ErrorState message={search.error.message} onRetry={() => void search.refetch()} />
      ) : (
        <FlatList
          data={decks}
          keyExtractor={({ deck }) => deck.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.content}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Public decks"
          refreshControl={refreshControl}
          renderItem={({ item: { deck, owner } }) => (
            <DeckTile
              deck={deck}
              width={width}
              byline={`by ${owner}`}
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

// Two tiles across the screen, whatever its width.
function useTileWidth() {
  const { width } = useWindowDimensions();
  return (width - SIDE * 2 - GAP) / 2;
}

function Loading() {
  const width = useTileWidth();
  return (
    <View style={[styles.content, styles.row]}>
      <Skeleton style={{ width, aspectRatio: ART }} />
      <Skeleton style={{ width, aspectRatio: ART }} />
    </View>
  );
}

const styles = StyleSheet.create({
  views: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    marginHorizontal: SIDE,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  tab: { paddingTop: 8, gap: 8 },
  tabLabel: { fontFamily: fonts.body, fontSize: 16, fontWeight: '600', color: colors.textMuted, paddingHorizontal: 2 },
  tabLabelSelected: { color: colors.text },
  tabLine: { height: 3, borderRadius: 2, marginBottom: -1 }, // over the row's own line
  tabLineSelected: { experimental_backgroundImage: gradients.brand },
  filter: { flex: 1, alignItems: 'flex-end', paddingBottom: 6 },
  filterLabel: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 14 },
  filterLabelSelected: { color: colors.text, fontWeight: '600' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  content: { paddingHorizontal: SIDE, paddingTop: 12, paddingBottom: 140, gap: 20 },
  row: { gap: GAP },
  actions: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  more: { marginVertical: 16 },
});
