//! CameraDatasetSyncService.cs: keeps camera/imports in step with the Railway bucket. Local changes queue in the
//! catalogue's outbox and upload in the background; remote changes download only when someone chooses Sync now.
//! Also the change tracker the camera store and the import call (`track_*`).
use crate::n0;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Timelike, Utc};
use futures::TryStreamExt;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::camera_annotation::{CameraImportDescriptor, CardAnnotation, CardIdentity};
use crate::camera_annotation_store::{CameraAnnotationStore, strip_bom};
use crate::camera_dataset_sync::{DatasetSyncConflict, DatasetSyncResult, DatasetSyncSnapshot};
use crate::camera_dataset_sync_catalog::{
    CameraDatasetSyncCatalog, DatasetSyncOperation, LocalHashes, PendingDatasetOperation, QueuedOperation, round_trip,
};
use crate::credentials::{DatasetSyncCredentials, DpapiSyncCredentialStore};
use crate::error::{Cancelled, check, is_cancelled};
use crate::object_store::{RailwayS3ObjectStore, RemoteDatasetObject, is_not_found};
use crate::paths::TrainingPaths;
use crate::training_result_exporter::sha256_file;

const NOT_CONFIGURED: &str = "Dataset sync is not configured.";
/// The training photos' bucket prefix (camera/imports).
pub const TRAINING_PREFIX: &str = "camera/v1/";
/// The model benchmark's photos (camera/benchmark): their own prefix, so training sync never reads or writes them.
pub const BENCHMARK_PREFIX: &str = "benchmark/v1/";
pub const MAXIMUM_PARALLEL_TRANSFERS: usize = 8;
pub const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(15);

const IMAGE_EXTENSIONS: [&str; 3] = [".jpg", ".jpeg", ".png"];

/// InvalidDataException: a remote file or key this PC refuses to take.
#[derive(Debug)]
struct InvalidData(String);

impl std::fmt::Display for InvalidData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidData {}

fn invalid_data(message: impl Into<String>) -> anyhow::Error {
    InvalidData(message.into()).into()
}

/// The bucket's record of a deleted file, written to TOMBSTONES_PREFIX in the C# Toolbox's JSON shape.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DatasetTombstone {
    #[serde(default)]
    schema_version: i32,
    object_key: String,
    #[serde(serialize_with = "write_json_timestamp", deserialize_with = "read_json_timestamp")]
    deleted_utc: DateTime<Utc>,
}

/// System.Text.Json's DateTimeOffset: round-trip format with the fraction's trailing zeros trimmed.
fn write_json_timestamp<S: Serializer>(timestamp: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error> {
    let fraction = format!("{:07}", timestamp.nanosecond() % 1_000_000_000 / 100);
    let fraction = fraction.trim_end_matches('0');
    let fraction = if fraction.is_empty() { String::new() } else { format!(".{fraction}") };
    serializer.serialize_str(&format!("{}{fraction}+00:00", timestamp.format("%Y-%m-%dT%H:%M:%S")))
}

fn read_json_timestamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<DateTime<Utc>, D::Error> {
    let text = String::deserialize(deserializer)?;
    DateTime::parse_from_rfc3339(&text)
        .map(|parsed| parsed.with_timezone(&Utc))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(&text, "%Y-%m-%dT%H:%M:%S%.f").map(|naive| naive.and_utc()))
        .map_err(serde::de::Error::custom)
}

struct RemoteMaterial {
    path: PathBuf,
    sha256: String,
}

enum Reconciled {
    Unchanged,
    Downloaded,
    Conflict,
}

pub struct CameraDatasetSyncService {
    this: Weak<Self>,
    runtime: Handle,
    paths: TrainingPaths,
    /// The local folder this sync keeps in step with its bucket `prefix`.
    root: PathBuf,
    prefix: &'static str,
    files_prefix: String,
    tombstones_prefix: String,
    credential_store: Arc<DpapiSyncCredentialStore>,
    catalog: CameraDatasetSyncCatalog,
    remote_gate: tokio::sync::Mutex<()>,
    lifetime: CancellationToken,
    // Shared with the benchmark's sync, so a connection saved on the Dataset Sync page reaches both.
    credentials: Arc<Mutex<Option<DatasetSyncCredentials>>>,
    worker_task: Mutex<Option<JoinHandle<()>>>,
    worker_scheduled: AtomicBool,
    is_running: AtomicBool,
    local_files: AtomicUsize,
    // The bucket's files as this PC last saw them; its size is the remote file count.
    known_remote_keys: Mutex<HashSet<String>>,
    started: Instant,
    last_progress_notification: AtomicU64,
    status: Mutex<String>,
    state: watch::Sender<u64>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CameraDatasetSyncService {
    /// Call inside the tokio runtime: the background uploads run on it, whichever thread tracks a change later.
    pub fn new(paths: TrainingPaths, credential_store: Arc<DpapiSyncCredentialStore>) -> Result<Arc<Self>> {
        let credentials = Arc::new(Mutex::new(credential_store.load()));
        let root = paths.camera_imports_root.clone();
        Self::create(paths, credential_store, credentials, root, TRAINING_PREFIX, "dataset-sync.db")
    }

    /// The model benchmark's sync: camera/benchmark with BENCHMARK_PREFIX, its own catalogue, this one's connection.
    pub fn benchmark(&self) -> Result<Arc<Self>> {
        let root = self.paths.camera_benchmark_root.clone();
        Self::create(
            self.paths.clone(),
            self.credential_store.clone(),
            self.credentials.clone(),
            root,
            BENCHMARK_PREFIX,
            "benchmark-sync.db",
        )
    }

    fn create(
        paths: TrainingPaths,
        credential_store: Arc<DpapiSyncCredentialStore>,
        credentials: Arc<Mutex<Option<DatasetSyncCredentials>>>,
        root: PathBuf,
        prefix: &'static str,
        catalog_name: &str,
    ) -> Result<Arc<Self>> {
        let runtime = Handle::try_current().context("The dataset sync needs the tokio runtime.")?;
        let catalog = CameraDatasetSyncCatalog::new(&paths.camera_root.join(catalog_name))?;
        let known_remote_keys: HashSet<String> = catalog.synchronized_object_keys()?.into_iter().collect();
        let (state, _) = watch::channel(0u64);
        let service = Arc::new_cyclic(|this| Self {
            this: this.clone(),
            runtime,
            paths,
            root,
            prefix,
            files_prefix: format!("{prefix}files/"),
            tombstones_prefix: format!("{prefix}tombstones/"),
            credential_store,
            catalog,
            remote_gate: tokio::sync::Mutex::new(()),
            lifetime: CancellationToken::new(),
            credentials,
            worker_task: Mutex::new(None),
            worker_scheduled: AtomicBool::new(false),
            is_running: AtomicBool::new(false),
            local_files: AtomicUsize::new(0),
            known_remote_keys: Mutex::new(known_remote_keys),
            started: Instant::now(),
            last_progress_notification: AtomicU64::new(0),
            status: Mutex::new(NOT_CONFIGURED.into()),
            state,
        });
        if service.load_credentials().is_some() {
            service.set_status("Ready. Remote downloads run only when you choose Sync now.");
        }
        Ok(service)
    }

    /// Counts the local files and starts uploading what the queue holds. The window only: a headless command (where
    /// the C# Toolbox never built this service) must neither walk the photo library nor upload in the background.
    pub fn start(&self) {
        self.recount_local_files();
        if self.load_credentials().is_some() {
            // The benchmark's sync shares the training sync's connection, saved through the training sync.
            let mut status = lock(&self.status);
            if *status == NOT_CONFIGURED {
                *status = "Connection saved. Choose Sync now to merge this computer with the bucket.".into();
            }
            drop(status);
            self.raise_state_changed();
            self.schedule_worker();
        }
    }

    /// StateChanged: bumped whenever the snapshot may have changed.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.state.subscribe()
    }

    pub fn load_credentials(&self) -> Option<DatasetSyncCredentials> {
        lock(&self.credentials).clone()
    }

    /// The local folder this sync mirrors (camera/imports or camera/benchmark).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Whether a bucket object (a conflict's key) belongs to this sync.
    pub fn owns_key(&self, object_key: &str) -> bool {
        object_key.starts_with(self.prefix)
    }

    fn object_key(&self, relative_path: &str) -> String {
        format!("{}{}", self.files_prefix, relative_path.replace('\\', "/").trim_start_matches('/'))
    }

    fn tombstone_key(&self, object_key: &str) -> String {
        format!("{}{}.json", self.tombstones_prefix, hex::encode(Sha256::digest(object_key.as_bytes())))
    }

    pub fn save_credentials(&self, credentials: DatasetSyncCredentials) -> Result<()> {
        self.credential_store.save(&credentials)?;
        *lock(&self.credentials) = Some(credentials);
        self.set_status("Connection saved. Choose Sync now to merge this computer with the bucket.");
        self.raise_state_changed();
        self.schedule_worker();
        Ok(())
    }

    pub fn get_snapshot(&self) -> Result<DatasetSyncSnapshot> {
        let (pending, failed) = self.catalog.counts()?;
        Ok(DatasetSyncSnapshot {
            is_configured: self.load_credentials().is_some(),
            is_running: self.is_running.load(Ordering::SeqCst),
            local_files: self.local_files.load(Ordering::SeqCst),
            remote_files: lock(&self.known_remote_keys).len(),
            pending_uploads: pending,
            failed_operations: failed,
            conflict_count: self.catalog.conflict_count()?,
            last_successful_sync_utc: self.catalog.last_successful_sync_utc()?,
            status: lock(&self.status).clone(),
        })
    }

    pub fn get_conflicts(&self) -> Result<Vec<DatasetSyncConflict>> {
        self.catalog.conflicts()
    }

    pub async fn test_connection(
        &self,
        credentials: &DatasetSyncCredentials,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let remote = RailwayS3ObjectStore::new(credentials)?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Cancelled.into()),
            probe = tokio::time::timeout(CONNECTION_TEST_TIMEOUT, remote.probe(self.prefix)) => match probe {
                Ok(result) => result,
                Err(_) => bail!(
                    "The Railway bucket did not respond within {} seconds. \
                     Check the endpoint and URL style against the bucket Credentials tab.",
                    CONNECTION_TEST_TIMEOUT.as_secs()
                ),
            },
        }
    }

    pub fn track_upload(&self, path: impl AsRef<Path>) {
        self.track_uploads(&[path.as_ref()]);
    }

    /// Many files at once: one queue write and one local recount instead of one per file.
    pub fn track_uploads<P: AsRef<Path>>(&self, paths: &[P]) {
        if self.load_credentials().is_none() {
            return;
        }
        let files: Vec<&Path> =
            paths.iter().map(AsRef::as_ref).filter(|path| path.is_file() && is_dataset_file(path)).collect();
        if files.is_empty() {
            return;
        }
        let queued = files
            .iter()
            .map(|path| self.upload_operation(path))
            .collect::<Result<Vec<_>>>()
            .and_then(|operations| self.catalog.queue_many(&operations));
        match queued {
            Ok(()) => {
                self.recount_local_files();
                self.set_status("Local changes are waiting to upload.");
                self.raise_state_changed();
                self.schedule_worker();
            }
            Err(error) => {
                self.set_status(format!("Could not queue a dataset upload: {error:#}"));
                self.raise_state_changed();
            }
        }
    }

    pub fn track_tree(&self, root: impl AsRef<Path>) {
        let root = root.as_ref();
        if self.load_credentials().is_none() || !root.is_dir() {
            return;
        }
        let queued = walkdir::WalkDir::new(root)
            .into_iter()
            .map(|entry| -> Result<Option<QueuedOperation>> {
                let entry = entry?;
                if !entry.file_type().is_file() || !is_dataset_file(entry.path()) {
                    return Ok(None);
                }
                Ok(Some(self.upload_operation(entry.path())?))
            })
            .filter_map(Result::transpose)
            .collect::<Result<Vec<_>>>()
            .and_then(|operations| self.catalog.queue_many(&operations));
        match queued {
            Ok(()) => {
                self.recount_local_files();
                self.set_status("Imported dataset files are waiting to upload.");
                self.raise_state_changed();
                self.schedule_worker();
            }
            Err(error) => {
                self.set_status(format!("Could not queue the imported dataset: {error:#}"));
                self.raise_state_changed();
            }
        }
    }

    pub fn track_deletion(&self, path: impl AsRef<Path>) {
        if self.load_credentials().is_none() {
            return;
        }
        let path = path.as_ref();
        let queued = self.relative_path(path).and_then(|relative| {
            self.catalog.queue(&self.object_key(&relative), &relative, DatasetSyncOperation::Delete, None)
        });
        match queued {
            Ok(()) => {
                // The callers delete first; one file less beats walking the whole tree once per deleted file.
                if is_dataset_file(path) && !path.exists() {
                    let _ = self.local_files.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
                }
                self.set_status("Local deletions are waiting to synchronize.");
                self.raise_state_changed();
                self.schedule_worker();
            }
            Err(error) => {
                self.set_status(format!("Could not queue a dataset deletion: {error:#}"));
                self.raise_state_changed();
            }
        }
    }

    pub async fn process_pending(&self, cancel: &CancellationToken) -> Result<()> {
        let Some(credentials) = self.load_credentials() else {
            return Ok(());
        };
        let _gate = self.acquire_remote_gate(cancel).await?;
        let result = async {
            self.set_running(true, Some("Uploading pending local dataset changes…".into()));
            let remote = RailwayS3ObjectStore::new(&credentials)?;
            self.process_pending_core(&remote, false, cancel).await?;
            let (pending, _) = self.catalog.counts()?;
            self.set_status(if pending == 0 {
                "All local changes are uploaded. Remote downloads run only with Sync now.".to_string()
            } else {
                format!("{} dataset operations are waiting to retry.", n0(pending))
            });
            Ok(())
        }
        .await;
        self.set_running(false, None);
        result
    }

    pub async fn sync_now(&self, cancel: &CancellationToken) -> Result<DatasetSyncResult> {
        let credentials = self
            .load_credentials()
            .ok_or_else(|| anyhow!("Save the Railway bucket connection before synchronizing."))?;
        let (sync_cancel, _linked) = self.linked_with_lifetime(cancel);
        let _gate = self.acquire_remote_gate(&sync_cancel).await?;
        let result = self.sync_core(&credentials, &sync_cancel).await;
        // Otherwise the status stays at the phase that failed ("Reading the remote dataset inventory…"), and the
        // page's snapshot shows that in place of the failure.
        if let Err(error) = &result
            && !is_cancelled(error)
        {
            self.set_status(format!("Sync failed: {}", self.safe_error(error)));
        }
        self.set_running(false, None);
        result
    }

    async fn sync_core(
        &self,
        credentials: &DatasetSyncCredentials,
        cancel: &CancellationToken,
    ) -> Result<DatasetSyncResult> {
        self.set_running(true, Some("Synchronizing the camera dataset…".into()));
        // Even empty: the artwork trainer reads the benchmark's cards from its folder, and stops without one.
        std::fs::create_dir_all(&self.root)?;
        self.recount_local_files();
        let remote = RailwayS3ObjectStore::new(credentials)?;
        let mut uploaded = self.process_pending_core(&remote, true, cancel).await?;
        let mut errors = Vec::new();
        let (mut downloaded, mut deleted, mut conflicts) = (0, 0, 0);

        self.set_running(true, Some("Reading the remote dataset inventory…".into()));
        let known_remote = self.catalog.remote_hashes()?;
        let known_sha256: &(dyn Fn(&str, Option<&str>, i64) -> Option<String> + Sync) = &|key, etag, size| {
            known_remote
                .get(key)
                .filter(|known| Some(known.0.as_str()) == etag && known.1 == size)
                .map(|known| known.2.clone())
        };
        let report: &(dyn Fn(usize, usize) + Sync) =
            &|completed, total| self.report_phase_progress("Reading remote file details", completed, total);
        let remote_objects = remote.list(self.prefix, Some(known_sha256), Some(report), cancel).await?;
        self.catalog.set_remote_hashes(&known_remote, &remote_objects)?;
        let local_hashes_at_start = self.catalog.local_hashes()?;
        let mut local_hashes = local_hashes_at_start.clone();
        let mut remote_files: BTreeMap<String, RemoteDatasetObject> = remote_objects
            .iter()
            .filter(|item| item.key.starts_with(&self.files_prefix))
            .map(|item| (item.key.clone(), item.clone()))
            .collect();
        *lock(&self.known_remote_keys) = remote_files.keys().cloned().collect();
        // An upload still queued (it failed above) is a local change made after the deletion: keep the file for the
        // retry, whose upload removes the tombstone, instead of deleting it.
        let queued_uploads: HashSet<String> = self
            .catalog
            .pending(true)?
            .into_iter()
            .filter(|operation| operation.operation == DatasetSyncOperation::Upload)
            .map(|operation| operation.object_key)
            .collect();
        let mut tombstones = self.load_tombstones(&remote, &remote_objects, cancel).await?;
        tombstones.retain(|key, _| !queued_uploads.contains(key));
        self.raise_state_changed();

        for tombstone in tombstones.values() {
            check(cancel)?;
            let local_path = self.local_path_from_key(&tombstone.object_key)?;
            if local_path.is_file() {
                std::fs::remove_file(&local_path)?;
                let _ = self
                    .local_files
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |count| Some(count.saturating_sub(1)));
                deleted += 1;
            }
            self.catalog.set_synchronized(&tombstone.object_key, &tombstone_marker(&tombstone.deleted_utc))?;
            if remote_files.contains_key(&tombstone.object_key) {
                remote.delete(&tombstone.object_key, cancel).await?;
                remote_files.remove(&tombstone.object_key);
                self.record_remote_presence(&tombstone.object_key, false);
            }
        }

        let local_files = self
            .enumerate_local_files()
            .into_iter()
            .map(|path| Ok((self.object_key(&self.relative_path(&path)?), path)))
            .collect::<Result<Vec<_>>>()?;
        let total = remote_files.len();
        for (index, remote_info) in remote_files.values().enumerate() {
            check(cancel)?;
            self.report_phase_progress("Comparing local and remote files", index + 1, total);
            let mut material = None;
            // A key this PC can't map to a file, or a local copy it can't read, fails that file, not the whole sync.
            let outcome = async {
                let local_path = self.local_path_from_key(&remote_info.key)?;
                if local_path.is_file()
                    && let Some(advertised) = remote_info.sha256.as_deref().filter(|sha| !sha.is_empty())
                {
                    let existing = self.local_sha256(&local_path, &mut local_hashes, cancel)?;
                    if existing.eq_ignore_ascii_case(advertised) {
                        self.catalog.set_synchronized(&remote_info.key, &existing)?;
                        return Ok(Reconciled::Unchanged);
                    }
                }
                self.reconcile(&remote, remote_info, &local_path, &mut local_hashes, &mut material, cancel).await
            }
            .await;
            if let Some(material) = &material {
                try_delete(&material.path);
            }
            match outcome {
                Ok(Reconciled::Downloaded) => downloaded += 1,
                Ok(Reconciled::Conflict) => conflicts += 1,
                Ok(Reconciled::Unchanged) => {}
                Err(error) if is_item_error(&error) => errors.push(format!("{}: {error:#}", remote_info.key)),
                Err(error) => return Err(error),
            }
        }

        let missing_remote = local_files
            .iter()
            .filter(|(key, _)| !remote_files.contains_key(key) && !tombstones.contains_key(key))
            .map(|(key, path)| Ok((key.clone(), self.relative_path(path)?, DatasetSyncOperation::Upload, None)))
            .collect::<Result<Vec<_>>>()?;
        self.catalog.queue_many(&missing_remote)?;
        let still_local: LocalHashes =
            local_hashes.into_iter().filter(|(relative, _)| self.root.join(relative).is_file()).collect();
        self.catalog.set_local_hashes(&local_hashes_at_start, &still_local)?;
        uploaded += self.process_pending_core(&remote, true, cancel).await?;

        if errors.is_empty() {
            self.catalog.set_last_successful_sync_utc(Some(Utc::now()))?;
        }
        let (remaining, _) = self.catalog.counts()?;
        self.set_status(if !errors.is_empty() {
            format!("Sync finished with {} errors.", n0(errors.len()))
        } else if conflicts > 0 {
            format!("Sync preserved {} conflicts for review.", n0(conflicts))
        } else if remaining > 0 {
            format!("Sync finished; {} operations still need retrying.", n0(remaining))
        } else {
            "Sync complete. This computer is safe to switch from.".to_string()
        });
        Ok(DatasetSyncResult { uploaded, downloaded, deleted, conflicts, errors })
    }

    /// One remote file that is missing here or differs from the local copy. `material` holds the downloaded copy
    /// until the caller deletes whatever is left of it.
    async fn reconcile(
        &self,
        remote: &RailwayS3ObjectStore,
        remote_info: &RemoteDatasetObject,
        local_path: &Path,
        local_hashes: &mut LocalHashes,
        material: &mut Option<RemoteMaterial>,
        cancel: &CancellationToken,
    ) -> Result<Reconciled> {
        let remote_material = material.insert(self.materialize_remote(remote, remote_info, cancel).await?);
        if !local_path.is_file() {
            validate_downloaded_file(local_path, &remote_material.path)?;
            move_file(&remote_material.path, local_path, false)?;
            self.catalog.set_synchronized(&remote_info.key, &remote_material.sha256)?;
            self.local_files.fetch_add(1, Ordering::SeqCst);
            return Ok(Reconciled::Downloaded);
        }

        let local_sha = self.local_sha256(local_path, local_hashes, cancel)?;
        if local_sha.eq_ignore_ascii_case(&remote_material.sha256) {
            self.catalog.set_synchronized(&remote_info.key, &local_sha)?;
            return Ok(Reconciled::Unchanged);
        }

        let baseline = self.catalog.synchronized_sha(&remote_info.key)?;
        match baseline {
            Some(baseline) if baseline.eq_ignore_ascii_case(&local_sha) => {
                validate_downloaded_file(local_path, &remote_material.path)?;
                move_file(&remote_material.path, local_path, true)?;
                self.catalog.set_synchronized(&remote_info.key, &remote_material.sha256)?;
                Ok(Reconciled::Downloaded)
            }
            Some(baseline) if baseline.eq_ignore_ascii_case(&remote_material.sha256) => {
                self.catalog.queue(
                    &remote_info.key,
                    &self.relative_path(local_path)?,
                    DatasetSyncOperation::Upload,
                    Some(&local_sha),
                )?;
                Ok(Reconciled::Unchanged)
            }
            _ => {
                self.preserve_conflict(&remote_info.key, local_path, &local_sha, remote_material)?;
                Ok(Reconciled::Conflict)
            }
        }
    }

    pub async fn keep_local(&self, object_key: &str, cancel: &CancellationToken) -> Result<()> {
        let conflict = self
            .catalog
            .conflicts()?
            .into_iter()
            .find(|item| item.object_key == object_key)
            .ok_or_else(|| anyhow!("The selected sync conflict no longer exists."))?;
        let credentials = self.load_credentials().ok_or_else(|| anyhow!(NOT_CONFIGURED))?;
        let local_path = self.local_path_from_key(object_key)?;
        if !local_path.is_file() {
            bail!("The local conflict file no longer exists.");
        }
        let gate = self.acquire_remote_gate(cancel).await?;
        let result = async {
            let remote = RailwayS3ObjectStore::new(&credentials)?;
            let hashed = local_path.clone();
            let token = cancel.clone();
            let sha = tokio::task::spawn_blocking(move || sha256_file(&hashed, &token)).await??;
            remote.upload(object_key, &local_path, &sha, cancel).await?;
            remote.delete(&self.tombstone_key(object_key), cancel).await?;
            self.catalog.set_synchronized(object_key, &sha)?;
            self.record_remote_presence(object_key, true);
            self.catalog.remove_conflict(object_key)?;
            try_delete(&conflict.remote_copy_path);
            self.set_status("Conflict resolved by keeping the local copy.");
            Ok(())
        }
        .await;
        drop(gate);
        self.raise_state_changed();
        result
    }

    pub async fn keep_remote(&self, object_key: &str, cancel: &CancellationToken) -> Result<()> {
        let conflict = self
            .catalog
            .conflicts()?
            .into_iter()
            .find(|item| item.object_key == object_key)
            .ok_or_else(|| anyhow!("The selected sync conflict no longer exists."))?;
        let gate = self.acquire_remote_gate(cancel).await?;
        let result = (|| -> Result<()> {
            check(cancel)?;
            let local_path = self.local_path_from_key(object_key)?;
            validate_downloaded_file(&local_path, &conflict.remote_copy_path)?;
            move_file(&conflict.remote_copy_path, &local_path, true)?;
            self.catalog.set_synchronized(object_key, &conflict.remote_sha256)?;
            self.catalog.remove_conflict(object_key)?;
            self.set_status("Conflict resolved by keeping the remote copy.");
            Ok(())
        })();
        drop(gate);
        self.raise_state_changed();
        result
    }

    /// DisposeAsync: stops the background uploads and waits for whatever holds the bucket to finish.
    pub async fn shutdown(&self) {
        self.lifetime.cancel();
        let worker = lock(&self.worker_task).take();
        if let Some(worker) = worker {
            let _ = worker.await;
        }
        let _ = self.remote_gate.lock().await;
    }

    // A file whose size and write time match the last hash taken of it is not read again.
    fn local_sha256(&self, path: &Path, cache: &mut LocalHashes, cancel: &CancellationToken) -> Result<String> {
        let info = std::fs::metadata(path)?;
        let relative = self.relative_path(path)?;
        let length = info.len() as i64;
        let ticks = crate::camera_annotation_store::ticks(info.modified()?);
        if let Some(known) = cache.get(&relative)
            && known.0 == length
            && known.1 == ticks
        {
            return Ok(known.2.clone());
        }
        let sha = sha256_file(path, cancel)?;
        cache.insert(relative, (length, ticks, sha.clone()));
        Ok(sha)
    }

    async fn process_pending_core(
        &self,
        remote: &RailwayS3ObjectStore,
        include_deferred: bool,
        cancel: &CancellationToken,
    ) -> Result<usize> {
        let completed = AtomicUsize::new(0);
        let operations = self.catalog.pending(include_deferred)?;
        futures::stream::iter(operations.into_iter().map(anyhow::Ok))
            .try_for_each_concurrent(MAXIMUM_PARALLEL_TRANSFERS, |operation| {
                let completed = &completed;
                async move { self.process_operation(remote, operation, completed, cancel).await }
            })
            .await?;
        Ok(completed.into_inner())
    }

    async fn process_operation(
        &self,
        remote: &RailwayS3ObjectStore,
        operation: PendingDatasetOperation,
        completed: &AtomicUsize,
        cancel: &CancellationToken,
    ) -> Result<()> {
        check(cancel)?;
        let key = operation.object_key.as_str();
        let transferred: Result<bool> = async {
            match operation.operation {
                DatasetSyncOperation::Upload => {
                    let path = self.root.join(&operation.relative_path);
                    if !path.is_file() {
                        self.catalog.queue(key, &operation.relative_path, DatasetSyncOperation::Delete, None)?;
                        return Ok(false);
                    }
                    // Off the task: try_for_each_concurrent polls every transfer on it, so an inline hash would stall them.
                    let hashed = path.clone();
                    let token = cancel.clone();
                    let sha = tokio::task::spawn_blocking(move || sha256_file(&hashed, &token)).await??;
                    remote.upload(key, &path, &sha, cancel).await?;
                    remote.delete(&self.tombstone_key(key), cancel).await?;
                    if !self.catalog.complete(&operation, Some(&sha))? {
                        return Ok(false);
                    }
                    self.record_remote_presence(key, true);
                }
                DatasetSyncOperation::Delete => {
                    let tombstone =
                        DatasetTombstone { schema_version: 1, object_key: key.to_string(), deleted_utc: Utc::now() };
                    let content = serde_json::to_vec(&tombstone)?;
                    let sha = hex::encode(Sha256::digest(&content));
                    remote.upload_bytes(&self.tombstone_key(key), content, &sha, cancel).await?;
                    remote.delete(key, cancel).await?;
                    if !self.catalog.complete(&operation, None)? {
                        return Ok(false);
                    }
                    self.record_remote_presence(key, false);
                }
            }
            completed.fetch_add(1, Ordering::SeqCst);
            self.report_transfer_progress();
            Ok(true)
        }
        .await;
        match transferred {
            Ok(_) => Ok(()),
            Err(error) if is_cancelled(&error) && cancel.is_cancelled() => Err(error),
            Err(error) => self.catalog.fail(&operation, &self.safe_error(&error)),
        }
    }

    fn record_remote_presence(&self, object_key: &str, exists: bool) {
        let mut keys = lock(&self.known_remote_keys);
        if exists {
            keys.insert(object_key.to_string());
        } else {
            keys.remove(object_key);
        }
    }

    /// Environment.TickCount64 for the throttle: milliseconds, never 0 once taken.
    fn now_ticks(&self) -> u64 {
        self.started.elapsed().as_millis() as u64 + 1
    }

    fn report_transfer_progress(&self) {
        let now = self.now_ticks();
        let previous = self.last_progress_notification.load(Ordering::SeqCst);
        if previous != 0 && now - previous.min(now) < 100 {
            return;
        }
        self.last_progress_notification.store(now, Ordering::SeqCst);
        let pending = self.catalog.counts().map(|counts| counts.0).unwrap_or(0);
        self.set_status(if pending > 0 {
            format!("Uploading camera dataset files… {} remaining.", n0(pending))
        } else {
            "Finishing dataset synchronization…".to_string()
        });
        self.raise_state_changed();
    }

    fn report_phase_progress(&self, phase: &str, completed: usize, total: usize) {
        let now = self.now_ticks();
        let previous = self.last_progress_notification.load(Ordering::SeqCst);
        if completed < total && previous != 0 && now - previous.min(now) < 100 {
            return;
        }
        self.last_progress_notification.store(now, Ordering::SeqCst);
        self.set_status(if total == 0 {
            format!("{phase}… none found.")
        } else {
            format!("{phase}… {} of {}.", n0(completed), n0(total))
        });
        self.raise_state_changed();
    }

    async fn load_tombstones(
        &self,
        remote: &RailwayS3ObjectStore,
        objects: &[RemoteDatasetObject],
        cancel: &CancellationToken,
    ) -> Result<BTreeMap<String, DatasetTombstone>> {
        let mut result = BTreeMap::new();
        // Tombstones never change once written, so only new ones (by ETag) are downloaded.
        let cached = self.catalog.cached_tombstones()?;
        let mut seen = HashMap::new();
        for item in objects.iter().filter(|item| item.key.starts_with(&self.tombstones_prefix)) {
            let temporary = temporary_path()?;
            let loaded: Result<()> = async {
                let etag = item.etag.as_deref().filter(|etag| !etag.is_empty());
                let content = match (etag, cached.get(&item.key)) {
                    (Some(etag), Some(known)) if known.0 == etag => known.1.clone(),
                    _ => match remote.download(&item.key, &temporary, cancel).await {
                        // Its file was uploaded again since the listing, which removes the tombstone: nothing to apply.
                        Err(error) if is_not_found(&error) => return Ok(()),
                        downloaded => {
                            downloaded?;
                            tokio::fs::read(&temporary).await?
                        }
                    },
                };
                if let Some(etag) = etag {
                    seen.insert(item.key.clone(), (etag.to_string(), content.clone()));
                }
                match serde_json::from_slice::<Option<DatasetTombstone>>(strip_bom(&content)) {
                    // One whose key maps to no file here is ignored: applying it would stop every sync.
                    Ok(Some(tombstone))
                        if tombstone.schema_version == 1
                            && tombstone.object_key.starts_with(&self.files_prefix)
                            && self.local_path_from_key(&tombstone.object_key).is_ok() =>
                    {
                        result.insert(tombstone.object_key.clone(), tombstone);
                    }
                    Ok(_) => {}
                    Err(_) => self.set_status(format!("Ignored an invalid remote tombstone: {}", item.key)),
                }
                Ok(())
            }
            .await;
            try_delete(&temporary);
            loaded?;
        }
        self.catalog.set_cached_tombstones(&cached, &seen)?;
        Ok(result)
    }

    async fn materialize_remote(
        &self,
        remote: &RailwayS3ObjectStore,
        item: &RemoteDatasetObject,
        cancel: &CancellationToken,
    ) -> Result<RemoteMaterial> {
        let temporary = temporary_path()?;
        // A failed or cancelled download leaves no material for the caller to clean up.
        let computed =
            match remote.download(&item.key, &temporary, cancel).await.and_then(|()| sha256_file(&temporary, cancel)) {
                Ok(computed) => computed,
                Err(error) => {
                    try_delete(&temporary);
                    return Err(error);
                }
            };
        if let Some(advertised) = &item.sha256
            && !advertised.eq_ignore_ascii_case(&computed)
        {
            try_delete(&temporary);
            return Err(invalid_data(format!("Remote hash metadata does not match {}.", item.key)));
        }
        Ok(RemoteMaterial { path: temporary, sha256: computed })
    }

    fn preserve_conflict(&self, key: &str, local_path: &Path, local_sha: &str, remote: &RemoteMaterial) -> Result<()> {
        let relative = self.relative_path(local_path)?;
        let conflict_root =
            self.paths.camera_root.join("sync-conflicts").join(Utc::now().format("%Y%m%d-%H%M%S%3f").to_string());
        let destination = conflict_root.join(format!("{relative}.remote"));
        move_file(&remote.path, &destination, false)?;
        self.catalog.add_conflict(&DatasetSyncConflict {
            object_key: key.to_string(),
            relative_path: relative,
            remote_copy_path: destination,
            local_sha256: local_sha.to_string(),
            remote_sha256: remote.sha256.clone(),
            created_utc: Utc::now(),
        })
    }

    /// The dataset files below camera/imports, unordered (a missing root yields none).
    fn local_dataset_files(&self) -> impl Iterator<Item = walkdir::DirEntry> {
        walkdir::WalkDir::new(&self.root)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file() && is_dataset_file(entry.path()))
    }

    fn enumerate_local_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = self.local_dataset_files().map(walkdir::DirEntry::into_path).collect();
        files.sort_by_cached_key(|path| path.to_string_lossy().to_uppercase());
        files
    }

    // Runs after every tracked save: a count, without collecting and sorting the whole library.
    fn recount_local_files(&self) {
        self.local_files.store(self.local_dataset_files().count(), Ordering::SeqCst);
    }

    fn upload_operation(&self, path: &Path) -> Result<QueuedOperation> {
        let relative = self.relative_path(path)?;
        Ok((self.object_key(&relative), relative, DatasetSyncOperation::Upload, None))
    }

    /// The path below camera/imports with Windows separators, as the catalogue stores it.
    fn relative_path(&self, path: &Path) -> Result<String> {
        let full = std::path::absolute(path)?;
        match strip_root(&full, &self.root)? {
            Some(relative) => Ok(relative),
            None => bail!("Only files inside the camera imports directory can be synchronized."),
        }
    }

    fn local_path_from_key(&self, key: &str) -> Result<PathBuf> {
        let Some(relative) = key.strip_prefix(self.files_prefix.as_str()) else {
            return Err(invalid_data("The remote object key is outside the Deckino dataset prefix."));
        };
        let relative = relative.replace('/', "\\");
        let segments: Vec<&str> = relative.split('\\').filter(|segment| !segment.is_empty()).collect();
        if segments.is_empty()
            || segments
                .iter()
                .any(|segment| *segment == "." || *segment == ".." || segment.chars().any(is_invalid_file_name_char))
        {
            return Err(invalid_data("The remote object key contains an invalid Windows path."));
        }
        let candidate = std::path::absolute(self.root.join(&relative))?;
        if strip_root(&candidate, &self.root)?.is_none() {
            return Err(invalid_data("The remote object key attempts to escape the camera imports directory."));
        }
        Ok(candidate)
    }

    fn schedule_worker(&self) {
        if self.worker_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(this) = self.this.upgrade() else {
            self.worker_scheduled.store(false, Ordering::SeqCst);
            return;
        };
        let worker = self.runtime.spawn(this.run_worker());
        *lock(&self.worker_task) = Some(worker);
    }

    async fn run_worker(self: Arc<Self>) {
        let lifetime = self.lifetime.clone();
        let processed = async {
            tokio::select! {
                biased;
                _ = lifetime.cancelled() => return Err(Cancelled.into()),
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
            self.process_pending(&lifetime).await
        }
        .await;
        match processed {
            Err(error) if is_cancelled(&error) && lifetime.is_cancelled() => {}
            Err(error) => {
                self.set_status(format!("Automatic dataset upload failed: {}", self.safe_error(&error)));
                self.raise_state_changed();
            }
            Ok(()) => {}
        }
        self.worker_scheduled.store(false, Ordering::SeqCst);
        if !lifetime.is_cancelled() && self.catalog.counts().map(|counts| counts.0 > 0).unwrap_or(false) {
            tokio::select! {
                _ = lifetime.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_secs(10)) => {}
            }
            if !lifetime.is_cancelled() {
                self.schedule_worker();
            }
        }
    }

    /// SemaphoreSlim.WaitAsync(cancel): one bucket job at a time.
    async fn acquire_remote_gate(&self, cancel: &CancellationToken) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Cancelled.into()),
            gate = self.remote_gate.lock() => Ok(gate),
        }
    }

    /// CreateLinkedTokenSource(cancel, lifetime): cancelled by either; the guard ends the link.
    fn linked_with_lifetime(&self, cancel: &CancellationToken) -> (CancellationToken, DropGuard) {
        let linked = self.lifetime.child_token();
        let (watched, outer) = (linked.clone(), cancel.clone());
        self.runtime.spawn(async move {
            tokio::select! {
                _ = outer.cancelled() => watched.cancel(),
                _ = watched.cancelled() => {}
            }
        });
        (linked.clone(), linked.drop_guard())
    }

    /// SetRunning: `status` None keeps the current one.
    fn set_running(&self, value: bool, status: Option<String>) {
        self.is_running.store(value, Ordering::SeqCst);
        if let Some(status) = status {
            self.set_status(status);
        }
        self.raise_state_changed();
    }

    fn set_status(&self, status: impl Into<String>) {
        *lock(&self.status) = status.into();
    }

    fn raise_state_changed(&self) {
        self.state.send_modify(|version| *version = version.wrapping_add(1));
    }

    /// The error's message without the bucket's keys.
    fn safe_error(&self, error: &anyhow::Error) -> String {
        let mut message = format!("{error:#}");
        if let Some(credentials) = self.load_credentials() {
            if !credentials.secret_access_key.is_empty() {
                message = message.replace(&credentials.secret_access_key, "[redacted]");
            }
            if !credentials.access_key_id.is_empty() {
                message = message.replace(&credentials.access_key_id, "[redacted]");
            }
        }
        message
    }
}

fn tombstone_marker(timestamp: &DateTime<Utc>) -> String {
    format!("deleted:{}", round_trip(timestamp))
}

pub(crate) fn is_dataset_file(path: &Path) -> bool {
    let name = path.file_name().map(|name| name.to_string_lossy().to_lowercase()).unwrap_or_default();
    let extension = name.rfind('.').map(|index| &name[index..]).unwrap_or("");
    IMAGE_EXTENSIONS.contains(&extension)
        || name.ends_with("._annotations.json")
        || name.ends_with("._identity.json")
        || name == ".deckino-import.json"
}

/// Path.GetInvalidFileNameChars on Windows.
pub(crate) fn is_invalid_file_name_char(c: char) -> bool {
    c < ' ' || matches!(c, '"' | '<' | '>' | '|' | ':' | '*' | '?' | '\\' | '/')
}

/// The rest of `full` below `root` (compared case-insensitively, like Windows), or None when it is not inside.
fn strip_root(full: &Path, root: &Path) -> Result<Option<String>> {
    let root = std::path::absolute(root)?;
    let root = format!("{}\\", root.to_string_lossy().trim_end_matches('\\'));
    let full = full.to_string_lossy();
    let mut characters = full.char_indices();
    for expected in root.chars() {
        match characters.next() {
            Some((_, actual)) if actual.to_lowercase().eq(expected.to_lowercase()) => {}
            _ => return Ok(None),
        }
    }
    Ok(Some(full[characters.offset()..].to_string()))
}

/// The errors one remote file may fail with while the rest of the sync goes on: IOException, JsonException and
/// InvalidDataException in the C# Toolbox.
fn is_item_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<io::Error>().is_some()
        || error.downcast_ref::<serde_json::Error>().is_some()
        || error.downcast_ref::<InvalidData>().is_some()
}

fn validate_downloaded_file(destination: &Path, temporary: &Path) -> Result<()> {
    let destination_name = destination.to_string_lossy().to_lowercase();
    if !destination_name.ends_with(".json") {
        return Ok(());
    }
    let bytes = std::fs::read(temporary)?;
    let content = strip_bom(&bytes);
    let document: serde_json::Value = serde_json::from_slice(content)?;
    if !document.is_object() {
        return Err(invalid_data("The downloaded JSON file does not contain an object."));
    }
    if destination_name.ends_with("._annotations.json") {
        let annotation: CardAnnotation = serde_json::from_slice(content)?;
        if !CameraAnnotationStore::is_valid(&annotation) {
            return Err(invalid_data("The downloaded annotation is not valid."));
        }
    } else if destination_name.ends_with("._identity.json") {
        let identity: CardIdentity = serde_json::from_slice(content)?;
        if !CameraAnnotationStore::is_valid_identity(&identity) {
            return Err(invalid_data("The downloaded card identity is not valid."));
        }
    } else if destination.file_name().is_some_and(|name| name.eq_ignore_ascii_case(".deckino-import.json")) {
        // Read only to prove it parses: a descriptor that does not is refused like the C# Toolbox refuses it.
        let _: CameraImportDescriptor = serde_json::from_slice(content)?;
    }
    Ok(())
}

/// File.Move: also across volumes (the download folder is on the system drive, the data may not be). Across volumes
/// the copy lands beside the destination first, so a reader never sees half a file and a failed copy leaves the
/// local one intact; `overwrite: false` fails atomically when the destination appeared meanwhile.
fn move_file(source: &Path, destination: &Path, overwrite: bool) -> io::Result<()> {
    use crate::camera_annotation_store::{move_file as move_on_volume, with_suffix};
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match move_on_volume(source, destination, overwrite) {
        // ERROR_NOT_SAME_DEVICE
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices || error.raw_os_error() == Some(17) => {
            let temporary = with_suffix(destination, &format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
            let moved =
                std::fs::copy(source, &temporary).and_then(|_| move_on_volume(&temporary, destination, overwrite));
            if temporary.exists() {
                let _ = std::fs::remove_file(&temporary);
            }
            moved?;
            // Moved; a leftover download is the caller's to remove, as on one volume.
            let _ = std::fs::remove_file(source);
            Ok(())
        }
        result => result,
    }
}

fn temporary_path() -> Result<PathBuf> {
    let root = std::env::temp_dir().join("deckino-dataset-sync");
    std::fs::create_dir_all(&root)?;
    Ok(root.join(format!("{}.download", uuid::Uuid::new_v4().simple())))
}

fn try_delete(path: &Path) {
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
}
