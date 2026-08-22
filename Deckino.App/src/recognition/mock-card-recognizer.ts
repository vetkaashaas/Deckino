import type { ICardRecognizer } from './card-recognizer';

export function createMockCardRecognizer(): ICardRecognizer {
  'worklet';
  const cards = [
    { scryfallId: 'mock-black-lotus', cardName: 'Black Lotus' },
    { scryfallId: 'mock-lightning-bolt', cardName: 'Lightning Bolt' },
    { scryfallId: 'mock-counterspell', cardName: 'Counterspell' },
    { scryfallId: 'mock-serra-angel', cardName: 'Serra Angel' },
  ] as const;
  const holdMs = 3000;
  const missRate = 0.08;
  let firstSeenAt = -1;

  return (_frame) => {
    const now = Date.now();
    if (firstSeenAt < 0) {
      firstSeenAt = now;
    }
    if (Math.random() < missRate) {
      return null;
    }
    const elapsed = now - firstSeenAt;
    const card = cards[Math.floor(elapsed / holdMs) % cards.length];
    const phase = (elapsed % holdMs) / holdMs;
    const jitter = Math.random() * 0.06;
    const confidence = Math.min(0.99, 0.7 + 0.28 * phase + jitter);
    return {
      scryfallId: card.scryfallId,
      cardName: card.cardName,
      confidence,
    };
  };
}
