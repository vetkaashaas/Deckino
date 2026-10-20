using System.IO;
using System.Security.Cryptography;

namespace Deckino.Toolbox.Services;

public sealed record BucketTrainingRun(string Kind, string ModelVersion, long Bytes)
{
    public string Key => $"{TrainingRunSyncService.Prefix}{Kind}/{ModelVersion}.zip";
}

// Training runs move between PCs through the dataset bucket instead of copied ZIPs: a finished run uploads the same
// checksummed bundle the imports already take (training-runs/<kind>/<version>.zip), and any PC lists them and pulls
// one down, which imports it and makes it the current model there. Agents can read a run from the bucket the same way.
public sealed class TrainingRunSyncService(
    TrainingPaths paths, ISyncCredentialStore credentials, IRemoteObjectStoreFactory stores, TrainingResultExporter exporter,
    WorkspaceOperationCoordinator coordinator, Func<string?> latestExtractionRun)
{
    public const string Prefix = "training-runs/";
    public const string ArtworkKind = "artwork";
    public const string ExtractionKind = "extraction";

    public bool IsConfigured => credentials.Load() is not null;

    public async Task UploadAsync(string kind, string modelVersion, string zipPath, CancellationToken cancellationToken)
    {
        var run = new BucketTrainingRun(kind, modelVersion, new FileInfo(zipPath).Length);
        await using var store = OpenStore();
        string sha256;
        await using (var stream = File.OpenRead(zipPath))
            sha256 = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
        await store.UploadAsync(run.Key, zipPath, sha256, cancellationToken);
    }

    /// <summary>
    /// Uploads the newest finished run of each kind when the bucket doesn't have it: its upload failed, it finished
    /// before the bucket was connected, or it was trained before runs went through the bucket. Older runs stay local.
    /// </summary>
    public async Task<IReadOnlyList<string>> UploadMissingAsync(CancellationToken cancellationToken)
    {
        if (!IsConfigured) return [];
        var inBucket = (await ListAsync(cancellationToken)).Select(run => run.Key).ToHashSet(StringComparer.Ordinal);
        var uploaded = new List<string>();
        // Packing reads the run, so it holds the workspace lease (a pull or a run must not change it meanwhile); the
        // upload only reads the packed ZIP and runs without it. A busy workspace fails this, and the next start retries.
        if (exporter.ResolvePackableArtworkModel() is { } artwork
            && !inBucket.Contains(new BucketTrainingRun(ArtworkKind, artwork, 0).Key))
        {
            string zipPath;
            using (await coordinator.AcquireAsync("pack a training run", cancellationToken))
                zipPath = await exporter.PackArtworkForOtherPcsAsync(artwork, cancellationToken);
            await UploadAsync(ArtworkKind, artwork, zipPath, cancellationToken);
            uploaded.Add(artwork);
        }
        if (latestExtractionRun() is { } extraction
            && !inBucket.Contains(new BucketTrainingRun(ExtractionKind, extraction, 0).Key))
        {
            string zipPath;
            using (await coordinator.AcquireAsync("pack a training run", cancellationToken))
                zipPath = await exporter.ExportExtractionHandoffAsync(extraction, cancellationToken);
            await UploadAsync(ExtractionKind, extraction, zipPath, cancellationToken);
            uploaded.Add(extraction);
        }
        return uploaded;
    }

    /// <summary>Every run in the bucket, newest first.</summary>
    public async Task<IReadOnlyList<BucketTrainingRun>> ListAsync(CancellationToken cancellationToken)
    {
        await using var store = OpenStore();
        // A known hash for every object: the list needs no metadata request per run.
        var objects = await store.ListAsync(Prefix, (_, _, _) => string.Empty, null, cancellationToken);
        var runs = new List<BucketTrainingRun>();
        foreach (var item in objects)
            if (item.Key[Prefix.Length..].Split('/') is [(ArtworkKind or ExtractionKind) and var kind, var name]
                && name.EndsWith(".zip", StringComparison.Ordinal))
                runs.Add(new BucketTrainingRun(kind, name[..^4], item.Size));
        return runs.OrderByDescending(run => RunTimestamp(run.ModelVersion), StringComparer.Ordinal).ToList();
    }

    // "<kind>-run-<UTC timestamp>": the kinds' prefixes differ, so only the timestamp orders runs of both.
    private static string RunTimestamp(string modelVersion) =>
        modelVersion.LastIndexOf("-run-", StringComparison.Ordinal) is var at and >= 0 ? modelVersion[(at + 5)..] : modelVersion;

    /// <summary>Download a run and import it, which makes it this PC's current model of its kind.</summary>
    /// <param name="reportPercent">Gets 0–100 while the run downloads; the import follows.</param>
    public async Task<string> SyncDownAsync(
        BucketTrainingRun run, CancellationToken cancellationToken, Action<int>? reportPercent = null)
    {
        Directory.CreateDirectory(paths.IncomingRoot);
        var zipPath = Path.Combine(paths.IncomingRoot, $"{run.Kind}-{run.ModelVersion}.zip");
        try
        {
            await using (var store = OpenStore())
                await store.DownloadAsync(run.Key, zipPath, reportPercent ?? (_ => { }), cancellationToken);
            if (run.Kind == ArtworkKind)
            {
                var imported = await exporter.ImportArtworkIdentityBundleAsync(zipPath, cancellationToken);
                return $"{imported.ModelVersion} ({imported.Prototypes:N0} artwork prototypes"
                    + (imported.Qualified ? ", qualified)" : ", not qualified)");
            }
            var extraction = await exporter.ImportExtractionBundleAsync(zipPath, cancellationToken);
            return $"{extraction.ModelVersion} ({extraction.FileCount} files)";
        }
        finally
        {
            if (File.Exists(zipPath)) File.Delete(zipPath);
        }
    }

    /// <summary>The model version this PC uses now for a kind (its current-*.json pointer), if any.</summary>
    public string? CurrentVersion(string kind) => kind == ArtworkKind
        ? exporter.ReadCurrentArtworkPointer()?.ModelVersion
        : exporter.ReadCurrentExtractionPointer()?.ModelVersion;

    private IRemoteObjectStore OpenStore() => stores.Create(credentials.Load()
        ?? throw new InvalidOperationException("Connect the Railway bucket first (Dataset Sync)."));
}
