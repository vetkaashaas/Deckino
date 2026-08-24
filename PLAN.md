# Deckino — Design & Direction

Living document. It records product and architecture decisions; it is not a task tracker.

## What Deckino is

A Magic: The Gathering collection companion:

- **App** (`Deckino.App`) — Android-first Expo app for continuous camera recognition.
- **Site** (`Deckino.Site`) — future backend and management site; currently out of scope.
- **Tools** (`Deckino.Tools`) — portable WPF application for Scryfall data, CUDA training, evaluation, recognition, and result export.

The PoC result is a card name and Scryfall oracle ID. Exact printing identification and digital-only cards are out of scope.

## Success criteria

- Sub-200 ms recognition end to end on mid-range Android hardware.
- Accuracy wins ties within a 40% speed / 60% accuracy tradeoff.
- Low-confidence frames are rejected instead of flashing an incorrect result.
- Offline training produces repeatable, version-compatible artifacts before mobile integration begins.

## Recognition pipeline

```text
camera frame -> four-corner detector -> validated perspective warp
             -> recognition crop -> int8 embedding network -> cosine search
             -> temporal confidence vote -> oracle ID and card name
```

- One metric-learning class per paper-available oracle card.
- MobileNetV3-Small at 224 px, ArcFace, and a 512-dimensional embedding are the baseline.
- Camera-reality augmentation covers glare, foil sheen, blur, perspective, and exposure.
- Card localization and card identity are separate models with independent datasets, versions, thresholds, and evaluation reports.
- A lightweight int8 keypoint model detects the four ordered card corners from a low-resolution frame. The fixed guide remains a user aid and region-of-interest hint, not the source of crop geometry.
- Invalid or low-confidence quadrilaterals are rejected before embedding inference. A validated homography warps accepted corners into a canonical full-card rectangle.

## Card extraction model

### Contract and preprocessing

- Input: a downscaled camera frame or fixed-guide region of interest, initially 192 px on its longest model dimension.
- Output: normalized `top_left`, `top_right`, `bottom_right`, and `bottom_left` coordinates plus card-presence confidence.
- Corner order is part of the versioned model contract. Training, desktop testing, and Android inference must use identical orientation and normalization rules.
- Before perspective correction, Deckino validates confidence, convexity, minimum card area, corner ordering, bounds, and plausible Magic-card aspect ratio.
- Accepted corners are mapped through a homography into a consistent portrait card rectangle. Distance, rotation, and camera angle are corrected geometrically; unrecoverable blur, glare, occlusion, or insufficient resolution is rejected with user guidance.

### Dataset and annotation

- Reuse and migrate the existing four-corner dataset where its image rights, coordinate order, and label quality are known.
- Store a versioned JSONL extraction manifest containing image path, image dimensions, four normalized corners, card-presence label, source group, capture condition, and split.
- The Corner Annotator is in scope after the first extraction workflow is proven from imported data. It reviews imported labels and adds difficult real-camera examples, showing ordered corners, the resulting perspective warp, and validation failures before saving.
- Bootstrap coverage with synthetic scenes made from full-card images placed onto varied backgrounds using randomized scale, rotation, homography, shadows, exposure, blur, noise, glare, and partial out-of-frame placement.
- Full-card source images are a separate extraction asset from the existing Scryfall art-crop cache. Prefer importing the prior authorized dataset; if more coverage is required, add an explicit normal-card-image download stage with its own disk estimate and cache status rather than silently expanding the current sync.
- Real camera captures remain the final gate and include different distances, angles, tables, sleeves, lighting, foil glare, borderless cards, dark cards, clutter, negative scenes, and partially visible cards.
- Split by source capture/card scene before generating variants so near-identical frames and synthetic derivatives cannot cross between training and validation.

### Training and evaluation

- Train a small mobile-friendly keypoint network independently from the embedding model. The initial target is a 192 px MobileNetV3-Small-style regressor with eight corner values and one presence-confidence value; simplify the backbone if device measurements justify it.
- Optimize corner-coordinate error together with card-presence confidence. Camera-reality augmentation must preserve and transform the corner labels exactly.
- Report presence precision/recall, normalized corner error, percentage of all four corners within tolerance, valid-quadrilateral rate, perspective-warp error, failures by capture condition, and false positives on negative scenes.
- Evaluate the complete extraction-to-recognition pipeline on rectified real camera captures. A good recognition result from a manually corrected crop does not hide an extraction failure.
- Versioned extraction artifacts contain checkpoint, model configuration, corner ordering, input size, normalization, confidence and geometry thresholds, evaluation report, and representative failure cases.
- Export the qualified extractor to ONNX and int8 TFLite separately from the embedding network and compare desktop, ONNX, and TFLite corner outputs within a declared tolerance.

### Mobile runtime

- Keep the camera preview full-rate while analysis is throttled. Initially run extraction and recognition together on each analyzed frame for a simple measurable baseline.
- Measure resize, corner inference, validation, perspective warp, embedding inference, cosine search, and voting separately against the end-to-end latency budget.
- If needed, run extraction less frequently and track or smooth valid corners between detections. Re-run extraction when motion, geometry confidence, or recognition confidence changes materially.
- The fixed guide narrows the search region and improves user positioning but does not replace detector validation.
- Do not combine extraction and embedding networks unless measurements show a clear device benefit without reducing maintainability or accuracy.

## System shape

```text
Deckino.Tools portable ZIP (native Windows, self-contained .NET)
  |-- Scryfall sync -> data/deckino.db + data/cards/
  |-- Model Training dashboard
        |-- persistent private Python 3.12 runtime when needed
        |-- adaptive NVIDIA profile (6 GB batch 32 / 8 GB batch 64)
        |-- persistent CUDA virtual environment + weight cache
        |-- schema-v3 oracle + schema-v4 artwork manifests -> data/exports/<dataset-version>/
        |-- checkpoints/reports -> data/training/artifacts/<model-version>/
        `-- checksummed result ZIP
  `-- Corner Annotator and Card Extraction dashboard
        |-- versioned corner manifests
        |-- extraction training/evaluation
        `-- extractor checkpoints and failure reports

result ZIPs -> development machine -> ONNX/int8 TFLite export -> Deckino.App
```

### Deckino App

- Expo, TypeScript, expo-router, and native dev-client builds.
- `react-native-vision-camera` frame processors, throttled analysis, and a full-rate preview.
- Future on-device inference through `react-native-fast-tflite` and NNAPI/GPU delegates.
- `ICardRecognizer` isolates the current mock from the future corner detection, validated perspective warp, recognition crop, embedding, cosine-search, and voter pipeline.

### Deckino Tools

- Scryfall `unique_artwork` and `oracle_cards` sync into SQLite with resumable art downloads.
- A one-click, resumable Model Training workflow checks artifacts, prepares data, selects an adaptive CUDA profile, trains, compares checkpoints, evaluates, recognizes, exports, and verifies results.
- A separate Card Extraction dashboard imports or annotates four-corner data, prepares deterministic splits, trains and resumes the keypoint model, evaluates real-camera geometry, and exports versioned results.
- Sync and model operations share a coordinator and cannot mutate the workspace concurrently.
- Python processes receive argument lists, emit JSON Lines, write complete logs, and are cancelled by terminating the child process tree.
- The portable publish includes only the WPF application and allow-listed Python project sources. It excludes data, environments, caches, tests, and local artifacts.

### Local data and versions

- Datasets, manifests, training outputs, and logs live beside the extracted application under `data/`.
- The reusable Python runtime, CUDA virtual environment, downloads, and weight cache live under
  `%LOCALAPPDATA%/Deckino/training-runtime-v3/`, so replacing or deleting a portable app extraction
  does not force a package reinstall.
- Images remain in `data/cards/`; preparation validates and references them without a second copy.
- Schema-v3 oracle manifests and schema-v4 artwork manifests declare a relative image root; neither preparation flow copies the image cache.
- Dataset, checkpoint, labels, thresholds, and evaluation artifacts carry compatible versions; schema-v1/v2 artifacts are rejected.
- Extraction manifests, checkpoints, coordinate contracts, thresholds, and reports carry a shared extraction dataset/model version and fail explicitly when incompatible.
- Checkpoints contain CPU-backed tensors so saved files remain portable and backend-neutral.

## Native CUDA training target

- Windows x64 laptop with a CUDA-capable NVIDIA GPU and at least 6,000 MiB VRAM.
- Deckino enumerates every NVIDIA adapter and selects the compatible device with the most VRAM. RTX 3060 Laptop and RTX 4070 Laptop profiles are validated; other compatible devices are clearly marked unvalidated.
- The adaptive profile uses batch 32 from 6,000–7,679 MiB and batch 64 from 7,680 MiB upward. A structured smoke-test OOM retries once at the next lower batch and persists the effective setting.
- Existing NVIDIA driver only; Deckino diagnoses but never installs or replaces a GPU driver.
- Python 3.12, PyTorch 2.4.1, torchvision 0.19.1, and CUDA 11.8 wheels are pinned.
- Deckino reuses an existing x64 Python 3.12 or, after confirmation, installs signed Python 3.12.10 privately under `%LOCALAPPDATA%/Deckino/training-runtime-v3/` without PATH changes or shortcuts. A stale Deckino-owned registration from an older portable build is repaired and then removed before reinstalling; unrelated Python installations are never repaired or removed.
- No CUDA Toolkit, Visual Studio, .NET SDK, Git, containers, or Linux subsystem is required on the training laptop.
- Fixed defaults: CUDA, AMP, 20 epochs, four workers, 512-dimensional embeddings, learning rate `3e-4`, seed `20260823`, and pretrained MobileNetV3-Small. Batch size is selected from the GPU profile.
- At least 15 GiB free disk is required before installation or sync; 20 GiB is recommended.

## Evaluation and delivery gates

- Extraction must meet its corner, valid-warp, presence, and negative-scene thresholds before end-to-end mobile recognition is considered valid.
- Deterministic held-out artwork and synthetic singleton validation.
- Top-1/top-5, confusion pairs, calibrated score/margin rejection, and grouped camera evaluation.
- Artwork retrieval target: at least 99.5% raw top-1, 99.9% raw top-5, and 99.9% accepted precision at 95% coverage. Singleton-artwork, alternate-artwork, basic-land, and token groups each require at least 99% raw top-1 when present.
- Real-camera coverage is evaluated later after perspective-corrected captures exist and is not inferred from simulated artwork views.
- Result ZIP contains best/last checkpoints, labels, configuration, thresholds, evaluation, optional camera report, model-run logs, version metadata, and SHA-256 checksums.
- Artwork-retrieval result ZIPs replace the large resumable training checkpoint with a compact inference-only embedding checkpoint plus the checksummed artwork prototype vectors and labels; optimizer state and ArcFace class centres remain local.
- Dataset images, Python runtimes, package-install logs, and absolute work-laptop paths never enter result ZIPs.

## Implementation roadmap

### Phase 2B — Full identity workflow

1. Use the single **Run / resume full training** action to prepare or recover `paper-v3`, select the adaptive NVIDIA profile, pass CUDA smoke, and train through 20 epochs.
2. Persist atomic stage state so cancellation, application restarts, and GPU changes resume from validated manifests and CPU-backed checkpoints.
3. Compare `best.pt` and `last.pt`, select the stronger checkpoint deterministically, and calibrate confidence thresholds from its simulated validation results.
4. Record known-image recognition and generated non-card diagnostics, then export `identity-report.json` with the model artifacts and verify every ZIP checksum.
5. Complete with green when the 95% simulated top-1 baseline and calibration gate pass, or amber with a diagnostic export when they do not. Real-camera validation is explicitly `not_run` in this phase.

The production workflow is the Model Training surface, with fixed run details available in a compact disclosure. A completed run can create a new timestamped model version without deleting previous checkpoints, reports, logs, or ZIPs.

Phase 2B ends when the offline identity baseline is credible. Simulated validation alone is not treated as proof of real-camera performance.

### Phase 2C — Artwork-prototype retrieval and strict qualification

The first full oracle-centre run demonstrated that one visual centre per oracle card is the wrong retrieval contract: alternate printings can have unrelated artwork even though the public answer is the same `oracle_id`. Phase 2D keeps `oracle_id` as the app-facing identity while searching a prototype for every downloaded artwork internally.

1. Store Scryfall `illustration_id` on each printing. For double-faced cards, the illustration identity and downloaded art crop must come from the same card face. Use a printing-scoped fallback only when Scryfall does not provide an illustration ID, and report it.
2. Build the no-copy schema-v4 `paper-art-v4` manifest. Each uniquely identifiable artwork receives independent prototype, calibration, mild-test, medium-test, and severe-diagnostic views. Scryfall illustration IDs shared by multiple oracle cards remain indexed with every valid oracle mapping, are excluded from single-answer accuracy, and force an explicit `ambiguous_artwork` rejection. Calibration views never contribute to reported test accuracy.
3. When `mobilenetv3s-512-v3/best.pt` is available, embed every artwork with it, average a clean view with four mild deterministic views, normalize the prototype, and write a checksummed float32 index with artwork, printing, oracle, name, and category metadata. On a clean installation with no prior checkpoint, record the bootstrap decision and proceed directly to initial artwork training from pretrained MobileNetV3-Small weights.
4. Search artwork prototypes by cosine similarity, then collapse candidates to distinct oracle IDs by retaining the highest-scoring artwork for each oracle. Report both the winning artwork metadata and the public oracle result.
5. Apply the strict gate before spending time retraining: 99.5% raw top-1, 99.9% raw top-5, 99.9% accepted precision at 95% coverage, and 99% top-1 for every populated subgroup. Write bounded failure examples and severe-augmentation diagnostics.
6. If the existing model passes, skip retraining. If it fails or no prior checkpoint exists, train `mobilenetv3s-512-art-v4` with two independently augmented views per artwork, ArcFace artwork classification, and a paired supervised-contrastive loss. Use CUDA AMP for the backbone, float32 metric losses, CPU-backed resumable schema-v4 checkpoints, cosine learning-rate decay, and up to 30 epochs.
7. Rebuild and re-evaluate the index after fallback training, run a deterministic known-artwork check, record a generated non-card diagnostically, then export and reopen a schema-v4 checksummed ZIP.

Deckino.Tools presents this as a nine-stage resumable workflow. Existing oracle-centre files remain intact and are used as evidence; the artwork workflow uses a separate active pointer and never overwrites the v3 checkpoint or `paper-v3` manifest.

### Phase 3 — Card extraction workflow

After the identity workflow works end to end:

1. Implement the extraction manifest, schema validation, deterministic grouped splits, and import path for the existing authorized four-corner dataset.
2. Implement the Card Extraction CLI and WPF stages for prepare, CUDA smoke, train/resume, geometry evaluation, and result export.
3. Train the 192 px four-corner/presence baseline independently from the identity embedding model.
4. Evaluate corner accuracy, presence precision/recall, valid quadrilaterals, perspective warps, negative scenes, and grouped real-camera conditions.
5. Compare conventional art-region, full-card, and mixed identity inputs on the corrected card images and version the chosen recognition-input contract.

### Phase 4 — Corner Annotator

After the imported extraction dataset can already train and evaluate:

1. Replace the current Corner Annotator placeholder with image/folder import and label-review queues.
2. Display and edit the four ordered corners with zoom, keyboard navigation, undo, and explicit card-present/card-absent labeling.
3. Preview the perspective-corrected card and surface geometry validation errors before saving.
4. Preserve source grouping, capture condition, dimensions, coordinate order, and extraction dataset version in every label.
5. Add difficult real-camera captures and representative extraction failures without allowing related samples to cross dataset splits.

### Phase 5 — Mobile delivery

After both trained models pass their desktop and real-camera gates:

1. Export the extractor and embedding network to ONNX and int8 TFLite and verify output parity.
2. Generate `index.bin` and `labels.json`.
3. Add `react-native-fast-tflite`.
4. Replace the mock recognizer with corner detection, geometry validation, perspective warp, recognition preprocessing, embedding, cosine search, and temporal voting.
5. Measure the full Android pipeline against the sub-200 ms target.

## Known risks

| Risk | Mitigation |
|---|---|
| Work-laptop policy prohibits sustained training | Confirm employer policy before installation or training; keep the development machine as the artifact verifier |
| Insufficient free disk | Block below 15 GiB and recommend 20 GiB before sync/package installation |
| Power or thermal throttling | Train while plugged in, use the performance power profile permitted by policy, and retain resumable checkpoints |
| Corporate network blocks Scryfall, Python.org, PyPI, or PyTorch wheels | Diagnose the failed endpoint and preserve full local install logs; do not bypass corporate controls |
| Selected batch exceeds available VRAM | Retry the real-network CUDA smoke once at the next lower batch and persist the fallback |
| Corner detection increases mobile latency | Start with a 192 px int8 model, measure each stage, then reduce detection frequency and track stable corners if required |
| Incorrect corners create confident wrong crops | Validate confidence and quadrilateral geometry before warping; reject uncertain frames and report extraction failures separately |
| Synthetic extraction data does not match real scenes | Use synthetic scenes only to bootstrap and require a grouped real-camera extraction gate before mobile export |
| Fixed art-box crop fails on unusual layouts | Compare art-region, full-card, and mixed inputs on rectified captures and version the selected recognition-input contract |
| Foils, glare, dark or borderless art | Camera-reality augmentation, temporal voting, calibrated rejection, and a labeled camera gate |
| Basic lands have many artworks per name | Collapse printing metadata to oracle-card identity |
