# Deckino training CLI

The training pipeline runs independently from Deckino.Tools. Use the Windows
database and art cache as the source of truth, but prepare the working dataset
on WSL's ext4 filesystem before training.

```bash
cd training
python -m venv .venv
source .venv/bin/activate
pip install -e .

deckino-training doctor
deckino-training prepare \
  --data-root /mnt/d/Deckino/Code/data \
  --output-root ~/deckino-data/phase2-v1 \
  --dataset-version phase2-v1
deckino-training train \
  --manifest ~/deckino-data/phase2-v1/manifest.jsonl \
  --artifacts-root ~/deckino-artifacts \
  --model-version baseline-v1 \
  --epochs 20 --batch-size 128 --pretrained
deckino-training evaluate \
  --manifest ~/deckino-data/phase2-v1/manifest.jsonl \
  --checkpoint ~/deckino-artifacts/baseline-v1/best.pt
deckino-training recognize \
  --checkpoint ~/deckino-artifacts/baseline-v1/best.pt \
  --image /path/to/card-art.jpg
```

All command output is JSON Lines. Long-running commands emit progress events
that can later be consumed unchanged by Deckino.Tools.

`prepare` also writes a source manifest and exclusion report to
`data/exports/<dataset-version>/`. Source manifests use paths relative to the
data directory; prepared manifests use paths relative to the prepared root.

`recognize` detects portrait full-card images and extracts the conventional art
box before inference. Use `--input-kind card` or `--input-kind art` to override
that heuristic.
