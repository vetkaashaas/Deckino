"""Score one extractor and one artwork model on the held-out benchmark photos, as the phone app would.

Each labelled photo is one camera frame, run through the app's still-photo path (Deckino.App
``src/scan/scan-still.ts``): shrunk to the phone's 480 px frame, letterboxed (nearest neighbour,
``cpu-letterbox.ts``) for extractor.onnx, decoded and accepted as ``decode-geometry.ts`` does, refined with
refiner.onnx, then ``identify.ts``: recognizer.onnx and its top-K decision, and when that rejects, the title
read matched against the top 5, then all the artwork model's cards. The artwork model is also scored on
the drawn corners alone, to tell its misses from the extractor's.
"""
from __future__ import annotations

import itertools
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .artwork_benchmark import LABEL_STATUSES
from .artwork_camera_probe import CORNER_NAMES, _phone_frame, load_phone_recognizer
from .events import emit
from .extraction import LEGACY_COORDINATE_TRANSFORM, _letterbox_geometry, unletterbox
from .extraction_mobile import refine_on_frame
from .extraction_network import _portrait_orientation, _screen_clockwise_indices
from .extraction_refiner import _diagonal, _pixels
from .title_ocr import CardNames, TitleMatcher, TitleReader, _write_json, ensure_model

PHOTO_SUFFIXES = (".jpg", ".jpeg", ".png")

# decode-geometry.ts
TOP_K = 8
MINIMUM_CORNER_LOGIT = math.log(.05 / .95)
MAXIMUM_PEAK_CANDIDATES = TOP_K * 4
MINIMUM_QUAD_AREA = .0025
MINIMUM_MASK_IOU = .75
NMS_RADIUS = 2
LEGACY_OFFSET_RANGE = .5
POINT_IN_QUAD_EPSILON = 1e-6
# A corner error past a tenth of the card's diagonal is a crop nothing can read: no worse than missing the card,
# which counts as that much too. Capped, the mean tracks the extractor's real precision and its misses together.
CORNER_ERROR_CAP = .1


def _sigmoid(value: float) -> float:
    return 1 / (1 + math.exp(-value)) if value >= 0 else math.exp(value) / (1 + math.exp(value))


def _log_softmax(values: np.ndarray) -> np.ndarray:
    exps = np.exp(values - values.max())
    return np.log(exps / exps.sum())


def _letterbox(frame: np.ndarray, size: int) -> np.ndarray:
    """letterboxPackedRgbToPlanarRgb: nearest neighbour into a black square, planar [0, 1] RGB."""
    height, width = frame.shape[:2]
    resized_width, resized_height, left, top, _, _ = _letterbox_geometry(width, height, size,
                                                                         LEGACY_COORDINATE_TRANSFORM)
    xs = np.minimum(width - 1, ((np.arange(resized_width) + .5) / resized_width * width).astype(np.int64))
    ys = np.minimum(height - 1, ((np.arange(resized_height) + .5) / resized_height * height).astype(np.int64))
    pixels = np.zeros((3, size, size), dtype=np.float32)
    pixels[:, top:top + resized_height, left:left + resized_width] = \
        frame[ys[:, None], xs[None, :]].transpose(2, 0, 1) / 255
    return pixels


def _peaks(logits: np.ndarray, offsets: np.ndarray, offset_range: float) -> list[tuple[float, float, float, int, int]]:
    """collectPeaks: 5x5 local maxima above the corner floor, best 32, then 8 at least NMS_RADIUS cells apart."""
    size = logits.shape[0]
    windows = np.lib.stride_tricks.sliding_window_view(np.pad(logits, 2, constant_values=-np.inf), (5, 5))
    flat = np.flatnonzero((logits > MINIMUM_CORNER_LOGIT) & (logits >= windows.max(axis=(2, 3))))
    ranked = flat[np.lexsort((flat, -logits.ravel()[flat]))][:MAXIMUM_PEAK_CANDIDATES]
    peaks: list[tuple[float, float, float, int, int]] = []
    for index in ranked.tolist():
        if len(peaks) == TOP_K:
            break
        y, x = divmod(index, size)
        if any(max(abs(x - peak[3]), abs(y - peak[4])) <= NMS_RADIUS for peak in peaks):
            continue
        offset_x, offset_y = np.clip(offsets[:, y, x], -offset_range, offset_range).tolist()
        # The app keeps peak probabilities in float32 (Math.fround).
        peaks.append((min(1., max(0., (x + offset_x) / (size - 1))), min(1., max(0., (y + offset_y) / (size - 1))),
                      float(np.float32(_sigmoid(logits[y, x]))), x, y))
    return peaks


def _valid_ordered_quad(points: np.ndarray) -> bool:
    if not (np.isfinite(points).all() and (points >= 0).all() and (points <= 1).all()):
        return False
    edges = np.roll(points, -1, axis=0) - points
    following = np.roll(edges, -1, axis=0)
    crosses = edges[:, 0] * following[:, 1] - edges[:, 1] * following[:, 0]
    area = abs(float(np.sum(points[:, 0] * np.roll(points[:, 1], -1) - points[:, 1] * np.roll(points[:, 0], -1)))) / 2
    return area >= MINIMUM_QUAD_AREA and bool((crosses > 1e-8).all() or (crosses < -1e-8).all())


def _mask_iou(points: np.ndarray, mask: np.ndarray, grid_x: np.ndarray, grid_y: np.ndarray) -> float:
    """maskIou: heatmap cells (cell / (size - 1)) inside the quad, epsilon-inclusive, against the mask."""
    positive = np.ones_like(mask)
    negative = np.ones_like(mask)
    for index in range(4):
        (ax, ay), (bx, by) = points[index], points[(index + 1) % 4]
        cross = (bx - ax) * (grid_y - ay) - (by - ay) * (grid_x - ax)
        positive &= cross >= -POINT_IN_QUAD_EPSILON
        negative &= cross <= POINT_IN_QUAD_EPSILON
    polygon = positive | negative
    intersection = int((polygon & mask).sum())
    union = int(mask.sum()) + int(polygon.sum()) - intersection
    return intersection / union if union else 0.


def _decode(outputs: dict[str, np.ndarray], manifest: dict[str, Any],
            thresholds: dict[str, Any]) -> tuple[list[float] | None, str | None]:
    """decodeGeometry + acceptExtraction: (letterboxed corners or None, rejection reason or None)."""
    size = manifest["heatmap_size"]
    corner_logits = outputs["corner_logits"].reshape(size, size)
    semantic = outputs.get("semantic_corner_logits")
    semantic = None if semantic is None else semantic.reshape(4, size, size)
    if _sigmoid(float(outputs["presence_logits"].ravel()[0])) < thresholds["presence_threshold"]:
        return None, "presence_below_threshold"
    peaks = _peaks(corner_logits if semantic is None else np.maximum(corner_logits, semantic.max(axis=0)),
                   outputs["offsets"].reshape(2, size, size), manifest.get("offset_range") or LEGACY_OFFSET_RANGE)
    mask = outputs["mask_logits"].reshape(size, size) >= 0
    grid_x, grid_y = np.meshgrid(np.arange(size) / max(1, size - 1), np.arange(size) / max(1, size - 1))
    best: tuple[float, np.ndarray, list[tuple[int, int]]] | None = None
    second, count = -math.inf, 0
    for group in itertools.combinations(peaks, 4):
        unordered = np.array([peak[:2] for peak in group], dtype=np.float64)
        order = _screen_clockwise_indices(unordered, manifest["corner_anchor_policy"]).tolist()
        points = unordered[order]
        if not _valid_ordered_quad(points):
            continue
        iou = _mask_iou(points, mask, grid_x, grid_y)
        if iou < MINIMUM_MASK_IOU:
            continue
        score = sum(math.log(max(group[index][2], 1e-8)) for index in order) / 4 + 2 * iou
        count += 1
        if best is None or score > best[0]:
            if best is not None:
                second = best[0]
            best = (score, points, [(group[index][3], group[index][4]) for index in order])
        elif score > second:
            second = score
    if best is None:
        return None, "invalid_quadrilateral"
    score, points, cells = best
    orientation_logits = outputs["orientation_logits"].ravel()
    orientation = int(np.argmax(orientation_logits))
    semantic_margin = 1e9
    if semantic is not None:
        orientation_scores = _log_softmax(orientation_logits)
        roles = [_log_softmax(semantic[:, y, x]) for x, y in cells]
        scores = [sum(roles[index][(index - role) % 4] for index in range(4)) / 4 + .5 * orientation_scores[role]
                  for role in range(4)]
        orientation = int(np.argmax(scores))
        ranked = sorted(scores, reverse=True)
        semantic_margin = float(ranked[0] - ranked[1])
    orientation = _portrait_orientation(points.tolist(), orientation)
    corners = np.roll(points, -orientation, axis=0).ravel().tolist()
    margin = min(score - second if count > 1 else 1e9, semantic_margin)
    return corners, "ambiguous_card_geometry" if margin < thresholds["ambiguity_margin_threshold"] else None


def _read_sidecar(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except PermissionError as error:
        # Locked for a moment (a save or a sync): scoring without it would cache a score short of a photo.
        raise ValueError(f"{path} is in use; score again in a moment") from error
    except (OSError, ValueError):
        # Half-written, not JSON or not UTF-8: unlabelled, and the Toolbox's fingerprint check catches a rewrite.
        return None
    return value if isinstance(value, dict) else None


def _annotation_valid(annotation: dict[str, Any]) -> bool:
    """CameraAnnotationStore::is_valid; a malformed sidecar (a null size, a corner without X) is invalid too."""
    try:
        return _annotation_fields_valid(annotation)
    except (KeyError, TypeError):
        return False


def _annotation_fields_valid(annotation: dict[str, Any]) -> bool:
    if annotation.get("ImageWidth", 0) <= 0 or annotation.get("ImageHeight", 0) <= 0 \
            or not str(annotation.get("ImageFile") or "").strip():
        return False
    points = [annotation.get(name) for name in CORNER_NAMES]
    if not annotation.get("CardPresent", True):
        return all(point is None for point in points)
    return all(point is not None and 0 <= point["X"] <= 1 and 0 <= point["Y"] <= 1 for point in points)


def _drawn_area(annotation: dict[str, Any]) -> float:
    """The drawn quad's area as a fraction of the photo (shoelace)."""
    points = [(annotation[name]["X"], annotation[name]["Y"]) for name in CORNER_NAMES]
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]))) / 2


def _right_card_margin(decision: dict[str, Any], label: str) -> float | None:
    """How surely the recognizer picks the right card: its score minus the best wrong card's.

    Positive when it ranks first (bigger is surer), negative when a wrong card beats it. A right card outside the
    top 5 scores at most the 5th, so that bound stands in for it. Raw scores aren't compared across models: each
    model spreads them differently, but the gap to the runner-up is what the app's decision reads.
    """
    scores = {candidate["oracle_id"]: candidate["score"] for candidate in decision["candidates"]}
    top = decision["candidates"][0]["score"]
    if decision["candidate_oracle_id"] == label:
        # Only the right card visible: the decision's own margin (a lower bound, or None for a one-card catalogue).
        return top - decision["candidates"][1]["score"] if len(decision["candidates"]) > 1 else decision["margin"]
    return scores.get(label, decision["candidates"][-1]["score"]) - top


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 4) if values else None


def _fraction(count: int, total: int) -> float | None:
    return round(count / total, 4) if total else None


def score_benchmark(training_root: Path, database: Path, extractor_version: str, artwork_version: str,
                    output: Path, benchmark_root: Path | None = None) -> dict[str, Any]:
    import onnxruntime as ort
    benchmark_root = benchmark_root or training_root / "camera" / "benchmark"
    if not benchmark_root.is_dir():
        raise ValueError(f"No benchmark folder at {benchmark_root}")
    extractor_root = training_root / "mobile" / "extractor" / extractor_version
    manifest = json.loads((extractor_root / "mobile-manifest.json").read_text(encoding="utf-8"))
    thresholds = json.loads((extractor_root / "thresholds.json").read_text(encoding="utf-8"))
    cpu = ["CPUExecutionProvider"]
    extractor = ort.InferenceSession(str(extractor_root / manifest["onnx"]), providers=cpu)
    # Extractors exported before recipe 9 have no refiner: the app keeps their corners.
    refiner = (ort.InferenceSession(str(extractor_root / manifest["refiner"]["onnx"]), providers=cpu)
               if manifest.get("refiner") else None)
    recognizer = load_phone_recognizer(training_root, artwork_version)
    app_labels = json.loads((recognizer.mobile_root / "app-labels.json").read_text(encoding="utf-8"))
    names = dict(zip(app_labels["oracle_ids"], app_labels["names"], strict=True))
    matcher = TitleMatcher(app_labels["oracle_ids"], app_labels["names"])
    # The model the app ships as title-reader.onnx, downloaded and checked by hash on PCs that have no copy.
    reader = TitleReader(ensure_model(training_root))
    display = CardNames(database).display
    input_size = manifest["input_shape"][2]

    photos, unlabelled = [], 0
    for path in sorted(path for path in benchmark_root.rglob("*") if path.suffix.lower() in PHOTO_SUFFIXES):
        annotation = _read_sidecar(path.with_name(path.stem + "._annotations.json"))
        identity = _read_sidecar(path.with_name(path.stem + "._identity.json")) or {}
        oracle = identity.get("OracleId")
        label = oracle.lower() if identity.get("Status") in LABEL_STATUSES and isinstance(oracle, str) else ""
        present = annotation is not None and annotation.get("CardPresent", True)
        # Corners drawn on one point or a line can't be cut out (and have no size to measure against).
        if annotation is None or not _annotation_valid(annotation) or (present and (not label
                                                                                    or _drawn_area(annotation) < 1e-6)):
            unlabelled += 1
            continue
        photos.append((path, annotation, label if present else None))

    def identify(frame: np.ndarray, corners: list[dict[str, float]]) -> tuple[str | None, str | None]:
        """identify.ts: the artwork decision, else the title against its top 5, then every card."""
        decision = recognizer.recognize(frame, corners, recognizer.app_thresholds)
        if not decision["rejected"]:
            return decision["oracle_id"], "embeddings"
        match = matcher.match(reader.read_frame(frame, corners),
                              [candidate["oracle_id"] for candidate in decision["candidates"]])
        return (match["oracle_id"], match["method"]) if match else (None, None)

    rows = []
    for done, (path, annotation, label) in enumerate(photos, 1):
        try:
            with Image.open(path) as source:
                frame = _phone_frame(source.convert("RGB"))
        except PermissionError as error:
            raise ValueError(f"{path} is in use; score again in a moment") from error
        except OSError:
            # A corrupt or half-synced photo: left out like an unlabelled one, not the end of every pair's score.
            unlabelled += 1
            emit("benchmark_progress", done=done, total=len(photos))
            continue
        height, width = frame.shape[:2]
        values = extractor.run(manifest["output_names"], {"image": _letterbox(frame, input_size)[None]})
        letterboxed, rejection = _decode({name: value.astype(np.float64) for name, value
                                          in zip(manifest["output_names"], values)}, manifest, thresholds)
        corners = (None if letterboxed is None else
                   unletterbox(letterboxed, width, height, input_size, manifest["coordinate_transform"]))
        found = rejection is None
        if found and refiner is not None:
            corners = refine_on_frame(refiner, frame, corners)["corners"]
        drawn = [{"x": annotation[name]["X"], "y": annotation[name]["Y"]} for name in CORNER_NAMES] if label else None
        corner_error, capped_error = None, None
        if drawn is not None:
            capped_error = CORNER_ERROR_CAP
            if found:
                truth, predicted = _pixels(drawn, width, height), _pixels(corners, width, height)
                # Corners drawn on one point have no size to measure against (and inf would not be valid JSON).
                diagonal = _diagonal(truth)
                corner_error = (float(np.linalg.norm(predicted - truth, axis=1).mean() / diagonal)
                                if diagonal > 0 else None)
                capped_error = None if corner_error is None else min(corner_error, CORNER_ERROR_CAP)

        artwork = None
        if drawn is not None:
            decision = recognizer.recognize(frame, drawn, recognizer.app_thresholds)
            top1 = decision["candidate_oracle_id"]
            artwork = {"oracle_id": top1, "name": names.get(top1), "correct": top1 == label,
                       "in_top5": label in [candidate["oracle_id"] for candidate in decision["candidates"]],
                       "accepted": not decision["rejected"], "score": decision["score"],
                       "margin": _right_card_margin(decision, label)}

        oracle, method = identify(frame, corners) if found else (None, None)
        if label:
            outcome = "right" if oracle == label else "wrong" if oracle else "none"
        else:
            outcome = "right" if not found else "wrong" if oracle else "none"
        relative = path.relative_to(benchmark_root)
        rows.append({"photo": relative.as_posix(), "session": "/".join(relative.parent.parts),
                     "card_present": label is not None, "oracle_id": label,
                     "card_name": display.get(label, label) if label else None,
                     "extractor": {"found": found, "rejection_reason": rejection, "corners": corners,
                                   "corner_error": corner_error, "capped_error": capped_error},
                     "artwork": artwork,
                     "end_to_end": {"outcome": outcome, "oracle_id": oracle,
                                    "name": names.get(oracle) if oracle else None, "method": method}})
        emit("benchmark_progress", done=done, total=len(photos))

    cards = [row for row in rows if row["card_present"]]
    no_card = [row for row in rows if not row["card_present"]]
    outcomes = [row["end_to_end"]["outcome"] for row in rows]
    errors = [row["extractor"]["corner_error"] for row in cards if row["extractor"]["corner_error"] is not None]
    summary = {
        "end_to_end_right": _fraction(outcomes.count("right"), len(rows)),
        "end_to_end_wrong": _fraction(outcomes.count("wrong"), len(rows)),
        "end_to_end_none": _fraction(outcomes.count("none"), len(rows)),
        "ocr_rescues": sum(row["end_to_end"]["outcome"] == "right"
                           and (row["end_to_end"]["method"] or "").startswith("ocr-") for row in rows),
        "extractor_found": _fraction(sum(row["extractor"]["found"] for row in cards), len(cards)),
        "extractor_false_finds": sum(row["extractor"]["found"] for row in no_card),
        "corner_error_median": statistics.median(errors) if errors else None,
        "corner_error_capped_mean": _mean([row["extractor"]["capped_error"] for row in cards
                                           if row["extractor"]["capped_error"] is not None]),
        "artwork_top1": _fraction(sum(row["artwork"]["correct"] for row in cards), len(cards)),
        "artwork_margin_mean": _mean([row["artwork"]["margin"] for row in cards
                                      if row["artwork"]["margin"] is not None]),
        "artwork_top5": _fraction(sum(row["artwork"]["in_top5"] for row in cards), len(cards)),
        "artwork_accepted_right": _fraction(sum(row["artwork"]["accepted"] and row["artwork"]["correct"]
                                                for row in cards), len(cards)),
        "artwork_accepted_wrong": _fraction(sum(row["artwork"]["accepted"] and not row["artwork"]["correct"]
                                                for row in cards), len(cards)),
    }
    report = {"extractor_version": extractor_version, "artwork_version": recognizer.version,
              "scored_utc": datetime.now(timezone.utc).isoformat(),
              "counts": {"photos": len(rows), "cards": len(cards), "no_card": len(no_card), "unlabelled": unlabelled},
              "summary": summary, "rows": rows}
    _write_json(output, report)
    emit("benchmark_scored", output=str(output), **report["counts"])
    return report
