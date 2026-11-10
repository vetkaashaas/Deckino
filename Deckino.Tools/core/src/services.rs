//! Every service, built once and shared (ToolboxServices.Add).

use std::sync::Arc;

use crate::bulk_data_sync::BulkDataSyncService;
use crate::camera_annotation_store::CameraAnnotationStore;
use crate::camera_dataset_sync_service::CameraDatasetSyncService;
use crate::camera_image_import::CameraImageImportService;
use crate::card_catalogue_lookup::CardCatalogueLookup;
use crate::card_identity_suggestions::CardIdentitySuggestionService;
use crate::card_images::CardImageService;
use crate::coordinator::WorkspaceOperationCoordinator;
use crate::credentials::DpapiSyncCredentialStore;
use crate::db::Database;
use crate::extraction_corner_suggestions::ExtractionCornerSuggestionService;
use crate::extraction_production_workflow::ExtractionProductionWorkflowService;
use crate::identity_production_workflow::IdentityProductionWorkflowService;
use crate::log::ApplicationLogService;
use crate::model_publish::ModelPublishService;
use crate::paths::{self, TrainingPaths};
use crate::python::PythonProcessRunner;
use crate::scryfall::ScryfallClient;
use crate::sync_options::SyncOptions;
use crate::toolbox_update::ToolboxUpdateService;
use crate::training_environment::TrainingEnvironmentService;
use crate::training_result_exporter::TrainingResultExporter;
use crate::training_run_sync::TrainingRunSyncService;

pub struct Services {
    pub paths: TrainingPaths,
    pub database: Database,
    pub log: Arc<ApplicationLogService>,
    pub coordinator: WorkspaceOperationCoordinator,
    pub http: reqwest::Client,
    pub credentials: Arc<DpapiSyncCredentialStore>,
    pub sync_options: SyncOptions,
    pub scryfall: Arc<ScryfallClient>,
    pub camera_dataset_sync: Arc<CameraDatasetSyncService>,
    pub training_run_sync: Arc<TrainingRunSyncService>,
    pub toolbox_update: Arc<ToolboxUpdateService>,
    pub model_publish: Arc<ModelPublishService>,
    pub camera_annotation_store: Arc<CameraAnnotationStore>,
    pub camera_image_import: Arc<CameraImageImportService>,
    /// The model benchmark's photos (camera/benchmark): the same three services, its own folder and bucket prefix.
    pub benchmark_dataset_sync: Arc<CameraDatasetSyncService>,
    pub benchmark_annotation_store: Arc<CameraAnnotationStore>,
    pub benchmark_image_import: Arc<CameraImageImportService>,
    pub bulk_data_sync: Arc<BulkDataSyncService>,
    pub card_images: Arc<CardImageService>,
    pub card_catalogue_lookup: Arc<CardCatalogueLookup>,
    pub python_runner: Arc<PythonProcessRunner>,
    pub training_environment: Arc<TrainingEnvironmentService>,
    pub training_result_exporter: Arc<TrainingResultExporter>,
    pub extraction_workflow: Arc<ExtractionProductionWorkflowService>,
    pub identity_workflow: Arc<IdentityProductionWorkflowService>,
    pub extraction_corner_suggestions: Arc<ExtractionCornerSuggestionService>,
    pub card_identity_suggestions: Arc<CardIdentitySuggestionService>,
}

impl Services {
    pub fn new() -> anyhow::Result<Services> {
        let paths = TrainingPaths::new(paths::resolve_data_root());
        let log = Arc::new(ApplicationLogService::new(paths.logs_root.clone()));
        let database = Database::new(Database::default_path());
        database.initialize()?;
        let data_root =
            database.path().parent().map(|root| root.to_path_buf()).unwrap_or_else(|| paths.data_root.clone());
        let sync_options = SyncOptions::new(data_root);
        let scryfall = Arc::new(ScryfallClient::new(sync_options.request_interval_ms));
        let coordinator = WorkspaceOperationCoordinator::default();
        let http = reqwest::Client::new();
        // A throwaway data root (DECKINO_TOOLBOX_DATA, the E2E run) gets its own, empty credentials: no bucket.
        let credentials = Arc::new(DpapiSyncCredentialStore::new(
            paths::data_root_override().map(|root| root.join("dataset-sync.credentials")),
        ));
        let python_runner = Arc::new(PythonProcessRunner::new(paths.clone()));
        let training_result_exporter = Arc::new(TrainingResultExporter::new(paths.clone()));
        let camera_dataset_sync = CameraDatasetSyncService::new(paths.clone(), credentials.clone())?;
        let extraction_workflow = Arc::new(ExtractionProductionWorkflowService::new(
            paths.clone(),
            python_runner.clone(),
            training_result_exporter.clone(),
        ));
        let latest_extraction_run: Arc<dyn Fn() -> Option<String> + Send + Sync> = {
            let workflow = extraction_workflow.clone();
            // None: no finished extraction run on this PC.
            Arc::new(move || workflow.resolve_suggestion_model().ok().map(|model| model.model_version))
        };
        let training_run_sync = Arc::new(TrainingRunSyncService::new(
            paths.clone(),
            credentials.clone(),
            training_result_exporter.clone(),
            coordinator.clone(),
            latest_extraction_run,
        ));
        let toolbox_update = Arc::new(ToolboxUpdateService::new(credentials.clone()));
        let model_publish = Arc::new(ModelPublishService::new(
            paths.clone(),
            credentials.clone(),
            python_runner.clone(),
            paths::repository_root().map(|repository| repository.join("scripts")),
        ));
        let camera_annotation_store =
            Arc::new(CameraAnnotationStore::new(paths.clone(), Some(camera_dataset_sync.clone())));
        let camera_image_import =
            Arc::new(CameraImageImportService::new(camera_annotation_store.clone(), Some(camera_dataset_sync.clone())));
        let benchmark_dataset_sync = camera_dataset_sync.benchmark()?;
        let benchmark_annotation_store =
            Arc::new(CameraAnnotationStore::benchmark(paths.clone(), Some(benchmark_dataset_sync.clone())));
        let benchmark_image_import = Arc::new(CameraImageImportService::new(
            benchmark_annotation_store.clone(),
            Some(benchmark_dataset_sync.clone()),
        ));
        let bulk_data_sync =
            Arc::new(BulkDataSyncService::new(database.clone(), scryfall.clone(), sync_options.clone()));
        let card_images = Arc::new(CardImageService::new(database.clone(), scryfall.clone(), sync_options.clone()));
        let card_catalogue_lookup = Arc::new(CardCatalogueLookup::new(database.clone(), paths.clone()));
        let training_environment =
            Arc::new(TrainingEnvironmentService::new(paths.clone(), python_runner.clone(), http.clone()));
        let identity_workflow = Arc::new(IdentityProductionWorkflowService::new(
            paths.clone(),
            python_runner.clone(),
            training_result_exporter.clone(),
        ));
        let extraction_corner_suggestions = Arc::new(ExtractionCornerSuggestionService::new(
            paths.clone(),
            python_runner.clone(),
            extraction_workflow.clone(),
            log.clone(),
        ));
        let card_identity_suggestions = Arc::new(CardIdentitySuggestionService::new(
            paths.clone(),
            python_runner.clone(),
            training_result_exporter.clone(),
            log.clone(),
        ));
        Ok(Services {
            paths,
            database,
            log,
            coordinator,
            http,
            credentials,
            sync_options,
            scryfall,
            camera_dataset_sync,
            training_run_sync,
            toolbox_update,
            model_publish,
            camera_annotation_store,
            camera_image_import,
            benchmark_dataset_sync,
            benchmark_annotation_store,
            benchmark_image_import,
            bulk_data_sync,
            card_images,
            card_catalogue_lookup,
            python_runner,
            training_environment,
            training_result_exporter,
            extraction_workflow,
            identity_workflow,
            extraction_corner_suggestions,
            card_identity_suggestions,
        })
    }

    /// The training photos' store, or the benchmark's.
    pub fn photo_store(&self, benchmark: bool) -> &Arc<CameraAnnotationStore> {
        if benchmark { &self.benchmark_annotation_store } else { &self.camera_annotation_store }
    }

    /// The store of the library this photo is in, whichever library a page is showing.
    pub fn store_for(&self, image_path: &std::path::Path) -> &Arc<CameraAnnotationStore> {
        // Ignoring case, like the stores and syncs: Windows paths may differ only in case.
        self.photo_store(crate::paths::is_within(image_path, &self.paths.camera_benchmark_root))
    }

    /// The training photos' importer, or the benchmark's.
    pub fn photo_import(&self, benchmark: bool) -> &Arc<CameraImageImportService> {
        if benchmark { &self.benchmark_image_import } else { &self.camera_image_import }
    }

    /// Stops the Python workers and the dataset sync's background work (Program.StopServicesAsync).
    pub async fn shutdown(&self) {
        // Together: one slow stop must not use up the caller's timeout before the others start.
        tokio::join!(
            self.extraction_corner_suggestions.shutdown(),
            self.card_identity_suggestions.shutdown(),
            self.camera_dataset_sync.shutdown(),
            self.benchmark_dataset_sync.shutdown(),
        );
    }
}
