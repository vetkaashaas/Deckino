import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Pressable, RefreshControl, StyleSheet, Switch, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useAccount } from '@/api/account';
import { getJson, useOffline } from '@/api/client';
import { queryClient } from '@/api/query-client';
import { ambient, colors, fonts, gradients, radius, type } from '@/theme';

export type Icon = ComponentProps<typeof SymbolView>['name'];

/** A tab's page: the ambient glow, safe area at the top, and its title bar with the profile avatar. */
export function Screen({ title, children }: { title: string; children: ReactNode }) {
  const offline = useOffline();
  // Any answer clears the note, so ask once even when this page has nothing to reload (a signed-out empty state).
  const retry = () => {
    getJson('/api/health').catch(() => {});
    void queryClient.refetchQueries({ type: 'active' });
  };
  return (
    <View style={styles.screen}>
      <View style={styles.glow} pointerEvents="none" />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.topBar}>
          <Text style={[type.title, styles.title]} accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
          <Avatar />
        </View>
        {offline ? (
          <Pressable onPress={retry} accessibilityRole="button" style={styles.offline}>
            <Text style={[type.label, { color: colors.danger }]}>You're offline. What you see may be out of date. Tap to try again.</Text>
          </Pressable>
        ) : null}
        {children}
      </SafeAreaView>
    </View>
  );
}

/** Opens Profile: the account's initial when signed in, else a person outline. */
export function Avatar() {
  const router = useRouter();
  const initial = useAccount().data?.username.slice(0, 1).toUpperCase();
  return (
    <Pressable
      onPress={() => router.push('/profile')}
      accessibilityRole="button"
      accessibilityLabel="Profile and settings"
      hitSlop={8}
      style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}
    >
      {initial ? (
        <Text style={styles.initial}>{initial}</Text>
      ) : (
        <SymbolView name={{ ios: 'person', android: 'person' }} size={20} tintColor={colors.text} />
      )}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  icon,
  variant = 'primary',
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: Icon;
  variant?: 'primary' | 'secondary';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && styles.pressed,
        style,
      ]}
    >
      {icon ? <SymbolView name={icon} size={20} tintColor={colors.text} /> : null}
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: ReactNode;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      {typeof label === 'string' ? (
        <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
      ) : (
        label
      )}
    </Pressable>
  );
}

/** An invitation where content will be: icon, headline, one line, and an optional action. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: Icon;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <SymbolView name={icon} size={30} tintColor={colors.lavender} />
      </View>
      <Text style={[type.heading, styles.center]}>{title}</Text>
      <Text style={[type.body, styles.center, { color: colors.textMuted }]}>{body}</Text>
      {action ? <Button label={action.label} onPress={action.onPress} style={styles.emptyAction} /> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.empty} accessibilityRole="alert">
      <View style={[styles.emptyIcon, styles.errorIcon]}>
        <SymbolView name={{ ios: 'wifi.exclamationmark', android: 'cloud_off' }} size={30} tintColor={colors.danger} />
      </View>
      <Text style={[type.body, styles.center, { color: colors.textMuted }]}>{message}</Text>
      <Button label="Try again" variant="secondary" onPress={onRetry} style={styles.emptyAction} />
    </View>
  );
}

/** A pulsing placeholder in the shape of what is loading. Still when the system asks for reduced motion. */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(0.5);
  useEffect(() => {
    if (!reduceMotion) opacity.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [opacity, reduceMotion]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.skeleton, animated, style]} accessibilityLabel="Loading" />;
}

/**
 * A list's pull to refresh, in the brand's colours. It spins for a pull only: a refetch after a change elsewhere
 * (a scan saved, a card moved) updates the list quietly.
 */
export function usePullToRefresh(refetch: () => Promise<unknown>) {
  const [pulling, setPulling] = useState(false);
  return (
    <RefreshControl
      refreshing={pulling}
      onRefresh={() => {
        setPulling(true);
        void refetch().finally(() => setPulling(false));
      }}
      tintColor={colors.lavender}
      colors={[colors.purple]}
    />
  );
}

/** A search field with its icon and a clear button (Cards, public decks). */
export function SearchBox({
  value,
  onChangeText,
  onSubmit,
  placeholder,
  label,
  style,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  label: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.searchBox, style]}>
      <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={20} tintColor={colors.textMuted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={colors.textDim}
        accessibilityLabel={label}
        returnKeyType="search"
        autoCorrect={false}
        style={styles.searchInput}
      />
      {value ? (
        <Pressable onPress={() => onChangeText('')} accessibilityLabel="Clear search" hitSlop={10}>
          <SymbolView name={{ ios: 'xmark.circle.fill', android: 'close' }} size={20} tintColor={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A row with a leading thumbnail or icon, title, detail and trailing content. */
export function ListRow({
  leading,
  title,
  detail,
  trailing,
  onPress,
  accessibilityLabel,
}: {
  leading?: ReactNode;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  /** Only when it says more than the title (Maestro matches it before the text inside). */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {leading}
      <View style={styles.rowText}>
        <Text style={[type.body, { fontWeight: '500' }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={type.label} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

/** A ListRow with a switch; the whole row toggles it. */
export function SwitchRow({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <ListRow
      title={title}
      detail={detail}
      onPress={() => onChange(!value)}
      trailing={
        <Switch
          value={value}
          onValueChange={onChange}
          accessibilityLabel={title}
          trackColor={{ false: colors.glassBorder, true: colors.purple }}
          thumbColor={value ? colors.text : colors.textMuted}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  safe: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  title: { flexShrink: 1 },
  offline: { paddingHorizontal: 20, paddingBottom: 8 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  initial: { fontFamily: fonts.heading, fontSize: 18, fontWeight: '800', color: colors.text },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  button: {
    minHeight: 52,
    paddingHorizontal: 22,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  buttonPrimary: {
    experimental_backgroundImage: gradients.brand,
    boxShadow: '0 8px 24px rgba(152, 29, 206, 0.40)',
  },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.glassBorder },
  buttonLabel: { fontFamily: fonts.body, color: colors.text, fontSize: 16, fontWeight: '600' },
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  chipSelected: { borderColor: colors.lavender, backgroundColor: 'rgba(152, 29, 206, 0.28)' },
  chipLabel: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 14 },
  chipLabelSelected: { color: colors.text, fontWeight: '600' },
  empty: { alignItems: 'center', gap: 12, paddingHorizontal: 32, paddingVertical: 48 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(152, 29, 206, 0.18)',
  },
  errorIcon: { backgroundColor: 'rgba(255, 90, 122, 0.14)' },
  emptyAction: { marginTop: 8, alignSelf: 'stretch' },
  center: { textAlign: 'center' },
  skeleton: { backgroundColor: colors.surface, borderRadius: radius.sm },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 16, color: colors.text, paddingVertical: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 56,
    paddingVertical: 8,
  },
  rowText: { flex: 1, gap: 2 },
});
