using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Drawing;
using DrawingImage = System.Drawing.Image;
using Dapper;
using Deckino.Toolbox.Data;

namespace Deckino.Toolbox.Services;

public sealed record ExtractionAssetCacheStatus(
    long Available,
    long Downloaded,
    long Pending,
    long Failed,
    long DownloadedBytes,
    long EstimatedRemainingBytes);

public sealed record ExtractionAssetDownloadProgress(long Completed, long Failed, long Remaining);

public sealed class ExtractionAssetDownloadService(
    Database database,
    TrainingPaths paths,
    HttpClient client)
{
    private const int DownloadConcurrency = 8;

    public async Task<ExtractionAssetCacheStatus> InspectAsync(CancellationToken cancellationToken)
    {
        await using var connection = database.OpenConnection();
        var rows = (await connection.QueryAsync<(string Status, long Count, long Bytes)>(new CommandDefinition(
            """
            SELECT status AS Status, COUNT(*) AS Count, COALESCE(SUM(file_bytes), 0) AS Bytes
            FROM extraction_full_card_assets
            GROUP BY status
            """, cancellationToken: cancellationToken))).ToArray();
        long Count(string status) => rows.Where(row => row.Status == status).Sum(row => row.Count);
        var downloaded = Count("downloaded");
        var downloadedBytes = rows.Where(row => row.Status == "downloaded").Sum(row => row.Bytes);
        var averageBytes = downloaded > 0 ? downloadedBytes / downloaded : 150_000;
        var pending = Count("pending");
        var failed = Count("failed");
        return new(rows.Sum(row => row.Count), downloaded, pending, failed, downloadedBytes,
            checked((pending + failed) * averageBytes));
    }

    public async Task<ExtractionAssetCacheStatus> DownloadPendingAsync(
        int maximumAssets,
        IProgress<ExtractionAssetDownloadProgress>? progress,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(paths.ExtractionFullCardsRoot);
        await using var readConnection = database.OpenConnection();
        var assets = (await readConnection.QueryAsync<PendingExtractionAsset>(new CommandDefinition(
            """
            SELECT a.asset_id AS AssetId, a.normal_uri AS NormalUri, c.set_code AS SetCode
            FROM extraction_full_card_assets a
            JOIN cards c ON c.scryfall_id = a.scryfall_id
            WHERE a.status IN ('pending', 'failed')
            ORDER BY a.asset_id
            LIMIT $maximumAssets
            """, new { maximumAssets }, cancellationToken: cancellationToken))).ToArray();
        if (assets.Length == 0) return await InspectAsync(cancellationToken);
        var completed = 0L;
        var failed = 0L;
        await using var writer = database.OpenConnection();
        using var writerLock = new SemaphoreSlim(1, 1);
        await Parallel.ForEachAsync(assets, new ParallelOptions
        {
            MaxDegreeOfParallelism = Math.Min(DownloadConcurrency, assets.Length),
            CancellationToken = cancellationToken,
        }, async (asset, token) =>
        {
            try
            {
                var downloaded = await DownloadOneAsync(asset, token);
                await writerLock.WaitAsync(token);
                try
                {
                    await writer.ExecuteAsync(new CommandDefinition(
                        """
                        UPDATE extraction_full_card_assets
                        SET status = 'downloaded', file_path = $relative, file_bytes = $bytes,
                            image_width = $width, image_height = $height,
                            sha256 = $hash, updated_at = $updated
                        WHERE asset_id = $assetId
                        """, new { relative = downloaded.RelativePath.Replace('\\', '/'),
                            bytes = downloaded.Bytes,
                            width = downloaded.Width,
                            height = downloaded.Height,
                            hash = downloaded.Hash,
                            updated = DateTime.UtcNow.ToString("o"), assetId = asset.AssetId },
                        cancellationToken: token));
                }
                finally
                {
                    writerLock.Release();
                }
                Interlocked.Increment(ref completed);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error) when (error is HttpRequestException or IOException or NotSupportedException)
            {
                await writerLock.WaitAsync(CancellationToken.None);
                try
                {
                    await writer.ExecuteAsync(
                        """
                        UPDATE extraction_full_card_assets
                        SET status = 'failed', updated_at = $updated
                        WHERE asset_id = $assetId
                        """, new { updated = DateTime.UtcNow.ToString("o"), assetId = asset.AssetId });
                }
                finally
                {
                    writerLock.Release();
                }
                Interlocked.Increment(ref failed);
            }
            var done = Interlocked.Read(ref completed);
            var failedCount = Interlocked.Read(ref failed);
            progress?.Report(new(done, failedCount, assets.Length - done - failedCount));
        });
        return await InspectAsync(cancellationToken);
    }

    private async Task<DownloadedExtractionAsset> DownloadOneAsync(
        PendingExtractionAsset asset,
        CancellationToken cancellationToken)
    {
        var extension = Uri.TryCreate(asset.NormalUri, UriKind.Absolute, out var uri)
            && Path.GetExtension(uri.AbsolutePath) is { Length: > 0 } value
                ? value : ".jpg";
        var safeAssetId = string.Concat(asset.AssetId.Select(character =>
            char.IsLetterOrDigit(character) || character is '-' or '_' ? character : '_'));
        var relative = Path.Combine("training", "extraction", "full-cards",
            asset.SetCode, safeAssetId + extension);
        var destination = Path.Combine(paths.DataRoot, relative);
        var temporary = destination + ".download";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            using var response = await client.GetAsync(asset.NormalUri,
                HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            response.EnsureSuccessStatusCode();
            await using (var source = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var output = File.Create(temporary))
                await source.CopyToAsync(output, cancellationToken);
            var dimensions = ValidateImage(temporary);
            var bytes = new FileInfo(temporary).Length;
            string hash;
            await using (var hashStream = File.OpenRead(temporary))
                hash = Convert.ToHexString(await SHA256.HashDataAsync(
                    hashStream, cancellationToken)).ToLowerInvariant();
            File.Move(temporary, destination, overwrite: true);
            return new(relative, bytes, dimensions.Width, dimensions.Height, hash);
        }
        catch
        {
            if (File.Exists(temporary)) File.Delete(temporary);
            throw;
        }
    }

    private static (int Width, int Height) ValidateImage(string path)
    {
        using var stream = File.OpenRead(path);
        using var image = DrawingImage.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: true);
        if (image.Width < 64 || image.Height < 64)
            throw new InvalidDataException("Downloaded full-card image is invalid.");
        return (image.Width, image.Height);
    }

    private sealed record PendingExtractionAsset(string AssetId, string NormalUri, string SetCode);
    private sealed record DownloadedExtractionAsset(
        string RelativePath,
        long Bytes,
        int Width,
        int Height,
        string Hash);
}
