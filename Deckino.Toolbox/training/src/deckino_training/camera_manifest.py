from __future__ import annotations

import json
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .manifest import (
    MANIFEST_SCHEMA_VERSION,
    REAL_CAMERA,
    ManifestRecord,
    stable_seed,
    validate_manifest,
    write_json,
    write_manifest,
)

CAPTURE_CONDITIONS = ("normal", "glare", "low_light", "perspective", "alternate")
REQUIRED_TRAITS = {"foil", "borderless", "unusual_layout"}
ALLOWED_TRAITS = REQUIRED_TRAITS | {"standard", "dark_art"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(frozen=True)
class CameraPreparationReport:
    schema_version: int
    dataset_version: str
    camera_version: str
    cards: int
    captures: int
    traits: list[str]


def _load_capture_metadata(path: Path) -> set[str]:
    if not path.is_file():
        raise ValueError(f"Capture metadata is missing: {path}")
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
        traits = set(values["traits"])
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid capture metadata: {path}") from error
    unknown = traits - ALLOWED_TRAITS
    if unknown:
        raise ValueError(f"Unsupported capture traits in {path}: {sorted(unknown)}")
    if not traits:
        raise ValueError(f"Capture metadata must declare at least one trait: {path}")
    return traits


def _condition_files(card_directory: Path) -> dict[str, Path]:
    images = [
        path
        for path in card_directory.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]
    by_condition: dict[str, Path] = {}
    for path in images:
        if path.stem not in CAPTURE_CONDITIONS:
            raise ValueError(
                f"Unexpected capture filename {path.name}; expected one file per condition"
            )
        if path.stem in by_condition:
            raise ValueError(f"Duplicate {path.stem} capture in {card_directory}")
        by_condition[path.stem] = path
    missing = sorted(set(CAPTURE_CONDITIONS) - set(by_condition))
    if missing:
        raise ValueError(f"Missing captures in {card_directory}: {missing}")
    return by_condition


def prepare_camera_manifest(
    input_root: Path,
    output_root: Path,
    dataset_manifest: Path,
    camera_version: str,
    minimum_cards: int = 30,
) -> CameraPreparationReport:
    input_root = input_root.resolve()
    output_root = output_root.resolve()
    if not input_root.is_dir():
        raise FileNotFoundError(f"Camera capture directory not found: {input_root}")
    if not camera_version.strip():
        raise ValueError("camera_version must not be blank")

    dataset_records, _ = validate_manifest(dataset_manifest)
    dataset_version = dataset_records[0].dataset_version
    names: dict[str, str] = {}
    for record in dataset_records:
        names.setdefault(record.oracle_id, record.card_name)

    card_directories = sorted(path for path in input_root.iterdir() if path.is_dir())
    if len(card_directories) < minimum_cards:
        raise ValueError(
            f"Camera set has {len(card_directories)} cards; at least {minimum_cards} are required"
        )

    records: list[ManifestRecord] = []
    all_traits: set[str] = set()
    for card_directory in card_directories:
        oracle_id = card_directory.name
        if oracle_id not in names:
            raise ValueError(f"Camera set contains an oracle ID absent from the dataset: {oracle_id}")
        all_traits.update(_load_capture_metadata(card_directory / "capture.json"))
        for condition, source in sorted(_condition_files(card_directory).items()):
            try:
                with Image.open(source) as image:
                    image.verify()
            except (OSError, UnidentifiedImageError) as error:
                raise ValueError(f"Invalid camera image: {source}") from error
            relative = Path("images") / oracle_id / f"{condition}{source.suffix.lower()}"
            destination = output_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            records.append(
                ManifestRecord(
                    dataset_version=dataset_version,
                    image_path=relative.as_posix(),
                    oracle_id=oracle_id,
                    printing_id=f"camera:{camera_version}:{oracle_id}:{condition}",
                    card_name=names[oracle_id],
                    split="validation",
                    validation_kind=REAL_CAMERA,
                    augmentation_seed=stable_seed(
                        f"camera:{camera_version}:{oracle_id}:{condition}"
                    ),
                    input_kind="auto",
                    camera_version=camera_version,
                    capture_condition=condition,
                )
            )

    missing_traits = REQUIRED_TRAITS - all_traits
    if missing_traits:
        raise ValueError(f"Camera set does not cover required traits: {sorted(missing_traits)}")

    records.sort(key=lambda item: (item.oracle_id, item.capture_condition or ""))
    write_manifest(output_root / "camera-manifest.jsonl", records)
    metadata = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "dataset_version": dataset_version,
        "image_root": ".",
        "camera_version": camera_version,
        "cards": len(card_directories),
        "captures": len(records),
        "traits": sorted(all_traits),
    }
    write_json(output_root / "metadata.json", metadata)
    write_json(output_root / "camera-metadata.json", metadata)
    report = CameraPreparationReport(
        schema_version=MANIFEST_SCHEMA_VERSION,
        dataset_version=dataset_version,
        camera_version=camera_version,
        cards=len(card_directories),
        captures=len(records),
        traits=sorted(all_traits),
    )
    write_json(output_root / "camera-report.json", asdict(report))
    return report
