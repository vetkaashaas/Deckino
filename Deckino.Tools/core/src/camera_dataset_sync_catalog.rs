//! CameraDatasetSyncCatalog.cs: the sync's SQLite file (camera/dataset-sync.db), shared with the C# Toolbox. The
//! outbox queues local changes for the bucket; objects records what both sides last agreed on.
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Timelike, Utc};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::camera_dataset_sync::DatasetSyncConflict;
use crate::object_store::RemoteDatasetObject;

/// Stored as a number: Upload = 1, Delete = 2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatasetSyncOperation {
    Upload = 1,
    Delete = 2,
}

impl DatasetSyncOperation {
    fn from_i64(value: i64) -> Self {
        if value == 1 { Self::Upload } else { Self::Delete }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDatasetOperation {
    pub id: i64,
    pub object_key: String,
    pub relative_path: String,
    pub operation: DatasetSyncOperation,
    pub sha256: Option<String>,
    pub attempts: i32,
    pub next_attempt_utc: Option<DateTime<Utc>>,
}

/// (object key, relative path, operation, sha256) for `queue_many`.
pub type QueuedOperation = (String, String, DatasetSyncOperation, Option<String>);
/// object key → (ETag, size, sha256).
pub type RemoteHashes = HashMap<String, (String, i64, String)>;
/// tombstone key → (ETag, content).
pub type CachedTombstones = HashMap<String, (String, Vec<u8>)>;
/// relative path → (length, write ticks, sha256).
pub type LocalHashes = HashMap<String, (i64, i64, String)>;

const SCHEMA: &str = "
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS outbox(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_key TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        operation INTEGER NOT NULL,
        sha256 TEXT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_utc TEXT NULL,
        last_error TEXT NULL);
    CREATE TABLE IF NOT EXISTS objects(object_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conflicts(
        object_key TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        remote_copy_path TEXT NOT NULL,
        local_sha256 TEXT NOT NULL,
        remote_sha256 TEXT NOT NULL,
        created_utc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NULL);
    -- Caches that let a sync skip work whose answer has not changed: a remote object's hash by its
    -- ETag and size, a tombstone's contents by its ETag, a local file's hash by its size and write time.
    CREATE TABLE IF NOT EXISTS remote_hashes(object_key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tombstone_cache(tombstone_key TEXT PRIMARY KEY, etag TEXT NOT NULL, content BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS local_hashes(relative_path TEXT PRIMARY KEY, length INTEGER NOT NULL, write_ticks INTEGER NOT NULL, sha256 TEXT NOT NULL);
";

/// DateTimeOffset.ToString("O") for a UTC time: `2026-11-08T12:34:56.1234567+00:00`. The outbox compares these as
/// text, so both Toolboxes must write exactly this shape.
pub fn round_trip(timestamp: &DateTime<Utc>) -> String {
    format!("{}.{:07}+00:00", timestamp.format("%Y-%m-%dT%H:%M:%S"), timestamp.nanosecond() % 1_000_000_000 / 100)
}

/// DateTimeOffset.Parse of a stored timestamp.
pub fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.trim()).ok().map(|parsed| parsed.with_timezone(&Utc))
}

pub struct CameraDatasetSyncCatalog {
    // One connection behind the gate: the C# Toolbox opens one per call under the same lock.
    connection: Mutex<Connection>,
}

impl CameraDatasetSyncCatalog {
    pub fn new(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(30))?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    fn gate(&self) -> MutexGuard<'_, Connection> {
        self.connection.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn queue(
        &self,
        key: &str,
        relative_path: &str,
        operation: DatasetSyncOperation,
        sha256: Option<&str>,
    ) -> Result<()> {
        self.queue_many(&[(key.to_string(), relative_path.to_string(), operation, sha256.map(str::to_string))])
    }

    pub fn queue_many(&self, operations: &[QueuedOperation]) -> Result<()> {
        if operations.is_empty() {
            return Ok(());
        }
        let mut connection = self.gate();
        let transaction = connection.transaction()?;
        {
            // A re-queued key gets a new id: `complete` of a transfer already in flight (by the old id) then leaves
            // the newer change queued instead of deleting it with the old one.
            let mut remove = transaction.prepare("DELETE FROM outbox WHERE object_key = ?1;")?;
            let mut insert = transaction.prepare(
                "INSERT INTO outbox(object_key, relative_path, operation, sha256, attempts, next_attempt_utc, last_error)
                 VALUES(?1, ?2, ?3, ?4, 0, NULL, NULL);",
            )?;
            for (key, relative_path, operation, sha256) in operations {
                remove.execute([key])?;
                insert.execute(params![key, relative_path, *operation as i64, sha256])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pending(&self, include_deferred: bool) -> Result<Vec<PendingDatasetOperation>> {
        let connection = self.gate();
        let read = |row: &rusqlite::Row<'_>| {
            Ok(PendingDatasetOperation {
                id: row.get(0)?,
                object_key: row.get(1)?,
                relative_path: row.get(2)?,
                operation: DatasetSyncOperation::from_i64(row.get(3)?),
                sha256: row.get(4)?,
                attempts: row.get(5)?,
                next_attempt_utc: row.get::<_, Option<String>>(6)?.as_deref().and_then(parse_timestamp),
            })
        };
        let result = if include_deferred {
            connection
                .prepare("SELECT id, object_key, relative_path, operation, sha256, attempts, next_attempt_utc FROM outbox ORDER BY id;")?
                .query_map([], read)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            connection
                .prepare("SELECT id, object_key, relative_path, operation, sha256, attempts, next_attempt_utc FROM outbox WHERE next_attempt_utc IS NULL OR next_attempt_utc <= ?1 ORDER BY id;")?
                .query_map([round_trip(&Utc::now())], read)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(result)
    }

    /// False when the operation was re-queued meanwhile (a new change to the same key, under a new id): that one
    /// stays queued.
    pub fn complete(&self, operation: &PendingDatasetOperation, synchronized_sha: Option<&str>) -> Result<bool> {
        let mut connection = self.gate();
        let transaction = connection.transaction()?;
        let deleted = transaction.execute(
            "DELETE FROM outbox WHERE id = ?1 AND operation = ?2;",
            params![operation.id, operation.operation as i64],
        )?;
        if deleted == 0 {
            transaction.rollback()?;
            return Ok(false);
        }
        match synchronized_sha {
            Some(sha) if operation.operation == DatasetSyncOperation::Upload => {
                set_object_core(&transaction, &operation.object_key, sha)?
            }
            _ => delete_object_core(&transaction, &operation.object_key)?,
        }
        transaction.commit()?;
        Ok(true)
    }

    pub fn fail(&self, operation: &PendingDatasetOperation, error: &str) -> Result<()> {
        let attempts = operation.attempts + 1;
        let delay = 300f64.min(2f64.powi(attempts.min(8)));
        let next = Utc::now() + chrono::Duration::milliseconds((delay * 1000.0) as i64);
        self.gate().execute(
            "UPDATE outbox SET attempts = ?1, next_attempt_utc = ?2, last_error = ?3 WHERE id = ?4;",
            params![attempts, round_trip(&next), sanitize_error(error), operation.id],
        )?;
        Ok(())
    }

    pub fn synchronized_sha(&self, key: &str) -> Result<Option<String>> {
        let value = self
            .gate()
            .query_row("SELECT sha256 FROM objects WHERE object_key = ?1;", [key], |row| row.get(0))
            .optional()?;
        Ok(value)
    }

    pub fn synchronized_object_keys(&self) -> Result<Vec<String>> {
        let connection = self.gate();
        let keys = connection
            .prepare("SELECT object_key FROM objects WHERE sha256 NOT LIKE 'deleted:%' ORDER BY object_key;")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(keys)
    }

    pub fn set_synchronized(&self, key: &str, sha256: &str) -> Result<()> {
        set_object_core(&self.gate(), key, sha256)
    }

    pub fn add_conflict(&self, conflict: &DatasetSyncConflict) -> Result<()> {
        self.gate().execute(
            "INSERT INTO conflicts(object_key, relative_path, remote_copy_path, local_sha256, remote_sha256, created_utc)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(object_key) DO UPDATE SET remote_copy_path = excluded.remote_copy_path,
                 local_sha256 = excluded.local_sha256, remote_sha256 = excluded.remote_sha256,
                 created_utc = excluded.created_utc;",
            params![
                conflict.object_key,
                conflict.relative_path,
                conflict.remote_copy_path.to_string_lossy(),
                conflict.local_sha256,
                conflict.remote_sha256,
                round_trip(&conflict.created_utc),
            ],
        )?;
        Ok(())
    }

    pub fn conflicts(&self) -> Result<Vec<DatasetSyncConflict>> {
        let connection = self.gate();
        let conflicts = connection
            .prepare("SELECT object_key, relative_path, remote_copy_path, local_sha256, remote_sha256, created_utc FROM conflicts ORDER BY created_utc;")?
            .query_map([], |row| {
                let created: String = row.get(5)?;
                Ok(DatasetSyncConflict {
                    object_key: row.get(0)?,
                    relative_path: row.get(1)?,
                    remote_copy_path: row.get::<_, String>(2)?.into(),
                    local_sha256: row.get(3)?,
                    remote_sha256: row.get(4)?,
                    created_utc: parse_timestamp(&created).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            format!("String '{created}' was not recognized as a valid DateTime.").into(),
                        )
                    })?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(conflicts)
    }

    pub fn conflict_count(&self) -> Result<usize> {
        let count: i64 = self.gate().query_row("SELECT COUNT(*) FROM conflicts;", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub fn remove_conflict(&self, key: &str) -> Result<()> {
        self.gate().execute("DELETE FROM conflicts WHERE object_key = ?1;", [key])?;
        Ok(())
    }

    pub fn last_successful_sync_utc(&self) -> Result<Option<DateTime<Utc>>> {
        Ok(self.get_meta("last_successful_sync_utc")?.as_deref().and_then(parse_timestamp))
    }

    pub fn set_last_successful_sync_utc(&self, value: Option<DateTime<Utc>>) -> Result<()> {
        self.set_meta("last_successful_sync_utc", value.as_ref().map(round_trip).as_deref())
    }

    /// (pending, failed): every queued operation, and those that failed at least once.
    pub fn counts(&self) -> Result<(usize, usize)> {
        let (pending, failed): (i64, i64) = self.gate().query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END), 0) FROM outbox;",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((pending as usize, failed as usize))
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>> {
        let value = self
            .gate()
            .query_row("SELECT value FROM meta WHERE key = ?1;", [key], |row| row.get::<_, Option<String>>(0))
            .optional()?;
        Ok(value.flatten())
    }

    fn set_meta(&self, key: &str, value: Option<&str>) -> Result<()> {
        self.gate().execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn remote_hashes(&self) -> Result<RemoteHashes> {
        self.read_all("SELECT object_key, etag, size, sha256 FROM remote_hashes;", |row| {
            Ok((row.get(1)?, row.get(2)?, row.get(3)?))
        })
    }

    /// Brings the cache to the latest listing: objects that are gone drop out, only new or changed rows are written.
    pub fn set_remote_hashes(&self, previous: &RemoteHashes, objects: &[RemoteDatasetObject]) -> Result<()> {
        let current: RemoteHashes = objects
            .iter()
            .filter_map(|item| match (&item.etag, &item.sha256) {
                (Some(etag), Some(sha)) if !etag.is_empty() && !sha.is_empty() => {
                    Some((item.key.clone(), (etag.clone(), item.size, sha.clone())))
                }
                _ => None,
            })
            .collect();
        self.merge(
            "remote_hashes",
            "object_key",
            "INSERT INTO remote_hashes(object_key, etag, size, sha256) VALUES(?1, ?2, ?3, ?4) \
             ON CONFLICT(object_key) DO UPDATE SET etag = excluded.etag, size = excluded.size, sha256 = excluded.sha256;",
            previous,
            &current,
            |key, (etag, size, sha)| {
                vec![key.to_string().into(), etag.clone().into(), (*size).into(), sha.clone().into()]
            },
        )
    }

    pub fn cached_tombstones(&self) -> Result<CachedTombstones> {
        self.read_all("SELECT tombstone_key, etag, content FROM tombstone_cache;", |row| Ok((row.get(1)?, row.get(2)?)))
    }

    pub fn set_cached_tombstones(&self, previous: &CachedTombstones, current: &CachedTombstones) -> Result<()> {
        self.merge(
            "tombstone_cache",
            "tombstone_key",
            "INSERT INTO tombstone_cache(tombstone_key, etag, content) VALUES(?1, ?2, ?3) \
             ON CONFLICT(tombstone_key) DO UPDATE SET etag = excluded.etag, content = excluded.content;",
            previous,
            current,
            |key, (etag, content)| vec![key.to_string().into(), etag.clone().into(), content.clone().into()],
        )
    }

    pub fn local_hashes(&self) -> Result<LocalHashes> {
        self.read_all("SELECT relative_path, length, write_ticks, sha256 FROM local_hashes;", |row| {
            Ok((row.get(1)?, row.get(2)?, row.get(3)?))
        })
    }

    pub fn set_local_hashes(&self, previous: &LocalHashes, current: &LocalHashes) -> Result<()> {
        self.merge(
            "local_hashes",
            "relative_path",
            "INSERT INTO local_hashes(relative_path, length, write_ticks, sha256) VALUES(?1, ?2, ?3, ?4) \
             ON CONFLICT(relative_path) DO UPDATE SET length = excluded.length, write_ticks = excluded.write_ticks, sha256 = excluded.sha256;",
            previous,
            current,
            |key, (length, ticks, sha)| {
                vec![key.to_string().into(), (*length).into(), (*ticks).into(), sha.clone().into()]
            },
        )
    }

    fn read_all<T>(
        &self,
        sql: &str,
        read: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> Result<HashMap<String, T>> {
        let connection = self.gate();
        let rows = connection
            .prepare(sql)?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, read(row)?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(rows)
    }

    // Deletes rows whose key is no longer current and upserts rows that are new or changed; an unchanged cache
    // costs no writes. table and key_column are always constants from this module.
    fn merge<T: PartialEq>(
        &self,
        table: &str,
        key_column: &str,
        upsert: &str,
        previous: &HashMap<String, T>,
        current: &HashMap<String, T>,
        row: impl Fn(&str, &T) -> Vec<Value>,
    ) -> Result<()> {
        let removed: Vec<&String> = previous.keys().filter(|key| !current.contains_key(*key)).collect();
        let changed: Vec<(&String, &T)> =
            current.iter().filter(|(key, value)| previous.get(*key) != Some(*value)).collect();
        if removed.is_empty() && changed.is_empty() {
            return Ok(());
        }
        let mut connection = self.gate();
        let transaction = connection.transaction()?;
        {
            let mut delete = transaction.prepare(&format!("DELETE FROM {table} WHERE {key_column} = ?1;"))?;
            for key in removed {
                delete.execute([key])?;
            }
            let mut insert = transaction.prepare(upsert)?;
            for (key, value) in changed {
                insert.execute(params_from_iter(row(key, value)))?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

fn set_object_core(connection: &Connection, key: &str, sha256: &str) -> Result<()> {
    connection.execute(
        "INSERT INTO objects(object_key, sha256) VALUES(?1, ?2) ON CONFLICT(object_key) DO UPDATE SET sha256 = excluded.sha256;",
        params![key, sha256],
    )?;
    Ok(())
}

fn delete_object_core(transaction: &Connection, key: &str) -> Result<()> {
    transaction.execute("DELETE FROM objects WHERE object_key = ?1;", [key])?;
    Ok(())
}

fn sanitize_error(error: &str) -> String {
    error.chars().take(1000).collect()
}
