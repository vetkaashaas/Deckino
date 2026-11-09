use crate::paths::TrainingPaths;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrainingStageAvailability {
    pub can_prepare_dataset: bool,
    pub dataset_ready: bool,
    pub cuda_smoke_ready: bool,
    pub training_ready: bool,
    pub evaluation_ready: bool,
}

impl TrainingStageAvailability {
    pub fn evaluate(
        paths: &TrainingPaths,
        dataset_version: &str,
        model_version: &str,
        packages_ready: bool,
        paper_cache_ready: bool,
    ) -> Self {
        let dataset_ready = paths.manifest_path(dataset_version).is_file();
        let smoke_marker = paths.training_root.join("cuda-smoke-v3.ok");
        let cuda_smoke_ready =
            dataset_ready && std::fs::read_to_string(&smoke_marker).is_ok_and(|text| text.trim() == dataset_version);
        let artifact_root = paths.artifact_root(model_version);
        let training_ready = artifact_root.join("best.pt").is_file();
        let evaluation_ready = training_ready
            && artifact_root.join("thresholds.json").is_file()
            && artifact_root.join("evaluation.json").is_file();
        Self {
            can_prepare_dataset: packages_ready && paper_cache_ready,
            dataset_ready,
            cuda_smoke_ready,
            training_ready,
            evaluation_ready,
        }
    }
}
