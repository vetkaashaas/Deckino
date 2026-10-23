import { useState, type ReactNode, type Ref } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { showDialog } from '@/components/dialog';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui';
import { ambient, colors, fonts, radius, type } from '@/theme';

/**
 * A form screen: scrolls above the keyboard, actions at the bottom within thumb reach and above Android's
 * navigation buttons. `brand` heads it with the logo, a title and a line under it, centred on the ambient glow, for
 * the signed-out screens (sign in, create account, forgot password), whose header is transparent (_layout.tsx).
 */
export function FormScreen({
  children,
  actions,
  brand,
}: {
  children?: ReactNode;
  actions: ReactNode;
  brand?: { title: string; subtitle?: string };
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView style={styles.screen} behavior="height">
      {brand ? <View style={styles.glow} pointerEvents="none" /> : null}
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: 20 + insets.bottom },
          brand ? { paddingTop: insets.top } : null, // the logo shares the transparent header's row with its back arrow
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.fields}>
          {brand ? (
            <View style={styles.brand}>
              <Image
                source={require('../../assets/images/brand/logo-original.svg')}
                style={styles.logo}
                contentFit="contain"
                accessibilityLabel="Deckino"
              />
              <Text style={[type.title, styles.center]} accessibilityRole="header">
                {brand.title}
              </Text>
              {brand.subtitle ? (
                <Text style={[type.body, styles.center, { color: colors.textMuted }]}>{brand.subtitle}</Text>
              ) : null}
            </View>
          ) : null}
          {children}
        </View>
        <View style={styles.actions}>{actions}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * A labelled text field with its error underneath. The label is also its accessibility name. `ref` reaches the input,
 * so the keyboard's Next can focus the following field.
 */
export function Field({
  label,
  error,
  secret,
  ...input
}: { label: string; error?: string; secret?: boolean; ref?: Ref<TextInput> } & TextInputProps) {
  const [hidden, setHidden] = useState(true);
  // Typing in the field puts its error away (it was about the old text); the next error shows again. useSubmit
  // clears every error when a submit starts, so even the same message coming back counts as new.
  const [edited, setEdited] = useState(false);
  const [lastError, setLastError] = useState(error);
  if (error !== lastError) {
    setLastError(error);
    setEdited(false);
  }
  const shownError = edited ? undefined : error;
  return (
    <View style={styles.field}>
      <Text style={type.label}>{label}</Text>
      <View style={[styles.inputBox, shownError ? styles.inputError : null]}>
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
          onChangeText={(text) => {
            setEdited(true);
            input.onChangeText?.(text);
          }}
        />
        {secret ? (
          <Pressable
            onPress={() => setHidden(!hidden)}
            accessibilityRole="button"
            accessibilityLabel={hidden ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
            hitSlop={12}
          >
            <Icon
              name={hidden ? 'visibility' : 'visibility_off'}
              size={20}
              tintColor={colors.textDim}
            />
          </Pressable>
        ) : null}
      </View>
      {shownError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {shownError}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Google and Apple sign-in above the email form, then "or". Apple only on iOS (its own rule: offer it where it's
 * native). Placeholders until the API takes their tokens.
 */
export function OAuthButtons() {
  // ponytail: "coming soon" alert, wire expo-auth-session (Google) / expo-apple-authentication when the API is ready
  const soon = () => showDialog('Coming soon', 'For now, use your email.');
  return (
    <View style={styles.oauth}>
      <Button
        label="Continue with Google"
        variant="secondary"
        leading={<Image source={require('../../assets/images/brand/google-g.svg')} style={styles.oauthLogo} />}
        onPress={soon}
      />
      {/* TEMP: Apple on Android too, to preview the iOS layout. Back to `Platform.OS === 'ios'` before release. */}
      {Platform.OS === 'ios' || __DEV__ ? (
        <Button
          label="Continue with Apple"
          variant="secondary"
          leading={<Image source={require('../../assets/images/brand/apple-logo.svg')} style={styles.oauthLogo} />}
          onPress={soon}
        />
      ) : null}
      <View style={styles.or}>
        <View style={styles.rule} />
        <Text style={[type.label, { color: colors.textDim }]}>or</Text>
        <View style={styles.rule} />
      </View>
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
  brand: { alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 12 },
  // The SVG viewBox is 1200 x 396.58, including its own padding.
  logo: { width: 240, height: 240 * (396.58 / 1200), marginBottom: 8 },
  center: { textAlign: 'center' },
  content: { flexGrow: 1, padding: 20, gap: 24, justifyContent: 'space-between' },
  fields: { gap: 16 },
  actions: { gap: 12 },
  field: { gap: 6 },
  oauth: { gap: 12 },
  oauthLogo: { width: 20, height: 20 },
  or: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  rule: { flex: 1, height: 1, backgroundColor: colors.glassBorder },
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
  messageInfo: { backgroundColor: 'rgba(121, 17, 203, 0.18)', borderColor: 'rgba(199, 155, 242, 0.35)' },
});
