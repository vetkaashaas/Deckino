using Deckino.Toolbox.Data;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;
using Deckino.Toolbox.ViewModels;
using Microsoft.Extensions.Logging;

namespace Deckino.Toolbox;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
            });

        builder.Services.AddSingleton<IDesktopService, DesktopService>();
        builder.Services.AddSingleton(_ => new TrainingPaths(Database.ResolveDataRoot()));
        builder.Services.AddSingleton(provider => new ApplicationLogService(provider.GetRequiredService<TrainingPaths>().LogsRoot));
        builder.Services.AddSingleton(provider =>
        {
            var database = new Database(Database.ResolveDefaultPath());
            database.Initialize();
            return database;
        });
        builder.Services.AddSingleton(provider => new SyncOptions
        {
            DataRoot = Path.GetDirectoryName(provider.GetRequiredService<Database>().DefaultPath)!,
        });
        builder.Services.AddSingleton(provider => new ScryfallClient(provider.GetRequiredService<SyncOptions>().RequestIntervalMs));
        builder.Services.AddSingleton<WorkspaceOperationCoordinator>();
        builder.Services.AddSingleton<HttpClient>();
        builder.Services.AddSingleton<DpapiSyncCredentialStore>();
        builder.Services.AddSingleton<RailwayS3ObjectStoreFactory>();
        builder.Services.AddSingleton<CameraDatasetSyncService>(provider => new CameraDatasetSyncService(
            provider.GetRequiredService<TrainingPaths>(),
            provider.GetRequiredService<DpapiSyncCredentialStore>(),
            provider.GetRequiredService<RailwayS3ObjectStoreFactory>()));
        builder.Services.AddSingleton<ICameraDatasetSyncService>(provider => provider.GetRequiredService<CameraDatasetSyncService>());
        builder.Services.AddSingleton(provider => new CameraAnnotationStore(
            provider.GetRequiredService<TrainingPaths>(),
            provider.GetRequiredService<CameraDatasetSyncService>()));
        builder.Services.AddSingleton(provider => new CameraImageImportService(
            provider.GetRequiredService<CameraAnnotationStore>(),
            provider.GetRequiredService<CameraDatasetSyncService>()));
        builder.Services.AddSingleton(provider => new VideoFrameImportService(
            provider.GetRequiredService<CameraAnnotationStore>(),
            changeTracker: provider.GetRequiredService<CameraDatasetSyncService>()));
        builder.Services.AddSingleton<BulkDataSyncService>();
        builder.Services.AddSingleton<ArtCropDownloadService>();
        builder.Services.AddSingleton<PythonProcessRunner>();
        builder.Services.AddSingleton<TrainingEnvironmentService>();
        builder.Services.AddSingleton<TrainingResultExporter>();
        builder.Services.AddSingleton<ExtractionProductionWorkflowService>();
        builder.Services.AddSingleton<ExtractionAssetDownloadService>();
        builder.Services.AddSingleton<IdentityProductionWorkflowService>();
        builder.Services.AddSingleton<ExtractionCornerSuggestionService>();
        builder.Services.AddSingleton<IExtractionCornerSuggestionService>(provider =>
            provider.GetRequiredService<ExtractionCornerSuggestionService>());

        builder.Services.AddSingleton<SyncViewModel>();
        builder.Services.AddSingleton<DatasetSyncViewModel>();
        builder.Services.AddSingleton<VideoImportViewModel>();
        builder.Services.AddSingleton<AnnotatorViewModel>();
        builder.Services.AddSingleton<PhotoLibraryViewModel>();
        builder.Services.AddSingleton<ExtractionTrainingViewModel>();
        builder.Services.AddSingleton<RunnerViewModel>();
        builder.Services.AddSingleton<ShellViewModel>();
        builder.Services.AddSingleton<HeadlessCommandRunner>();
        builder.Services.AddSingleton<AppShell>();

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
