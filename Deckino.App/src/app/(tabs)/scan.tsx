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
import { useFocusEffect, useRouter } from 'expo-router';
import { useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import {
  Camera,
  CommonResolutions,
  useCameraPermission,
  useFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import { useResizer } from 'react-native-vision-camera-resizer';
import { runOnJS } from 'react-native-worklets';
import type { InferenceSession } from 'onnxruntime-react-native';

import { DebugHud, type HudStats } from '@/components/debug-hud';
import {
  ExtractionOverlay,
  type OverlayPoint,
} from '@/components/extraction-overlay';
import { badgesFor, FlyingCard, ScanHint, ScanToast } from '@/components/scan-feedback';
import { guideWidth, ScanFrame, type GuideArea, type ScanTone } from '@/components/scan-frame';
import { ScannerSettingsSheet } from '@/components/scanner-settings-sheet';
import { TrayBar } from '@/components/tray-bar';
import { useOwnership } from '@/api/wishlist';
import { setE2ELock, useE2ELock } from '@/scan/e2e-lock';
import { formatPrice } from '@/components/card-visuals';
import { Avatar } from '@/components/ui';
import { addToTray, useTray, type TrayCard } from '@/scan/tray';
import { createVisitTracker } from '@/scan/visit-tracker';
import { useScannedPrinting } from '@/scan/use-scanned-printing';
import { colors, gradients, radius } from '@/theme';
import {
  letterboxFrameToPlanarRgb,
  orientedFrameSize,
  stretchFrameToPlanarRgbU8,
  uprightToBufferUv,
} from '@/extraction/cpu-letterbox';
import { coverMap } from '@/extraction/letterbox';
import type {
  ExtractionResult,
  NormalizedPoint,
} from '@/extraction/types';
import {
  createTemporalVoter,
  type CardGuess,
  type LockState,
  type TemporalVoterConfig,
} from '@/recognition';
import {
  type ArtworkRecognition,
  type ArtworkRecognizer,
} from '@/recognition/artwork/artwork-recognizer';
import type { RgbImage } from '@/recognition/artwork/recognition-crop';
import type { Finish } from '@/api/binders';
import { useSignedIn } from '@/api/session';
import { usePreferences } from '@/preferences';
import { createTrainingUploader, useTrainingUploads } from '@/training/training-upload';
import {
  EXTRACTOR_INPUT_SIZE as INPUT_SIZE,
  extractorManifest as manifest,
  getArtworkRecognizer,
  getExtractor,
  refineFrameCorners,
  runExtractor,
} from '@/scan/models';

// The upright VGA frame the recognition crop is cut from (an identity stretch of a
// 480x640 portrait frame, on the GPU or the CPU fallback). It is also the training upload.
const RECOGNITION_FRAME = { width: 480, height: 640 };
// The GPU path's PRIVATE frames need a HardwareBuffer the phone's allocator accepts at that size;
// CameraX checks it up front (the Galaxy S24 Ultra refuses 640x480). Try these 4:3 sizes, then CPU.
const NATIVE_RESOLUTIONS = [
  CommonResolutions.VGA_4_3,
  CommonResolutions.HD_4_3,
  CommonResolutions.FHD_4_3,
];
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
  gpuProbed?: boolean;
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

let askedThisRun = false;

/** How long the pill naming an added card stays once the card is out of view. */
const ADDED_PILL_MS = 1500;
/** Where an added card flies to: the centre of the tray bar's first thumbnail (tray-bar.tsx), measured from the
 * bottom controls' left and bottom edges; the newest of the three shown sits `step` right of the one before. */
const TRAY_THUMB = { left: 42, fromBottom: 47, width: 34, step: 14 };
export default function ScanScreen() {
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => {
        setIsFocused(false);
        setE2ELock(null);
      };
    }, []),
  );
  // Signed in, the first visit asks whether scan photos may help train the scanner. Once per run: backing out of
  // the question without an answer leaves it for the next start, and nothing uploads meanwhile.
  const router = useRouter();
  const signedIn = useSignedIn();
  const { trainingPhotosAsked, scanSound, haptics, currency } = usePreferences();
  useEffect(() => {
    if (!isFocused || !signedIn || trainingPhotosAsked || askedThisRun) return;
    askedThisRun = true;
    router.push('/help-improve');
  }, [isFocused, signedIn, trainingPhotosAsked, router]);
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();
  // Ask on first open instead of waiting for a tap; the button below covers a dismissed dialog. Only once the tab is
  // shown: the tabs mount together at launch, and the dialog would otherwise land on the welcome screen.
  useEffect(() => {
    console.log(`camera: permission ${hasPermission ? 'granted' : 'missing'}, can request ${canRequestPermission}`);
    if (isFocused && !hasPermission && canRequestPermission) void requestPermission().catch(() => {});
  }, [isFocused, hasPermission, canRequestPermission, requestPermission]);
  useEffect(() => {
    console.log(`camera: screen ${isFocused ? 'focused' : 'blurred'}`);
  }, [isFocused]);
  const cameraRef = useRef<ComponentRef<typeof Camera>>(null);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const [guideArea, setGuideArea] = useState<GuideArea | null>(null);
  const [bottomEdge, setBottomEdge] = useState<number | null>(null);
  const [showHud, setShowHud] = useState(false);
  const [showCornerLabels, setShowCornerLabels] = useState(false);
  // High accuracy: the corner refiner runs on each frame sent to recognition (two small
  // model runs). Off, recognition uses the extractor's corners as they are.
  const [highAccuracy, setHighAccuracy] = useState(true);
  const highAccuracyRef = useRef(highAccuracy);
  highAccuracyRef.current = highAccuracy;
  const [refineMs, setRefineMs] = useState<number | null>(null);
  const [refinerError, setRefinerError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hud, setHud] = useState<HudStats | null>(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [overlayPoints, setOverlayPoints] = useState<OverlayPoint[] | null>(
    null,
  );
  const [modelStatus, setModelStatus] = useState('loading extractor');
  const [useCpuResize, setUseCpuResize] = useState(false);
  const [nativeResolution, setNativeResolution] = useState(0);
  // The default handler only console.errors, which a release build hides behind a black preview.
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [resizeNote, setResizeNote] = useState<string | null>(null);
  const [recognizerStatus, setRecognizerStatus] = useState('loading artwork');
  const [recognition, setRecognition] = useState<ArtworkRecognition | null>(
    null,
  );
  const [lock, setLock] = useState<LockState>({ status: 'searching' });
  // A chime and a buzz for each card added.
  // expo-audio's default mode mixes with other apps' audio and respects iOS silent mode.
  const chime = useAudioPlayer(require('../../../assets/sounds/card-identified.wav'));
  const announce = () => {
    if (scanSound) {
      chime.seekTo(0);
      chime.play();
    }
    if (haptics) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
  const lockedOracleId = lock.status === 'locked' ? lock.guess.oracleId : null;
  const printing = useScannedPrinting(
    lockedOracleId,
    lock.status === 'locked' ? lock.guess.illustrationId : null,
  );
  // Each card goes in the tray once per visit (src/scan/visit-tracker.ts).
  const [visit] = useState(createVisitTracker);
  const [visitNote, setVisitNote] = useState(visit.note);
  useEffect(() => {
    if (lock.status !== 'locked' || printing === null) return;
    const add = visit.locked(lock.guess.oracleId, Date.now());
    setVisitNote(visit.note);
    if (!add) return;
    addToTray({
      ...printing,
      oracleId: lock.guess.oracleId,
      name: lock.guess.cardName,
      illustrationId: lock.guess.illustrationId,
      smallImage: printing.image,
      finishes: printing.finishes as Finish[],
    });
  }, [lock, printing, visit]);
  useEffect(() => {
    if (extraction === null) return;
    visit.frame(extraction.rejectionReason === 'presence_below_threshold', Date.now());
    setVisitNote(visit.note);
  }, [extraction, visit]);
  // A card joining the tray (from the camera, or deckino://e2e-scan) flies into it, and its pill stays while the card
  // is in view and a moment after. Only a new card: +1 and an undone removal don't (tray keys only grow).
  const tray = useTray();
  const [added, setAdded] = useState<TrayCard | null>(null);
  const [flying, setFlying] = useState<TrayCard | null>(null);
  const newestKey = useRef(Number(tray.at(-1)?.key ?? -1));
  useEffect(() => {
    const last = tray.at(-1);
    if (last === undefined || Number(last.key) <= newestKey.current) return;
    newestKey.current = Number(last.key);
    setAdded(last);
    setFlying(last);
    announce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray]);
  // The card in view: the camera's lock, or in dev and E2E builds the one deckino://e2e-scan sent.
  const e2eLock = useE2ELock();
  const seenOracleId = lock.status === 'locked' ? lock.guess.oracleId : e2eLock?.oracleId;
  const addedInView = added !== null && added.printing.oracleId === seenOracleId;
  useEffect(() => {
    if (added === null || addedInView) return;
    const timer = setTimeout(() => setAdded(null), ADDED_PILL_MS);
    return () => clearTimeout(timer);
  }, [added, addedInView]);
  const pill = added?.printing ?? null;
  const ownership = useOwnership(pill?.oracleId ?? null).data;
  const uploadEnabled = useTrainingUploads();
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
  useEffect(() => {
    console.log(
      `recognition resizer: ${recognitionResizerState.state}`,
      recognitionResizerState.state === 'error' ? recognitionResizerState.error : '',
    );
  }, [recognitionResizerState]);

  const firstFrameLogged = useRef(false);
  const applyHud = useCallback((stats: HudStats) => {
    if (!firstFrameLogged.current) {
      firstFrameLogged.current = true;
      console.log(`camera: first analysed frame ${stats.width}x${stats.height}`);
    }
    setHud(stats);
  }, []);
  const logGpuProbe = useCallback((lines: string) => console.log(lines), []);
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
    console.log(`gpu resizer: ${resizerState.state}`, resizerState.state === 'error' ? resizerState.error : '');
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
        const loaded = await getExtractor();
        if (cancelled) {
          return;
        }
        sessionRef.current = loaded.session;
        delegateRef.current = loaded.delegate;
        setModelStatus(`extractor: ${manifest.model_version}`);
        console.log(`Deckino extractor session: ${loaded.delegate}`);
      } catch (error) {
        console.error('extractor failed to load', error);
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
        const loaded = await getArtworkRecognizer();
        if (cancelled) {
          return;
        }
        recognizerRef.current = loaded;
        setRecognizerStatus(`artwork: ${loaded.modelVersion} · ${loaded.delegate}`);
        console.log(`Deckino artwork recognizer session: ${loaded.delegate}`);
      } catch (error) {
        console.error('artwork recognizer failed to load', error);
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
        let corners = job.corners;
        let refinedIn: number | null = null;
        if (highAccuracyRef.current) {
          const refineStarted = Date.now();
          try {
            corners = (await refineFrameCorners(job.image, job.corners)).corners;
            refinedIn = Date.now() - refineStarted;
            setRefinerError(null);
          } catch (error) {
            // Recognition still runs on the extractor's corners.
            setRefinerError(`refiner failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const recognized = await recognizer.recognize(job.image, corners);
        const decision = recognized.decision;
        setRecognition(recognized);
        setRefineMs(refinedIn);
        const guess: CardGuess | null = decision.rejected
          ? null
          : {
              oracleId: decision.candidate.oracleId,
              cardName: decision.candidate.name,
              confidence: decision.score,
              illustrationId: decision.candidate.illustrationId,
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
                  corners,
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
        const result = await runExtractor(
          { session, delegate: delegateRef.current },
          job.pixels,
          job.width,
          job.height,
          job.resizeMs,
        );
        applyExtraction(result);
        if (result.corners === null) {
          lastMappedRef.current = null;
          setOverlayPoints(null);
        } else {
          lastMappedRef.current = { corners: result.corners, job };
          setOverlayPoints(mapCornersToView(result.corners, job));
        }

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

      // The CPU path means this phone refused 'native' frames. Test once whether the GPU
      // resizers take its YUV frames instead, which would bring the GPU path back.
      if (cpuResize && !pipeline.gpuProbed) {
        pipeline.gpuProbed = true;
        const lines = [
          `gpu probe: frame ${frame.pixelFormat} ${frame.width}x${frame.height} ${frame.orientation} planar=${frame.isPlanar} pixelBuffer=${frame.hasPixelBuffer} nativeBuffer=${frame.hasNativeBuffer}`,
        ];
        const probes = [
          { name: 'extractor', candidate: resizer },
          { name: 'recognition', candidate: recognitionResizer },
        ];
        for (const { name, candidate } of probes) {
          if (candidate == null) {
            lines.push(`gpu probe: ${name} resizer not ready`);
            continue;
          }
          const started = Date.now();
          try {
            const resized = candidate.resize(frame);
            lines.push(`gpu probe: ${name} resize ok ${resized.width}x${resized.height} in ${Date.now() - started} ms`);
            resized.dispose();
          } catch (error) {
            lines.push(`gpu probe: ${name} resize failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        runOnJS(logGpuProbe)(lines.join(' | '));
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
          const size = RECOGNITION_FRAME;
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
      logGpuProbe,
      recognitionResizer,
      resizer,
      useCpuResize,
    ],
  );

  const frameOutput = useFrameOutput({
    targetResolution: useCpuResize ? CommonResolutions.VGA_4_3 : NATIVE_RESOLUTIONS[nativeResolution],
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
        visitLine: visitNote,
      } satisfies HudStats;
    }
    return {
      ...hud,
      recognizerName: recognizerStatus,
      artworkLine:
        recognition === null
          ? undefined
          : `art ${recognition.decision.score.toFixed(2)} ${recognition.decision.candidate.name} · ${refineMs === null ? '' : `refine ${refineMs} + `}${recognition.timings.prepareMs}+${recognition.timings.inferMs} ms`,
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
      visitLine: visitNote,
    };
  }, [extraction, hud, modelStatus, recognition, recognizerStatus, refineMs, resizeNote, visitNote]);

  // The frame's colour shows how the scan is going; words only when something needs fixing.
  let tone: ScanTone = 'idle';
  let hint: string | null = null;
  if (cameraError !== null) hint = "Camera didn't start. Close other apps using it.";
  else if (extraction?.rejectionReason === 'invalid_quadrilateral') hint = 'Fit the whole card in the frame';
  else if (extraction?.rejectionReason === 'ambiguous_card_geometry') hint = 'One card at a time';
  if (seenOracleId) tone = 'locked';
  else if (hint !== null) tone = 'rejected';
  else if (extraction?.accepted) tone = 'detecting';
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
        {/* A plain Pressable: the @expo/ui Host laid out zero-wide here, so the drawn button took no taps. */}
        <Pressable
          accessibilityRole="button"
          onPress={() => void requestPermission().catch(() => {})}
          style={({ pressed }) => [styles.permissionButton, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.permissionButtonLabel}>Grant camera access</Text>
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
        // The app is portrait-only. 'device' reads the phone's tilt, which is ambiguous when the
        // phone points down at a card on a table, and turned frames by a random 90°/180°.
        orientationSource="interface"
        outputs={[frameOutput]}
        resizeMode="cover"
        implementationMode="compatible"
        enableNativeTapToFocusGesture
        onSessionConfigSelected={(config) => console.log(`camera: session config ${config.selectedFPS ?? '?'} fps`)}
        onConfigured={() => console.log('camera: configured')}
        onStarted={() => {
          console.log('camera: started');
          setCameraError(null);
        }}
        onStopped={() => console.log('camera: stopped')}
        onPreviewStarted={() => console.log('camera: preview started')}
        onPreviewStopped={() => console.log('camera: preview stopped')}
        onInterruptionStarted={(reason) => console.warn('camera: interrupted', reason)}
        onInterruptionEnded={() => console.log('camera: interruption ended')}
        onError={(error) => {
          // Refused native frames are expected on some devices (the emulator) and fall back below, with a warning.
          if (!useCpuResize && error.message.includes('not supported for ImageAnalysis')) {
            const next = nativeResolution + 1;
            if (next < NATIVE_RESOLUTIONS.length) {
              const { width, height } = NATIVE_RESOLUTIONS[next];
              console.warn(`camera: native frames refused, trying ${width}x${height}`);
              setNativeResolution(next);
            } else {
              // YUV analysis works on every phone.
              enableCpuResize('native frames unsupported');
            }
            return;
          }
          console.error('camera error', error);
          setCameraError(error.message);
        }}
      />
      <ScanFrame tone={tone} area={guideArea} cardInView={overlayPoints !== null} />
      <ExtractionOverlay points={overlayPoints} tone={tone} showLabels={showCornerLabels} />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="box-none">
          <View style={styles.topBarSide}>
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
          <Image
            source={require('../../../assets/images/brand/logo-white.svg')}
            style={styles.logo}
            contentFit="contain"
            accessibilityLabel="Deckino"
          />
          <View style={[styles.topBarSide, styles.topBarEnd]}>
            <Avatar />
          </View>
        </View>
        {showHud ? (
          <View style={styles.hudWrap} pointerEvents="none">
            <DebugHud stats={hudStats} />
          </View>
        ) : null}
        <View style={styles.message} pointerEvents="box-none">
          {pill ? (
            <ScanToast
              name={pill.name}
              detail={formatPrice(pill.prices[currency], currency)}
              badges={ownership && badgesFor(ownership)}
              onPress={() => router.push(`/card/${pill.id}`)}
            />
          ) : hint !== null ? (
            <ScanHint text={hint} />
          ) : null}
        </View>
        {/* The guide is drawn beneath, in this band: clear of the controls above and below. */}
        <View
          style={styles.spacer}
          pointerEvents="none"
          onLayout={({ nativeEvent: { layout } }) =>
            setGuideArea((current) =>
              current?.y === layout.y && current.width === layout.width && current.height === layout.height
                ? current
                : { y: layout.y, width: layout.width, height: layout.height },
            )
          }
        />
        <View
          style={styles.bottom}
          pointerEvents="box-none"
          onLayout={({ nativeEvent: { layout } }) => setBottomEdge(layout.y + layout.height)}
        >
          <TrayBar />
        </View>
      </SafeAreaView>
      {flying && guideArea && bottomEdge !== null ? (
        <FlyingCard
          key={flying.key}
          uri={flying.printing.smallImage ?? flying.printing.image}
          from={{ x: viewSize.width / 2, y: guideArea.y + guideArea.height / 2, width: guideWidth(guideArea) }}
          to={{
            x: TRAY_THUMB.left + TRAY_THUMB.step * (Math.min(tray.length, 3) - 1),
            y: bottomEdge - TRAY_THUMB.fromBottom,
            width: TRAY_THUMB.width,
          }}
          onDone={() => setFlying(null)}
        />
      ) : null}
      <ScannerSettingsSheet
        isPresented={settingsOpen}
        onDismiss={() => setSettingsOpen(false)}
        showHud={showHud}
        onShowHudChange={setShowHud}
        showCornerLabels={showCornerLabels}
        onShowCornerLabelsChange={setShowCornerLabels}
        highAccuracy={highAccuracy}
        onHighAccuracyChange={setHighAccuracy}
        statusLines={[
          resizeNote ? `${modelStatus} · ${resizeNote}` : modelStatus,
          recognizerStatus,
          ...(refinerError === null ? [] : [refinerError]),
          ...(uploadEnabled ? [uploadStatus] : []),
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
      'radial-gradient(circle at 50% 35%, rgba(121, 17, 203, 0.30) 0%, rgba(11, 6, 16, 0) 60%)',
  },
  permissionIcon: {
    width: 76,
    height: 76,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    experimental_backgroundImage: gradients.brandDiagonal,
    boxShadow: '0 10px 30px rgba(121, 17, 203, 0.45)',
  },
  permissionButton: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: radius.pill,
    experimental_backgroundImage: gradients.brand,
  },
  permissionButtonLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
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
    backgroundColor: 'rgba(121, 17, 203, 0.6)',
  },
  hudWrap: {
    paddingHorizontal: 16,
  },
  // Room for the pill with a line of badges, so the guide below doesn't jump as it comes and goes.
  message: {
    minHeight: 76,
    paddingHorizontal: 16,
  },
  spacer: {
    flex: 1,
  },
  // Room for the tray bar, so the guide doesn't jump when the tray appears.
  bottom: {
    minHeight: 84,
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
});
