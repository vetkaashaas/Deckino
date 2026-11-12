use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, bail};
use tokio_util::sync::CancellationToken;

use crate::coordinator::WorkspaceOperationCoordinator;
use crate::credentials::DpapiSyncCredentialStore;
use crate::object_store::RailwayS3ObjectStore;
use crate::paths::TrainingPaths;
use crate::training_result_exporter::{TrainingResultExporter, is_safe_model_version, sha256_file};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BucketTrainingRun {
    pub kind: String,
    pub model_version: String,
    pub bytes: i64,
}

impl BucketTrainingRun {
    pub fn new(kind: impl Into<String>, model_version: impl Into<String>, bytes: i64) -> Self {
        Self { kind: kind.into(), model_version: model_version.into(), bytes }
    }

    pub fn key(&self) -> String {
        format!("{}{}/{}.zip", TrainingRunSyncService::PREFIX, self.kind, self.model_version)
    }

    /// The deletion marker: an empty object every PC reads, so the run's copies go everywhere and nothing uploads it
    /// again.
    fn deleted_key(&self) -> String {
        format!("{}{}/{}", TrainingRunSyncService::DELETED_PREFIX, self.kind, self.model_version)
    }
}

/// The run list: what the bucket holds, and the runs only this PC has (never uploaded: older than the bucket, or not
/// the newest of their kind).
pub struct TrainingRunListing {
    pub in_bucket: Vec<BucketTrainingRun>,
    pub local_only: Vec<BucketTrainingRun>,
}

// Training runs move between PCs through the dataset bucket instead of copied ZIPs: a finished run uploads the same
// checksummed bundle the imports already take (training-runs/<kind>/<version>.zip), and any PC lists them and pulls
// one down, which imports it and makes it the current model there. Agents can read a run from the bucket the same way.
pub struct TrainingRunSyncService {
    paths: TrainingPaths,
    credentials: Arc<DpapiSyncCredentialStore>,
    exporter: Arc<TrainingResultExporter>,
    coordinator: WorkspaceOperationCoordinator,
    latest_extraction_run: Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

impl TrainingRunSyncService {
    pub const PREFIX: &str = "training-runs/";
    pub const DELETED_PREFIX: &str = "training-runs/deleted/";
    pub const ARTWORK_KIND: &str = "artwork";
    pub const EXTRACTION_KIND: &str = "extraction";

    pub fn new(
        paths: TrainingPaths,
        credentials: Arc<DpapiSyncCredentialStore>,
        exporter: Arc<TrainingResultExporter>,
        coordinator: WorkspaceOperationCoordinator,
        latest_extraction_run: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Self {
        Self { paths, credentials, exporter, coordinator, latest_extraction_run }
    }

    pub fn is_configured(&self) -> bool {
        self.credentials.load().is_some()
    }

    pub async fn upload(
        &self,
        kind: &str,
        model_version: &str,
        zip_path: &Path,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let run = BucketTrainingRun::new(kind, model_version, std::fs::metadata(zip_path)?.len() as i64);
        let store = RailwayS3ObjectStore::connect(&self.credentials)?;
        let path = zip_path.to_path_buf();
        let token = cancel.clone();
        let sha256 = tokio::task::spawn_blocking(move || sha256_file(&path, &token)).await??;
        store.upload(&run.key(), zip_path, &sha256, cancel).await
    }

    /// Uploads the newest finished run of each kind when the bucket doesn't have it: its upload failed, it finished
    /// before the bucket was connected, or it was trained before runs went through the bucket. Older runs stay local.
    pub async fn upload_missing(&self, cancel: &CancellationToken) -> Result<Vec<String>> {
        if !self.is_configured() {
            return Ok(Vec::new());
        }
        let (runs, deleted) = self.bucket_runs(cancel).await?;
        // A run deleted on any PC counts as there: this PC may still hold it as its current model.
        let in_bucket: HashSet<String> = runs.iter().chain(&deleted).map(BucketTrainingRun::key).collect();
        let mut uploaded = Vec::new();
        // Packing reads the run, so it holds the workspace lease (a pull or a run must not change it meanwhile); the
        // upload only reads the packed ZIP and runs without it. A busy workspace fails this, and the next start retries.
        if let Some(artwork) = self.exporter.resolve_packable_artwork_model()
            && !in_bucket.contains(&BucketTrainingRun::new(Self::ARTWORK_KIND, artwork.as_str(), 0).key())
        {
            let zip_path = {
                let _lease = self.coordinator.acquire("pack a training run")?;
                self.exporter.pack_artwork_for_other_pcs(Some(&artwork), cancel).await?
            };
            self.upload(Self::ARTWORK_KIND, &artwork, &zip_path, cancel).await?;
            uploaded.push(artwork);
        }
        if let Some(extraction) = (self.latest_extraction_run)()
            && !in_bucket.contains(&BucketTrainingRun::new(Self::EXTRACTION_KIND, extraction.as_str(), 0).key())
        {
            let zip_path = {
                let _lease = self.coordinator.acquire("pack a training run")?;
                self.exporter.export_extraction_handoff(&extraction, cancel).await?
            };
            self.upload(Self::EXTRACTION_KIND, &extraction, &zip_path, cancel).await?;
            uploaded.push(extraction);
        }
        Ok(uploaded)
    }

    /// Every run in the bucket and every one only this PC has, newest first; deleted runs left out.
    pub async fn list(&self, cancel: &CancellationToken) -> Result<TrainingRunListing> {
        let (mut in_bucket, deleted) = self.bucket_runs(cancel).await?;
        let known: HashSet<String> = in_bucket.iter().chain(&deleted).map(BucketTrainingRun::key).collect();
        let mut local_only: Vec<BucketTrainingRun> =
            self.local_runs().into_iter().filter(|run| !known.contains(&run.key())).collect();
        for runs in [&mut in_bucket, &mut local_only] {
            runs.sort_by(|a, b| run_timestamp(&b.model_version).cmp(run_timestamp(&a.model_version)));
        }
        Ok(TrainingRunListing { in_bucket, local_only })
    }

    /// (the runs in the bucket, the runs deleted). A run whose marker is written but whose ZIP is still there (its
    /// delete failed) counts as deleted.
    async fn bucket_runs(
        &self,
        cancel: &CancellationToken,
    ) -> Result<(Vec<BucketTrainingRun>, Vec<BucketTrainingRun>)> {
        let store = RailwayS3ObjectStore::connect(&self.credentials)?;
        // A known hash for every object: the list needs no metadata request per run.
        let known = |_: &str, _: Option<&str>, _: i64| Some(String::new());
        let objects = store.list(Self::PREFIX, Some(&known), None, cancel).await?;
        let (mut runs, mut deleted) = (Vec::new(), Vec::new());
        for item in objects {
            let parts: Vec<&str> = item.key[Self::PREFIX.len()..].split('/').collect();
            // The version names the local download (incoming/<kind>-<version>.zip): one with a path in it is skipped.
            match parts.as_slice() {
                [kind @ (Self::ARTWORK_KIND | Self::EXTRACTION_KIND), name]
                    if name.strip_suffix(".zip").is_some_and(is_safe_model_version) =>
                {
                    runs.push(BucketTrainingRun::new(*kind, &name[..name.len() - 4], item.size));
                }
                ["deleted", kind @ (Self::ARTWORK_KIND | Self::EXTRACTION_KIND), version]
                    if is_safe_model_version(version) =>
                {
                    deleted.push(BucketTrainingRun::new(*kind, *version, 0));
                }
                _ => {}
            }
        }
        let gone: HashSet<String> = deleted.iter().map(BucketTrainingRun::key).collect();
        runs.retain(|run| !gone.contains(&run.key()));
        Ok((runs, deleted))
    }

    /// The runs on this PC: its training artifacts and its phone files, by version.
    fn local_runs(&self) -> Vec<BucketTrainingRun> {
        let mobile = self.paths.training_root.join("mobile");
        let folders = [self.paths.artifacts_root.clone(), mobile.join("artwork"), mobile.join("extractor")];
        let mut seen = HashSet::new();
        folders
            .iter()
            .flat_map(|folder| std::fs::read_dir(folder).into_iter().flatten().flatten())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| {
                let version = entry.file_name().to_string_lossy().into_owned();
                let kind = if version.starts_with("artwork-run-") {
                    Self::ARTWORK_KIND
                } else if version.starts_with("extractor-run-") {
                    Self::EXTRACTION_KIND
                } else {
                    return None;
                };
                // Skips the backups an import keeps (….replaced-…) and import staging folders: not versions.
                (is_safe_model_version(&version) && seen.insert(version.clone()))
                    .then(|| BucketTrainingRun::new(kind, version, 0))
            })
            .collect()
    }

    /// Deletes a run everywhere: marks it deleted in the bucket (every other PC deletes its copy when it next reads
    /// the runs), removes its ZIP there, then its files on this PC. This PC's current model can't be deleted.
    pub async fn delete(&self, run: &BucketTrainingRun, cancel: &CancellationToken) -> Result<()> {
        if self.current_version(&run.kind).as_deref() == Some(run.model_version.as_str()) {
            bail!(
                "{} is this PC's current {} model. Pull another run first, then delete this one.",
                run.model_version,
                run.kind
            );
        }
        let store = RailwayS3ObjectStore::connect(&self.credentials)?;
        // The marker first: a ZIP delete that fails afterwards still leaves the run deleted on every PC.
        // The SHA-256 of no bytes, which every object here carries as its hash.
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        store.upload_bytes(&run.deleted_key(), Vec::new(), empty, cancel).await?;
        store.delete(&run.key(), cancel).await?;
        let _lease = self.coordinator.acquire("delete a training run")?;
        self.delete_local(run)
    }

    /// Deletes this PC's copies of the runs deleted on another PC; its current models stay. Returns the versions
    /// deleted.
    pub async fn apply_deletions(&self, cancel: &CancellationToken) -> Result<Vec<String>> {
        if !self.is_configured() {
            return Ok(Vec::new());
        }
        let (_, deleted) = self.bucket_runs(cancel).await?;
        let local: HashSet<String> = self.local_runs().into_iter().map(|run| run.key()).collect();
        let mut removed = Vec::new();
        for run in deleted.iter().filter(|run| local.contains(&run.key())) {
            if self.current_version(&run.kind).as_deref() == Some(run.model_version.as_str()) {
                continue;
            }
            let _lease = self.coordinator.acquire("delete a training run")?;
            self.delete_local(run)?;
            removed.push(run.model_version.clone());
        }
        Ok(removed)
    }

    /// Every file and folder of the run on this PC: its artifacts (and the backups an import kept of them), its phone
    /// files, its handoff and result ZIPs, and the benchmark scores made with it.
    fn delete_local(&self, run: &BucketTrainingRun) -> Result<()> {
        if !is_safe_model_version(&run.model_version) {
            bail!("{} is not a model version.", run.model_version);
        }
        let training = &self.paths.training_root;
        let mobile_kind = if run.kind == Self::ARTWORK_KIND { "artwork" } else { "extractor" };
        let mut folders = vec![
            self.paths.artifacts_root.clone(),
            training.join("mobile").join(mobile_kind),
            self.paths.handoff_root.clone(),
            self.paths.incoming_root.clone(),
            training.join("results"),
        ];
        folders.extend(
            std::fs::read_dir(training.join("benchmark-scores"))
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir()),
        );
        // A version is "<kind>-run-<UTC time>": no other run's name contains it.
        for folder in folders {
            for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
                if !entry.file_name().to_string_lossy().contains(run.model_version.as_str()) {
                    continue;
                }
                let path = entry.path();
                if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) }
                    .map_err(|error| anyhow::anyhow!("Could not delete {}: {error}", path.display()))?;
            }
        }
        Ok(())
    }

    /// Download a run and import it, which makes it this PC's current model of its kind. `report_percent` gets 0–100
    /// while the run downloads; the import follows.
    pub async fn sync_down(
        &self,
        run: &BucketTrainingRun,
        cancel: &CancellationToken,
        report_percent: Option<&(dyn Fn(i32) + Sync)>,
    ) -> Result<String> {
        std::fs::create_dir_all(&self.paths.incoming_root)?;
        let zip_path = self.paths.incoming_root.join(format!("{}-{}.zip", run.kind, run.model_version));
        let result = async {
            let store = RailwayS3ObjectStore::connect(&self.credentials)?;
            store.download_with_progress(&run.key(), &zip_path, report_percent.unwrap_or(&|_| {}), cancel).await?;
            if run.kind == Self::ARTWORK_KIND {
                let imported = self.exporter.import_artwork_identity_bundle(&zip_path, cancel).await?;
                return Ok(format!(
                    "{} ({} artwork prototypes{}",
                    imported.model_version,
                    crate::n0(imported.prototypes),
                    if imported.qualified { ", qualified)" } else { ", not qualified)" }
                ));
            }
            let extraction = self.exporter.import_extraction_bundle(&zip_path, cancel).await?;
            Ok(format!("{} ({} files)", extraction.model_version, extraction.file_count))
        }
        .await;
        // Best effort: a leftover ZIP must not turn a finished import into a failure, or hide why one failed.
        if zip_path.is_file() {
            let _ = std::fs::remove_file(&zip_path);
        }
        result
    }

    /// The model version this PC uses now for a kind (its current-*.json pointer), if any.
    pub fn current_version(&self, kind: &str) -> Option<String> {
        if kind == Self::ARTWORK_KIND {
            self.exporter.read_current_artwork_pointer().map(|pointer| pointer.model_version)
        } else {
            self.exporter.read_current_extraction_pointer().map(|pointer| pointer.model_version)
        }
    }
}

// "<kind>-run-<UTC timestamp>": the kinds' prefixes differ, so only the timestamp orders runs of both.
fn run_timestamp(model_version: &str) -> &str {
    match model_version.rfind("-run-") {
        Some(at) => &model_version[at + 5..],
        None => model_version,
    }
}
