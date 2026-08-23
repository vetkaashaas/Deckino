ALTER TABLE cards
ADD COLUMN is_paper INTEGER NOT NULL DEFAULT 0
CHECK (is_paper IN (0, 1));

CREATE INDEX IF NOT EXISTS ix_cards_is_paper ON cards (is_paper);

-- Existing databases need one unique-artwork reimport to populate availability.
DELETE FROM sync_state WHERE bulk_type = 'unique_artwork';
