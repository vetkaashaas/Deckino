"""Persistent, group-safe extraction splits."""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any


def assign_groups(groups: dict[str, dict[str, Any]], seed: int,
                  pins: dict[str, str] | None = None) -> dict[str, str]:
    """Balance globally, never splitting a group or moving an established assignment."""
    splits = ("train", "validation", "test")
    # Validation drives checkpoint selection and calibration; at 10% it held only
    # ~70 positives, so one photo moved coverage metrics by 1.4%. New groups now
    # fill validation/test towards 12.5% each; established assignments never move.
    fractions = dict(zip(splits, (0.75, 0.125, 0.125)))
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
        # Sample-heavy video captures should not crowd independent sessions out
        # of validation/test. Balance group count as well as photos/classes.
        vectors[group]["groups"] = 1
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
        value["counts"].update({"samples": 1, "positive" if record["card_present"] else "negative": 1})
        # Balance each tag across splits, not each combination of tags.
        value["counts"].update("condition:" + tag for tag in record.get("condition_tags") or ["unlabeled"])
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
