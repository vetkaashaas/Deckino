import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
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
// link can ask for one. Two tabs, and the views sit side by side: a swipe drags the other one in.
export default function DecksScreen() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const { width } = useWindowDimensions();
  const { view: chosen } = useLocalSearchParams<{ view?: 'yours' | 'public' }>();
  const view = chosen ?? (signedIn ? 'yours' : 'public'); // until one is chosen, follows signing in
  const setView = (next: 'yours' | 'public') => {
    if (next !== view) router.setParams({ view: next });
  };
  // The two views side by side: a sideways drag moves them with the finger and snaps to one, and the tabs follow it.
  const pager = useAnimatedRef<Animated.ScrollView>();
  const offset = view === 'public' ? width : 0;
  const x = useSharedValue(offset);
  const onScroll = useAnimatedScrollHandler((event) => {
    x.value = event.contentOffset.x;
  });
  // A tab, a link (/decks?view=public) or signing in changes the view: the pager goes there.
  useEffect(() => {
    pager.current?.scrollTo({ x: offset, animated: true });
  }, [offset, pager]);
  // One format for both views, chosen in a sheet as the Cards tab's filters are.
  const [format, setFormat] = useState('');
  const [choosing, setChoosing] = useState(false);
  const label = format ? formatLabel(format) : 'Format';
  return (
    <Screen title="Decks">
      <View style={styles.views} accessibilityRole="tablist">
        {(['yours', 'public'] as const).map((v, at) => (
          <ViewTab key={v} label={v === 'yours' ? 'Yours' : 'Public'} at={at} selected={view === v} x={x} width={width} onPress={() => setView(v)} />
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
      <Animated.ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={() => pager.current?.scrollTo({ x: offset, animated: false })} // opens on the chosen view
        onMomentumScrollEnd={(event) => setView(event.nativeEvent.contentOffset.x > width / 2 ? 'public' : 'yours')}
        style={styles.flex}
      >
        <View style={{ width }}>{signedIn ? <Decks format={format} /> : <SignedOut />}</View>
        <View style={{ width }}>
          <PublicDecks format={format} />
        </View>
      </Animated.ScrollView>
    </Screen>
  );
}

// Bright with its line while its view is on screen, dimming as the other one slides in.
function ViewTab({
  label,
  at,
  selected,
  x,
  width,
  onPress,
}: {
  label: string;
  at: number;
  selected: boolean;
  x: SharedValue<number>;
  width: number;
  onPress: () => void;
}) {
  const text = useAnimatedStyle(() => ({
    color: interpolateColor(x.value / width, [at - 1, at, at + 1], [colors.textMuted, colors.text, colors.textMuted]),
  }));
  const line = useAnimatedStyle(() => ({
    opacity: interpolate(x.value / width, [at - 1, at, at + 1], [0, 1, 0], Extrapolation.CLAMP),
  }));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      hitSlop={8}
      style={({ pressed }) => [styles.tab, pressed && { opacity: 0.7 }]}
    >
      <Animated.Text style={[styles.tabLabel, text]}>{label}</Animated.Text>
      <Animated.View style={[styles.tabLine, line]} />
    </Pressable>
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
  tabLine: { height: 3, borderRadius: 2, marginBottom: -1, experimental_backgroundImage: gradients.brand }, // over the row's own line
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
