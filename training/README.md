# Deckino training CLI

Deckino.Tools is the supported training entry point. It owns the local runtime,
CUDA package installation, paths, process cancellation, logs, stage ordering,
and result ZIP export. The CLI remains independently runnable for development
and CPU tests.

## Target environment

- Native Windows x64
- Python 3.12
- NVIDIA GeForce RTX 4070 Laptop GPU (approximately 8 GiB VRAM)
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

Deckino enumerates CUDA adapters by name and selects the required 4070 even when
it is not CUDA device zero. The current Tools hardware profile remains fixed to
that GPU; additional NVIDIA profiles can be added later without changing the
training artifact format.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-cache-dir -r requirements-cuda.txt
.\.venv\Scripts\python.exe -m pip install --no-cache-dir --no-deps .
$env:TORCH_HOME = "$env:LOCALAPPDATA\Deckino\training-runtime-v3\torch-cache"
.\.venv\Scripts\deckino-training.exe cache-backbone
.\.venv\Scripts\deckino-training.exe doctor --require-cuda --expected-device "RTX 4070 Laptop GPU"
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

## CUDA smoke and training

```powershell
deckino-training accelerator-smoke `
  --manifest D:\Deckino\data\exports\paper-v3\manifest.jsonl `
  --device cuda --batch-size 64 --embedding-dim 512

deckino-training train `
  --manifest D:\Deckino\data\exports\paper-v3\manifest.jsonl `
  --artifacts-root D:\Deckino\data\training\artifacts `
  --model-version mobilenetv3s-512-v3 `
  --device cuda --pretrained --batch-size 64 --epochs 20 `
  --workers 4 --embedding-dim 512 --learning-rate 3e-4
```

Resume with `--resume <model-version>\last.pt`. Checkpoints store CPU tensors
and schema-v3 version metadata. CUDA runs use automatic mixed precision. CUDA
out-of-memory failures emit a structured recommendation to retry with batch 32.

For the isolated quick workflow, derive a manifest-only subset and use a fixed
seed. This reads manifest metadata and checks only selected image references; it
does not reopen or copy the production cache.

```powershell
deckino-training subset `
  --source-manifest D:\Deckino\data\exports\paper-v3\manifest.jsonl `
  --dataset-version paper-smoke20-v3 --max-classes 20 --min-images-per-class 3

deckino-training train `
  --manifest D:\Deckino\data\exports\paper-smoke20-v3\manifest.jsonl `
  --artifacts-root D:\Deckino\data\training\artifacts `
  --model-version mobilenetv3s-512-smoke20-v3 --device cuda --pretrained `
  --batch-size 16 --epochs 1 --workers 4 --embedding-dim 512 `
  --learning-rate 3e-4 --seed 20260823

deckino-training checkpoint-info `
  --checkpoint D:\Deckino\data\training\artifacts\mobilenetv3s-512-smoke20-v3\last.pt
```

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

Evaluation writes version-checked evaluation, thresholds, and camera reports.
Recognition loads calibrated thresholds and emits either an oracle ID/card name
or a low-confidence rejection. Every CLI command writes structured JSON Lines
to stdout.
