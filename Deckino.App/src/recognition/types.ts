export interface CardGuess {
  oracleId: string;
  cardName: string;
  confidence: number;
}

export type LockState =
  | { status: 'searching' }
  | { status: 'locked'; guess: CardGuess };
