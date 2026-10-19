"""The frozen real-photo benchmark's cards, held out of artwork training.

``benchmarks/artwork-real-v1.json`` (committed, never edited) lists labelled camera photos of cards no model has
trained on. Its scoring and the Toolbox's Model Benchmarks page were removed for now; the file and this hold-out stay
so a rebuilt benchmark can still measure recognition of never-trained cards. Training a photo of one of its cards
would spoil it for good.
"""
from __future__ import annotations

import json
from pathlib import Path

BENCHMARK_ROOT = Path(__file__).resolve().parents[2] / "benchmarks"


def benchmark_oracles() -> set[str]:
    """Every card in any frozen benchmark: training must never see a photo of one."""
    files = sorted(BENCHMARK_ROOT.glob("artwork-*.json"))
    if not files:
        # An installed copy of the package (not the source tree or the Toolbox's bundled training/src) has no
        # benchmarks next to it; training on without them would quietly train on the benchmark cards.
        raise ValueError(f"No frozen benchmarks in {BENCHMARK_ROOT}; run the training CLI from the Toolbox, or with "
                         "PYTHONPATH set to Deckino.Toolbox/training/src")
    return {photo["oracle_id"] for path in files for photo in json.loads(path.read_text(encoding="utf-8"))["photos"]}
