import { useEffect, useState } from 'react';
import { Text, View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { isLoaded, loadAsync } from 'expo-font';
import type { AndroidSymbol } from 'expo-symbols';
import { MaterialSymbols_400Regular } from '@expo-google-fonts/material-symbols/400Regular';
import { MaterialSymbols_700Bold } from '@expo-google-fonts/material-symbols/700Bold';

// A Material Symbols name (https://fonts.google.com/icons).
export type IconName = AndroidSymbol;

const FONTS = {
  regular: { name: 'MaterialSymbols_400Regular', file: MaterialSymbols_400Regular },
  bold: { name: 'MaterialSymbols_700Bold', file: MaterialSymbols_700Bold },
};

// Both weights start loading with the app, so the bold one is ready before the scanner's first lock badge needs it.
const READY = Object.fromEntries(
  Object.entries(FONTS).map(([weight, font]) => [
    weight,
    loadAsync({ [font.name]: font.file }).catch((error) => console.warn(`icon font ${font.name} failed to load`, error)),
  ]),
) as Record<keyof typeof FONTS, Promise<void>>;

// Material Symbols on iOS and Android alike, so the two apps look the same (SF Symbols are Apple-only). The font draws
// the icon from its name (a ligature).
export function Icon({
  name,
  size = 24,
  tintColor,
  weight = 'regular',
  style,
}: {
  name: IconName;
  size?: number;
  tintColor?: ColorValue;
  weight?: keyof typeof FONTS;
  style?: StyleProp<ViewStyle>;
}) {
  const font = FONTS[weight];
  // The loaded font's name is state: the React Compiler memoizes a plain isLoaded(font.name) call on font.name, so a
  // re-render alone would never see the font arrive. Keyed by name, so a change of weight waits for that weight's font
  // rather than drawing the name as text.
  const [ready, setReady] = useState(() => (isLoaded(font.name) ? font.name : null));
  const loaded = ready === font.name;
  useEffect(() => {
    if (!loaded) void READY[weight].then(() => isLoaded(font.name) && setReady(font.name));
  }, [weight, loaded, font.name]);

  // Decorative: whatever holds the icon carries the label, and a screen reader would otherwise read out the name.
  return (
    <View
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {loaded ? (
        // Twice the box's width, centred over it: a glyph is exactly `size` wide, and on a phone whose pixel density
        // rounds it a hair wider than the box (a Galaxy A56), a box-wide Text would cut it to "…".
        <Text
          allowFontScaling={false}
          style={{
            width: size * 2,
            textAlign: 'center',
            fontFamily: font.name,
            fontSize: size,
            lineHeight: size,
            color: tintColor,
            includeFontPadding: false,
          }}
        >
          {name}
        </Text>
      ) : null}
    </View>
  );
}
