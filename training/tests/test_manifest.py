from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from PIL import Image

from deckino_training.manifest import MANIFEST_SCHEMA_VERSION, prepare_dataset, read_manifest, validate_manifest


class PrepareDatasetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.data_root = self.root / "data"
        self.data_root.mkdir()
        self.database_path = self.data_root / "deckino.db"
        with closing(sqlite3.connect(self.database_path)) as connection:
            connection.executescript(
                """
                CREATE TABLE cards (
                  scryfall_id TEXT PRIMARY KEY,
                  oracle_id TEXT,
                  is_paper INTEGER NOT NULL,
                  name TEXT NOT NULL,
                  set_code TEXT NOT NULL,
                  collector_number TEXT NOT NULL,
                  art_crop_uri TEXT
                );
                CREATE TABLE art_downloads (
                  scryfall_id TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  file_path TEXT
                );
                """
            )
            connection.commit()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _add(
        self,
        printing: str,
        oracle: str | None,
        status: str,
        kind: str = "valid",
        is_paper: bool = True,
    ) -> None:
        image = self.data_root / "cards" / "tst" / f"{printing}.jpg"
        image.parent.mkdir(parents=True, exist_ok=True)
        if kind == "valid":
            Image.new("RGB", (24, 24), (50, 100, 150)).save(image)
        elif kind == "corrupt":
            image.write_bytes(b"not a jpeg")
        elif kind == "missing":
            image = image.with_name("does-not-exist.jpg")
        with closing(sqlite3.connect(self.database_path)) as connection:
            connection.execute(
                "INSERT INTO cards VALUES (?, ?, ?, ?, 'tst', ?, 'https://example.invalid/art.jpg')",
                (printing, oracle, int(is_paper), f"Card {oracle}", printing),
            )
            connection.execute(
                "INSERT INTO art_downloads VALUES (?, ?, ?)",
                (printing, status, str(image)),
            )
            connection.commit()

    def test_prepare_is_deterministic_and_reports_exclusions(self) -> None:
        self._add("a1", "oracle-a", "downloaded")
        self._add("a2", "oracle-a", "downloaded")
        self._add("b1", "oracle-b", "downloaded")
        self._add("c1", "oracle-c", "downloaded")
        self._add("c2", "oracle-c", "downloaded")
        self._add("no-oracle", None, "downloaded")
        self._add("pending", "oracle-d", "pending")
        self._add("missing", "oracle-e", "downloaded", "missing")
        self._add("corrupt", "oracle-f", "downloaded", "corrupt")
        self._add("digital", "oracle-digital", "downloaded", is_paper=False)

        first_report = prepare_dataset(self.data_root, "test-v1")
        manifest = self.data_root / "exports" / "test-v1" / "manifest.jsonl"
        first_manifest = manifest.read_bytes()
        second_report = prepare_dataset(self.data_root, "test-v1")

        self.assertEqual(first_report, second_report)
        self.assertEqual(first_report.classes, 3)
        self.assertEqual(first_report.train, 3)
        self.assertEqual(first_report.validation, 3)
        self.assertEqual(first_report.held_out_artwork, 2)
        self.assertEqual(first_report.synthetic_views, 1)
        self.assertEqual(first_report.referenced_images, 5)
        self.assertEqual(first_report.records, 6)
        self.assertEqual(first_report.excluded_not_paper, 1)
        self.assertEqual(first_report.excluded_no_oracle, 1)
        self.assertEqual(first_report.excluded_not_downloaded, 1)
        self.assertEqual(first_report.excluded_missing, 1)
        self.assertEqual(first_report.excluded_corrupt, 1)
        self.assertEqual(
            first_manifest,
            manifest.read_bytes(),
        )
        records, root = validate_manifest(manifest)
        self.assertEqual(len(records), 6)
        self.assertEqual(
            {record.oracle_id for record in records if record.split == "validation"},
            {"oracle-a", "oracle-b", "oracle-c"},
        )
        self.assertEqual(root, self.data_root.resolve())
        metadata = __import__("json").loads((manifest.parent / "metadata.json").read_text())
        self.assertEqual(metadata["schema_version"], MANIFEST_SCHEMA_VERSION)
        self.assertEqual(metadata["image_root"], "../..")
        self.assertFalse((self.data_root / "exports" / "test-v1" / "images").exists())

        source_manifest = self.data_root / "exports" / "test-v1" / "manifest.jsonl"
        source_records = read_manifest(source_manifest)
        self.assertTrue(all(not Path(record.image_path).is_absolute() for record in source_records))

    def test_prepare_requires_oracle_migration(self) -> None:
        with closing(sqlite3.connect(self.database_path)) as connection:
            connection.execute("ALTER TABLE cards RENAME TO cards_old")
            connection.execute(
                """
                CREATE TABLE cards (
                  scryfall_id TEXT PRIMARY KEY,
                  name TEXT,
                  set_code TEXT,
                  collector_number TEXT,
                  art_crop_uri TEXT
                )
                """
            )
            connection.commit()
        with self.assertRaisesRegex(ValueError, "cards.oracle_id"):
            prepare_dataset(self.data_root, "test-v1")

    def test_rejects_manifest_without_schema_v3_metadata(self) -> None:
        manifest = self.root / "legacy" / "manifest.jsonl"
        manifest.parent.mkdir()
        manifest.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Schema v1/v2"):
            validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
