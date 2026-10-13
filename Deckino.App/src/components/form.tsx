import { useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';

import { ApiError } from '@/api/client';
import { ambient, colors, fonts, radius, type } from '@/theme';

/**
 * A form screen: scrolls above the keyboard, actions at the bottom within thumb reach. `brand` adds the logo and the
 * ambient glow, for the signed-out screens (sign in, create account, forgot password).
 */
export function FormScreen({ children, actions, brand }: { children: ReactNode; actions: ReactNode; brand?: boolean }) {
  return (
    <KeyboardAvoidingView style={styles.screen} behavior="height">
      {brand ? <View style={styles.glow} pointerEvents="none" /> : null}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.fields}>
          {brand ? (
            <Image
              source={require('../../assets/images/brand/logo-original.svg')}
              style={styles.logo}
              contentFit="contain"
              accessibilityLabel="Deckino"
            />
          ) : null}
          {children}
        </View>
        <View style={styles.actions}>{actions}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A labelled text field with its error underneath. The label is also its accessibility name. */
export function Field({
  label,
  error,
  secret,
  ...input
}: { label: string; error?: string; secret?: boolean } & TextInputProps) {
  const [hidden, setHidden] = useState(true);
  return (
    <View style={styles.field}>
      <Text style={type.label}>{label}</Text>
      <View style={[styles.inputBox, error ? styles.inputError : null]}>
        <TextInput
          accessibilityLabel={label}
          testID={`field-${label.toLowerCase().replace(/ /g, '-')}`} // Maestro: `id: field-email`
          placeholderTextColor={colors.textDim}
          selectionColor={colors.lavender}
          secureTextEntry={secret && hidden}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          {...input}
        />
        {secret ? (
          <Pressable
            onPress={() => setHidden(!hidden)}
            accessibilityRole="button"
            accessibilityLabel={hidden ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
            hitSlop={12}
          >
            <SymbolView
              name={{ ios: hidden ? 'eye' : 'eye.slash', android: hidden ? 'visibility' : 'visibility_off' }}
              size={20}
              tintColor={colors.textDim}
            />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** A problem with the whole form (wrong password, offline). */
export function FormMessage({ message, tone = 'error' }: { message: string | null; tone?: 'error' | 'info' }) {
  if (!message) return null;
  return (
    <View style={[styles.message, tone === 'info' && styles.messageInfo]} accessibilityRole="alert">
      <Text style={type.body}>{message}</Text>
    </View>
  );
}

/**
 * Runs a form's request: busy while it runs, then the API's message for the form and each field.
 * `run` returns true when it worked.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function submit(request: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    setFields({});
    try {
      await request();
      return true;
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        setFields(Object.fromEntries(Object.entries(error.fields).map(([field, messages]) => [field, messages[0]])));
        if (error.fields['']) setMessage(error.fields[''][0]);
      } else {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, fields, submit };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glow: { ...StyleSheet.absoluteFill, experimental_backgroundImage: ambient },
  // The SVG viewBox is 1200 x 396.58, including its own padding.
  logo: { width: 180, height: 180 * (396.58 / 1200), marginLeft: -12, marginBottom: 4 },
  content: { flexGrow: 1, padding: 20, gap: 24, justifyContent: 'space-between' },
  fields: { gap: 16 },
  actions: { gap: 12 },
  field: { gap: 6 },
  inputBox: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surface,
  },
  inputError: { borderColor: colors.danger },
  input: { flex: 1, fontFamily: fonts.body, fontSize: 16, color: colors.text, paddingVertical: 12 },
  error: { fontFamily: fonts.body, fontSize: 13, color: colors.danger },
  message: {
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255, 90, 122, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255, 90, 122, 0.35)',
  },
  messageInfo: { backgroundColor: 'rgba(152, 29, 206, 0.18)', borderColor: 'rgba(199, 155, 242, 0.35)' },
});
