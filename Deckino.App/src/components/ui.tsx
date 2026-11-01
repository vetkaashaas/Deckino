import { useEffect, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useAccount } from '@/api/account';
import { ping, useOffline } from '@/api/client';
import { queryClient } from '@/api/query-client';
import { Icon, type IconName } from '@/components/icon';
import { colors, fonts, gradients, radius, type } from '@/theme';

// The mark from icon-white.svg (380 × 380; the star itself spans about 52–328).
const STAR = 'M289.9,56.89l-101.35,35.71,6.41,44.14,57.22-29.32-12.17,62.96,44.14-6.41,5.75-107.08ZM287.65,188.19l-44.1,6.4,29.07,56.32-62.72-11.25,6.41,44.14,106.84,4.82-35.49-100.44ZM185.68,243.19l-57.05,29.39,11.97-63.03-44.12,6.39-5.57,107.17,101.17-35.81-6.4-44.1ZM170.74,140.24l-6.4-44.1-107.48-5.67,36.11,101.27,44.12-6.42-29.7-57.13,63.35,12.06ZM221.08,185.5h0c-1.15-7.95-.34-16.06,2.37-23.62l11.03-30.75-26.75,19.28c-6.42,4.62-13.86,7.63-21.69,8.76l-.33.05c-7.86,1.14-15.89.35-23.38-2.3l-31.26-11.05,19.48,26.6c4.74,6.48,7.82,14.01,8.98,21.96l.02.11c1.14,7.88.35,15.91-2.3,23.41l-10.94,30.94,26.54-19.27c6.45-4.68,13.94-7.72,21.83-8.86l.58-.08c7.65-1.1,15.45-.39,22.76,2.09l30.9,10.46-18.87-25.77c-4.74-6.47-7.82-14.01-8.97-21.95Z';

/** The mark in the wordmark's gradient, before each tab page's title. */
function TitleStar() {
  return (
    <Svg width={26} height={26} viewBox="52 52 276 276">
      <Defs>
        <LinearGradient id="titleStar" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={colors.violet} />
          <Stop offset="1" stopColor={colors.purple} />
        </LinearGradient>
      </Defs>
      <Path d={STAR} fill="url(#titleStar)" />
    </Svg>
  );
}

/**
 * Every page's background: a soft wash of the brand purple from the top, gone by the middle. Linear and faint: the
 * dark radial glows this replaced showed in visible steps (banding) on OLED phones.
 */
export function Backdrop() {
  return <View style={styles.wash} pointerEvents="none" />;
}

/** A tab's page: the backdrop, safe area at the top, and its title bar with the profile avatar. */
export function Screen({ title, children }: { title: string; children: ReactNode }) {
  const offline = useOffline();
  // Any answer clears the note, so ask once even when this page has nothing to reload (a signed-out empty state).
  const retry = () => {
    void ping();
    void queryClient.refetchQueries({ type: 'active' });
  };
  return (
    <View style={styles.screen}>
      <Backdrop />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.topBar}>
          {/* Shrinks before it cuts off (a long username in Home's greeting). */}
          <View style={styles.heading}>
            <TitleStar />
            <Text style={[type.title, styles.title]} accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {title}
            </Text>
          </View>
          <Avatar />
        </View>
        {offline ? (
          <Pressable onPress={retry} accessibilityRole="button" style={styles.offline}>
            <Text style={[type.label, { color: colors.danger }]}>{"You're offline. What you see may be out of date. Tap to try again."}</Text>
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
        <Icon name="person" size={20} tintColor={colors.text} />
      )}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  icon,
  leading,
  variant = 'primary',
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  /** In place of `icon`, for what isn't a symbol (the Google logo). */
  leading?: ReactNode;
  /** `danger` for what can't be undone (solid red); `remove` for a remove that can (red words on a quiet button). */
  variant?: 'primary' | 'secondary' | 'danger' | 'remove';
  /** Dimmed and untappable, until the screen has what the action needs. */
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const ink = variant === 'remove' ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : variant === 'danger' ? styles.buttonDanger : styles.buttonSecondary,
        variant === 'remove' && styles.buttonRemove,
        pressed && styles.pressed,
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={20} tintColor={ink} /> : leading}
      <Text style={[styles.buttonLabel, { color: ink }]}>{label}</Text>
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

/**
 * A sheet from the bottom: a title, its choices and Done. The one way to pick from a short list (the Cards tab's
 * filters, the Decks tab's format), so there is one thing to learn. It rises with the keyboard for a text field.
 */
export function Sheet({
  visible,
  title,
  onClose,
  onDone = onClose,
  onShow,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  onDone?: () => void;
  onShow?: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onShow={onShow}>
      <KeyboardAvoidingView behavior="padding" style={styles.sheetFrame}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={`Close ${title.toLowerCase()}`} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <View style={styles.handle} />
          <Text style={type.heading}>{title}</Text>
          {children}
          <Button label="Done" onPress={onDone} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** An invitation where content will be: icon, headline, one line, and an optional action. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={30} tintColor={colors.lavender} />
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
        <Icon name="cloud_off" size={30} tintColor={colors.danger} />
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
      <Icon name="search" size={20} tintColor={colors.textMuted} />
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
          <Icon name="close" size={20} tintColor={colors.textMuted} />
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
  danger,
}: {
  leading?: ReactNode;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  /** Only when it says more than the title (Maestro matches it before the text inside). */
  accessibilityLabel?: string;
  /** A red title, for a row that deletes something. */
  danger?: boolean;
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
        <Text style={[type.body, { fontWeight: '500' }, danger && { color: colors.danger }]} numberOfLines={1}>
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
  sheetFrame: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.55)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: 24,
    gap: 16,
    borderTopWidth: 1,
    borderColor: colors.glassBorder,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.textDim },
  screen: { flex: 1, backgroundColor: colors.background },
  wash: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(121, 17, 203, 0.14) 0%, rgba(121, 17, 203, 0) 55%)',
  },
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
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
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
    boxShadow: '0 8px 24px rgba(121, 17, 203, 0.40)',
  },
  buttonDanger: { experimental_backgroundImage: gradients.danger },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.glassBorder },
  buttonRemove: { borderColor: 'rgba(255, 90, 122, 0.30)' },
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
  chipSelected: { borderColor: colors.lavender, backgroundColor: 'rgba(121, 17, 203, 0.28)' },
  chipLabel: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 14 },
  chipLabelSelected: { color: colors.text, fontWeight: '600' },
  empty: { alignItems: 'center', gap: 12, paddingHorizontal: 32, paddingVertical: 48 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(121, 17, 203, 0.18)',
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
