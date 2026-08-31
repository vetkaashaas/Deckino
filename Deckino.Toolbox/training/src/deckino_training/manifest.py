from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable

from PIL import Image, UnidentifiedImageError

MANIFEST_SCHEMA_VERSION = 3

TRAINING_VIEW = "training"
HELD_OUT_ARTWORK = "held_out_artwork"
SYNTHETIC_VIEW = "synthetic_view"
REAL_CAMERA = "real_camera"


@dataclass(frozen=True)
class ManifestRecord:
    dataset_version: str
    image_path: str
    oracle_id: str
    printing_id: str
    card_name: str
    split: str
    validation_kind: str = TRAINING_VIEW
    augmentation_seed: int | None = None
    input_kind: str = "art"
    camera_version: str | None = None
    capture_condition: str | None = None


@dataclass(frozen=True)
class PreparationReport:
    schema_version: int
    dataset_version: str
    eligible_images: int
    referenced_images: int
    records: int
    classes: int
    train: int
    validation: int
    held_out_artwork: int
    synthetic_views: int
    excluded_not_paper: int
    excluded_no_oracle: int
    excluded_not_downloaded: int
    excluded_missing: int
    excluded_corrupt: int


def _stable_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stable_seed(value: str) -> int:
    return int(_stable_key(value)[:15], 16)


def _sanitize_windows_filename(value: str) -> str:
    invalid = '<>:"/\\|?*'
    return "".join(
        "_" if character in invalid or ord(character) < 32 else character
        for character in value
    )


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_manifest(path: Path, records: Iterable[ManifestRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for record in records:
            stream.write(json.dumps(asdict(record), ensure_ascii=False, sort_keys=True))
            stream.write("\n")


def read_manifest(path: Path) -> list[ManifestRecord]:
    records: list[ManifestRecord] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                records.append(ManifestRecord(**json.loads(line)))
            except (TypeError, json.JSONDecodeError) as error:
                raise ValueError(f"Invalid manifest row {line_number}: {error}") from error
    if not records:
        raise ValueError(f"Manifest is empty: {path}")
    versions = {record.dataset_version for record in records}
    if len(versions) != 1:
        raise ValueError(f"Manifest contains multiple dataset versions: {sorted(versions)}")
    return records


def validate_manifest(
    path: Path, *, check_images: bool = True
) -> tuple[list[ManifestRecord], Path]:
    metadata_path = path.parent / "metadata.json"
    if not metadata_path.is_file():
        raise ValueError(
            f"Manifest metadata is missing: {metadata_path}. "
            "Schema v1/v2 manifests are not supported; run prepare again."
        )
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid manifest metadata: {metadata_path}") from error
    schema_version = metadata.get("schema_version")
    if schema_version != MANIFEST_SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported manifest schema {schema_version!r}; expected "
            f"{MANIFEST_SCHEMA_VERSION}. DirectML-era artifacts must be prepared again."
        )
    image_root = metadata.get("image_root")
    if not isinstance(image_root, str) or not image_root.strip():
        raise ValueError("Manifest metadata.image_root must be a non-empty relative path")
    declared_root = Path(image_root)
    if declared_root.is_absolute():
        raise ValueError("Manifest metadata.image_root must be relative")
    records = read_manifest(path)
    if metadata.get("dataset_version") != records[0].dataset_version:
        raise ValueError("Manifest metadata dataset version does not match its records")
    root = (path.parent / declared_root).resolve()
    if check_images:
        missing = sorted(
            {
                record.image_path
                for record in records
                if not (root / record.image_path).is_file()
            }
        )
        if missing:
            preview = ", ".join(missing[:3])
            raise ValueError(f"Manifest references {len(missing)} missing files; first: {preview}")
    return records, root


def _source_path(data_root: Path, row: sqlite3.Row) -> Path:
    stored = Path(row["file_path"])
    if stored.is_file():
        return stored.resolve()
    return (
        data_root
        / "cards"
        / _sanitize_windows_filename(row["set_code"])
        / f"{_sanitize_windows_filename(row['collector_number'])}.jpg"
    ).resolve()


def _logical_record(
    dataset_version: str,
    image_path: str,
    row: sqlite3.Row,
    split: str,
    validation_kind: str,
    augmentation_seed: int | None,
) -> ManifestRecord:
    return ManifestRecord(
        dataset_version=dataset_version,
        image_path=image_path,
        oracle_id=row["oracle_id"],
        printing_id=row["scryfall_id"],
        card_name=row["name"],
        split=split,
        validation_kind=validation_kind,
        augmentation_seed=augmentation_seed,
    )


def prepare_dataset(
    data_root: Path,
    dataset_version: str,
    max_classes: int | None = None,
    progress: Callable[[int, int, int, int], None] | None = None,
) -> PreparationReport:
    data_root = data_root.resolve()
    database_path = data_root / "deckino.db"
    if not database_path.is_file():
        raise FileNotFoundError(f"Deckino database not found: {database_path}")
    if not dataset_version.strip():
        raise ValueError("dataset_version must not be blank")
    if max_classes is not None and max_classes < 2:
        raise ValueError("max_classes must be at least 2")

    connection = sqlite3.connect(f"file:{database_path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(cards)")}
        missing_columns = {"oracle_id", "is_paper"} - columns
        if missing_columns:
            missing = ", ".join(f"cards.{name}" for name in sorted(missing_columns))
            raise ValueError(f"Database is missing {missing}; run Deckino.Toolbox to apply migrations")

        excluded_not_paper = connection.execute(
            """
            SELECT COUNT(*) FROM cards
            WHERE art_crop_uri IS NOT NULL AND oracle_id IS NOT NULL AND is_paper = 0
            """
        ).fetchone()[0]
        excluded_no_oracle = connection.execute(
            """
            SELECT COUNT(*) FROM cards
            WHERE art_crop_uri IS NOT NULL AND oracle_id IS NULL AND is_paper = 1
            """
        ).fetchone()[0]
        excluded_not_downloaded = connection.execute(
            """
            SELECT COUNT(*)
            FROM cards c
            LEFT JOIN art_downloads d ON d.scryfall_id = c.scryfall_id
            WHERE c.is_paper = 1
              AND c.oracle_id IS NOT NULL
              AND c.art_crop_uri IS NOT NULL
              AND (d.status IS NULL OR d.status <> 'downloaded' OR d.file_path IS NULL)
            """
        ).fetchone()[0]
        rows = connection.execute(
            """
            SELECT c.scryfall_id, c.oracle_id, c.name, c.set_code,
                   c.collector_number, d.file_path
            FROM cards c
            JOIN art_downloads d ON d.scryfall_id = c.scryfall_id
            WHERE c.is_paper = 1
              AND c.oracle_id IS NOT NULL
              AND c.art_crop_uri IS NOT NULL
              AND d.status = 'downloaded'
              AND d.file_path IS NOT NULL
            ORDER BY c.oracle_id, c.scryfall_id
            """
        ).fetchall()
    finally:
        connection.close()

    candidates: list[tuple[sqlite3.Row, Path]] = []
    excluded_missing = 0
    excluded_corrupt = 0
    total_rows = len(rows)
    for row_index, row in enumerate(rows, 1):
        source = _source_path(data_root, row)
        if not source.is_file():
            excluded_missing += 1
        else:
            try:
                with Image.open(source) as image:
                    image.verify()
            except (OSError, UnidentifiedImageError):
                excluded_corrupt += 1
            else:
                candidates.append((row, source))
        if progress is not None and (row_index == total_rows or row_index % 500 == 0):
            progress(row_index, total_rows, excluded_missing, excluded_corrupt)

    grouped: dict[str, list[tuple[sqlite3.Row, Path]]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate[0]["oracle_id"]].append(candidate)
    selected_ids = sorted(grouped)
    if max_classes is not None:
        selected_ids = selected_ids[:max_classes]
    if len(selected_ids) < 2:
        raise ValueError(
            "Fewer than two paper oracle classes are eligible. Re-run Scryfall sync after migration."
        )
    selected_image_count = sum(len(grouped[oracle_id]) for oracle_id in selected_ids)

    records: list[ManifestRecord] = []
    for oracle_id in selected_ids:
        entries = sorted(
            grouped[oracle_id], key=lambda item: _stable_key(item[0]["scryfall_id"])
        )
        for entry_index, (row, source) in enumerate(entries):
            try:
                source_relative = source.relative_to(data_root).as_posix()
            except ValueError as error:
                raise ValueError(f"Cached image is outside the data root: {source}") from error

            if len(entries) >= 2 and entry_index == 0:
                logical_views = [
                    (
                        "validation",
                        HELD_OUT_ARTWORK,
                        stable_seed(f"{row['scryfall_id']}:held-out"),
                    )
                ]
            else:
                logical_views = [("train", TRAINING_VIEW, None)]
                if len(entries) == 1:
                    logical_views.append(
                        (
                            "validation",
                            SYNTHETIC_VIEW,
                            stable_seed(f"{row['scryfall_id']}:synthetic"),
                        )
                    )

            for split, validation_kind, seed in logical_views:
                records.append(_logical_record(
                    dataset_version,
                    source_relative,
                    row,
                    split,
                    validation_kind,
                    seed,
                ))

    def sort_key(item: ManifestRecord) -> tuple[str, str, str, str]:
        return item.oracle_id, item.printing_id, item.split, item.validation_kind

    records.sort(key=sort_key)
    export_root = data_root / "exports" / dataset_version
    write_manifest(export_root / "manifest.jsonl", records)

    labels = [
        {
            "index": index,
            "oracle_id": oracle_id,
            "card_name": sorted(
                grouped[oracle_id], key=lambda item: item[0]["scryfall_id"]
            )[0][0]["name"],
        }
        for index, oracle_id in enumerate(selected_ids)
    ]
    metadata = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "dataset_version": dataset_version,
        "classes": len(labels),
        "records": len(records),
        "images": selected_image_count,
        "image_root": "../..",
    }
    write_json(export_root / "metadata.json", metadata)
    write_json(export_root / "labels.json", {**metadata, "labels": labels})

    report = PreparationReport(
        schema_version=MANIFEST_SCHEMA_VERSION,
        dataset_version=dataset_version,
        eligible_images=len(candidates),
        referenced_images=selected_image_count,
        records=len(records),
        classes=len(labels),
        train=sum(record.split == "train" for record in records),
        validation=sum(record.split == "validation" for record in records),
        held_out_artwork=sum(
            record.validation_kind == HELD_OUT_ARTWORK for record in records
        ),
        synthetic_views=sum(
            record.validation_kind == SYNTHETIC_VIEW for record in records
        ),
        excluded_not_paper=excluded_not_paper,
        excluded_no_oracle=excluded_no_oracle,
        excluded_not_downloaded=excluded_not_downloaded,
        excluded_missing=excluded_missing,
        excluded_corrupt=excluded_corrupt,
    )
    write_json(export_root / "report.json", asdict(report))
    return report
