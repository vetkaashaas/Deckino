namespace Deckino.Api.Hosting;

// What the mobile app needs to know before anything else.
public static class AppConfig
{
    public const string VersionHeader = "X-Deckino-App-Version";

    public static void MapAppConfig(this WebApplication app)
    {
        // Older apps show "Update Deckino". Raised (Railway variable App__MinimumVersion) only when an endpoint an
        // old app uses is finally removed.
        app.MapGet("/api/app/config", (IConfiguration configuration) =>
            new AppConfigResponse(configuration["App:MinimumVersion"] ?? "0.0.0"));

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
