import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { copyPrice, finishFor, type BinderPrinting, type Condition, type Finish } from '@/api/binders';
import type { Printing } from '@/api/cards';
import { CardImage, formatPrice, SetSymbol } from '@/components/card-visuals';
import { Icon } from '@/components/icon';
import { PrintingButton } from '@/components/printing-picker';
import { Button, Chip } from '@/components/ui';
import { CONDITIONS, LANGUAGES, usePreferences } from '@/preferences';
import { colors, fonts, radius, type } from '@/theme';

// The one place a card is changed (AGENTS.md: one way to do a thing): a binder row, a scan-tray row and a deck row
// all open it, and a wishlist row. Condition and language are for cards you own (not in decks), the finish for cards
// you own or play (not wanted ones); `sections` is for deck cards.

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
  extra,
  sections,
  maxCopies = () => 99,
}: {
  initial: SheetValues;
  /** A scanned card nobody has checked: say so above the printings. */
  unchecked: boolean;
  removeLabel: string;
  onSave: (values: SheetValues) => void;
  onRemove: () => void;
  extra?: ReactNode;
  sections?: { value: string; label: string }[];
  /** The most copies allowed with these values (a commander is one card). */
  maxCopies?: (values: SheetValues) => number;
}) {
  const insets = useSafeAreaInsets();
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

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}>
      <View style={styles.head}>
        <View style={styles.picture}>
          <CardImage uri={printing.image} name={printing.name} />
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
        </View>
      </View>

      {unchecked ? (
        <Text style={[type.label, styles.hint]}>
          Some printings share this picture. Pick the one whose set symbol matches your card.
        </Text>
      ) : null}
      <PrintingButton id={printing.id} onChoose={choosePrinting} />

      {sections && values.section ? (
        <Section title="Part of the deck">
          <Choices options={sections} value={values.section} onChange={(section) => change({ section })} />
        </Section>
      ) : null}

      {values.condition ? (
        <Section title="Condition">
          <Choices options={CONDITIONS} value={values.condition} onChange={(condition) => change({ condition })} />
        </Section>
      ) : null}

      {values.finish && printing.finishes.length > 1 ? (
        <Section title="Finish">
          <Choices
            options={printing.finishes.map((finish) => ({ value: finish, label: finishLabel(finish) }))}
            value={values.finish}
            onChange={(finish) => change({ finish })}
          />
        </Section>
      ) : null}

      {values.language ? (
        <Section title="Language">
          <Choices options={LANGUAGES} value={values.language} onChange={(language) => change({ language })} />
        </Section>
      ) : null}

      <Section title="Copies">
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
      </Section>

      <Button label="Save" onPress={() => onSave({ ...values, copies: Math.min(values.copies, most) })} style={styles.save} />
      {extra}
      <Button label={removeLabel} variant="secondary" icon="delete" onPress={onRemove} />
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={type.label} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Choices<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    // A ScrollView shrinks by default; this one keeps its chips' height.
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.choices} contentContainerStyle={styles.chips}>
      {options.map((option) => (
        <Chip key={option.value} label={option.label} selected={option.value === value} onPress={() => onChange(option.value)} />
      ))}
    </ScrollView>
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
  content: { padding: 20, gap: 20 },
  head: { flexDirection: 'row', gap: 16 },
  picture: { width: 110 },
  headText: { flex: 1, gap: 6 },
  price: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '700', color: colors.text },
  section: { gap: 10 },
  hint: { color: colors.warning },
  choices: { flexGrow: 0, flexShrink: 0 },
  chips: { gap: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  step: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  disabled: { opacity: 0.4 },
  count: { fontFamily: fonts.heading, fontSize: 24, fontWeight: '700', color: colors.text, minWidth: 32, textAlign: 'center' },
  save: { marginTop: 4 },
});
