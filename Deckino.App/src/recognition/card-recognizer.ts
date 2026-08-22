import type { Frame } from 'react-native-vision-camera';

import { createMockCardRecognizer } from './mock-card-recognizer';
import type { CardGuess } from './types';

export type ICardRecognizer = (frame: Frame) => CardGuess | null;

export interface CardRecognizerDescriptor {
  readonly name: string;
  readonly recognize: ICardRecognizer;
}

export function createCardRecognizer(): CardRecognizerDescriptor {
  'worklet';
  return {
    name: 'mock',
    recognize: createMockCardRecognizer(),
  };
}
