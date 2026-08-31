from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


class CardDataMigrationTests(unittest.TestCase):
    def test_legacy_database_backfills_identity_and_paper_availability(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        schema_root = repository_root / "Deckino.Toolbox" / "Data" / "Schema"
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "deckino.db"
            with closing(sqlite3.connect(database_path)) as connection:
                connection.executescript((schema_root / "001_baseline.sql").read_text(encoding="utf-8"))
                connection.executescript((schema_root / "002_sync_state.sql").read_text(encoding="utf-8"))
                connection.execute(
                    "INSERT INTO sync_state VALUES ('unique_artwork', 'remote-version', 'now')"
                )
                connection.executescript(
                    (schema_root / "003_oracle_identity.sql").read_text(encoding="utf-8")
                )
                connection.execute(
                    "INSERT INTO sync_state VALUES ('unique_artwork', 'remote-version', 'now')"
                )
                connection.executescript(
                    (schema_root / "004_paper_availability.sql").read_text(encoding="utf-8")
                )

                columns = {
                    row[1] for row in connection.execute("PRAGMA table_info(cards)").fetchall()
                }
                foreign_keys = connection.execute("PRAGMA foreign_key_list(cards)").fetchall()
                unique_sync = connection.execute(
                    "SELECT COUNT(*) FROM sync_state WHERE bulk_type = 'unique_artwork'"
                ).fetchone()[0]

            self.assertIn("oracle_id", columns)
            self.assertIn("is_paper", columns)
            self.assertTrue(any(row[2] == "oracle_cards" and row[3] == "oracle_id" for row in foreign_keys))
            self.assertEqual(unique_sync, 0)


if __name__ == "__main__":
    unittest.main()
