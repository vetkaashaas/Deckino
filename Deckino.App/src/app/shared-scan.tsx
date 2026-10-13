import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { clearSharedPayloads, useIncomingShare } from 'expo-sharing';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatPrice } from '@/components/card-visuals';
import { ExtractionOverlay } from '@/components/extraction-overlay';
import type { ScanTone } from '@/components/scan-frame';
import { ScanResultCard } from '@/components/scan-result-card';
import { extractorManifest } from '@/scan/models';
import { usePreferences } from '@/preferences';
import { scanStill, type StillScan } from '@/scan/scan-still';
import { useScannedPrinting } from '@/scan/use-scanned-printing';
import { colors, radius } from '@/theme';
import { upload, useTrainingUploads } from '@/training/training-upload';

export default function SharedScanScreen() {
  const { resolvedSharedPayloads, isResolving, error: shareError } = useIncomingShare();
  const sharedUri =
    resolvedSharedPayloads.find((payload) => payload.contentType === 'image')?.contentUri ?? null;
  const [scan, setScan] = useState<StillScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const { currency } = usePreferences();
  const uploads = useRef(false);
  uploads.current = useTrainingUploads(); // read when the scan ends, without scanning again when it changes

  useEffect(() => {
    if (sharedUri === null) {
      return;
    }
    let cancelled = false;
    setScan(null);
    setError(null);
    setUploadStatus(null);
    void (async () => {
      try {
        const result = await scanStill(sharedUri);
        if (cancelled) {
          return;
        }
        setScan(result);
        const corners = result.extraction.corners;
        const decision = result.recognition?.decision;
        if (corners === null || decision === undefined) {
          setUploadStatus('No card extracted, nothing uploaded');
          return;
        }
        if (!uploads.current) {
          setUploadStatus('Not uploaded: sign in and turn on Help improve recognition in Profile');
          return;
        }
        setUploadStatus('Uploading…');
        const predicted = decision.rejected ? null : decision.candidate.oracleId;
        const uploaded = await upload({
          image: result.image,
          corners,
          kind: predicted !== null ? 'locked' : 'unidentified',
          subject: predicted ?? 'unidentified',
          candidates: decision.candidates,
          predictedOracleId: predicted,
          modelVersion: result.modelVersion,
          extractorVersion: extractorManifest.model_version,
          upsideDown: false,
          source: 'shared',
        }).then(
          () => 'Uploaded for training',
          // The scan itself worked; only the upload failed, so say so under the photo.
          (failure: unknown) =>
            `Upload failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
        if (!cancelled) setUploadStatus(uploaded);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        // Handled: a later launch of the app must not scan the same share again. Cleared only now,
        // because clearing drops sharedUri and cancels this effect.
        if (!cancelled) clearSharedPayloads();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sharedUri]);

  const router = useRouter();
  const decision = scan?.recognition?.decision;
  const accepted = decision !== undefined && !decision.rejected ? decision.candidate : null;
  const printing = useScannedPrinting(accepted?.oracleId ?? null, accepted?.illustrationId ?? null);
  const result: {
    tone: ScanTone;
    title: string;
    detail: string;
    confidence?: number;
    action?: { label: string; onPress: () => void };
  } =
    error !== null || shareError !== null
      ? { tone: 'rejected', title: 'Scan failed', detail: error ?? shareError?.message ?? '' }
      : scan === null
        ? {
            tone: 'detecting',
            title: sharedUri === null && !isResolving ? 'No photo shared' : 'Scanning…',
            detail: sharedUri === null && !isResolving ? 'Share a photo of a card to Deckino.' : '',
          }
        : decision === undefined
          ? scan.extraction.corners === null
            ? { tone: 'rejected', title: 'No card found', detail: 'The extractor found no card in this photo.' }
            : {
                tone: 'rejected',
                title: 'Card unclear',
                detail: `The extractor was not confident (${scan.extraction.rejectionReason ?? 'rejected'}).`,
              }
          : decision.rejected
            ? {
                tone: 'rejected',
                title: 'Not sure',
                detail: `${decision.candidate.name}? ${decision.score.toFixed(2)}`,
              }
            : {
                tone: 'locked',
                title: decision.candidate.name,
                detail:
                  printing === null
                    ? `Score ${decision.score.toFixed(2)}`
                    : `${printing.setName} · ${formatPrice(printing[currency], currency)}`,
                confidence: decision.score,
                action:
                  printing === null
                    ? undefined
                    : { label: 'View card', onPress: () => router.push(`/card/${printing.id}`) },
              };

  // The photo is fitted into the area by hand so the overlay shares its exact box.
  const fit = scan === null ? 0 : Math.min(area.width / scan.image.width, area.height / scan.image.height);
  const box = { width: (scan?.image.width ?? 0) * fit, height: (scan?.image.height ?? 0) * fit };
  // Corners are normalized to the photo.
  const points =
    scan?.extraction.corners?.map((corner) => ({
      x: corner.x * box.width,
      y: corner.y * box.height,
      name: corner.name,
    })) ?? null;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.photoArea} onLayout={(event) => setArea(event.nativeEvent.layout)}>
        {scan !== null && fit > 0 ? (
          <View style={box}>
            <Image source={{ uri: scan.uri }} style={styles.image} contentFit="fill" />
            <ExtractionOverlay points={points} accepted={scan.extraction.accepted} />
          </View>
        ) : null}
      </View>
      {uploadStatus !== null ? <Text style={styles.status}>{uploadStatus}</Text> : null}
      <ScanResultCard {...result} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 16,
    gap: 12,
  },
  photoArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Rounded on the image, not its box: clipping the box would cut off corner labels near the edges.
  image: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.md,
  },
  status: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
});
