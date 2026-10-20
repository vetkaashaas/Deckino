using Deckino.Toolbox.Bridge;
using Deckino.Toolbox.Data;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox;

public static class ToolboxServices
{
    public static void Add(IServiceCollection services, SynchronizationContext uiContext)
    {
        services.AddSingleton(new UiDispatcher(uiContext));
        services.AddSingleton<AppEvents>();
        services.AddSingleton<DesktopService>();
        services.AddSingleton<IDesktopService>(provider => provider.GetRequiredService<DesktopService>());
        services.AddSingleton<WorkspaceRegistry>();

        services.AddSingleton(_ => new TrainingPaths(Database.ResolveDataRoot()));
        services.AddSingleton(provider => new ApplicationLogService(provider.GetRequiredService<TrainingPaths>().LogsRoot));
        services.AddSingleton(_ =>
        {
            var database = new Database(Database.ResolveDefaultPath());
            database.Initialize();
            return database;
        });
        services.AddSingleton(provider => new SyncOptions
        {
            DataRoot = Path.GetDirectoryName(provider.GetRequiredService<Database>().DefaultPath)!,
        });
        services.AddSingleton(provider => new ScryfallClient(provider.GetRequiredService<SyncOptions>().RequestIntervalMs));
        services.AddSingleton<WorkspaceOperationCoordinator>();
        services.AddSingleton<HttpClient>();
        // A throwaway data root (DECKINO_TOOLBOX_DATA, the E2E run) gets its own, empty credentials: no bucket.
        services.AddSingleton(_ => new DpapiSyncCredentialStore(
            Database.DataRootOverride is { } dataRoot ? Path.Combine(dataRoot, "dataset-sync.credentials") : null));
        services.AddSingleton<RailwayS3ObjectStoreFactory>();
        services.AddSingleton(provider => new CameraDatasetSyncService(
            provider.GetRequiredService<TrainingPaths>(),
            provider.GetRequiredService<DpapiSyncCredentialStore>(),
            provider.GetRequiredService<RailwayS3ObjectStoreFactory>()));
        services.AddSingleton<ICameraDatasetSyncService>(provider => provider.GetRequiredService<CameraDatasetSyncService>());
        services.AddSingleton(provider => new TrainingRunSyncService(
            provider.GetRequiredService<TrainingPaths>(),
            provider.GetRequiredService<DpapiSyncCredentialStore>(),
            provider.GetRequiredService<RailwayS3ObjectStoreFactory>(),
            provider.GetRequiredService<TrainingResultExporter>(),
            provider.GetRequiredService<WorkspaceOperationCoordinator>(),
            () =>
            {
                try
                {
                    return provider.GetRequiredService<ExtractionProductionWorkflowService>().ResolveSuggestionModel().ModelVersion;
                }
                catch (Exception error) when (error is InvalidOperationException or IOException)
                {
                    return null; // no finished extraction run on this PC
                }
            }));
        services.AddSingleton(provider => new ToolboxUpdateService(
            provider.GetRequiredService<DpapiSyncCredentialStore>(),
            provider.GetRequiredService<RailwayS3ObjectStoreFactory>()));
        services.AddSingleton(provider => new ModelPublishService(
            provider.GetRequiredService<TrainingPaths>(),
            provider.GetRequiredService<DpapiSyncCredentialStore>(),
            provider.GetRequiredService<RailwayS3ObjectStoreFactory>(),
            provider.GetRequiredService<PythonProcessRunner>(),
            Database.RepositoryRoot() is { } repository ? Path.Combine(repository, "scripts") : null));
        services.AddSingleton(provider => new CameraAnnotationStore(
            provider.GetRequiredService<TrainingPaths>(),
            provider.GetRequiredService<CameraDatasetSyncService>()));
        services.AddSingleton(provider => new CameraImageImportService(
            provider.GetRequiredService<CameraAnnotationStore>(),
            provider.GetRequiredService<CameraDatasetSyncService>()));
        services.AddSingleton(provider => new VideoFrameImportService(
            provider.GetRequiredService<CameraAnnotationStore>(),
            changeTracker: provider.GetRequiredService<CameraDatasetSyncService>()));
        services.AddSingleton<BulkDataSyncService>();
        services.AddSingleton<CardImageService>();
        services.AddSingleton<CardCatalogueLookup>();
        services.AddSingleton<PythonProcessRunner>();
        services.AddSingleton<TrainingEnvironmentService>();
        services.AddSingleton<TrainingResultExporter>();
        services.AddSingleton<ExtractionProductionWorkflowService>();
        services.AddSingleton<IdentityProductionWorkflowService>();
        services.AddSingleton<ExtractionCornerSuggestionService>();
        services.AddSingleton<CardIdentitySuggestionService>();
        services.AddSingleton<IExtractionCornerSuggestionService>(provider =>
            provider.GetRequiredService<ExtractionCornerSuggestionService>());

        services.AddSingleton<SyncViewModel>();
        services.AddSingleton<DatasetSyncViewModel>();
        services.AddSingleton<VideoImportViewModel>();
        services.AddSingleton<AnnotatorViewModel>();
        services.AddSingleton<CardIdentificationViewModel>();
        services.AddSingleton<PhotoLibraryViewModel>();
        services.AddSingleton<ExtractionTrainingViewModel>();
        services.AddSingleton<RunnerViewModel>();
        services.AddSingleton<ShellViewModel>();
        services.AddSingleton<HeadlessCommandRunner>();
    }
}
