using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;

namespace Deckino.Api.Training;

// The scanner's models, published by the Toolbox (ModelPublishService) into the training bucket: the files under
// models/<kind>/<version>/, then models/<kind>/schema-<n>/latest.json naming them. An app asks for the newest model
// its code can run (the schema it was built with) and downloads the files straight from the bucket with presigned
// URLs: bucket egress is free on Railway, the API's is not. Without the bucket configured the endpoint answers 404.
public static class ModelEndpoints
{
    private static readonly string[] Kinds = ["artwork", "extractor"];
    // Checked when a download starts, not while it runs; the app asks again on its next start.
    private static readonly TimeSpan UrlLifetime = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan PointerLifetime = TimeSpan.FromMinutes(1);
    private static readonly ConcurrentDictionary<string, (DateTime ReadUtc, ModelPointer? Pointer)> Pointers = new();
    private static readonly JsonSerializerOptions PointerJson = new(JsonSerializerDefaults.Web);

    public static void MapModelEndpoints(this WebApplication app, TrainingBucket? bucket)
    {
        // Anonymous: signed out, the app scans too. The global per-client limit covers it (one call per start).
        app.MapGet("/api/models/{kind}", async (string kind, int schema, CancellationToken ct) =>
        {
            if (bucket is null || !Kinds.Contains(kind) || schema is < 1 or > 1000) return Results.NotFound();
            var pointer = await LatestAsync(bucket, kind, schema, ct);
            if (pointer is null) return Results.NotFound();
            var expires = DateTime.UtcNow + UrlLifetime;
            return Results.Ok(new ModelRelease(pointer.ModelVersion, pointer.Files.Select(file => new ModelReleaseFile(
                file.Name, file.Bytes, file.Md5, bucket.Client.GetPreSignedURL(new GetPreSignedUrlRequest
                {
                    BucketName = bucket.Name,
                    Key = $"models/{kind}/{pointer.ModelVersion}/{file.Name}",
                    Verb = HttpVerb.GET,
                    Expires = expires,
                }))).ToList()));
        });
    }

    // Cached a minute: every app start asks, and a publish can wait that long to show.
    private static async Task<ModelPointer?> LatestAsync(TrainingBucket bucket, string kind, int schema, CancellationToken ct)
    {
        var key = $"models/{kind}/schema-{schema}/latest.json";
        if (Pointers.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.ReadUtc < PointerLifetime) return cached.Pointer;
        ModelPointer? pointer;
        try
        {
            using var response = await bucket.Client.GetObjectAsync(bucket.Name, key, ct);
            pointer = await JsonSerializer.DeserializeAsync<ModelPointer>(response.ResponseStream, PointerJson, ct);
        }
        catch (AmazonS3Exception error) when (error.StatusCode == HttpStatusCode.NotFound)
        {
            pointer = null;
        }
        Pointers[key] = (DateTime.UtcNow, pointer);
        return pointer;
    }
}

// latest.json as the Toolbox writes it.
public sealed record ModelPointer(string ModelVersion, int Schema, List<ModelPointerFile> Files);

public sealed record ModelPointerFile(string Name, long Bytes, string Sha256, string Md5);

public sealed record ModelRelease(string ModelVersion, List<ModelReleaseFile> Files);

public sealed record ModelReleaseFile(string Name, long Bytes, string Md5, string Url);
