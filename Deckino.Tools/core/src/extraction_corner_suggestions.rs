//! ExtractionCornerSuggestionService.cs: keeps the extraction model loaded in a long-lived Python worker (CPU) so
//! the Corner Annotator can suggest and snap corners. One JSON line per request on stdin, JSON lines back on stdout,
//! matched by request_id; stderr goes to the application log.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio_util::sync::CancellationToken;

use crate::camera_annotation::NormalizedPoint;
use crate::camera_annotation_store::{file_name, full_path};
use crate::error::{Cancelled, check};
use crate::extraction_production_workflow::{ExtractionProductionWorkflowService, ExtractionSuggestionModel};
use crate::log::ApplicationLogService;
use crate::paths::TrainingPaths;
use crate::python::{PythonProcessRunner, kill_tree, next_line_lossy};
use crate::training_result_exporter::sha256_file;

#[derive(Clone, Debug)]
pub struct ExtractionCornerSuggestion {
    pub model_version: String,
    pub checkpoint_sha256: String,
    pub corners: Option<Vec<NormalizedPoint>>,
    pub geometry_valid: bool,
    pub would_be_accepted: bool,
    pub rejection_reason: Option<String>,
    pub presence_probability: f64,
    pub ambiguity_margin: f64,
    pub elapsed: Duration,
}

#[derive(Clone, Debug)]
pub struct ExtractionCornerRefinement {
    pub model_version: String,
    pub corners: Option<Vec<NormalizedPoint>>,
    pub refiner_available: bool,
    pub maximum_shift: f64,
    pub elapsed: Duration,
    pub refined: bool,
}

struct ExtractionWorker {
    process: PythonWorker,
    model_version: String,
}

pub struct ExtractionCornerSuggestionService {
    paths: TrainingPaths,
    runner: Arc<PythonProcessRunner>,
    workflow: Arc<ExtractionProductionWorkflowService>,
    application_log: Arc<ApplicationLogService>,
    // The gate: one request at a time. A request takes the worker out and puts it back only after a clean reply, so
    // a failed or abandoned request never leaves a worker with an unread reply behind.
    worker: tokio::sync::Mutex<Option<ExtractionWorker>>,
    active_request: std::sync::Mutex<Option<CancellationToken>>,
}

impl ExtractionCornerSuggestionService {
    pub fn new(
        paths: TrainingPaths,
        runner: Arc<PythonProcessRunner>,
        workflow: Arc<ExtractionProductionWorkflowService>,
        application_log: Arc<ApplicationLogService>,
    ) -> Self {
        Self {
            paths,
            runner,
            workflow,
            application_log,
            worker: tokio::sync::Mutex::new(None),
            active_request: std::sync::Mutex::new(None),
        }
    }

    pub async fn suggest(&self, image_path: &Path, cancel: &CancellationToken) -> Result<ExtractionCornerSuggestion> {
        let payload = json!({ "image_path": full_path(image_path).to_string_lossy() });
        let (root, elapsed) = self.request(Some(payload), "extraction_suggestion", cancel).await?;
        let result = ExtractionCornerSuggestion {
            model_version: string(&root, "model_version")?,
            checkpoint_sha256: string(&root, "checkpoint_sha256")?,
            corners: parse_corners(&root)?,
            geometry_valid: boolean(&root, "geometry_valid")?,
            would_be_accepted: boolean(&root, "would_be_accepted")?,
            rejection_reason: root.get("rejection_reason").and_then(Value::as_str).map(str::to_string),
            presence_probability: number(&root, "presence_probability")?,
            ambiguity_margin: number(&root, "ambiguity_margin")?,
            elapsed,
        };
        self.application_log.information(
            "corner-suggestion",
            &format!(
                "{} suggested {} corners for {} in {:.0} ms; presence={:.1}%; accepted={}; reason={}.",
                result.model_version,
                result.corners.as_ref().map_or(0, Vec::len),
                file_name(image_path),
                result.elapsed.as_secs_f64() * 1000.0,
                result.presence_probability * 100.0,
                cs_bool(result.would_be_accepted),
                result.rejection_reason.as_deref().unwrap_or("none")
            ),
        );
        Ok(result)
    }

    /// Moves annotator-placed corners onto the edge-intersection convention with the full-resolution refiner.
    pub async fn refine(
        &self,
        image_path: &Path,
        corners: &[NormalizedPoint],
        cancel: &CancellationToken,
    ) -> Result<ExtractionCornerRefinement> {
        if corners.len() != 4 {
            bail!("Snapping requires exactly four corners.");
        }
        let payload = json!({
            "mode": "refine",
            "image_path": full_path(image_path).to_string_lossy(),
            "corners": corners_payload(corners),
        });
        let (root, elapsed) = self.request(Some(payload), "extraction_refinement", cancel).await?;
        let available = boolean(&root, "refiner_available")?;
        let shift = root.get("maximum_shift").and_then(Value::as_f64).unwrap_or(0.0);
        let refined = available && root.get("refined") == Some(&Value::Bool(true));
        let result = ExtractionCornerRefinement {
            model_version: string(&root, "model_version")?,
            corners: if available { parse_corners(&root)? } else { None },
            refiner_available: available,
            maximum_shift: shift,
            elapsed,
            refined,
        };
        self.application_log.information(
            "corner-suggestion",
            &format!(
                "{} snapped corners for {} in {:.0} ms; refiner={}; refined={}; maximum shift={:.2}% of the card diagonal.",
                result.model_version,
                file_name(image_path),
                elapsed.as_secs_f64() * 1000.0,
                cs_bool(available),
                cs_bool(refined),
                shift * 100.0
            ),
        );
        Ok(result)
    }

    /// Starts the worker ahead of the first photo: Python and torch take seconds to load. A failure is left for that
    /// photo's request to report.
    pub async fn warm_up(&self) {
        let _ = self.request(None, "", &CancellationToken::new()).await;
    }

    /// `payload` None only makes sure the worker runs.
    async fn request(
        &self,
        payload: Option<Value>,
        expected_event: &str,
        cancel: &CancellationToken,
    ) -> Result<(Value, Duration)> {
        let mut slot = tokio::select! {
            slot = self.worker.lock() => slot,
            _ = cancel.cancelled() => return Err(Cancelled.into()),
        };
        let request_cancel = cancel.child_token();
        *self.active_request.lock().unwrap() = Some(request_cancel.clone());
        let mut worker = slot.take();
        let result = self.exchange(&mut worker, payload, expected_event, &request_cancel).await;
        *self.active_request.lock().unwrap() = None;
        match result {
            Ok(reply) => {
                *slot = worker;
                Ok(reply)
            }
            Err(error) => {
                // A timeout or cancelled caller may leave an unread response in stdout.
                // Restarting guarantees that the next request cannot consume a stale reply.
                if let Some(worker) = worker {
                    worker.process.stop().await;
                }
                Err(error)
            }
        }
    }

    async fn exchange(
        &self,
        worker: &mut Option<ExtractionWorker>,
        payload: Option<Value>,
        expected_event: &str,
        cancel: &CancellationToken,
    ) -> Result<(Value, Duration)> {
        let model = self.workflow.resolve_suggestion_model()?;
        let reusable = worker
            .as_mut()
            .is_some_and(|worker| !worker.process.has_exited() && worker.model_version == model.model_version);
        if !reusable {
            let (checkpoint, token) = (PathBuf::from(&model.checkpoint_path), cancel.clone());
            let checkpoint_hash = tokio::task::spawn_blocking(move || sha256_file(&checkpoint, &token)).await??;
            if let Some(previous) = worker.take() {
                previous.process.stop().await;
            }
            *worker = Some(self.start_worker(&model, &checkpoint_hash, cancel).await?);
        }
        let Some(mut payload) = payload else {
            return Ok((Value::Null, Duration::ZERO));
        };
        let process = &mut worker.as_mut().expect("worker started").process;

        let request_id = uuid::Uuid::new_v4().simple().to_string();
        payload["request_id"] = Value::String(request_id.clone());
        let started = Instant::now();
        process.write_line(&payload.to_string()).await?;

        loop {
            let Some(line) = process.read_line(Duration::from_secs(30), cancel).await? else {
                bail!("The extraction suggestion worker stopped unexpectedly.");
            };
            let root: Value = serde_json::from_str(&line)?;
            if root.get("request_id").and_then(Value::as_str) != Some(request_id.as_str()) {
                continue;
            }
            let event = string(&root, "event")?;
            if event == "extraction_suggestion_error" {
                bail!(
                    "{}",
                    root.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("The extraction model could not process the photo.")
                );
            }
            if event != expected_event {
                continue;
            }
            let elapsed = started.elapsed();
            check(cancel)?;
            return Ok((root, elapsed));
        }
    }

    pub async fn stop(&self) {
        if let Some(active) = self.active_request.lock().unwrap().as_ref() {
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

    async fn start_worker(
        &self,
        model: &ExtractionSuggestionModel,
        checkpoint_hash: &str,
        cancel: &CancellationToken,
    ) -> Result<ExtractionWorker> {
        let python = self.paths.virtual_environment_python();
        if !python.is_file() {
            bail!(
                "The Deckino training runtime is not installed. Prepare the extraction environment before enabling suggestions."
            );
        }
        let mut arguments: Vec<String> =
            ["-m", "deckino_training", "extraction-suggestion-worker", "--checkpoint"].map(String::from).to_vec();
        arguments.push(path_text(&model.checkpoint_path));
        arguments.push("--thresholds".into());
        arguments.push(path_text(&model.thresholds_path));
        arguments.extend(["--device".into(), "cpu".into()]);
        if let Some(refiner) = &model.refiner_path {
            arguments.push("--refiner".into());
            arguments.push(path_text(refiner));
        }
        let mut process = PythonWorker::start(
            &self.runner,
            &python,
            &arguments,
            self.application_log.clone(),
            "corner-suggestion-python",
            "Could not start the extraction suggestion worker.",
        )?;
        let ready = async {
            let Some(line) = process.read_line(Duration::from_secs(60), cancel).await? else {
                bail!("The extraction suggestion worker did not become ready.");
            };
            let root: Value = serde_json::from_str(&line)?;
            let text = |name: &str| root.get(name).and_then(Value::as_str).map(str::to_string);
            if text("event").as_deref() != Some("extraction_suggestion_ready")
                || text("model_version").as_deref() != Some(model.model_version.as_str())
                || text("checkpoint_sha256").as_deref() != Some(checkpoint_hash)
            {
                bail!("The extraction suggestion worker loaded an unexpected model.");
            }
            Ok(())
        }
        .await;
        if let Err(error) = ready {
            process.stop().await;
            return Err(error);
        }
        self.application_log.information(
            "corner-suggestion",
            &format!(
                "Loaded {} ({}) for persistent CPU suggestions.",
                model.model_version,
                &checkpoint_hash[..12.min(checkpoint_hash.len())]
            ),
        );
        Ok(ExtractionWorker { process, model_version: model.model_version.clone() })
    }
}

/// A long-lived Python helper speaking JSON lines: requests on stdin, replies on stdout, stderr to the log.
/// Dropping it kills the process (kill_on_drop); `stop` kills its whole tree.
pub(crate) struct PythonWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

impl PythonWorker {
    pub(crate) fn start(
        runner: &PythonProcessRunner,
        python: &Path,
        arguments: &[String],
        application_log: Arc<ApplicationLogService>,
        log_area: &'static str,
        start_failure: &'static str,
    ) -> Result<Self> {
        let mut command = runner.command(python, arguments);
        command.stdin(Stdio::piped());
        let mut child = command.spawn().context(start_failure)?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped")).lines();
        let stderr = child.stderr.take().expect("stderr is piped");
        tokio::spawn(async move {
            let mut stderr = BufReader::new(stderr);
            while let Some(line) = next_line_lossy(&mut stderr).await {
                application_log.information(log_area, &line);
            }
        });
        Ok(Self { child, stdin, stdout })
    }

    pub(crate) fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub(crate) async fn write_line(&mut self, line: &str) -> Result<()> {
        self.stdin.write_all(format!("{line}\n").as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// None when the worker closed its stdout.
    pub(crate) async fn read_line(&mut self, timeout: Duration, cancel: &CancellationToken) -> Result<Option<String>> {
        tokio::select! {
            _ = cancel.cancelled() => Err(Cancelled.into()),
            read = tokio::time::timeout(timeout, self.stdout.next_line()) => match read {
                Ok(line) => Ok(line?),
                Err(_) => bail!("The operation has timed out."),
            },
        }
    }

    pub(crate) async fn stop(mut self) {
        if let (Ok(None), Some(pid)) = (self.child.try_wait(), self.child.id()) {
            kill_tree(pid).await;
        }
        // kill_on_drop covers a taskkill that failed.
    }
}

/// A required property of a worker reply (JsonElement.GetProperty).
pub(crate) fn property<'a>(root: &'a Value, name: &str) -> Result<&'a Value> {
    root.get(name).with_context(|| format!("The worker reply has no '{name}'."))
}

pub(crate) fn string(root: &Value, name: &str) -> Result<String> {
    property(root, name)?
        .as_str()
        .map(str::to_string)
        .with_context(|| format!("The worker reply's '{name}' is not text."))
}

fn boolean(root: &Value, name: &str) -> Result<bool> {
    property(root, name)?.as_bool().with_context(|| format!("The worker reply's '{name}' is not true or false."))
}

fn number(root: &Value, name: &str) -> Result<f64> {
    property(root, name)?.as_f64().with_context(|| format!("The worker reply's '{name}' is not a number."))
}

pub(crate) fn corners_payload(corners: &[NormalizedPoint]) -> Value {
    corners.iter().map(|point| json!({ "x": point.x, "y": point.y })).collect()
}

fn parse_corners(result: &Value) -> Result<Option<Vec<NormalizedPoint>>> {
    let values = match result.get("corners") {
        None | Some(Value::Null) => return Ok(None),
        Some(values) => values,
    };
    let Some(values) = values.as_array().filter(|values| values.len() == 4) else {
        bail!("The extraction worker returned an invalid corner count.");
    };
    let points = values
        .iter()
        .map(|value| Ok(NormalizedPoint::new(number(value, "x")?, number(value, "y")?)))
        .collect::<Result<Vec<_>>>()?;
    if points.iter().any(|point| {
        !point.x.is_finite()
            || !point.y.is_finite()
            || !(0.0..=1.0).contains(&point.x)
            || !(0.0..=1.0).contains(&point.y)
    }) {
        bail!("The extraction worker returned non-finite or out-of-bounds corners.");
    }
    Ok(Some(points))
}

fn path_text(path: &(impl AsRef<OsStr> + ?Sized)) -> String {
    Path::new(path).to_string_lossy().into_owned()
}

/// How C# prints a bool, as the log has always read.
fn cs_bool(value: bool) -> &'static str {
    if value { "True" } else { "False" }
}
