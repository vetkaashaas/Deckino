using System.Runtime.InteropServices;

namespace Deckino.Toolbox.Services;

public sealed class HeadlessCommandRunner(
    BulkDataSyncService bulkSync,
    ArtCropDownloadService artSync,
    ApplicationLogService applicationLog)
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int processId);

    public async Task<int> RunAsync(IReadOnlyList<string> arguments)
    {
        AttachConsole(-1);
        try
        {
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
}
