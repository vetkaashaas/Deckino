using System.IO;

namespace Deckino.Toolbox.Services;

public sealed class SyncOptions
{
    public required string DataRoot { get; init; }
    // Image downloads are latency-bound (about a second each from Scryfall's CDN), so many run at once:
    // measured ~25 images/s at 32, ~50 at 64 and ~90 at 128, where 56k faces take about 10 minutes.
    public int ImageConcurrency { get; init; } = 128;
    public int RequestIntervalMs { get; init; } = 60;
    public int ImportBatchSize { get; init; } = 500;

    public string BulkDirectory => Path.Combine(DataRoot, "bulk");
}
