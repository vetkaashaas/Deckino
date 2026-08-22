CREATE TABLE IF NOT EXISTS sets (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  card_count   INTEGER,
  released_at  TEXT
);

CREATE TABLE IF NOT EXISTS cards (
  scryfall_id      TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  set_code         TEXT NOT NULL REFERENCES sets (code),
  collector_number TEXT NOT NULL,
  layout           TEXT,
  released_at      TEXT,
  art_crop_uri     TEXT
);

CREATE INDEX IF NOT EXISTS ix_cards_set_code ON cards (set_code);
CREATE INDEX IF NOT EXISTS ix_cards_name     ON cards (name);

CREATE TABLE IF NOT EXISTS oracle_cards (
  oracle_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mana_cost   TEXT,
  type_line   TEXT,
  oracle_text TEXT
);

CREATE INDEX IF NOT EXISTS ix_oracle_cards_name ON oracle_cards (name);

CREATE TABLE IF NOT EXISTS art_downloads (
  scryfall_id TEXT PRIMARY KEY REFERENCES cards (scryfall_id),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'downloaded', 'failed')),
  file_path   TEXT,
  file_bytes  INTEGER,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_art_downloads_status ON art_downloads (status);
