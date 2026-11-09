# Card title reader drop-in

Filled by `scripts/ensure-title-reader.ps1`, which `scripts/deckino-android-dev.ps1` and
`scripts/build-android-release.ps1` run. Do not edit these files by hand.

- `title-reader.onnx` (git-ignored): PaddleOCR's PP-OCRv5 English text recognizer (Apache-2.0), pinned
  by checksum. Input one title strip (3 x 48 x width, BGR in [-1, 1]), output characters per step.
- `characters.json`: the recognizer's characters (class 0 is the CTC blank, the last class a space).
- `title-manifest.json`: schema, checksum and the constants the app shares with the Toolbox (where the
  title is on the card, the strip widths, the match thresholds).

## What it does

When the artwork model is unsure of a frame, the app reads the card's printed name and matches it
against the artwork model's top 5 cards, then against every card name (`src/recognition/identify.ts`).
Frames the artwork model accepts never run it. Training uploads record which way the card was found
(`RecognitionMethod`: embeddings, ocr-top5 or ocr-all) and what the title read (`TitleText`).

The Toolbox's `title_ocr.py` is the reference: the ensure script exports its constants and a fixture
and `scripts/verify-title-reader.mjs` proves `src/recognition/title/title-core.ts` reproduces it.
