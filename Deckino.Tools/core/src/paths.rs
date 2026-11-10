use std::path::{Path, PathBuf};

/// The repository a build runs from: the folder holding the .git folder. None when installed.
pub fn repository_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|dir| dir.join(".git").is_dir()).map(Path::to_path_buf)
}

/// DECKINO_TOOLBOX_DATA: a throwaway data root (an E2E run), which also gets its own, empty bucket credentials. A
/// debug build's only: an installed Toolbox always opens its own data.
pub fn data_root_override() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let value = std::env::var("DECKINO_TOOLBOX_DATA").ok().filter(|v| !v.is_empty())?;
    Some(std::path::absolute(value).ok()?)
}

pub fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// A build inside the repository keeps its data next to the code (Code/data). An installed Toolbox keeps it in
/// %LocalAppData%\Deckino\data, beside its credentials and Python runtime: every update replaces the install folder.
pub fn resolve_data_root() -> PathBuf {
    data_root_override().unwrap_or_else(|| match repository_root() {
        Some(repository) => repository.join("data"),
        None => local_app_data().join("Deckino").join("data"),
    })
}

/// The folder the exe runs from.
pub fn base_directory() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The training package (Python sources, requirements, runtime tools) shipped beside the exe. A build in
/// the repository reads it where it lives, in Deckino.Tools/training.
fn bundled_project_root() -> PathBuf {
    let beside = base_directory().join("training");
    if beside.is_dir() {
        return beside;
    }
    match repository_root() {
        Some(repository) => repository.join("Deckino.Tools").join("training"),
        None => beside,
    }
}

/// Where everything lives. Mirrors the C# Toolbox's TrainingPaths exactly: both read the same data.
#[derive(Clone, Debug)]
pub struct TrainingPaths {
    pub data_root: PathBuf,
    pub training_root: PathBuf,
    pub runtime_root: PathBuf,
    pub virtual_environment_root: PathBuf,
    pub logs_root: PathBuf,
    pub artifacts_root: PathBuf,
    pub handoff_root: PathBuf,
    pub incoming_root: PathBuf,
    pub current_extraction_pointer_path: PathBuf,
    pub current_artwork_pointer_path: PathBuf,
    pub mobile_artwork_root: PathBuf,
    pub production_root: PathBuf,
    pub camera_root: PathBuf,
    pub camera_imports_root: PathBuf,
    /// The model benchmark's photos: beside imports, never inside, so no trainer reads them.
    pub camera_benchmark_root: PathBuf,
    pub extraction_root: PathBuf,
    pub card_images_root: PathBuf,
    pub extraction_production_root: PathBuf,
    pub exports_root: PathBuf,
    pub torch_cache_root: PathBuf,
    pub bundled_project_root: PathBuf,
}

impl TrainingPaths {
    pub fn new(data_root: impl AsRef<Path>) -> Self {
        let data_root = std::path::absolute(data_root.as_ref()).unwrap_or_else(|_| data_root.as_ref().to_path_buf());
        let training_root = data_root.join("training");
        let runtime_root = local_app_data().join("Deckino").join("training-runtime-v3");
        let camera_root = training_root.join("camera");
        let production_root = training_root.join("production");
        Self {
            virtual_environment_root: runtime_root.join("venv"),
            logs_root: training_root.join("logs"),
            artifacts_root: training_root.join("artifacts"),
            handoff_root: training_root.join("handoff"),
            incoming_root: training_root.join("incoming"),
            current_extraction_pointer_path: training_root.join("current-extraction.json"),
            current_artwork_pointer_path: training_root.join("current-artwork.json"),
            mobile_artwork_root: training_root.join("mobile").join("artwork"),
            camera_imports_root: camera_root.join("imports"),
            camera_benchmark_root: camera_root.join("benchmark"),
            extraction_root: training_root.join("extraction"),
            card_images_root: data_root.join("card-images"),
            extraction_production_root: production_root.join("extraction"),
            exports_root: data_root.join("exports"),
            torch_cache_root: runtime_root.join("torch-cache"),
            bundled_project_root: bundled_project_root(),
            camera_root,
            production_root,
            runtime_root,
            training_root,
            data_root,
        }
    }

    pub fn bundled_source_root(&self) -> PathBuf {
        self.bundled_project_root.join("src")
    }
    pub fn virtual_environment_python(&self) -> PathBuf {
        self.virtual_environment_root.join("Scripts").join("python.exe")
    }
    pub fn requirements_path(&self) -> PathBuf {
        self.bundled_project_root.join("requirements-cuda.txt")
    }
    pub fn signature_verifier_path(&self) -> PathBuf {
        self.bundled_project_root.join("runtime-tools").join("verify-python-signature.ps1")
    }
    pub fn private_python(&self) -> PathBuf {
        self.runtime_root.join("python312").join("python.exe")
    }
    pub fn dataset_root(&self, version: &str) -> PathBuf {
        self.exports_root.join(version)
    }
    pub fn manifest_path(&self, version: &str) -> PathBuf {
        self.dataset_root(version).join("manifest.jsonl")
    }
    pub fn artifact_root(&self, version: &str) -> PathBuf {
        self.artifacts_root.join(version)
    }

    /// The path below the data root with forward slashes, as stored in manifests and the sync catalogue.
    pub fn relative_to_data_root(&self, full_path: impl AsRef<Path>) -> String {
        relative_path(&self.data_root, full_path.as_ref())
    }
}

/// `path` is `root` or inside it, by whole components and ignoring case (Windows paths).
pub fn is_within(path: &Path, root: &Path) -> bool {
    let fold = |path: &Path| PathBuf::from(path.to_string_lossy().to_lowercase());
    fold(path).starts_with(fold(root))
}

/// Path.GetRelativePath with forward slashes. Falls back to the full path when `path` is not below `root`.
pub fn relative_path(root: &Path, path: &Path) -> String {
    let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let root = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    // Windows paths compare case-insensitively; part by part, so a lowercase of another byte length can't skew a slice.
    let lower = |part: std::path::Component| part.as_os_str().to_string_lossy().to_lowercase();
    let mut rest = path.components();
    if root.components().all(|part| rest.next().is_some_and(|other| lower(part) == lower(other))) {
        let parts: Vec<String> = rest.map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
        return if parts.is_empty() { ".".into() } else { parts.join("/") };
    }
    path.to_string_lossy().replace('\\', "/")
}
