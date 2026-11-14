use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use anyhow::Result;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::camera_annotation_store::CameraAnnotationStore;
use crate::error::is_cancelled;
use crate::identity_production_workflow::{
    InvalidOperation, OnLine, ProductionStageResult, ProductionStageStatus, ProductionWorkflowOutcome, StageCompletion,
    atomic_write, cli, ensure_success, eq_ignore_case, file_name, get_bool, get_i32, get_string, invalid,
    is_out_of_memory, is_safe_version, key_not_found, last_event, log_file_names, pending_stages, property, read_json,
    read_text, run_training_cli, run_training_cli_raw, stage, stage_result, try_property, workflow_outcome,
};
use crate::paths::TrainingPaths;
use crate::python::{PythonProcessRunner, PythonRunResult};
use crate::recognition_crop;
use crate::training_environment::CudaTrainingProfile;
use crate::training_result_exporter::TrainingResultExporter;

#[derive(Clone, Debug, PartialEq)]
pub struct ExtractionWorkflowSnapshot {
    pub outcome: ProductionWorkflowOutcome,
    pub summary: String,
    pub dataset_version: String,
    pub model_version: String,
    pub stages: Vec<ProductionStageResult>,
    pub gpu_name: Option<String>,
    pub gpu_profile: Option<String>,
    pub batch_size: Option<i32>,
    pub completed_epoch: i32,
    pub export_path: Option<PathBuf>,
    pub include_synthetic_cards: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractionSuggestionModel {
    pub model_version: String,
    pub checkpoint_path: PathBuf,
    pub thresholds_path: PathBuf,
    pub refiner_path: Option<PathBuf>,
}

const STATE_SCHEMA_VERSION: i32 = 3;
const TRAINING_RECIPE_VERSION: i32 = 11;
const EXTRACTOR_ARCHITECTURE: &str = "mobilenetv3-small-card-geometry-v6";
const REFINER_ARCHITECTURE: &str = "mobilenetv3-small-corner-refiner-v1";
const CHECKPOINT_SELECTION_POLICY: &str = "phone-calibrated-robust-geometry-v7";
const TIMESTAMPED_MODEL_PREFIX: &str = "extractor-run-";
/// yyyyMMddTHHmmssfff'Z'
const TIMESTAMPED_MODEL_FORMAT: &str = "%Y%m%dT%H%M%S%3fZ";

const STAGE_DEFINITIONS: &[(&str, &str)] = &[
    ("inputs", "Inspect annotations & full-card assets"),
    ("dataset", "Prepare grouped extraction dataset"),
    ("cuda", "GPU profile & extractor CUDA smoke"),
    ("quick", "Real-photo learning check"),
    ("train", "Train or resume full extractor"),
    ("refiner", "Train full-resolution corner refiner"),
    ("evaluate", "Evaluate & calibrate geometry"),
    ("diagnostics", "Extraction & rectification diagnostics"),
    ("export", "Export extraction result ZIP"),
    ("verify", "Verify SHA-256 checksums"),
];

type OnProgress<'a> = Option<&'a (dyn Fn(ExtractionWorkflowSnapshot) + Send + Sync)>;

pub struct ExtractionProductionWorkflowService {
    paths: TrainingPaths,
    runner: Arc<PythonProcessRunner>,
    exporter: Arc<TrainingResultExporter>,
    /// The `model_version` each run's thresholds/evaluation JSON names, by file (modified time, length).
    model_versions: Mutex<HashMap<PathBuf, ((SystemTime, u64), Option<String>)>>,
}

impl ExtractionProductionWorkflowService {
    pub const DATASET_VERSION: &str = "corners-v1";
    pub const INITIAL_MODEL_VERSION: &str = "extractor-mnv3-geometry-320-recipe9";
    pub const SEED: i32 = 20260824;
    pub const EPOCHS: i32 = 150;
    pub const REFINER_EPOCHS: i32 = 60;
    pub const WORKERS: i32 = 4;

    pub fn new(paths: TrainingPaths, runner: Arc<PythonProcessRunner>, exporter: Arc<TrainingResultExporter>) -> Self {
        Self { paths, runner, exporter, model_versions: Mutex::default() }
    }

    pub fn active_model_path(&self) -> PathBuf {
        self.paths.extraction_production_root.join("active-extraction-model.txt")
    }

    pub fn active_model_version(&self) -> Result<String> {
        self.read_active_model_version()
    }

    pub fn resolve_suggestion_model(&self) -> Result<ExtractionSuggestionModel> {
        std::fs::create_dir_all(&self.paths.extraction_production_root)?;
        Ok(self.suggestion_model(&self.resolve_latest_ready_model_version()?))
    }

    pub fn inspect(&self) -> Result<ExtractionWorkflowSnapshot> {
        let model_version = self.read_active_model_version()?;
        let Some(state) = self.load_state(&model_version)? else {
            return Ok(empty_snapshot(&model_version, "Ready to prepare the card extractor."));
        };
        if !state.is_current_recipe() {
            return Ok(empty_snapshot(
                &model_version,
                "Ready for the recipe 11 extractor and phone-validated corner refiner; previous checkpoints are retained for comparison.",
            ));
        }
        validate_identity(&state, &model_version)?;
        if let Err(error) = self.validate_completed_artifacts(&state) {
            // Train starts a fresh run (FilesIntact), so the page shows one ready to start.
            if error.is::<InvalidOperation>() {
                return Ok(empty_snapshot(
                    &model_version,
                    "The last run's files are missing, so Train starts a new run.",
                ));
            }
            return Err(error);
        }
        Ok(to_snapshot(&state))
    }

    pub async fn run(
        &self,
        profile: &CudaTrainingProfile,
        on_line: &OnLine,
        on_progress: OnProgress<'_>,
        cancel: &CancellationToken,
        include_synthetic_cards: bool,
    ) -> Result<ExtractionWorkflowSnapshot> {
        let paths = &self.paths;
        std::fs::create_dir_all(&paths.extraction_production_root)?;
        let mut state = self.select_run_for_execution(include_synthetic_cards)?;
        let model_version = state.model_version.clone();
        validate_identity(&state, &model_version)?;
        self.validate_completed_artifacts(&state)?;

        let gpu_changed = state
            .gpu_name
            .as_ref()
            .is_some_and(|name| !eq_ignore_case(name, &profile.gpu_name) || state.gpu_index != profile.device_index);
        if gpu_changed {
            set_stage(
                &mut state,
                "cuda",
                ProductionStageStatus::Pending,
                "GPU changed; extractor CUDA validation will run again.",
            )?;
        }
        state.gpu_name = Some(profile.gpu_name.clone());
        state.gpu_index = profile.device_index;
        state.gpu_profile = Some(profile.label.clone());
        state.vram_mib = profile.vram_mib;
        if gpu_changed || state.batch_size == 0 {
            state.batch_size =
                if profile.vram_mib >= 7680 { profile.batch_size.min(32) } else { profile.batch_size.min(16) };
        }
        self.save_state(&state)?;
        on_line(
            if state.include_synthetic_cards {
                "Training inputs: annotated imports plus synthetic scenes."
            } else {
                "Training inputs: annotated imports only; synthetic scenes are excluded."
            },
            None,
        );

        if self.begin(&mut state, "inputs", "Inspecting managed sidecars and extraction assets…", on_progress)? {
            let outcome = stage(async {
                let sidecars = count_files(&paths.camera_imports_root, |name| name.ends_with("._annotations.json"))?;
                if sidecars == 0 {
                    return Err(invalid("No managed Corner Annotator sidecars were found."));
                }
                if !state.include_synthetic_cards {
                    return Ok(StageCompletion::passed(format!(
                        "Found {} annotations. Synthetic cards are disabled; full-card assets are not required.",
                        crate::n0(sidecars)
                    )));
                }
                let full_cards = count_files(&paths.card_images_root, |name| {
                    name.ends_with(".jpg") || name.ends_with(".jpeg") || name.ends_with(".png")
                })?;
                Ok(if full_cards > 0 {
                    StageCompletion::passed(format!(
                        "Found {} annotations and {} full-card assets.",
                        crate::n0(sidecars),
                        crate::n0(full_cards)
                    ))
                } else {
                    StageCompletion::warning(format!(
                        "Found {} annotations; no full-card assets are cached, so synthetic coverage is unavailable.",
                        crate::n0(sidecars)
                    ))
                })
            })
            .await;
            self.finish(&mut state, "inputs", outcome, on_progress)?;
        }

        if self.begin(
            &mut state,
            "dataset",
            "Reading the latest annotated photos and building this run's snapshot…",
            on_progress,
        )? {
            let outcome = stage(async {
                let mut arguments = cli![
                    "prepare-extraction",
                    "--data-root",
                    paths.data_root,
                    "--dataset-version",
                    state.dataset_version,
                    "--seed",
                    Self::SEED,
                    "--synthetic-per-card",
                    "4",
                    "--max-full-cards",
                    "5000",
                ];
                if state.include_synthetic_cards {
                    arguments.push("--include-synthetic".into());
                }
                let result =
                    self.run_cli(arguments, &format!("{model_version}-prepare-extraction"), on_line, cancel).await?;
                state.logs.push(result.log_path);
                ensure_file(&paths.manifest_path(&state.dataset_version), "extraction manifest")?;
                let report = read_json(&paths.dataset_root(&state.dataset_version).join("preparation-report.json"))?;
                state.dataset_ready = get_bool(property(&report, "production_data_ready")?)?;
                let records = get_i32(property(&report, "records")?)?;
                let real = get_i32(property(&report, "real_records")?)?;
                let synthetic = get_i32(property(&report, "synthetic_records")?)?;
                let negatives = match try_property(&report, "real_negative_records")? {
                    Some(real_negatives) => get_i32(real_negatives)?,
                    None => get_i32(property(&report, "negative_records")?)?,
                };
                let composition = format!(
                    "{} samples ({} real, {} synthetic)",
                    crate::n0(records),
                    crate::n0(real),
                    crate::n0(synthetic)
                );
                if negatives < 100 {
                    return Ok(StageCompletion::warning(format!(
                        "Prepared {composition}; only {} No Card examples are available. \
                         Add at least 100 across independent sessions for dependable rejection calibration.",
                        crate::n0(negatives)
                    )));
                }
                Ok(if state.dataset_ready {
                    StageCompletion::passed(format!("Prepared and checksummed {composition}."))
                } else {
                    StageCompletion::warning(format!(
                        "Prepared {composition}; production split/negative coverage remains incomplete."
                    ))
                })
            })
            .await;
            self.finish(&mut state, "dataset", outcome, on_progress)?;
        }

        let detail = format!("Testing {} at batch {}…", profile.gpu_name, state.batch_size);
        if self.begin(&mut state, "cuda", &detail, on_progress)? {
            let outcome = stage(async {
                let result = self.run_cuda_smoke(&mut state, profile, on_line, cancel).await?;
                state.logs.push(result.log_path);
                Ok(StageCompletion::passed(format!("Extractor CUDA smoke passed at batch {}.", state.batch_size)))
            })
            .await;
            self.finish(&mut state, "cuda", outcome, on_progress)?;
        }

        if self.begin(
            &mut state,
            "quick",
            "Checking real-photo learning and saved-checkpoint inference…",
            on_progress,
        )? {
            let outcome = stage(async {
                let quick_version = format!("{model_version}-learning");
                let result = self
                    .run_cli(
                        cli![
                            "extraction-learning-check", "--manifest", paths.manifest_path(&state.dataset_version),
                            "--artifacts-root", paths.artifacts_root, "--model-version", quick_version,
                            "--device", "cuda", "--cuda-device-index", state.gpu_index,
                            "--batch-size", state.batch_size, "--workers", Self::WORKERS, "--seed", Self::SEED,
                        ],
                        &format!("{model_version}-learning-check"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(result.log_path);
                let report_path = paths.artifact_root(&quick_version).join("learning-check.json");
                let report = read_json(&report_path)?;
                if !get_bool(property(&report, "passed")?)? {
                    return Err(invalid(
                        "Real-photo learning check failed. Inspect its loss history and failure previews.",
                    ));
                }
                std::fs::copy(&report_path, paths.artifact_root(&model_version).join("learning-check.json"))?;
                Ok(StageCompletion::passed(
                    "Real-photo corner learning and checkpoint reload parity passed; full training starts from fresh weights.",
                ))
            })
            .await;
            self.finish(&mut state, "quick", outcome, on_progress)?;
        }

        let artifact_root = paths.artifact_root(&model_version);
        let detail = format!("Training the full extractor through at most epoch {}…", Self::EPOCHS);
        if self.begin(&mut state, "train", &detail, on_progress)? {
            let outcome = stage(async {
                let last = artifact_root.join("last.pt");
                let mut arguments = cli![
                    "train-extraction",
                    "--manifest",
                    paths.manifest_path(&state.dataset_version),
                    "--artifacts-root",
                    paths.artifacts_root,
                    "--model-version",
                    model_version,
                    "--device",
                    "cuda",
                    "--cuda-device-index",
                    state.gpu_index,
                    "--batch-size",
                    state.batch_size,
                    "--epochs",
                    Self::EPOCHS,
                    "--workers",
                    Self::WORKERS,
                    "--learning-rate",
                    "3e-4",
                    "--seed",
                    Self::SEED,
                    "--pretrained",
                    "--patience",
                    "30",
                ];
                if last.is_file() {
                    arguments.extend(cli!["--resume", last]);
                }
                let result = self.run_cli(arguments, &format!("{model_version}-train"), on_line, cancel).await?;
                state.logs.push(result.log_path.clone());
                ensure_file(&artifact_root.join("best.pt"), "best extraction checkpoint")?;
                ensure_file(&last, "last extraction checkpoint")?;
                state.completed_epoch = last_epoch(&result)?.unwrap_or(Self::EPOCHS);
                Ok(StageCompletion::passed(format!(
                    "Full extraction training completed through epoch {}.",
                    state.completed_epoch
                )))
            })
            .await;
            self.finish(&mut state, "train", outcome, on_progress)?;
        }

        let refiner = artifact_root.join("refiner.pt");
        let detail = format!("Training the full-resolution corner refiner through epoch {}…", Self::REFINER_EPOCHS);
        if self.begin(&mut state, "refiner", &detail, on_progress)? {
            let outcome = stage(async {
                let last = artifact_root.join("refiner-last.pt");
                let mut arguments = cli![
                    "train-extraction-refiner",
                    "--coarse-checkpoint",
                    artifact_root.join("best.pt"),
                    "--manifest",
                    paths.manifest_path(&state.dataset_version),
                    "--artifacts-root",
                    paths.artifacts_root,
                    "--model-version",
                    model_version,
                    "--device",
                    "cuda",
                    "--cuda-device-index",
                    state.gpu_index,
                    "--batch-size",
                    state.batch_size,
                    "--epochs",
                    Self::REFINER_EPOCHS,
                    "--workers",
                    Self::WORKERS,
                    "--seed",
                    Self::SEED,
                    "--pretrained",
                ];
                if last.is_file() {
                    arguments.extend(cli!["--resume", last]);
                }
                let result =
                    self.run_cli(arguments, &format!("{model_version}-train-refiner"), on_line, cancel).await?;
                state.logs.push(result.log_path);
                ensure_file(&refiner, "corner refiner checkpoint")?;
                Ok(StageCompletion::passed(format!(
                    "Corner refiner trained through epoch {}; best validation checkpoint retained.",
                    Self::REFINER_EPOCHS
                )))
            })
            .await;
            self.finish(&mut state, "refiner", outcome, on_progress)?;
        }

        if self.begin(
            &mut state,
            "evaluate",
            "Calibrating presence and evaluating refined geometry on locked groups…",
            on_progress,
        )? {
            let outcome = stage(async {
                let mut arguments = cli![
                    "evaluate-extraction", "--manifest", paths.manifest_path(&state.dataset_version),
                    "--checkpoint", artifact_root.join("best.pt"), "--output-root", artifact_root,
                    "--device", "cuda", "--cuda-device-index", state.gpu_index,
                    "--batch-size", state.batch_size, "--workers", Self::WORKERS,
                    "--refiner", refiner,
                ];
                // Recover older completed artifacts even if an interrupted run lost its baseline chain.
                state.baseline_model_version =
                    self.find_completed_baseline(state.baseline_model_version.clone(), Some(&model_version))?;
                self.save_state(&state)?;
                if let Some(baseline_version) = &state.baseline_model_version {
                    let baseline = paths.artifact_root(baseline_version).join("best.pt");
                    arguments.extend(cli!["--baseline-checkpoint", baseline]);
                    on_line(
                        &format!(
                            "Comparing against preserved baseline {baseline_version} on this run's real validation photos."
                        ),
                        None,
                    );
                } else {
                    on_line(
                        "Baseline comparison unavailable: no previous completed extraction checkpoint was found. Candidate metrics will still be reported.",
                        None,
                    );
                }
                let result = self.run_cli(arguments, &format!("{model_version}-evaluate"), on_line, cancel).await?;
                state.logs.push(result.log_path);
                let evaluation = read_json(&artifact_root.join("evaluation.json"))?;
                state.qualified = get_bool(property(&evaluation, "qualified")?)?;
                let promotion = property(&evaluation, "promotion")?;
                if get_bool(property(promotion, "eligible")?)? {
                    on_line(
                        &format!("{model_version} met the development targets and is now the latest preview extractor."),
                        None,
                    );
                } else {
                    on_line(
                        "Candidate missed the development targets, but remains the latest completed extractor selected for previews.",
                        None,
                    );
                }
                state.evaluation = Some(evaluation);
                Ok(if state.qualified {
                    StageCompletion::passed("All extraction geometry and real-camera qualification gates passed.")
                } else {
                    StageCompletion::warning(
                        "Evaluation completed; quality or real-camera coverage remains below qualification.",
                    )
                })
            })
            .await;
            self.finish(&mut state, "evaluate", outcome, on_progress)?;
        }

        if self.begin(
            &mut state,
            "diagnostics",
            "Writing predicted corners, warp, and identity-crop preview…",
            on_progress,
        )? {
            let outcome = stage(async {
                let sample = self.read_known_sample(&state.dataset_version)?;
                let diagnostic_root = artifact_root.join("diagnostics");
                let result = self
                    .run_cli(
                        cli![
                            "rectify-extraction",
                            "--checkpoint",
                            artifact_root.join("best.pt"),
                            "--thresholds",
                            artifact_root.join("thresholds.json"),
                            "--image",
                            sample,
                            "--output-root",
                            diagnostic_root,
                            "--device",
                            "cuda",
                            "--cuda-device-index",
                            state.gpu_index,
                            "--refiner",
                            refiner,
                        ],
                        &format!("{model_version}-diagnostics"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(result.log_path);
                ensure_file(&diagnostic_root.join("diagnostic.json"), "extraction diagnostic")?;
                let diagnostic = read_json(&diagnostic_root.join("diagnostic.json"))?;
                // Read-only: ranks existing labels against the edge-intersection convention for manual review.
                let audit_root = diagnostic_root.join("label-audit");
                let audit = self
                    .run_cli(
                        cli![
                            "audit-extraction-labels",
                            "--manifest",
                            paths.manifest_path(&state.dataset_version),
                            "--checkpoint",
                            artifact_root.join("best.pt"),
                            "--refiner",
                            refiner,
                            "--output-root",
                            audit_root,
                            "--device",
                            "cuda",
                            "--cuda-device-index",
                            state.gpu_index,
                        ],
                        &format!("{model_version}-label-audit"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(audit.log_path);
                let audit_report = read_json(&audit_root.join("label-audit.json"))?;
                let flagged = get_i32(property(&audit_report, "flagged")?)?;
                let audit_summary =
                    format!(" Label audit flagged {} annotations for corner review.", crate::n0(flagged));
                Ok(if get_bool(property(&diagnostic, "accepted")?)? {
                    StageCompletion::passed(format!(
                        "Produced predicted corners, a 315×440 warp, and recognition-crop preview.{audit_summary}"
                    ))
                } else {
                    StageCompletion::warning(format!(
                        "Diagnostic image was safely rejected; review its overlay and confidence.{audit_summary}"
                    ))
                })
            })
            .await;
            self.finish(&mut state, "diagnostics", outcome, on_progress)?;
        }

        let mut provisional_zip: Option<PathBuf> = None;
        if self.begin(&mut state, "export", "Creating the checksummed extraction bundle…", on_progress)? {
            let outcome = stage(async {
                self.write_report(&state, false)?;
                let zip = self.exporter.export_extraction(&model_version, cancel).await?;
                provisional_zip = Some(zip.clone());
                state.export_path = Some(zip.clone());
                Ok(StageCompletion::passed(format!("Created {}.", file_name(&zip))))
            })
            .await;
            self.finish(&mut state, "export", outcome, on_progress)?;
        }
        if self.begin(&mut state, "verify", "Reopening the ZIP and hashing every entry…", on_progress)? {
            let outcome = stage(async {
                let zip =
                    state.export_path.clone().ok_or_else(|| inconsistent("Extraction export path is missing."))?;
                let verified = self.exporter.verify_extraction(&zip, cancel).await?;
                Ok(StageCompletion::passed(format!("Verified all {} checksummed entries.", verified.verified_entries)))
            })
            .await;
            self.finish(&mut state, "verify", outcome, on_progress)?;
        }

        state.completed = true;
        state.completed_utc = Some(Utc::now());
        self.write_report(&state, true)?;
        self.save_state(&state)?;
        let final_zip = self.exporter.export_extraction(&model_version, cancel).await?;
        self.exporter.verify_extraction(&final_zip, cancel).await?;
        state.export_path = Some(final_zip.clone());
        self.save_state(&state)?;
        if let Some(provisional) = provisional_zip
            && !eq_ignore_case(&provisional.to_string_lossy(), &final_zip.to_string_lossy())
            && provisional.is_file()
        {
            std::fs::remove_file(&provisional)?;
        }
        self.exporter.export_extraction_handoff(&model_version, cancel).await?;
        Ok(to_snapshot(&state))
    }

    /// Runs the latest ready extractor on one chosen photo. Returns the folder its diagnostic was written to.
    pub async fn run_diagnostic(
        &self,
        image_path: &Path,
        profile: &CudaTrainingProfile,
        on_line: &OnLine,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        let model_version = self.resolve_latest_ready_model_version()?;
        let artifact_root = self.paths.artifact_root(&model_version);
        let selected_image = std::path::absolute(image_path)?;
        ensure_file(&selected_image, "selected diagnostic image")?;
        let extension = selected_image.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
            return Err(invalid("Choose a JPG, JPEG, or PNG photograph for extraction testing."));
        }
        ensure_file(&artifact_root.join("best.pt"), "best extraction checkpoint")?;
        ensure_file(&artifact_root.join("thresholds.json"), "extraction thresholds")?;
        let output = Self::create_manual_diagnostic_output_path(&artifact_root);
        let mut arguments = cli![
            "rectify-extraction",
            "--checkpoint",
            artifact_root.join("best.pt"),
            "--thresholds",
            artifact_root.join("thresholds.json"),
            "--image",
            selected_image,
            "--output-root",
            output,
            "--device",
            "cuda",
            "--cuda-device-index",
            profile.device_index,
        ];
        // Older imported models predate the refiner and are diagnosed with coarse corners only.
        let refiner = artifact_root.join("refiner.pt");
        if refiner.is_file() {
            arguments.extend(cli!["--refiner", refiner]);
        }
        self.run_cli(arguments, &format!("{model_version}-manual-diagnostic"), on_line, cancel).await?;
        Ok(output)
    }

    pub fn create_manual_diagnostic_output_path(artifact_root: &Path) -> PathBuf {
        artifact_root.join("diagnostics").join("manual").join(format!(
            "{}-{}",
            Utc::now().format("%Y%m%d-%H%M%S%3f"),
            uuid::Uuid::new_v4().simple()
        ))
    }

    pub fn next_lower_batch(current_batch: i32) -> i32 {
        1.max(current_batch / 2)
    }

    fn begin(&self, state: &mut ExtractionState, id: &str, detail: &str, on_progress: OnProgress<'_>) -> Result<bool> {
        if is_complete(state, id) {
            return Ok(false);
        }
        set_stage(state, id, ProductionStageStatus::Running, detail)?;
        self.save_state(state)?;
        if let Some(report) = on_progress {
            report(to_snapshot(state));
        }
        Ok(true)
    }

    fn finish(
        &self,
        state: &mut ExtractionState,
        id: &str,
        outcome: Result<StageCompletion>,
        on_progress: OnProgress<'_>,
    ) -> Result<()> {
        let failure = match outcome {
            Ok(completion) => {
                set_stage(state, id, completion.status, &completion.detail)?;
                None
            }
            Err(error) => {
                if is_cancelled(&error) {
                    set_stage(
                        state,
                        id,
                        ProductionStageStatus::Cancelled,
                        "Cancelled safely; completed stages and checkpoints are retained.",
                    )?;
                } else {
                    set_stage(
                        state,
                        id,
                        ProductionStageStatus::Failed,
                        "Stage failed. Review the activity log, then run again to retry.",
                    )?;
                }
                Some(error)
            }
        };
        self.save_state(state)?;
        if let Some(report) = on_progress {
            report(to_snapshot(state));
        }
        failure.map_or(Ok(()), Err)
    }

    async fn run_cuda_smoke(
        &self,
        state: &mut ExtractionState,
        profile: &CudaTrainingProfile,
        on_line: &OnLine,
        cancel: &CancellationToken,
    ) -> Result<PythonRunResult> {
        let manifest = self.paths.manifest_path(&state.dataset_version);
        let command = |batch: i32| {
            cli![
                "extraction-smoke",
                "--manifest",
                manifest,
                "--device",
                "cuda",
                "--cuda-device-index",
                profile.device_index,
                "--batch-size",
                batch,
                "--steps",
                "2",
            ]
        };
        let log_name =
            |state: &ExtractionState| format!("{}-extractor-smoke-{}", state.model_version, state.batch_size);
        let mut result = self.run_cli_raw(command(state.batch_size), &log_name(state), on_line, cancel).await?;
        while result.exit_code != 0 && is_out_of_memory(&result) && state.batch_size > 1 {
            state.batch_size = Self::next_lower_batch(state.batch_size);
            self.save_state(state)?;
            result = self.run_cli_raw(command(state.batch_size), &log_name(state), on_line, cancel).await?;
        }
        ensure_success(&result)?;
        Ok(result)
    }

    async fn run_cli(
        &self,
        command: Vec<String>,
        log_name: &str,
        on_line: &OnLine,
        cancel: &CancellationToken,
    ) -> Result<PythonRunResult> {
        run_training_cli(&self.runner, &self.paths, command, log_name, on_line, cancel).await
    }

    async fn run_cli_raw(
        &self,
        command: Vec<String>,
        log_name: &str,
        on_line: &OnLine,
        cancel: &CancellationToken,
    ) -> Result<PythonRunResult> {
        run_training_cli_raw(&self.runner, &self.paths, command, log_name, on_line, cancel).await
    }

    fn read_known_sample(&self, dataset_version: &str) -> Result<PathBuf> {
        for line in read_text(&self.paths.manifest_path(dataset_version))?.lines() {
            let record: Value = serde_json::from_str(line)?;
            if !get_bool(property(&record, "card_present")?)? {
                continue;
            }
            let relative = get_string(property(&record, "image_path")?)?
                .ok_or_else(|| inconsistent("Extraction manifest sample path is empty."))?;
            return ensure_contained(&self.paths.data_root.join(relative.replace('/', "\\")), &self.paths.data_root);
        }
        Err(inconsistent("Extraction manifest has no positive diagnostic sample."))
    }

    fn write_report(&self, state: &ExtractionState, completed: bool) -> Result<()> {
        let artifact_root = self.paths.artifact_root(&state.model_version);
        std::fs::create_dir_all(&artifact_root)?;
        let stages = STAGE_DEFINITIONS
            .iter()
            .map(|(id, _)| state.stages.get(*id).ok_or_else(|| key_not_found(id)))
            .collect::<Result<Vec<_>>>()?;
        let mut report = json!({
            "extraction_report_schema_version": 4,
            "artifact_schema_version": 2,
            "dataset_version": state.dataset_version,
            "model_version": state.model_version,
            "include_synthetic_cards": state.include_synthetic_cards,
            "architecture": EXTRACTOR_ARCHITECTURE,
            "training_recipe_version": TRAINING_RECIPE_VERSION,
            "checkpoint_selection_policy": state.checkpoint_selection_policy,
            "independent_from_identity": true,
            "input_size": 320,
            "heatmap_size": 80,
            "decoder_channels": 48,
        });
        report["geometry_contract"] = json!({
            "corner_heatmap": "generic-plus-four-semantic-subcell-centred",
            "offsets": "3x3-neighbourhood-trained-range-1.5-cells",
            "corner_convention": CameraAnnotationStore::CORNER_CONVENTION,
            "refiner": {
                "architecture": REFINER_ARCHITECTURE, "crop_size": 128, "crop_half_extent": 0.075,
                "frame": "corner-centre-next-edge-right-previous-edge-down", "passes": 2,
            },
            "mask": "physical-card-excluding-sleeve",
            "semantic_corner_classes": 4,
            "orientation_classes": 4,
            "corner_anchor": "screen-top-left-v2",
            "orientation_metric": "best-cyclic-final-semantic-order",
            "candidate_score": "mean-log-corner-confidence-plus-2x-mask-iou",
        });
        report["corner_order"] = json!(["TopLeft", "TopRight", "BottomRight", "BottomLeft"]);
        report["coordinate_contract"] = json!("EXIF-normalized image; x/(width-1), y/(height-1); printed orientation");
        report["rectified_output"] =
            json!({ "width": recognition_crop::CARD_WIDTH, "height": recognition_crop::CARD_HEIGHT });
        report["recognition_crop_v1"] = json!({
            "left": 0.08, "top": 0.11, "right": 0.92, "bottom": 0.49,
            "canonical_pixels": {
                "left": recognition_crop::LEFT, "top": recognition_crop::TOP,
                "right": recognition_crop::RIGHT, "bottom": recognition_crop::BOTTOM,
            },
            "inspection_resize": { "width": 224, "height": 224, "resampling": "bicubic" },
            "production_identity_contract_changed": false,
        });
        report["gpu_profile"] = json!({
            "device_index": state.gpu_index, "name": state.gpu_name, "vram_mib": state.vram_mib,
            "profile": state.gpu_profile, "effective_batch_size": state.batch_size,
        });
        report["stages"] = serde_json::to_value(stages)?;
        report["completed_epoch"] = json!(state.completed_epoch);
        report["evaluation"] = json!(state.evaluation);
        report["baseline_trained"] = json!(state.completed_epoch > 0);
        report["extraction_qualified"] = json!(state.qualified);
        report["phase_completion"] = json!({
            "engineering_complete": completed,
            "baseline_trained": state.completed_epoch > 0 && state.evaluation.is_some(),
            "extraction_qualified": state.qualified,
        });
        report["mobile_export_performed"] = json!(false);
        report["identity_inference_performed"] = json!(false);
        report["started_utc"] = json!(state.started_utc);
        report["completed_utc"] = json!(if completed { state.completed_utc } else { None });
        report["logs"] = json!(log_file_names(&state.logs));
        atomic_write(&artifact_root.join("extraction-report.json"), &serde_json::to_string_pretty(&report)?, false)
    }

    fn validate_completed_artifacts(&self, state: &ExtractionState) -> Result<()> {
        if is_complete(state, "dataset") {
            ensure_file(&self.paths.manifest_path(&state.dataset_version), "extraction manifest")?;
        }
        let root = self.paths.artifact_root(&state.model_version);
        if is_complete(state, "quick") {
            let learning_report = root.join("learning-check.json");
            ensure_file(&learning_report, "real-photo learning check")?;
            if !get_bool(property(&read_json(&learning_report)?, "passed")?)? {
                return Err(inconsistent("Recorded real-photo learning check did not pass."));
            }
        }
        if is_complete(state, "train") {
            ensure_file(&root.join("best.pt"), "best extraction checkpoint")?;
            ensure_file(&root.join("last.pt"), "last extraction checkpoint")?;
        }
        if is_complete(state, "refiner") {
            ensure_file(&root.join("refiner.pt"), "corner refiner checkpoint")?;
        }
        if is_complete(state, "evaluate") {
            ensure_file(&root.join("evaluation.json"), "extraction evaluation")?;
            ensure_file(&root.join("extractor.pt"), "compact extractor")?;
        }
        if is_complete(state, "export") && !state.export_path.as_ref().is_some_and(|path| path.is_file()) {
            return Err(inconsistent("Recorded extraction result ZIP is missing."));
        }
        Ok(())
    }

    fn select_run_for_execution(&self, include_synthetic_cards: bool) -> Result<ExtractionState> {
        std::fs::create_dir_all(&self.paths.extraction_production_root)?;
        let active_version = self.read_active_model_version()?;
        if let Some(current) = self.load_state(&active_version)?
            && !current.completed
            && current.include_synthetic_cards == include_synthetic_cards
            && current.is_current_recipe()
            && self.files_intact(&current)?
        {
            return Ok(current);
        }
        self.create_fresh_run(include_synthetic_cards)
    }

    // A run whose recorded files are gone can't resume; a fresh run leaves it, and every other, as it is.
    fn files_intact(&self, state: &ExtractionState) -> Result<bool> {
        match self.validate_completed_artifacts(state) {
            Ok(()) => Ok(true),
            Err(error) if error.is::<InvalidOperation>() => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn create_fresh_run(&self, include_synthetic_cards: bool) -> Result<ExtractionState> {
        std::fs::create_dir_all(&self.paths.extraction_production_root)?;
        for attempt in 0..10 {
            let stamp = (Utc::now() + Duration::milliseconds(attempt)).format("%Y%m%dT%H%M%S%3fZ");
            let model_version = format!("{TIMESTAMPED_MODEL_PREFIX}{stamp}");
            if self.paths.artifact_root(&model_version).is_dir() || self.state_path(&model_version).is_file() {
                continue;
            }
            self.reset_working_dataset()?;
            let mut state = ExtractionState::new(&model_version, "corners-current", include_synthetic_cards);
            let previous = self.read_active_model_version()?;
            state.baseline_model_version = match self.find_latest_timestamped_baseline(Some(&model_version))? {
                Some(baseline) => Some(baseline),
                None => self.find_completed_baseline(Some(previous), Some(&model_version))?,
            };
            atomic_write(&self.active_model_path(), &format!("{model_version}\r\n"), false)?;
            self.save_state(&state)?;
            return Ok(state);
        }
        Err(invalid("Could not allocate a fresh card-extraction training run. Try again."))
    }

    fn find_completed_baseline(
        &self,
        version: Option<String>,
        excluded_version: Option<&str>,
    ) -> Result<Option<String>> {
        let mut visited = HashSet::new();
        let mut version = version;
        while let Some(current) = version.take()
            && is_safe_version(&current)
            && visited.insert(current.clone())
        {
            if self.is_completed_baseline(&current, excluded_version) {
                return Ok(Some(current));
            }
            match self.load_state(&current) {
                Ok(state) => version = state.and_then(|state| state.baseline_model_version),
                // Discovery can recover from an obsolete, unreadable state.
                Err(error) if error.is::<InvalidOperation>() => break,
                Err(error) => return Err(error),
            }
        }
        if self.paths.artifacts_root.is_dir() {
            let mut candidates = directory_names(&self.paths.artifacts_root)?;
            candidates.sort_by(|a, b| {
                (parse_timestamped_model_version(b), b.as_str()).cmp(&(parse_timestamped_model_version(a), a.as_str()))
            });
            if let Some(candidate) =
                candidates.into_iter().find(|candidate| self.is_completed_baseline(candidate, excluded_version))
            {
                return Ok(Some(candidate));
            }
        }
        Ok(None)
    }

    fn is_completed_baseline(&self, version: &str, excluded_version: Option<&str>) -> bool {
        if !is_safe_version(version) || Some(version) == excluded_version {
            return false;
        }
        let root = self.paths.artifact_root(version);
        if !root.join("best.pt").is_file() || !root.join("evaluation.json").is_file() {
            return false;
        }
        // Identity and disposable learning-check artifacts are not extraction baselines.
        (|| -> Result<bool> {
            let report = read_json(&root.join("evaluation.json"))?;
            Ok(try_property(&report, "evaluation_schema_version")?.is_some()
                && match try_property(&report, "model_version")? {
                    Some(model) => get_string(model)?.as_deref() == Some(version),
                    None => false,
                }
                && try_property(&report, "validation_metrics")?.is_some())
        })()
        .unwrap_or(false)
    }

    fn is_suggestion_model_ready(&self, version: &str) -> bool {
        if !is_safe_version(version) {
            return false;
        }
        let root = self.paths.artifact_root(version);
        let thresholds_path = root.join("thresholds.json");
        let evaluation_path = root.join("evaluation.json");
        if !root.join("best.pt").is_file()
            || !root.join("extractor.pt").is_file()
            || !thresholds_path.is_file()
            || !evaluation_path.is_file()
        {
            return false;
        }
        let names_version = |path: &Path| self.named_model_version(path).as_deref() == Some(version);
        names_version(&thresholds_path) && names_version(&evaluation_path)
    }

    /// The `model_version` a run's JSON names. Every corner suggestion asks, and evaluation.json runs to 100 MB: the
    /// rest of the file is skipped unread, and the answer is kept until the file changes.
    fn named_model_version(&self, path: &Path) -> Option<String> {
        #[derive(Deserialize)]
        struct Named {
            model_version: Option<String>,
        }
        let metadata = std::fs::metadata(path).ok()?;
        let stamp = (metadata.modified().ok()?, metadata.len());
        let mut cache = self.model_versions.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((cached, version)) = cache.get(path)
            && *cached == stamp
        {
            return version.clone();
        }
        let version = read_text(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Named>(&text).ok())
            .and_then(|named| named.model_version);
        cache.insert(path.to_path_buf(), (stamp, version.clone()));
        version
    }

    fn suggestion_model(&self, version: &str) -> ExtractionSuggestionModel {
        let root = self.paths.artifact_root(version);
        let refiner = root.join("refiner.pt");
        ExtractionSuggestionModel {
            model_version: version.into(),
            checkpoint_path: root.join("extractor.pt"),
            thresholds_path: root.join("thresholds.json"),
            refiner_path: refiner.is_file().then_some(refiner),
        }
    }

    fn resolve_latest_ready_model_version(&self) -> Result<String> {
        if let Some(latest) =
            self.find_latest_timestamped_model(|version| self.is_suggestion_model_ready(version), None)?
        {
            return Ok(latest);
        }
        // Retain compatibility with an older, non-timestamped completed extractor.
        if let Some(baseline) = self.find_completed_baseline(Some(self.read_active_model_version()?), None)?
            && self.is_suggestion_model_ready(&baseline)
        {
            return Ok(baseline);
        }
        Err(invalid(
            "No completed extraction model is available. Copy or train a complete extractor-run-<timestamp> artifact folder first.",
        ))
    }

    fn find_latest_timestamped_baseline(&self, excluded_version: Option<&str>) -> Result<Option<String>> {
        self.find_latest_timestamped_model(
            |version| self.is_completed_baseline(version, excluded_version),
            excluded_version,
        )
    }

    fn find_latest_timestamped_model(
        &self,
        is_eligible: impl Fn(&str) -> bool,
        excluded_version: Option<&str>,
    ) -> Result<Option<String>> {
        if !self.paths.artifacts_root.is_dir() {
            return Ok(None);
        }
        let mut candidates: Vec<_> = directory_names(&self.paths.artifacts_root)?
            .into_iter()
            .filter_map(|version| parse_timestamped_model_version(&version).map(|timestamp| (timestamp, version)))
            .filter(|(_, version)| Some(version.as_str()) != excluded_version)
            .collect();
        // Newest first, stopping at the first eligible one: checking a run reads its files.
        candidates.sort_unstable_by(|a, b| b.cmp(a));
        Ok(candidates.into_iter().map(|(_, version)| version).find(|version| is_eligible(version)))
    }

    fn reset_working_dataset(&self) -> Result<()> {
        let targets = [
            (self.paths.dataset_root("corners-current"), &self.paths.exports_root),
            (self.paths.extraction_root.join("synthetic").join("corners-current"), &self.paths.extraction_root),
        ];
        for (path, root) in targets {
            ensure_contained(&path, root)?;
            if path.is_dir() {
                std::fs::remove_dir_all(&path)?;
            }
        }
        Ok(())
    }

    fn read_active_model_version(&self) -> Result<String> {
        let path = self.active_model_path();
        if !path.is_file() {
            return Ok(Self::INITIAL_MODEL_VERSION.into());
        }
        let value = read_text(&path)?.trim().to_string();
        if !is_safe_version(&value) {
            return Err(inconsistent("The active extraction model pointer is invalid."));
        }
        Ok(value)
    }

    fn state_path(&self, model_version: &str) -> PathBuf {
        self.paths.extraction_production_root.join(format!("{model_version}-state.json"))
    }

    fn load_state(&self, model_version: &str) -> Result<Option<ExtractionState>> {
        let path = self.state_path(model_version);
        if !path.is_file() {
            return Ok(None);
        }
        match serde_json::from_str::<Option<ExtractionState>>(&read_text(&path)?) {
            Ok(Some(state)) => Ok(Some(state)),
            Ok(None) => Err(inconsistent("Extraction state is empty.")),
            Err(error) => Err(inconsistent(&format!("Extraction state is unreadable: {error}"))),
        }
    }

    fn save_state(&self, state: &ExtractionState) -> Result<()> {
        let text = serde_json::to_string_pretty(state)?;
        atomic_write(&self.state_path(&state.model_version), &text, false)?;
        let artifact_root = self.paths.artifact_root(&state.model_version);
        std::fs::create_dir_all(&artifact_root)?;
        atomic_write(&artifact_root.join("workflow-state.json"), &text, false)
    }
}

fn validate_identity(state: &ExtractionState, model_version: &str) -> Result<()> {
    if !state.is_current_recipe()
        || state.dataset_version.trim().is_empty()
        || state.model_version != model_version
        || state.seed != ExtractionProductionWorkflowService::SEED
    {
        return Err(inconsistent("Existing extraction production state belongs to a different workflow."));
    }
    Ok(())
}

fn set_stage(state: &mut ExtractionState, id: &str, status: ProductionStageStatus, detail: &str) -> Result<()> {
    let stage = state.stages.get_mut(id).ok_or_else(|| key_not_found(id))?;
    stage.status = status;
    stage.detail = detail.into();
    Ok(())
}

fn is_complete(state: &ExtractionState, id: &str) -> bool {
    state
        .stages
        .get(id)
        .is_some_and(|stage| matches!(stage.status, ProductionStageStatus::Passed | ProductionStageStatus::Warning))
}

fn to_snapshot(state: &ExtractionState) -> ExtractionWorkflowSnapshot {
    let outcome = workflow_outcome(state.completed, state.qualified, state.stages.values().map(|stage| stage.status));
    let summary = match outcome {
        ProductionWorkflowOutcome::Passed => "✓ Card extraction qualified",
        ProductionWorkflowOutcome::Warning => "Artifacts exported · real-camera extraction is not yet qualified",
        ProductionWorkflowOutcome::Failed => "Extraction workflow stopped · review the activity log",
        ProductionWorkflowOutcome::Running => "Card extraction workflow in progress",
        ProductionWorkflowOutcome::Ready => "Ready to run or resume card extraction",
    };
    ExtractionWorkflowSnapshot {
        outcome,
        summary: summary.into(),
        dataset_version: state.dataset_version.clone(),
        model_version: state.model_version.clone(),
        stages: STAGE_DEFINITIONS
            .iter()
            .map(|(id, name)| match state.stages.get(*id) {
                Some(stage) => stage_result(&stage.id, &stage.name, stage.status, &stage.detail),
                None => stage_result(id, name, ProductionStageStatus::Pending, "Waiting."),
            })
            .collect(),
        gpu_name: state.gpu_name.clone(),
        gpu_profile: state.gpu_profile.clone(),
        batch_size: Some(state.batch_size),
        completed_epoch: state.completed_epoch,
        export_path: state.export_path.clone(),
        include_synthetic_cards: state.include_synthetic_cards,
    }
}

fn empty_snapshot(model_version: &str, summary: &str) -> ExtractionWorkflowSnapshot {
    ExtractionWorkflowSnapshot {
        outcome: ProductionWorkflowOutcome::Ready,
        summary: summary.into(),
        dataset_version: ExtractionProductionWorkflowService::DATASET_VERSION.into(),
        model_version: model_version.into(),
        stages: pending_stages(STAGE_DEFINITIONS),
        gpu_name: None,
        gpu_profile: None,
        batch_size: None,
        completed_epoch: 0,
        export_path: None,
        include_synthetic_cards: false,
    }
}

fn last_epoch(result: &PythonRunResult) -> Result<Option<i32>> {
    if let Some(completed) = last_event(&result.events, "extraction_training_completed") {
        return Ok(Some(get_i32(property(completed, "completed_epoch")?)?));
    }
    last_event(&result.events, "extraction_epoch_completed").map(|event| get_i32(property(event, "epoch")?)).transpose()
}

fn parse_timestamped_model_version(version: &str) -> Option<DateTime<Utc>> {
    let timestamp = version.strip_prefix(TIMESTAMPED_MODEL_PREFIX)?;
    NaiveDateTime::parse_from_str(timestamp, TIMESTAMPED_MODEL_FORMAT).ok().map(|parsed| parsed.and_utc())
}

/// The names of the folders directly in `root`.
fn directory_names(root: &Path) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok(names)
}

/// Files below `root` whose lowercase name passes `matches`; 0 when `root` doesn't exist.
fn count_files(root: &Path, matches: impl Fn(&str) -> bool) -> Result<i64> {
    if !root.is_dir() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry?;
        if entry.file_type().is_file() && matches(&entry.file_name().to_string_lossy().to_lowercase()) {
            count += 1;
        }
    }
    Ok(count)
}

fn ensure_file(path: &Path, description: &str) -> Result<()> {
    if !path.is_file() {
        return Err(inconsistent(&format!("Completed {description} is missing: {}", path.display())));
    }
    Ok(())
}

fn ensure_contained(target: &Path, root: &Path) -> Result<PathBuf> {
    let full = std::path::absolute(target)?;
    let allowed = format!("{}\\", std::path::absolute(root)?.to_string_lossy());
    if !full.to_string_lossy().to_lowercase().starts_with(&allowed.to_lowercase()) {
        return Err(inconsistent("Extraction path escapes the data root."));
    }
    Ok(full)
}

fn inconsistent(detail: &str) -> anyhow::Error {
    invalid(format!("Extraction workflow state is inconsistent. {detail}"))
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct PersistedStage {
    id: String,
    name: String,
    status: ProductionStageStatus,
    detail: String,
}

/// The run's state file, PascalCase on disk (C#'s default property names).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct ExtractionState {
    schema_version: i32,
    training_recipe_version: i32,
    checkpoint_selection_policy: Option<String>,
    baseline_model_version: Option<String>,
    dataset_version: String,
    model_version: String,
    seed: i32,
    started_utc: DateTime<Utc>,
    completed_utc: Option<DateTime<Utc>>,
    completed: bool,
    include_synthetic_cards: bool,
    qualified: bool,
    dataset_ready: bool,
    gpu_name: Option<String>,
    gpu_index: i32,
    #[serde(rename = "VramMiB")]
    vram_mib: i64,
    gpu_profile: Option<String>,
    batch_size: i32,
    completed_epoch: i32,
    stages: BTreeMap<String, PersistedStage>,
    logs: Vec<PathBuf>,
    evaluation: Option<Value>,
    export_path: Option<PathBuf>,
}

impl Default for ExtractionState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            training_recipe_version: 1,
            checkpoint_selection_policy: None,
            baseline_model_version: None,
            dataset_version: ExtractionProductionWorkflowService::DATASET_VERSION.into(),
            model_version: String::new(),
            seed: ExtractionProductionWorkflowService::SEED,
            started_utc: Utc::now(),
            completed_utc: None,
            completed: false,
            // Runs saved before this option existed always included synthetic scenes.
            include_synthetic_cards: true,
            qualified: false,
            dataset_ready: false,
            gpu_name: None,
            gpu_index: 0,
            vram_mib: 0,
            gpu_profile: None,
            batch_size: 0,
            completed_epoch: 0,
            stages: BTreeMap::new(),
            logs: Vec::new(),
            evaluation: None,
            export_path: None,
        }
    }
}

impl ExtractionState {
    fn new(model_version: &str, dataset_version: &str, include_synthetic_cards: bool) -> Self {
        Self {
            dataset_version: dataset_version.into(),
            model_version: model_version.into(),
            include_synthetic_cards,
            schema_version: STATE_SCHEMA_VERSION,
            training_recipe_version: TRAINING_RECIPE_VERSION,
            checkpoint_selection_policy: Some(CHECKPOINT_SELECTION_POLICY.into()),
            stages: STAGE_DEFINITIONS
                .iter()
                .map(|(id, name)| {
                    let stage = PersistedStage {
                        id: (*id).into(),
                        name: (*name).into(),
                        status: ProductionStageStatus::Pending,
                        detail: "Waiting.".into(),
                    };
                    ((*id).to_string(), stage)
                })
                .collect(),
            ..Self::default()
        }
    }

    fn is_current_recipe(&self) -> bool {
        self.schema_version == STATE_SCHEMA_VERSION
            && self.training_recipe_version == TRAINING_RECIPE_VERSION
            && self.checkpoint_selection_policy.as_deref() == Some(CHECKPOINT_SELECTION_POLICY)
    }
}
