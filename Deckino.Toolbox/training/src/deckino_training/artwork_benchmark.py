"""Frozen real-photo benchmarks for the artwork recognizer, so every model generation is scored on the same photos.

``freeze-artwork-benchmark`` writes ``training/benchmarks/<name>.json`` once: labelled camera photos of cards whose
photos no model has trained on, with a copy of their corners and card, and each photo's SHA-256. The file is
committed and never edited; a bigger set is frozen under a new name. Training never uses photos of a benchmark card.

``benchmark-artwork`` replays the phone on every benchmark photo with a model's phone export (``recognizer.onnx``
and the app's decision, on the CPU) and writes ``artifacts/<model>/benchmarks/<name>.json``: each photo's top-5
candidates and a summary. The result is deterministic, so re-running it gives the same file.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image

from .artwork_camera_probe import CORNER_NAMES, _phone_frame, load_phone_recognizer
from .artwork_real_photos import LABEL_STATUSES, load_real_photos
from .events import emit

BENCHMARK_SCHEMA_VERSION = 1
RESULT_SCHEMA_VERSION = 1
BENCHMARK_ROOT = Path(__file__).resolve().parents[2] / "benchmarks"
DEFAULT_BENCHMARK = "artwork-real-v1"
# Each card counts about equally; a card photographed 17 times must not decide the average.
PHOTOS_PER_CARD = 5
# artwork-real-v1's cards: one in five labelled cards (by oracle id), which camera-real-v1 training held out until
# v1 was frozen. Since then training excludes only benchmark cards.
# ponytail: this selection is only valid for v1; a v2 needs freshly captured never-trained cards and a way to pick them.
HOLDOUT_BUCKETS = 5


def is_holdout(oracle_id: str) -> bool:
    return int(hashlib.sha256(oracle_id.lower().encode("utf-8")).hexdigest()[:8], 16) % HOLDOUT_BUCKETS == 0


def benchmark_path(name: str) -> Path:
    return BENCHMARK_ROOT / f"{name}.json"


def benchmark_oracles() -> set[str]:
    """Every card in any frozen benchmark: training must never see a photo of one."""
    files = sorted(BENCHMARK_ROOT.glob("artwork-*.json"))
    if not files:
        # An installed copy of the package (not the source tree or the Toolbox's bundled training/src) has no
        # benchmarks next to it; training on without them would quietly train on the benchmark cards.
        raise ValueError(f"No frozen benchmarks in {BENCHMARK_ROOT}; run the training CLI from the Toolbox, or with "
                         "PYTHONPATH set to Deckino.Toolbox/training/src")
    return {photo["oracle_id"] for path in files for photo in json.loads(path.read_text(encoding="utf-8"))["photos"]}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze_artwork_benchmark(training_root: Path, name: str = DEFAULT_BENCHMARK) -> dict[str, Any]:
    output = benchmark_path(name)
    if output.exists():
        raise ValueError(f"{output} is frozen; freeze a new benchmark under a new name instead")
    imports = training_root / "camera" / "imports"
    by_card: dict[str, list[Any]] = defaultdict(list)
    for photo in load_real_photos(training_root.parent):
        if is_holdout(photo.oracle_id):
            by_card[photo.oracle_id].append(photo)
    if not by_card:
        raise ValueError("No labelled photos of held-out cards were found; label and sync the camera dataset first")
    connection = sqlite3.connect(training_root.parent / "deckino.db")
    try:
        def card_name(oracle_id: str) -> str:
            row = connection.execute("SELECT name FROM cards WHERE lower(oracle_id) = ? LIMIT 1", (oracle_id,)).fetchone()
            return row[0] if row else oracle_id
        photos = []
        for oracle_id in sorted(by_card):
            card = sorted(by_card[oracle_id], key=lambda item: item.image_path.as_posix())
            # Spread the kept photos over the card's captures rather than taking the first few.
            count = min(PHOTOS_PER_CARD, len(card))
            name_of_card = card_name(oracle_id)
            for index in range(count):
                photo = card[index * len(card) // count]
                photos.append({"photo": photo.image_path.relative_to(imports).as_posix(),
                               "sha256": _sha256(photo.image_path), "oracle_id": oracle_id,
                               "card_name": name_of_card, "corners": [list(point) for point in photo.corners]})
    finally:
        connection.close()
    benchmark = {"benchmark_schema_version": BENCHMARK_SCHEMA_VERSION, "name": name,
                 "corner_order": list(CORNER_NAMES), "photos_per_card": PHOTOS_PER_CARD,
                 "cards": len(by_card), "photo_count": len(photos), "photos": photos}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(benchmark, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    emit("artwork_benchmark_frozen", path=str(output), cards=len(by_card), photos=len(photos))
    return benchmark


def run_artwork_benchmark(training_root: Path, model_version: str | None = None,
                          name: str = DEFAULT_BENCHMARK) -> dict[str, Any]:
    source = benchmark_path(name)
    if not source.is_file():
        raise ValueError(f"No benchmark {source}")
    benchmark = json.loads(source.read_text(encoding="utf-8"))
    phone = load_phone_recognizer(training_root, model_version)
    imports = training_root / "camera" / "imports"
    emit("artwork_benchmark_started", model_version=phone.version, benchmark=name, photos=len(benchmark["photos"]))
    rows: list[dict[str, Any]] = []
    for entry in benchmark["photos"]:
        image_path = imports / entry["photo"]
        if not image_path.is_file() or _sha256(image_path) != entry["sha256"]:
            raise ValueError(f"Benchmark photo {entry['photo']} is missing or changed; sync the camera dataset")
        with Image.open(image_path) as image:
            frame = _phone_frame(image.convert("RGB"))
        decision = phone.recognize(frame, [{"x": x, "y": y} for x, y in entry["corners"]], phone.app_thresholds)
        candidates = [{"oracle_id": item["oracle_id"], "card_name": phone.names.get(item["oracle_id"], item["oracle_id"]),
                       "score": round(item["score"], 4)} for item in decision["candidates"]]
        rank = next((index + 1 for index, item in enumerate(candidates)
                     if item["oracle_id"].lower() == entry["oracle_id"]), None)
        rows.append({"photo": entry["photo"], "oracle_id": entry["oracle_id"], "card_name": entry["card_name"],
                     "label_changed": _label_changed(image_path, entry["oracle_id"]),
                     "rank": rank, "accepted": not decision["rejected"], "rejection_reason": decision["rejection_reason"],
                     "score": round(decision["score"], 4),
                     "margin": None if decision["margin"] is None else round(decision["margin"], 4),
                     "candidates": candidates})
        if len(rows) % 25 == 0:
            emit("artwork_benchmark_progress", done=len(rows), photos=len(benchmark["photos"]))

    result = {"result_schema_version": RESULT_SCHEMA_VERSION, "benchmark": name,
              "benchmark_sha256": _sha256(source), "model_version": phone.version,
              "app_thresholds": phone.app_thresholds, "summary": summarize(rows), "photos": rows}
    output = training_root / "artifacts" / phone.version / "benchmarks" / f"{name}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    emit("artwork_benchmark_finished", model_version=phone.version, benchmark=name, output=str(output),
         **result["summary"])
    return result


def _label_changed(image_path: Path, frozen_oracle_id: str) -> bool:
    """Whether the photo's current Card Identification label names another card than the frozen one.

    The benchmark keeps scoring the frozen label (so every model is scored the same way); this only flags it,
    so a label corrected after freezing is seen and a corrected benchmark can be frozen under a new name.
    """
    identity_path = image_path.with_name(image_path.stem + "._identity.json")
    if not identity_path.is_file():
        return False
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    current = identity.get("OracleId") if identity.get("Status") in LABEL_STATUSES else None
    return current is not None and current.lower() != frozen_oracle_id


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_card: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_card[row["oracle_id"]].append(row)
    accepted = [row for row in rows if row["accepted"]]
    right = [row for row in rows if row["rank"] == 1]

    def share(count: int, total: int) -> float:
        return round(count / total, 4) if total else 0.0

    return {
        "photos": len(rows),
        "cards": len(by_card),
        "top1": share(len(right), len(rows)),
        "top5": share(sum(row["rank"] is not None for row in rows), len(rows)),
        # Every card weighs the same, however many photos it has.
        "card_top1": round(statistics.fmean(share(sum(row["rank"] == 1 for row in card), len(card))
                                            for card in by_card.values()), 4) if by_card else 0.0,
        "accepted": share(len(accepted), len(rows)),
        "accepted_correct": share(sum(row["rank"] == 1 for row in accepted), len(rows)),
        "accepted_wrong": share(sum(row["rank"] != 1 for row in accepted), len(rows)),
        "median_score_right": round(statistics.median(row["score"] for row in right), 4) if right else None,
        "median_margin_right": round(statistics.median(row["margin"] for row in right if row["margin"] is not None), 4)
        if any(row["margin"] is not None for row in right) else None,
        "labels_changed": sum(row["label_changed"] for row in rows),
    }
