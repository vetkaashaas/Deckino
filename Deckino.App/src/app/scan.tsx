import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  Camera,
  CommonResolutions,
  useCameraPermission,
  useFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import { runOnJS } from 'react-native-worklets';

import { DebugHud, type HudStats } from '@/components/debug-hud';
import {
  createCardRecognizer,
  createTemporalVoter,
  type CardRecognizerDescriptor,
  type LockState,
  type TemporalVoter,
} from '@/recognition';

interface FrameRuntimeState {
  lastAnalyzedAt: number;
  received: number;
  analyzed: number;
  latencySumMs: number;
  batchStartedAt: number;
  lastLockKey: string;
  recognizer: CardRecognizerDescriptor;
  voter: TemporalVoter;
}

export default function ScanScreen() {
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();
  const [showHud, setShowHud] = useState(true);
  const [hud, setHud] = useState<HudStats | null>(null);
  const [lock, setLock] = useState<LockState>({ status: 'searching' });

  const applyHud = useCallback((stats: HudStats) => setHud(stats), []);
  const applyLock = useCallback((state: LockState) => setLock(state), []);

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      const analysisIntervalMs = 100;
      const hudIntervalMs = 500;
      const runtime = globalThis as typeof globalThis & {
        __deckinoPipeline?: FrameRuntimeState;
      };
      if (runtime.__deckinoPipeline === undefined) {
        runtime.__deckinoPipeline = {
          lastAnalyzedAt: 0,
          received: 0,
          analyzed: 0,
          latencySumMs: 0,
          batchStartedAt: 0,
          lastLockKey: 'searching',
          recognizer: createCardRecognizer(),
          voter: createTemporalVoter(),
        };
      }
      const pipeline = runtime.__deckinoPipeline;

      const now = Date.now();
      pipeline.received += 1;
      if (now - pipeline.lastAnalyzedAt < analysisIntervalMs) {
        frame.dispose();
        return;
      }
      pipeline.lastAnalyzedAt = now;

      const startedAt = Date.now();
      const guess = pipeline.recognizer.recognize(frame);
      const latencyMs = Date.now() - startedAt;
      const nextLock = pipeline.voter(guess, now);

      pipeline.analyzed += 1;
      pipeline.latencySumMs += latencyMs;

      const lockKey =
        nextLock.status === 'locked' ? nextLock.guess.scryfallId : 'searching';
      if (lockKey !== pipeline.lastLockKey) {
        pipeline.lastLockKey = lockKey;
        runOnJS(applyLock)(nextLock);
      }

      if (pipeline.batchStartedAt === 0) {
        pipeline.batchStartedAt = now;
      }
      if (now - pipeline.batchStartedAt >= hudIntervalMs) {
        const elapsedS = (now - pipeline.batchStartedAt) / 1000;
        runOnJS(applyHud)({
          cameraFps: pipeline.received / elapsedS,
          analysisFps: pipeline.analyzed / elapsedS,
          latencyMs: pipeline.latencySumMs / Math.max(1, pipeline.analyzed),
          width: frame.width,
          height: frame.height,
          recognizerName: `recognizer: ${pipeline.recognizer.name}`,
        });
        pipeline.received = 0;
        pipeline.analyzed = 0;
        pipeline.latencySumMs = 0;
        pipeline.batchStartedAt = now;
      }
      frame.dispose();
    },
    [applyHud, applyLock],
  );

  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.HD_4_3,
    pixelFormat: 'yuv',
    onFrame,
  });

  const resultBar = useMemo(() => {
    if (lock.status === 'locked') {
      return {
        title: lock.guess.cardName,
        detail: `${Math.round(lock.guess.confidence * 100)}% match`,
        accent: '#7CFC9A',
      };
    }
    return {
      title: 'Scanning for cards…',
      detail: 'Hold a card inside the frame',
      accent: '#FFFFFF',
    };
  }, [lock]);

  if (!hasPermission && !canRequestPermission) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.heading}>Camera access blocked</Text>
        <Text style={styles.body}>
          Deckino needs the camera to recognize cards. Enable it in system
          settings and come back.
        </Text>
      </SafeAreaView>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.heading}>Deckino</Text>
        <Text style={styles.body}>
          Point your camera at Magic: The Gathering cards to identify them in
          real time.
        </Text>
        <Pressable
          style={styles.button}
          onPress={() => void requestPermission()}
        >
          <Text style={styles.buttonLabel}>Grant camera access</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.flex}>
      <Camera
        style={StyleSheet.absoluteFill}
        isActive={isFocused}
        device="back"
        outputs={[frameOutput]}
        enableNativeTapToFocusGesture
      />
      <View style={styles.guideWrap} pointerEvents="none">
        <View style={styles.guide} />
      </View>
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <DebugHud stats={hud} />
          <View style={styles.spacer} />
          <Pressable
            style={[styles.chip, showHud && styles.chipActive]}
            onPress={() => setShowHud((value) => !value)}
          >
            <Text style={styles.chipLabel}>HUD</Text>
          </Pressable>
        </View>
        <View style={styles.resultBar} pointerEvents="none">
          <ActivityIndicator
            animating={lock.status !== 'locked'}
            color={resultBar.accent}
          />
          <View style={styles.resultText}>
            <Text style={[styles.resultTitle, { color: resultBar.accent }]}>
              {resultBar.title}
            </Text>
            <Text style={styles.resultDetail}>{resultBar.detail}</Text>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const CARD_ASPECT_RATIO = 63 / 88;

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: '#000000',
  },
  center: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 32,
  },
  heading: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '700',
  },
  body: {
    color: '#B8B8C0',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
  },
  spacer: {
    flex: 1,
  },
  chip: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    backgroundColor: 'rgba(32, 138, 239, 0.75)',
  },
  chipLabel: {
    color: '#FFFFFF',
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
  },
  guideWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guide: {
    width: '72%',
    aspectRatio: CARD_ASPECT_RATIO,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.65)',
    borderRadius: 14,
  },
  resultBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  resultText: {
    flexShrink: 1,
    gap: 2,
  },
  resultTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  resultDetail: {
    color: '#B8B8C0',
    fontSize: 13,
  },
});
