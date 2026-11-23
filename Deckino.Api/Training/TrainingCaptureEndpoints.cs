using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Deckino.Api.Accounts;
using Deckino.Api.Data;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Identity;

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
    private static readonly JsonSerializerOptions SidecarJson = new() { WriteIndented = true };
    public const string UploadLimit = "training-captures";

    public static void MapTrainingCaptureEndpoints(this WebApplication app, TrainingBucket? bucket)
    {
        app.MapPost("/api/training-captures",
                (HttpContext http, ILoggerFactory logs, CancellationToken ct) => UploadAsync(http, bucket, logs, ct))
            .RequireAuthorization().RequireRateLimiting(UploadLimit)
            .Accepts<TrainingCapture>("application/json") // read by hand, for its own size limit and answer
            .Produces<StoredCapture>();
        // Admins only (users.is_admin): photos with no card in them, taken on purpose with the app's no-card camera.
        // They arrive already labelled "no card", so the Toolbox's annotator and Identify Card never queue them.
        app.MapPost("/api/training-captures/no-card",
                (HttpContext http, UserManager<User> users, ILoggerFactory logs, CancellationToken ct) =>
                    UploadNoCardAsync(http, users, bucket, logs, ct))
            .RequireAuthorization().RequireRateLimiting(UploadLimit)
            .Accepts<NoCardCapture>("application/json")
            .Produces<StoredCapture>();
    }

    private static async Task<IResult> UploadNoCardAsync(
        HttpContext http, UserManager<User> users, TrainingBucket? bucket, ILoggerFactory logs, CancellationToken ct)
    {
        if (bucket is null) return Results.NotFound();
        if (await users.GetUserAsync(http.User) is not { IsAdmin: true }) return Results.Forbid();

        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = MaxBodyBytes;
        NoCardCapture? capture;
        try
        {
            capture = await http.Request.ReadFromJsonAsync<NoCardCapture>(ct);
        }
        catch (Exception error) when (error is JsonException or BadHttpRequestException)
        {
            return Results.BadRequest(new { title = "The capture is not valid JSON or is too large." });
        }
        if (string.IsNullOrEmpty(capture?.ImageJpegBase64)) return Results.BadRequest(new { title = "The image is missing." });
        byte[] image;
        try
        {
            image = Convert.FromBase64String(capture.ImageJpegBase64);
        }
        catch (FormatException)
        {
            return Results.BadRequest(new { title = "The image is not base64." });
        }
        if ((image.Length <= MaxImageBytes ? JpegSize(image) : null) is not { } size)
            return Results.BadRequest(new { title = "The image must be a JPEG under 2 MB." });
        var (width, height) = size;

        var now = DateTime.UtcNow;
        var name = $"{now:yyyyMMdd-HHmmss-fff}-nocard-{Guid.NewGuid().ToString("N")[..8]}";
        var folder = $"{FilesPrefix}{now:yyyy-MM-dd}/";
        // The annotation the Toolbox saves for "No card". Training splits photos by SourceGroup: each five minutes
        // (usually one spot) is its own group, so a day of no-card photos spreads over training, validation and test
        // instead of joining that day's card scans in one split. A photo the phone's card finder took for a card is
        // tagged (CaptureCondition is comma-separated tags), so training reports how it does on its own mistakes.
        var annotation = JsonSerializer.SerializeToUtf8Bytes(new
        {
            SchemaVersion = 1,
            DatasetVersion = "corners-v1",
            ImageFile = name + ".jpg",
            CardPresent = false,
            CornerOrder = new[] { "TopLeft", "TopRight", "BottomRight", "BottomLeft" },
            TopLeft = (object?)null,
            TopRight = (object?)null,
            BottomRight = (object?)null,
            BottomLeft = (object?)null,
            ImageWidth = width,
            ImageHeight = height,
            SourceGroup = $"no-card/{now:yyyy-MM-dd-HH}{now.Minute / 5 * 5:00}",
            CaptureCondition = capture.FinderMistake == true ? "finder-mistake" : null,
            Split = (string?)null,
            CornerConvention = (string?)null,
        }, SidecarJson);

        await PutAsync(bucket, folder + name + ".jpg", image, "image/jpeg", ct);
        await PutAsync(bucket, folder + name + "._annotations.json", annotation, "application/json", ct);
        logs.CreateLogger("TrainingCaptures").LogInformation("Stored no-card photo {Name} ({Bytes} bytes, finder mistake {Mistake})",
            name, image.Length, capture.FinderMistake == true);
        return Results.Ok(new StoredCapture(name));
    }

    /// A baseline or progressive JPEG's size from its frame header (SOFn), or null when it is not a JPEG.
    private static (int Width, int Height)? JpegSize(byte[] jpeg)
    {
        if (jpeg.Length < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8) return null;
        var at = 2;
        while (at + 9 < jpeg.Length)
        {
            if (jpeg[at] != 0xFF) return null;
            var marker = jpeg[at + 1];
            if (marker == 0xFF) { at++; continue; } // fill byte
            var length = (jpeg[at + 2] << 8) | jpeg[at + 3];
            // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
            if (marker is >= 0xC0 and <= 0xCF and not 0xC4 and not 0xC8 and not 0xCC)
            {
                int height = (jpeg[at + 5] << 8) | jpeg[at + 6], width = (jpeg[at + 7] << 8) | jpeg[at + 8];
                return width > 0 && height > 0 ? (width, height) : null;
            }
            if (length < 2) return null;
            at += 2 + length;
        }
        return null;
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
        var kind = capture.Kind!.Value.Code(); // the sidecar and the file name carry the code, as the Toolbox reads it
        var name = $"{now:yyyyMMdd-HHmmss-fff}-{kind}-{Guid.NewGuid().ToString("N")[..8]}";
        var folder = $"{FilesPrefix}{now:yyyy-MM-dd}/";
        var sidecar = JsonSerializer.SerializeToUtf8Bytes(new
        {
            SchemaVersion = 1,
            ImageFile = name + ".jpg",
            Source = capture.Source ?? "phone",
            UserId = http.User.FindFirstValue(ClaimTypes.NameIdentifier),
            CapturedUtc = now,
            Kind = kind,
            capture.ModelVersion,
            capture.ExtractorVersion,
            PredictedCorners = capture.Corners.Select(point => new { point.X, point.Y }),
            Candidates = capture.Candidates.Select(c => new { c.OracleId, c.Score, c.Prototype }),
            capture.PredictedOracleId,
            // Builds before the title reader send none: they only had the artwork model's embeddings.
            RecognitionMethod = (capture.RecognitionMethod ?? Data.RecognitionMethod.Embeddings).Code(),
            capture.TitleText,
            Status = "unreviewed",
            OracleId = (string?)null,
            ReviewedUtc = (DateTime?)null,
        }, SidecarJson);

        // The photo goes first: a sidecar without its photo would be an orphan, a photo without one is just unlabelled.
        await PutAsync(bucket, folder + name + ".jpg", image, "image/jpeg", ct);
        await PutAsync(bucket, folder + name + "._identity.json", sidecar, "application/json", ct);
        logs.CreateLogger("TrainingCaptures").LogInformation("Stored training capture {Name} ({Bytes} bytes)", name, image.Length);
        return Results.Ok(new StoredCapture(name));
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
        if (capture.Kind is null) return "Kind must be locked or unidentified.";
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
        if (capture.TitleText is { Length: > 100 }) return "TitleText is too long.";
        return null;
    }
}

public sealed record TrainingCapture(
    string ImageJpegBase64,
    CaptureKind? Kind,
    string ModelVersion,
    string? ExtractorVersion,
    List<CapturePoint> Corners,
    List<CaptureCandidate> Candidates,
    string? PredictedOracleId,
    string? Source = null,
    RecognitionMethod? RecognitionMethod = null, // how the phone found the card
    string? TitleText = null); // what the card's title read, when it was read

public sealed record CapturePoint(double X, double Y);

public sealed record NoCardCapture(
    string ImageJpegBase64,
    bool? FinderMistake = null); // sent by itself because the phone's card finder took it for a card

public sealed record StoredCapture(string Name); // the capture's file name in the bucket

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
