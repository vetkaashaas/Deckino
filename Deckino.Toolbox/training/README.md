# Deckino training CLI

Deckino.Toolbox is the supported training entry point. It owns the local runtime,
CUDA package installation, paths, process cancellation, logs, stage ordering,
and result ZIP export. The CLI remains independently runnable for development
and CPU tests.

## Target environment

- Native Windows x64
- Python 3.12
- CUDA-capable NVIDIA GPU with at least 6,000 MiB VRAM
- Existing NVIDIA driver exposing CUDA
- PyTorch 2.4.1 and torchvision 0.19.1 from the CUDA 11.8 wheel index

Deckino does not install a GPU driver or the CUDA Toolkit. The portable Tools
application installs only a private Python runtime when required, a local
virtual environment, the packages in `requirements-cuda.txt`, and cached
MobileNetV3 weights. The managed runtime is stored in
`%LOCALAPPDATA%\Deckino\training-runtime-v3`, which survives replacement of the
portable application folder. Set `TORCH_HOME` to a controlled Deckino runtime
directory when invoking the CLI manually.

When migrating from an older portable build whose private Python folder was
deleted, Tools repairs the broken Deckino-owned Windows Installer registration,
uninstalls it, and then creates the persistent runtime. Each maintenance step
writes both a live copyable activity entry and a complete installer log under
`data\training\install-logs`.

Deckino enumerates all CUDA adapters and selects the compatible device with the
most VRAM, even when it is not CUDA device zero. RTX 3060 Laptop and RTX 4070
Laptop profiles are validated. A 6 GB device uses batch 32 and an 8 GB device
uses batch 64; other compatible GPUs are allowed but identified as unvalidated.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-cache-dir -r requirements-cuda.txt
.\.venv\Scripts\python.exe -m pip install --no-cache-dir --no-deps .
$env:TORCH_HOME = "$env:LOCALAPPDATA\Deckino\training-runtime-v3\torch-cache"
.\.venv\Scripts\deckino-training.exe cache-backbone
.\.venv\Scripts\deckino-training.exe doctor --require-cuda --minimum-vram-mb 6000
```

## Dataset preparation

Preparation validates the existing image cache and writes only metadata under
`data/exports/<dataset-version>/`. Images remain in `data/cards`; there is no
prepared image copy.

```powershell
deckino-training prepare --data-root D:\Deckino\data --dataset-version paper-v3
```

The schema-v3 `metadata.json` declares `image_root` relative to the manifest.
Rows use data-root-relative paths and are deterministically ordered. Preparation
reports paper eligibility, missing oracle IDs, incomplete downloads, missing
files, corrupt files, held-out artworks, and synthetic singleton views. Scan
progress is emitted periodically as JSON Lines.

## Artwork-prototype retrieval

The artwork-retrieval workflow keeps `oracle_id` as the public result but searches one prototype per downloaded artwork internally. Deckino.Toolbox runs these commands as one evidence-first workflow: when an existing v3 checkpoint is available it measures that checkpoint first and invokes `train-artwork` only when the index misses the strict gate. On a clean installation with no prior checkpoint, the comparison stages record a bootstrap skip and `train-artwork` creates the initial artwork model from pretrained MobileNetV3-Small weights.

```powershell
deckino-training prepare-artwork --data-root D:\Deckino\data --dataset-version paper-art-v4
deckino-training build-index --manifest D:\Deckino\data\exports\paper-art-v4\manifest.jsonl --checkpoint D:\Deckino\data\training\artifacts\mobilenetv3s-512-v3\best.pt --output-root D:\Deckino\data\training\artifacts\mobilenetv3s-512-art-v4\index --device cuda --cuda-device-index 0
deckino-training evaluate-index --manifest D:\Deckino\data\exports\paper-art-v4\manifest.jsonl --checkpoint D:\Deckino\data\training\artifacts\mobilenetv3s-512-v3\best.pt --index-root D:\Deckino\data\training\artifacts\mobilenetv3s-512-art-v4\index --output D:\Deckino\data\training\artifacts\mobilenetv3s-512-art-v4\retrieval-report.json --device cuda --cuda-device-index 0
deckino-training train-artwork --manifest D:\Deckino\data\exports\paper-art-v4\manifest.jsonl --artifacts-root D:\Deckino\data\training\artifacts --model-version mobilenetv3s-512-art-v4 --epochs 30 --batch-size 64 --workers 4 --embedding-dim 512 --learning-rate 3e-4 --seed 20260823 --pretrained --device cuda --cuda-device-index 0
deckino-training recognize-index --checkpoint D:\Deckino\data\training\artifacts\mobilenetv3s-512-v3\best.pt --index-root D:\Deckino\data\training\artifacts\mobilenetv3s-512-art-v4\index --thresholds D:\Deckino\data\training\artifacts\mobilenetv3s-512-art-v4\artwork-thresholds.json --image <art-crop.jpg> --device cuda --cuda-device-index 0
```

The schema-v4 manifest is no-copy and records Scryfall `illustration_id`, printing metadata, artwork identity, oracle identity, and independent prototype/calibration/test roles. When one illustration ID belongs to multiple oracle cards, the prototype retains every mapping and recognition rejects it as `ambiguous_artwork`; these fundamentally indistinguishable art crops are reported and excluded from single-answer accuracy. The float32 index carries a checksum and evaluation collapses the highest artwork scores to distinct oracle candidates before calculating top-1/top-5 and rejection metrics.

## CUDA smoke and training

```powershell
deckino-training accelerator-smoke `
  --manifest D:\Deckino\data\exports\paper-v3\manifest.jsonl `
  --device cuda --cuda-device-index 0 --batch-size 64 --embedding-dim 512

deckino-training train `
  --manifest D:\Deckino\data\exports\paper-v3\manifest.jsonl `
  --artifacts-root D:\Deckino\data\training\artifacts `
  --model-version mobilenetv3s-512-v3 `
  --device cuda --cuda-device-index 0 --pretrained --batch-size 64 --epochs 20 `
  --workers 4 --embedding-dim 512 --learning-rate 3e-4 --seed 20260823
```

Deckino.Toolbox normally supplies the selected device index and adaptive batch
automatically through its one-click production workflow. Resume with
`--resume <model-version>\last.pt`. Checkpoints store CPU tensors
and schema-v3 version metadata. CUDA runs use automatic mixed precision. CUDA
out-of-memory failures emit a structured recommendation to retry with batch 32.

## Card extraction

Card extraction is a standalone **320px MobileNetV3-Small geometry-aware** pipeline. It does not import
the artwork identity model or share its weights. Managed Corner Annotator
sidecars are read from `data/training/camera/imports`, full-card normal images
are cached separately under `data/training/extraction/full-cards`, and the
working manifest is written beneath `data/exports`. Each run retains its own
checksummed manifest and metadata snapshot alongside its checkpoints.

The **Include synthetic cards** checkbox is off by default. With it off, preparation
uses only managed annotated imports (positive cards and real No Card photos), skips
Scryfall discovery/downloads, and excludes all generated scenes and extraction
background assets, even if cached files exist. With it on, the existing automatic
full-card cache and synthetic scene generation are included, but synthetic examples
are capped at 20% of sampled training examples. Only real validation photos select
checkpoints; synthetic evaluation is separate. Matching unfinished
runs resume; changing the setting starts a fresh model and retains previous model
artifacts. The selection is recorded in workflow state, dataset metadata, and reports.
Older 192px, 256px spatial, recipe-4, recipe-6, recipe-7, and recipe-8 320px models remain readable for previews and
baseline comparisons, but never resume into recipe 9. The next full run starts fresh automatically.

Automatically assigned import groups are refined into capture-day groups using
EXIF DateTimeOriginal, falling back to confirmed `yyyyMMdd_HHmmss` filenames.
Custom groups are preserved; unknown/conflicting dates retain their import group
with a warning. Source sidecars are never rewritten. Exact and conservative
near-duplicates merge groups before global 75/12.5/12.5 assignment. Established
assignments never move; new capture groups fill validation/test towards 12.5% each,
so validation grows with the dataset instead of staying near 70 positives. Exact copies are
counted once; conflicting duplicate labels or established splits fail explicitly.
`data/training/extraction/capture-splits-v2.json` preserves existing assignments
as photos arrive or synthetic inclusion changes. This is an internal file, not
an additional operator step. Missing real validation/test sets remain unavailable;
training photos are never substituted for them.

The Corner Annotator's condition field is saved with the current annotation and
is also used as the default for a newly imported folder. Use a small consistent
vocabulary rather than unique prose (for example `normal`, `dark-background`,
`glare`, `low-light`, `strong-perspective`, or `handheld`). Preparation reports
real counts, independent source groups, orientation counts, and the exact
validation/test shortfalls against production-quality targets.

The backbone's strides 4/8/16/32 feed a 48-channel GroupNorm decoder. Recipe 9
predicts one generic four-peak 80×80 corner map plus four semantic corner maps,
subcell offsets, a complete-card mask, readable-orientation class, and fused
usable-card presence. The semantic maps add only a 1×1 head and do not make the
MobileNetV3 backbone heavier. The orientation head sees a pooled 2×2 spatial grid
instead of a layout-erasing global average, adding roughly 0.24M net parameters while
keeping the convolutional backbone unchanged. Local 5×5 NMS retains eight peaks from the strongest
generic or semantic response; valid four-point combinations are ranked by mean log
corner confidence plus twice polygon-to-mask IoU. Semantic corner scores provide
the primary printed `TopLeft, TopRight, BottomRight, BottomLeft` assignment, with
the global orientation class as a secondary vote. Screen-clockwise geometry is
anchored to the screen's top-left corner (`min(x+y)`), moving orientation-class
boundaries away from the common nearly upright and sideways poses. Older checkpoints
retain their original topmost-vertex decoder. Serving ambiguity covers both geometry
selection and semantic ordering. Backbone BatchNorm statistics stay
frozen, including during fine-tuning.

Recipe 9 fixes the sub-cell precision of recipe 8, whose offset head measured barely
better than predicting zero and whose peak landed in the correct cell less than half
the time, even on training photos. Each corner Gaussian is now centred on the exact
position (the nearest cell stays the single focal peak), so the heatmap itself carries
sub-cell information. The offset head gains a 3×3 depthwise refinement and is
supervised on all nine cells around each corner with targets up to ±1.5 cells, so a
peak one cell away still decodes the exact corner. `offset_range` (1.5, or 0.5 for
older checkpoints) is stored in the checkpoint and the mobile manifest.

### Full-resolution corner refiner

A 320px input places corners to roughly one 4px heatmap cell, 15-25px on an imported
2048px photo. `train-extraction-refiner` trains a second MobileNetV3-Small stage on
128px crops taken from the photograph itself. Each crop is warped into a canonical
frame: the coarse corner at the centre, the edge to the next corner pointing right and
the edge to the previous corner pointing down, so every corner looks like the top-left
corner of an upright card. A stride-2 soft-argmax gives the corner in crop pixels, and
a Laplace uncertainty head is trained on detached errors. Crops cover ±7.5% of the
card diagonal; the photo is box-reduced first so a crop pixel never spans more than
about two source pixels. Training perturbs the labels with a coarse-stage-like error
(shared similarity jitter plus per-corner noise), photometric camera augmentation,
crop-scale jitter and mirrored corners. Inference runs two passes. Each corner keeps
its coarse position when its predicted uncertainty exceeds 1.5% of the card diagonal
(provisional; tune it from `refined_corner_rate` and the refined-vs-coarse bootstrap) or
when it leaves the crop; an invalid refined quad falls back entirely. Box reduction
maps working pixel i to source pixels [i·factor, (i+1)·factor) exactly.

Classical edge-line fitting was evaluated first and rejected: on black-bordered cards
over dark surfaces, the printed frame was the strongest straight line, which made
held-out error worse (1.45% to 2.28% of the diagonal).

`evaluate-extraction --refiner` serves refined corners for calibration, test and
comparison metrics, and also records a coarse-only ablation and the baseline
extractor with the new refiner. The Toolbox runs the refiner stage between training
and evaluation and exports `refiner.pt`, `refiner-config.json` and
`refiner-history.json` in recipe 9 bundles. Suggestions, manual previews, and
`export-extraction-mobile` (`refiner.onnx` plus its crop contract) use it when present.

### Corner convention

Each corner is the intersection of the card's two straight edges (`edge-intersection-v1`),
never a point on the rounded arc, and it excludes sleeves. The Corner Annotator shows
this guidance, draws dashed extensions of every edge past its corners, and records
`CornerConvention` in each saved positive sidecar. **Snap to card edges** runs the
refiner on the annotator's own four points; Undo restores them. Preparation reports
`real_positive_corner_conventions`; labels saved earlier are `unrecorded`.

The diagnostics stage runs the read-only `audit-extraction-labels`, which ranks every
annotated positive by its disagreement with the refined corners. The report
`diagnostics/label-audit/label-audit.json` and zoomed corner previews ship in the result
ZIP: review the flagged photos in the Corner Annotator and save corrections. A
consistently positive `median_radial_offset` means labels sit inside the edge
intersection (for example on the arc).

Training uses label-preserving camera augmentation in memory, keeping 25% unchanged,
biasing transformed positives toward the four phone-camera rotations while retaining arbitrary angles, and
using reflected source texture outside the warp. Bounded exposure, white-balance,
shadow, glare, blur, motion, noise, and resolution degradation model phone-camera
variation. The objective is 2× peak-normalized generic corner focal loss +
peak-normalized semantic corner focal loss + 0.75× semantic-role CE at the four
annotated cells + 2× Smooth L1 offsets over the 3×3 cells around each corner + mask BCE + mask Dice + label-smoothed
orientation CE + class-balanced presence BCE. AdamW uses five head-only epochs at 1e-3, then
backbone 3e-5 / heads 3e-4 with cosine decay, AMP, at least 32 updates/epoch,
and at most 150 epochs. Early stopping has patience 30 after epoch 40.

Real training samples target 75% positive / 25% negative; positive sampling mixes
natural-photo, capture-group-balanced, and readable-orientation-balanced draws.
Orientation-balanced draws also balance capture groups within an orientation so
video-frame bursts do not dominate a rare rotation. Enabled synthetic data remains
capped at 20%. An EMA copy begins after backbone unfreezing; raw and EMA
weights are evaluated each epoch and only the stronger candidate is exported.
There is no separate precision-finishing stage.

The preparation report includes real positive orientation counts per split and
real capture-condition counts. Treat large class gaps or an all-`unlabeled`
condition report as dataset-quality warnings before starting a long run.

Checkpoint selection uses `calibrated-robust-geometry-v6`: require 90% presence recall
and zero accepted validation negatives when both classes exist, then rank the
continuous `robust_geometry_error` (the mean over positives of each photo's worst-corner
error, capped at 10% of the diagonal; invalid geometry scores the cap), then
correct-warp coverage, all-four accuracy, orientation, p95, and mean error. With about
70 validation positives, pass/fail coverage moved in 1.4% steps on single photos; the
continuous score ranks by actual accuracy instead.
Orientation accuracy is measured from the final decoded semantic corner sequence by
the best cyclic match to the annotation, rather than comparing two independently
anchored intermediate orientation classes.
Serving calibration happens only after selection and jointly chooses presence and
ambiguity-margin thresholds. Fewer than 200 validation negatives remains provisional.
The inspected test set is a development regression benchmark; it cannot support a
fresh blind qualification claim. Preview testing and Corner Annotator suggestions
automatically use the newest valid `extractor-run-<timestamp>` directory under
`data/training/artifacts`. The timestamp is read from the directory name; no preview
pointer file is required. Incomplete or inconsistent artifact directories are skipped.

Baseline discovery follows the preserved run chain, then searches completed
extraction artifacts if that chain is missing. The current candidate, identity
artifacts and disposable learning checks are excluded. Both checkpoints are
calibrated independently on exactly the same current real validation photos;
`baseline-comparison.json` records hashes, sample membership, both metric sets,
and explicit unavailability reasons. A paired image-level bootstrap (2,000 resamples)
reports each geometry delta with a 95% interval and flags significant improvements or
regressions, both for the served (refined) corners and for the coarse extractor alone. Unknown/overlapping baseline training
membership prevents an unbiased improvement claim. That report is required in
new-selection ZIPs; previously completed evaluations are not silently rerun.

Manual previews and up to 20 validation/test gallery samples get four-corner
`*-heatmaps.png` and `*-heatmaps.json` diagnostics. Cyan marks the serving output,
yellow the strongest heatmap cell, red the annotation when available. Relative
heat intensity, normalized entropy and the strongest competing peak outside four
cells are inspection aids, not calibrated confidence. These diagnostics never
change decoding, semantic corner order, acceptance or annotations. Legacy 192px
models explicitly report that heatmaps are unavailable. Files are included in
the existing checksummed diagnostics export; no new buttons are needed.

Regression tests were added but local tests/builds/training are intentionally not
run on the AMD machine. Validate the workflow and compare real validation results
on the NVIDIA machine before claiming any accuracy improvement.

Validation overlays include numbered predicted/annotated corners and boundary
review hints; failure reasons distinguish confidence, geometry, corner and warp
errors. Prior supplied test failures were inspected during recipe design: results
are locked regression checks, not a claim of fresh blind qualification. Baseline
comparisons disclose training overlap and only claim improvement for higher
validation correct-warp coverage without worse mean/p95 error or negative acceptance.

AMP gradient overflows skip the optimizer update and retry the same batch at a
reduced loss scale, up to 16 retries. Logs show each retry and affected parameters;
only successful updates count toward training/learning-check progress. Loss scale
and retry totals are checkpointed. Persistent overflow, non-finite forward loss,
or non-finite gradients without AMP still stop the run. This recovery fix is
retained in recipe 8, including recovery from a learning check interrupted before
its first update. Older recipes remain preview-only compatible.

Inspect any foreign four-corner collection before writing an adapter; unknown
coordinate units, order, EXIF handling, negative labels, grouping, and rights
are never guessed.

```powershell
deckino-training inspect-extraction-dataset `
  --input-root D:\owned-corner-dataset `
  --output D:\owned-corner-dataset\format-report.json

deckino-training prepare-extraction `
  --data-root D:\Deckino\Code\data --dataset-version corners-v1 `
  --seed 20260824

deckino-training extraction-smoke `
  --manifest D:\Deckino\Code\data\exports\corners-v1\manifest.jsonl `
  --device cuda --cuda-device-index 0 --batch-size 32 --steps 2

deckino-training train-extraction `
  --manifest D:\Deckino\Code\data\exports\corners-v1\manifest.jsonl `
  --artifacts-root D:\Deckino\Code\data\training\artifacts `
  --model-version extractor-mnv3-geometry-320-recipe8 --device cuda --cuda-device-index 0 `
  --pretrained --batch-size 32 --epochs 150 --workers 4 `
  --learning-rate 3e-4 --seed 20260824 --patience 30
```

CLI preparation also defaults to annotated imports only. Add `--include-synthetic`
to opt in; `--synthetic-per-card 4 --max-full-cards 5000` then controls generation.
Those numeric limits alone no longer enable synthetic data. Use a fresh dataset
version when changing inputs through the CLI; the WPF button handles this automatically.

The Card Extraction page is the supported one-button operator experience. Before
full training, its **real-photo learning check** selects up to 16 positive and eight
negative training photos and attempts to fit them without augmentation in at most
1,000 updates. It requires mean corner error ≤1.5%, ≥95% all-four accuracy within
4%, and ≥95% presence precision/recall when both classes exist. Missing classes
are reported. Inference and reloaded predictions must match. A failure stops the
full run and writes loss diagnostics/overlays; its disposable checkpoint never
initializes production training. The CLI equivalent is `extraction-learning-check`
with the same manifest/artifacts/model/device/batch/workers/seed arguments (use a
separate model version ending in `-learning`).

The full action resumes compatible `last.pt`, calibrates on real validation,
evaluates locked real test groups once for the checkpoint, and exports
`deckino-extraction-results-*.zip` plus a compact cross-PC handoff ZIP. It optionally compares the previous model on
the same validation photos and reports known/unknown previous training overlap.
Development targets are mean ≤3%, p95 ≤8%, ≥80% all-four accuracy and ≥90% correct
warp coverage; original strict production gates and real-camera coverage minimums
remain unchanged. Missing held-outs/classes/conditions cannot qualify, but do not
prevent previews or export. Schema-v2 exports include grouping evidence, split
assignments, dataset metadata/manifest, learning-check report, training history,
selection evidence, thresholds, failure previews and verified SHA-256 checksums.
Source photographs and absolute machine paths are excluded. ONNX, TFLite,
mobile wiring, and automatic label acceptance are deliberately outside this pipeline.

## Copy a model to another PC

Train on the NVIDIA machine. Build and run the Expo app on any other Windows PC.
Do not copy the whole `data/` tree; copy one compact ZIP.

On the training PC, after a completed extraction run (or from an existing
`extractor-run-*` folder), click **Pack for other PCs** on the Card Extraction
page (headless: `--pack-extraction-handoff [model-version]`).

That writes `data/training/handoff/deckino-extraction-handoff-latest.zip` (and a
versioned copy next to it). Copy that one file to the build PC.

On the build PC, click **Import bundle** on the Card Extraction page and pick
the ZIP (headless: `--import-extraction <zip>`).

Import unpacks into `data/training/artifacts/<model-version>/` and writes
`data/training/current-extraction.json` with the architecture, input size, and
paths to `extractor.pt`, `preprocessing.json`, and `thresholds.json`. No GPU is
required. The Card Extraction page also has **Pack for other PCs**, **Import
bundle**, and **Open handoff folder**. Toolbox headless flags:
`--pack-extraction-handoff [model-version]` and `--import-extraction <zip>`.

The full `deckino-extraction-results-*.zip` still imports if you already copied
one; the handoff ZIP is the file meant for USB / network copy.

### Artwork identity model

The artwork workflow on the NVIDIA PC ends by writing
`data/training/results/deckino-results-<model-version>-<timestamp>.zip`
(**Open results folder** on the Model Training page). Copy that ZIP to the other PC
and click **Import artwork bundle** there (headless: `--import-artwork <zip>`). No
GPU is needed.

Import verifies every ZIP checksum, requires `embedding.pt`, the prototype index,
`artwork-thresholds.json` and both reports, and unpacks into a staging folder first.
The index size and vector SHA-256 must match `index-metadata.json`, and the
thresholds must belong to the same checkpoint and dataset as the index. Only then
does it replace `data/training/artifacts/<model-version>/`; an existing folder of
that name is kept as `<model-version>.replaced-<timestamp>`. It writes
`data/training/current-artwork.json` with the prototype count, dataset and
qualification state.

## Export for the Android app

Automatic: `scripts/start-deckino-android.ps1` calls
`scripts/ensure-extraction-mobile.ps1` before Metro starts. When
`data/training/current-extraction.json` points at a newer model than the App
assets, it runs `export-extraction-mobile` on CPU into
`data/training/mobile/extractor/<model-version>/` and copies the result into
`Deckino.App/assets/models/extractor/`. Later starts are a no-op; pass
`-Force` to `ensure-extraction-mobile.ps1` to re-run the export and copy.

This writes ONNX with ImageNet normalize inside the graph and checks PyTorch vs
ONNX corner parity. TFLite is produced when `onnx2tf` is installed, but current
converters collapse the 80×80 heatmap heads, so the App loads `extractor.onnx`
through ONNX Runtime. Rebuild the Android dev client after copying the model.

The Corner Annotator has an optional **Suggest corners with current model** helper.
It is off by default and starts a persistent CPU worker only while enabled. The
worker loads the newest completed extraction artifact once, proposes four ordered
corners for each newly opened unannotated photo, and never writes images, diagnostics,
or sidecars. Geometrically valid guesses are shown even when production confidence
or ambiguity thresholds would reject them, with an explicit warning. The operator
must review or adjust the points and click **Save & next** before they become training
labels. Manual input cancels pending results, suggested points are one undoable edit,
and stale replies cannot be applied to a later photo.

### Artwork model for the app

**Export for app** on the Model Training page (or
`deckino-training export-artwork-mobile --artifacts-root data/training/artifacts`)
packs the imported artwork model on CPU into
`data/training/mobile/artwork/<model-version>/`:

- `embedding.onnx`: input `image` [1, 3, 224, 224] RGB in [0, 1] with ImageNet
  normalization inside the graph; output `embedding`, L2-normalized. The export
  fails if ONNX Runtime differs from PyTorch by more than 1e-4.
- `index.float16.bin` (default; `--index-dtype int8` adds `index.scales.f32`,
  `float32` keeps full precision): row-major, little-endian prototype vectors. The
  export fails unless the packed index keeps at least 99.9% top-1 agreement with the
  float32 index on 2,000 near-duplicate queries.
- `labels.json`: an oracle table (id, name) plus one entry per prototype (artwork,
  printing, oracle indices, ambiguous flag).
- `mobile-manifest.json`: the query preprocessing (the extraction
  `recognition_crop_v1` region of the 315x440 rectified card, stretched to 224x224),
  the decision rule and calibrated thresholds, file checksums and parity results.
- `fixture.json` + `fixture-inputs.f32`: two reference inputs with their expected
  embeddings and decisions, plus index-row queries covering oracle collapse and
  ambiguous-artwork rejection. The app's implementation must reproduce them.

The decision matches `recognize-index`: score every prototype by dot product, keep
the best score per oracle, reject an ambiguous artwork (one illustration shared by
several cards), and require both the score and top-2 margin thresholds.

## Camera evaluation and recognition

Each labeled camera-card folder is named with an oracle ID and contains
`capture.json` plus `normal`, `glare`, `low_light`, `perspective`, and
`alternate` images. The complete set must include foil, borderless, and unusual
layout traits.

```powershell
deckino-training prepare-camera `
  --input-root D:\captures `
  --output-root D:\Deckino\data\training\camera\camera-v1 `
  --dataset-manifest D:\Deckino\data\exports\paper-v3\manifest.jsonl `
  --camera-version camera-v1

deckino-training evaluate `
  --manifest D:\Deckino\data\exports\paper-v3\manifest.jsonl `
  --checkpoint D:\Deckino\data\training\artifacts\mobilenetv3s-512-v3\best.pt `
  --camera-manifest D:\Deckino\data\training\camera\camera-v1\camera-manifest.jsonl `
  --device cuda --batch-size 64 --workers 4

deckino-training recognize `
  --checkpoint D:\Deckino\data\training\artifacts\mobilenetv3s-512-v3\best.pt `
  --image D:\captures\test-card.jpg --device cuda
```

Production evaluation compares `best.pt` and `last.pt`, chooses the stronger
checkpoint (ties prefer `best.pt`), and writes version-checked evaluation and
threshold artifacts. Camera evaluation is intentionally not run in the offline identity phase.
Recognition loads calibrated thresholds and emits either an oracle ID/card name
or a low-confidence rejection. Every CLI command writes structured JSON Lines
to stdout.
