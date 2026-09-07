import { InferenceSession } from 'onnxruntime-react-native';

interface SessionAttempt {
  label: string;
  options: InferenceSession.SessionOptions;
}

const ATTEMPTS: SessionAttempt[] = [
  {
    label: 'xnnpack',
    options: {
      executionProviders: [{ name: 'xnnpack' }],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 4,
      enableCpuMemArena: true,
      enableMemPattern: true,
    },
  },
  {
    label: 'nnapi+xnnpack',
    options: {
      executionProviders: [
        { name: 'nnapi', useFP16: true, useNCHW: true },
        { name: 'xnnpack' },
      ],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 2,
      enableCpuMemArena: true,
      enableMemPattern: true,
    },
  },
  {
    label: 'cpu',
    options: {
      executionProviders: [{ name: 'cpu', useArena: true }],
      graphOptimizationLevel: 'all',
    },
  },
];

export async function createExtractorSession(uri: string): Promise<{
  session: InferenceSession;
  delegate: string;
}> {
  let lastError: unknown;
  for (const attempt of ATTEMPTS) {
    try {
      const session = await InferenceSession.create(uri, attempt.options);
      return { session, delegate: attempt.label };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}
