import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, CommonResolutions, useCameraPermission, useFrameOutput, type Frame } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';

import { Button } from '@/components/ui';
import { stretchFrameToPlanarRgbU8 } from '@/extraction/cpu-letterbox';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';
import { uploadNoCard } from '@/training/training-upload';
import { colors, type } from '@/theme';

// Admins only (Profile): photos with no card in them, so the card finder learns what "no card" looks like. Each
// shot is the scanner's own 480×640 recognition frame, as its training uploads send, and the API saves it already
// labelled "no card": nothing to review in the Toolbox.
const FRAME = { width: 480, height: 640 };
/** How often the newest frame is kept for the shutter; a shot is at most this old. */
const KEEP_EVERY_MS = 250;

export default function NoCardCameraScreen() {
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );
  const { hasPermission, requestPermission } = useCameraPermission();
  const latest = useRef<RgbImage | null>(null);
  const [sent, setSent] = useState(0);
  const [failed, setFailed] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const keep = useCallback((image: RgbImage) => {
    latest.current = image;
  }, []);
  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const runtime = globalThis as typeof globalThis & { __deckinoNoCardKeptAt?: number };
      const now = Date.now();
      if (now - (runtime.__deckinoNoCardKeptAt ?? 0) >= KEEP_EVERY_MS && (frame.hasPixelBuffer || frame.isPlanar)) {
        runtime.__deckinoNoCardKeptAt = now;
        try {
          const data = stretchFrameToPlanarRgbU8(frame, FRAME.width, FRAME.height);
          runOnJS(keep)({ data, width: FRAME.width, height: FRAME.height, layout: 'planar' });
        } catch {
          // The next frame is kept instead.
        }
      }
      frame.dispose();
    },
    [keep],
  );
  // The scanner's CPU path: YUV frames turned upright, which every phone supports.
  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    enablePhysicalBufferRotation: true,
    onFrame,
  });

  const shoot = () => {
    const image = latest.current;
    if (image === null) return;
    // A second tap before the next frame would send the same picture twice.
    latest.current = null;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    uploadNoCard(image).then(
      () => setSent((count) => count + 1),
      (error: unknown) => {
        setFailed((count) => count + 1);
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  };

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <Text style={[type.body, styles.text]}>Deckino needs the camera to take these photos.</Text>
        <Button label="Allow camera" icon="photo_camera" onPress={() => void requestPermission().catch(() => {})} />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <Camera
        style={StyleSheet.absoluteFill}
        isActive={isFocused}
        device="back"
        orientationSource="interface"
        outputs={[frameOutput]}
        resizeMode="cover"
        implementationMode="compatible"
        enableNativeTapToFocusGesture
      />
      <SafeAreaView style={styles.bottom} edges={['bottom']} pointerEvents="box-none">
        <View style={styles.panel}>
          <Text style={[type.body, styles.text]}>
            {sent} sent{failed > 0 ? ` · ${failed} failed` : ''}
          </Text>
          <Text style={[type.caption, styles.text]}>
            {problem ?? 'Point at anything without a card: tables, mats, binders, boxes, an empty tray.'}
          </Text>
        </View>
        <Pressable
          onPress={shoot}
          accessibilityRole="button"
          accessibilityLabel="Take a no-card photo"
          style={({ pressed }) => [styles.shutter, pressed && styles.shutterPressed]}
        >
          <View style={styles.shutterInner} />
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: colors.background },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 20, paddingBottom: 24 },
  panel: { marginHorizontal: 16, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14, backgroundColor: colors.glass, gap: 4 },
  text: { textAlign: 'center' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterPressed: { opacity: 0.6 },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.text },
});
