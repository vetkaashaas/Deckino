//! Checks card identity labels against the card's printed name (the training CLI's `verify-identity-labels`, a
//! title-strip text reader). The report lists the labelled photos whose title clearly names another card; Identify
//! Card shows them again until each is saved. It never edits a label itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::camera_annotation::{CardIdentity, CardIdentityStatus};
use crate::camera_annotation_store::full_path;
use crate::paths::TrainingPaths;
use crate::python::PythonProcessRunner;

#[derive(Clone, Debug, Deserialize)]
pub struct LabelFlag {
    /// Below the camera imports root, with "/" separators.
    pub image: String,
    pub label_oracle_id: String,
    pub label_name: String,
    /// When the label the check read was saved: the flag stays open while the label is still that one.
    #[serde(default)]
    pub label_reviewed_utc: Option<DateTime<Utc>>,
    pub read_text: String,
    pub read_oracle_id: String,
    pub read_name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct LabelCheckCounts {
    pub labelled: usize,
    pub agrees: usize,
    pub flagged: usize,
    pub unclear: usize,
    /// Labelled photos with no corners or no image, so not read.
    #[serde(default)]
    pub no_corners: usize,
}

#[derive(Clone, Debug, Deserialize)]
pub struct LabelCheckReport {
    pub checked_utc: DateTime<Utc>,
    pub counts: LabelCheckCounts,
    pub flagged: Vec<LabelFlag>,
}

impl LabelCheckReport {
    /// The flags still open, by full image path in upper case: a photo saved again since the check (or relabelled
    /// elsewhere) is settled.
    pub fn open_flags(
        &self,
        imports_root: &Path,
        identity_of: impl Fn(&Path) -> Option<CardIdentity>,
    ) -> HashMap<String, LabelFlag> {
        self.flagged
            .iter()
            .filter_map(|flag| {
                let path = full_path(&imports_root.join(&flag.image));
                let identity = identity_of(&path)?;
                let open =
                    matches!(identity.status.as_str(), CardIdentityStatus::CONFIRMED | CardIdentityStatus::CORRECTED)
                        && identity
                            .oracle_id
                            .as_deref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(&flag.label_oracle_id))
                        && match flag.label_reviewed_utc {
                            Some(read) => identity.reviewed_utc == Some(read),
                            None => identity.reviewed_utc.is_none_or(|reviewed| reviewed <= self.checked_utc),
                        };
                open.then(|| (path.to_string_lossy().to_uppercase(), flag.clone()))
            })
            .collect()
    }
}

pub fn report_path(paths: &TrainingPaths) -> PathBuf {
    paths.camera_root.join("identity-label-check.json")
}

/// The last check's report; None before the first one (or when it can't be read).
pub fn load_report(paths: &TrainingPaths) -> Option<LabelCheckReport> {
    read_report(paths).ok()
}

fn read_report(paths: &TrainingPaths) -> Result<LabelCheckReport> {
    Ok(serde_json::from_str(&std::fs::read_to_string(report_path(paths))?)?)
}

/// Reads every labelled photo's title (about a minute per thousand photos; the first run downloads the 8 MB reader).
/// `on_progress(done, total)`.
pub async fn run(
    runner: &PythonProcessRunner,
    paths: &TrainingPaths,
    database: &Path,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<LabelCheckReport> {
    let python = paths.virtual_environment_python();
    if !python.is_file() {
        bail!("The Deckino training runtime is not installed; prepare it on the Runner page first.");
    }
    let output = report_path(paths);
    let arguments: Vec<String> = vec![
        "-m".into(),
        "deckino_training".into(),
        "verify-identity-labels".into(),
        "--training-root".into(),
        paths.training_root.to_string_lossy().into_owned(),
        "--database".into(),
        database.to_string_lossy().into_owned(),
        "--output".into(),
        output.to_string_lossy().into_owned(),
    ];
    let on_line = |_: &str, event: Option<&Value>| {
        if let Some(event) = event.filter(|event| event["event"] == "identity_ocr_progress") {
            let count = |key: &str| event[key].as_u64().unwrap_or(0) as usize;
            on_progress(count("done"), count("total"));
        }
    };
    let result = runner.run(&python, &arguments, "identity-label-check", &on_line, cancel, None).await?;
    if result.exit_code != 0 {
        let message = result
            .events
            .iter()
            .rev()
            // Only the CLI's "error" event: skipped photos carry a message too.
            .find_map(|event| (event["event"] == "error").then(|| event["message"].as_str()).flatten())
            .map_or_else(|| format!("see {}", result.log_path.display()), str::to_string);
        bail!("The label check failed: {message}");
    }
    read_report(paths)
        .with_context(|| format!("The label check's report could not be read; see {}.", result.log_path.display()))
}
