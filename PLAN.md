# Deckino — Design & Direction

Living document. Describes what we're building, why, and the shape of the solution.
Intentionally **not** a task list — sequencing stays flexible; this captures decisions and direction only.

---

## What Deckino is

A Magic: The Gathering collection companion:

- **App** (`Deckino.App`) — Expo app, Android first. Continuous camera scanning that identifies cards in real time.
- **Site** (`Deckino.Site`) — web-facing management site + backend the app connects to. *(Out of scope for now.)*
- **Tools** (`Deckino.Tools`) — WPF desktop app for internal work: dataset building, image annotation, model training orchestration, admin utilities.

**PoC goal:** open app → scan page → camera opens → continuously identify MTG cards.
**Recognition scope:** card name + Scryfall ID guess. Exact printing/set identification is out of scope for now.

## Success criteria

- **Sub-200ms scan time end-to-end** on mid-range Android hardware.
- Priority ratio: **40% speed / 60% accuracy** — accuracy wins ties, but never at the cost of sluggishness.
- Continuous scanning UX: lock-in feels instant, misreads get rejected instead of flashing wrong results.

## Recognition philosophy

This is a **closed-set computer vision problem** (~27k known classes via Scryfall), so specialized small models beat general-purpose ones decisively on both speed and accuracy.

**Explicitly rejected:**

- *On-device LLMs/VLMs* — 500ms–seconds per frame even quantized on phone NPUs. Dead on arrival for this budget.
- *OCR-first baseline* — considered and skipped. It's throwaway work: fails on stylized fonts, non-English cards, foils/glare. We build the PROD engine from day one.

**The pipeline (per frame):**

```
camera frame ─► crop card region ─► int8 TFLite embedding net   (~10–30ms, NPU/GPU)
             ─► cosine similarity vs flat index of ~27k cards  (<5ms, brute force)
             ─► temporal vote (k-of-n frames agree + confidence margin) ─► lock-in
```

- Embeddings trained via metric learning (ArcFace) on Scryfall art crops — auto-labeled data, heavy camera-reality augmentation (glare/foil sheen, blur, perspective warp, exposure jitter).
- Ambiguous frames fall to a *hold-steady* state rather than mis-locking.
- If eval surfaces systematic confusion pairs later, add-ons (e.g., OCR reranking) can be bolted on without rearchitecting.
- Card localization starts as fixed-crop + alignment guide; a tiny learned detector can replace it once annotated corner data exists.

## System shape

```
┌─────────────────┐      ┌──────────────────────┐      ┌─────────────────────┐
│   Deckino App   │ HTTP │    Deckino Site      │      │    Deckino Tools    │
│ Expo, Android   │◄────►│ backend + admin web  │      │ WPF (C#/.NET 10)    │
│ vision-camera → │      │                      │      │  ├ Scryfall sync    │
│ crop → embed →  │      │                      │      │  ├ Corner annotator │
│ index match →   │      │                      │      │  └ PythonRunner ────┼──► Python CLI
│ vote → card ID  │      │                      │      │                     │    (PyTorch, WSL2+ROCm)
└─────────────────┘      └──────────────────────┘      └─────────────────────┘
        ▲                                                            │
        └─────────────── artifacts (model.tflite,                    │
                          index.bin, labels.json) ───────────────────┘
```

### Deckino App

- Expo + TypeScript + expo-router, **dev-client builds** (no Expo Go — native modules require it).
- `react-native-vision-camera` frame processors (JSI, zero-copy), throttled analysis (~10fps) while preview runs full rate.
- On-device inference: `react-native-fast-tflite` (NNAPI/GPU delegate).
- `ICardRecognizer` seam behind which recognition implementations live — the scan page never knows the difference.
- Toggleable debug HUD: FPS, per-stage latency, resolution. Performance measurement is first-class from day one.

### Deckino Tools

WPF owns data + UX; Python owns math. Clean split.

- **Scryfall Sync** — bulk data (`unique-artwork`, `oracle_cards`) into SQLite; art-crop downloader with resume/politeness/integrity checks; local cache under `data/cards/{set}/{collector}.jpg`.
- **Corner Annotator** — drag 4 corner handles, save normalized quads to SQLite, export JSONL. Serves double duty: ground truth for a future detector model + calibration for warp augmentation. Keyboard-driven batch flow.
- **PythonRunner** — PowerShell spawn → venv activate → script execution, streaming stdout/stderr to a log pane, JSON-lines progress protocol, cancellation support.
- Training scripts runnable standalone AND from the UI.

### Local data

- `data/` at the repo root holds the Tools SQLite database (`deckino.db`) and the art-crop cache (`data/cards/{set}/{collector}.jpg`); gitignored, and doubles as the visible Windows↔WSL handoff point.

### Training environment

- **WSL2 + ROCm** for PyTorch on the AMD 6900XT. Fallback if needed: native Windows + torch-directml.
- Dataset lives on the WSL2 ext4 side for IO throughput; Windows↔WSL handoff via defined folder contract.
- Export chain (ONNX → `onnx2tf` → int8 TFLite with representative-dataset calibration) is CPU-only — environment-independent.
- Model candidate: MobileNetV3-Small @224px, ArcFace head, 512-d embedding (configurable down to 256).
- Eval gate before any export: top-1/top-5 on held-out simulated-camera set + confusion-pair report. Targets: ≥95% top-1 simulated, stretch 98%.
- Artifacts are small (~14MB int8 index + model) — bundle directly as app assets for PoC; OTA distribution comes later via Site.

## Guiding constraints

- Incremental delivery — every milestone leaves the system runnable.
- Nothing built that won't ship in PROD.
- Speed measured, not assumed: latency budgets tracked per stage (crop ~5ms, embed ~10–30ms, search <5ms, voting free ⇒ realistic total 60–130ms).
- Accuracy levers in order: better data/augmentation → bigger backbone → fusion tricks. Never slow paths first.

## Known risks

| Risk | Mitigation |
|---|---|
| Foil glare, dark/borderless arts | Aggressive augmentation, temporal voting, margin-based rejection |
| Version pinning pain (vision-camera/reanimated/RN new arch) | Lock known-good trio, upgrade deliberately |
| No OCR tiebreaker at launch | Hold-steady rejection state; revisit only if confusion clusters appear |
| ROCm quirks on RDNA2 | doctor script validates GPU before long jobs; DirectML fallback path documented |
| Basic lands (many artworks, same name) | Collapse printings→name in label mapping; trivially correct anyway |
