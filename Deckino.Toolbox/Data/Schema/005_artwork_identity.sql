ALTER TABLE cards
ADD COLUMN illustration_id TEXT;

CREATE INDEX IF NOT EXISTS ix_cards_illustration_id ON cards (illustration_id);

-- Reimport metadata so existing image rows receive their Scryfall illustration ID.
DELETE FROM sync_state WHERE bulk_type = 'unique_artwork';
