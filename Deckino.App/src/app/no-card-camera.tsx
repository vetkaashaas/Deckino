import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, CommonResolutions, useCameraPermission, useFrameOutput, type Frame } from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';

import { ExtractionOverlay, type OverlayPoint } from '@/components/extraction-overlay';
import { Button } from '@/components/ui';
import { letterboxFrameToPlanarRgb, stretchFrameToPlanarRgbU8 } from '@/extraction/cpu-letterbox';
import { coverMap } from '@/extraction/letterbox';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';
import { EXTRACTOR_INPUT_SIZE, getExtractor, type LoadedExtractor, runExtractor } from '@/scan/models';
import { photoPrint, type PhotoPrint, samePhoto } from '@/training/same-photo';
import { uploadNoCard } from '@/training/training-upload';
import { colors, type } from '@/theme';

// Admins only (Profile): photos with no card in them, so the card finder learns what "no card" looks like. Each
// shot is the scanner's own 480×640 recognition frame, as its training uploads send, and the API saves it already
// labelled "no card": nothing to review in the Toolbox. The card finder runs here as in the scanner, and every frame
// it takes for a card is sent by itself: with no card in view, those are its mistakes, the photos it most needs.
const FRAME = { width: 480, height: 640 };
/** How often a frame is analysed, as in the scanner. */
const ANALYSE_EVERY_MS = 100;
/** A found "card" is sent at most this often... */
const AUTO_EVERY_MS = 1000;
/** ...and not when it is the same photo as one of the last few sent (the camera left on one spot). */
const RECENT_PHOTOS = 10;

interface Job {
  pixels: Float32Array;
  width: number;
  height: number;
  image: RgbImage;
}

export default function NoCardCameraScreen() {
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraActive = isFocused && hasPermission;
  useEffect(() => {
    if (!cameraActive) return;
    activateKeepAwakeAsync('no-card-camera').catch(() => {});
    return () => {
      deactivateKeepAwake('no-card-camera').catch(() => {});
    };
  }, [cameraActive]);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const [points, setPoints] = useState<OverlayPoint[] | null>(null);
  const [found, setFound] = useState(false);
  const [sent, setSent] = useState(0);
  const [autoSent, setAutoSent] = useState(0);
  const [failed, setFailed] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const latest = useRef<RgbImage | null>(null);
  const extractorRef = useRef<LoadedExtractor | null>(null);
  const pending = useRef<Job | null>(null);
  const busy = useRef(false);
  const autoInFlight = useRef(false);
  const lastAutoAt = useRef(0);
  const recent = useRef<PhotoPrint[]>([]);
  const viewSizeRef = useRef(viewSize);
  viewSizeRef.current = viewSize;

  useEffect(() => {
    let cancelled = false;
    getExtractor().then(
      (loaded) => {
        if (!cancelled) extractorRef.current = loaded;
      },
      (error: unknown) => setProblem(`Card finder failed to load: ${error instanceof Error ? error.message : String(error)}`),
    );
    return () => {
      cancelled = true;
      extractorRef.current = null;
    };
  }, []);

  const send = useCallback((image: RgbImage, auto: boolean) => {
    if (auto) autoInFlight.current = true;
    uploadNoCard(image, auto)
      .then(
        () => (auto ? setAutoSent : setSent)((count) => count + 1),
        (error: unknown) => {
          setFailed((count) => count + 1);
          setProblem(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        if (auto) autoInFlight.current = false;
      });
  }, []);

  const drain = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (pending.current !== null) {
        const job = pending.current;
        pending.current = null;
        const extractor = extractorRef.current;
        if (extractor === null) continue;
        const result = await runExtractor(extractor, job.pixels, job.width, job.height, 0);
        const { width, height } = viewSizeRef.current;
        setPoints(
          result.corners === null || width < 2
            ? null
            : result.corners.map((corner) => ({
                ...coverMap(corner.x, corner.y, job.width, job.height, width, height),
                name: corner.name,
              })),
        );
        setFound(result.accepted);
        // What the scanner would go on to identify. With no card in view, that is a mistake worth learning from.
        if (!result.accepted || result.corners === null) continue;
        const now = Date.now();
        if (autoInFlight.current || now - lastAutoAt.current < AUTO_EVERY_MS) continue;
        const print = photoPrint(job.image, result.corners);
        if (print !== null && recent.current.some((earlier) => samePhoto(earlier, print))) continue;
        if (print !== null) recent.current = [print, ...recent.current].slice(0, RECENT_PHOTOS);
        lastAutoAt.current = now;
        send(job.image, true);
      }
    } catch (error) {
      setProblem(`Card finder failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.current = false;
      if (pending.current !== null) void drain();
    }
  }, [send]);

  const enqueue = useCallback(
    (job: Job) => {
      latest.current = job.image;
      pending.current = job;
      void drain();
    },
    [drain],
  );
  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const runtime = globalThis as typeof globalThis & { __deckinoNoCardAt?: number };
      const now = Date.now();
      if (now - (runtime.__deckinoNoCardAt ?? 0) >= ANALYSE_EVERY_MS && (frame.hasPixelBuffer || frame.isPlanar)) {
        runtime.__deckinoNoCardAt = now;
        try {
          const data = stretchFrameToPlanarRgbU8(frame, FRAME.width, FRAME.height);
          const { pixels, width, height } = letterboxFrameToPlanarRgb(frame, EXTRACTOR_INPUT_SIZE);
          runOnJS(enqueue)({ pixels, width, height, image: { data, width: FRAME.width, height: FRAME.height, layout: 'planar' } });
        } catch {
          // The next frame is analysed instead.
        }
      }
      frame.dispose();
    },
    [enqueue],
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
    send(image, false);
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
    <View
      style={styles.flex}
      onLayout={({ nativeEvent: { layout } }) =>
        setViewSize((current) =>
          current.width === layout.width && current.height === layout.height
            ? current
            : { width: layout.width, height: layout.height },
        )
      }
    >
      <Camera
        style={StyleSheet.absoluteFill}
        isActive={cameraActive}
        device="back"
        orientationSource="interface"
        outputs={[frameOutput]}
        resizeMode="cover"
        implementationMode="compatible"
        enableNativeTapToFocusGesture
      />
      <ExtractionOverlay
        points={points}
        // A "card" found here is a mistake: shown as one.
        tone={found ? 'rejected' : 'idle'}
        rest={viewSize.width > 0 ? { x: viewSize.width / 2, y: viewSize.height * 0.4, width: viewSize.width * 0.3 } : null}
      />
      <SafeAreaView style={styles.bottom} edges={['bottom']} pointerEvents="box-none">
        <View style={styles.panel}>
          <Text style={[type.body, styles.text]}>
            {sent} taken · {autoSent} found by mistake{failed > 0 ? ` · ${failed} failed` : ''}
          </Text>
          <Text style={[type.caption, styles.text]}>
            {problem ??
              'Point at anything without a card: tables, mats, binders, boxes, an empty tray. Whatever the scanner mistakes for a card is sent by itself, so keep cards out of view.'}
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
