//! CardIdentitySuggestionService.cs: keeps the current artwork model loaded in a Python worker while Identify Card is
//! open, so "Suggest cards" answers in about a second. A newly imported model is picked up on the next request.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, bail};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::camera_annotation::{IdentityCandidate, NormalizedPoint};
use crate::camera_annotation_store::full_path;
use crate::extraction_corner_suggestions::{PythonWorker, corners_payload, property, string};
use crate::log::ApplicationLogService;
use crate::paths::TrainingPaths;
use crate::python::PythonProcessRunner;
use crate::training_result_exporter::TrainingResultExporter;

#[derive(Clone, Debug)]
pub struct CardIdentitySuggestion {
    pub model_version: String,
    pub candidates: Vec<IdentityCandidate>,
}

struct IdentityWorker {
    process: PythonWorker,
    /// The artwork pointer's model version it loaded (None: the worker picked the model itself).
    pointer: Option<String>,
}

pub struct CardIdentitySuggestionService {
    paths: TrainingPaths,
    runner: Arc<PythonProcessRunner>,
    exporter: Arc<TrainingResultExporter>,
    application_log: Arc<ApplicationLogService>,
    // The gate: one request at a time. A request takes the worker out and puts it back only after a clean reply.
    worker: tokio::sync::Mutex<Option<IdentityWorker>>,
    // The token of whatever holds the gate, so `stop` can end a warm-up or request instead of waiting for it.
    active_request: Mutex<Option<CancellationToken>>,
}

impl CardIdentitySuggestionService {
    pub fn new(
        paths: TrainingPaths,
        runner: Arc<PythonProcessRunner>,
        exporter: Arc<TrainingResultExporter>,
        application_log: Arc<ApplicationLogService>,
    ) -> Self {
        Self {
            paths,
            runner,
            exporter,
            application_log,
            worker: tokio::sync::Mutex::new(None),
            active_request: Mutex::default(),
        }
    }

    /// Loads the model ahead of the first click; a failure here is reported again by that click.
    pub async fn warm_up(&self) {
        let mut slot = self.worker.lock().await;
        let cancel = self.begin_request();
        let warmed = self.ensure_worker(&mut slot, &cancel).await;
        self.end_request();
        if let Err(error) = warmed {
            self.application_log.information("card-suggestion", &format!("Warm-up skipped: {error}"));
        }
    }

    pub async fn suggest(&self, image_path: &Path, corners: &[NormalizedPoint]) -> Result<CardIdentitySuggestion> {
        let mut slot = self.worker.lock().await;
        let cancel = self.begin_request();
        let result = self.suggest_locked(&mut slot, image_path, corners, &cancel).await;
        self.end_request();
        result
    }

    async fn suggest_locked(
        &self,
        slot: &mut Option<IdentityWorker>,
        image_path: &Path,
        corners: &[NormalizedPoint],
        cancel: &CancellationToken,
    ) -> Result<CardIdentitySuggestion> {
        self.ensure_worker(slot, cancel).await?;
        let mut worker = slot.take().expect("worker started");
        match exchange(&mut worker.process, image_path, corners, cancel).await {
            Ok(suggestion) => {
                *slot = Some(worker);
                Ok(suggestion)
            }
            Err(error) => {
                // A timed-out reply could still arrive; a fresh worker cannot hand it to the next photo.
                worker.process.stop().await;
                Err(error)
            }
        }
    }

    pub async fn stop(&self) {
        if let Some(active) = self.active_request.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            active.cancel();
        }
        let mut slot = self.worker.lock().await;
        if let Some(worker) = slot.take() {
            worker.process.stop().await;
        }
    }

    /// DisposeAsync.
    pub async fn shutdown(&self) {
        self.stop().await;
    }

    fn begin_request(&self) -> CancellationToken {
        let cancel = CancellationToken::new();
        *self.active_request.lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());
        cancel
    }

    fn end_request(&self) {
        *self.active_request.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    async fn ensure_worker(&self, slot: &mut Option<IdentityWorker>, cancel: &CancellationToken) -> Result<()> {
        let pointer = self.exporter.read_current_artwork_pointer().map(|pointer| pointer.model_version);
        if let Some(worker) = slot.as_mut()
            && !worker.process.has_exited()
            && worker.pointer == pointer
        {
            return Ok(());
        }
        if let Some(previous) = slot.take() {
            previous.process.stop().await;
        }
        let python = self.paths.virtual_environment_python();
        if !python.is_file() {
            bail!("The Deckino training runtime is not installed; prepare it on the Runner page first.");
        }
        let mut arguments: Vec<String> = vec![
            "-m".into(),
            "deckino_training".into(),
            "card-identity-worker".into(),
            "--training-root".into(),
            self.paths.training_root.to_string_lossy().into_owned(),
        ];
        if let Some(pointer) = &pointer {
            arguments.extend(["--model-version".into(), pointer.clone()]);
        }
        let mut process = PythonWorker::start(
            &self.runner,
            &python,
            &arguments,
            self.application_log.clone(),
            "card-suggestion-python",
            "Could not start the card suggestion worker.",
        )?;
        let ready = async {
            let Some(line) = process.read_line(Duration::from_secs(120), cancel).await? else {
                bail!("The card suggestion worker did not start; see the application log.");
            };
            let root: Value = serde_json::from_str(&line)?;
            if root.get("event").and_then(Value::as_str) != Some("card_identity_worker_ready") {
                bail!(
                    "{}",
                    root.get("message").and_then(Value::as_str).unwrap_or("The card suggestion worker did not start.")
                );
            }
            string(&root, "model_version")
        }
        .await;
        match ready {
            Ok(model_version) => {
                self.application_log
                    .information("card-suggestion", &format!("Loaded {model_version} for card suggestions."));
                *slot = Some(IdentityWorker { process, pointer });
                Ok(())
            }
            Err(error) => {
                process.stop().await;
                Err(error)
            }
        }
    }
}

async fn exchange(
    process: &mut PythonWorker,
    image_path: &Path,
    corners: &[NormalizedPoint],
    cancel: &CancellationToken,
) -> Result<CardIdentitySuggestion> {
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let request = json!({
        "request_id": request_id,
        "image_path": full_path(image_path).to_string_lossy(),
        "corners": corners_payload(corners),
    });
    process.write_line(&request.to_string()).await?;
    loop {
        let Some(line) = process.read_line(Duration::from_secs(30), cancel).await? else {
            bail!("The card suggestion worker stopped unexpectedly.");
        };
        let root: Value = serde_json::from_str(&line)?;
        if root.get("request_id").and_then(Value::as_str) != Some(request_id.as_str()) {
            continue;
        }
        if root.get("event").and_then(Value::as_str) == Some("card_identity_suggestion_error") {
            bail!(
                "{}",
                root.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Operation is not valid due to the current state of the object.")
            );
        }
        return Ok(CardIdentitySuggestion {
            model_version: string(&root, "model_version")?,
            candidates: serde_json::from_value(property(&root, "candidates")?.clone())?,
        });
    }
}
