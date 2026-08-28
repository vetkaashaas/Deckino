from __future__ import annotations

import hashlib
import json
import math
import random
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps
from torch import Tensor, nn
from torch.utils.data import DataLoader, Dataset
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small
from torchvision.transforms import functional as TF

from .events import emit
from .extraction_groups import assign_groups, capture_group, persistent_real_splits
from .extraction_network import CardExtractor, ARCHITECTURE, spatial_loss
from .extraction_augmentation import augment_photo

EXTRACTION_MANIFEST_SCHEMA = 1
ANNOTATION_DATASET_VERSION = "corners-v1"
EXTRACTION_ARTIFACT_SCHEMA = 2
MODEL_INPUT_SIZE = 256
RECTIFIED_WIDTH = 315
RECTIFIED_HEIGHT = 440
CORNER_ORDER = ("TopLeft", "TopRight", "BottomRight", "BottomLeft")
NORMALIZE_MEAN = (0.485, 0.456, 0.406)
NORMALIZE_STD = (0.229, 0.224, 0.225)
DEFAULT_SEED = 20260824
GENERATOR_VERSION = 2
BACKGROUND_STYLES = ("wood", "fabric", "paper", "clutter")


@dataclass(frozen=True)
class ExtractionRecord:
    schema_version: int
    dataset_version: str
    sample_id: str
    image_path: str
    image_sha256: str
    image_width: int
    image_height: int
    card_present: bool
    corners: list[dict[str, float]] | None
    source_kind: str
    source_group: str
    capture_condition: str | None
    condition_tags: list[str]
    parent_card_id: str | None
    parent_background_id: str | None
    generation_seed: int | None
    split: str
    generation_recipe: dict[str, Any] | None = None
    import_group: str | None = None
    capture_group: str | None = None
    grouping_evidence: dict[str, Any] | None = None


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _write_jsonl(path: Path, values: Iterable[object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as output:
        for value in values:
            payload = asdict(value) if hasattr(value, "__dataclass_fields__") else value
            output.write(json.dumps(payload, sort_keys=True) + "\n")
    temporary.replace(path)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_id(*values: str) -> str:
    return hashlib.sha256("\0".join(values).encode("utf-8")).hexdigest()


def _safe_relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise ValueError(f"Extraction image is outside the data root: {path}") from error


def _image_dimensions(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        image.load()
        return image.size


def _perceptual_hash(path: Path) -> tuple[int, tuple[float, float, float], np.ndarray]:
    """Return a difference hash plus mean colour for conservative leakage detection."""
    with Image.open(path) as image:
        rgb = np.asarray(image.convert("RGB").resize((32, 32), Image.Resampling.BILINEAR), dtype=np.float32)
        grayscale = image.convert("L")
        pixels = np.asarray(grayscale.resize((9, 8), Image.Resampling.BILINEAR), dtype=np.int16)
        structure = np.asarray(grayscale.resize((16, 16), Image.Resampling.BILINEAR), dtype=np.float32)
        structure -= structure.mean()
    bits = (pixels[:, 1:] >= pixels[:, :-1]).reshape(-1)
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value, tuple(float(channel) for channel in rgb.mean(axis=(0, 1))), structure


def _validate_quad(corners: Sequence[dict[str, float]]) -> None:
    if len(corners) != 4:
        raise ValueError("A present card must have exactly four corners")
    points = [(float(item["x"]), float(item["y"])) for item in corners]
    if any(not math.isfinite(value) or value < 0 or value > 1 for point in points for value in point):
        raise ValueError("Corner coordinates must be finite normalized values")
    signs: list[float] = []
    for index in range(4):
        a, b, c = points[index], points[(index + 1) % 4], points[(index + 2) % 4]
        signs.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
    if any(abs(value) < 1e-4 for value in signs) or not (
        all(value > 0 for value in signs) or all(value < 0 for value in signs)
    ):
        raise ValueError("Ordered corners must form a convex non-crossing quadrilateral")
    area = abs(sum(
        points[index][0] * points[(index + 1) % 4][1]
        - points[(index + 1) % 4][0] * points[index][1]
        for index in range(4)
    )) / 2
    if area < 0.0025:
        raise ValueError("Card quadrilateral is too small")
    try:
        coefficients = _homography_coefficients(
            [(0.0, 0.0), (RECTIFIED_WIDTH - 1.0, 0.0),
             (RECTIFIED_WIDTH - 1.0, RECTIFIED_HEIGHT - 1.0), (0.0, RECTIFIED_HEIGHT - 1.0)],
            points,
        )
    except np.linalg.LinAlgError as error:
        raise ValueError("Card quadrilateral does not produce a solvable 315x440 homography") from error
    if any(not math.isfinite(value) for value in coefficients):
        raise ValueError("Card quadrilateral produces a non-finite 315x440 homography")


def _sidecar_to_record(sidecar: Path, data_root: Path, dataset_version: str) -> tuple[dict[str, Any], Path]:
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    image_file = payload.get("ImageFile")
    if not isinstance(image_file, str) or Path(image_file).name != image_file:
        raise ValueError(f"{sidecar}: ImageFile must be a local filename")
    image_path = sidecar.parent / image_file
    if not image_path.is_file():
        raise ValueError(f"{sidecar}: matching image does not exist")
    with Image.open(image_path) as source_image:
        if source_image.getexif().get(274) not in (None, 1):
            raise ValueError(f"{sidecar}: stored image still has a non-normalized EXIF orientation")
    width, height = _image_dimensions(image_path)
    if (payload.get("SchemaVersion") != 1
            or payload.get("DatasetVersion") != ANNOTATION_DATASET_VERSION):
        raise ValueError(f"{sidecar}: incompatible annotation schema or dataset version")
    if payload.get("ImageWidth") != width or payload.get("ImageHeight") != height:
        raise ValueError(f"{sidecar}: annotation dimensions do not match the stored image")
    order = payload.get("CornerOrder")
    if order != list(CORNER_ORDER):
        raise ValueError(f"{sidecar}: unsupported corner order {order}")
    if not isinstance(payload.get("CardPresent"), bool):
        raise ValueError(f"{sidecar}: CardPresent must be an explicit boolean")
    present = payload["CardPresent"]
    corners = None
    if present:
        corners = []
        for name in CORNER_ORDER:
            point = payload.get(name)
            if not isinstance(point, dict) or "X" not in point or "Y" not in point:
                raise ValueError(f"{sidecar}: {name} is missing")
            corners.append({"x": float(point["X"]), "y": float(point["Y"])})
        _validate_quad(corners)
    elif any(name not in payload or payload[name] is not None for name in CORNER_ORDER):
        raise ValueError(f"{sidecar}: no-card annotations must have null corners")
    relative = _safe_relative(image_path, data_root)
    image_hash = _sha256(image_path)
    source_group = str(payload.get("SourceGroup") or sidecar.parent.relative_to(data_root).as_posix())
    capture, evidence = capture_group(sidecar, image_path, source_group, data_root / "training" / "camera" / "imports")
    return ({
        "image_path": relative,
        "image_sha256": image_hash,
        "image_width": width,
        "image_height": height,
        "card_present": present,
        "corners": corners,
        "source_kind": "real",
        "source_group": capture,
        "import_group": source_group,
        "capture_group": capture,
        "grouping_evidence": evidence,
        "capture_condition": payload.get("CaptureCondition"),
        "condition_tags": [payload["CaptureCondition"]] if payload.get("CaptureCondition") else [],
        "parent_card_id": None,
        "parent_background_id": None,
        "generation_seed": None,
        "requested_split": payload.get("Split"),
    }, image_path)


def inspect_foreign_dataset(input_root: Path, output: Path) -> dict[str, Any]:
    input_root = input_root.resolve()
    if not input_root.is_dir():
        raise FileNotFoundError(f"Dataset folder not found: {input_root}")
    images = sorted(path for path in input_root.rglob("*") if path.suffix.casefold() in {".jpg", ".jpeg", ".png"})
    json_files = sorted(input_root.rglob("*.json"))
    key_sets: defaultdict[tuple[str, ...], int] = defaultdict(int)
    parse_failures: list[str] = []
    for path in json_files:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                key_sets[tuple(sorted(payload))] += 1
        except (OSError, json.JSONDecodeError) as error:
            parse_failures.append(f"{path.relative_to(input_root).as_posix()}: {error}")
    matching_sidecars = sum((path.parent / f"{path.stem}._annotations.json").is_file() for path in images)
    result = {
        "inspection_schema_version": 1,
        "input_root": str(input_root),
        "images": len(images),
        "json_files": len(json_files),
        "matching_deckino_sidecars": matching_sidecars,
        "observed_json_shapes": [{"keys": list(keys), "count": count} for keys, count in sorted(key_sets.items())],
        "parse_failures": parse_failures[:100],
        "decision_required": matching_sidecars != len(images),
        "message": "Use the Deckino sidecar adapter." if matching_sidecars == len(images)
        else "Inspect coordinate units, origin, order, EXIF behavior, negatives, groups, and rights before adding an adapter.",
    }
    _write_json(output, result)
    emit("extraction_dataset_inspected", images=len(images), json_files=len(json_files), output=str(output))
    return result


def _assign_splits(groups: dict[str, dict[str, Any]], seed: int) -> dict[str, str]:
    return assign_groups(groups, seed)


def _homography_coefficients(destination: Sequence[tuple[float, float]], source: Sequence[tuple[float, float]]) -> list[float]:
    matrix: list[list[float]] = []
    target: list[float] = []
    for (x, y), (u, v) in zip(destination, source, strict=True):
        matrix.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        target.append(u)
        matrix.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        target.append(v)
    return np.linalg.solve(np.asarray(matrix), np.asarray(target)).tolist()


def _render_card(card: Image.Image, background: Image.Image, quad: Sequence[tuple[float, float]], seed: int,
                 occlude: bool = False) -> Image.Image:
    rng = random.Random(seed)
    canvas = background.convert("RGB").resize((640, 640), Image.Resampling.BICUBIC)
    card = card.convert("RGB").resize((315, 440), Image.Resampling.BICUBIC)
    if rng.random() < 0.45:
        border = Image.new("RGB", (331, 456), rng.choice(((25, 25, 28), (28, 40, 70), (90, 30, 45))))
        border.paste(card, (8, 8))
        card = border.resize((315, 440), Image.Resampling.BICUBIC)
    source_quad = [(0.0, 0.0), (314.0, 0.0), (314.0, 439.0), (0.0, 439.0)]
    # Map the requested output quadrilateral back into card coordinates.
    matrix: list[list[float]] = []
    target: list[float] = []
    for (x, y), (u, v) in zip(quad, source_quad, strict=True):
        matrix.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); target.append(u)
        matrix.append([0, 0, 0, x, y, 1, -v * x, -v * y]); target.append(v)
    inverse = np.linalg.solve(np.asarray(matrix), np.asarray(target)).tolist()
    warped = card.transform((640, 640), Image.Transform.PERSPECTIVE, inverse, Image.Resampling.BICUBIC)
    mask = Image.new("L", card.size, 255).transform((640, 640), Image.Transform.PERSPECTIVE, inverse, Image.Resampling.BILINEAR)
    shadow = mask.filter(ImageFilter.GaussianBlur(rng.uniform(5, 14)))
    shifted = Image.new("L", canvas.size, 0)
    shifted.paste(shadow, (rng.randint(4, 14), rng.randint(6, 18)))
    dark = Image.new("RGB", canvas.size, (12, 10, 12))
    canvas = Image.composite(dark, canvas, shifted.point(lambda value: int(value * 0.42)))
    canvas.paste(warped, (0, 0), mask)
    canvas = ImageEnhance.Brightness(canvas).enhance(rng.uniform(0.65, 1.25))
    canvas = ImageEnhance.Contrast(canvas).enhance(rng.uniform(0.75, 1.30))
    canvas = ImageEnhance.Color(canvas).enhance(rng.uniform(0.75, 1.20))
    if rng.random() < 0.55:
        glare = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(glare)
        x = rng.randint(-100, 600)
        draw.polygon([(x, 0), (x + rng.randint(30, 100), 0), (x + 240, 640), (x + 120, 640)], fill=(255, 255, 255, rng.randint(25, 85)))
        canvas = Image.alpha_composite(canvas.convert("RGBA"), glare).convert("RGB")
    if rng.random() < 0.45:
        canvas = canvas.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.6)))
    if rng.random() < 0.25:
        horizontal = rng.random() < 0.5
        weights = [0.0] * 25
        for offset in range(5):
            weights[2 * 5 + offset if horizontal else offset * 5 + 2] = 0.2
        canvas = canvas.filter(ImageFilter.Kernel((5, 5), weights, scale=1.0))
    array = np.asarray(canvas, dtype=np.float32)
    array += np.random.default_rng(seed ^ 0xBAD5EED).normal(0, rng.uniform(0.0, 7.0), array.shape)
    yy, xx = np.ogrid[-1:1:640j, -1:1:640j]
    vignette = np.clip(1.0 - (xx * xx + yy * yy) * rng.uniform(0.0, 0.22), 0.65, 1.0)[..., None]
    canvas = Image.fromarray(np.clip(array * vignette, 0, 255).astype(np.uint8), "RGB")
    if occlude:
        draw = ImageDraw.Draw(canvas)
        x_values, y_values = [point[0] for point in quad], [point[1] for point in quad]
        left, top, right, bottom = min(x_values), min(y_values), max(x_values), max(y_values)
        draw.rounded_rectangle((left - 8, top + (bottom - top) * 0.35,
                                right + 8, top + (bottom - top) * 0.62), radius=12,
                               fill=tuple(rng.randint(20, 170) for _ in range(3)))
    return canvas


def _synthetic_quad(seed: int, hard_negative: bool) -> list[tuple[float, float]]:
    rng = random.Random(seed)
    scale = rng.uniform(0.25, 0.72)
    width = 640 * scale
    height = width * 440 / 315
    angle = math.radians(rng.uniform(-40, 40))
    center_x = rng.uniform(-0.05, 1.05) * 640 if hard_negative else rng.uniform(0.25, 0.75) * 640
    center_y = rng.uniform(-0.05, 1.05) * 640 if hard_negative else rng.uniform(0.32, 0.68) * 640
    base = [(-width / 2, -height / 2), (width / 2, -height / 2), (width / 2, height / 2), (-width / 2, height / 2)]
    result = []
    for x, y in base:
        px = center_x + x * math.cos(angle) - y * math.sin(angle) + rng.uniform(-0.08, 0.08) * width
        py = center_y + x * math.sin(angle) + y * math.cos(angle) + rng.uniform(-0.06, 0.06) * height
        result.append((px, py))
    return result


def _procedural_background(seed: int) -> Image.Image:
    rng = np.random.default_rng(seed)
    style = BACKGROUND_STYLES[seed % len(BACKGROUND_STYLES)]
    palette = {"wood": (125, 72, 38), "fabric": (55, 70, 105),
               "paper": (190, 184, 165), "clutter": (95, 95, 105)}
    base = np.asarray(palette[style], dtype=np.uint8).reshape(1, 1, 3)
    noise = rng.normal(0, 18, size=(640, 640, 3))
    array = np.clip(base + noise, 0, 255).astype(np.uint8)
    image = Image.fromarray(array, "RGB").filter(ImageFilter.GaussianBlur(2.5))
    draw = ImageDraw.Draw(image)
    randomizer = random.Random(seed)
    if style == "wood":
        for y in range(0, 640, 38):
            draw.line((0, y + randomizer.randint(-5, 5), 639, y + randomizer.randint(-5, 5)),
                      fill=(75, 42, 24), width=3)
    elif style == "fabric":
        for offset in range(0, 640, 24):
            draw.line((offset, 0, offset, 639), fill=(75, 88, 125), width=1)
            draw.line((0, offset, 639, offset), fill=(42, 54, 86), width=1)
    elif style == "paper":
        for y in range(45, 640, 32):
            draw.line((0, y, 639, y), fill=(150, 160, 175), width=1)
    for _ in range(20):
        x, y = randomizer.randrange(640), randomizer.randrange(640)
        w, h = randomizer.randrange(20, 180), randomizer.randrange(8, 90)
        draw.rounded_rectangle((x, y, min(639, x + w), min(639, y + h)), radius=6,
                               fill=tuple(randomizer.randrange(25, 220) for _ in range(3)))
    return image


def prepare_extraction_dataset(
    data_root: Path,
    dataset_version: str,
    seed: int = DEFAULT_SEED,
    synthetic_per_card: int = 4,
    max_full_cards: int = 5000,
    *,
    include_synthetic: bool = False,
) -> dict[str, Any]:
    data_root = data_root.resolve()
    imports_root = data_root / "training" / "camera" / "imports"
    export_root = data_root / "exports" / dataset_version
    synthetic_root = data_root / "training" / "extraction" / "synthetic" / dataset_version
    raw: list[dict[str, Any]] = []
    annotation_inventory: list[dict[str, str]] = []
    errors: list[str] = []
    sidecars = sorted(imports_root.rglob("*._annotations.json")) if imports_root.is_dir() else []

    def progress(phase: str, completed: int, total: int, detail: str) -> None:
        interval = min(100, max(1, total // 20))
        if completed == 1 or completed == total or completed % interval == 0:
            emit("extraction_preparation_progress", phase=phase, completed=completed,
                 total=total, detail=detail)

    for index, sidecar in enumerate(sidecars, start=1):
        try:
            value, _ = _sidecar_to_record(sidecar, data_root, dataset_version)
            raw.append(value)
            annotation_inventory.append({"annotation_path": _safe_relative(sidecar, data_root),
                                         "sha256": _sha256(sidecar)})
        except (OSError, ValueError, json.JSONDecodeError) as error:
            errors.append(str(error))
        progress("annotations", index, len(sidecars), "Validating annotated photographs")
    if errors:
        _write_json(export_root / "preparation-errors.json", {"errors": errors[:200]})
        raise ValueError(f"{len(errors)} extraction annotations are invalid; see preparation-errors.json")
    if not raw:
        raise ValueError("No valid managed extraction annotations were found")

    full_card_root = data_root / "training" / "extraction" / "full-cards"
    full_cards = sorted(path for path in full_card_root.rglob("*")
                        if path.suffix.casefold() in {".jpg", ".jpeg", ".png"})[:max_full_cards] if include_synthetic and full_card_root.is_dir() else []
    background_root = data_root / "training" / "extraction" / "backgrounds"
    backgrounds = sorted(path for path in background_root.rglob("*")
                          if path.suffix.casefold() in {".jpg", ".jpeg", ".png"}) if include_synthetic and background_root.is_dir() else []
    full_card_hashes: dict[Path, str] = {}
    for index, path in enumerate(full_cards, start=1):
        full_card_hashes[path] = _sha256(path)
        progress("full_card_hashes", index, len(full_cards), "Checking cached full-card images")
    background_hashes: dict[Path, str] = {}
    for index, path in enumerate(backgrounds, start=1):
        background_hashes[path] = _sha256(path)
        progress("background_hashes", index, len(backgrounds), "Checking background images")
    preparation_input = {
        "grouping_version": 2,
        "generator_version": GENERATOR_VERSION, "seed": seed,
        "synthetic_per_card": synthetic_per_card, "max_full_cards": max_full_cards,
        "include_synthetic": include_synthetic,
        "annotations": raw, "full_cards": list(full_card_hashes.values()),
        "backgrounds": list(background_hashes.values()),
    }
    preparation_input_sha256 = hashlib.sha256(
        json.dumps(preparation_input, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    existing_metadata_path = export_root / "metadata.json"
    if existing_metadata_path.is_file():
        existing_metadata = json.loads(existing_metadata_path.read_text(encoding="utf-8"))
        existing_fingerprint = existing_metadata.get("preparation_input_sha256")
        if existing_fingerprint is not None and existing_fingerprint != preparation_input_sha256:
            raise ValueError(f"Dataset version {dataset_version} is immutable and its preparation inputs changed; start a new dataset version")

    group_parent = {item["source_group"]: item["source_group"] for item in raw}

    def find(group: str) -> str:
        while group_parent[group] != group:
            group_parent[group] = group_parent[group_parent[group]]
            group = group_parent[group]
        return group

    def merge(left: str, right: str) -> None:
        left_root, right_root = find(left), find(right)
        if left_root == right_root:
            return
        first, second = sorted((left_root, right_root))
        group_parent[second] = first

    hashes: list[tuple[str, int, tuple[float, float, float], np.ndarray, str]] = []
    for index, item in enumerate(raw, start=1):
        image_path = data_root / item["image_path"]
        perceptual, mean_rgb, structure = _perceptual_hash(image_path)
        hashes.append((item["image_sha256"], perceptual, mean_rgb, structure, item["source_group"]))
        progress("real_image_hashes", index, len(raw), "Grouping related camera photographs")
    near_duplicate_pairs = 0
    for index, (digest, perceptual, mean_rgb, structure, group) in enumerate(hashes):
        for other_digest, other_perceptual, other_mean_rgb, other_structure, other_group in hashes[:index]:
            colour_distance = math.dist(mean_rgb, other_mean_rgb)
            structural_distance = float(np.mean(np.abs(structure - other_structure)))
            if digest == other_digest or ((perceptual ^ other_perceptual).bit_count() <= 4
                                          and colour_distance <= 35 and structural_distance <= 1):
                if find(group) != find(other_group):
                    near_duplicate_pairs += 1
                merge(group, other_group)
    for item in raw:
        item["source_group"] = find(item["source_group"])
    registry_path = data_root / "training" / "extraction" / "capture-splits-v2.json"
    split_by_group, registry = persistent_real_splits(raw, registry_path, seed)
    for item in raw:
        item.pop("requested_split")
    records: list[ExtractionRecord] = []
    unique_images: dict[str, dict[str, Any]] = {}
    for item in raw:
        previous = unique_images.get(item["image_sha256"])
        if previous is not None:
            if previous["card_present"] != item["card_present"] or (item["card_present"] and not np.allclose(
                    [[point["x"], point["y"]] for point in previous["corners"]],
                    [[point["x"], point["y"]] for point in item["corners"]], atol=.001, rtol=0)):
                raise ValueError(f"Identical photograph has conflicting annotations: {previous['image_path']} and {item['image_path']}")
            continue
        unique_images[item["image_sha256"]] = item
        split = split_by_group[item["source_group"]]
        records.append(ExtractionRecord(
            EXTRACTION_MANIFEST_SCHEMA, dataset_version,
            _stable_id(dataset_version, item["image_sha256"], item["source_group"]),
            split=split, **item,
        ))

    synthetic_groups = {
        f"synthetic-card:{full_card_hashes[card_path]}": {
            "source_kind": "synthetic-positive", "card_present": True,
            "condition": "synthetic", "requested": None,
        }
        for card_path in full_cards
    }
    synthetic_splits = _assign_splits(synthetic_groups, seed) if synthetic_groups else {}
    background_groups = {
        f"background:{digest}": {"source_kind": "synthetic-negative", "card_present": False,
                                 "condition": "authorized-background", "requested": None}
        for digest in background_hashes.values()
    }
    background_splits = _assign_splits(background_groups, seed) if background_groups else {}
    backgrounds_by_split = {split: [path for path in backgrounds
                                    if background_splits[f"background:{background_hashes[path]}"] == split]
                            for split in ("train", "validation", "test")}
    synthetic_total = len(full_cards) * synthetic_per_card
    synthetic_completed = 0
    for card_path in full_cards:
        card_hash = full_card_hashes[card_path]
        group = f"synthetic-card:{card_hash}"
        split = synthetic_splits[group]
        for variant in range(synthetic_per_card):
            generation_seed = int(_stable_id(str(seed), card_hash, str(variant))[:15], 16)
            hard_negative = variant == synthetic_per_card - 1 and synthetic_per_card > 2
            quad = _synthetic_quad(generation_seed, hard_negative)
            output = synthetic_root / split / f"{card_hash[:16]}-g{GENERATOR_VERSION:02d}-{variant:02d}.jpg"
            output.parent.mkdir(parents=True, exist_ok=True)
            available_backgrounds = backgrounds_by_split[split]
            selected_background = available_backgrounds[generation_seed % len(available_backgrounds)] if available_backgrounds else None
            background_hash = background_hashes[selected_background] if selected_background else None
            background_style = "authorized" if selected_background else BACKGROUND_STYLES[generation_seed % len(BACKGROUND_STYLES)]
            if not output.is_file():
                with Image.open(card_path) as card:
                    if selected_background:
                        with Image.open(selected_background) as background_source:
                            background = background_source.convert("RGB")
                    else:
                        background = _procedural_background(generation_seed)
                    scene = _render_card(card, background, quad, generation_seed, occlude=hard_negative)
                    scene.save(output, quality=91, optimize=True)
            inside = all(0 <= x <= 639 and 0 <= y <= 639 for x, y in quad)
            present = inside and not hard_negative
            corners = [{"x": x / 639, "y": y / 639} for x, y in quad] if present else None
            if corners is not None:
                try:
                    _validate_quad(corners)
                except ValueError:
                    present, corners = False, None
            output_hash = _sha256(output)
            records.append(ExtractionRecord(
                EXTRACTION_MANIFEST_SCHEMA, dataset_version,
                _stable_id(dataset_version, output_hash, group), _safe_relative(output, data_root),
                output_hash, 640, 640, present, corners,
                "synthetic-positive" if present else "hard-negative", group, "synthetic",
                ["perspective", "rotation", "distance", "lighting", "shadow", "blur", "noise",
                 "vignette", "glare", "clutter", "sleeve", "occlusion" if hard_negative else background_style],
                card_hash, background_hash or f"procedural:{background_style}", generation_seed, split,
                {"generator_version": GENERATOR_VERSION, "renderer_seed": generation_seed, "card_sha256": card_hash,
                 "background": background_hash or f"procedural-{background_style}-v1", "quad_pixels": quad,
                 "hard_negative": hard_negative, "canvas": [640, 640]},
            ))
            synthetic_completed += 1
            progress("synthetic_cards", synthetic_completed, synthetic_total,
                     "Generating synthetic card photographs")

    for background_path, background_hash in background_hashes.items():
        width, height = _image_dimensions(background_path)
        group = f"background:{background_hash}"
        records.append(ExtractionRecord(
            EXTRACTION_MANIFEST_SCHEMA, dataset_version,
            _stable_id(dataset_version, background_hash, group), _safe_relative(background_path, data_root),
            background_hash, width, height, False, None, "synthetic-negative", group,
            "authorized-background", ["background-only"], None, background_hash, None,
            background_splits[group], None,
        ))

    negative_types = ("background-only", "rectangular-non-card", "screen", "book", "packaging")
    negative_groups = {
        f"synthetic-background:{index:03d}": {
            "source_kind": "synthetic-negative", "card_present": False,
            "condition": f"negative:{negative_types[index % len(negative_types)]}", "requested": None,
        }
        for index in range(32 if include_synthetic else 0)
    }
    negative_splits = _assign_splits(negative_groups, seed)
    for index, group in enumerate(negative_groups):
        generation_seed = int(_stable_id(str(seed), group)[:15], 16)
        split = negative_splits[group]
        negative_type = negative_types[index % len(negative_types)]
        output = synthetic_root / split / f"negative-g{GENERATOR_VERSION:02d}-{index:03d}.jpg"
        output.parent.mkdir(parents=True, exist_ok=True)
        if not output.is_file():
            scene = _procedural_background(generation_seed)
            draw = ImageDraw.Draw(scene)
            randomizer = random.Random(generation_seed)
            if negative_type != "background-only":
                object_count = 4 if negative_type == "rectangular-non-card" else 1
                for _ in range(object_count):
                    x, y = randomizer.randint(0, 450), randomizer.randint(0, 480)
                    width, height = randomizer.randint(90, 220), randomizer.randint(80, 180)
                    fill = (18, 22, 28) if negative_type == "screen" else tuple(randomizer.randint(20, 210) for _ in range(3))
                    draw.rounded_rectangle((x, y, min(639, x + width), min(639, y + height)), radius=8,
                                           fill=fill, outline=(225, 225, 225), width=5)
                    if negative_type in {"book", "packaging"}:
                        draw.line((x + 15, y + 25, min(630, x + width - 15), y + 25), fill=(245, 245, 245), width=4)
            scene.save(output, quality=91, optimize=True)
        output_hash = _sha256(output)
        records.append(ExtractionRecord(
            EXTRACTION_MANIFEST_SCHEMA, dataset_version,
            _stable_id(dataset_version, output_hash, group), _safe_relative(output, data_root),
            output_hash, 640, 640, False, None, "synthetic-negative", group,
            f"negative:{negative_type}", ["clutter", negative_type], None,
            f"procedural:{index:03d}", generation_seed, split,
            {"generator_version": GENERATOR_VERSION, "renderer_seed": generation_seed,
             "background": "procedural-clutter-v1", "negative_type": negative_type,
              "canvas": [640, 640]},
        ))
        progress("negative_scenes", index + 1, len(negative_groups),
                 "Generating synthetic no-card photographs")

    records.sort(key=lambda item: (item.split, item.source_group, item.sample_id))
    _write_jsonl(export_root / "manifest.jsonl", records)
    source_inventory = sorted({item.image_path: item.image_sha256 for item in records}.items())
    _write_json(export_root / "source-inventory.json", {
        "images": [{"image_path": path, "sha256": digest} for path, digest in source_inventory],
        "annotations": sorted(annotation_inventory, key=lambda item: item["annotation_path"]),
        "full_card_assets": [{"path": _safe_relative(path, data_root), "sha256": full_card_hashes[path]} for path in full_cards],
        "background_assets": [{"path": _safe_relative(path, data_root), "sha256": digest}
                              for path, digest in background_hashes.items()],
    })
    counts = {split: sum(item.split == split for item in records) for split in ("train", "validation", "test")}
    report = {
        "schema_version": EXTRACTION_MANIFEST_SCHEMA,
        "dataset_version": dataset_version,
        "generator_version": GENERATOR_VERSION,
        "preparation_input_sha256": preparation_input_sha256,
        "seed": seed,
        "records": len(records),
        "real_records": sum(item.source_kind.startswith("real") for item in records),
        "synthetic_records": sum(item.source_kind.startswith("synthetic") or item.source_kind == "hard-negative" for item in records),
        "include_synthetic": include_synthetic,
        "positive_records": sum(item.card_present for item in records),
        "negative_records": sum(not item.card_present for item in records),
        "source_groups": len({item.source_group for item in records}),
        "near_duplicate_group_merges": near_duplicate_pairs,
        "exact_duplicate_photos_excluded": len(raw) - len(unique_images),
        "splits": counts,
        "full_card_assets": len(full_cards),
        "authorized_background_assets": len(backgrounds),
        "production_data_ready": counts["validation"] > 0 and counts["test"] > 0
            and sum(item.source_kind == "real" and item.split == "test" and item.card_present for item in records) >= 200
            and sum(item.source_kind == "real" and item.split == "test" and not item.card_present for item in records) >= 200
            and len({item.source_group for item in records if item.source_kind == "real" and item.split == "test"}) >= 5,
    }
    metadata = {
        "schema_version": EXTRACTION_MANIFEST_SCHEMA,
        "dataset_version": dataset_version,
        "generator_version": GENERATOR_VERSION,
        "preparation_input_sha256": preparation_input_sha256,
        "image_root": "../..",
        "include_synthetic": include_synthetic,
        "corner_order": list(CORNER_ORDER),
        "coordinate_origin": "top_left",
        "coordinate_normalization": "x/(width-1), y/(height-1)",
        "card_presence": "one fully rectifiable card; false requires null corners",
        "input": {"width": MODEL_INPUT_SIZE, "height": MODEL_INPUT_SIZE, "resize": "contain",
                  "resize_rounding": "round-half-to-even", "padding": "centered-floor-left-top",
                  "padding_color_rgb": [0, 0, 0], "channel_order": "RGB",
                  "mean": NORMALIZE_MEAN, "std": NORMALIZE_STD},
        "rectified_output": {"width": RECTIFIED_WIDTH, "height": RECTIFIED_HEIGHT},
    }
    grouping = {"grouping_version": 2, "split_assignments": split_by_group,
                "warnings": [{"image_path": item.image_path, **item.grouping_evidence}
                             for item in records if item.grouping_evidence and item.grouping_evidence.get("warning")],
                "groups": [{"image_path": item.image_path, "import_group": item.import_group,
                            "capture_group": item.capture_group, "source_group": item.source_group,
                            "split": item.split, "evidence": item.grouping_evidence}
                           for item in records if item.source_kind == "real"]}
    report["development_only"] = not all(any(item.source_kind == "real" and item.split == split
                                               for item in records) for split in ("validation", "test"))
    report["real_source_groups"] = len({item.source_group for item in records if item.source_kind == "real"})
    report["real_splits"] = {split: {"positive": sum(item.source_kind == "real" and item.split == split and item.card_present for item in records),
                                      "negative": sum(item.source_kind == "real" and item.split == split and not item.card_present for item in records)}
                              for split in ("train", "validation", "test")}
    report["grouping_warnings"] = len(grouping["warnings"])
    _write_json(export_root / "grouping-report.json", grouping)
    _write_json(export_root / "split-assignments.json", split_by_group)
    _write_json(registry_path, registry)
    _write_json(export_root / "metadata.json", metadata)
    _write_json(export_root / "preparation-report.json", report)
    emit("extraction_dataset_prepared", **report)
    return report


def read_manifest(path: Path) -> tuple[list[ExtractionRecord], Path, dict[str, Any]]:
    metadata_path = path.parent / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("requires_original_data_root"):
        raise ValueError("This portable snapshot references external images; use the original dataset manifest for training")
    if metadata.get("schema_version") != EXTRACTION_MANIFEST_SCHEMA:
        raise ValueError("Extraction manifest requires schema v1 metadata")
    records = [ExtractionRecord(**json.loads(line)) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not records or any(item.dataset_version != metadata["dataset_version"] for item in records):
        raise ValueError("Extraction manifest is empty or version-inconsistent")
    established: dict[tuple[str, str], str] = {}
    sample_ids = set()
    for record in records:
        if record.split not in ("train", "validation", "test"):
            raise ValueError(f"Invalid manifest split for {record.sample_id}")
        if record.sample_id in sample_ids:
            raise ValueError(f"Duplicate manifest sample ID: {record.sample_id}")
        sample_ids.add(record.sample_id)
        for kind, value in (("capture", record.source_group), ("image", record.image_sha256)):
            if established.setdefault((kind, value), record.split) != record.split:
                raise ValueError(f"Manifest {kind} crosses train/validation/test splits: {value}")
    image_root = (path.parent / metadata["image_root"]).resolve()
    return records, image_root, metadata


def letterbox(image: Image.Image, corners: Sequence[dict[str, float]] | None = None,
              input_size: int = MODEL_INPUT_SIZE, mean: Sequence[float] = NORMALIZE_MEAN,
              std: Sequence[float] = NORMALIZE_STD) -> tuple[Tensor, Tensor | None]:
    image = image.convert("RGB")
    width, height = image.size
    scale = min(input_size / width, input_size / height)
    resized_width = max(1, min(input_size, round(width * scale)))
    resized_height = max(1, min(input_size, round(height * scale)))
    left = (input_size - resized_width) // 2
    top = (input_size - resized_height) // 2
    canvas = Image.new("RGB", (input_size, input_size))
    canvas.paste(image.resize((resized_width, resized_height), Image.Resampling.BICUBIC), (left, top))
    tensor = TF.normalize(TF.to_tensor(canvas), mean, std)
    if corners is None:
        return tensor, None
    values: list[float] = []
    for point in corners:
        pixel_x = point["x"] * (width - 1)
        pixel_y = point["y"] * (height - 1)
        values.extend(((pixel_x * scale + left) / (input_size - 1),
                       (pixel_y * scale + top) / (input_size - 1)))
    return tensor, torch.tensor(values, dtype=torch.float32)


def unletterbox(values: Sequence[float], width: int, height: int,
                input_size: int = MODEL_INPUT_SIZE) -> list[dict[str, float]]:
    scale = min(input_size / width, input_size / height)
    resized_width, resized_height = round(width * scale), round(height * scale)
    left, top = (input_size - resized_width) // 2, (input_size - resized_height) // 2
    result = []
    for index in range(0, 8, 2):
        pixel_x = (float(values[index]) * (input_size - 1) - left) / scale
        pixel_y = (float(values[index + 1]) * (input_size - 1) - top) / scale
        result.append({"x": pixel_x / max(1, width - 1), "y": pixel_y / max(1, height - 1)})
    return result


class ExtractionDataset(Dataset[tuple[Tensor, Tensor, Tensor, str]]):
    def __init__(self, image_root: Path, records: Sequence[ExtractionRecord], training: bool = False,
                 input_size: int = MODEL_INPUT_SIZE, mean: Sequence[float] = NORMALIZE_MEAN,
                 std: Sequence[float] = NORMALIZE_STD) -> None:
        self.image_root = image_root
        self.records = list(records)
        self.training = training
        self.input_size, self.mean, self.std = input_size, mean, std

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int | tuple[int, int]) -> tuple[Tensor, Tensor, Tensor, str]:
        rng = random.Random(index[1]) if isinstance(index, tuple) else random
        index = index[0] if isinstance(index, tuple) else index
        record = self.records[index]
        with Image.open(self.image_root / record.image_path) as source:
            image = source.convert("RGB")
        points = record.corners
        if self.training:
            image, points = augment_photo(image, points, rng)
        tensor, corners = letterbox(image, points, self.input_size, self.mean, self.std)
        if corners is None:
            corners = torch.zeros(8, dtype=torch.float32)
        return tensor, corners, torch.tensor(float(record.card_present)), record.sample_id


class LegacyCardExtractor(nn.Module):
    def __init__(self, pretrained: bool = False) -> None:
        super().__init__()
        network = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT if pretrained else None)
        self.features = network.features
        self.pool = network.avgpool
        self.shared = nn.Sequential(nn.Linear(576, 128), nn.Hardswish(), nn.Dropout(0.15))
        self.corner_head = nn.Linear(128, 8)
        self.presence_head = nn.Linear(128, 1)

    def forward(self, images: Tensor) -> tuple[Tensor, Tensor]:
        values = self.pool(self.features(images)).flatten(1)
        values = self.shared(values)
        return torch.sigmoid(self.corner_head(values)), self.presence_head(values).squeeze(1)


def _device(name: str, cuda_index: int | None) -> torch.device:
    if name == "auto":
        name = "cuda" if torch.cuda.is_available() else "cpu"
    if name == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable")
        index = 0 if cuda_index is None else cuda_index
        torch.cuda.set_device(index)
        return torch.device("cuda", index)
    return torch.device("cpu")


def extractor_smoke(manifest: Path, device_name: str, batch_size: int, steps: int, cuda_index: int | None) -> dict[str, Any]:
    if batch_size < 1 or steps < 1:
        raise ValueError("CUDA validation batch size and steps must be positive")
    records, root, _ = read_manifest(manifest)
    train_records = sorted((item for item in records if item.split == "train"), key=lambda item: not item.card_present)
    if not any(item.card_present for item in train_records):
        raise ValueError("Extractor CUDA validation requires a positive training sample")
    # Validate the actual production batch even when only a handful of photos exist.
    indices = [index % len(train_records) for index in range(batch_size * steps)]
    loader = DataLoader(ExtractionDataset(root, train_records, training=True), batch_size=batch_size, sampler=indices)
    device = _device(device_name, cuda_index)
    model = CardExtractor().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
    completed = 0
    loss_values: list[float] = []
    corner_values: list[float] = []
    presence_values: list[float] = []
    corner_gradient = 0.0
    presence_gradient = 0.0
    for images, corners, presence, _ in loader:
        images, corners, presence = images.to(device), corners.to(device), presence.to(device)
        optimizer.zero_grad(set_to_none=True)
        predicted, logits, heatmaps = model.forward_with_heatmaps(images)
        loss, components = spatial_loss(predicted, logits, heatmaps, corners, presence)
        corner_loss, presence_loss = components["corner_loss"], components["presence_loss"]
        loss.backward()
        corner_gradient = max(corner_gradient, sum(float(parameter.grad.detach().abs().sum().cpu())
                              for parameter in model.corner_head.parameters() if parameter.grad is not None))
        presence_gradient = max(presence_gradient, sum(float(parameter.grad.detach().abs().sum().cpu())
                                for parameter in model.presence_head.parameters() if parameter.grad is not None))
        optimizer.step()
        loss_values.append(float(loss.detach().cpu()))
        corner_values.append(float(corner_loss.detach().cpu()))
        presence_values.append(float(presence_loss.detach().cpu()))
        completed += 1
        if completed >= steps:
            break
    values = (sum(loss_values) / completed, sum(corner_values) / completed, sum(presence_values) / completed)
    if not all(math.isfinite(value) for value in values) or corner_gradient <= 0 or presence_gradient <= 0:
        raise RuntimeError("Extractor smoke produced a non-finite loss or an inactive output head")
    result = {"device": str(device), "batch_size": batch_size, "steps": completed,
              "loss": values[0], "corner_loss": values[1], "presence_loss": values[2],
              "corner_gradient": corner_gradient, "presence_gradient": presence_gradient}
    emit("extraction_cuda_smoke_completed", **result)
    return result


def _cpu(value: Any) -> Any:
    if isinstance(value, Tensor):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: _cpu(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_cpu(item) for item in value]
    return value


def _atomic_torch_save(value: object, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(_cpu(value), temporary)
    temporary.replace(path)


def train_extractor(
    manifest: Path, artifacts_root: Path, model_version: str, epochs: int, batch_size: int,
    learning_rate: float, workers: int, pretrained: bool, resume: Path | None,
    device_name: str, seed: int, cuda_index: int | None, max_batches: int | None = None,
    patience: int = 20,
) -> dict[str, Any]:
    from .extraction_training import train
    return train(manifest, artifacts_root, model_version, epochs, batch_size, learning_rate,
                 workers, pretrained, resume, device_name, seed, cuda_index, max_batches, patience)


def _load_model(checkpoint_path: Path, device: torch.device) -> tuple[dict[str, Any], nn.Module]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if checkpoint.get("artifact_schema_version") not in (1, EXTRACTION_ARTIFACT_SCHEMA):
        raise ValueError("Unsupported extraction checkpoint schema")
    if checkpoint.get("architecture") == "mobilenetv3-small-extractor":
        if checkpoint.get("input_size") != 192:
            raise ValueError("Legacy extractor must use its original 192px contract")
        model = LegacyCardExtractor().to(device)
    elif checkpoint.get("architecture") == ARCHITECTURE and checkpoint.get("input_size") == MODEL_INPUT_SIZE:
        model = CardExtractor().to(device)
    else:
        raise ValueError("Unsupported extraction architecture or input size")
    model.load_state_dict(checkpoint["model_state"]); model.eval()
    return checkpoint, model


def _quad_valid(corners: Sequence[dict[str, float]]) -> bool:
    try:
        _validate_quad(corners)
        return True
    except ValueError:
        return False


def _project_points(coefficients: Sequence[float], points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    a, b, c, d, e, f, g, h = coefficients
    projected = []
    for x, y in points:
        denominator = g * x + h * y + 1.0
        if not math.isfinite(denominator) or abs(denominator) < 1e-9:
            raise ValueError("Predicted homography is singular")
        projected.append(((a * x + b * y + c) / denominator,
                          (d * x + e * y + f) / denominator))
    return projected


def evaluate_extractor(
    manifest: Path, checkpoint_path: Path, output_root: Path, device_name: str,
    batch_size: int, workers: int, cuda_index: int | None,
    baseline_checkpoint: Path | None = None,
) -> dict[str, Any]:
    from .extraction_evaluation import evaluate
    return evaluate(manifest, checkpoint_path, output_root, device_name, batch_size,
                    workers, cuda_index, baseline_checkpoint)


def rectify_extractor(
    checkpoint_path: Path,
    thresholds_path: Path,
    image_path: Path,
    output_root: Path,
    device_name: str,
    cuda_index: int | None,
) -> dict[str, Any]:
    thresholds = json.loads(thresholds_path.read_text(encoding="utf-8"))
    device = _device(device_name, cuda_index)
    checkpoint, model = _load_model(checkpoint_path, device)
    if thresholds.get("model_version") != checkpoint.get("model_version"):
        raise ValueError("Extraction thresholds do not match checkpoint")
    with Image.open(image_path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    input_size = int(checkpoint["input_size"])
    tensor, _ = letterbox(image, input_size=input_size,
                          mean=checkpoint.get("normalization_mean", NORMALIZE_MEAN),
                          std=checkpoint.get("normalization_std", NORMALIZE_STD))
    with torch.inference_mode():
        predicted, logits = model(tensor.unsqueeze(0).to(device))
    probability = float(torch.sigmoid(logits)[0].cpu())
    corners = unletterbox(predicted[0].cpu().tolist(), image.width, image.height, input_size)
    valid = _quad_valid(corners)
    accepted = probability >= thresholds["presence_threshold"] and valid
    output_root.mkdir(parents=True, exist_ok=True)
    overlay = image.copy(); draw = ImageDraw.Draw(overlay)
    pixels = [(point["x"] * (image.width - 1), point["y"] * (image.height - 1)) for point in corners]
    draw.line([*pixels, pixels[0]], fill=(0, 220, 255), width=max(2, image.width // 200))
    for index, point in enumerate(pixels):
        draw.ellipse((point[0] - 5, point[1] - 5, point[0] + 5, point[1] + 5), fill=(0, 220, 255))
        draw.text((point[0] + 7, point[1] + 2), CORNER_ORDER[index], fill=(255, 255, 255))
    ground_truth = None
    sidecar_path = image_path.with_name(f"{image_path.stem}._annotations.json")
    if sidecar_path.is_file():
        try:
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
            if sidecar.get("CardPresent") and sidecar.get("CornerOrder") == list(CORNER_ORDER):
                ground_truth = [{"x": float(sidecar[name]["X"]), "y": float(sidecar[name]["Y"])} for name in CORNER_ORDER]
                ground_truth_pixels = [(point["x"] * (image.width - 1), point["y"] * (image.height - 1)) for point in ground_truth]
                draw.line([*ground_truth_pixels, ground_truth_pixels[0]], fill=(255, 90, 90), width=max(2, image.width // 200))
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            ground_truth = None
    overlay.save(output_root / "overlay.jpg", quality=93)
    if accepted:
        destination = [(0.0, 0.0), (RECTIFIED_WIDTH - 1.0, 0.0),
                       (RECTIFIED_WIDTH - 1.0, RECTIFIED_HEIGHT - 1.0), (0.0, RECTIFIED_HEIGHT - 1.0)]
        coefficients = _homography_coefficients(destination, pixels)
        rectified = image.transform((RECTIFIED_WIDTH, RECTIFIED_HEIGHT), Image.Transform.PERSPECTIVE,
                                    coefficients, Image.Resampling.BICUBIC)
        rectified.save(output_root / "rectified.jpg", quality=95)
        crop_bounds = (round(RECTIFIED_WIDTH * 0.08), round(RECTIFIED_HEIGHT * 0.11),
                       round(RECTIFIED_WIDTH * 0.92), round(RECTIFIED_HEIGHT * 0.49))
        crop = rectified.crop(crop_bounds).resize((224, 224), Image.Resampling.BICUBIC)
        crop.save(output_root / "recognition-crop-v1.jpg", quality=95)
        rectified_overlay = rectified.copy()
        ImageDraw.Draw(rectified_overlay).rectangle(crop_bounds, outline=(0, 220, 255), width=3)
        rectified_overlay.save(output_root / "rectified-with-identity-crop.jpg", quality=95)
    rejection_reason = None if accepted else ("presence_below_threshold" if probability < thresholds["presence_threshold"] else "invalid_quadrilateral")
    result = {"diagnostic_schema_version": 1, "model_version": checkpoint["model_version"],
              "input_size": input_size, "calibrated": thresholds.get("calibrated", True),
              "calibration_provisional": thresholds.get("calibration_provisional", False),
              "calibration_status": thresholds.get("calibration_status"),
              "image": image_path.name, "presence_probability": probability,
              "presence_threshold": thresholds["presence_threshold"], "accepted": accepted,
              "geometry_valid": valid, "geometry_rejection_reason": rejection_reason,
              "corners": corners, "ground_truth_corners": ground_truth,
              "rectified": "rectified.jpg" if accepted else None,
              "recognition_crop": "recognition-crop-v1.jpg" if accepted else None}
    _write_json(output_root / "diagnostic.json", result)
    emit("extraction_rectified", **result)
    return result
