-- Recognition references and extraction scenes both come from Scryfall's full-card image of each face, cut
-- with the phone's crop box, so art crops and the separate extraction asset table are gone.
DROP TABLE IF EXISTS art_downloads;
DROP TABLE IF EXISTS extraction_full_card_assets;
ALTER TABLE cards DROP COLUMN art_crop_uri;

CREATE TABLE IF NOT EXISTS card_images (
  image_id        TEXT PRIMARY KEY,
  scryfall_id     TEXT NOT NULL REFERENCES cards (scryfall_id),
  face_index      INTEGER NOT NULL,
  illustration_id TEXT,
  image_uri       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'downloaded', 'failed')),
  file_path       TEXT,
  file_bytes      INTEGER,
  error           TEXT,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_card_images_status ON card_images (status);
CREATE INDEX IF NOT EXISTS ix_card_images_scryfall ON card_images (scryfall_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  summary     TEXT NOT NULL
);
