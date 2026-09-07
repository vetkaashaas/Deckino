import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Asset } from 'expo-asset';
import {
  Camera,
  CommonResolutions,
  useCameraPermission,
  useFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import { useResizer } from 'react-native-vision-camera-resizer';
import { runOnJS } from 'react-native-worklets';
import { InferenceSession, Tensor } from 'onnxruntime-react-native';

import { DebugHud, type HudStats } from '@/components/debug-hud';
import {
  ExtractionOverlay,
  type OverlayPoint,
} from '@/components/extraction-overlay';
import {
  letterboxFrameToPlanarRgb,
  orientedFrameSize,
  uprightToBufferUv,
} from '@/extraction/cpu-letterbox';
import { coverMap } from '@/extraction/letterbox';
import { interpretExtractor } from '@/extraction/load-extractor';
import { createExtractorSession } from '@/extraction/session';
import type {
  ExtractionResult,
  ExtractorThresholds,
  MobileExtractorManifest,
} from '@/extraction/types';
import manifestJson from '../../assets/models/extractor/mobile-manifest.json';
import thresholdsJson from '../../assets/models/extractor/thresholds.json';

const manifest = manifestJson as MobileExtractorManifest;
const thresholds = thresholdsJson as ExtractorThresholds;
const INPUT_SIZE = 320;

interface FrameRuntimeState {
  lastAnalyzedAt: number;
  received: number;
  analyzed: number;
  latencySumMs: number;
  batchStartedAt: number;
}

interface CameraAxes {
  originX: number;
  originY: number;
  xAxisX: number;
  xAxisY: number;
  yAxisX: number;
  yAxisY: number;
}

type ResizeBackend = 'native' | 'cpu';

interface ExtractorJob {
  pixels: Float32Array;
  width: number;
  height: number;
  bufferWidth: number;
  bufferHeight: number;
  orientation: Frame['orientation'];
  isMirrored: boolean;
  cameraAxes: CameraAxes;
  resizeMs: number;
  resizeBackend: ResizeBackend;
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
  const cameraRef = useRef<ComponentRef<typeof Camera>>(null);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const [showHud, setShowHud] = useState(true);
  const [hud, setHud] = useState<HudStats | null>(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [overlayPoints, setOverlayPoints] = useState<OverlayPoint[] | null>(
    null,
  );
  const [modelStatus, setModelStatus] = useState('loading extractor');
  const [useCpuResize, setUseCpuResize] = useState(false);
  const [resizeNote, setResizeNote] = useState<string | null>(null);
  const sessionRef = useRef<InferenceSession | null>(null);
  const delegateRef = useRef('cpu-onnx');
  const busyRef = useRef(false);
  const latestJob = useRef<ExtractorJob | null>(null);

  const resizerState = useResizer({
    width: INPUT_SIZE,
    height: INPUT_SIZE,
    channelOrder: 'rgb',
    dataType: 'float32',
    scaleMode: 'contain',
    pixelLayout: 'planar',
  });
  const resizer =
    resizerState.state === 'ready' ? resizerState.resizer : null;

  const applyHud = useCallback((stats: HudStats) => setHud(stats), []);
  const applyExtraction = useCallback(
    (result: ExtractionResult) => setExtraction(result),
    [],
  );
  const enableCpuResize = useCallback((reason: string) => {
    console.warn(`Deckino: falling back to CPU resize (${reason})`);
    setUseCpuResize(true);
    setResizeNote(`cpu resize: ${reason}`);
  }, []);

  useEffect(() => {
    if (resizerState.state === 'error') {
      enableCpuResize(
        resizerState.error.message.split('.')[0] || 'vulkan unavailable',
      );
    }
  }, [enableCpuResize, resizerState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const asset = Asset.fromModule(
          require('../../assets/models/extractor/extractor.onnx'),
        );
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (!uri) {
          throw new Error('Extractor ONNX asset has no file URI.');
        }
        const loaded = await createExtractorSession(uri);
        if (cancelled) {
          return;
        }
        sessionRef.current = loaded.session;
        delegateRef.current = loaded.delegate;
        setModelStatus(`extractor: ${manifest.model_version}`);
        console.log(`Deckino extractor session: ${loaded.delegate}`);
      } catch (error) {
        setModelStatus(
          `extractor failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
      sessionRef.current = null;
    };
  }, []);

  const lastMappedRef = useRef<{
    corners: NonNullable<ExtractionResult['corners']>;
    job: ExtractorJob;
  } | null>(null);

  const mapCornersToView = useCallback(
    (
      corners: NonNullable<ExtractionResult['corners']>,
      job: ExtractorJob,
    ): OverlayPoint[] | null => {
      if (viewSize.width < 2 || viewSize.height < 2) {
        return null;
      }
      const covered = corners.map((corner) => {
        const mapped = coverMap(
          corner.x,
          corner.y,
          job.width,
          job.height,
          viewSize.width,
          viewSize.height,
        );
        return { ...mapped, name: corner.name };
      });
      const preview = cameraRef.current;
      if (preview == null) {
        return covered;
      }
      try {
        const converted = corners.map((corner) => {
          const buffer = uprightToBufferUv(
            corner.x,
            corner.y,
            job.orientation,
            job.isMirrored,
          );
          const axes = job.cameraAxes;
          const cameraPoint = {
            x:
              axes.originX +
              (axes.xAxisX - axes.originX) * buffer.u +
              (axes.yAxisX - axes.originX) * buffer.v,
            y:
              axes.originY +
              (axes.xAxisY - axes.originY) * buffer.u +
              (axes.yAxisY - axes.originY) * buffer.v,
          };
          const view = preview.convertCameraPointToViewPoint(cameraPoint);
          return { x: view.x, y: view.y, name: corner.name };
        });
        const inView = converted.every(
          (point) =>
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            point.x >= -viewSize.width * 0.2 &&
            point.x <= viewSize.width * 1.2 &&
            point.y >= -viewSize.height * 0.2 &&
            point.y <= viewSize.height * 1.2 &&
            (Math.abs(point.x) > 4 || Math.abs(point.y) > 4),
        );
        return inView ? converted : covered;
      } catch {
        return covered;
      }
    },
    [viewSize.height, viewSize.width],
  );

  useEffect(() => {
    const pending = lastMappedRef.current;
    if (pending === null || viewSize.width < 2) {
      return;
    }
    setOverlayPoints(mapCornersToView(pending.corners, pending.job));
  }, [mapCornersToView, viewSize.height, viewSize.width]);

  const drainJobs = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    try {
      while (latestJob.current !== null) {
        const job = latestJob.current;
        latestJob.current = null;
        const session = sessionRef.current;
        if (session === null) {
          continue;
        }
        const inferStarted = Date.now();
        const results = await session.run({
          image: new Tensor('float32', job.pixels, [1, 3, INPUT_SIZE, INPUT_SIZE]),
        });
        const inferMs = Date.now() - inferStarted;
        const tensors = manifest.output_names.map((name) => {
          const value = results[name]?.data;
          return value instanceof Float32Array
            ? value
            : Float32Array.from(value as Iterable<number>);
        });
        const result = interpretExtractor(
          tensors,
          manifest,
          thresholds,
          job.width,
          job.height,
          {
            resizeMs: job.resizeMs,
            inferMs,
            decodeMs: 0,
            totalMs: 0,
          },
          delegateRef.current,
        );
        applyExtraction(result);
        if (result.corners === null) {
          lastMappedRef.current = null;
          setOverlayPoints(null);
        } else {
          lastMappedRef.current = { corners: result.corners, job };
          setOverlayPoints(mapCornersToView(result.corners, job));
        }
        console.log(
          `Deckino extract ${result.timings.resizeMs.toFixed(0)}ms resize / ${result.timings.inferMs}ms infer / ${result.timings.decodeMs.toFixed(0)}ms decode · ${result.delegate} · ${job.resizeBackend} resize`,
        );
      }
    } catch (error) {
      setModelStatus(
        `infer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      busyRef.current = false;
      if (latestJob.current !== null) {
        void drainJobs();
      }
    }
  }, [applyExtraction, mapCornersToView]);

  const enqueueJob = useCallback(
    (job: ExtractorJob) => {
      latestJob.current = job;
      void drainJobs();
    },
    [drainJobs],
  );

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
        };
      }
      const pipeline = runtime.__deckinoPipeline;
      const now = Date.now();
      pipeline.received += 1;
      if (now - pipeline.lastAnalyzedAt < analysisIntervalMs) {
        frame.dispose();
        return;
      }

      const cpuResize = useCpuResize;
      const resizeBackend: ResizeBackend = cpuResize ? 'cpu' : 'native';
      if (!cpuResize && resizer == null) {
        frame.dispose();
        return;
      }

      pipeline.lastAnalyzedAt = now;
      const resizeStarted = Date.now();
      let pixels: Float32Array | null = null;
      const oriented = orientedFrameSize(
        frame.width,
        frame.height,
        frame.orientation,
      );
      let width = oriented.width;
      let height = oriented.height;
      let cameraAxes: CameraAxes = {
        originX: 0,
        originY: 0,
        xAxisX: 1,
        xAxisY: 0,
        yAxisX: 0,
        yAxisY: 1,
      };
      try {
        const origin = frame.convertFramePointToCameraPoint({ x: 0, y: 0 });
        const xAxis = frame.convertFramePointToCameraPoint({
          x: frame.width,
          y: 0,
        });
        const yAxis = frame.convertFramePointToCameraPoint({
          x: 0,
          y: frame.height,
        });
        cameraAxes = {
          originX: origin.x,
          originY: origin.y,
          xAxisX: xAxis.x,
          xAxisY: xAxis.y,
          yAxisX: yAxis.x,
          yAxisY: yAxis.y,
        };
      } catch {
        // Keep a 0-1 identity mapping if the Frame cannot convert points.
      }
      const bufferWidth = frame.width;
      const bufferHeight = frame.height;
      const orientation = frame.orientation;
      const isMirrored = frame.isMirrored;
      try {
        if (!cpuResize && resizer != null) {
          const resized = resizer.resize(frame);
          try {
            const view = new Float32Array(resized.getPixelBuffer());
            pixels = new Float32Array(view);
          } finally {
            resized.dispose();
          }
        } else if (frame.hasPixelBuffer || frame.isPlanar) {
          const letterboxed = letterboxFrameToPlanarRgb(frame, INPUT_SIZE);
          pixels = letterboxed.pixels;
          width = letterboxed.width;
          height = letterboxed.height;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const reason = message.includes('VkResult -13')
          ? 'vulkan oom'
          : message.slice(0, 48);
        runOnJS(enableCpuResize)(reason);
        frame.dispose();
        return;
      }
      frame.dispose();
      if (pixels === null) {
        return;
      }
      const resizeMs = Date.now() - resizeStarted;
      runOnJS(enqueueJob)({
        pixels,
        width,
        height,
        bufferWidth,
        bufferHeight,
        orientation,
        isMirrored,
        cameraAxes,
        resizeMs,
        resizeBackend,
      });

      pipeline.analyzed += 1;
      pipeline.latencySumMs += resizeMs;
      if (pipeline.batchStartedAt === 0) {
        pipeline.batchStartedAt = now;
      }
      if (now - pipeline.batchStartedAt >= hudIntervalMs) {
        const elapsedS = (now - pipeline.batchStartedAt) / 1000;
        runOnJS(applyHud)({
          cameraFps: pipeline.received / elapsedS,
          analysisFps: pipeline.analyzed / elapsedS,
          latencyMs: pipeline.latencySumMs / Math.max(1, pipeline.analyzed),
          width,
          height,
          recognizerName: 'recognizer: off (extraction spike)',
          extractorName: `extractor: ${manifest.model_version}`,
        });
        pipeline.received = 0;
        pipeline.analyzed = 0;
        pipeline.latencySumMs = 0;
        pipeline.batchStartedAt = now;
      }
    },
    [applyHud, enableCpuResize, enqueueJob, resizer, useCpuResize],
  );

  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.VGA_4_3,
    pixelFormat: useCpuResize ? 'yuv' : 'native',
    dropFramesWhileBusy: true,
    enablePhysicalBufferRotation: Platform.OS !== 'android' || useCpuResize,
    onFrame,
  });

  const hudStats = useMemo(() => {
    if (hud === null) {
      return {
        cameraFps: 0,
        analysisFps: 0,
        latencyMs: 0,
        width: 0,
        height: 0,
        recognizerName: modelStatus,
        extractorName: resizeNote
          ? `${modelStatus} · ${resizeNote}`
          : `extractor: ${manifest.model_version}`,
      } satisfies HudStats;
    }
    return {
      ...hud,
      extractorName: resizeNote
        ? `${modelStatus} · ${resizeNote}`
        : modelStatus,
      resizeMs: extraction?.timings.resizeMs,
      inferMs: extraction?.timings.inferMs,
      decodeMs: extraction?.timings.decodeMs,
      presence: extraction?.presence,
      accepted: extraction?.accepted,
      rejectionReason: extraction?.rejectionReason,
      delegate: extraction?.delegate,
    };
  }, [extraction, hud, modelStatus, resizeNote]);

  const resultBar = useMemo(() => {
    if (extraction?.accepted) {
      return {
        title: 'Card geometry locked',
        detail: `${Math.round(extraction.presence * 100)}% presence`,
        accent: '#00D4FF',
      };
    }
    if (extraction?.rejectionReason) {
      return {
        title: 'No safe card quad',
        detail: extraction.rejectionReason.split('_').join(' '),
        accent: '#FF5A5A',
      };
    }
    return {
      title: 'Scanning for cards…',
      detail: 'Hold a card inside the frame',
      accent: '#FFFFFF',
    };
  }, [extraction]);

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
    <View
      style={styles.flex}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setViewSize((current) =>
          current.width === width && current.height === height
            ? current
            : { width, height },
        );
      }}
    >
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        isActive={isFocused}
        device="back"
        outputs={[frameOutput]}
        resizeMode="cover"
        implementationMode="compatible"
        enableNativeTapToFocusGesture
      />
      <ExtractionOverlay
        points={overlayPoints}
        accepted={extraction?.accepted === true}
      />
      <View style={styles.guideWrap} pointerEvents="none">
        <View style={styles.guide} />
      </View>
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          {showHud ? (
            <View style={styles.hudWrap}>
              <DebugHud stats={hudStats} />
            </View>
          ) : null}
          <Pressable
            style={[styles.chip, showHud && styles.chipActive]}
            onPress={() => setShowHud((value) => !value)}
            hitSlop={12}
          >
            <Text style={styles.chipLabel}>HUD</Text>
          </Pressable>
        </View>
        <View style={styles.resultBar} pointerEvents="none">
          <ActivityIndicator
            animating={!extraction?.accepted}
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
    justifyContent: 'space-between',
    padding: 12,
    gap: 8,
  },
  hudWrap: {
    flex: 1,
    marginRight: 4,
  },
  chip: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    zIndex: 30,
    elevation: 30,
    flexShrink: 0,
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
