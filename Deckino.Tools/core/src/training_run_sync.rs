use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
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
        let in_bucket: std::collections::HashSet<String> =
            self.list(cancel).await?.into_iter().map(|run| run.key()).collect();
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

    /// Every run in the bucket, newest first.
    pub async fn list(&self, cancel: &CancellationToken) -> Result<Vec<BucketTrainingRun>> {
        let store = RailwayS3ObjectStore::connect(&self.credentials)?;
        // A known hash for every object: the list needs no metadata request per run.
        let known = |_: &str, _: Option<&str>, _: i64| Some(String::new());
        let objects = store.list(Self::PREFIX, Some(&known), None, cancel).await?;
        let mut runs = Vec::new();
        for item in objects {
            let parts: Vec<&str> = item.key[Self::PREFIX.len()..].split('/').collect();
            // The version names the local download (incoming/<kind>-<version>.zip): one with a path in it is skipped.
            if let [kind @ (Self::ARTWORK_KIND | Self::EXTRACTION_KIND), name] = parts.as_slice()
                && let Some(version) = name.strip_suffix(".zip")
                && is_safe_model_version(version)
            {
                runs.push(BucketTrainingRun::new(*kind, version, item.size));
            }
        }
        runs.sort_by(|a, b| run_timestamp(&b.model_version).cmp(run_timestamp(&a.model_version)));
        Ok(runs)
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
