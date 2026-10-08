import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Asset } from 'expo-asset';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Button, Host } from '@expo/ui';
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
import { ScanFrame, type ScanTone } from '@/components/scan-frame';
import { ScanResultCard } from '@/components/scan-result-card';
import { ScannerSettingsSheet } from '@/components/scanner-settings-sheet';
import { colors, gradients, radius } from '@/theme';
import {
  letterboxFrameToPlanarRgb,
  orientedFrameSize,
  stretchFrameToPlanarRgbU8,
  uprightToBufferUv,
} from '@/extraction/cpu-letterbox';
import { coverMap } from '@/extraction/letterbox';
import { interpretExtractor } from '@/extraction/load-extractor';
import { createExtractorSession } from '@/extraction/session';
import type {
  ExtractionResult,
  ExtractorThresholds,
  MobileExtractorManifest,
  NormalizedPoint,
} from '@/extraction/types';
import {
  createTemporalVoter,
  type CardGuess,
  type LockState,
  type TemporalVoterConfig,
} from '@/recognition';
import type { ArtworkAppLabels } from '@/recognition/artwork/artwork-decision';
import {
  loadArtworkRecognizer,
  type ArtworkRecognition,
  type ArtworkRecognizer,
} from '@/recognition/artwork/artwork-recognizer';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';
import type { ArtworkMobileManifest } from '@/recognition/artwork/types';
import {
  createTrainingUploader,
  trainingUploadConfigured,
} from '@/training/training-upload';
import manifestJson from '../../assets/models/extractor/mobile-manifest.json';
import thresholdsJson from '../../assets/models/extractor/thresholds.json';
import artworkManifestJson from '../../assets/models/artwork/mobile-manifest.json';
import artworkLabelsJson from '../../assets/models/artwork/app-labels.json';

const manifest = manifestJson as MobileExtractorManifest;
const thresholds = thresholdsJson as ExtractorThresholds;
const artworkManifest = artworkManifestJson as ArtworkMobileManifest;
const artworkLabels = artworkLabelsJson as ArtworkAppLabels;
const INPUT_SIZE = 320;
// The upright VGA frame the recognition crop is cut from (GPU resizer: an identity
// stretch of a 480x640 portrait frame). The CPU fallback samples a smaller copy.
const RECOGNITION_FRAME = { width: 480, height: 640 };
const CPU_RECOGNITION_FRAME = { width: 360, height: 480 };
// Lock once 4 of the last 6 recognized frames agree. A clear majority decides;
// score means over a handful of frames are too noisy to compare, so no margin.
const VOTER_CONFIG: TemporalVoterConfig = {
  windowSize: 6,
  lockThreshold: 4,
  releaseThreshold: 2,
  marginThreshold: Number.NEGATIVE_INFINITY,
  voteMaxAgeMs: 1500,
};

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
  /** Upright frame copy for the artwork crop; null when it could not be captured. */
  recognitionImage: RgbImage | null;
}

interface RecognitionJob {
  image: RgbImage;
  corners: NormalizedPoint[];
  /** The frame is upside down (see TrainingCapture.upsideDown). */
  upsideDown: boolean;
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
  const [showCornerLabels, setShowCornerLabels] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hud, setHud] = useState<HudStats | null>(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [overlayPoints, setOverlayPoints] = useState<OverlayPoint[] | null>(
    null,
  );
  const [modelStatus, setModelStatus] = useState('loading extractor');
  const [useCpuResize, setUseCpuResize] = useState(false);
  const [resizeNote, setResizeNote] = useState<string | null>(null);
  const [recognizerStatus, setRecognizerStatus] = useState('loading artwork');
  const [recognition, setRecognition] = useState<ArtworkRecognition | null>(
    null,
  );
  const [lock, setLock] = useState<LockState>({ status: 'searching' });
  const [uploadEnabled, setUploadEnabled] = useState(trainingUploadConfigured);
  const [uploadStatus, setUploadStatus] = useState('training uploads: none yet');
  const uploadEnabledRef = useRef(uploadEnabled);
  uploadEnabledRef.current = uploadEnabled;
  const [offerTrainingCapture] = useState(() => createTrainingUploader(setUploadStatus));
  const recognizerRef = useRef<ArtworkRecognizer | null>(null);
  const voterRef = useRef(createTemporalVoter(VOTER_CONFIG));
  const sessionRef = useRef<InferenceSession | null>(null);
  const delegateRef = useRef('cpu-onnx');
  const busyRef = useRef(false);
  const latestJob = useRef<ExtractorJob | null>(null);
  // Recognition has its own queue so it runs natively alongside the next extraction.
  const recognitionBusyRef = useRef(false);
  const latestRecognition = useRef<RecognitionJob | null>(null);

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
  const recognitionResizerState = useResizer({
    width: RECOGNITION_FRAME.width,
    height: RECOGNITION_FRAME.height,
    channelOrder: 'rgb',
    dataType: 'uint8',
    scaleMode: 'stretch',
    pixelLayout: 'planar',
  });
  const recognitionResizer =
    recognitionResizerState.state === 'ready'
      ? recognitionResizerState.resizer
      : null;

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadArtworkRecognizer(
          artworkManifest,
          artworkLabels,
          require('../../assets/models/artwork/recognizer.onnx'),
        );
        if (cancelled) {
          return;
        }
        recognizerRef.current = loaded;
        setRecognizerStatus(`artwork: ${loaded.modelVersion} · ${loaded.delegate}`);
        console.log(`Deckino artwork recognizer session: ${loaded.delegate}`);
      } catch (error) {
        setRecognizerStatus(
          `artwork failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
      recognizerRef.current = null;
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

  const drainRecognition = useCallback(async () => {
    if (recognitionBusyRef.current) {
      return;
    }
    recognitionBusyRef.current = true;
    try {
      while (latestRecognition.current !== null) {
        const job = latestRecognition.current;
        latestRecognition.current = null;
        const recognizer = recognizerRef.current;
        if (recognizer === null) {
          continue;
        }
        const recognized = await recognizer.recognize(job.image, job.corners);
        const decision = recognized.decision;
        setRecognition(recognized);
        const guess: CardGuess | null = decision.rejected
          ? null
          : {
              oracleId: decision.candidate.oracleId,
              cardName: decision.candidate.name,
              confidence: decision.score,
            };
        const lockState = voterRef.current(guess, Date.now());
        setLock(lockState);
        // Locked cards and unidentified card-shaped frames feed the Toolbox review queues.
        // A locked frame counts only when this frame itself names the locked card: the
        // lock outlives a card swap by a few frames, and those must not be labelled with it.
        if (uploadEnabledRef.current) {
          const locked =
            lockState.status === 'locked' &&
            !decision.rejected &&
            decision.candidate.oracleId === lockState.guess.oracleId
              ? lockState.guess.oracleId
              : null;
          offerTrainingCapture(
            job.corners,
            locked !== null || decision.rejected
              ? {
                  image: job.image,
                  corners: job.corners,
                  kind: locked !== null ? 'locked' : 'unidentified',
                  subject: locked ?? 'unidentified',
                  candidates: decision.candidates,
                  predictedOracleId: locked,
                  upsideDown: job.upsideDown,
                  modelVersion: recognizer.modelVersion,
                  extractorVersion: manifest.model_version,
                }
              : null,
          );
        }
        console.log(
          `Deckino artwork ${decision.candidate.name} ${decision.score.toFixed(3)}${decision.rejected ? ` (${decision.rejectionReason})` : ''} · ${recognized.timings.prepareMs}ms prepare / ${recognized.timings.inferMs}ms infer`,
        );
      }
    } catch (error) {
      setRecognizerStatus(
        `recognize failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      recognitionBusyRef.current = false;
      if (latestRecognition.current !== null) {
        void drainRecognition();
      }
    }
  }, []);

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

        // Identify the card only on a safe quad, without waiting for it: the next
        // extraction starts at once and a slower recognition keeps only the newest
        // quad. Every frame without a safe quad is a miss for the voter.
        if (result.accepted && result.corners !== null && job.recognitionImage !== null) {
          latestRecognition.current = {
            image: job.recognitionImage,
            corners: result.corners,
            // The GPU resizer turns a sideways sensor frame the opposite way to the
            // phone's real up, so its "upright" frame is upside down (seen on Android,
            // 2026-10). The models don't mind; training photos should be upright.
            upsideDown:
              job.resizeBackend === 'native' &&
              (job.orientation === 'left' || job.orientation === 'right'),
          };
          void drainRecognition();
        } else {
          latestRecognition.current = null;
          setRecognition(null);
          setLock(voterRef.current(null, Date.now()));
        }
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
  }, [applyExtraction, drainRecognition, mapCornersToView]);

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
      let recognitionImage: RgbImage | null = null;
      try {
        if (!cpuResize && recognitionResizer != null) {
          const resized = recognitionResizer.resize(frame);
          try {
            recognitionImage = {
              data: new Uint8Array(new Uint8Array(resized.getPixelBuffer())),
              width: resized.width,
              height: resized.height,
              layout: 'planar',
            };
          } finally {
            resized.dispose();
          }
        } else if (cpuResize && (frame.hasPixelBuffer || frame.isPlanar)) {
          const size = CPU_RECOGNITION_FRAME;
          recognitionImage = {
            data: stretchFrameToPlanarRgbU8(frame, size.width, size.height),
            width: size.width,
            height: size.height,
            layout: 'planar',
          };
        }
      } catch {
        // Extraction still runs; this frame just cannot be identified.
        recognitionImage = null;
      }
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
        recognitionImage,
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
          recognizerName: '',
          extractorName: `extractor: ${manifest.model_version}`,
        });
        pipeline.received = 0;
        pipeline.analyzed = 0;
        pipeline.latencySumMs = 0;
        pipeline.batchStartedAt = now;
      }
    },
    [
      applyHud,
      enableCpuResize,
      enqueueJob,
      recognitionResizer,
      resizer,
      useCpuResize,
    ],
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
        recognizerName: recognizerStatus,
        extractorName: resizeNote
          ? `${modelStatus} · ${resizeNote}`
          : `extractor: ${manifest.model_version}`,
      } satisfies HudStats;
    }
    return {
      ...hud,
      recognizerName: recognizerStatus,
      artworkLine:
        recognition === null
          ? undefined
          : `art ${recognition.decision.score.toFixed(2)} ${recognition.decision.candidate.name} · ${recognition.timings.prepareMs}+${recognition.timings.inferMs} ms`,
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
  }, [extraction, hud, modelStatus, recognition, recognizerStatus, resizeNote]);

  const resultBar = useMemo((): {
    title: string;
    detail: string;
    tone: ScanTone;
    confidence?: number;
  } => {
    if (lock.status === 'locked') {
      return {
        title: lock.guess.cardName,
        detail: `Score ${lock.guess.confidence.toFixed(2)}`,
        tone: 'locked',
        confidence: lock.guess.confidence,
      };
    }
    if (extraction?.accepted) {
      const decision = recognition?.decision;
      let detail = 'Reading the artwork…';
      if (decision?.rejectionReason === 'ambiguous_artwork') {
        detail = `Shared artwork: ${decision.candidate.name}?`;
      } else if (decision?.rejected) {
        detail = `Not sure (${decision.candidate.name}? ${decision.score.toFixed(2)})`;
      } else if (decision) {
        detail = `${decision.candidate.name} · ${decision.score.toFixed(2)}`;
      }
      return {
        title: 'Identifying card…',
        detail,
        tone: 'detecting',
        confidence: decision?.score,
      };
    }
    if (extraction?.rejectionReason) {
      return {
        title: 'No safe card quad',
        detail: extraction.rejectionReason.split('_').join(' '),
        tone: 'rejected',
      };
    }
    return {
      title: 'Scanning for cards…',
      detail: 'Hold a card inside the frame',
      tone: 'idle',
    };
  }, [extraction, lock, recognition]);

  if (!hasPermission && !canRequestPermission) {
    return (
      <SafeAreaView style={styles.center}>
        <View style={styles.permissionIcon}>
          <SymbolView
            name={{ ios: 'video.slash.fill', android: 'videocam_off' }}
            size={34}
            tintColor={colors.text}
          />
        </View>
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
        <View style={styles.permissionIcon}>
          <SymbolView
            name={{ ios: 'camera.fill', android: 'photo_camera' }}
            size={34}
            tintColor={colors.text}
          />
        </View>
        <Text style={styles.heading}>Let Deckino see your cards</Text>
        <Text style={styles.body}>
          Point your camera at Magic: The Gathering cards to identify them in
          real time.
        </Text>
        <Host matchContents colorScheme="dark" seedColor={colors.purple}>
          <Button
            label="Grant camera access"
            onPress={() => void requestPermission()}
          />
        </Host>
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
        // The app is portrait-only. 'device' reads the phone's tilt, which is ambiguous when the
        // phone points down at a card on a table, and turned frames by a random 90°/180°.
        orientationSource="interface"
        outputs={[frameOutput]}
        resizeMode="cover"
        implementationMode="compatible"
        enableNativeTapToFocusGesture
      />
      <ScanFrame tone={resultBar.tone} />
      <ExtractionOverlay
        points={overlayPoints}
        accepted={extraction?.accepted === true}
        showLabels={showCornerLabels}
      />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="box-none">
          <View style={styles.topBarSide} />
          <Image
            source={require('../../assets/images/brand/logo-white.svg')}
            style={styles.logo}
            contentFit="contain"
            accessibilityLabel="Deckino"
          />
          <View style={[styles.topBarSide, styles.topBarEnd]}>
            <Pressable
              style={({ pressed }) => [
                styles.iconButton,
                pressed && styles.iconButtonPressed,
              ]}
              onPress={() => setSettingsOpen(true)}
              hitSlop={12}
              accessibilityLabel="Scanner settings"
            >
              <SymbolView
                name={{ ios: 'slider.horizontal.3', android: 'tune' }}
                size={20}
                tintColor={colors.text}
              />
            </Pressable>
          </View>
        </View>
        {showHud ? (
          <View style={styles.hudWrap} pointerEvents="none">
            <DebugHud stats={hudStats} />
          </View>
        ) : null}
        <View style={styles.spacer} pointerEvents="none" />
        <View style={styles.resultWrap} pointerEvents="none">
          <ScanResultCard
            tone={resultBar.tone}
            title={resultBar.title}
            detail={resultBar.detail}
            confidence={resultBar.confidence}
          />
        </View>
      </SafeAreaView>
      <ScannerSettingsSheet
        isPresented={settingsOpen}
        onDismiss={() => setSettingsOpen(false)}
        showHud={showHud}
        onShowHudChange={setShowHud}
        showCornerLabels={showCornerLabels}
        onShowCornerLabelsChange={setShowCornerLabels}
        trainingUpload={
          trainingUploadConfigured
            ? { enabled: uploadEnabled, onChange: setUploadEnabled }
            : null
        }
        statusLines={[
          resizeNote ? `${modelStatus} · ${resizeNote}` : modelStatus,
          recognizerStatus,
          ...(trainingUploadConfigured ? [uploadStatus] : []),
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 32,
    experimental_backgroundImage:
      'radial-gradient(circle at 50% 35%, rgba(152, 29, 206, 0.30) 0%, rgba(11, 6, 16, 0) 60%)',
  },
  permissionIcon: {
    width: 76,
    height: 76,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    experimental_backgroundImage: gradients.brandDiagonal,
    boxShadow: '0 10px 30px rgba(152, 29, 206, 0.45)',
  },
  heading: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  overlay: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  topBarSide: {
    width: 44,
  },
  topBarEnd: {
    alignItems: 'flex-end',
  },
  logo: {
    flex: 1,
    height: 40,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    zIndex: 30,
    elevation: 30,
  },
  iconButtonPressed: {
    backgroundColor: 'rgba(152, 29, 206, 0.6)',
  },
  hudWrap: {
    paddingHorizontal: 16,
  },
  spacer: {
    flex: 1,
  },
  resultWrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
});
