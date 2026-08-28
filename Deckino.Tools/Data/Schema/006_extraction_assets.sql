CREATE TABLE IF NOT EXISTS extraction_full_card_assets (
  asset_id     TEXT PRIMARY KEY,
  scryfall_id  TEXT NOT NULL REFERENCES cards (scryfall_id),
  face_index   INTEGER NOT NULL,
  normal_uri   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'downloaded', 'failed')),
  file_path    TEXT,
  file_bytes   INTEGER,
  image_width  INTEGER,
  image_height INTEGER,
  sha256       TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_extraction_full_card_assets_status
  ON extraction_full_card_assets (status);

CREATE INDEX IF NOT EXISTS ix_extraction_full_card_assets_scryfall
  ON extraction_full_card_assets (scryfall_id);
