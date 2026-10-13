import { useEffect, useState, useSyncExternalStore } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, type } from '@/theme';

// One message at a time at the bottom of any screen, e.g. "Added 5 cards to Trades · Undo" (AGENTS.md: undo over
// "Are you sure?"). A new one replaces the last.

interface Toast {
  id: number;
  message: string;
  undo?: () => void;
  onPress?: () => void;
}

let current: Toast | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function set(toast: Toast | null) {
  current = toast;
  listeners.forEach((listener) => listener());
}

export function showToast(toast: Omit<Toast, 'id'>) {
  set({ ...toast, id: nextId++ });
}

const SHOWN_MS = 8000;

/** Mounted once, over the whole app (app/_layout.tsx). */
export function ToastHost() {
  const toast = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  const insets = useSafeAreaInsets();
  // Above the keyboard while it's up (adding by name), so the Undo can be seen.
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => setKeyboard(event.endCoordinates.height));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => current === toast && set(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;

  return (
    // Above the tab bar on the tabs; a little high on other screens, which is fine.
    <View style={[styles.layer, { bottom: keyboard > 0 ? keyboard + 12 : insets.bottom + 92 }]} pointerEvents="box-none">
      <Animated.View key={toast.id} entering={FadeInDown} exiting={FadeOutDown} style={styles.toast} accessibilityRole="alert">
        <Pressable
          style={styles.message}
          disabled={!toast.onPress}
          onPress={() => {
            set(null);
            toast.onPress?.();
          }}
          accessibilityRole={toast.onPress ? 'button' : 'text'}
        >
          <Text style={[type.body, styles.text]}>{toast.message}</Text>
        </Pressable>
        {toast.undo ? (
          <Pressable
            onPress={() => {
              set(null);
              toast.undo?.();
            }}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => [styles.undo, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.undoLabel}>Undo</Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 16, right: 16 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingLeft: 18,
    paddingRight: 8,
    borderRadius: radius.md,
    backgroundColor: '#2A1B38',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
  },
  message: { flex: 1, paddingVertical: 12 },
  text: { fontWeight: '500' },
  undo: { paddingHorizontal: 14, paddingVertical: 12 },
  undoLabel: { fontFamily: fonts.body, fontSize: 15, fontWeight: '700', color: colors.lavender },
});

/** Runs a change; a failure says why in a toast (the API's message, or "Can't reach Deckino…"). */
export async function attempt(change: () => Promise<unknown>): Promise<boolean> {
  try {
    await change();
    return true;
  } catch (error) {
    showToast({ message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
