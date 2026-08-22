from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from PIL import Image

from deckino_training.manifest import prepare_dataset, read_manifest, validate_manifest


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

    def _add(self, printing: str, oracle: str | None, status: str, kind: str = "valid") -> None:
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
                "INSERT INTO cards VALUES (?, ?, ?, 'tst', ?, 'https://example.invalid/art.jpg')",
                (printing, oracle, f"Card {oracle}", printing),
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

        first_output = self.root / "prepared-one"
        second_output = self.root / "prepared-two"
        first_report = prepare_dataset(self.data_root, first_output, "test-v1")
        second_report = prepare_dataset(self.data_root, second_output, "test-v1")

        self.assertEqual(first_report, second_report)
        self.assertEqual(first_report.classes, 3)
        self.assertEqual(first_report.train, 3)
        self.assertEqual(first_report.validation, 2)
        self.assertEqual(first_report.excluded_no_oracle, 1)
        self.assertEqual(first_report.excluded_not_downloaded, 1)
        self.assertEqual(first_report.excluded_missing, 1)
        self.assertEqual(first_report.excluded_corrupt, 1)
        self.assertEqual(
            (first_output / "manifest.jsonl").read_bytes(),
            (second_output / "manifest.jsonl").read_bytes(),
        )
        records, root = validate_manifest(first_output / "manifest.jsonl")
        self.assertEqual(len(records), 5)
        self.assertEqual(root, first_output)

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
            prepare_dataset(self.data_root, self.root / "prepared", "test-v1")


if __name__ == "__main__":
    unittest.main()
