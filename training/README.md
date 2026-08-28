# Deckino training CLI

Deckino.Tools is the supported training entry point. It owns the local runtime,
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

The artwork-retrieval workflow keeps `oracle_id` as the public result but searches one prototype per downloaded artwork internally. Deckino.Tools runs these commands as one evidence-first workflow: when an existing v3 checkpoint is available it measures that checkpoint first and invokes `train-artwork` only when the index misses the strict gate. On a clean installation with no prior checkpoint, the comparison stages record a bootstrap skip and `train-artwork` creates the initial artwork model from pretrained MobileNetV3-Small weights.

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

Deckino.Tools normally supplies the selected device index and adaptive batch
automatically through its one-click production workflow. Resume with
`--resume <model-version>\last.pt`. Checkpoints store CPU tensors
and schema-v3 version metadata. CUDA runs use automatic mixed precision. CUDA
out-of-memory failures emit a structured recommendation to retry with batch 32.

## Card extraction

Card extraction is a standalone **256px MobileNetV3-Small spatial** pipeline. It does not import
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
Older 192px models remain readable for previews, but never resume into the spatial
architecture. The next full run starts fresh automatically.

Automatically assigned import groups are refined into capture-day groups using
EXIF DateTimeOriginal, falling back to confirmed `yyyyMMdd_HHmmss` filenames.
Custom groups are preserved; unknown/conflicting dates retain their import group
with a warning. Source sidecars are never rewritten. Exact and conservative
near-duplicates merge groups before global 80/10/10 assignment. Exact copies are
counted once; conflicting duplicate labels or established splits fail explicitly.
`data/training/extraction/capture-splits-v2.json` preserves existing assignments
as photos arrive or synthetic inclusion changes. This is an internal file, not
an additional operator step. Missing real validation/test sets remain unavailable;
training photos are never substituted for them.

The backbone's strides 4/8/16/32 feed a lightweight 32-channel decoder with
GroupNorm and four 64×64 heatmaps. Spatial softmax expectations produce the same
eight ordered coordinates. The separate pooled branch predicts usable-card
presence. Backbone BatchNorm statistics stay frozen, including during fine-tuning.
This uses the spatial-to-coordinate approach described in
[Numerical Coordinate Regression with Convolutional Neural Networks](https://arxiv.org/abs/1801.07372).

Training uses label-preserving camera augmentation in memory, keeping 20% unchanged
and never augmenting held-out photos. Localization is positive-only Gaussian KL
(sigma 1.5 cells) plus 10× diagonal-normalized Smooth L1 (beta 0.02), with
class-balanced presence BCE. AdamW uses weight decay 1e-4, five head-only epochs
at 1e-3, then backbone 3e-5 / heads 3e-4 with cosine decay, AMP, at least 32
updates/epoch, and at most 150 epochs. Early stopping has patience 20 after epoch
30. Checkpoints rank by the 95% precision/recall floor at threshold 0.5, correct-warp
coverage, then corner error—not combined loss. Without real positive validation, best.pt
is the last checkpoint, early stopping is disabled, and the run is development-only.

AMP gradient overflows skip the optimizer update and retry the same batch at a
reduced loss scale, up to 16 retries. Logs show each retry and affected parameters;
only successful updates count toward training/learning-check progress. Loss scale
and retry totals are checkpointed. Persistent overflow, non-finite forward loss,
or non-finite gradients without AMP still stop the run. This recovery fix is
compatible with existing spatial-v2 checkpoints, including a learning check
interrupted before its first update.

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
  --device cuda --cuda-device-index 0 --batch-size 64 --steps 2

deckino-training train-extraction `
  --manifest D:\Deckino\Code\data\exports\corners-v1\manifest.jsonl `
  --artifacts-root D:\Deckino\Code\data\training\artifacts `
  --model-version extractor-mnv3-spatial-256-v2 --device cuda --cuda-device-index 0 `
  --pretrained --batch-size 64 --epochs 150 --workers 4 `
  --learning-rate 3e-4 --seed 20260824 --patience 20
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
`deckino-extraction-results-*.zip`. It optionally compares the previous model on
the same validation photos and reports known/unknown previous training overlap.
Development targets are mean ≤3%, p95 ≤8%, ≥80% all-four accuracy and ≥90% correct
warp coverage; original strict production gates and real-camera coverage minimums
remain unchanged. Missing held-outs/classes/conditions cannot qualify, but do not
prevent previews or export. Schema-v2 exports include grouping evidence, split
assignments, dataset metadata/manifest, learning-check report, training history,
selection evidence, thresholds, failure previews and verified SHA-256 checksums.
Source photographs and absolute machine paths are excluded. ONNX, TFLite,
mobile wiring, and Corner Annotator implementation are deliberately outside this
pipeline.

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
