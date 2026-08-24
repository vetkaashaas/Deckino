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
