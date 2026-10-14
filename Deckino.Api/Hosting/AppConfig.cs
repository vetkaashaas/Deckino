namespace Deckino.Api.Hosting;

// What the mobile app needs to know before anything else.
public static class AppConfig
{
    public const string VersionHeader = "X-Deckino-App-Version";

    // The store app and the side-by-side preview build (scripts/build-android-release.ps1).
    private static readonly string[] AndroidPackages = ["com.deckino.app", "com.deckino.app.preview"];

    public static void MapAppConfig(this WebApplication app)
    {
        // Older apps show "Update Deckino". Raised (Railway variable App__MinimumVersion) only when an endpoint an
        // old app uses is finally removed.
        app.MapGet("/api/app/config", (IConfiguration configuration) =>
            new AppConfigResponse(configuration["App:MinimumVersion"] ?? "0.0.0"));

        // Android App Links: the app may open deckino.com links when it is signed with one of these keys (Railway
        // variable App__AndroidCertFingerprints, SHA-256 fingerprints separated by commas). None set: no app may.
        app.MapGet("/.well-known/assetlinks.json", (IConfiguration configuration) =>
        {
            var fingerprints = (configuration["App:AndroidCertFingerprints"] ?? "")
                .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            return fingerprints.Length == 0
                ? Results.Json(Array.Empty<object>())
                : Results.Json(AndroidPackages.Select(package => new
                {
                    relation = new[] { "delegate_permission/common.handle_all_urls" },
                    target = new { @namespace = "android_app", package_name = package, sha256_cert_fingerprints = fingerprints },
                }));
        });

        // The app's version on every log line of its requests (@AppVersion:…), to tell which builds still call what.
        var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Deckino.Api.App");
        app.Use(async (http, next) =>
        {
            if (http.Request.Headers[VersionHeader] is [{ Length: > 0 and <= 32 } version])
            {
                using (logger.BeginScope(new Dictionary<string, object> { ["AppVersion"] = version }))
                {
                    await next(http);
                }
            }
            else
            {
                await next(http);
            }
        });
    }
}

public record AppConfigResponse(string MinimumVersion);
