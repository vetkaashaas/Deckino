using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Deckino.Toolbox.Services;

public sealed record PublishedModel(string Kind, string ModelVersion, int Schema, long Bytes);

// Puts the current model (data/training/current-*.json) on the app's update channel: its mobile export, once
// scripts/ensure-*-mobile.ps1 has verified the app's code against it, goes to the dataset bucket under
// models/<kind>/<version>/, then models/<kind>/schema-<n>/latest.json names it. The pointer goes last, so an app
// never finds a version whose files are still uploading. The API (ModelEndpoints) hands the files out from there.
public sealed class ModelPublishService(
    TrainingPaths paths, ISyncCredentialStore credentials, IRemoteObjectStoreFactory stores)
{
    // What the app loads (src/scan/model-store.ts), and which manifest field is the contract the app was built for.
    private static readonly Dictionary<string, (string Pointer, string SchemaField, string[] Files)> Kinds = new()
    {
        ["artwork"] = ("current-artwork.json", "artwork_mobile_schema_version",
            ["recognizer.onnx", "app-labels.json", "mobile-manifest.json"]),
        ["extractor"] = ("current-extraction.json", "mobile_export_schema_version",
            ["extractor.onnx", "refiner.onnx", "mobile-manifest.json", "thresholds.json"]),
    };

    public async Task<PublishedModel> PublishAsync(string kind, CancellationToken cancellationToken)
    {
        if (!Kinds.TryGetValue(kind, out var spec)) throw new ArgumentException($"Unknown model kind '{kind}'.", nameof(kind));
        var version = ReadString(Path.Combine(paths.TrainingRoot, spec.Pointer), "model_version")
            ?? throw new InvalidOperationException($"No current {kind} model ({spec.Pointer}). Import one first.");
        var folder = Path.Combine(paths.TrainingRoot, "mobile", kind, version);
        var script = kind == "artwork" ? "ensure-artwork-mobile.ps1" : "ensure-extraction-mobile.ps1";

        var verification = Path.Combine(folder, "app-verification.json");
        if (ReadString(verification, "model_version") != version || ReadNode(verification)?["passed"]?.GetValue<bool>() != true)
            throw new InvalidOperationException(
                $"{version} has no passed app verification. Run scripts/{script} first; it exports and verifies the model.");
        var manifest = ReadNode(Path.Combine(folder, "mobile-manifest.json"));
        if (manifest?["model_version"]?.GetValue<string>() != version || manifest[spec.SchemaField]?.GetValue<int>() is not int schema)
            throw new InvalidOperationException($"The mobile export of {version} has no {spec.SchemaField}. Run scripts/{script} again.");

        var files = new List<(string Name, string Path, long Bytes, string Sha256, string Md5)>();
        foreach (var name in spec.Files)
        {
            var path = Path.Combine(folder, name);
            if (!File.Exists(path)) throw new InvalidOperationException($"{name} is missing from {folder}. Run scripts/{script} again.");
            files.Add((name, path, new FileInfo(path).Length, await HashAsync(SHA256.Create(), path, cancellationToken),
                await HashAsync(MD5.Create(), path, cancellationToken)));
        }

        var connection = credentials.Load() ?? throw new InvalidOperationException("Connect the Railway bucket first (Dataset Sync).");
        await using var store = stores.Create(connection);
        foreach (var file in files)
            await store.UploadAsync($"models/{kind}/{version}/{file.Name}", file.Path, file.Sha256, cancellationToken);
        var pointer = JsonSerializer.SerializeToUtf8Bytes(new
        {
            modelVersion = version,
            schema,
            publishedUtc = DateTime.UtcNow,
            files = files.Select(file => new { name = file.Name, bytes = file.Bytes, sha256 = file.Sha256, md5 = file.Md5 }),
        }, new JsonSerializerOptions { WriteIndented = true });
        await store.UploadBytesAsync($"models/{kind}/schema-{schema}/latest.json", pointer,
            Convert.ToHexString(SHA256.HashData(pointer)).ToLowerInvariant(), cancellationToken);
        return new PublishedModel(kind, version, schema, files.Sum(file => file.Bytes));
    }

    private static async Task<string> HashAsync(HashAlgorithm algorithm, string path, CancellationToken cancellationToken)
    {
        using (algorithm)
        await using (var stream = File.OpenRead(path))
            return Convert.ToHexString(await algorithm.ComputeHashAsync(stream, cancellationToken)).ToLowerInvariant();
    }

    private static JsonNode? ReadNode(string path) => File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) : null;

    private static string? ReadString(string path, string property) => ReadNode(path)?[property]?.GetValue<string>();
}
