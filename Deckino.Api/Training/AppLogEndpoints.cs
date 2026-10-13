using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;

namespace Deckino.Api.Training;

// Test builds of the app send their console output here while signed in. Each entry becomes one "AppLog" line in
// the API's own log, with the user's id, so Railway's log view (search "AppLog", a session id or a user id) shows what
// a tester's phone did.
public static class AppLogEndpoints
{
    private const long MaxBodyBytes = 512_000;
    private const int MaxEntries = 200;
    private const int MaxMessageLength = 4000;

    public static void MapAppLogEndpoints(this WebApplication app)
    {
        app.MapPost("/api/app-logs", (HttpContext http, ILoggerFactory logs, CancellationToken ct) =>
                UploadAsync(http, logs.CreateLogger("AppLog"), ct))
            .RequireAuthorization().RequireRateLimiting(TrainingCaptureEndpoints.UploadLimit);
    }

    private static async Task<IResult> UploadAsync(HttpContext http, ILogger log, CancellationToken ct)
    {
        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = MaxBodyBytes;
        AppLogBatch? batch;
        try
        {
            batch = await http.Request.ReadFromJsonAsync<AppLogBatch>(ct);
        }
        catch (Exception error) when (error is JsonException or BadHttpRequestException)
        {
            return Results.BadRequest(new { title = "The log batch is not valid JSON or is too large." });
        }
        if (batch is not { Entries.Count: > 0 and <= MaxEntries } || batch.Session is not { Length: > 0 and <= 64 }
            || batch.Device is { Length: > 300 })
            return Results.BadRequest(new { title = $"A batch needs a session and 1 to {MaxEntries} entries." });

        foreach (var entry in batch.Entries)
        {
            var level = entry.Level switch { "error" => LogLevel.Error, "warn" => LogLevel.Warning, _ => LogLevel.Information };
            var message = entry.Message is { Length: > MaxMessageLength } ? entry.Message[..MaxMessageLength] + "…" : entry.Message;
            log.Log(level, "AppLog {Session} {UserId} {Device} {ClientTime:O} {Message}", batch.Session,
                http.User.FindFirstValue(ClaimTypes.NameIdentifier), batch.Device, DateTimeOffset.FromUnixTimeMilliseconds(entry.Time), message);
        }
        return Results.Ok();
    }
}

public sealed record AppLogBatch(string Session, string? Device, List<AppLogEntry> Entries);

public sealed record AppLogEntry(long Time, string Level, string Message);
