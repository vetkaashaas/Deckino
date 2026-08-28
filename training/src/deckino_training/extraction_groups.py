"""Capture provenance and persistent, group-safe extraction splits."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image


def capture_group(sidecar: Path, image: Path, import_group: str, imports_root: Path) -> tuple[str, dict[str, Any]]:
    automatic = False
    for parent in sidecar.parents:
        if parent == imports_root.parent:
            break
        descriptor = parent / ".deckino-import.json"
        if descriptor.is_file():
            payload = json.loads(descriptor.read_text(encoding="utf-8"))
            automatic = import_group == payload.get("BatchId") or any(
                import_group == source.get("SourceGroup") for source in payload.get("Sources", [])
            )
            break
    evidence: dict[str, Any] = {"method": "explicit-group", "capture_day": None, "warning": None}
    if not automatic:
        return import_group, evidence
    dates: dict[str, str] = {}
    with Image.open(image) as source:
        exif = source.getexif()
        original = exif.get(36867)
        if original is None:
            try:
                original = exif.get_ifd(34665).get(36867)
            except (KeyError, TypeError, SyntaxError):
                pass
        if original:
            try:
                dates["exif"] = datetime.strptime(str(original).strip("\0"), "%Y:%m:%d %H:%M:%S").date().isoformat()
            except ValueError:
                evidence["warning"] = "Invalid EXIF capture date; original import group retained."
    match = re.match(r"^(\d{8}_\d{6})(?:\D|$)", image.stem)
    if match:
        try:
            dates["filename"] = datetime.strptime(match[1], "%Y%m%d_%H%M%S").date().isoformat()
        except ValueError:
            evidence["warning"] = "Invalid filename capture date; original import group retained."
    evidence["date_sources"] = dates
    if evidence["warning"] or not dates or len(set(dates.values())) > 1:
        evidence["method"] = "import-group-fallback"
        evidence["warning"] = evidence["warning"] or (
            "Conflicting capture dates; original import group retained." if len(set(dates.values())) > 1
            else "No reliable capture date; original import group retained."
        )
        return import_group, evidence
    day = dates.get("exif", dates.get("filename"))
    evidence.update(method="exif" if "exif" in dates else "filename", capture_day=day)
    # Deliberately conservative: even separate imports on the same day stay together.
    return f"capture-day:{day}", evidence


def assign_groups(groups: dict[str, dict[str, Any]], seed: int,
                  pins: dict[str, str] | None = None) -> dict[str, str]:
    """Balance globally, never splitting a group or moving an established assignment."""
    splits = ("train", "validation", "test")
    fractions = dict(zip(splits, (0.8, 0.1, 0.1)))
    result = dict(pins or {})
    vectors = {}
    for group, value in groups.items():
        requested = value.get("requested")
        if requested is not None:
            if requested not in splits or (group in result and result[group] != requested):
                raise ValueError(f"Conflicting explicit or established split for capture group {group}")
            result[group] = requested
        vectors[group] = Counter(value.get("counts") or {
            "samples": 1, "positive" if value["card_present"] else "negative": 1,
            "condition:" + str(value.get("condition") or "unlabeled"): 1,
        })
    if any(split not in splits for split in result.values()):
        raise ValueError("Invalid persisted capture split")
    totals = sum(vectors.values(), Counter())
    assigned = {split: Counter() for split in splits}
    for group, split in result.items():
        if group in vectors:
            assigned[split].update(vectors[group])
    unassigned = sorted((group for group in groups if group not in result), key=lambda group: (
        -vectors[group]["samples"], hashlib.sha256(f"{seed}:{group}".encode()).hexdigest()))
    required = splits if len(groups) >= 3 else splits[:2] if len(groups) == 2 else splits[:1]
    for index, group in enumerate(unassigned):
        empty = [split for split in required if not assigned[split]["samples"]]
        choices = empty if len(unassigned) - index <= len(empty) else list(required)
        for label in ("positive", "negative"):
            if (not assigned["train"][label] and vectors[group][label]
                    and not any(vectors[remaining][label] for remaining in unassigned[index + 1:])):
                choices = ["train"]
        def score(split: str) -> float:
            return sum(
                ((assigned[target][key] + (vectors[group][key] if target == split else 0)
                  - fractions[target] * total) / max(1, total)) ** 2
                for target in splits for key, total in totals.items()
            )
        selected = min(choices, key=lambda split: (score(split), splits.index(split)))
        result[group] = selected
        assigned[selected].update(vectors[group])
    return {group: result[group] for group in groups}


def persistent_real_splits(raw: list[dict[str, Any]], registry_path: Path, seed: int
                           ) -> tuple[dict[str, str], dict[str, Any]]:
    registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.exists() else {
        "schema_version": 2, "seed": seed, "groups": {}, "image_hashes": {},
    }
    if registry.get("schema_version") != 2 or registry.get("seed") != seed:
        raise ValueError("Capture split registry schema or seed does not match this run")
    groups: dict[str, dict[str, Any]] = {}
    pins: dict[str, str] = {}
    for record in raw:
        group = record["source_group"]
        value = groups.setdefault(group, {"counts": Counter(), "requested": None})
        value["counts"].update({"samples": 1, "positive" if record["card_present"] else "negative": 1,
                                "condition:" + str(record["capture_condition"] or "unlabeled"): 1})
        capture = record["capture_group"]
        candidates = {split for split in (
            pins.get(group), registry["groups"].get(capture),
            registry["image_hashes"].get(record["image_sha256"]), record.get("requested_split"),
        ) if split is not None}
        if len(candidates) > 1:
            raise ValueError(f"Duplicate/capture group {group} crosses established or explicit splits; correct its grouping before training")
        if candidates:
            pins[group] = candidates.pop()
    assignments = assign_groups(groups, seed, pins)
    for record in raw:
        split = assignments[record["source_group"]]
        registry["groups"][record["capture_group"]] = split
        registry["image_hashes"][record["image_sha256"]] = split
    return assignments, registry
