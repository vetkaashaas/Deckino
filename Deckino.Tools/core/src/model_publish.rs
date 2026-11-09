use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::credentials::DpapiSyncCredentialStore;
use crate::error::check;
use crate::object_store::RailwayS3ObjectStore;
use crate::paths::TrainingPaths;
use crate::python::PythonProcessRunner;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedModel {
    pub kind: String,
    pub model_version: String,
    pub schema: i32,
    pub bytes: i64,
}

/// What the app loads (src/scan/model-store.ts): the current-*.json pointer naming the model, the manifest field that is
/// the contract the app was built for, and the phone files.
fn kind_spec(kind: &str) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    match kind {
        "artwork" => Some((
            "current-artwork.json",
            "artwork_mobile_schema_version",
            &["recognizer.onnx", "app-labels.json", "mobile-manifest.json"],
        )),
        "extractor" => Some((
            "current-extraction.json",
            "mobile_export_schema_version",
            &["extractor.onnx", "refiner.onnx", "mobile-manifest.json", "thresholds.json"],
        )),
        _ => None,
    }
}

struct PhoneFile {
    name: String,
    path: PathBuf,
    bytes: i64,
    sha256: String,
    md5: String,
}

// Puts the current model (data/training/current-*.json) on the app's update channel. Its phone files are made first
// when they aren't yet: scripts/ensure-*-mobile.ps1 exports the model (CPU), has the app's own code reproduce its
// results, and puts it in Deckino.App as the model the next app build ships. A failure there stops the publish. The
// files then go to the dataset bucket under models/<kind>/<version>/, and models/<kind>/schema-<n>/latest.json names
// them. The pointer goes last, so an app never finds a version whose files are still uploading. The API
// (ModelEndpoints) hands the files out from there.
pub struct ModelPublishService {
    paths: TrainingPaths,
    credentials: Arc<DpapiSyncCredentialStore>,
    runner: Arc<PythonProcessRunner>,
    scripts_root: Option<PathBuf>,
}

impl ModelPublishService {
    pub fn new(
        paths: TrainingPaths,
        credentials: Arc<DpapiSyncCredentialStore>,
        runner: Arc<PythonProcessRunner>,
        scripts_root: Option<PathBuf>,
    ) -> Self {
        Self { paths, credentials, runner, scripts_root }
    }

    /// `progress`: what the phone files' script is doing, line by line. `report_uploaded`: 0–100 while the phone files
    /// upload, after the script.
    pub async fn publish(
        &self,
        kind: &str,
        progress: &(dyn Fn(&str) + Send + Sync),
        cancel: &CancellationToken,
        report_uploaded: Option<&(dyn Fn(i32) + Sync)>,
    ) -> Result<PublishedModel> {
        let (pointer, schema_field, file_names) =
            kind_spec(kind).ok_or_else(|| anyhow!("Unknown model kind '{kind}'. (Parameter 'kind')"))?;
        let version = read_string(&self.paths.training_root.join(pointer), "model_version")?
            .ok_or_else(|| anyhow!("No current {kind} model ({pointer}). Import one first."))?;
        let folder = self.paths.training_root.join("mobile").join(kind).join(&version);
        let script = if kind == "artwork" { "ensure-artwork-mobile.ps1" } else { "ensure-extraction-mobile.ps1" };

        let verification = folder.join("app-verification.json");
        let verified = || -> Result<bool> {
            Ok(read_string(&verification, "model_version")?.as_deref() == Some(version.as_str())
                && read_node(&verification)?.and_then(|node| node.get("passed").and_then(Value::as_bool)) == Some(true))
        };
        if !verified()? {
            self.make_phone_files(script, &version, false, progress, cancel).await?;
            // The script leaves alone a model the app already ships; one without a passed check is made again.
            if !verified()? {
                self.make_phone_files(script, &version, true, progress, cancel).await?;
            }
            if !verified()? {
                bail!("scripts/{script} finished, but {version} has no passed app check ({}).", verification.display());
            }
        }
        let manifest = read_node(&folder.join("mobile-manifest.json"))?;
        let schema = manifest
            .as_ref()
            .filter(|manifest| manifest.get("model_version").and_then(Value::as_str) == Some(version.as_str()))
            .and_then(|manifest| manifest.get(schema_field).and_then(Value::as_i64))
            .map(|schema| schema as i32)
            .ok_or_else(|| {
                anyhow!("The mobile export of {version} has no {schema_field}. Run scripts/{script} again.")
            })?;

        let mut files = Vec::new();
        for name in file_names {
            let path = folder.join(name);
            if !path.is_file() {
                bail!("{name} is missing from {}. Run scripts/{script} again.", folder.display());
            }
            // Off the async thread: the phone files run to tens of megabytes.
            let (hashed, token) = (path.clone(), cancel.clone());
            let (sha256, md5) = tokio::task::spawn_blocking(move || hash_file(&hashed, &token)).await??;
            files.push(PhoneFile {
                name: name.to_string(),
                bytes: std::fs::metadata(&path)?.len() as i64,
                path,
                sha256,
                md5,
            });
        }

        let store = RailwayS3ObjectStore::connect(&self.credentials)?;
        let total_bytes: i64 = files.iter().map(|file| file.bytes).sum();
        let total = total_bytes.max(1);
        let mut sent = 0i64;
        for file in &files {
            check(cancel)?;
            let base = sent;
            let report = |bytes: i64| {
                if let Some(report_uploaded) = report_uploaded {
                    report_uploaded(((base + bytes) * 100 / total) as i32);
                }
            };
            store
                .upload_with_progress(
                    &format!("models/{kind}/{version}/{}", file.name),
                    &file.path,
                    &file.sha256,
                    &report,
                    cancel,
                )
                .await?;
            sent += file.bytes;
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Pointer<'a> {
            model_version: &'a str,
            schema: i32,
            published_utc: DateTime<Utc>,
            files: Vec<PointerFile<'a>>,
        }
        #[derive(Serialize)]
        struct PointerFile<'a> {
            name: &'a str,
            bytes: i64,
            sha256: &'a str,
            md5: &'a str,
        }
        let pointer = serde_json::to_vec_pretty(&Pointer {
            model_version: &version,
            schema,
            published_utc: Utc::now(),
            files: files
                .iter()
                .map(|file| PointerFile { name: &file.name, bytes: file.bytes, sha256: &file.sha256, md5: &file.md5 })
                .collect(),
        })?;
        let pointer_sha = hex::encode(Sha256::digest(&pointer));
        store
            .upload_bytes(&format!("models/{kind}/schema-{schema}/latest.json"), pointer, &pointer_sha, cancel)
            .await?;
        Ok(PublishedModel { kind: kind.to_string(), model_version: version, schema, bytes: total_bytes })
    }

    async fn make_phone_files(
        &self,
        script: &str,
        version: &str,
        force: bool,
        progress: &(dyn Fn(&str) + Send + Sync),
        cancel: &CancellationToken,
    ) -> Result<()> {
        let Some(scripts_root) = &self.scripts_root else {
            bail!(
                "The phone files of {version} aren't made yet, and scripts/{script} that makes them lives in the repository: publish from the developer PC's Toolbox (started from Visual Studio)."
            );
        };
        let quoted = |value: &str| format!("'{}'", value.replace('\'', "''"));
        // The script's own error comes back as one FAILED line, not as PowerShell's error record.
        let command = format!(
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; try {{ & {} -ModelVersion {} -DataRoot {}{} }} catch {{ Write-Output \"FAILED: $($_.Exception.Message)\"; exit 1 }}",
            quoted(&scripts_root.join(script).to_string_lossy()),
            quoted(version),
            quoted(&self.paths.data_root.to_string_lossy()),
            if force { " -Force" } else { "" }
        );
        let failure: Mutex<Option<String>> = Mutex::new(None);
        let on_line = |line: &str, json: Option<&Value>| {
            let text = line.trim();
            if json.is_some() || text.is_empty() {
                return;
            }
            match text.strip_prefix("FAILED: ") {
                Some(message) => *failure.lock().unwrap() = Some(message.to_string()),
                None => progress(text),
            }
        };
        let script_name =
            Path::new(script).file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        let arguments: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
            .into_iter()
            .map(str::to_string)
            .chain([command])
            .collect();
        let result = self
            .runner
            .run(Path::new("powershell.exe"), &arguments, &format!("{version}-{script_name}"), &on_line, cancel, None)
            .await?;
        if result.exit_code != 0 {
            let failure = failure.lock().unwrap().take().unwrap_or_else(|| format!("exit code {}", result.exit_code));
            bail!("Making the phone files of {version} failed: {failure} (log: {})", result.log_path.display());
        }
        Ok(())
    }
}

/// The file's SHA-256 and MD5, lowercase hex, in one read.
fn hash_file(path: &Path, cancel: &CancellationToken) -> Result<(String, String)> {
    let mut file = std::fs::File::open(path)?;
    let (mut sha256, mut md5) = (Sha256::new(), md5::Md5::new());
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        check(cancel)?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        sha256.update(&buffer[..read]);
        md5.update(&buffer[..read]);
    }
    Ok((hex::encode(sha256.finalize()), hex::encode(md5.finalize())))
}

fn read_node(path: &Path) -> Result<Option<Value>> {
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    let bytes = crate::camera_annotation_store::strip_bom(&bytes);
    Ok(Some(serde_json::from_slice(bytes)?))
}

fn read_string(path: &Path, property: &str) -> Result<Option<String>> {
    Ok(read_node(path)?.and_then(|node| node.get(property).and_then(Value::as_str).map(str::to_string)))
}
