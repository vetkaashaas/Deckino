import { useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { File } from 'expo-file-system';
import { clearSharedPayloads, useIncomingShare } from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cardCount } from '@/api/binders';
import {
  countCards,
  createImportedDeck,
  previewImport,
  SECTIONS,
  sectionLabel,
  suggestedCommander,
  type ImportLine,
  type SectionName,
} from '@/api/decks';
import { useSignedIn } from '@/api/session';
import { Field, FormMessage, useSubmit } from '@/components/form';
import { FormatChoice } from '@/components/format-choice';
import { editImportLine } from '@/components/import-edit';
import { finishLabel, type SheetValues } from '@/components/card-sheet';
import { Icon } from '@/components/icon';
import { CardImage } from '@/components/card-visuals';
import { isSharedList } from '@/components/share-file';
import { showToast } from '@/components/toast';
import { Backdrop, Button, Chip, EmptyState } from '@/components/ui';
import { colors, fonts, radius, type } from '@/theme';

// Import a decklist (AppPlan, Phase A8), in the website's two steps: paste it, choose a file or share one to Deckino,
// then review what matched before the deck is made. A line that didn't match is dropped, or fixed in the text.
export default function ImportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const signedIn = useSignedIn();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [format, setFormat] = useState('commander');
  const [text, setText] = useState('');
  const [lines, setLines] = useState<ImportLine[] | null>(null);
  const [commanderLine, setCommanderLine] = useState<number | null>(null);
  const form = useSubmit();
  // The API names the list's field (text, cards…); there is one box to show it in, and the name's under its field
  // (the review has no name field, so there it's in the box too).
  const problem =
    form.message ?? Object.entries(form.fields).find(([field]) => lines !== null || field !== 'name')?.[1] ?? null;

  // A list shared to Deckino as text arrives here through shared-scan.tsx.
  const { resolvedSharedPayloads } = useIncomingShare();
  const shared = resolvedSharedPayloads.find(isSharedList);
  useEffect(() => {
    if (!shared) return;
    setText(shared.value);
    setLines(null); // back from a review of another list
    clearSharedPayloads();
  }, [shared]);

  async function choose() {
    try {
      const picked = await File.pickFileAsync({ mimeTypes: ['text/*', 'application/octet-stream'] });
      if (picked.canceled) return;
      setText(await picked.result.text());
      setName((current) => current || picked.result.name.replace(/\.[^.]+$/, '').slice(0, 100)); // the field's limit
    } catch {
      showToast({ message: "Deckino couldn't read that file. Paste the list instead." });
    }
  }

  async function paste() {
    const copied = await Clipboard.getStringAsync();
    if (copied.trim()) setText(copied);
    else showToast({ message: 'Nothing to paste. Copy the decklist first.' });
  }

  async function review() {
    // Asked before the review, where the name can't be changed.
    if (!name.trim()) return setNameError('Give the deck a name.');
    setNameError(null);
    let parsed: ImportLine[] = [];
    if (await form.submit(async () => void (parsed = await previewImport(text)))) {
      setLines(parsed);
      setCommanderLine(suggestedCommander(parsed, format));
    }
  }

  async function create() {
    let id = '';
    if (await form.submit(async () => void (id = (await createImportedDeck(lines!, name, format, commanderLine)).id))) {
      router.replace(`/deck/${id}`);
    }
  }

  // A row opens the card sheet, as a deck row does: the printing, foil or not, copies, and which part of the deck.
  function edit(item: ImportLine) {
    const card = item.card!;
    const commander = format === 'commander' && (card.canBeCommander || !!card.typeLine?.includes('Background'));
    const section =
      item.line === commanderLine ? 'commander' : SECTIONS.includes(item.section as SectionName) ? item.section : 'mainboard';
    editImportLine({
      line: item,
      section,
      sections: [
        ...(commander || section === 'commander' ? [{ value: 'commander', label: 'Commander' }] : []),
        { value: 'mainboard', label: sectionLabel('mainboard', format) },
        { value: 'sideboard', label: sectionLabel('sideboard', format) },
      ],
      save: (values: SheetValues) => {
        setLines((current) =>
          current!.map((l) =>
            l.line === item.line
              ? { ...l, card: { ...card, ...values.printing }, finish: values.finish!, quantity: values.copies, section: values.section!, note: null }
              : l,
          ),
        );
        // The sheet now says where it goes, not the suggestion.
        if (values.section === 'commander' || item.line === commanderLine) setCommanderLine(null);
      },
      remove: () => {
        const index = lines!.indexOf(item);
        setLines((current) => current!.filter((l) => l !== item));
        showToast({
          message: `Removed ${card.name}`,
          undo: () => setLines((current) => [...current!.slice(0, index), item, ...current!.slice(index)]),
        });
      },
    });
    router.push('/import-card');
  }

  if (!signedIn) {
    return (
      <View style={styles.screen}>
        <EmptyState
          icon="download"
          title="Sign in to import a deck"
          body="The deck goes into your account, next to the ones you make here or on deckino.com."
          action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
        />
      </View>
    );
  }

  if (lines === null) {
    return (
      <KeyboardAvoidingView style={styles.screen} behavior="height">
        <Stack.Screen options={{ title: 'Import a deck' }} />
        <Backdrop />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[type.body, { color: colors.textMuted }]}>
            Paste a decklist, or choose a text file exported from Arena, MTGO, Moxfield, Archidekt or TappedOut.
          </Text>
          <FormMessage message={problem} />
          <Field
            label="Deck name"
            value={name}
            onChangeText={setName}
            error={nameError ?? form.fields.name}
            autoCapitalize="sentences"
            maxLength={100}
          />
          <FormatChoice value={format} onChange={setFormat} />
          <View style={styles.field}>
            <View style={styles.labelRow}>
              <Text style={[type.label, styles.flex]}>Decklist</Text>
              <Pressable onPress={() => void paste()} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.link}>Paste</Text>
              </Pressable>
              <Pressable onPress={() => void choose()} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.link}>Choose a file</Text>
              </Pressable>
            </View>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              textAlignVertical="top"
              placeholder={"Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n4 Lightning Bolt"}
              placeholderTextColor={colors.textDim}
              selectionColor={colors.lavender}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Decklist"
              style={styles.list}
            />
          </View>
        </ScrollView>
        {/* Outside the scroll, so a long list never pushes it out of sight. */}
        <View style={[styles.bar, styles.fixed, { paddingBottom: 12 + insets.bottom }]}>
          <Button label={form.busy ? 'Reading…' : 'Review import'} disabled={!text.trim()} onPress={() => void review()} />
        </View>
      </KeyboardAvoidingView>
    );
  }

  const unresolved = lines.filter((l) => !l.card);
  const ready = countCards(lines.filter((l) => l.card));
  const legendary = format === 'commander' && !lines.some((l) => l.section === 'commander')
    ? lines.filter((l) => l.card?.typeLine?.includes('Legendary'))
    : [];
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Review import' }} />
      <FlatList
        data={lines}
        keyExtractor={(l) => String(l.line)}
        contentContainerStyle={[styles.review, { paddingBottom: 140 + insets.bottom }]}
        ListHeaderComponent={
          <View style={styles.fields}>
            <FormMessage message={problem} />
            <Text style={type.body} accessibilityRole="summary">
              {cardCount(ready)} ready
              {unresolved.length > 0 ? ` · ${unresolved.length} ${unresolved.length === 1 ? 'line' : 'lines'} not found` : ''}
            </Text>
            {legendary.length > 0 ? (
              <View style={styles.field}>
                <Text style={type.label}>Commander (the list doesn't say)</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                  <Chip label="None" selected={commanderLine === null} onPress={() => setCommanderLine(null)} />
                  {legendary.map((l) => (
                    <Chip key={l.line} label={l.card!.name} selected={commanderLine === l.line} onPress={() => setCommanderLine(l.line)} />
                  ))}
                </ScrollView>
              </View>
            ) : null}
            <Pressable onPress={() => setLines(null)} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.link}>Edit the list</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) =>
          item.card ? (
            <Pressable
              onPress={() => edit(item)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.line, pressed && { opacity: 0.8 }]}
            >
              <Text style={styles.quantity}>{item.quantity}×</Text>
              {/* The printing that will go in the deck, big enough to tell the art apart. */}
              <View style={styles.thumb}>
                <CardImage uri={item.card.image ?? item.card.smallImage} placeholder={item.card.smallImage} name="" />
              </View>
              <View style={styles.flex}>
                <Text style={[type.body, { fontWeight: '500' }]} numberOfLines={1}>
                  {item.card.name}
                </Text>
                <Text style={type.label} numberOfLines={1}>
                  {[
                    item.line === commanderLine || item.section === 'commander' ? 'Commander' : item.section === 'sideboard' ? 'Sideboard' : null,
                    `${item.card.setCode.toUpperCase()} #${item.card.collectorNumber}`,
                    item.finish === 'nonfoil' ? null : finishLabel(item.finish),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
              </View>
              <Icon name="chevron_right" size={20} tintColor={colors.textDim} />
            </Pressable>
          ) : (
            <View style={[styles.line, styles.unresolved]}>
              <View style={styles.flex}>
                <Text style={[type.body, styles.source]}>{item.text}</Text>
                <Text style={styles.problem}>{item.problem}</Text>
              </View>
              <Pressable
                onPress={() => setLines(lines.filter((l) => l !== item))}
                accessibilityRole="button"
                accessibilityLabel={`Drop line ${item.line}`}
                hitSlop={8}
              >
                <Text style={styles.link}>Drop</Text>
              </Pressable>
            </View>
          )
        }
      />
      <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
        {unresolved.length > 0 ? (
          <Button
            label={`Drop ${unresolved.length} ${unresolved.length === 1 ? 'line' : 'lines'} not found`}
            variant="secondary"
            onPress={() => setLines(lines.filter((l) => l.card))}
          />
        ) : (
          <Button label={form.busy ? 'Creating…' : 'Create deck'} onPress={() => (ready > 0 ? void create() : setLines(null))} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 16 },
  fields: { gap: 16, marginBottom: 8 },
  field: { gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  list: {
    minHeight: 200,
    maxHeight: 320, // a long list scrolls inside, the fields under it stay close
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surface,
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.text,
  },
  review: { padding: 20, gap: 4 },
  chips: { gap: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  unresolved: { paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: 'rgba(255, 90, 122, 0.10)' },
  quantity: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '700', color: colors.lavender, minWidth: 32 },
  thumb: { width: 64 },
  flex: { flex: 1 },
  source: { fontFamily: fonts.body },
  problem: { fontFamily: fonts.body, fontSize: 13, color: colors.violet },
  note: { fontFamily: fonts.body, fontSize: 13, color: colors.warning },
  link: { fontFamily: fonts.body, fontSize: 15, fontWeight: '700', color: colors.lavender },
  fixed: { position: 'relative' }, // below the scroll, rising with the keyboard
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
