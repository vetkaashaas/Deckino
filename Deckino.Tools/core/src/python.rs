use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::check;
use crate::paths::TrainingPaths;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct PythonRunResult {
    pub exit_code: i32,
    /// Every stdout/stderr line that parsed as JSON, in order.
    pub events: Vec<Value>,
    pub log_path: PathBuf,
}

static LOG_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Runs the training CLI (or any helper) with the Toolbox's environment, logging every line to its own file.
pub struct PythonProcessRunner {
    paths: TrainingPaths,
}

impl PythonProcessRunner {
    pub fn new(paths: TrainingPaths) -> Self {
        Self { paths }
    }

    /// A command with no window, UTF-8 Python, the torch cache in the runtime folder, and the training package from
    /// this app's own copy (the Python runtime outlives app updates; the CLI must not).
    pub fn command(&self, executable: &Path, arguments: &[String]) -> Command {
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .current_dir(&self.paths.data_root)
            .env("PYTHONUTF8", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("TORCH_HOME", &self.paths.torch_cache_root)
            .env("PYTHONPATH", self.paths.bundled_source_root())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true);
        command
    }

    /// Runs to the end. `on_line(line, parsed)` sees every line as it arrives; a cancel kills the whole process tree
    /// and returns `Cancelled`. `environment`: extra variables, None removes one.
    pub async fn run(
        &self,
        executable: &Path,
        arguments: &[String],
        log_name: &str,
        on_line: &(dyn Fn(&str, Option<&Value>) + Send + Sync),
        cancel: &CancellationToken,
        environment: Option<&HashMap<String, Option<String>>>,
    ) -> Result<PythonRunResult> {
        std::fs::create_dir_all(&self.paths.logs_root)?;
        let safe_name: String =
            log_name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
        let log_path = self.paths.logs_root.join(format!(
            "{}-{:04}-{safe_name}.log",
            Utc::now().format("%Y%m%d-%H%M%S%3f"),
            LOG_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1
        ));
        let mut command = self.command(executable, arguments);
        if let Some(environment) = environment {
            for (key, value) in environment {
                match value {
                    Some(value) => command.env(key, value),
                    None => command.env_remove(key),
                };
            }
        }
        let mut child = command.spawn().with_context(|| format!("Failed to start {}.", executable.display()))?;
        let pid = child.id();
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");
        let log = Arc::new(tokio::sync::Mutex::new(tokio::fs::File::create(&log_path).await?));
        let events = Arc::new(Mutex::new(Vec::new()));

        let drain = |reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>, stream: &'static str| {
            let (log, events) = (log.clone(), events.clone());
            async move {
                let mut reader = BufReader::new(reader);
                while let Some(line) = next_line_lossy(&mut reader).await {
                    let parsed = serde_json::from_str::<Value>(&line).ok();
                    if let Some(value) = &parsed {
                        events.lock().unwrap().push(value.clone());
                    }
                    {
                        let mut log = log.lock().await;
                        let entry = format!("[{}] [{stream}] {line}\r\n", Utc::now().to_rfc3339());
                        let _ = log.write_all(entry.as_bytes()).await;
                        let _ = log.flush().await;
                    }
                    on_line(&line, parsed.as_ref());
                }
            }
        };

        let run = async {
            tokio::join!(drain(Box::new(stdout), "stdout"), drain(Box::new(stderr), "stderr"));
            child.wait().await
        };
        let status = tokio::select! {
            status = run => status?,
            _ = cancel.cancelled() => {
                if let Some(pid) = pid {
                    kill_tree(pid).await;
                }
                check(cancel)?;
                unreachable!()
            }
        };
        let events = std::mem::take(&mut *events.lock().unwrap());
        Ok(PythonRunResult { exit_code: status.code().unwrap_or(-1), events, log_path })
    }
}

/// StreamReader.ReadLineAsync with UTF-8: a line ends at "\n", "\r\n" or a lone "\r" (a progress bar redrawing
/// itself), invalid bytes replaced, None at the end. A child's output that isn't UTF-8 (a localized tool's error) must
/// not stop the draining: a pipe no one reads fills up and blocks the child forever.
pub(crate) async fn next_line_lossy(reader: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> Option<String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await.ok()?;
        if available.is_empty() {
            return (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned());
        }
        let Some(end) = available.iter().position(|&byte| byte == b'\n' || byte == b'\r') else {
            let length = available.len();
            bytes.extend_from_slice(available);
            reader.consume(length);
            continue;
        };
        let carriage_return = available[end] == b'\r';
        bytes.extend_from_slice(&available[..end]);
        reader.consume(end + 1);
        if carriage_return && reader.fill_buf().await.ok().is_some_and(|next| next.first() == Some(&b'\n')) {
            reader.consume(1);
        }
        return Some(String::from_utf8_lossy(&bytes).into_owned());
    }
}

/// Process.Kill(entireProcessTree: true).
pub async fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .await;
}
