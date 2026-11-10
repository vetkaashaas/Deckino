//! The model benchmark: scores card extractor and artwork recognizer versions on the benchmark's photos
//! (camera/benchmark, which no trainer reads) with the training CLI's `score-benchmark`, which replays the phone's
//! pipeline. A pair's score is cached under the benchmark's current labels, so fixing a label or adding photos
//! scores every model again on the same answers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::camera_annotation_store::{has_image_extension, move_file};
use crate::camera_dataset_sync_service::is_dataset_file;
use crate::error::check;
use crate::paths::TrainingPaths;
use crate::python::PythonProcessRunner;
use crate::training_result_exporter::sha256_file;

#[derive(Clone, Debug, Deserialize)]
pub struct BenchmarkScore {
    pub extractor_version: String,
    pub artwork_version: String,
    pub counts: BenchmarkCounts,
    pub summary: BenchmarkSummary,
    pub rows: Vec<BenchmarkRow>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BenchmarkCounts {
    pub photos: usize,
    pub cards: usize,
    pub no_card: usize,
    /// Photos without drawn corners or a reviewed card yet: not scored.
    pub unlabelled: usize,
}

/// Fractions are of all scored photos (end to end) or of the card photos (the rest); None when there are none.
#[derive(Clone, Debug, Deserialize)]
pub struct BenchmarkSummary {
    pub end_to_end_right: Option<f64>,
    pub end_to_end_wrong: Option<f64>,
    pub end_to_end_none: Option<f64>,
    pub ocr_rescues: usize,
    pub extractor_found: Option<f64>,
    pub extractor_false_finds: usize,
    /// Mean corner distance over the card's diagonal.
    pub corner_error_median: Option<f64>,
    /// On the drawn corners: the recognizer alone, whatever the extractor did.
    pub artwork_top1: Option<f64>,
    pub artwork_top5: Option<f64>,
    pub artwork_accepted_right: Option<f64>,
    pub artwork_accepted_wrong: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BenchmarkRow {
    /// Below camera/benchmark, with "/" separators.
    pub photo: String,
    /// The photo's folder: a shooting session.
    pub session: String,
    pub card_present: bool,
    pub card_name: Option<String>,
    pub extractor: RowExtractor,
    pub artwork: Option<RowArtwork>,
    pub end_to_end: RowOutcome,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RowExtractor {
    pub found: bool,
    pub corner_error: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RowArtwork {
    pub name: Option<String>,
    pub correct: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RowOutcome {
    /// "right", "wrong" or "none".
    pub outcome: String,
    pub name: Option<String>,
    /// "embeddings", "ocr-top5" or "ocr-all".
    pub method: Option<String>,
}

impl BenchmarkRow {
    pub fn is_right(&self) -> bool {
        self.end_to_end.outcome == "right"
    }

    /// What the phone made of the photo, in a few words.
    pub fn answer(&self) -> String {
        match (self.end_to_end.outcome.as_str(), self.card_present, self.extractor.found) {
            ("right", false, _) => "found no card".into(),
            (_, true, false) => "found no card".into(),
            (_, _, true) if self.end_to_end.name.is_none() => "unsure".into(),
            _ => format!("said {}", self.end_to_end.name.as_deref().unwrap_or("?")),
        }
    }
}

/// The phone models on this PC (data/training/mobile/<kind>), oldest first. `kind`: "extractor" or "artwork".
pub fn model_versions(paths: &TrainingPaths, kind: &str) -> Vec<String> {
    // What score-benchmark reads: a folder holding only a run's ONNX files can't be scored.
    let needed: &[&str] = if kind == "artwork" {
        &["recognizer.onnx", "mobile-manifest.json", "app-labels.json", "labels.json"]
    } else {
        &["extractor.onnx", "mobile-manifest.json", "thresholds.json"]
    };
    let mut versions: Vec<String> = std::fs::read_dir(paths.training_root.join("mobile").join(kind))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| needed.iter().all(|file| entry.path().join(file).is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    // By the run's UTC time that ends each name, whatever comes before it.
    versions.sort_by(|a, b| a.rsplit('-').next().cmp(&b.rsplit('-').next()).then_with(|| a.cmp(b)));
    versions
}

/// The benchmark's photos and labels as they are now: every score is cached under it.
pub fn fingerprint(paths: &TrainingPaths, cancel: &CancellationToken) -> Result<String> {
    let root = &paths.camera_benchmark_root;
    let mut files: Vec<(String, PathBuf)> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        // The synced photos and sidecars, but not the import notes: they don't change any answer.
        .filter(|entry| {
            is_dataset_file(entry.path()) && !entry.file_name().eq_ignore_ascii_case(".deckino-import.json")
        })
        .map(|entry| {
            let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
            (relative.to_string_lossy().replace('\\', "/").to_lowercase(), entry.into_path())
        })
        .collect();
    files.sort();
    let mut hash = Sha256::new();
    for (relative, path) in files {
        check(cancel)?;
        // Labels by content; photos (megabytes each, never edited in place) by size and write time.
        let stamp = if has_image_extension(&path) {
            let metadata = std::fs::metadata(&path)?;
            let modified = metadata.modified()?.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
            format!("{}:{}", metadata.len(), modified.as_nanos())
        } else {
            sha256_file(&path, cancel)?
        };
        hash.update(format!("{relative}\t{stamp}\n"));
    }
    Ok(hex::encode(hash.finalize())[..16].to_string())
}

fn cache_path(paths: &TrainingPaths, fingerprint: &str, extractor: &str, artwork: &str) -> PathBuf {
    paths.training_root.join("benchmark-scores").join(fingerprint).join(format!("{extractor}__{artwork}.json"))
}

/// The scores already made under `fingerprint`, by (extractor, artwork). Unreadable ones are left to be made again.
// ponytail: scores under older fingerprints stay on disk; delete training/benchmark-scores if it ever grows large.
pub fn cached_scores(paths: &TrainingPaths, fingerprint: &str) -> HashMap<(String, String), BenchmarkScore> {
    std::fs::read_dir(paths.training_root.join("benchmark-scores").join(fingerprint))
        .into_iter()
        .flatten()
        .flatten()
        // .partial files are runs that never finished, or whose labels changed under them.
        .filter(|entry| !entry.file_name().to_string_lossy().contains(".partial"))
        .filter_map(|entry| serde_json::from_slice::<BenchmarkScore>(&std::fs::read(entry.path()).ok()?).ok())
        .map(|score| ((score.extractor_version.clone(), score.artwork_version.clone()), score))
        .collect()
}

/// Scores one pair on the phone's pipeline (10–20 s on the CPU); the page reads cached scores itself. `on_progress(done, total)`.
pub async fn score(
    runner: &PythonProcessRunner,
    paths: &TrainingPaths,
    database: &Path,
    fingerprint: &str,
    extractor: &str,
    artwork: &str,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<BenchmarkScore> {
    let output = cache_path(paths, fingerprint, extractor, artwork);
    let python = paths.virtual_environment_python();
    if !python.is_file() {
        bail!("The Deckino training runtime is not installed; prepare it on the Runner page first.");
    }
    std::fs::create_dir_all(output.parent().context("The score has no folder.")?)?;
    // A PC that hasn't synced a benchmark yet scores an empty one rather than failing.
    std::fs::create_dir_all(&paths.camera_benchmark_root)?;
    // Written beside, then moved into place: a cancelled run must not leave half a score in the cache.
    let partial = output.with_extension("partial.json");
    let arguments: Vec<String> = vec![
        "-m".into(),
        "deckino_training".into(),
        "score-benchmark".into(),
        "--training-root".into(),
        paths.training_root.to_string_lossy().into_owned(),
        "--database".into(),
        database.to_string_lossy().into_owned(),
        "--extractor".into(),
        extractor.into(),
        "--artwork".into(),
        artwork.into(),
        "--output".into(),
        partial.to_string_lossy().into_owned(),
        "--benchmark-root".into(),
        paths.camera_benchmark_root.to_string_lossy().into_owned(),
    ];
    let on_line = |_: &str, event: Option<&Value>| {
        if let Some(event) = event.filter(|event| event["event"] == "benchmark_progress") {
            let count = |key: &str| event[key].as_u64().unwrap_or(0) as usize;
            on_progress(count("done"), count("total"));
        }
    };
    let result = runner.run(&python, &arguments, "model-benchmark", &on_line, cancel, None).await?;
    if result.exit_code != 0 {
        let message = result
            .events
            .iter()
            .rev()
            .find_map(|event| (event["event"] == "error").then(|| event["message"].as_str()).flatten())
            .map_or_else(|| format!("see {}", result.log_path.display()), str::to_string);
        bail!("Scoring {extractor} with {artwork} failed: {message}");
    }
    // A label saved or a sync finished during the run: the score may mix old and new answers, so it isn't kept.
    let changed = match self::fingerprint(paths, cancel) {
        Ok(now) => now != fingerprint,
        // A photo deleted mid-walk fails the walk: that too is a change. Any other failure (a file locked for a
        // moment, a cancel) is only an error.
        Err(error)
            if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            true
        }
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
    };
    if changed {
        let _ = std::fs::remove_file(&partial);
        return Err(LabelsChanged.into());
    }
    let score = serde_json::from_slice(&std::fs::read(&partial)?)
        .with_context(|| format!("The score could not be read; see {}.", result.log_path.display()))?;
    move_file(&partial, &output, true)?;
    Ok(score)
}

/// The benchmark's photos or labels changed while scoring: every pair still to score would be thrown away too.
#[derive(Debug)]
pub struct LabelsChanged;

impl std::fmt::Display for LabelsChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The benchmark's photos or labels changed while scoring; score again.")
    }
}

impl std::error::Error for LabelsChanged {}

/// Photo by photo, end to end: what B got right that A didn't, and the reverse.
pub struct Comparison<'a> {
    /// (B's row, A's row).
    pub fixed: Vec<(&'a BenchmarkRow, &'a BenchmarkRow)>,
    pub broken: Vec<(&'a BenchmarkRow, &'a BenchmarkRow)>,
    /// McNemar's exact test on the photos that changed: the chance of a split this lopsided if A and B were equally
    /// good. Below 0.05 the difference is real; above it, it could be luck.
    pub p_value: f64,
}

pub fn compare<'a>(a: &'a BenchmarkScore, b: &'a BenchmarkScore) -> Comparison<'a> {
    let by_photo: HashMap<&str, &BenchmarkRow> = a.rows.iter().map(|row| (row.photo.as_str(), row)).collect();
    let (mut fixed, mut broken) = (Vec::new(), Vec::new());
    for row in &b.rows {
        if let Some(&before) = by_photo.get(row.photo.as_str()) {
            match (before.is_right(), row.is_right()) {
                (false, true) => fixed.push((row, before)),
                (true, false) => broken.push((row, before)),
                _ => {}
            }
        }
    }
    let p_value = mcnemar(fixed.len(), broken.len());
    Comparison { fixed, broken, p_value }
}

/// Two-sided exact binomial test of `fixed` against `broken` at one half each.
fn mcnemar(fixed: usize, broken: usize) -> f64 {
    let n = fixed + broken;
    let k = fixed.min(broken);
    // C(n, i) / 2^n, summed for i in 0..=k, each term in logs: 0.5^n alone underflows past n = 1074.
    let (mut log_term, mut tail) = (n as f64 * 0.5f64.ln(), 0.);
    for i in 0..=k {
        tail += log_term.exp();
        log_term += ((n - i) as f64 / (i + 1) as f64).ln();
    }
    (2. * tail).min(1.)
}
