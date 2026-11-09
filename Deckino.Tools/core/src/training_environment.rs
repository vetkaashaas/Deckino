use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use chrono::Utc;
use futures::StreamExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{Cancelled, check};
use crate::paths::TrainingPaths;
use crate::python::{CREATE_NO_WINDOW, PythonProcessRunner, PythonRunResult};

/// A training-runtime line callback: the raw line and, when it parsed, its JSON.
pub type OnLine<'a> = &'a (dyn Fn(&str, Option<&Value>) + Send + Sync);

#[derive(Clone, Debug, PartialEq)]
pub struct TrainingReadiness {
    pub has_minimum_disk_space: bool,
    pub free_disk_gib: f64,
    pub python_path: Option<String>,
    pub python_version: Option<String>,
    pub virtual_environment_ready: bool,
    pub packages_ready: bool,
    pub cuda_ready: bool,
    pub gpu_name: Option<String>,
    pub driver_version: Option<String>,
    pub vram_mib: Option<i64>,
    pub torch_version: Option<String>,
    pub cuda_runtime: Option<String>,
    pub pretrained_weights_cached: bool,
    pub gpu_index: Option<i32>,
    pub gpu_profile: Option<String>,
    pub recommended_batch_size: Option<i32>,
    pub validated_gpu: bool,
}

impl TrainingReadiness {
    pub fn ready(&self) -> bool {
        self.has_minimum_disk_space
            && self.virtual_environment_ready
            && self.packages_ready
            && self.cuda_ready
            && self.pretrained_weights_cached
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NvidiaGpuInfo {
    pub index: i32,
    pub name: String,
    pub driver_version: String,
    pub vram_mib: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CudaTrainingProfile {
    pub device_index: i32,
    pub gpu_name: String,
    pub vram_mib: i64,
    pub batch_size: i32,
    pub validated: bool,
    pub label: String,
}

const PYTHON_INSTALLER_URI: &str = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe";
const PYTHON_PROBE: &str =
    "import platform,sys;print(sys.executable);print(platform.architecture()[0]);print(sys.version_info[:2])";

pub struct TrainingEnvironmentService {
    paths: TrainingPaths,
    process_runner: Arc<PythonProcessRunner>,
    http_client: reqwest::Client,
}

impl TrainingEnvironmentService {
    pub const REQUIRED_CLI_VERSION: &str = "0.19.4";
    pub const MINIMUM_VRAM_MIB: i64 = 6000;
    pub const PYTHON_VERSION: &str = "3.12.10";

    pub fn new(paths: TrainingPaths, process_runner: Arc<PythonProcessRunner>, http_client: reqwest::Client) -> Self {
        Self { paths, process_runner, http_client }
    }

    fn runtime_marker_path(&self) -> PathBuf {
        self.paths.runtime_root.join("cuda-runtime-v3.marker")
    }

    pub fn build_private_python_installer_arguments(target_directory: &Path) -> Vec<String> {
        vec![
            "/quiet".into(),
            "InstallAllUsers=0".into(),
            format!("TargetDir={}", target_directory.display()),
            "PrependPath=0".into(),
            "Include_launcher=0".into(),
            "Include_test=0".into(),
            "Include_doc=0".into(),
            "Include_pip=1".into(),
            "Shortcuts=0".into(),
            "AssociateFiles=0".into(),
        ]
    }

    pub async fn check(&self, on_line: OnLine<'_>, cancel: &CancellationToken) -> Result<TrainingReadiness> {
        let free_gib = self.minimum_available_free_gib()?;
        let python = self.find_python_312(cancel).await?;
        let venv_ready = self.paths.virtual_environment_python().is_file();
        let mut packages_ready = false;
        let mut cuda_ready = false;
        let detected_gpus = detect_nvidia_gpus(cancel).await?;
        let mut selected_profile = Self::select_training_profile(&detected_gpus);
        let selected_gpu = selected_profile
            .as_ref()
            .and_then(|profile| detected_gpus.iter().find(|gpu| gpu.index == profile.device_index));
        let mut gpu_name = selected_gpu.map(|gpu| gpu.name.clone());
        let mut driver = selected_gpu.map(|gpu| gpu.driver_version.clone());
        let mut vram = selected_gpu.map(|gpu| gpu.vram_mib);
        let mut torch: Option<String> = None;
        let mut runtime: Option<String> = None;

        if venv_ready {
            let result = self
                .process_runner
                .run(
                    &self.paths.virtual_environment_python(),
                    &strings(&[
                        "-m",
                        "deckino_training",
                        "doctor",
                        "--require-cuda",
                        "--minimum-vram-mb",
                        &TrainingEnvironmentService::MINIMUM_VRAM_MIB.to_string(),
                    ]),
                    "requirements-check",
                    on_line,
                    cancel,
                    None,
                )
                .await?;
            let doctor = result
                .events
                .iter()
                .rev()
                .find(|item| item.get("event").and_then(Value::as_str) == Some("doctor"))
                .filter(|item| item.is_object());
            if let Some(doctor) = doctor {
                let text = |name: &str| doctor.get(name).and_then(Value::as_str).map(str::to_string);
                cuda_ready = text("status").as_deref() == Some("ok");
                torch = text("torch");
                runtime = text("cuda_runtime");
                packages_ready = text("cli_version").as_deref()
                    == Some(TrainingEnvironmentService::REQUIRED_CLI_VERSION)
                    && torch.as_deref().is_some_and(|torch| torch.starts_with("2.4.1+cu118"))
                    && runtime.as_deref() == Some("11.8");
                if driver.is_none() {
                    driver = text("driver_version");
                }
                if let Some(device) = doctor.get("selected_device").filter(|device| device.is_object()) {
                    let name = device.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                    let memory = device.get("vram_mb").and_then(Value::as_i64).unwrap_or_default();
                    let index = device.get("index").and_then(Value::as_i64).unwrap_or_default() as i32;
                    selected_profile = Some(Self::create_training_profile(index, &name, memory));
                    gpu_name = Some(name);
                    vram = Some(memory);
                }
            }
        }

        let pretrained_weights_cached = self.paths.torch_cache_root.is_dir()
            && walkdir::WalkDir::new(&self.paths.torch_cache_root).into_iter().filter_map(|entry| entry.ok()).any(
                |entry| {
                    entry.file_type().is_file()
                        && entry.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("pth"))
                },
            );
        Ok(TrainingReadiness {
            has_minimum_disk_space: free_gib >= 15.0,
            free_disk_gib: free_gib,
            python_version: python.as_ref().map(|_| "3.12 x64".to_string()),
            python_path: python,
            virtual_environment_ready: venv_ready,
            packages_ready,
            cuda_ready,
            gpu_name,
            driver_version: driver,
            vram_mib: vram,
            torch_version: torch,
            cuda_runtime: runtime,
            pretrained_weights_cached,
            gpu_index: selected_profile.as_ref().map(|profile| profile.device_index),
            gpu_profile: selected_profile.as_ref().map(|profile| profile.label.clone()),
            recommended_batch_size: selected_profile.as_ref().map(|profile| profile.batch_size),
            validated_gpu: selected_profile.as_ref().is_some_and(|profile| profile.validated),
        })
    }

    pub fn parse_nvidia_smi_output(output: &str) -> Vec<NvidiaGpuInfo> {
        output
            .split(['\r', '\n'])
            .filter(|line| !line.is_empty())
            .filter_map(|line| {
                let fields: Vec<&str> = line.split(',').map(str::trim).collect();
                if fields.len() != 4 {
                    return None;
                }
                Some(NvidiaGpuInfo {
                    index: fields[0].parse().ok()?,
                    name: fields[1].to_string(),
                    driver_version: fields[2].to_string(),
                    vram_mib: fields[3].parse().ok()?,
                })
            })
            .collect()
    }

    pub fn select_training_profile(adapters: &[NvidiaGpuInfo]) -> Option<CudaTrainingProfile> {
        adapters
            .iter()
            .filter(|adapter| adapter.vram_mib >= TrainingEnvironmentService::MINIMUM_VRAM_MIB)
            .min_by(|a, b| b.vram_mib.cmp(&a.vram_mib).then(a.index.cmp(&b.index)))
            .map(|selected| Self::create_training_profile(selected.index, &selected.name, selected.vram_mib))
    }

    pub fn create_training_profile(index: i32, name: &str, vram_mib: i64) -> CudaTrainingProfile {
        let lower = name.to_lowercase();
        let validated = lower.contains("rtx 3060 laptop") || lower.contains("rtx 4070 laptop");
        let batch_size = if vram_mib >= 7680 { 64 } else { 32 };
        let label = if validated {
            format!("Validated {batch_size}-batch profile")
        } else {
            format!("Compatible unvalidated {batch_size}-batch profile")
        };
        CudaTrainingProfile { device_index: index, gpu_name: name.to_string(), vram_mib, batch_size, validated, label }
    }

    pub async fn install(
        &self,
        allow_private_python_install: bool,
        on_line: OnLine<'_>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        std::fs::create_dir_all(&self.paths.runtime_root)?;
        if self.minimum_available_free_gib()? < 15.0 {
            bail!("At least 15 GiB of free disk space is required; 20 GiB is recommended.");
        }
        let python = match self.find_python_312(cancel).await? {
            Some(python) => PathBuf::from(python),
            None => {
                if !allow_private_python_install {
                    bail!("Python 3.12 x64 is not installed and private installation was not approved.");
                }
                self.install_private_python(on_line, cancel).await?
            }
        };
        if self.paths.virtual_environment_root.is_dir() && !self.runtime_marker_path().is_file() {
            std::fs::remove_dir_all(&self.paths.virtual_environment_root)?;
        }
        let venv_python = self.paths.virtual_environment_python();
        if !venv_python.is_file() {
            let arguments = vec!["-m".into(), "venv".into(), path_text(&self.paths.virtual_environment_root)];
            ensure_success(
                self.process_runner.run(&python, &arguments, "runtime-create", on_line, cancel, None).await?,
                "Creating the virtual environment",
            )?;
        }
        let arguments = vec![
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--no-cache-dir".into(),
            "-r".into(),
            path_text(&self.paths.requirements_path()),
        ];
        ensure_success(
            self.process_runner.run(&venv_python, &arguments, "packages-install", on_line, cancel, None).await?,
            "Installing CUDA packages",
        )?;
        let arguments = vec![
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--no-cache-dir".into(),
            "--no-deps".into(),
            "--force-reinstall".into(),
            path_text(&self.paths.bundled_project_root),
        ];
        ensure_success(
            self.process_runner
                .run(&venv_python, &arguments, "deckino-training-install", on_line, cancel, None)
                .await?,
            "Installing Deckino training CLI",
        )?;
        ensure_success(
            self.process_runner
                .run(
                    &venv_python,
                    &strings(&["-m", "deckino_training", "cache-backbone"]),
                    "backbone-cache",
                    on_line,
                    cancel,
                    None,
                )
                .await?,
            "Caching pretrained weights",
        )?;
        std::fs::write(self.runtime_marker_path(), "schema=3\nbackend=cuda\n")?;
        Ok(())
    }

    async fn find_python_312(&self, cancel: &CancellationToken) -> Result<Option<String>> {
        let mut candidates = vec![path_text(&self.paths.private_python())];
        candidates.extend(registered_python_executables().into_iter().filter(|path| Path::new(path).is_file()));
        candidates.extend(["py.exe".to_string(), "python.exe".to_string()]);
        let mut seen: Vec<String> = Vec::new();
        for candidate in candidates {
            if seen.iter().any(|known| known.eq_ignore_ascii_case(&candidate)) {
                continue;
            }
            seen.push(candidate.clone());
            let arguments: Vec<&str> = if candidate.to_lowercase().ends_with("py.exe") {
                vec!["-3.12", "-c", PYTHON_PROBE]
            } else {
                vec!["-c", PYTHON_PROBE]
            };
            let Some((exit_code, output)) = capture(Path::new(&candidate), &arguments, cancel).await? else {
                continue;
            };
            let lines: Vec<&str> = output.split(['\r', '\n']).filter(|line| !line.is_empty()).collect();
            if exit_code == 0 && lines.len() >= 3 && lines[1] == "64bit" && lines[2].contains("(3, 12)") {
                return Ok(Some(lines[0].to_string()));
            }
        }
        Ok(None)
    }

    async fn install_private_python(&self, on_line: OnLine<'_>, cancel: &CancellationToken) -> Result<PathBuf> {
        let python = Self::PYTHON_VERSION;
        let downloads = self.paths.runtime_root.join("downloads");
        std::fs::create_dir_all(&downloads)?;
        let installer = downloads.join(format!("python-{python}-amd64.exe"));
        if !installer.is_file() {
            let partial_installer = PathBuf::from(format!("{}.download", installer.display()));
            // The client has no timeout: a stalled server must still give way to Cancel.
            let response = cancel
                .run_until_cancelled(self.http_client.get(PYTHON_INSTALLER_URI).send())
                .await
                .ok_or(Cancelled)??
                .error_for_status()?;
            let mut source = response.bytes_stream();
            {
                let mut destination = tokio::fs::File::create(&partial_installer).await?;
                while let Some(chunk) = cancel.run_until_cancelled(source.next()).await.ok_or(Cancelled)? {
                    destination.write_all(&chunk?).await?;
                }
                destination.flush().await?;
            }
            std::fs::rename(&partial_installer, &installer)?;
        }
        let arguments = vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            path_text(&self.paths.signature_verifier_path()),
            "-InstallerPath".into(),
            path_text(&installer),
        ];
        ensure_success(
            self.process_runner
                .run(Path::new("powershell.exe"), &arguments, "python-signature-check", on_line, cancel, None)
                .await?,
            "Verifying the Python installer signature",
        )?;
        let install_logs = self.paths.training_root.join("install-logs");
        std::fs::create_dir_all(&install_logs)?;
        let stale_deckino_registration = registered_python_executables()
            .into_iter()
            .find(|path| !Path::new(path).is_file() && is_deckino_owned_python_path(path));
        if let Some(stale) = stale_deckino_registration {
            on_line(
                &format!(
                    "A deleted Deckino Python runtime is still registered at {stale}. Repairing it before removal…"
                ),
                None,
            );
            let repair_log =
                install_logs.join(format!("python-{python}-stale-repair-{}.log", Utc::now().format("%Y%m%d-%H%M%S")));
            let arguments = vec!["/repair".into(), "/quiet".into(), "/log".into(), path_text(&repair_log)];
            ensure_success(
                self.process_runner
                    .run(&installer, &arguments, "python-stale-runtime-repair", on_line, cancel, None)
                    .await?,
                "Repairing the deleted Deckino Python runtime before removal",
            )?;

            let uninstall_log = install_logs
                .join(format!("python-{python}-stale-uninstall-{}.log", Utc::now().format("%Y%m%d-%H%M%S")));
            let arguments = vec!["/uninstall".into(), "/quiet".into(), "/log".into(), path_text(&uninstall_log)];
            ensure_success(
                self.process_runner
                    .run(&installer, &arguments, "python-stale-runtime-uninstall", on_line, cancel, None)
                    .await?,
                "Removing the stale Deckino Python registration",
            )?;
            on_line("The stale Deckino Python registration was removed. Installing the persistent runtime…", None);
        }
        let private_python = self.paths.private_python();
        let target = private_python.parent().expect("python312 folder").to_path_buf();
        std::fs::create_dir_all(&target)?;
        let installer_log =
            install_logs.join(format!("python-{python}-install-{}.log", Utc::now().format("%Y%m%d-%H%M%S")));
        let mut installer_arguments = Self::build_private_python_installer_arguments(&target);
        installer_arguments.splice(1..1, ["/log".to_string(), path_text(&installer_log)]);
        ensure_success(
            self.process_runner
                .run(&installer, &installer_arguments, "python-private-install", on_line, cancel, None)
                .await?,
            "Installing private Python",
        )?;
        let mut attempt = 0;
        while attempt < 20 && !private_python.is_file() {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                _ = cancel.cancelled() => check(cancel)?,
            }
            attempt += 1;
        }
        if !private_python.is_file() {
            bail!(
                "Python installer completed without creating the private runtime. Installer log: {}",
                installer_log.display()
            );
        }
        Ok(private_python)
    }

    fn minimum_available_free_gib(&self) -> Result<f64> {
        let mut roots: Vec<PathBuf> = Vec::new();
        for path in [&self.paths.data_root, &self.paths.runtime_root] {
            let Some(root) = path.ancestors().last().filter(|root| !root.as_os_str().is_empty()) else { continue };
            if !roots.iter().any(|known| known.to_string_lossy().eq_ignore_ascii_case(&root.to_string_lossy())) {
                roots.push(root.to_path_buf());
            }
        }
        let mut minimum = f64::MAX;
        for root in roots {
            minimum = minimum.min(available_free_bytes(&root)? as f64 / 1024.0 / 1024.0 / 1024.0);
        }
        Ok(minimum)
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn ensure_success(result: PythonRunResult, operation: &str) -> Result<()> {
    if result.exit_code != 0 {
        bail!("{operation} failed with exit code {}. See {}", result.exit_code, result.log_path.display());
    }
    Ok(())
}

/// Runs a helper with no window and returns its exit code and stdout; None when it cannot start (not installed).
async fn capture(executable: &Path, arguments: &[&str], cancel: &CancellationToken) -> Result<Option<(i32, String)>> {
    let child = Command::new(executable)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .spawn();
    let Ok(child) = child else { return Ok(None) };
    tokio::select! {
        output = child.wait_with_output() => {
            let output = output?;
            Ok(Some((output.status.code().unwrap_or(-1), String::from_utf8_lossy(&output.stdout).into_owned())))
        }
        _ = cancel.cancelled() => {
            check(cancel)?;
            unreachable!()
        }
    }
}

async fn detect_nvidia_gpus(cancel: &CancellationToken) -> Result<Vec<NvidiaGpuInfo>> {
    let mut candidates = vec![PathBuf::from("nvidia-smi.exe")];
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("NVIDIA Corporation").join("NVSMI").join("nvidia-smi.exe"));
    }
    for executable in candidates {
        let arguments = ["--query-gpu=index,name,driver_version,memory.total", "--format=csv,noheader,nounits"];
        if let Some((0, output)) = capture(&executable, &arguments, cancel).await? {
            return Ok(TrainingEnvironmentService::parse_nvidia_smi_output(&output));
        }
    }
    Ok(Vec::new())
}

/// Every Python 3.12 the registry knows, for this user and the machine (64-bit view).
fn registered_python_executables() -> Vec<String> {
    const KEY_WOW64_64KEY: u32 = 0x0100;
    let mut result = Vec::new();
    for hive in [windows_registry::CURRENT_USER, windows_registry::LOCAL_MACHINE] {
        let Ok(python_core) = hive.options().read().access(KEY_WOW64_64KEY).open(r"SOFTWARE\Python\PythonCore") else {
            continue;
        };
        let Ok(versions) = python_core.keys() else { continue };
        for version in versions.filter(|name| name.to_lowercase().starts_with("3.12")) {
            let Ok(install_path) = python_core.open(format!(r"{version}\InstallPath")) else { continue };
            let mut executable = install_path.get_string("ExecutablePath").ok().filter(|v| !v.trim().is_empty());
            let directory = install_path.get_string("").ok().filter(|v| !v.trim().is_empty());
            if executable.is_none() {
                if let Some(directory) = directory {
                    executable = Some(path_text(&Path::new(&directory).join("python.exe")));
                }
            }
            if let Some(executable) = executable {
                result.push(executable);
            }
        }
    }
    result
}

fn is_deckino_owned_python_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_lowercase();
    normalized.contains(r"\data\training\runtime\python312\")
        || normalized.contains(r"\deckino\training-runtime-v3\python312\")
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetDiskFreeSpaceExW(
        directory: *const u16,
        free_bytes_available_to_caller: *mut u64,
        total_bytes: *mut u64,
        total_free_bytes: *mut u64,
    ) -> i32;
}

/// DriveInfo.AvailableFreeSpace: the free space this user may use on the drive holding `root`.
fn available_free_bytes(root: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    if unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(available)
}
