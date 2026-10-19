using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.AspNetCore.Http.Features;

namespace Deckino.Api.Training;

// Scans from signed-in app users who opted in (Profile, Privacy). Each capture becomes a photo plus its
// ._identity.json sidecar, which records the sender, in the Toolbox's camera dataset bucket, where the Toolbox sync
// picks them up for corner annotation and card identification review. Without the bucket configured (TrainingBucket)
// the endpoint answers 404 as if it did not exist.
public static class TrainingCaptureEndpoints
{
    private const long MaxBodyBytes = 3_000_000;
    private const int MaxImageBytes = 2_000_000;
    private const string FilesPrefix = "camera/v1/files/phone-scans/";
    private static readonly string[] Kinds = ["locked", "unidentified"];
    private static readonly JsonSerializerOptions SidecarJson = new() { WriteIndented = true };
    public const string UploadLimit = "training-captures";

    public static void MapTrainingCaptureEndpoints(this WebApplication app, TrainingBucket? bucket)
    {
        app.MapPost("/api/training-captures",
                (HttpContext http, ILoggerFactory logs, CancellationToken ct) => UploadAsync(http, bucket, logs, ct))
            .RequireAuthorization().RequireRateLimiting(UploadLimit);
    }

    private static async Task<IResult> UploadAsync(
        HttpContext http, TrainingBucket? bucket, ILoggerFactory logs, CancellationToken ct)
    {
        if (bucket is null) return Results.NotFound();

        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = MaxBodyBytes;
        TrainingCapture? capture;
        try
        {
            capture = await http.Request.ReadFromJsonAsync<TrainingCapture>(ct);
        }
        catch (Exception error) when (error is JsonException or BadHttpRequestException)
        {
            return Results.BadRequest(new { title = "The capture is not valid JSON or is too large." });
        }
        if (capture is null) return Results.BadRequest(new { title = "Empty capture." });
        if (Validate(capture) is { } problem) return Results.BadRequest(new { title = problem });

        byte[] image;
        try
        {
            image = Convert.FromBase64String(capture.ImageJpegBase64);
        }
        catch (FormatException)
        {
            return Results.BadRequest(new { title = "The image is not base64." });
        }
        if (image.Length is < 3 or > MaxImageBytes || image[0] != 0xFF || image[1] != 0xD8 || image[2] != 0xFF)
            return Results.BadRequest(new { title = "The image must be a JPEG under 2 MB." });

        var now = DateTime.UtcNow;
        var name = $"{now:yyyyMMdd-HHmmss-fff}-{capture.Kind}-{Guid.NewGuid().ToString("N")[..8]}";
        var folder = $"{FilesPrefix}{now:yyyy-MM-dd}/";
        var sidecar = JsonSerializer.SerializeToUtf8Bytes(new
        {
            SchemaVersion = 1,
            ImageFile = name + ".jpg",
            Source = capture.Source ?? "phone",
            UserId = http.User.FindFirstValue(ClaimTypes.NameIdentifier),
            CapturedUtc = now,
            capture.Kind,
            capture.ModelVersion,
            capture.ExtractorVersion,
            PredictedCorners = capture.Corners.Select(point => new { point.X, point.Y }),
            Candidates = capture.Candidates.Select(c => new { c.OracleId, c.Score, c.Prototype }),
            capture.PredictedOracleId,
            Status = "unreviewed",
            OracleId = (string?)null,
            ReviewedUtc = (DateTime?)null,
        }, SidecarJson);

        // The photo goes first: a sidecar without its photo would be an orphan, a photo without one is just unlabelled.
        await PutAsync(bucket, folder + name + ".jpg", image, "image/jpeg", ct);
        await PutAsync(bucket, folder + name + "._identity.json", sidecar, "application/json", ct);
        logs.CreateLogger("TrainingCaptures").LogInformation("Stored training capture {Name} ({Bytes} bytes)", name, image.Length);
        return Results.Ok(new { name });
    }

    // The Toolbox sync compares files by this SHA-256 metadata.
    private static async Task PutAsync(TrainingBucket bucket, string key, byte[] content, string contentType, CancellationToken ct)
    {
        using var stream = new MemoryStream(content, writable: false);
        var request = new PutObjectRequest { BucketName = bucket.Name, Key = key, InputStream = stream, ContentType = contentType };
        request.Metadata["deckino-sha256"] = Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();
        await bucket.Client.PutObjectAsync(request, ct);
    }

    private static string? Validate(TrainingCapture capture)
    {
        if (string.IsNullOrEmpty(capture.ImageJpegBase64)) return "The image is missing.";
        if (!Kinds.Contains(capture.Kind)) return "Kind must be locked or unidentified.";
        if (capture.ModelVersion is not { Length: > 0 and <= 100 } || capture.ExtractorVersion is { Length: > 100 })
            return "The model versions are missing or too long.";
        if (capture.Corners is not { Count: 4 } || capture.Corners.Any(p => !double.IsFinite(p.X) || !double.IsFinite(p.Y)
                || p.X is < 0 or > 1 || p.Y is < 0 or > 1))
            return "Corners must be four normalized points.";
        if (capture.Candidates is not { Count: > 0 and <= 10 } || capture.Candidates.Any(c =>
                !Guid.TryParse(c.OracleId, out _) || !double.IsFinite(c.Score) || c.Prototype < 0))
            return "Candidates must be 1 to 10 oracle IDs with scores.";
        if (capture.Source is not (null or "shared")) return "Source must be shared or absent.";
        if (capture.PredictedOracleId is not null && !Guid.TryParse(capture.PredictedOracleId, out _))
            return "The predicted oracle ID is not a GUID.";
        return null;
    }
}

public sealed record TrainingCapture(
    string ImageJpegBase64,
    string Kind,
    string ModelVersion,
    string? ExtractorVersion,
    List<CapturePoint> Corners,
    List<CaptureCandidate> Candidates,
    string? PredictedOracleId,
    string? Source = null);

public sealed record CapturePoint(double X, double Y);

public sealed record CaptureCandidate(string OracleId, double Score, int Prototype);

// The private Railway bucket (TrainingCaptures__Endpoint, __Bucket, __AccessKeyId, __SecretAccessKey): training
// captures go in, and the scanner models the Toolbox publishes come out (ModelEndpoints). One client for the app's
// lifetime, so requests reuse its connections; null when not configured.
public sealed record TrainingBucket(IAmazonS3 Client, string Name)
{
    public static TrainingBucket? From(IConfiguration configuration)
    {
        var settings = configuration.GetSection("TrainingCaptures");
        if (!new[] { "Endpoint", "Bucket", "AccessKeyId", "SecretAccessKey" }.All(name => !string.IsNullOrWhiteSpace(settings[name])))
            return null;
        var client = new AmazonS3Client(
            new BasicAWSCredentials(settings["AccessKeyId"], settings["SecretAccessKey"]),
            new AmazonS3Config
            {
                ServiceURL = settings["Endpoint"],
                ForcePathStyle = settings.GetValue("ForcePathStyle", true),
                AuthenticationRegion = settings["Region"] ?? "auto",
            });
        return new TrainingBucket(client, settings["Bucket"]!);
    }
}
