use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Result, bail};
use futures::TryStreamExt;
use reqwest::Url;
use rusqlite::{Connection, named_params};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::bulk_data_sync::{BulkDataSyncService, round_trip_utc_now, run_blocking};
use crate::db::Database;
use crate::error::{check, is_cancelled};
use crate::recognition_crop;
use crate::scryfall::{RequestTimedOut, ScryfallClient, read_chunk};
use crate::sync_options::SyncOptions;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CardImageCacheStatus {
    pub total: i64,
    pub downloaded: i64,
    pub pending: i64,
    pub failed: i64,
    pub downloaded_bytes: i64,
}

impl CardImageCacheStatus {
    pub fn percent(&self) -> f64 {
        if self.total == 0 { 0.0 } else { self.downloaded as f64 * 100.0 / self.total as f64 }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardImageFailure {
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub face_index: i32,
    pub error: String,
}

/// `failures` lists the faces that failed since the previous report, so none is missed when reports are throttled.
#[derive(Clone, Debug)]
pub struct CardImageProgress {
    pub downloaded: i64,
    pub failed: i64,
    pub remaining: i64,
    pub failures: Vec<CardImageFailure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CardImageRunResult {
    pub downloaded: i64,
    pub failed: i64,
    pub cancelled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CardImageReconcileStatus {
    pub scanned: i64,
    pub total: i64,
    pub recovered: i64,
}

/// `files_removed` counts the legacy art-crop caches and card images no row uses any more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CardImagePreparation {
    pub files_removed: i64,
    pub bytes_removed: i64,
    pub requeued: i64,
    pub recovered: i64,
}

const FOLDER: &str = "card-images";

// Caches from before full-card references: art crops, and the extraction scene cards that were downloaded
// separately. Both are replaced by card-images.
const LEGACY_FOLDERS: [&[&str]; 2] = [&["cards"], &["training", "extraction", "full-cards"]];

// At over a hundred images a second, reporting each one floods the caller's UI thread with updates.
const PROGRESS_INTERVAL_MS: i64 = 100;

/// Scryfall's full-card image of every paper face, cached under the data root. Recognition references and
/// extraction scenes both read these. Paths in `card_images.file_path` are relative to the data root.
pub struct CardImageService {
    database: Database,
    client: Arc<ScryfallClient>,
    options: SyncOptions,
}

struct PendingFace {
    image_id: String,
    image_uri: String,
    face_index: i64,
    name: String,
    set_code: String,
    collector_number: String,
}

impl CardImageService {
    pub fn new(database: Database, client: Arc<ScryfallClient>, options: SyncOptions) -> Self {
        Self { database, client, options }
    }

    pub fn images_directory(&self) -> PathBuf {
        self.options.data_root.join(FOLDER)
    }

    /// A `card_images.file_path` (relative to the data root, forward slashes) as a full path.
    pub fn absolute_path(data_root: &Path, relative_path: &str) -> PathBuf {
        data_root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
    }

    fn absolute(&self, relative_path: &str) -> PathBuf {
        Self::absolute_path(&self.options.data_root, relative_path)
    }

    pub async fn inspect(&self, cancel: &CancellationToken) -> Result<CardImageCacheStatus> {
        check(cancel)?;
        let connection = self.database.open()?;
        let mut statement = connection.prepare(
            "SELECT status AS Status, COUNT(*) AS Count, COALESCE(SUM(file_bytes), 0) AS Bytes
            FROM card_images GROUP BY status",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let count = |status: &str| rows.iter().filter(|row| row.0 == status).map(|row| row.1).sum::<i64>();
        Ok(CardImageCacheStatus {
            total: rows.iter().map(|row| row.1).sum(),
            downloaded: count("downloaded"),
            pending: count("pending"),
            failed: count("failed"),
            downloaded_bytes: rows.iter().filter(|row| row.0 == "downloaded").map(|row| row.2).sum(),
        })
    }

    /// Gets the queue ready: removes the legacy caches, re-queues downloaded faces whose file is gone (and failed
    /// faces when `retry_failed`), and marks pending faces whose file is already on disk as downloaded.
    /// Failed faces otherwise stay failed with their reason, so a face Scryfall no longer serves is not asked for on
    /// every sync.
    pub async fn prepare(
        &self,
        retry_failed: bool,
        progress: Option<&(dyn Fn(CardImageReconcileStatus) + Send + Sync)>,
        cancel: &CancellationToken,
    ) -> Result<CardImagePreparation> {
        check(cancel)?;
        // The database and file work is long and blocking (the C# ran it under Task.Run).
        run_blocking(|| {
            let (legacy_files, legacy_bytes) = self.remove_legacy_caches()?;
            let requeued = self.requeue(retry_failed)?;
            let recovered = self.reconcile_existing_files(progress, cancel)?;
            let (unused_files, unused_bytes) = self.remove_unused_images(cancel)?;
            Ok(CardImagePreparation {
                files_removed: legacy_files + unused_files,
                bytes_removed: legacy_bytes + unused_bytes,
                requeued,
                recovered,
            })
        })
    }

    // Files of faces the catalogue dropped or whose scan Scryfall replaced (the name carries the old URI's hash), and
    // interrupted downloads. Runs after reconciling, so every file a row can use is referenced by then.
    fn remove_unused_images(&self, cancel: &CancellationToken) -> Result<(i64, i64)> {
        let images_directory = self.images_directory();
        if !images_directory.is_dir() {
            return Ok((0, 0));
        }
        let connection = self.database.open()?;
        let used: HashSet<String> = connection
            .prepare("SELECT file_path FROM card_images WHERE file_path IS NOT NULL")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|path| full_path_key(&self.absolute(&path)))
            .collect();
        let (mut files, mut bytes) = (0, 0);
        for entry in walkdir::WalkDir::new(&images_directory) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            check(cancel)?;
            if used.contains(&full_path_key(entry.path())) {
                continue;
            }
            // Open elsewhere; the next sync removes it.
            let Ok(length) = entry.metadata().map(|metadata| metadata.len() as i64) else { continue };
            if std::fs::remove_file(entry.path()).is_ok() {
                files += 1;
                bytes += length;
            }
        }
        Ok((files, bytes))
    }

    fn remove_legacy_caches(&self) -> Result<(i64, i64)> {
        let (mut files, mut bytes) = (0, 0);
        for parts in LEGACY_FOLDERS {
            let folder = parts.iter().fold(self.options.data_root.clone(), |path, part| path.join(part));
            if !folder.is_dir() {
                continue;
            }
            for entry in walkdir::WalkDir::new(&folder) {
                let entry = entry?;
                if entry.file_type().is_file() {
                    files += 1;
                    bytes += entry.metadata()?.len() as i64;
                }
            }
            std::fs::remove_dir_all(&folder)?;
        }
        Ok((files, bytes))
    }

    fn requeue(&self, retry_failed: bool) -> Result<i64> {
        let connection = self.database.open()?;
        let downloaded = connection
            .prepare("SELECT image_id AS Id, file_path AS Path FROM card_images WHERE status = 'downloaded'")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let missing: Vec<String> = downloaded
            .into_iter()
            .filter(|(_, path)| path.as_ref().is_none_or(|path| !self.absolute(path).is_file()))
            .map(|(id, _)| id)
            .collect();
        let now = round_trip_utc_now();
        let mut requeued = if retry_failed {
            connection.execute(
                "UPDATE card_images SET status = 'pending', error = NULL, updated_at = $now WHERE status = 'failed'",
                named_params! {"$now": now},
            )? as i64
        } else {
            0
        };
        for chunk in missing.chunks(900) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let parameters = std::iter::once(now.as_str()).chain(chunk.iter().map(String::as_str));
            requeued += connection.execute(
                &format!(
                    "UPDATE card_images SET status = 'pending', file_path = NULL, file_bytes = NULL, updated_at = ?
                    WHERE image_id IN ({placeholders})"
                ),
                rusqlite::params_from_iter(parameters),
            )? as i64;
        }
        Ok(requeued)
    }

    fn reconcile_existing_files(
        &self,
        progress: Option<&(dyn Fn(CardImageReconcileStatus) + Send + Sync)>,
        cancel: &CancellationToken,
    ) -> Result<i64> {
        let mut connection = self.database.open()?;
        let pending = load_pending(&connection, None)?;
        if pending.is_empty() {
            if let Some(progress) = progress {
                progress(CardImageReconcileStatus { scanned: 0, total: 0, recovered: 0 });
            }
            return Ok(0);
        }
        let total = pending.len() as i64;
        let mut found = Vec::new();
        for (index, face) in pending.iter().enumerate() {
            check(cancel)?;
            let relative = relative_path_of(face);
            if let Some(bytes) = try_get_complete_jpeg_length(&self.absolute(&relative)) {
                found.push((face.image_id.clone(), relative, bytes));
            }
            let scanned = index as i64 + 1;
            if scanned % 250 == 0 || scanned == total {
                if let Some(progress) = progress {
                    progress(CardImageReconcileStatus { scanned, total, recovered: found.len() as i64 });
                }
            }
        }
        if found.is_empty() {
            return Ok(0);
        }
        check(cancel)?;
        let transaction = connection.transaction()?;
        let now = round_trip_utc_now();
        let mut updated = 0;
        {
            let mut statement = transaction.prepare(
                "UPDATE card_images
                SET status = 'downloaded', file_path = $Path, file_bytes = $Bytes, error = NULL, updated_at = $Now
                WHERE image_id = $Id AND status = 'pending'",
            )?;
            for (id, path, bytes) in &found {
                updated +=
                    statement.execute(named_params! {"$Path": path, "$Bytes": bytes, "$Now": now, "$Id": id})? as i64;
            }
        }
        transaction.commit()?;
        Ok(updated)
    }

    /// Downloads pending faces, at most `maximum` when given.
    pub async fn download_pending(
        &self,
        maximum: Option<i32>,
        progress: Option<&(dyn Fn(CardImageProgress) + Send + Sync)>,
        cancel: &CancellationToken,
    ) -> Result<CardImageRunResult> {
        let writer = Mutex::new(self.database.open()?);
        let queue = {
            let connection = writer.lock().unwrap_or_else(|e| e.into_inner());
            load_pending(&connection, maximum)?
        };
        if queue.is_empty() {
            return Ok(CardImageRunResult { downloaded: 0, failed: 0, cancelled: cancel.is_cancelled() });
        }
        let queue_length = queue.len() as i64;
        let downloaded = AtomicI64::new(0);
        let failed = AtomicI64::new(0);
        let clock = Instant::now();
        let last_report = AtomicI64::new(0);
        // The highest finished count reported; also serializes reports.
        let reported_finished = Mutex::new(-1_i64);
        let new_failures = Mutex::new(Vec::<CardImageFailure>::new());

        let run = futures::stream::iter(queue.iter().map(Ok::<_, anyhow::Error>)).try_for_each_concurrent(
            self.options.image_concurrency.min(queue.len()).max(1),
            |face| {
                let (writer, downloaded, failed, last_report, reported_finished, new_failures) =
                    (&writer, &downloaded, &failed, &last_report, &reported_finished, &new_failures);
                async move {
                    check(cancel)?;
                    let relative = relative_path_of(face);
                    let (error, bytes) = match self.download_one(&face.image_uri, &self.absolute(&relative), cancel).await
                    {
                        Ok(bytes) => (None, bytes),
                        Err(exception) if is_cancelled(&exception) && cancel.is_cancelled() => return Err(exception),
                        // One face failing (a timeout, an HTTP error, a file the disk refused) is recorded against
                        // that face; the rest keep downloading.
                        Err(exception) => {
                            let message = if exception.is::<RequestTimedOut>() {
                                "timed out".to_string()
                            } else {
                                format!("{exception:#}")
                            };
                            (Some(message), 0)
                        }
                    };
                    {
                        let connection = writer.lock().unwrap_or_else(|e| e.into_inner());
                        let now = round_trip_utc_now();
                        match &error {
                            None => connection.execute(
                                "UPDATE card_images
                                SET status = 'downloaded', file_path = $relative, file_bytes = $bytes, error = NULL,
                                    updated_at = $now
                                WHERE image_id = $id",
                                named_params! {"$relative": relative, "$bytes": bytes, "$now": now, "$id": face.image_id},
                            )?,
                            Some(error) => connection.execute(
                                "UPDATE card_images SET status = 'failed', error = $error, updated_at = $now WHERE image_id = $id",
                                named_params! {"$error": error, "$now": now, "$id": face.image_id},
                            )?,
                        };
                    }
                    // Queued before it is counted, so the report that sees the final count carries it.
                    if let Some(error) = &error {
                        new_failures.lock().unwrap_or_else(|e| e.into_inner()).push(CardImageFailure {
                            name: face.name.clone(),
                            set_code: face.set_code.clone(),
                            collector_number: face.collector_number.clone(),
                            face_index: face.face_index as i32,
                            error: error.clone(),
                        });
                    }
                    let (done, lost) = if error.is_none() {
                        (downloaded.fetch_add(1, Ordering::SeqCst) + 1, failed.load(Ordering::SeqCst))
                    } else {
                        (downloaded.load(Ordering::SeqCst), failed.fetch_add(1, Ordering::SeqCst) + 1)
                    };
                    // The last face always reports; the rest at most every PROGRESS_INTERVAL_MS, failures included (a
                    // lost connection fails thousands in seconds). Each report carries the failures queued since the
                    // last.
                    let now = clock.elapsed().as_millis() as i64;
                    let last = last_report.load(Ordering::SeqCst);
                    let due = done + lost == queue_length
                        || (now - last >= PROGRESS_INTERVAL_MS
                            && last_report.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst).is_ok());
                    let Some(progress) = progress.filter(|_| due) else { return Ok(()) };
                    // Counts are read and reported under the lock, so reports leave in order and never step back.
                    let mut reported = reported_finished.lock().unwrap_or_else(|e| e.into_inner());
                    let (ok, bad) = (downloaded.load(Ordering::SeqCst), failed.load(Ordering::SeqCst));
                    if ok + bad <= *reported {
                        return Ok(());
                    }
                    *reported = ok + bad;
                    let failures = std::mem::take(&mut *new_failures.lock().unwrap_or_else(|e| e.into_inner()));
                    progress(CardImageProgress {
                        downloaded: ok,
                        failed: bad,
                        remaining: queue_length - ok - bad,
                        failures,
                    });
                    Ok(())
                }
            },
        );
        match run.await {
            Ok(()) => Ok(CardImageRunResult {
                downloaded: downloaded.load(Ordering::SeqCst),
                failed: failed.load(Ordering::SeqCst),
                cancelled: false,
            }),
            Err(error) if is_cancelled(&error) && cancel.is_cancelled() => Ok(CardImageRunResult {
                downloaded: downloaded.load(Ordering::SeqCst),
                failed: failed.load(Ordering::SeqCst),
                cancelled: true,
            }),
            Err(error) => Err(error),
        }
    }

    // The name carries a hash of the image URI: when Scryfall replaces a scan (a new URI) the old file is never
    // mistaken for the new one, and two image rows of one face never share a file.
    pub fn relative_path(set_code: &str, collector_number: &str, face_index: i64, image_uri: &str) -> String {
        let hash = hex::encode(Sha256::digest(image_uri.as_bytes()));
        format!(
            "{FOLDER}/{}/{}-{face_index}-{}.jpg",
            BulkDataSyncService::sanitize_file_name(set_code),
            BulkDataSyncService::sanitize_file_name(collector_number),
            &hash[..8]
        )
    }

    async fn download_one(&self, uri: &str, destination: &Path, cancel: &CancellationToken) -> Result<i64> {
        let mut response = self.client.get(&Url::parse(uri)?, cancel).await?;
        let status = response.status();
        if !status.is_success() {
            bail!("HTTP {} {}", status.as_u16(), status.canonical_reason().unwrap_or(""));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = crate::camera_annotation_store::with_suffix(destination, ".download");
        let result = async {
            {
                let mut target = tokio::fs::File::create(&temporary).await?;
                while let Some(chunk) = read_chunk(&mut response, cancel).await? {
                    target.write_all(&chunk).await?;
                }
                target.flush().await?;
            }
            let Some(bytes) = try_get_complete_jpeg_length(&temporary) else { bail!("not a complete JPEG") };
            std::fs::rename(&temporary, destination)?;
            Ok(bytes)
        }
        .await;
        if temporary.exists() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

/// Path.GetFullPath, compared ignoring case (StringComparer.OrdinalIgnoreCase).
fn full_path_key(path: &Path) -> String {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()).to_string_lossy().to_lowercase()
}

// Pending faces in image-id order, which is Scryfall-id order: effectively random across sets, so a capped
// download (extraction's first scenes) still samples the whole catalogue.
fn load_pending(connection: &Connection, maximum: Option<i32>) -> Result<Vec<PendingFace>> {
    let mut statement = connection.prepare(
        "SELECT i.image_id AS ImageId, i.image_uri AS ImageUri, i.face_index AS FaceIndex,
               c.name AS Name, c.set_code AS SetCode, c.collector_number AS CollectorNumber
        FROM card_images i JOIN cards c ON c.scryfall_id = i.scryfall_id
        WHERE i.status = 'pending'
        ORDER BY i.image_id
        LIMIT $limit",
    )?;
    let faces = statement
        .query_map(named_params! {"$limit": maximum.unwrap_or(-1)}, |row| {
            Ok(PendingFace {
                image_id: row.get(0)?,
                image_uri: row.get(1)?,
                face_index: row.get(2)?,
                name: row.get(3)?,
                set_code: row.get(4)?,
                collector_number: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(faces)
}

fn relative_path_of(face: &PendingFace) -> String {
    CardImageService::relative_path(&face.set_code, &face.collector_number, face.face_index, &face.image_uri)
}

fn try_get_complete_jpeg_length(path: &Path) -> Option<i64> {
    let length = std::fs::metadata(path).ok().filter(|metadata| metadata.is_file())?.len();
    if length < 1024 {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut marker = [0u8; 2];
    file.read_exact(&mut marker).ok()?;
    if marker != [0xFF, 0xD8] {
        return None;
    }
    file.seek(SeekFrom::End(-2)).ok()?;
    file.read_exact(&mut marker).ok()?;
    if marker != [0xFF, 0xD9] {
        return None;
    }
    Some(length as i64)
}

/// A cached full-card image cut to the phone's recognition box: the art a person picks a printing by
/// (Bridge/Images.cs CropCardArt).
pub fn crop_card_art(path: &Path) -> Result<image::RgbImage> {
    let card = image::ImageReader::open(path)?.with_guessed_format()?.decode()?.to_rgb8();
    let scale_x = card.width() as f64 / recognition_crop::CARD_WIDTH as f64;
    let scale_y = card.height() as f64 / recognition_crop::CARD_HEIGHT as f64;
    // Math.Round rounds half to even.
    let round = |value: u32, scale: f64| (value as f64 * scale).round_ties_even() as u32;
    let (left, top) = (round(recognition_crop::LEFT, scale_x), round(recognition_crop::TOP, scale_y));
    let (right, bottom) = (round(recognition_crop::RIGHT, scale_x), round(recognition_crop::BOTTOM, scale_y));
    Ok(image::imageops::crop_imm(&card, left, top, right - left, bottom - top).to_image())
}
