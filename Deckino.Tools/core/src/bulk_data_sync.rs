use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use flate2::read::MultiGzDecoder;
use reqwest::Url;
use rusqlite::{OptionalExtension, Transaction, named_params};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::error::check;
use crate::scryfall::{
    ScryfallBulkDataEntryDto, ScryfallCardDto, ScryfallClient, ScryfallOracleCardDto, ensure_success_status_code,
    read_body, read_chunk,
};
use crate::sync_options::SyncOptions;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BulkSyncPhase {
    Checking,
    Downloading,
    Importing,
}

#[derive(Clone, Debug)]
pub struct BulkSyncStatus {
    pub stage: String,
    pub processed: i64,
    pub total: Option<i64>,
    pub phase: BulkSyncPhase,
}

impl BulkSyncStatus {
    fn new(stage: impl Into<String>, processed: i64, total: Option<i64>, phase: BulkSyncPhase) -> Self {
        Self { stage: stage.into(), processed, total, phase }
    }
}

/// One Scryfall bulk file as Scryfall last published it and as this computer last imported it.
#[derive(Clone, Debug)]
pub struct BulkFreshness {
    pub r#type: String,
    pub remote_updated_at: String,
    pub local_updated_at: Option<String>,
    pub synced_at: Option<String>,
}

impl BulkFreshness {
    pub fn up_to_date(&self) -> bool {
        self.local_updated_at.as_deref() == Some(self.remote_updated_at.as_str())
    }
}

#[derive(Clone, Debug)]
pub struct BulkSyncResult {
    pub cards_imported: i32,
    pub sets_upserted: i32,
    pub no_art_count: i32,
    pub oracle_cards_imported: i32,
    pub skipped_up_to_date: Vec<String>,
}

struct CardRow {
    id: String,
    oracle_id: Option<String>,
    illustration_id: Option<String>,
    is_paper: bool,
    name: String,
    set: String,
    collector: String,
    layout: Option<String>,
    released: Option<String>,
}

struct ImageRow {
    image_id: String,
    scryfall_id: String,
    face_index: i32,
    image_uri: String,
    illustration_id: Option<String>,
}

/// Per set: its name, release date and how many printings the file listed.
type SetCounts = HashMap<String, (String, Option<String>, i64)>;

pub struct BulkDataSyncService {
    database: Database,
    client: Arc<ScryfallClient>,
    options: SyncOptions,
}

impl BulkDataSyncService {
    pub fn new(database: Database, client: Arc<ScryfallClient>, options: SyncOptions) -> Self {
        Self { database, client, options }
    }

    pub async fn sync_all(
        &self,
        progress: &(dyn Fn(BulkSyncStatus) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<BulkSyncResult> {
        std::fs::create_dir_all(self.options.bulk_directory())?;

        progress(BulkSyncStatus::new("checking Scryfall", 0, None, BulkSyncPhase::Checking));
        let entries = self.get_bulk_entries(cancel).await?;
        let mut skipped = Vec::new();
        let mut cards_imported = 0;
        let mut sets_upserted = 0;
        let mut no_art = 0;
        let mut oracle_imported = 0;
        let card_image_catalog_empty = self.is_card_image_catalog_empty()?;

        // Import oracle rows first so printing rows can safely reference them.
        let oracle_cards = entries.iter().find(|e| e.r#type == "oracle_cards");
        if let Some(oracle_cards) = oracle_cards
            && !self.is_up_to_date("oracle_cards", &oracle_cards.updated_at)?
        {
            progress(BulkSyncStatus::new(
                format!("downloading {}", oracle_cards.r#type),
                0,
                None,
                BulkSyncPhase::Downloading,
            ));
            let file = self.download_to_file(oracle_cards, "oracle_cards", progress, cancel).await?;
            progress(BulkSyncStatus::new("importing oracle cards", 0, None, BulkSyncPhase::Importing));
            oracle_imported = run_blocking(|| self.import_oracle_cards(&file, progress, cancel))?;
            std::fs::remove_file(&file)?;
            self.mark_synced("oracle_cards", &oracle_cards.updated_at)?;
        } else if let Some(oracle_cards) = oracle_cards {
            skipped.push(oracle_cards.r#type.clone());
        }

        let unique_artwork = entries.iter().find(|e| e.r#type == "unique_artwork");
        if let Some(unique_artwork) = unique_artwork
            && (card_image_catalog_empty || !self.is_up_to_date("unique_artwork", &unique_artwork.updated_at)?)
        {
            progress(BulkSyncStatus::new(
                format!("downloading {}", unique_artwork.r#type),
                0,
                None,
                BulkSyncPhase::Downloading,
            ));
            let file = self.download_to_file(unique_artwork, "unique_artwork", progress, cancel).await?;
            progress(BulkSyncStatus::new("importing cards", 0, None, BulkSyncPhase::Importing));
            (cards_imported, sets_upserted, no_art) =
                run_blocking(|| self.import_unique_artwork(&file, progress, cancel))?;
            std::fs::remove_file(&file)?;
            self.mark_synced("unique_artwork", &unique_artwork.updated_at)?;
        } else if let Some(unique_artwork) = unique_artwork {
            skipped.push(unique_artwork.r#type.clone());
        }

        Ok(BulkSyncResult {
            cards_imported,
            sets_upserted,
            no_art_count: no_art,
            oracle_cards_imported: oracle_imported,
            skipped_up_to_date: skipped,
        })
    }

    /// Path.GetInvalidFileNameChars (Windows) replaced with '_'.
    pub fn sanitize_file_name(value: &str) -> String {
        value
            .chars()
            .map(|ch| if crate::camera_dataset_sync_service::is_invalid_file_name_char(ch) { '_' } else { ch })
            .collect()
    }

    async fn get_bulk_entries(&self, cancel: &CancellationToken) -> Result<Vec<ScryfallBulkDataEntryDto>> {
        #[derive(Deserialize)]
        struct BulkList {
            data: Vec<ScryfallBulkDataEntryDto>,
        }
        let url = Url::parse("https://api.scryfall.com/bulk-data")?;
        let response = ensure_success_status_code(self.client.get(&url, cancel).await?)?;
        let body = read_body(response, cancel).await?;
        Ok(serde_json::from_slice::<BulkList>(&body)?.data)
    }

    fn is_up_to_date(&self, bulk_type: &str, remote_updated_at: &str) -> Result<bool> {
        let connection = self.database.open()?;
        let stored: Option<String> = connection
            .query_row(
                "SELECT updated_at FROM sync_state WHERE bulk_type = $type",
                named_params! {"$type": bulk_type},
                |row| row.get(0),
            )
            .optional()?;
        Ok(stored.as_deref() == Some(remote_updated_at))
    }

    fn is_card_image_catalog_empty(&self) -> Result<bool> {
        let connection = self.database.open()?;
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM card_images", [], |row| row.get(0))?;
        Ok(count == 0)
    }

    /// Compares Scryfall's published bulk files with the last import, without downloading anything.
    pub async fn check_freshness(&self, cancel: &CancellationToken) -> Result<Vec<BulkFreshness>> {
        let entries = self.get_bulk_entries(cancel).await?;
        let connection = self.database.open()?;
        let mut statement = connection
            .prepare("SELECT bulk_type AS Type, updated_at AS UpdatedAt, synced_at AS SyncedAt FROM sync_state")?;
        let local = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, (row.get::<_, String>(1)?, row.get::<_, String>(2)?))))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(entries
            .into_iter()
            .filter(|entry| entry.r#type == "oracle_cards" || entry.r#type == "unique_artwork")
            .map(|entry| {
                let row = local.get(&entry.r#type);
                BulkFreshness {
                    local_updated_at: row.map(|row| row.0.clone()),
                    synced_at: row.map(|row| row.1.clone()),
                    remote_updated_at: entry.updated_at,
                    r#type: entry.r#type,
                }
            })
            .collect())
    }

    fn mark_synced(&self, bulk_type: &str, updated_at: &str) -> Result<()> {
        let connection = self.database.open()?;
        connection.execute(
            "INSERT INTO sync_state (bulk_type, updated_at, synced_at)
            VALUES ($type, $updated, $synced)
            ON CONFLICT(bulk_type) DO UPDATE SET
              updated_at = $updated,
              synced_at = $synced",
            named_params! {"$type": bulk_type, "$updated": updated_at, "$synced": round_trip_utc_now()},
        )?;
        Ok(())
    }

    async fn download_to_file(
        &self,
        entry: &ScryfallBulkDataEntryDto,
        name: &str,
        progress: &(dyn Fn(BulkSyncStatus) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        let path = self.options.bulk_directory().join(format!("{name}.download"));
        let url = Url::parse(&entry.jsonl_download_uri)?;
        let mut response = ensure_success_status_code(self.client.get(&url, cancel).await?)?;
        let total = response.content_length().map(|total| total as i64);
        let mut target = tokio::fs::File::create(&path).await?;
        let mut written: i64 = 0;
        let mut last_reported: i64 = -1;
        while let Some(chunk) = read_chunk(&mut response, cancel).await? {
            target.write_all(&chunk).await?;
            written += chunk.len() as i64;
            if written - last_reported > (4 << 20) {
                last_reported = written;
                progress(BulkSyncStatus::new(
                    format!("downloading {name}"),
                    written >> 20,
                    total.map(|t| t >> 20),
                    BulkSyncPhase::Downloading,
                ));
            }
        }
        target.flush().await?;
        Ok(path)
    }

    fn import_unique_artwork(
        &self,
        path: &Path,
        progress: &(dyn Fn(BulkSyncStatus) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<(i32, i32, i32)> {
        let batch_size = self.options.import_batch_size;
        let mut set_counts = SetCounts::new();
        let mut ensured_sets = HashSet::new();
        let mut batch = Vec::with_capacity(batch_size);
        let mut images = Vec::with_capacity(batch_size);
        let mut listed_images = HashSet::new();
        let mut processed: i64 = 0;
        let mut no_art = 0;

        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;

        let reader = BufReader::new(MultiGzDecoder::new(std::fs::File::open(path)?));
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            check(cancel)?;

            let Some(dto) = serde_json::from_str::<Option<ScryfallCardDto>>(&line)? else { continue };
            if dto.set.is_empty() {
                continue;
            }
            processed += 1;

            let faces = dto.resolve_card_images();
            if faces.is_empty() {
                no_art += 1;
            }
            let is_paper = dto.is_available_in_paper();
            batch.push(CardRow {
                id: dto.id.clone(),
                oracle_id: dto.oracle_id.clone(),
                illustration_id: faces
                    .first()
                    .and_then(|face| face.illustration_id.clone())
                    .or_else(|| dto.illustration_id.clone()),
                is_paper,
                name: dto.name.clone(),
                set: dto.set.clone(),
                collector: dto.collector_number.clone(),
                layout: dto.layout.clone(),
                released: dto.released_at.clone(),
            });
            if is_paper {
                listed_images.extend(faces.iter().map(|face| face.image_id.clone()));
                images.extend(faces.into_iter().map(|face| ImageRow {
                    image_id: face.image_id,
                    scryfall_id: dto.id.clone(),
                    face_index: face.face_index,
                    image_uri: face.image_uri,
                    illustration_id: face.illustration_id,
                }));
            }

            match set_counts.get_mut(&dto.set) {
                Some(entry) => {
                    if let Some(set_name) = &dto.set_name {
                        entry.0 = set_name.clone();
                    }
                    if entry.1.is_none() {
                        entry.1 = dto.released_at.clone();
                    }
                    entry.2 += 1;
                }
                None => {
                    let name = dto.set_name.clone().unwrap_or_else(|| dto.set.clone());
                    set_counts.insert(dto.set.clone(), (name, dto.released_at.clone(), 1));
                }
            }

            if batch.len() >= batch_size {
                ensure_sets(&transaction, &batch, &mut ensured_sets, &set_counts)?;
                flush_cards(&transaction, &mut batch)?;
                flush_card_images(&transaction, &mut images)?;
                progress(BulkSyncStatus::new("importing cards", processed, None, BulkSyncPhase::Importing));
            }
        }

        if !batch.is_empty() {
            ensure_sets(&transaction, &batch, &mut ensured_sets, &set_counts)?;
            flush_cards(&transaction, &mut batch)?;
            flush_card_images(&transaction, &mut images)?;
        }

        // Faces the file no longer lists for a paper printing (a single image now split into faces, a printing gone
        // digital-only) leave the download queue and training.
        let stale: Vec<String> = transaction
            .prepare("SELECT image_id FROM card_images")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|id| !listed_images.contains(id))
            .collect();
        for chunk in stale.chunks(900) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            transaction.execute(
                &format!("DELETE FROM card_images WHERE image_id IN ({placeholders})"),
                rusqlite::params_from_iter(chunk),
            )?;
        }

        transaction
            .execute("UPDATE sets SET card_count = (SELECT COUNT(*) FROM cards c WHERE c.set_code = sets.code)", [])?;

        transaction.commit()?;
        progress(BulkSyncStatus::new("cards imported", processed, None, BulkSyncPhase::Importing));
        Ok((processed as i32, set_counts.len() as i32, no_art))
    }

    fn import_oracle_cards(
        &self,
        path: &Path,
        progress: &(dyn Fn(BulkSyncStatus) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<i32> {
        let mut imported: i64 = 0;
        let mut buffer = Vec::with_capacity(self.options.import_batch_size);

        let mut connection = self.database.open()?;
        let transaction = connection.transaction()?;

        let reader = BufReader::new(MultiGzDecoder::new(std::fs::File::open(path)?));
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            check(cancel)?;

            let Some(dto) = serde_json::from_str::<Option<ScryfallOracleCardDto>>(&line)? else { continue };
            imported += 1;
            buffer.push(dto);

            if buffer.len() >= self.options.import_batch_size {
                flush_oracle(&transaction, &mut buffer)?;
                progress(BulkSyncStatus::new("importing oracle cards", imported, None, BulkSyncPhase::Importing));
            }
        }
        if !buffer.is_empty() {
            flush_oracle(&transaction, &mut buffer)?;
        }
        transaction.commit()?;
        Ok(imported as i32)
    }
}

fn ensure_sets(
    transaction: &Transaction,
    batch: &[CardRow],
    ensured: &mut HashSet<String>,
    set_counts: &SetCounts,
) -> Result<()> {
    let mut statement = transaction.prepare_cached(
        "INSERT INTO sets (code, name, card_count, released_at)
        VALUES ($code, $name, 0, $released)
        ON CONFLICT(code) DO UPDATE SET
          name = $name",
    )?;
    for row in batch {
        if !ensured.insert(row.set.clone()) {
            continue;
        }
        let (name, released_at, _) = &set_counts[&row.set];
        statement.execute(named_params! {"$code": row.set, "$name": name, "$released": released_at})?;
    }
    Ok(())
}

fn flush_cards(transaction: &Transaction, batch: &mut Vec<CardRow>) -> Result<()> {
    let mut statement = transaction.prepare_cached(
        "INSERT INTO cards (scryfall_id, oracle_id, illustration_id, is_paper, name, set_code, collector_number, layout, released_at)
        VALUES ($id, $oracleId, $illustrationId, $isPaper, $name, $set, $collector, $layout, $released)
        ON CONFLICT(scryfall_id) DO UPDATE SET
          oracle_id = $oracleId,
          illustration_id = $illustrationId,
          is_paper = $isPaper,
          name = $name,
          set_code = $set,
          collector_number = $collector,
          layout = $layout,
          released_at = $released",
    )?;
    for row in batch.iter() {
        statement.execute(named_params! {
            "$id": row.id,
            "$oracleId": row.oracle_id,
            "$illustrationId": row.illustration_id,
            "$isPaper": row.is_paper,
            "$name": row.name,
            "$set": row.set,
            "$collector": row.collector,
            "$layout": row.layout,
            "$released": row.released,
        })?;
    }
    batch.clear();
    Ok(())
}

fn flush_card_images(transaction: &Transaction, images: &mut Vec<ImageRow>) -> Result<()> {
    // A changed image URI means Scryfall replaced the scan, so the cached file is downloaded again.
    let mut statement = transaction.prepare_cached(
        "INSERT INTO card_images
          (image_id, scryfall_id, face_index, illustration_id, image_uri, status, updated_at)
        VALUES ($imageId, $scryfallId, $faceIndex, $illustrationId, $imageUri, 'pending', $now)
        ON CONFLICT(image_id) DO UPDATE SET
          illustration_id = $illustrationId,
          image_uri = $imageUri,
          status = CASE WHEN image_uri = $imageUri THEN status ELSE 'pending' END,
          file_path = CASE WHEN image_uri = $imageUri THEN file_path ELSE NULL END,
          file_bytes = CASE WHEN image_uri = $imageUri THEN file_bytes ELSE NULL END,
          error = CASE WHEN image_uri = $imageUri THEN error ELSE NULL END,
          updated_at = $now",
    )?;
    for image in images.iter() {
        statement.execute(named_params! {
            "$imageId": image.image_id,
            "$scryfallId": image.scryfall_id,
            "$faceIndex": image.face_index,
            "$illustrationId": image.illustration_id,
            "$imageUri": image.image_uri,
            "$now": round_trip_utc_now(),
        })?;
    }
    images.clear();
    Ok(())
}

fn flush_oracle(transaction: &Transaction, buffer: &mut Vec<ScryfallOracleCardDto>) -> Result<()> {
    let mut statement = transaction.prepare_cached(
        "INSERT INTO oracle_cards (oracle_id, name, mana_cost, type_line, oracle_text)
        VALUES ($id, $Name, $ManaCost, $TypeLine, $OracleText)
        ON CONFLICT(oracle_id) DO UPDATE SET
          name = $Name,
          mana_cost = $ManaCost,
          type_line = $TypeLine,
          oracle_text = $OracleText",
    )?;
    for dto in buffer.iter() {
        statement.execute(named_params! {
            "$id": dto.oracle_id,
            "$Name": dto.name,
            "$ManaCost": dto.mana_cost,
            "$TypeLine": dto.type_line,
            "$OracleText": dto.oracle_text,
        })?;
    }
    buffer.clear();
    Ok(())
}

/// DateTime.UtcNow.ToString("o"): seven fractional digits and a Z, as the C# Toolbox stores timestamps.
pub(crate) fn round_trip_utc_now() -> String {
    round_trip_utc(Utc::now())
}

/// DateTime.ToString("o") for a UTC time.
pub fn round_trip_utc(time: DateTime<Utc>) -> String {
    format!("{}.{:07}Z", time.format("%Y-%m-%dT%H:%M:%S"), time.timestamp_subsec_nanos().min(999_999_999) / 100)
}

/// Long SQLite and file work (the C# ran it under Task.Run): on a multi-threaded runtime the worker hands its other
/// tasks on first, so the import doesn't stall them.
pub(crate) fn run_blocking<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}
