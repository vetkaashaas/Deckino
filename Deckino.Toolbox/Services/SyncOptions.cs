using System.IO;

namespace Deckino.Toolbox.Services;

public sealed class SyncOptions
{
    public required string DataRoot { get; init; }
    public int ImageConcurrency { get; init; } = 8;
    public int RequestIntervalMs { get; init; } = 60;
    public int ImportBatchSize { get; init; } = 500;

    public string BulkDirectory => Path.Combine(DataRoot, "bulk");
    public string CardsDirectory => Path.Combine(DataRoot, "cards");
}
