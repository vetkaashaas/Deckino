import type { RecognitionMethod } from './identify';

export interface CardGuess {
  oracleId: string;
  cardName: string;
  confidence: number;
  /** The artwork matched in the latest frame of this card, when the labels know it. */
  illustrationId: string | null;
  /** How this frame found the card. */
  method: RecognitionMethod;
}

export type LockState =
  | { status: 'searching' }
  | { status: 'locked'; guess: CardGuess };
