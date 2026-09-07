using System.Runtime.InteropServices;

namespace Deckino.Toolbox.Services;

public sealed class HeadlessCommandRunner(
    BulkDataSyncService bulkSync,
    ArtCropDownloadService artSync,
    ApplicationLogService applicationLog,
    TrainingResultExporter exporter,
    ExtractionProductionWorkflowService workflow)
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    public async Task<int> RunAsync(IReadOnlyList<string> arguments)
    {
        AttachConsole(-1);
        try
        {
            if (HasOption(arguments, "--import-extraction"))
            {
                if (!TryGetOptionValue(arguments, "--import-extraction", out var importPath)
                    || string.IsNullOrWhiteSpace(importPath))
                    throw new InvalidOperationException("Pass a ZIP path after --import-extraction.");
                applicationLog.Information("headless-import", $"Importing extraction bundle {importPath}.");
                var imported = await exporter.ImportExtractionBundleAsync(importPath, CancellationToken.None);
                Console.WriteLine($"imported {imported.ModelVersion} ({imported.FileCount} files) -> {imported.ArtifactRoot}");
                applicationLog.Information("headless-import", $"Imported {imported.ModelVersion}.");
                return 0;
            }

            if (HasOption(arguments, "--pack-extraction-handoff"))
            {
                TryGetOptionValue(arguments, "--pack-extraction-handoff", out var requestedVersion);
                var modelVersion = string.IsNullOrWhiteSpace(requestedVersion)
                    ? workflow.ResolveSuggestionModel().ModelVersion
                    : requestedVersion;
                applicationLog.Information("headless-handoff", $"Packing extraction handoff {modelVersion}.");
                var zipPath = await exporter.ExportExtractionHandoffAsync(modelVersion, CancellationToken.None);
                Console.WriteLine($"packed {zipPath}");
                applicationLog.Information("headless-handoff", $"Packed {zipPath}.");
                return 0;
            }

            if (arguments.Any(value => value.Equals("--sync-art", StringComparison.OrdinalIgnoreCase)))
            {
                applicationLog.Information("headless-art", "Art download started.");
                var preparation = await artSync.PreparePendingAsync(null, CancellationToken.None);
                var progress = new Progress<ArtSyncStatus>(status =>
                    Console.WriteLine($"{DateTime.UtcNow:HH:mm:ss} art: {status.Done:N0} done, {status.Failed:N0} failed, {status.Pending:N0} pending"));
                var result = await artSync.RunPendingAsync(progress, CancellationToken.None, preparation);
                Console.WriteLine($"done: {result.Downloaded:N0} downloaded, {result.Failed:N0} failed, {result.Repaired:N0} repaired");
                applicationLog.Information("headless-art", "Art download finished.");
                return result.Failed == 0 ? 0 : 1;
            }

            if (arguments.Any(value => value.Equals("--sync", StringComparison.OrdinalIgnoreCase)))
            {
                applicationLog.Information("headless-sync", "Bulk Scryfall sync started.");
                var progress = new Progress<BulkSyncStatus>(status =>
                    Console.WriteLine($"{DateTime.UtcNow:HH:mm:ss} {status.Stage}: {status.Processed:N0}"
                        + (status.Total is { } total ? $" / {total:N0}" : string.Empty)));
                var result = await bulkSync.SyncAllAsync(progress, CancellationToken.None);
                Console.WriteLine($"done: {result.CardsImported:N0} cards ({result.SetsUpserted} sets), "
                    + $"{result.OracleCardsImported:N0} oracle cards, no-art={result.NoArtCount}, "
                    + $"up-to-date=[{string.Join(", ", result.SkippedUpToDate)}]");
                applicationLog.Information("headless-sync", "Bulk Scryfall sync finished.");
                return 0;
            }

            return 0;
        }
        catch (Exception error)
        {
            applicationLog.Error("headless", "Headless operation failed.", error);
            Console.Error.WriteLine($"FAILED: {error}");
            return 1;
        }
    }

    private static bool HasOption(IReadOnlyList<string> arguments, string option) =>
        arguments.Any(value => value.Equals(option, StringComparison.OrdinalIgnoreCase));

    private static bool TryGetOptionValue(IReadOnlyList<string> arguments, string option, out string value)
    {
        for (var index = 0; index < arguments.Count; index++)
        {
            if (!arguments[index].Equals(option, StringComparison.OrdinalIgnoreCase)) continue;
            if (index + 1 < arguments.Count && !arguments[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                value = arguments[index + 1];
                return true;
            }
            value = string.Empty;
            return option.Equals("--pack-extraction-handoff", StringComparison.OrdinalIgnoreCase);
        }
        value = string.Empty;
        return false;
    }
}
