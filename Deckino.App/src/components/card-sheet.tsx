import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { copyPrice, finishFor, type BinderPrinting, type Condition, type Finish } from '@/api/binders';
import type { Printing } from '@/api/cards';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { PrintingButton } from '@/components/printing-picker';
import { Backdrop, Button, Chip, Sheet } from '@/components/ui';
import { CONDITIONS, LANGUAGES, usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

// The one place a card is changed (AGENTS.md: one way to do a thing): a binder row, a scan-tray row and a deck row
// all open it, and a wishlist row. Condition and language are for cards you own (not in decks), the finish for cards
// you own or play (not wanted ones); `sections` is for deck cards, `move` for a binder's row (beside Save). Removing
// is a quiet link under them, as a removal can be undone.

export interface SheetValues {
  printing: BinderPrinting;
  copies: number;
  finish?: Finish;
  condition?: Condition;
  language?: string;
  section?: string;
}

const FINISH_LABELS: Record<Finish, string> = { nonfoil: 'Non-foil', foil: 'Foil', etched: 'Etched' };
export const finishLabel = (finish: Finish) => FINISH_LABELS[finish];

export function CardSheet({
  initial,
  unchecked,
  removeLabel,
  onSave,
  onRemove,
  move,
  sections,
  maxCopies = () => 99,
}: {
  initial: SheetValues;
  /** A scanned card nobody has checked: say so above the printings. */
  unchecked: boolean;
  removeLabel: string;
  onSave: (values: SheetValues) => void;
  onRemove: () => void;
  move?: () => void;
  sections?: { value: string; label: string }[];
  /** The most copies allowed with these values (a commander is one card). */
  maxCopies?: (values: SheetValues) => number;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currency } = usePreferences();
  const [values, setValues] = useState(initial);
  const change = (next: Partial<SheetValues>) => setValues((current) => ({ ...current, ...next }));
  const { printing } = values;
  const price = copyPrice(printing.prices, values.finish ?? finishFor(printing.finishes, 'nonfoil'), currency);
  const most = maxCopies(values);

  function choosePrinting(next: Printing) {
    change({
      printing: { ...printing, ...next, name: printing.name, smallImage: next.smallImage ?? next.image },
      // Keep the finish when the new printing comes in it.
      finish: values.finish && finishFor(next.finishes, values.finish),
    });
  }

  // The rules, every price and the price history are on the card's own page; this sheet is for your copy of it.
  const details = () => router.push(`/card/${printing.id}`);

  return (
    <View style={styles.screen}>
      <Backdrop />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}>
        <View style={styles.head}>
          {/* The other printings right under the picture they'd replace. */}
          <View style={styles.pictureColumn}>
            <Pressable
              onPress={details}
              accessibilityRole="button"
              accessibilityLabel={`${printing.name}, card details`}
              style={({ pressed }) => [styles.picture, pressed && { opacity: 0.85 }]}
            >
              <CardImage uri={printing.image} name={printing.name} />
            </Pressable>
            <PrintingButton id={printing.id} compact onChoose={choosePrinting} />
          </View>
          <View style={styles.headText}>
            <Text style={type.heading} accessibilityRole="header">
              {printing.name}
            </Text>
            <SetSymbol
              setCode={printing.setCode}
              rarity={printing.rarity}
              size={18}
              withCode
              detail={`${printing.setName} #${printing.collectorNumber}`}
            />
            <Text style={styles.price}>{formatPrice(price, currency)}</Text>
            {values.copies > 1 && price !== null ? (
              <Text style={type.label}>
                each · {formatPrice(price * values.copies, currency)} for {values.copies}
              </Text>
            ) : null}
            <Pressable onPress={details} accessibilityRole="button" hitSlop={8} style={styles.details}>
              <Text style={styles.detailsLabel}>Card details</Text>
              <Icon name="chevron_right" size={18} tintColor={colors.violet} />
            </Pressable>
          </View>
        </View>

        {unchecked ? (
          <Text style={[type.label, styles.hint]}>
            Some printings share this picture. Pick the one whose set symbol matches your card.
          </Text>
        ) : null}

        <View style={styles.panel}>
          {sections && values.section ? (
            <Choice title="Part of the deck" options={sections} value={values.section} onChange={(section) => change({ section })} />
          ) : null}

          {values.condition ? (
            <Choice title="Condition" options={CONDITIONS} value={values.condition} onChange={(condition) => change({ condition })} />
          ) : null}

          {values.finish && printing.finishes.length > 1 ? (
            <Choice
              title="Finish"
              options={printing.finishes.map((finish) => ({ value: finish, label: finishLabel(finish) }))}
              value={values.finish}
              onChange={(finish) => change({ finish })}
            />
          ) : null}

          {values.language ? (
            <Choice title="Language" options={LANGUAGES} value={values.language} onChange={(language) => change({ language })} />
          ) : null}

          {/* A row of its own: the label on the left, the count on the right. */}
          <View style={styles.copies}>
            <Text style={type.label} accessibilityRole="header">
              Copies
            </Text>
            <View style={styles.stepper}>
              <StepButton
                label="One fewer copy"
                icon="remove"
                disabled={values.copies <= 1}
                onPress={() => change({ copies: values.copies - 1 })}
              />
              <Text style={styles.count} accessibilityLabel={`${values.copies} copies`}>
                {values.copies}
              </Text>
              <StepButton
                label="One more copy"
                icon="add"
                disabled={values.copies >= most}
                onPress={() => change({ copies: values.copies + 1 })}
              />
            </View>
          </View>
        </View>

        <View style={styles.actions}>
          <Button label="Save" onPress={() => onSave({ ...values, copies: Math.min(values.copies, most) })} style={styles.flex} />
          {move ? <Button label="Move" variant="secondary" icon="drive_file_move" onPress={move} style={styles.flex} /> : null}
        </View>
        <Pressable onPress={onRemove} accessibilityRole="button" hitSlop={8} style={({ pressed }) => [styles.remove, pressed && { opacity: 0.7 }]}>
          <Icon name="delete" size={18} tintColor={colors.danger} />
          <Text style={styles.removeLabel}>{removeLabel}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// A row with the current value; a tap opens the choices in a sheet, as the Cards filters and the Decks format do, and
// picking one closes it. Most people keep the defaults, so the rows stay short.
function Choice<T extends string>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = options.find((option) => option.value === value)?.label ?? value;
  return (
    <>
      <Row title={title} value={label} onPress={() => setOpen(true)} />
      <Sheet visible={open} title={title} onClose={() => setOpen(false)}>
        <View style={styles.options}>
          {options.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={option.value === value}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
            />
          ))}
        </View>
      </Sheet>
    </>
  );
}

function Row({ title, value, onPress }: { title: string; value: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${value}`}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <Text style={type.label}>{title}</Text>
      <View style={styles.rowValue}>
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
        <Icon name="chevron_right" size={18} tintColor={colors.textDim} />
      </View>
    </Pressable>
  );
}

function StepButton({
  label,
  icon,
  disabled,
  onPress,
}: {
  label: string;
  icon: 'remove' | 'add';
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.step, disabled && styles.disabled, pressed && { opacity: 0.7 }]}
    >
      <Icon name={icon} size={22} tintColor={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 20 },
  head: { flexDirection: 'row', gap: 16 },
  pictureColumn: { width: '46%', gap: 12 },
  picture: { borderRadius: radius.sm, boxShadow: '0 12px 32px rgba(121, 17, 203, 0.35)' },
  headText: { flex: 1, gap: 6, paddingTop: 4 },
  price: { fontFamily: fonts.heading, fontSize: 24, fontWeight: '800', color: colors.text, marginTop: 4 },
  panel: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  details: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8 },
  detailsLabel: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.violet },
  hint: { color: colors.warning },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  rowValue: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  value: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.text, flexShrink: 1 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  copies: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  disabled: { opacity: 0.4 },
  count: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '700', color: colors.text, minWidth: 28, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  flex: { flex: 1 },
  remove: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: 'center', paddingVertical: 8 },
  removeLabel: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600', color: colors.danger },
});
