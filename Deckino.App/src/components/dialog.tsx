import { useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui';
import { ambient, colors, radius, type } from '@/theme';

// The app's own alert, in place of the platform's grey box. Same arguments as Alert.alert, so a call swaps over as is.
// One at a time; a new one replaces the last.

interface DialogButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

interface Dialog {
  title: string;
  message?: string;
  buttons: DialogButton[];
}

let current: Dialog | null = null;
const listeners = new Set<() => void>();

function set(dialog: Dialog | null) {
  current = dialog;
  listeners.forEach((listener) => listener());
}

export function showDialog(title: string, message?: string, buttons: DialogButton[] = [{ text: 'OK' }]) {
  set({ title, message, buttons });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mounted once, over the whole app (app/_layout.tsx). */
export function DialogHost() {
  const open = useSyncExternalStore(subscribe, () => current);
  // The last dialog stays drawn while the Modal fades out, rather than an empty backdrop.
  const [last, setLast] = useState(open);
  if (open && open !== last) setLast(open);
  const dialog = open ?? last;

  function press(button: DialogButton) {
    if (!open) return; // a second tap while it fades out
    set(null);
    button.onPress?.();
  }
  // Back or a tap outside is the cancel button, or the only button (an OK, never a destructive one); with neither,
  // like Alert, it stays up.
  const dismiss = () => {
    const only = open?.buttons.length === 1 && open.buttons[0].style !== 'destructive' ? open.buttons[0] : undefined;
    const button = open?.buttons.find((b) => b.style === 'cancel') ?? only;
    if (button) press(button);
  };

  return (
    <Modal visible={open !== null} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={dismiss}>
      {/* Not accessible itself: an accessible parent hides its children from VoiceOver. Back closes it for readers. */}
      <Pressable style={styles.backdrop} onPress={dismiss} accessible={false}>
        {dialog ? (
          // A Pressable of its own, so taps on the card don't reach the backdrop.
          <Pressable style={styles.card} accessible={false} accessibilityViewIsModal>
            <Text style={type.heading} accessibilityRole="header">
              {dialog.title}
            </Text>
            {dialog.message ? <Text style={[type.body, { color: colors.textMuted }]}>{dialog.message}</Text> : null}
            <View style={[styles.buttons, dialog.buttons.length > 2 && styles.stacked]}>
              {dialog.buttons.map((button, i) => (
                <Button
                  key={i}
                  label={button.text}
                  variant={button.style === 'destructive' ? 'danger' : button.style === 'cancel' ? 'secondary' : 'primary'}
                  onPress={() => press(button)}
                  style={dialog.buttons.length <= 2 && styles.grow}
                />
              ))}
            </View>
          </Pressable>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  card: {
    gap: 10,
    padding: 22,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surface,
    experimental_backgroundImage: ambient,
    boxShadow: '0 16px 48px rgba(0, 0, 0, 0.6)',
  },
  buttons: { flexDirection: 'row', gap: 12, marginTop: 12 },
  stacked: { flexDirection: 'column' },
  grow: { flex: 1, paddingHorizontal: 12 },
});
