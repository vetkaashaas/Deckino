ALTER TABLE cards
ADD COLUMN oracle_id TEXT REFERENCES oracle_cards (oracle_id);

CREATE INDEX IF NOT EXISTS ix_cards_oracle_id ON cards (oracle_id);

-- Existing databases need one unique-artwork reimport to backfill the new column.
DELETE FROM sync_state WHERE bulk_type = 'unique_artwork';
