use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{Datelike, Local, NaiveDate, TimeZone, Timelike, Utc};
use regex::Regex;
use serde::{Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::bulk_data_sync::{BulkDataSyncService, round_trip_utc_now};
use crate::camera_annotation_store::strip_bom;
use crate::error::check;
use crate::paths::TrainingPaths;

const EXTRACTION_ARTIFACTS: &[&str] = &[
    "best.pt",
    "last.pt",
    "extractor.pt",
    "config.json",
    "preprocessing.json",
    "thresholds.json",
    "evaluation.json",
    "grouped-metrics.json",
    "failures.jsonl",
    "extraction-report.json",
    "workflow-state.json",
];
const SPATIAL_EXTRACTION_ARTIFACTS: &[&str] = &[
    "learning-check.json",
    "training-history.jsonl",
    "checkpoint-selection.json",
    "dataset/manifest.jsonl",
    "dataset/metadata.json",
    "dataset/preparation-report.json",
    "dataset/grouping-report.json",
    "dataset/split-assignments.json",
    "dataset/source-inventory.json",
];
const EXTRACTION_HANDOFF_REQUIRED: &[&str] = &[
    "best.pt",
    "extractor.pt",
    "config.json",
    "preprocessing.json",
    "thresholds.json",
    "evaluation.json",
    "extraction-report.json",
];
const EXTRACTION_HANDOFF_OPTIONAL: &[&str] =
    &["calibration.json", "checkpoint-selection.json", "workflow-state.json", "refiner.pt", "refiner-config.json"];
// Recipe 9 serves corners through the full-resolution refiner, so its bundle must carry it.
const REFINER_ARTIFACTS: &[&str] = &["refiner.pt", "refiner-config.json", "refiner-history.json"];
const CALIBRATED_SELECTION_POLICIES: &[&str] = &[
    "calibrated-extraction-v2",
    "geometry-guarded-v3",
    "calibrated-geometry-v4",
    "calibrated-geometry-v5",
    "calibrated-robust-geometry-v6",
];

// Everything export-artwork-mobile and recognize-index need; reports travel for review.
const ARTWORK_IMPORT_REQUIRED: &[&str] = &[
    "embedding.pt",
    "artwork-thresholds.json",
    "identity-report.json",
    "retrieval-report.json",
    "index/index.f32",
    "index/index-metadata.json",
    "index/index-labels.json",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZipVerificationResult {
    pub zip_path: PathBuf,
    pub verified_entries: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtworkImportResult {
    pub model_version: String,
    pub artifact_root: PathBuf,
    pub pointer_path: PathBuf,
    pub file_count: usize,
    pub prototypes: i32,
    pub embedding_dimension: i32,
    pub dataset_version: String,
    pub qualified: bool,
    pub replaced_path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtworkModelPointer {
    pub model_version: String,
    pub dataset_version: Option<String>,
    pub prototypes: i32,
    pub qualified: bool,
    pub updated_utc: Option<String>,
    pub source_zip: Option<String>,
}

struct ArtworkIndexSummary {
    count: i32,
    embedding_dimension: i32,
    dataset_version: String,
    checkpoint_model_version: String,
    qualified: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractionImportResult {
    pub model_version: String,
    pub artifact_root: PathBuf,
    pub pointer_path: PathBuf,
    pub source_kind: String,
    pub file_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractionModelPointer {
    pub pointer_schema_version: i32,
    pub kind: String,
    pub model_version: String,
    pub architecture: Option<String>,
    pub input_size: Option<i32>,
    pub artifact_root: String,
    pub files: BTreeMap<String, String>,
    pub updated_utc: Option<String>,
    pub source_zip: Option<String>,
    pub source_kind: Option<String>,
}

/// Packs, verifies and imports training results: the checksummed ZIPs that move models between PCs.
#[derive(Clone)]
pub struct TrainingResultExporter {
    paths: TrainingPaths,
}

impl TrainingResultExporter {
    pub const EXTRACTION_HANDOFF_KIND: &str = "card-extraction-handoff";
    pub const ARTWORK_IDENTITY_KIND: &str = "artwork-identity";
    pub const CURRENT_ARTWORK_POINTER_SCHEMA: i32 = 1;
    pub const LATEST_HANDOFF_ZIP_FILE_NAME: &str = "deckino-extraction-handoff-latest.zip";
    pub const CURRENT_EXTRACTION_POINTER_SCHEMA: i32 = 1;

    pub fn new(paths: TrainingPaths) -> Self {
        Self { paths }
    }

    pub fn handoff_zip_file_name(model_version: &str) -> String {
        format!("deckino-extraction-handoff-{}.zip", BulkDataSyncService::sanitize_file_name(model_version))
    }

    /// Zipping and hashing models takes seconds: it runs on the blocking pool.
    async fn blocking<T: Send + 'static>(
        &self,
        cancel: &CancellationToken,
        work: impl FnOnce(&Self, &CancellationToken) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (this, cancel) = (self.clone(), cancel.clone());
        tokio::task::spawn_blocking(move || work(&this, &cancel)).await?
    }

    /// The artwork model "Pack for other PCs" takes when none is named: the most recently trained or imported one on
    /// this PC that has everything a bundle needs.
    pub fn resolve_packable_artwork_model(&self) -> Option<String> {
        let entries = std::fs::read_dir(&self.paths.artifacts_root).ok()?;
        entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|folder| {
                let name = folder.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                // A safe version also skips import staging folders (.import-…) and the dated backups an import keeps
                // of a replaced model (….replaced-…); no PC could import any other name, and the bucket's run list
                // skips it, so the startup upload would pack and send it again every time.
                folder.is_dir()
                    && is_safe_model_version(&name)
                    && folder.join("embedding.pt").is_file()
                    && folder.join("identity-report.json").is_file()
                    && folder.join("index").join("index.f32").is_file()
            })
            .min_by_key(|folder| {
                std::cmp::Reverse(
                    std::fs::metadata(folder.join("embedding.pt"))
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(SystemTime::UNIX_EPOCH),
                )
            })
            .and_then(|folder| folder.file_name().map(|name| name.to_string_lossy().into_owned()))
    }

    /// Create and verify the artwork result ZIP that another PC imports. Returns its path.
    pub async fn pack_artwork_for_other_pcs(
        &self,
        model_version: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        let model_version = match model_version {
            Some(version) => version.to_string(),
            None => self.resolve_packable_artwork_model().ok_or_else(|| {
                anyhow!(
                    "No finished artwork model was found on this PC. Run Train on Card Embeddings to the end first."
                )
            })?,
        };
        let zip_path = self.export_artwork_identity(&model_version, cancel).await?;
        self.verify_identity(&zip_path, cancel).await?;
        Ok(zip_path)
    }

    pub async fn export_artwork_identity(&self, model_version: &str, cancel: &CancellationToken) -> Result<PathBuf> {
        let version = model_version.to_string();
        self.blocking(cancel, move |this, cancel| this.export_artwork_identity_now(&version, cancel)).await
    }

    fn export_artwork_identity_now(&self, model_version: &str, cancel: &CancellationToken) -> Result<PathBuf> {
        let artifact_root = self.paths.artifact_root(model_version);
        let required = [
            "embedding.pt",
            "identity-report.json",
            "retrieval-report.json",
            "artwork-thresholds.json",
            "retrieval-failures.jsonl",
            r"index\index.f32",
            r"index\index-metadata.json",
            r"index\index-labels.json",
        ];
        for relative in required {
            if !artifact_root.join(relative).is_file() {
                bail!("Cannot export: {relative} is missing.");
            }
        }
        let mut sources: Vec<(PathBuf, String)> = required
            .iter()
            .map(|relative| (artifact_root.join(relative), format!("artifacts/{}", relative.replace('\\', "/"))))
            .collect();
        let configuration = artifact_root.join("configuration.json");
        if configuration.is_file() {
            sources.push((configuration, "artifacts/configuration.json".into()));
        }
        self.write_zip(
            model_version,
            sources,
            true,
            5,
            cancel,
            TrainingResultExporter::ARTWORK_IDENTITY_KIND,
            None,
            None,
            true,
        )
    }

    pub async fn export_extraction(&self, model_version: &str, cancel: &CancellationToken) -> Result<PathBuf> {
        let version = model_version.to_string();
        self.blocking(cancel, move |this, cancel| this.export_extraction_now(&version, cancel)).await
    }

    fn export_extraction_now(&self, model_version: &str, cancel: &CancellationToken) -> Result<PathBuf> {
        let artifact_root = self.paths.artifact_root(model_version);
        for relative in EXTRACTION_ARTIFACTS {
            if !artifact_root.join(relative).is_file() {
                bail!("Cannot export extraction results: {relative} is missing.");
            }
        }
        let mut sources: Vec<(PathBuf, String)> = EXTRACTION_ARTIFACTS
            .iter()
            .map(|relative| (artifact_root.join(relative), format!("artifacts/{relative}")))
            .collect();
        let configuration = read_json(&artifact_root.join("config.json"))?;
        let schema = optional_i32(&configuration, "artifact_schema_version").unwrap_or(1);
        if schema >= 2 {
            for relative in SPATIAL_EXTRACTION_ARTIFACTS {
                let source = artifact_root.join(relative.replace('/', "\\"));
                if !source.is_file() {
                    bail!("Cannot export spatial extraction results: {relative} is missing.");
                }
                sources.push((source, format!("artifacts/{relative}")));
            }
        }
        let recipe = optional_i32(&configuration, "training_recipe_version");
        if recipe.is_some_and(|recipe| recipe >= 3) {
            let calibration = artifact_root.join("calibration.json");
            if !calibration.is_file() {
                bail!("Cannot export extraction recipe: calibration.json is missing.");
            }
            sources.push((calibration, "artifacts/calibration.json".into()));
        }
        if recipe.is_some_and(|recipe| recipe >= 9) {
            for relative in REFINER_ARTIFACTS {
                let source = artifact_root.join(relative);
                if !source.is_file() {
                    bail!("Cannot export recipe 9 extraction results: {relative} is missing.");
                }
                sources.push((source, format!("artifacts/{relative}")));
            }
        }
        if uses_calibrated_selection(&configuration) {
            let comparison = artifact_root.join("baseline-comparison.json");
            if !comparison.is_file() {
                bail!("Cannot export: baseline-comparison.json is missing.");
            }
            sources.push((comparison, "artifacts/baseline-comparison.json".into()));
        }
        let diagnostics = artifact_root.join("diagnostics");
        if diagnostics.is_dir() {
            for entry in walkdir::WalkDir::new(&diagnostics) {
                let entry = entry?;
                if entry.file_type().is_file() {
                    let relative = crate::paths::relative_path(&diagnostics, entry.path());
                    sources.push((entry.path().to_path_buf(), format!("artifacts/diagnostics/{relative}")));
                }
            }
        }
        self.write_zip(model_version, sources, false, schema, cancel, "card-extraction", None, None, true)
    }

    pub async fn export_extraction_handoff(&self, model_version: &str, cancel: &CancellationToken) -> Result<PathBuf> {
        let version = model_version.to_string();
        self.blocking(cancel, move |this, cancel| this.export_extraction_handoff_now(&version, cancel)).await
    }

    fn export_extraction_handoff_now(&self, model_version: &str, cancel: &CancellationToken) -> Result<PathBuf> {
        if !is_safe_model_version(model_version) {
            bail!("Cannot pack extraction handoff: invalid model version '{model_version}'.");
        }
        let artifact_root = self.paths.artifact_root(model_version);
        let mut sources = Vec::new();
        for relative in EXTRACTION_HANDOFF_REQUIRED {
            let source = artifact_root.join(relative.replace('/', "\\"));
            if !source.is_file() {
                bail!("Cannot pack extraction handoff: {relative} is missing.");
            }
            sources.push((source, format!("artifacts/{relative}")));
        }
        for relative in EXTRACTION_HANDOFF_OPTIONAL {
            let source = artifact_root.join(relative.replace('/', "\\"));
            if source.is_file() {
                sources.push((source, format!("artifacts/{relative}")));
            }
        }
        let configuration = read_json(&artifact_root.join("config.json"))?;
        let schema = optional_i32(&configuration, "artifact_schema_version").unwrap_or(1);
        let zip_path = self.write_zip(
            model_version,
            sources,
            false,
            schema,
            cancel,
            TrainingResultExporter::EXTRACTION_HANDOFF_KIND,
            Some(&self.paths.handoff_root),
            Some(Self::handoff_zip_file_name(model_version)),
            false,
        )?;
        std::fs::copy(&zip_path, self.paths.handoff_root.join(TrainingResultExporter::LATEST_HANDOFF_ZIP_FILE_NAME))?;
        self.write_current_extraction_pointer(
            model_version,
            &zip_path,
            TrainingResultExporter::EXTRACTION_HANDOFF_KIND,
        )?;
        Ok(zip_path)
    }

    pub async fn import_extraction_bundle(
        &self,
        zip_path: &Path,
        cancel: &CancellationToken,
    ) -> Result<ExtractionImportResult> {
        let zip_path = zip_path.to_path_buf();
        self.blocking(cancel, move |this, cancel| this.import_extraction_bundle_now(&zip_path, cancel)).await
    }

    fn import_extraction_bundle_now(
        &self,
        zip_path: &Path,
        cancel: &CancellationToken,
    ) -> Result<ExtractionImportResult> {
        let full_zip_path = std::path::absolute(zip_path)?;
        if !full_zip_path.is_file() {
            bail!("Extraction bundle ZIP was not found.");
        }
        self.verify_now(&full_zip_path, cancel)?;
        let mut archive = open_zip(&full_zip_path)?;
        let metadata = read_entry_json(&mut archive, "metadata.json")?
            .ok_or_else(|| anyhow!("Extraction bundle is missing metadata.json."))?;
        let kind = string(&metadata, "artifact_kind");
        let kind = match kind.as_deref() {
            Some(kind @ ("card-extraction" | TrainingResultExporter::EXTRACTION_HANDOFF_KIND)) => kind.to_string(),
            other => bail!("ZIP is not an extraction bundle: {}.", other.unwrap_or("missing artifact_kind")),
        };
        let model_version = string(&metadata, "model_version")
            .filter(|version| is_safe_model_version(version))
            .ok_or_else(|| anyhow!("Extraction bundle metadata has an invalid model_version."))?;
        let artifact_root = self.paths.artifact_root(&model_version);
        std::fs::create_dir_all(&artifact_root)?;
        let extracted = extract_artifacts(&mut archive, &artifact_root, "Extraction", cancel)?;
        for required in ["extractor.pt", "config.json", "preprocessing.json", "thresholds.json"] {
            if !artifact_root.join(required).is_file() {
                bail!("Imported extraction bundle is missing {required}.");
            }
        }
        if extracted == 0 {
            bail!("Extraction bundle did not contain any artifacts.");
        }
        let pointer_path = self.write_current_extraction_pointer(&model_version, &full_zip_path, &kind)?;
        Ok(ExtractionImportResult {
            model_version,
            artifact_root,
            pointer_path,
            source_kind: kind,
            file_count: extracted,
        })
    }

    /// Imports an artwork-identity result ZIP trained on another PC (for example the NVIDIA laptop). The bundle is
    /// checksum-verified, extracted to a staging folder and its prototype index is validated before it replaces any
    /// same-named model, which is kept as a dated backup.
    pub async fn import_artwork_identity_bundle(
        &self,
        zip_path: &Path,
        cancel: &CancellationToken,
    ) -> Result<ArtworkImportResult> {
        let zip_path = zip_path.to_path_buf();
        self.blocking(cancel, move |this, cancel| this.import_artwork_identity_bundle_now(&zip_path, cancel)).await
    }

    fn import_artwork_identity_bundle_now(
        &self,
        zip_path: &Path,
        cancel: &CancellationToken,
    ) -> Result<ArtworkImportResult> {
        let full_zip_path = std::path::absolute(zip_path)?;
        if !full_zip_path.is_file() {
            bail!("Artwork bundle ZIP was not found.");
        }
        self.verify_now(&full_zip_path, cancel)?;
        let mut archive = open_zip(&full_zip_path)?;
        let metadata = read_entry_json(&mut archive, "metadata.json")?
            .ok_or_else(|| anyhow!("Artwork bundle is missing metadata.json."))?;
        let kind = string(&metadata, "artifact_kind");
        let model_version = string(&metadata, "model_version");
        if kind.as_deref() != Some(TrainingResultExporter::ARTWORK_IDENTITY_KIND) {
            bail!(
                "ZIP is not an artwork identity bundle: {}. Extraction bundles are imported from Card Extraction Training.",
                kind.as_deref().unwrap_or("missing artifact_kind")
            );
        }
        let model_version = model_version
            .filter(|version| is_safe_model_version(version))
            .ok_or_else(|| anyhow!("Artwork bundle metadata has an invalid model_version."))?;
        for required in ARTWORK_IMPORT_REQUIRED {
            if archive.index_for_name(&format!("artifacts/{required}")).is_none() {
                bail!("Artwork bundle is missing {required}.");
            }
        }

        std::fs::create_dir_all(&self.paths.artifacts_root)?;
        let artifact_root = self.paths.artifact_root(&model_version);
        let staging =
            self.paths.artifacts_root.join(format!(".import-{model_version}-{}", uuid::Uuid::new_v4().simple()));
        let result = (|| {
            let extracted = extract_artifacts(&mut archive, &staging, "Artwork", cancel)?;
            let index = validate_artwork_index(&staging, &model_version, cancel)?;

            // Swap in the new model only after it validated; keep the previous one recoverable.
            let mut replaced_path = None;
            if artifact_root.is_dir() {
                let replaced = self
                    .paths
                    .artifacts_root
                    .join(format!("{model_version}.replaced-{}", Utc::now().format("%Y%m%dT%H%M%S%3fZ")));
                std::fs::rename(&artifact_root, &replaced)?;
                replaced_path = Some(replaced);
            }
            std::fs::rename(&staging, &artifact_root)?;
            let pointer_path = self.write_current_artwork_pointer(&model_version, &full_zip_path, &index)?;
            Ok(ArtworkImportResult {
                model_version: model_version.clone(),
                artifact_root: artifact_root.clone(),
                pointer_path,
                file_count: extracted,
                prototypes: index.count,
                embedding_dimension: index.embedding_dimension,
                dataset_version: index.dataset_version,
                qualified: index.qualified,
                replaced_path,
            })
        })();
        if staging.is_dir() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result
    }

    fn write_current_artwork_pointer(
        &self,
        model_version: &str,
        source_zip_path: &Path,
        index: &ArtworkIndexSummary,
    ) -> Result<PathBuf> {
        #[derive(Serialize)]
        struct Pointer<'a> {
            pointer_schema_version: i32,
            kind: &'a str,
            model_version: &'a str,
            checkpoint_model_version: &'a str,
            dataset_version: &'a str,
            prototypes: i32,
            embedding_dimension: i32,
            qualified: bool,
            artifact_root: String,
            files: OrderedMap,
            updated_utc: String,
            source_zip: String,
        }
        let pointer = Pointer {
            pointer_schema_version: TrainingResultExporter::CURRENT_ARTWORK_POINTER_SCHEMA,
            kind: TrainingResultExporter::ARTWORK_IDENTITY_KIND,
            model_version,
            checkpoint_model_version: &index.checkpoint_model_version,
            dataset_version: &index.dataset_version,
            prototypes: index.count,
            embedding_dimension: index.embedding_dimension,
            qualified: index.qualified,
            artifact_root: self.paths.relative_to_data_root(self.paths.artifact_root(model_version)),
            files: OrderedMap(vec![
                ("embedding".into(), "embedding.pt".into()),
                ("index_root".into(), "index".into()),
                ("thresholds".into(), "artwork-thresholds.json".into()),
                ("identity_report".into(), "identity-report.json".into()),
                ("retrieval_report".into(), "retrieval-report.json".into()),
            ]),
            updated_utc: round_trip_utc_now(),
            source_zip: self.pointer_source_zip(source_zip_path),
        };
        std::fs::create_dir_all(&self.paths.training_root)?;
        let path = &self.paths.current_artwork_pointer_path;
        let temporary = PathBuf::from(format!("{}.tmp", path.display()));
        std::fs::write(&temporary, serde_json::to_string_pretty(&pointer)?)?;
        std::fs::rename(&temporary, path)?;
        Ok(path.clone())
    }

    pub fn read_current_artwork_pointer(&self) -> Option<ArtworkModelPointer> {
        let root = read_json(&self.paths.current_artwork_pointer_path).ok()?;
        if root.get("pointer_schema_version")?.as_i64()?
            != TrainingResultExporter::CURRENT_ARTWORK_POINTER_SCHEMA as i64
        {
            return None;
        }
        let version = string(&root, "model_version").filter(|version| is_safe_model_version(version))?;
        Some(ArtworkModelPointer {
            model_version: version,
            dataset_version: string(&root, "dataset_version"),
            prototypes: root.get("prototypes").and_then(Value::as_i64).unwrap_or(0) as i32,
            qualified: root.get("qualified") == Some(&Value::Bool(true)),
            updated_utc: string(&root, "updated_utc"),
            source_zip: string(&root, "source_zip"),
        })
    }

    pub fn read_current_extraction_pointer(&self) -> Option<ExtractionModelPointer> {
        let root = read_json(&self.paths.current_extraction_pointer_path).ok()?;
        if root.get("pointer_schema_version")?.as_i64()?
            != TrainingResultExporter::CURRENT_EXTRACTION_POINTER_SCHEMA as i64
        {
            return None;
        }
        let files = root
            .get("files")
            .and_then(Value::as_object)
            .map(|files| {
                files
                    .iter()
                    .filter_map(|(name, value)| value.as_str().map(|value| (name.clone(), value.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        // Required properties may be null (then defaulted) but not missing.
        let required = |name: &str| root.get(name).map(|value| value.as_str().map(str::to_string));
        Some(ExtractionModelPointer {
            pointer_schema_version: TrainingResultExporter::CURRENT_EXTRACTION_POINTER_SCHEMA,
            kind: required("kind")?.unwrap_or_else(|| "card-extraction".into()),
            model_version: required("model_version")?.unwrap_or_default(),
            architecture: string(&root, "architecture"),
            input_size: root.get("input_size").and_then(Value::as_i64).map(|size| size as i32),
            artifact_root: required("artifact_root")?.unwrap_or_default(),
            files,
            updated_utc: string(&root, "updated_utc"),
            source_zip: string(&root, "source_zip"),
            source_kind: string(&root, "source_kind"),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn write_zip(
        &self,
        model_version: &str,
        mut sources: Vec<(PathBuf, String)>,
        identity: bool,
        artifact_schema_version: i32,
        cancel: &CancellationToken,
        artifact_kind: &str,
        output_directory: Option<&Path>,
        file_name: Option<String>,
        include_logs: bool,
    ) -> Result<PathBuf> {
        let output_root =
            output_directory.map(Path::to_path_buf).unwrap_or_else(|| self.paths.training_root.join("results"));
        std::fs::create_dir_all(&output_root)?;
        let prefix = match artifact_kind {
            "card-extraction" => "deckino-extraction-results",
            TrainingResultExporter::EXTRACTION_HANDOFF_KIND => "deckino-extraction-handoff",
            _ => "deckino-results",
        };
        let zip_path = output_root.join(file_name.unwrap_or_else(|| {
            format!(
                "{prefix}-{}-{}.zip",
                BulkDataSyncService::sanitize_file_name(model_version),
                Utc::now().format("%Y%m%dT%H%M%S%3fZ")
            )
        }));
        if include_logs && self.paths.logs_root.is_dir() {
            let version = model_version.to_lowercase();
            for entry in std::fs::read_dir(&self.paths.logs_root)? {
                let path = entry?.path();
                let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                if path.is_file() && name.to_lowercase().ends_with(".log") && name.to_lowercase().contains(&version) {
                    sources.push((path, format!("logs/{name}")));
                }
            }
        }
        let mut ordered = sources.clone();
        ordered.sort_by(|a, b| a.1.cmp(&b.1));
        // One source per entry (GroupBy(...).Single()).
        if ordered.windows(2).any(|pair| pair[0].1 == pair[1].1) {
            bail!("Sequence contains more than one element");
        }

        let mut checksums = BTreeMap::new();
        let mut archive = ZipWriter::new(File::create(&zip_path)?);
        let options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).last_modified_time(dos_now());
        for (path, entry) in &ordered {
            check(cancel)?;
            let lower = entry.to_lowercase();
            let bytes = if entry.starts_with("logs/") || lower.ends_with(".json") || lower.ends_with(".jsonl") {
                redact_absolute_paths(&read_text(path)?).into_bytes()
            } else {
                std::fs::read(path).with_context(|| format!("Reading {} failed", path.display()))?
            };
            checksums.insert(entry.clone(), hex::encode(Sha256::digest(&bytes)));
            archive.start_file(entry.as_str(), options)?;
            archive.write_all(&bytes)?;
        }
        let dataset_version = match sources
            .iter()
            .find(|(_, entry)| entry == "artifacts/identity-report.json" || entry == "artifacts/extraction-report.json")
        {
            Some((path, _)) => string(&read_json(path)?, "dataset_version"),
            None => None,
        };
        #[derive(Serialize)]
        struct Metadata<'a> {
            export_schema_version: i32,
            artifact_schema_version: i32,
            model_version: &'a str,
            dataset_version: Option<String>,
            identity: bool,
            artifact_kind: &'a str,
            created_utc: String,
        }
        let metadata = serde_json::to_vec_pretty(&Metadata {
            export_schema_version: 1,
            artifact_schema_version,
            model_version,
            dataset_version,
            identity,
            artifact_kind,
            created_utc: round_trip_utc_now(),
        })?;
        checksums.insert("metadata.json".into(), hex::encode(Sha256::digest(&metadata)));
        archive.start_file("metadata.json", options)?;
        archive.write_all(&metadata)?;
        let checksum_text: String = checksums.iter().map(|(name, hash)| format!("{hash}  {name}\n")).collect();
        archive.start_file("SHA256SUMS", options)?;
        archive.write_all(checksum_text.as_bytes())?;
        archive.finish()?;
        Ok(zip_path)
    }

    pub async fn verify(&self, zip_path: &Path, cancel: &CancellationToken) -> Result<ZipVerificationResult> {
        let zip_path = zip_path.to_path_buf();
        self.blocking(cancel, move |this, cancel| this.verify_now(&zip_path, cancel)).await
    }

    fn verify_now(&self, zip_path: &Path, cancel: &CancellationToken) -> Result<ZipVerificationResult> {
        let mut archive = open_zip(zip_path)?;
        if archive.has_duplicate_names() {
            bail!("Result ZIP contains duplicate entry names.");
        }
        let mut names = HashSet::new();
        for name in archive.file_names() {
            let name = name?;
            if !entry_file_name(&name).is_empty() {
                names.insert(name.into_owned());
            }
        }
        if !names.contains("SHA256SUMS") {
            bail!("Result ZIP does not contain SHA256SUMS.");
        }
        let mut checksum_text = String::new();
        archive.by_name("SHA256SUMS")?.read_to_string(&mut checksum_text)?;
        let expected = parse_checksums(checksum_text.trim_start_matches('\u{feff}'))?;
        let actual_payload_names: HashSet<&str> =
            names.iter().map(String::as_str).filter(|name| *name != "SHA256SUMS").collect();
        let expected_names: HashSet<&str> = expected.iter().map(|(name, _)| name.as_str()).collect();
        if actual_payload_names != expected_names {
            bail!("Result ZIP contains missing or additional unchecked entries.");
        }
        for (name, hash) in &expected {
            check(cancel)?;
            let mut hasher = Sha256::new();
            std::io::copy(&mut archive.by_name(name)?, &mut hasher)?;
            if hex::encode(hasher.finalize()) != *hash {
                bail!("Checksum mismatch for {name}.");
            }
        }
        Ok(ZipVerificationResult { zip_path: zip_path.to_path_buf(), verified_entries: expected.len() })
    }

    pub async fn verify_identity(&self, zip_path: &Path, cancel: &CancellationToken) -> Result<ZipVerificationResult> {
        let result = self.verify(zip_path, cancel).await?;
        let archive = open_zip(zip_path)?;
        if archive.index_for_name("artifacts/identity-report.json").is_none() {
            bail!("Production result ZIP does not contain identity-report.json.");
        }
        Ok(result)
    }

    pub async fn verify_extraction(
        &self,
        zip_path: &Path,
        cancel: &CancellationToken,
    ) -> Result<ZipVerificationResult> {
        let result = self.verify(zip_path, cancel).await?;
        let mut archive = open_zip(zip_path)?;
        let has = |archive: &ZipArchive<File>, name: &str| archive.index_for_name(name).is_some();
        if !has(&archive, "artifacts/extractor.pt") || !has(&archive, "artifacts/extraction-report.json") {
            bail!("Extraction result ZIP is missing required compact artifacts.");
        }
        let metadata = read_entry_json(&mut archive, "metadata.json")?
            .ok_or_else(|| anyhow!("Extraction result ZIP is missing metadata.json."))?;
        if required_i32(&metadata, "artifact_schema_version")? >= 2 {
            for relative in EXTRACTION_ARTIFACTS.iter().chain(SPATIAL_EXTRACTION_ARTIFACTS) {
                if !has(&archive, &format!("artifacts/{relative}")) {
                    bail!("Spatial extraction ZIP is missing required artifact: {relative}.");
                }
            }
        }
        if let Some(config) = read_entry_json(&mut archive, "artifacts/config.json")? {
            let recipe = optional_i32(&config, "training_recipe_version");
            if recipe.is_some_and(|recipe| recipe >= 3) && !has(&archive, "artifacts/calibration.json") {
                bail!("Extraction ZIP is missing calibration.json.");
            }
            if uses_calibrated_selection(&config) && !has(&archive, "artifacts/baseline-comparison.json") {
                bail!("Calibrated-selection extraction ZIP is missing baseline-comparison.json.");
            }
            if recipe.is_some_and(|recipe| recipe >= 9) {
                for relative in REFINER_ARTIFACTS {
                    if !has(&archive, &format!("artifacts/{relative}")) {
                        bail!("Recipe 9 extraction ZIP is missing {relative}.");
                    }
                }
            }
        }
        Ok(result)
    }

    fn write_current_extraction_pointer(
        &self,
        model_version: &str,
        source_zip_path: &Path,
        source_kind: &str,
    ) -> Result<PathBuf> {
        let artifact_root = self.paths.artifact_root(model_version);
        let (mut architecture, mut input_size) = (None, None);
        let config_path = artifact_root.join("config.json");
        if config_path.is_file() {
            let config = read_json(&config_path)?;
            architecture = string(&config, "architecture");
            input_size = config.get("input_size").and_then(Value::as_i64).map(|size| size as i32);
        }
        let files = OrderedMap(
            [
                ("checkpoint", "extractor.pt"),
                ("best_checkpoint", "best.pt"),
                ("config", "config.json"),
                ("preprocessing", "preprocessing.json"),
                ("thresholds", "thresholds.json"),
                ("evaluation", "evaluation.json"),
            ]
            .into_iter()
            .filter(|(_, name)| artifact_root.join(name).is_file())
            .map(|(key, name)| (key.to_string(), name.to_string()))
            .collect(),
        );
        #[derive(Serialize)]
        struct Pointer<'a> {
            pointer_schema_version: i32,
            kind: &'a str,
            model_version: &'a str,
            architecture: Option<String>,
            input_size: Option<i32>,
            artifact_root: String,
            files: OrderedMap,
            updated_utc: String,
            source_zip: String,
            source_kind: &'a str,
        }
        let pointer = Pointer {
            pointer_schema_version: TrainingResultExporter::CURRENT_EXTRACTION_POINTER_SCHEMA,
            kind: "card-extraction",
            model_version,
            architecture,
            input_size,
            artifact_root: self.paths.relative_to_data_root(&artifact_root),
            files,
            updated_utc: round_trip_utc_now(),
            source_zip: self.pointer_source_zip(source_zip_path),
            source_kind,
        };
        std::fs::create_dir_all(&self.paths.training_root)?;
        std::fs::write(&self.paths.current_extraction_pointer_path, serde_json::to_string_pretty(&pointer)?)?;
        Ok(self.paths.current_extraction_pointer_path.clone())
    }

    fn pointer_source_zip(&self, zip_path: &Path) -> String {
        let full = std::path::absolute(zip_path).unwrap_or_else(|_| zip_path.to_path_buf());
        let data_root = std::path::absolute(&self.paths.data_root).unwrap_or_else(|_| self.paths.data_root.clone());
        let data_root = format!("{}\\", data_root.to_string_lossy().trim_end_matches(['\\', '/'])).to_lowercase();
        if full.to_string_lossy().to_lowercase().starts_with(&data_root) {
            return self.paths.relative_to_data_root(&full);
        }
        full.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

fn validate_artwork_index(root: &Path, model_version: &str, cancel: &CancellationToken) -> Result<ArtworkIndexSummary> {
    let metadata = read_json(&root.join("index").join("index-metadata.json"))?;
    let count = required_i32(&metadata, "count")?;
    let dimension = required_i32(&metadata, "embedding_dimension")?;
    let vectors = root.join("index").join("index.f32");
    if count <= 0
        || dimension <= 0
        || std::fs::metadata(&vectors)?.len() != count as u64 * dimension as u64 * std::mem::size_of::<f32>() as u64
    {
        bail!("Artwork index size does not match its metadata count and embedding dimension.");
    }
    let actual = sha256_file(&vectors, cancel)?;
    if !required(&metadata, "vectors_sha256")?.as_str().is_some_and(|expected| expected.eq_ignore_ascii_case(&actual)) {
        bail!("Artwork index vectors do not match their recorded checksum.");
    }
    let index_model = required(&metadata, "checkpoint_model_version")?.as_str().map(str::to_string);
    let thresholds = read_json(&root.join("artwork-thresholds.json"))?;
    if required(&thresholds, "checkpoint_model_version")?.as_str() != index_model.as_deref() {
        bail!("Artwork thresholds were calibrated for a different checkpoint than the index.");
    }
    let dataset_version = required(&metadata, "dataset_version")?.as_str().unwrap_or_default().to_string();
    if required(&thresholds, "dataset_version")?.as_str() != Some(dataset_version.as_str()) {
        bail!("Artwork thresholds belong to a different dataset version than the index.");
    }
    // The identity workflow records its retrieval gate as baseline_qualified (camera qualification is separate and not
    // yet evaluated).
    let report = read_json(&root.join("identity-report.json"))?;
    let qualified = report.get("baseline_qualified") == Some(&Value::Bool(true));
    Ok(ArtworkIndexSummary {
        count,
        embedding_dimension: dimension,
        dataset_version,
        checkpoint_model_version: index_model.unwrap_or_else(|| model_version.to_string()),
        qualified,
    })
}

/// Extracts every artifacts/ entry below `destination_root`, refusing any path that would leave it. `label` names the
/// bundle in the messages ("Extraction", "Artwork").
fn extract_artifacts(
    archive: &mut ZipArchive<File>,
    destination_root: &Path,
    label: &str,
    cancel: &CancellationToken,
) -> Result<usize> {
    let root_text = std::path::absolute(destination_root)?.to_string_lossy().to_lowercase();
    let mut extracted = 0;
    for index in 0..archive.len() {
        check(cancel)?;
        let mut entry = archive.by_index(index)?;
        let full_name = entry.name()?.into_owned();
        if entry_file_name(&full_name).is_empty() || !full_name.starts_with("artifacts/") {
            continue;
        }
        let relative = full_name["artifacts/".len()..].replace('/', "\\");
        if relative.trim().is_empty() || relative.contains("..") || is_path_rooted(&relative) {
            bail!("{label} bundle contains an unsafe path: {full_name}.");
        }
        let destination = std::path::absolute(destination_root.join(&relative))?;
        let destination_text = destination.to_string_lossy().to_lowercase();
        if !destination_text.starts_with(&format!("{root_text}\\")) && destination_text != root_text {
            bail!("{label} bundle would write outside the artifact folder: {full_name}.");
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&destination)?;
        std::io::copy(&mut entry, &mut file)?;
        // ExtractToFile keeps the entry's time: an imported model keeps the age it was packed with.
        if let Some(modified) = entry.last_modified().and_then(local_time) {
            let _ = file.set_modified(modified);
        }
        extracted += 1;
    }
    Ok(extracted)
}

fn parse_checksums(value: &str) -> Result<Vec<(String, String)>> {
    let mut result: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for line in value.split('\n').map(str::trim).filter(|line| !line.is_empty()) {
        if line.len() < 67 || line.get(64..66) != Some("  ") {
            bail!("SHA256SUMS contains an invalid line.");
        }
        let (hash, name) = (&line[..64], &line[66..]);
        let valid_hash = hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !valid_hash || name.trim().is_empty() || name.contains("..") || !seen.insert(name.to_string()) {
            bail!("SHA256SUMS contains an invalid or duplicate entry.");
        }
        result.push((name.to_string(), hash.to_string()));
    }
    if result.is_empty() {
        bail!("SHA256SUMS is empty.");
    }
    Ok(result)
}

/// A JSON object whose keys keep their insertion order (a C# Dictionary serializes in insertion order).
struct OrderedMap(Vec<(String, String)>);

impl Serialize for OrderedMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(key, value)| (key, value)))
    }
}

fn open_zip(path: &Path) -> Result<ZipArchive<File>> {
    Ok(ZipArchive::new(File::open(path).with_context(|| format!("Opening {} failed", path.display()))?)?)
}

fn read_entry_json(archive: &mut ZipArchive<File>, name: &str) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    match archive.by_name(name) {
        Ok(mut entry) => entry.read_to_end(&mut bytes)?,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    Ok(Some(serde_json::from_slice(strip_bom(&bytes))?))
}

/// The portion of an entry name after its last separator: empty for a folder entry.
fn entry_file_name(full_name: &str) -> &str {
    full_name.rsplit(['/', '\\']).next().unwrap_or_default()
}

fn is_path_rooted(path: &str) -> bool {
    path.starts_with(['\\', '/']) || path.chars().nth(1) == Some(':')
}

fn uses_calibrated_selection(configuration: &Value) -> bool {
    string(configuration, "checkpoint_selection_policy")
        .is_some_and(|policy| CALIBRATED_SELECTION_POLICIES.contains(&policy.as_str()))
}

/// File.ReadAllText: UTF-8, a byte-order mark dropped.
fn read_text(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("Reading {} failed", path.display()))?;
    Ok(String::from_utf8_lossy(strip_bom(&bytes)).into_owned())
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_str(&read_text(path)?).with_context(|| format!("{} is not valid JSON", path.display()))?)
}

fn required<'a>(value: &'a Value, name: &str) -> Result<&'a Value> {
    value.get(name).ok_or_else(|| anyhow!("The given key '{name}' was not present in the dictionary."))
}

fn required_i32(value: &Value, name: &str) -> Result<i32> {
    required(value, name)?.as_i64().map(|number| number as i32).ok_or_else(|| anyhow!("{name} is not a number."))
}

fn optional_i32(value: &Value, name: &str) -> Option<i32> {
    value.get(name).and_then(Value::as_i64).map(|number| number as i32)
}

fn string(value: &Value, name: &str) -> Option<String> {
    value.get(name).and_then(Value::as_str).map(str::to_string)
}

/// Lower-case SHA-256 of a file, checking for cancellation between chunks.
pub(crate) fn sha256_file(path: &Path, cancel: &CancellationToken) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        check(cancel)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub(crate) fn is_safe_model_version(version: &str) -> bool {
    !version.trim().is_empty() && version.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

fn redact_absolute_paths(value: &str) -> String {
    static ABSOLUTE_PATH: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)\b[A-Z]:(?:\\+|/+)[^"\r\n]*"#).expect("valid pattern"));
    ABSOLUTE_PATH.replace_all(value, "<ABSOLUTE_PATH>").into_owned()
}

/// A ZIP entry's time, local like .NET's ZipArchive writes it.
fn dos_now() -> zip::DateTime {
    let now = Local::now();
    zip::DateTime::from_date_and_time(
        now.year() as u16,
        now.month() as u8,
        now.day() as u8,
        now.hour() as u8,
        now.minute() as u8,
        now.second() as u8,
    )
    .unwrap_or_default()
}

fn local_time(time: zip::DateTime) -> Option<SystemTime> {
    let naive = NaiveDate::from_ymd_opt(time.year() as i32, time.month() as u32, time.day() as u32)?.and_hms_opt(
        time.hour() as u32,
        time.minute() as u32,
        time.second() as u32,
    )?;
    Local.from_local_datetime(&naive).earliest().map(SystemTime::from)
}
