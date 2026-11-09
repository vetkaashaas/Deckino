use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, anyhow};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::error::is_cancelled;
use crate::paths::TrainingPaths;
use crate::python::{PythonProcessRunner, PythonRunResult};
use crate::training_environment::CudaTrainingProfile;
use crate::training_result_exporter::TrainingResultExporter;

/// Written as lowercase strings: both state files use a string enum converter (camelCase / snake_case_lower, which
/// agree on these one-word names).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductionStageStatus {
    #[default]
    Pending,
    Running,
    Passed,
    Warning,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProductionWorkflowOutcome {
    #[default]
    Ready,
    Running,
    Passed,
    Warning,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProductionStageResult {
    pub id: String,
    pub name: String,
    pub status: ProductionStageStatus,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdentityProductionSnapshot {
    pub outcome: ProductionWorkflowOutcome,
    pub summary: String,
    pub dataset_version: String,
    pub model_version: String,
    pub stages: Vec<ProductionStageResult>,
    pub gpu_name: Option<String>,
    pub gpu_profile: Option<String>,
    pub batch_size: Option<i32>,
    pub completed_epoch: i32,
    /// The selected checkpoint's file name.
    pub selected_checkpoint: Option<String>,
    pub export_path: Option<PathBuf>,
}

/// A Python line as it arrives: the text, and the JSON event when it parsed as one.
pub type OnLine = dyn Fn(&str, Option<&Value>) + Send + Sync;

const STATE_SCHEMA_VERSION: i32 = 2;

const STAGE_DEFINITIONS: &[(&str, &str)] = &[
    ("dataset", "Build artwork catalog"),
    ("cuda", "GPU profile & CUDA smoke"),
    ("evidence_index", "Index a prior model if available"),
    ("evidence_evaluate", "Measure prior retrieval quality"),
    ("train", "Retrain only if required"),
    ("final_index", "Build & qualify final index"),
    ("recognize", "Recognition diagnostics"),
    ("export", "Export result ZIP"),
    ("verify", "Verify SHA-256 checksums"),
];

pub struct IdentityProductionWorkflowService {
    paths: TrainingPaths,
    runner: Arc<PythonProcessRunner>,
    exporter: Arc<TrainingResultExporter>,
}

impl IdentityProductionWorkflowService {
    pub const DATASET_VERSION: &str = "paper-art-v4";
    pub const INITIAL_MODEL_VERSION: &str = "mobilenetv3s-512-art-v4";
    pub const EXISTING_MODEL_VERSION: &str = "mobilenetv3s-512-v3";
    pub const SEED: i32 = 20260823;
    pub const EPOCHS: i32 = 30;
    pub const WORKERS: i32 = 4;
    pub const EMBEDDING_DIMENSION: i32 = 512;
    pub const LEARNING_RATE: &str = "3e-4";
    // Training-view recipe (training/src/deckino_training/camera_augmentation.py). camera-real-v1 also trains on
    // the camera photos labelled on the Identify Card page, so sync the camera dataset before training.
    pub const AUGMENTATION_RECIPE: &str = "camera-real-v1";

    pub fn new(paths: TrainingPaths, runner: Arc<PythonProcessRunner>, exporter: Arc<TrainingResultExporter>) -> Self {
        Self { paths, runner, exporter }
    }

    pub fn active_model_path(&self) -> PathBuf {
        self.paths.production_root.join("active-artwork-model.txt")
    }

    pub fn active_model_version(&self) -> Result<String> {
        self.read_active_model_version()
    }

    pub fn inspect(&self) -> Result<IdentityProductionSnapshot> {
        let model_version = self.read_active_model_version()?;
        let Some(state) = self.load_state(&model_version)? else {
            return Ok(empty_snapshot(&model_version, "Ready to train the card recognizer."));
        };
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
        on_progress: Option<&(dyn Fn(IdentityProductionSnapshot) + Send + Sync)>,
        cancel: &CancellationToken,
    ) -> Result<IdentityProductionSnapshot> {
        let paths = &self.paths;
        std::fs::create_dir_all(&paths.production_root)?;
        let mut state = self.select_run_for_execution()?;
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
                "GPU changed; CUDA validation will run again.",
            )?;
        }
        state.gpu_name = Some(profile.gpu_name.clone());
        state.gpu_index = profile.device_index;
        state.gpu_profile = Some(profile.label.clone());
        state.vram_mib = profile.vram_mib;
        if gpu_changed || state.batch_size == 0 {
            state.batch_size = profile.batch_size;
        }
        self.save_state(&state)?;

        let manifest = paths.manifest_path(&state.dataset_version);

        if self.begin(
            &mut state,
            "dataset",
            "Reading the latest synced artwork and building this run's snapshot…",
            on_progress,
        )? {
            let outcome = stage(async {
                let result = self
                    .run_cli(
                        cli!["prepare-artwork", "--data-root", paths.data_root, "--dataset-version", state.dataset_version],
                        &format!("prepare-{}", state.dataset_version),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(result.log_path);
                self.validate_dataset(&state.dataset_version)?;
                let report = read_json(&paths.dataset_root(&state.dataset_version).join("report.json"))?;
                let ambiguous = match try_property(&report, "ambiguous_illustrations")? {
                    Some(count) => get_i32(count)?,
                    None => 0,
                };
                Ok(StageCompletion::passed(format!(
                    "Created or recovered the schema-v5 catalog; {} shared artworks are indexed but require ambiguity rejection.",
                    crate::n0(ambiguous)
                )))
            })
            .await;
            self.finish(&mut state, "dataset", outcome, on_progress)?;
        }

        let detail = format!("Testing {} at batch {}…", profile.gpu_name, state.batch_size);
        if self.begin(&mut state, "cuda", &detail, on_progress)? {
            let outcome = stage(async {
                let result = self.run_cuda_smoke(&mut state, profile, on_line, cancel).await?;
                state.logs.push(result.log_path);
                Ok(StageCompletion::passed(format!(
                    "Selected {} ({} MiB) and passed at batch {}.",
                    profile.gpu_name,
                    crate::n0(state.vram_mib),
                    state.batch_size
                )))
            })
            .await;
            self.finish(&mut state, "cuda", outcome, on_progress)?;
        }

        let artifact_root = paths.artifact_root(&model_version);
        let index_root = artifact_root.join("index");
        let existing_checkpoint = paths.artifact_root(Self::EXISTING_MODEL_VERSION).join("best.pt");
        if !is_complete(&state, "evidence_index") && !is_complete(&state, "evidence_evaluate") {
            state.bootstrap_training_required = Self::requires_bootstrap_training(&existing_checkpoint);
            self.save_state(&state)?;
        }

        let detail = if state.bootstrap_training_required {
            "No prior model was found; preparing a clean training run…"
        } else {
            "Embedding every catalog artwork with the existing model…"
        };
        if self.begin(&mut state, "evidence_index", detail, on_progress)? {
            let outcome = stage(async {
                if state.bootstrap_training_required {
                    return Ok(StageCompletion::passed(
                        "No compatible prior checkpoint was found; initial artwork training will run from pretrained weights.",
                    ));
                }
                let result = self
                    .run_cli(
                        cli![
                            "build-index", "--manifest", manifest, "--checkpoint", existing_checkpoint,
                            "--output-root", index_root, "--device", "cuda",
                            "--cuda-device-index", state.gpu_index, "--batch-size", state.batch_size,
                        ],
                        &format!("{model_version}-evidence-index"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(result.log_path);
                ensure_index(&index_root)?;
                Ok(StageCompletion::passed("Built clean multi-view artwork prototypes from the existing checkpoint."))
            })
            .await;
            self.finish(&mut state, "evidence_index", outcome, on_progress)?;
        }

        let detail = if state.bootstrap_training_required {
            "Recording the clean-install bootstrap decision…"
        } else {
            "Applying independent calibration and strict retrieval gates…"
        };
        if self.begin(&mut state, "evidence_evaluate", detail, on_progress)? {
            let outcome = stage(async {
                if state.bootstrap_training_required {
                    return Ok(StageCompletion::passed(
                        "Prior-model evaluation was skipped because this clean installation has no checkpoint to compare.",
                    ));
                }
                let report_path = artifact_root.join("retrieval-report.json");
                let result = self
                    .run_cli(
                        cli![
                            "evaluate-index", "--manifest", manifest, "--checkpoint", existing_checkpoint,
                            "--index-root", index_root, "--output", report_path, "--device", "cuda",
                            "--cuda-device-index", state.gpu_index, "--batch-size", state.batch_size,
                        ],
                        &format!("{model_version}-evidence-evaluate"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(result.log_path);
                let retrieval = read_json(&report_path)?;
                state.qualified = get_bool(property(&retrieval, "qualified")?)?;
                state.selected_checkpoint_path = Some(existing_checkpoint.clone());
                // The strict gate is synthetic, so a prior model can pass it and still be weak on real
                // camera frames. Only skip retraining when it was trained with the current recipe.
                let prior_recipe = Self::training_augmentation(&retrieval);
                state.retrieval = Some(retrieval);
                if state.qualified && prior_recipe != Self::AUGMENTATION_RECIPE {
                    state.qualified = false;
                    return Ok(StageCompletion::warning(format!(
                        "Existing embeddings pass the synthetic gate but were trained with '{prior_recipe}' views; retraining with '{}'.",
                        Self::AUGMENTATION_RECIPE
                    )));
                }
                Ok(if state.qualified {
                    StageCompletion::passed("Existing embeddings passed the strict artwork gate; retraining is unnecessary.")
                } else {
                    StageCompletion::warning("Existing embeddings missed the strict gate; paired-view retraining will run.")
                })
            })
            .await;
            self.finish(&mut state, "evidence_evaluate", outcome, on_progress)?;
        }

        let trained_checkpoint = artifact_root.join("best.pt");
        let detail = if state.qualified {
            "Recording the evidence-first skip decision…".to_string()
        } else if state.bootstrap_training_required {
            format!("Training the initial artwork model through epoch {}…", Self::EPOCHS)
        } else {
            format!("Training paired artwork views through epoch {}…", Self::EPOCHS)
        };
        if self.begin(&mut state, "train", &detail, on_progress)? {
            let outcome = stage(async {
                if state.qualified {
                    return Ok(StageCompletion::passed(
                        "Skipped by design because the cheaper evidence run already qualified.",
                    ));
                }
                let last_checkpoint = artifact_root.join("last.pt");
                let mut arguments = cli![
                    "train-artwork",
                    "--manifest",
                    manifest,
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
                    "--embedding-dim",
                    Self::EMBEDDING_DIMENSION,
                    "--learning-rate",
                    Self::LEARNING_RATE,
                    "--seed",
                    Self::SEED,
                    "--pretrained",
                    "--augmentation",
                    Self::AUGMENTATION_RECIPE,
                ];
                if last_checkpoint.is_file() {
                    arguments.extend(cli!["--resume", last_checkpoint]);
                }
                let result =
                    self.run_cli(arguments, &format!("{model_version}-train-artwork"), on_line, cancel).await?;
                state.logs.push(result.log_path.clone());
                ensure_file(&trained_checkpoint, "artwork best checkpoint")?;
                ensure_file(&last_checkpoint, "artwork last checkpoint")?;
                state.completed_epoch = last_epoch(&result)?.unwrap_or(Self::EPOCHS);
                state.selected_checkpoint_path = Some(trained_checkpoint.clone());
                Ok(StageCompletion::passed(format!(
                    "Completed paired-view artwork training through epoch {}.",
                    state.completed_epoch
                )))
            })
            .await;
            self.finish(&mut state, "train", outcome, on_progress)?;
        }

        if self.begin(
            &mut state,
            "final_index",
            "Building and strictly qualifying the selected embedding index…",
            on_progress,
        )? {
            let outcome = stage(async {
                if state.qualified {
                    return Ok(StageCompletion::passed(
                        "Reused the already-qualified evidence index without recomputation.",
                    ));
                }
                let checkpoint = state.selected_checkpoint_path.clone().unwrap_or_else(|| trained_checkpoint.clone());
                let build = self
                    .run_cli(
                        cli![
                            "build-index",
                            "--manifest",
                            manifest,
                            "--checkpoint",
                            checkpoint,
                            "--output-root",
                            index_root,
                            "--device",
                            "cuda",
                            "--cuda-device-index",
                            state.gpu_index,
                            "--batch-size",
                            state.batch_size,
                        ],
                        &format!("{model_version}-final-index"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(build.log_path);
                let report_path = artifact_root.join("retrieval-report.json");
                let evaluate = self
                    .run_cli(
                        cli![
                            "evaluate-index",
                            "--manifest",
                            manifest,
                            "--checkpoint",
                            checkpoint,
                            "--index-root",
                            index_root,
                            "--output",
                            report_path,
                            "--device",
                            "cuda",
                            "--cuda-device-index",
                            state.gpu_index,
                            "--batch-size",
                            state.batch_size,
                        ],
                        &format!("{model_version}-final-evaluate"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(evaluate.log_path);
                let retrieval = read_json(&report_path)?;
                state.qualified = get_bool(property(&retrieval, "qualified")?)?;
                state.retrieval = Some(retrieval);
                Ok(if state.qualified {
                    StageCompletion::passed("The retrained embedding and final index passed every strict gate.")
                } else {
                    StageCompletion::warning("Artifacts were produced, but the final strict gate did not qualify.")
                })
            })
            .await;
            self.finish(&mut state, "final_index", outcome, on_progress)?;
        }

        if self.begin(&mut state, "recognize", "Checking a known artwork and generated non-card…", on_progress)? {
            let outcome = stage(async {
                let sample = self.read_known_sample(&state.dataset_version)?;
                state.expected_oracle_id = Some(sample.oracle_id.clone());
                state.expected_card_name = Some(sample.card_name.clone());
                let checkpoint = state.selected_checkpoint_path.clone().unwrap_or_else(|| {
                    if trained_checkpoint.is_file() { trained_checkpoint.clone() } else { existing_checkpoint.clone() }
                });
                ensure_file(&checkpoint, "selected recognition checkpoint")?;
                let thresholds = artifact_root.join("artwork-thresholds.json");
                let known = self
                    .run_cli(
                        cli![
                            "recognize-index",
                            "--checkpoint",
                            checkpoint,
                            "--index-root",
                            index_root,
                            "--image",
                            sample.image_path,
                            "--thresholds",
                            thresholds,
                            "--device",
                            "cuda",
                            "--cuda-device-index",
                            state.gpu_index,
                        ],
                        &format!("{model_version}-recognize-known"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(known.log_path.clone());
                let recognition = required_event(&known, "prototype_recognition")?;
                state.known_recognition = Some(recognition.clone());
                let negative_image = self.write_negative_image(&model_version)?;
                let negative = self
                    .run_cli(
                        cli![
                            "recognize-index",
                            "--checkpoint",
                            checkpoint,
                            "--index-root",
                            index_root,
                            "--image",
                            negative_image,
                            "--thresholds",
                            thresholds,
                            "--device",
                            "cuda",
                            "--cuda-device-index",
                            state.gpu_index,
                        ],
                        &format!("{model_version}-recognize-negative"),
                        on_line,
                        cancel,
                    )
                    .await?;
                state.logs.push(negative.log_path.clone());
                state.negative_diagnostic = Some(required_event(&negative, "prototype_recognition")?);
                state.known_recognition_passed = !get_bool(property(&recognition, "rejected")?)?
                    && get_string(property(&recognition, "oracle_id")?)?.as_deref() == Some(sample.oracle_id.as_str());
                Ok(if state.known_recognition_passed {
                    StageCompletion::passed(format!(
                        "Correctly recognized {}; non-card remains diagnostic only.",
                        sample.card_name
                    ))
                } else {
                    StageCompletion::warning(format!(
                        "Known artwork did not pass calibrated recognition for {}.",
                        sample.card_name
                    ))
                })
            })
            .await;
            self.finish(&mut state, "recognize", outcome, on_progress)?;
        }

        let mut provisional_zip: Option<PathBuf> = None;
        if self.begin(&mut state, "export", "Creating the schema-v5 checksummed result bundle…", on_progress)? {
            let outcome = stage(async {
                self.write_report(&state, false)?;
                let zip = self.exporter.export_artwork_identity(&model_version, cancel).await?;
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
                    state.export_path.clone().ok_or_else(|| inconsistent("Production export path is missing."))?;
                let verified = self.exporter.verify_identity(&zip, cancel).await?;
                Ok(StageCompletion::passed(format!("Verified all {} checksummed entries.", verified.verified_entries)))
            })
            .await;
            self.finish(&mut state, "verify", outcome, on_progress)?;
        }

        state.completed = true;
        state.completed_utc = Some(Utc::now());
        state.qualified = state.qualified && state.known_recognition_passed;
        self.write_report(&state, true)?;
        let final_zip = self.exporter.export_artwork_identity(&model_version, cancel).await?;
        self.exporter.verify_identity(&final_zip, cancel).await?;
        state.export_path = Some(final_zip.clone());
        self.save_state(&state)?;
        if let Some(provisional) = provisional_zip
            && !eq_ignore_case(&provisional.to_string_lossy(), &final_zip.to_string_lossy())
            && provisional.is_file()
        {
            std::fs::remove_file(&provisional)?;
        }
        Ok(to_snapshot(&state))
    }

    pub fn next_lower_batch(current_batch: i32) -> i32 {
        16.max(current_batch / 2)
    }

    pub fn requires_bootstrap_training(existing_checkpoint_path: &Path) -> bool {
        !existing_checkpoint_path.is_file()
    }

    /// The recipe a retrieval report's checkpoint was trained with; reports before camera-v1 lack it.
    pub fn training_augmentation(retrieval_report: &Value) -> String {
        match retrieval_report.get("training_augmentation") {
            Some(Value::String(recipe)) => recipe.clone(),
            _ => "legacy".into(),
        }
    }

    fn begin(
        &self,
        state: &mut ProductionState,
        id: &str,
        detail: &str,
        on_progress: Option<&(dyn Fn(IdentityProductionSnapshot) + Send + Sync)>,
    ) -> Result<bool> {
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
        state: &mut ProductionState,
        id: &str,
        outcome: Result<StageCompletion>,
        on_progress: Option<&(dyn Fn(IdentityProductionSnapshot) + Send + Sync)>,
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
                        "Cancelled safely; completed artifacts are retained for resume.",
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
        state: &mut ProductionState,
        profile: &CudaTrainingProfile,
        on_line: &OnLine,
        cancel: &CancellationToken,
    ) -> Result<PythonRunResult> {
        let manifest = self.paths.manifest_path(&state.dataset_version);
        let command = |batch: i32| {
            cli![
                "accelerator-smoke",
                "--manifest",
                manifest,
                "--device",
                "cuda",
                "--cuda-device-index",
                profile.device_index,
                "--batch-size",
                batch,
                "--embedding-dim",
                Self::EMBEDDING_DIMENSION,
                "--steps",
                "2",
            ]
        };
        let mut result = self
            .run_cli_raw(
                command(state.batch_size),
                &format!("{}-cuda-smoke-batch-{}", state.model_version, state.batch_size),
                on_line,
                cancel,
            )
            .await?;
        if result.exit_code != 0 && is_out_of_memory(&result) {
            state.batch_size = Self::next_lower_batch(state.batch_size);
            self.save_state(state)?;
            result = self
                .run_cli_raw(
                    command(state.batch_size),
                    &format!("{}-cuda-smoke-batch-{}", state.model_version, state.batch_size),
                    on_line,
                    cancel,
                )
                .await?;
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

    fn validate_dataset(&self, dataset_version: &str) -> Result<()> {
        ensure_file(&self.paths.manifest_path(dataset_version), "artwork manifest")?;
        let dataset_root = self.paths.dataset_root(dataset_version);
        let metadata = read_json(&dataset_root.join("metadata.json"))?;
        if get_i32(property(&metadata, "schema_version")?)? != 5
            || get_string(property(&metadata, "dataset_version")?)?.as_deref() != Some(dataset_version)
        {
            return Err(inconsistent("The artwork dataset metadata is incompatible."));
        }
        ensure_file(&dataset_root.join("labels.json"), "artwork labels")?;
        ensure_file(&dataset_root.join("report.json"), "artwork dataset report")?;
        Ok(())
    }

    fn read_known_sample(&self, dataset_version: &str) -> Result<KnownSample> {
        let export_root = self.paths.dataset_root(dataset_version);
        let metadata = read_json(&export_root.join("metadata.json"))?;
        let image_root_name = get_string(property(&metadata, "image_root")?)?.unwrap_or_default();
        let image_root = std::path::absolute(export_root.join(image_root_name))?;
        for line in read_text(&self.paths.manifest_path(dataset_version))?.lines() {
            let record: Value = serde_json::from_str(line)?;
            if get_string(property(&record, "role")?)?.as_deref() != Some("test")
                || get_string(property(&record, "view_profile")?)?.as_deref() != Some("mild")
            {
                continue;
            }
            let relative = get_string(property(&record, "image_path")?)?.unwrap_or_default();
            let image_path = std::path::absolute(image_root.join(relative.replace('/', "\\")))?;
            ensure_contained(&image_path, &self.paths.data_root)?;
            return Ok(KnownSample {
                image_path,
                oracle_id: get_string(property(&record, "oracle_id")?)?.unwrap_or_default(),
                card_name: get_string(property(&record, "card_name")?)?.unwrap_or_default(),
            });
        }
        Err(inconsistent("No deterministic artwork sample is available for recognition."))
    }

    fn write_negative_image(&self, model_version: &str) -> Result<PathBuf> {
        let output = self.paths.production_root.join(format!("{model_version}-deterministic-non-card.ppm"));
        const SIZE: i64 = 224;
        let mut bytes = format!("P6\n{SIZE} {SIZE}\n255\n").into_bytes();
        for y in 0..SIZE {
            for x in 0..SIZE {
                let block = ((x / 16) + (y / 16)) % 2;
                bytes.push(if block == 0 { 18 } else { 224 });
                bytes.push(((x * 17 + y * 31 + i64::from(Self::SEED)) & 255) as u8);
                bytes.push(if block == 0 { 210 } else { 28 });
            }
        }
        std::fs::write(&output, bytes)?;
        Ok(output)
    }

    fn write_report(&self, state: &ProductionState, completed: bool) -> Result<()> {
        let artifact_root = self.paths.artifact_root(&state.model_version);
        std::fs::create_dir_all(&artifact_root)?;
        let stages = STAGE_DEFINITIONS
            .iter()
            .map(|(id, _)| state.stages.get(*id).ok_or_else(|| key_not_found(id)))
            .collect::<Result<Vec<_>>>()?;
        let mut report = json!({
            "identity_report_schema_version": 2,
            "artifact_schema_version": 5,
            "dataset_version": state.dataset_version,
            "model_version": state.model_version,
            "public_identity": "oracle_id",
            "internal_identity": "artwork_id",
            "evidence_first": true,
            "clean_install_bootstrap": state.bootstrap_training_required,
            "retraining_performed": state.completed_epoch > 0,
            "selected_checkpoint_source": if state.completed_epoch > 0 {
                if state.bootstrap_training_required { "initial_artwork_v5" } else { "paired_view_v5" }
            } else {
                "existing_v3"
            },
            "seed": Self::SEED,
        });
        report["gpu_profile"] = json!({
            "device_index": state.gpu_index, "name": state.gpu_name, "vram_mib": state.vram_mib,
            "profile": state.gpu_profile, "effective_batch_size": state.batch_size,
        });
        report["configuration"] = json!({
            "max_epochs": Self::EPOCHS, "workers": Self::WORKERS, "embedding_dimension": Self::EMBEDDING_DIMENSION,
            "learning_rate": Self::LEARNING_RATE, "pretrained": true, "amp": true,
            "retrieval": "maximum artwork cosine collapsed to oracle_id",
        });
        report["strict_targets"] = json!({
            "raw_top1": 0.995, "raw_top5": 0.999, "accepted_precision": 0.999, "coverage": 0.95, "subgroup_top1": 0.99,
        });
        report["stages"] = serde_json::to_value(stages)?;
        report["completed_epoch"] = json!(state.completed_epoch);
        report["retrieval_evaluation"] = json!(state.retrieval);
        report["baseline_qualified"] = json!(state.qualified);
        report["camera_evaluated"] = json!(false);
        report["camera_qualified"] = Value::Null;
        report["expected_recognition"] =
            json!({ "oracle_id": state.expected_oracle_id, "card_name": state.expected_card_name });
        report["actual_recognition"] = json!(state.known_recognition);
        report["negative_diagnostic"] = json!(state.negative_diagnostic);
        report["started_utc"] = json!(state.started_utc);
        report["completed_utc"] = json!(if completed { state.completed_utc } else { None });
        report["logs"] = json!(log_file_names(&state.logs));
        atomic_write(&artifact_root.join("identity-report.json"), &serde_json::to_string_pretty(&report)?, true)
    }

    fn validate_completed_artifacts(&self, state: &ProductionState) -> Result<()> {
        if is_complete(state, "dataset") {
            self.validate_dataset(&state.dataset_version)?;
        }
        let artifact_root = self.paths.artifact_root(&state.model_version);
        if is_complete(state, "evidence_index") && !state.bootstrap_training_required {
            ensure_index(&artifact_root.join("index"))?;
            ensure_file(&artifact_root.join("embedding.pt"), "compact embedding checkpoint")?;
        }
        if is_complete(state, "evidence_evaluate") && !state.bootstrap_training_required {
            ensure_file(&artifact_root.join("retrieval-report.json"), "retrieval report")?;
        }
        if is_complete(state, "train") && state.completed_epoch > 0 {
            ensure_file(&artifact_root.join("best.pt"), "artwork checkpoint")?;
        }
        if is_complete(state, "final_index") {
            ensure_index(&artifact_root.join("index"))?;
            ensure_file(&artifact_root.join("artwork-thresholds.json"), "artwork thresholds")?;
        }
        if is_complete(state, "export") && !state.export_path.as_ref().is_some_and(|path| path.is_file()) {
            return Err(inconsistent("Recorded production result ZIP is missing."));
        }
        Ok(())
    }

    fn select_run_for_execution(&self) -> Result<ProductionState> {
        std::fs::create_dir_all(&self.paths.production_root)?;
        let active_version = self.read_active_model_version()?;
        if let Some(current) = self.load_state(&active_version)?
            && !current.completed
            && (is_complete(&current, "train") || !self.trained_with_other_recipe(&current.model_version)?)
            && self.files_intact(&current)?
        {
            return Ok(current);
        }
        self.create_fresh_run()
    }

    // A run whose recorded files are gone can't resume; a fresh run leaves it, and every other, as it is.
    fn files_intact(&self, state: &ProductionState) -> Result<bool> {
        match self.validate_completed_artifacts(state) {
            Ok(()) => Ok(true),
            Err(error) if error.is::<InvalidOperation>() => Ok(false),
            Err(error) => Err(error),
        }
    }

    // A run whose training stopped part-way with another recipe cannot resume it (train-artwork refuses to mix
    // recipes), so a fresh run starts. A run that finished training keeps its model and resumes the later stages.
    fn trained_with_other_recipe(&self, model_version: &str) -> Result<bool> {
        let configuration = self.paths.artifact_root(model_version).join("configuration.json");
        if !configuration.is_file() {
            return Ok(false);
        }
        let Ok(value) = serde_json::from_str::<Value>(&read_text(&configuration)?) else {
            // Cut off mid-write: its recipe is unknown, so it cannot be resumed safely.
            return Ok(true);
        };
        // Configurations from before recipes were recorded are legacy.
        let recipe = match try_property(&value, "augmentation")? {
            Some(recipe) => get_string(recipe)?,
            None => Some("legacy".into()),
        };
        Ok(recipe.as_deref() != Some(Self::AUGMENTATION_RECIPE))
    }

    fn create_fresh_run(&self) -> Result<ProductionState> {
        std::fs::create_dir_all(&self.paths.production_root)?;
        for attempt in 0..10 {
            let stamp = (Utc::now() + Duration::milliseconds(attempt)).format("%Y%m%dT%H%M%S%3fZ");
            let model_version = format!("artwork-run-{stamp}");
            if self.paths.artifact_root(&model_version).is_dir() || self.state_path(&model_version).is_file() {
                continue;
            }
            let state = ProductionState::new(&model_version, "paper-art-current");
            atomic_write(&self.active_model_path(), &format!("{model_version}\r\n"), true)?;
            self.save_state(&state)?;
            return Ok(state);
        }
        Err(invalid("Could not allocate a fresh artwork training run. Try again."))
    }

    fn read_active_model_version(&self) -> Result<String> {
        let path = self.active_model_path();
        if !path.is_file() {
            return Ok(Self::INITIAL_MODEL_VERSION.into());
        }
        let value = read_text(&path)?.trim().to_string();
        if !is_safe_version(&value) {
            return Err(inconsistent("The active artwork model pointer is invalid."));
        }
        Ok(value)
    }

    fn state_path(&self, model_version: &str) -> PathBuf {
        self.paths.production_root.join(format!("{model_version}-state.json"))
    }

    fn load_state(&self, model_version: &str) -> Result<Option<ProductionState>> {
        let path = self.state_path(model_version);
        if !path.is_file() {
            return Ok(None);
        }
        match serde_json::from_str::<Option<ProductionState>>(&read_text(&path)?) {
            Ok(Some(state)) => Ok(Some(state)),
            Ok(None) => Err(inconsistent("Production state is empty.")),
            Err(error) => Err(inconsistent(&format!("Production state is unreadable: {error}"))),
        }
    }

    fn save_state(&self, state: &ProductionState) -> Result<()> {
        atomic_write(&self.state_path(&state.model_version), &serde_json::to_string_pretty(state)?, true)
    }
}

fn validate_identity(state: &ProductionState, model_version: &str) -> Result<()> {
    if state.schema_version != STATE_SCHEMA_VERSION
        || state.dataset_version.trim().is_empty()
        || state.model_version != model_version
        || state.seed != IdentityProductionWorkflowService::SEED
    {
        return Err(inconsistent("Existing artwork production state belongs to a different workflow."));
    }
    Ok(())
}

fn ensure_index(index_root: &Path) -> Result<()> {
    ensure_file(&index_root.join("index.f32"), "prototype vectors")?;
    ensure_file(&index_root.join("index-metadata.json"), "prototype index metadata")?;
    ensure_file(&index_root.join("index-labels.json"), "prototype labels")
}

fn set_stage(state: &mut ProductionState, id: &str, status: ProductionStageStatus, detail: &str) -> Result<()> {
    let stage = state.stages.get_mut(id).ok_or_else(|| key_not_found(id))?;
    stage.status = status;
    stage.detail = detail.into();
    Ok(())
}

fn is_complete(state: &ProductionState, id: &str) -> bool {
    state
        .stages
        .get(id)
        .is_some_and(|stage| matches!(stage.status, ProductionStageStatus::Passed | ProductionStageStatus::Warning))
}

fn to_snapshot(state: &ProductionState) -> IdentityProductionSnapshot {
    let outcome = workflow_outcome(state.completed, state.qualified, state.stages.values().map(|stage| stage.status));
    let summary = match outcome {
        ProductionWorkflowOutcome::Passed => "✓ Strict artwork retrieval baseline passed",
        ProductionWorkflowOutcome::Warning => "Artifacts exported · strict retrieval quality still needs improvement",
        ProductionWorkflowOutcome::Failed => "Artwork workflow stopped · review the activity log",
        ProductionWorkflowOutcome::Running => "Artwork retrieval workflow in progress",
        ProductionWorkflowOutcome::Ready => "Ready to run or resume artwork retrieval qualification",
    };
    IdentityProductionSnapshot {
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
        selected_checkpoint: state.selected_checkpoint_path.as_deref().map(file_name),
        export_path: state.export_path.clone(),
    }
}

fn empty_snapshot(model_version: &str, summary: &str) -> IdentityProductionSnapshot {
    IdentityProductionSnapshot {
        outcome: ProductionWorkflowOutcome::Ready,
        summary: summary.into(),
        dataset_version: IdentityProductionWorkflowService::DATASET_VERSION.into(),
        model_version: model_version.into(),
        stages: pending_stages(STAGE_DEFINITIONS),
        gpu_name: None,
        gpu_profile: None,
        batch_size: None,
        completed_epoch: 0,
        selected_checkpoint: None,
        export_path: None,
    }
}

fn last_epoch(result: &PythonRunResult) -> Result<Option<i32>> {
    last_event(&result.events, "artwork_epoch_completed").map(|event| get_i32(property(event, "epoch")?)).transpose()
}

fn required_event(result: &PythonRunResult, event_name: &str) -> Result<Value> {
    last_event(&result.events, event_name)
        .cloned()
        .ok_or_else(|| invalid(format!("Python command did not emit required {event_name} event.")))
}

fn ensure_file(path: &Path, description: &str) -> Result<()> {
    if !path.is_file() {
        return Err(inconsistent(&format!("Recorded {description} is missing.")));
    }
    Ok(())
}

fn ensure_contained(target: &Path, allowed_root: &Path) -> Result<PathBuf> {
    let full_target = std::path::absolute(target)?.to_string_lossy().trim_end_matches('\\').to_string();
    let root = format!("{}\\", std::path::absolute(allowed_root)?.to_string_lossy().trim_end_matches('\\'));
    if !full_target.to_lowercase().starts_with(&root.to_lowercase()) {
        return Err(invalid(format!("Path is outside the allowed Deckino root: {full_target}")));
    }
    Ok(PathBuf::from(full_target))
}

fn inconsistent(detail: &str) -> anyhow::Error {
    invalid(format!(
        "{detail} Production state and artifacts disagree. Start a new model version or restore the missing artifact."
    ))
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case", default)]
struct PersistedProductionStage {
    id: String,
    name: String,
    status: ProductionStageStatus,
    detail: String,
}

/// The run's state file, snake_case on disk (the C# JsonNamingPolicy.SnakeCaseLower).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
struct ProductionState {
    schema_version: i32,
    dataset_version: String,
    model_version: String,
    seed: i32,
    started_utc: DateTime<Utc>,
    completed_utc: Option<DateTime<Utc>>,
    completed: bool,
    qualified: bool,
    known_recognition_passed: bool,
    bootstrap_training_required: bool,
    gpu_name: Option<String>,
    gpu_index: i32,
    // SnakeCaseLower splits VramMiB at each capital.
    #[serde(rename = "vram_mi_b")]
    vram_mib: i64,
    gpu_profile: Option<String>,
    batch_size: i32,
    completed_epoch: i32,
    selected_checkpoint_path: Option<PathBuf>,
    stages: BTreeMap<String, PersistedProductionStage>,
    logs: Vec<PathBuf>,
    retrieval: Option<Value>,
    expected_oracle_id: Option<String>,
    expected_card_name: Option<String>,
    known_recognition: Option<Value>,
    negative_diagnostic: Option<Value>,
    export_path: Option<PathBuf>,
}

impl Default for ProductionState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            dataset_version: IdentityProductionWorkflowService::DATASET_VERSION.into(),
            model_version: String::new(),
            seed: IdentityProductionWorkflowService::SEED,
            started_utc: Utc::now(),
            completed_utc: None,
            completed: false,
            qualified: false,
            known_recognition_passed: false,
            bootstrap_training_required: false,
            gpu_name: None,
            gpu_index: 0,
            vram_mib: 0,
            gpu_profile: None,
            batch_size: 0,
            completed_epoch: 0,
            selected_checkpoint_path: None,
            stages: BTreeMap::new(),
            logs: Vec::new(),
            retrieval: None,
            expected_oracle_id: None,
            expected_card_name: None,
            known_recognition: None,
            negative_diagnostic: None,
            export_path: None,
        }
    }
}

impl ProductionState {
    fn new(model_version: &str, dataset_version: &str) -> Self {
        Self {
            dataset_version: dataset_version.into(),
            model_version: model_version.into(),
            stages: STAGE_DEFINITIONS
                .iter()
                .map(|(id, name)| {
                    let stage = PersistedProductionStage {
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
}

struct KnownSample {
    image_path: PathBuf,
    oracle_id: String,
    card_name: String,
}

// ---- Shared by both production workflows ----

/// InvalidOperationException: the failures the workflows' `catch (InvalidOperationException)` handle (a missing
/// recorded artifact, an inconsistent state). Other failures (unreadable JSON, IO) pass through those catches.
#[derive(Debug)]
pub struct InvalidOperation(pub String);

impl std::fmt::Display for InvalidOperation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidOperation {}

pub(crate) fn invalid(message: impl Into<String>) -> anyhow::Error {
    InvalidOperation(message.into()).into()
}

pub(crate) struct StageCompletion {
    pub status: ProductionStageStatus,
    pub detail: String,
}

impl StageCompletion {
    pub fn passed(detail: impl Into<String>) -> Self {
        Self { status: ProductionStageStatus::Passed, detail: detail.into() }
    }
    pub fn warning(detail: impl Into<String>) -> Self {
        Self { status: ProductionStageStatus::Warning, detail: detail.into() }
    }
}

/// Pins a stage body's output type, so `?` inside the async block knows its error type.
pub(crate) fn stage<F: Future<Output = Result<StageCompletion>>>(future: F) -> F {
    future
}

pub(crate) fn workflow_outcome(
    completed: bool,
    qualified: bool,
    mut statuses: impl Iterator<Item = ProductionStageStatus> + Clone,
) -> ProductionWorkflowOutcome {
    if completed {
        if qualified { ProductionWorkflowOutcome::Passed } else { ProductionWorkflowOutcome::Warning }
    } else if statuses.clone().any(|status| status == ProductionStageStatus::Failed) {
        ProductionWorkflowOutcome::Failed
    } else if statuses.any(|status| status == ProductionStageStatus::Running) {
        ProductionWorkflowOutcome::Running
    } else {
        ProductionWorkflowOutcome::Ready
    }
}

pub(crate) fn stage_result(id: &str, name: &str, status: ProductionStageStatus, detail: &str) -> ProductionStageResult {
    ProductionStageResult { id: id.into(), name: name.into(), status, detail: detail.into() }
}

pub(crate) fn pending_stages(definitions: &[(&str, &str)]) -> Vec<ProductionStageResult> {
    definitions.iter().map(|(id, name)| stage_result(id, name, ProductionStageStatus::Pending, "Waiting.")).collect()
}

/// `python -m deckino_training <command>` in the training runtime.
pub(crate) async fn run_training_cli_raw(
    runner: &PythonProcessRunner,
    paths: &TrainingPaths,
    command: Vec<String>,
    log_name: &str,
    on_line: &OnLine,
    cancel: &CancellationToken,
) -> Result<PythonRunResult> {
    let mut arguments = vec!["-m".to_string(), "deckino_training".to_string()];
    arguments.extend(command);
    runner.run(&paths.virtual_environment_python(), &arguments, log_name, on_line, cancel, None).await
}

pub(crate) async fn run_training_cli(
    runner: &PythonProcessRunner,
    paths: &TrainingPaths,
    command: Vec<String>,
    log_name: &str,
    on_line: &OnLine,
    cancel: &CancellationToken,
) -> Result<PythonRunResult> {
    let result = run_training_cli_raw(runner, paths, command, log_name, on_line, cancel).await?;
    ensure_success(&result)?;
    Ok(result)
}

pub(crate) fn ensure_success(result: &PythonRunResult) -> Result<()> {
    if result.exit_code != 0 {
        return Err(invalid(format!(
            "Stage failed with exit code {}. See {}",
            result.exit_code,
            result.log_path.display()
        )));
    }
    Ok(())
}

pub(crate) fn is_out_of_memory(result: &PythonRunResult) -> bool {
    result.events.iter().any(|event| event.get("error_code").and_then(Value::as_str) == Some("cuda_out_of_memory"))
}

/// The last `{"event": name, …}` line.
pub(crate) fn last_event<'a>(events: &'a [Value], name: &str) -> Option<&'a Value> {
    events.iter().rev().find(|event| event.get("event").and_then(Value::as_str) == Some(name))
}

/// File.ReadAllText: drops a UTF-8 byte order mark.
pub(crate) fn read_text(path: &Path) -> Result<String> {
    let text = std::fs::read_to_string(path)?;
    Ok(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text,
    })
}

pub(crate) fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_str(&read_text(path)?)?)
}

/// Write beside, then move over: a reader never sees half a file. `bom`: C#'s Encoding.UTF8 writes one.
pub(crate) fn atomic_write(path: &Path, text: &str, bom: bool) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut temporary = OsString::from(path.as_os_str());
    temporary.push(".tmp");
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice(b"\xEF\xBB\xBF");
    }
    bytes.extend_from_slice(text.as_bytes());
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "Null",
        Value::Bool(_) => "Boolean",
        Value::Number(_) => "Number",
        Value::String(_) => "String",
        Value::Array(_) => "Array",
        Value::Object(_) => "Object",
    }
}

fn wrong_kind(expected: &str, value: &Value) -> anyhow::Error {
    invalid(format!(
        "The requested operation requires an element of type '{expected}', but the target element has type '{}'.",
        kind(value)
    ))
}

pub(crate) fn key_not_found(name: &str) -> anyhow::Error {
    anyhow!("The given key '{name}' was not present in the dictionary.")
}

/// JsonElement.TryGetProperty.
pub(crate) fn try_property<'a>(value: &'a Value, name: &str) -> Result<Option<&'a Value>> {
    match value {
        Value::Object(map) => Ok(map.get(name)),
        _ => Err(wrong_kind("Object", value)),
    }
}

/// JsonElement.GetProperty.
pub(crate) fn property<'a>(value: &'a Value, name: &str) -> Result<&'a Value> {
    try_property(value, name)?.ok_or_else(|| key_not_found(name))
}

pub(crate) fn get_bool(value: &Value) -> Result<bool> {
    value.as_bool().ok_or_else(|| wrong_kind("Boolean", value))
}

pub(crate) fn get_i32(value: &Value) -> Result<i32> {
    value.as_i64().and_then(|number| i32::try_from(number).ok()).ok_or_else(|| wrong_kind("Number", value))
}

/// JsonElement.GetString: null is None.
pub(crate) fn get_string(value: &Value) -> Result<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        _ => Err(wrong_kind("String", value)),
    }
}

/// A model version names a folder: letters, digits, '-' and '_' only.
pub(crate) fn is_safe_version(version: &str) -> bool {
    !version.trim().is_empty() && version.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn eq_ignore_case(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The reports list each log's file name once, sorted.
pub(crate) fn log_file_names(logs: &[PathBuf]) -> Vec<String> {
    let mut names: Vec<String> = logs.iter().map(|log| file_name(log)).collect();
    names.sort();
    names.dedup();
    names
}

/// One training CLI argument.
pub(crate) trait ToArg {
    fn to_arg(&self) -> String;
}

impl ToArg for str {
    fn to_arg(&self) -> String {
        self.to_string()
    }
}
impl ToArg for String {
    fn to_arg(&self) -> String {
        self.clone()
    }
}
impl ToArg for Path {
    fn to_arg(&self) -> String {
        self.to_string_lossy().into_owned()
    }
}
impl ToArg for PathBuf {
    fn to_arg(&self) -> String {
        self.to_string_lossy().into_owned()
    }
}
impl ToArg for i32 {
    fn to_arg(&self) -> String {
        self.to_string()
    }
}
impl<T: ToArg + ?Sized> ToArg for &T {
    fn to_arg(&self) -> String {
        (**self).to_arg()
    }
}

/// `cli!["build-index", "--manifest", manifest_path, "--batch-size", batch]`: strings, paths and numbers as arguments.
macro_rules! cli {
    ($($argument:expr),* $(,)?) => {
        vec![$($crate::identity_production_workflow::ToArg::to_arg(&$argument)),*]
    };
}
pub(crate) use cli;
