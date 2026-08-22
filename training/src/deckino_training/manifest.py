from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from collections import defaultdict
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Iterable

from PIL import Image, UnidentifiedImageError

MANIFEST_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ManifestRecord:
    dataset_version: str
    image_path: str
    oracle_id: str
    printing_id: str
    card_name: str
    split: str


@dataclass(frozen=True)
class PreparationReport:
    dataset_version: str
    eligible: int
    copied: int
    classes: int
    train: int
    validation: int
    excluded_no_oracle: int
    excluded_not_downloaded: int
    excluded_missing: int
    excluded_corrupt: int


def _stable_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sanitize_windows_filename(value: str) -> str:
    invalid = '<>:"/\\|?*'
    return "".join("_" if character in invalid or ord(character) < 32 else character for character in value)


def _write_json(path: Path, value: object) -> None:
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


def validate_manifest(path: Path) -> tuple[list[ManifestRecord], Path]:
    records = read_manifest(path)
    root = path.parent
    missing = [record.image_path for record in records if not (root / record.image_path).is_file()]
    if missing:
        preview = ", ".join(missing[:3])
        raise ValueError(f"Manifest references {len(missing)} missing files; first: {preview}")
    return records, root


def prepare_dataset(
    data_root: Path,
    output_root: Path,
    dataset_version: str,
    max_classes: int | None = None,
) -> PreparationReport:
    data_root = data_root.resolve()
    output_root = output_root.resolve()
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
        if "oracle_id" not in columns:
            raise ValueError("Database is missing cards.oracle_id; run Deckino.Tools once to apply migrations")

        excluded_no_oracle = connection.execute(
            "SELECT COUNT(*) FROM cards WHERE art_crop_uri IS NOT NULL AND oracle_id IS NULL"
        ).fetchone()[0]
        excluded_not_downloaded = connection.execute(
            """
            SELECT COUNT(*)
            FROM cards c
            LEFT JOIN art_downloads d ON d.scryfall_id = c.scryfall_id
            WHERE c.oracle_id IS NOT NULL
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
            WHERE c.oracle_id IS NOT NULL
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
    for row in rows:
        source = Path(row["file_path"])
        if not source.is_file():
            source = (
                data_root
                / "cards"
                / _sanitize_windows_filename(row["set_code"])
                / f"{_sanitize_windows_filename(row['collector_number'])}.jpg"
            )
        if not source.is_file():
            excluded_missing += 1
            continue
        try:
            with Image.open(source) as image:
                image.verify()
        except (OSError, UnidentifiedImageError):
            excluded_corrupt += 1
            continue
        candidates.append((row, source.resolve()))

    grouped: dict[str, list[tuple[sqlite3.Row, Path]]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate[0]["oracle_id"]].append(candidate)
    selected_ids = sorted(grouped)
    if max_classes is not None:
        selected_ids = selected_ids[:max_classes]
    if len(selected_ids) < 2:
        raise ValueError(
            "Fewer than two oracle classes are eligible. Re-run Scryfall sync after the oracle migration."
        )

    source_records: list[ManifestRecord] = []
    prepared_records: list[ManifestRecord] = []
    images_root = output_root / "images"
    images_root.mkdir(parents=True, exist_ok=True)
    for oracle_id in selected_ids:
        entries = sorted(grouped[oracle_id], key=lambda item: _stable_key(item[0]["scryfall_id"]))
        validation_printing = entries[0][0]["scryfall_id"] if len(entries) >= 2 else None
        for row, source in entries:
            split = "validation" if row["scryfall_id"] == validation_printing else "train"
            try:
                source_relative = source.relative_to(data_root).as_posix()
            except ValueError:
                source_relative = f"cards-external/{row['scryfall_id']}{source.suffix.lower()}"
            source_records.append(
                ManifestRecord(
                    dataset_version=dataset_version,
                    image_path=source_relative,
                    oracle_id=oracle_id,
                    printing_id=row["scryfall_id"],
                    card_name=row["name"],
                    split=split,
                )
            )
            destination_relative = Path("images") / f"{row['scryfall_id']}{source.suffix.lower()}"
            destination = output_root / destination_relative
            shutil.copy2(source, destination)
            prepared_records.append(
                replace(source_records[-1], image_path=destination_relative.as_posix())
            )

    source_records.sort(key=lambda item: (item.oracle_id, item.printing_id))
    prepared_records.sort(key=lambda item: (item.oracle_id, item.printing_id))
    source_export = data_root / "exports" / dataset_version
    write_manifest(source_export / "manifest.jsonl", source_records)
    write_manifest(output_root / "manifest.jsonl", prepared_records)

    labels = [
        {
            "index": index,
            "oracle_id": oracle_id,
            "card_name": sorted(grouped[oracle_id], key=lambda item: item[0]["scryfall_id"])[0][0]["name"],
        }
        for index, oracle_id in enumerate(selected_ids)
    ]
    metadata = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "dataset_version": dataset_version,
        "classes": len(labels),
        "records": len(prepared_records),
    }
    _write_json(source_export / "metadata.json", metadata)
    _write_json(output_root / "metadata.json", metadata)
    _write_json(output_root / "labels.json", {**metadata, "labels": labels})

    report = PreparationReport(
        dataset_version=dataset_version,
        eligible=len(candidates),
        copied=len(prepared_records),
        classes=len(labels),
        train=sum(record.split == "train" for record in prepared_records),
        validation=sum(record.split == "validation" for record in prepared_records),
        excluded_no_oracle=excluded_no_oracle,
        excluded_not_downloaded=excluded_not_downloaded,
        excluded_missing=excluded_missing,
        excluded_corrupt=excluded_corrupt,
    )
    _write_json(source_export / "report.json", asdict(report))
    _write_json(output_root / "report.json", asdict(report))
    return report
