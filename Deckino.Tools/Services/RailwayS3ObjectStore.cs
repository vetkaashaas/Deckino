using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using System.IO;

namespace Deckino.Tools.Services;

public sealed class RailwayS3ObjectStoreFactory : IRemoteObjectStoreFactory
{
    public IRemoteObjectStore Create(DatasetSyncCredentials credentials) => new RailwayS3ObjectStore(credentials);
}

public sealed class RailwayS3ObjectStore : IRemoteObjectStore
{
    private readonly AmazonS3Client _client;
    private readonly string _bucket;

    public RailwayS3ObjectStore(DatasetSyncCredentials credentials)
    {
        if (!credentials.IsComplete) throw new ArgumentException("The dataset sync credentials are incomplete.", nameof(credentials));
        _bucket = credentials.Bucket.Trim();
        _client = new AmazonS3Client(
            new BasicAWSCredentials(credentials.AccessKeyId.Trim(), credentials.SecretAccessKey),
            new AmazonS3Config
            {
                ServiceURL = credentials.Endpoint.TrimEnd('/'),
                ForcePathStyle = credentials.ForcePathStyle,
                AuthenticationRegion = credentials.Region.Trim(),
            });
    }

    public async Task<IReadOnlyList<RemoteDatasetObject>> ListAsync(string prefix, CancellationToken cancellationToken)
    {
        var result = new List<RemoteDatasetObject>();
        string? continuationToken = null;
        do
        {
            var response = await _client.ListObjectsV2Async(new ListObjectsV2Request
            {
                BucketName = _bucket,
                Prefix = prefix,
                ContinuationToken = continuationToken,
            }, cancellationToken);
            foreach (var item in ObjectsOrEmpty(response))
            {
                if (string.IsNullOrWhiteSpace(item.Key)) continue;
                var metadata = await _client.GetObjectMetadataAsync(new GetObjectMetadataRequest
                {
                    BucketName = _bucket,
                    Key = item.Key,
                }, cancellationToken);
                var objectMetadata = metadata?.Metadata;
                result.Add(new RemoteDatasetObject(
                    item.Key,
                    objectMetadata?["x-amz-meta-deckino-sha256"]
                        ?? objectMetadata?["deckino-sha256"],
                    item.ETag?.Trim('"'),
                    item.Size ?? 0));
            }
            continuationToken = response?.IsTruncated == true ? response.NextContinuationToken : null;
        } while (continuationToken is not null);
        return result;
    }

    internal static IReadOnlyList<Amazon.S3.Model.S3Object> ObjectsOrEmpty(ListObjectsV2Response? response) =>
        response?.S3Objects ?? [];

    public async Task DownloadAsync(string key, string destinationPath, CancellationToken cancellationToken)
    {
        using var response = await _client.GetObjectAsync(_bucket, key, cancellationToken);
        await response.WriteResponseStreamToFileAsync(destinationPath, false, cancellationToken);
    }

    public async Task UploadAsync(string key, string sourcePath, string sha256, CancellationToken cancellationToken)
    {
        var request = new PutObjectRequest
        {
            BucketName = _bucket,
            Key = key,
            FilePath = sourcePath,
            AutoCloseStream = true,
        };
        request.Metadata["deckino-sha256"] = sha256;
        await _client.PutObjectAsync(request, cancellationToken);
    }

    public async Task UploadBytesAsync(string key, ReadOnlyMemory<byte> content, string sha256, CancellationToken cancellationToken)
    {
        using var stream = new MemoryStream(content.ToArray(), writable: false);
        var request = new PutObjectRequest
        {
            BucketName = _bucket,
            Key = key,
            InputStream = stream,
            AutoCloseStream = false,
            ContentType = "application/json",
        };
        request.Metadata["deckino-sha256"] = sha256;
        await _client.PutObjectAsync(request, cancellationToken);
    }

    public Task DeleteAsync(string key, CancellationToken cancellationToken) =>
        _client.DeleteObjectAsync(_bucket, key, cancellationToken);

    public ValueTask DisposeAsync()
    {
        _client.Dispose();
        return ValueTask.CompletedTask;
    }
}
