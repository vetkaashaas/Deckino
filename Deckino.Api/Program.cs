using Deckino.Api.Accounts;
using Deckino.Api.Binders;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Deckino.Api.Decks;
using Deckino.Api.Import;
using Deckino.Api.Prices;
using Deckino.Api.Sharing;
using Deckino.Api.Wishlist;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Railway supplies the port to listen on.
if (Environment.GetEnvironmentVariable("PORT") is { } port)
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

builder.Services.AddDbContext<DeckinoDbContext>(options =>
    options
        .UseNpgsql(DatabaseConnection.Resolve(builder.Configuration),
            npgsql => npgsql.MigrationsHistoryTable("__ef_migrations_history"))
        .UseSnakeCaseNamingConvention());
builder.Services.AddProblemDetails();
builder.Services.AddHealthChecks().AddDbContextCheck<DeckinoDbContext>("database");

// Scryfall asks for an identifying User-Agent and an Accept header on every request.
builder.Services.AddHttpClient(CatalogueSync.HttpClientName, http =>
{
    http.DefaultRequestHeaders.UserAgent.ParseAdd("Deckino/1.0");
    http.DefaultRequestHeaders.Accept.ParseAdd("application/json;q=0.9,*/*;q=0.8");
});
builder.Services.AddSingleton<CatalogueSync>();
builder.Services.AddHostedService(services => services.GetRequiredService<CatalogueSync>());
builder.Services.AddAccounts();

// Railway's edge terminates HTTPS and tells the app who the client is in X-Real-IP (its documented header;
// X-Forwarded-For's hop count isn't documented) and the scheme in X-Forwarded-Proto. The rate limiter partitions
// by that IP. Railway's proxy address isn't fixed, so no known-proxy list.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.ForwardedForHeaderName = "X-Real-IP";
    options.ForwardLimit = 1;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

var app = builder.Build();
app.Services.GetRequiredService<AccountLinks>(); // fail at startup, not at the first registration, without App:BaseUrl

using (var scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<DeckinoDbContext>().Database.MigrateAsync();
}

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

app.MapHealthChecks("/api/health", new HealthCheckOptions
{
    ResponseWriter = (context, report) => context.Response.WriteAsJsonAsync(new
    {
        status = report.Status.ToString(),
        checks = report.Entries.ToDictionary(e => e.Key, e => e.Value.Status.ToString()),
    }),
});

app.MapCardEndpoints();
app.MapAccountEndpoints();
app.MapDeckEndpoints();
app.MapPublicDeckEndpoints();
app.MapBinderEndpoints();
app.MapWishlistEndpoints();
app.MapPriceEndpoints();
app.MapImportEndpoints();
app.MapSharePreviews();
if (app.Environment.IsDevelopment())
{
    // The account emails the log sender recorded for an address (how E2E tests follow emailed links).
    app.MapGet("/api/dev/account-emails", (string to, LogAccountEmails emails) => emails.SentTo(to));
    // Forces a full catalogue import now (waits for any sync already running).
    app.MapPost("/api/dev/catalogue/sync", (CatalogueSync sync, CancellationToken ct) => sync.RunAsync(force: true, ct));
    // Replaces a printing's price history before today (today's row is the sync's), since the fixture only has
    // today's prices. Whole history, not just these days: the E2E database outlives a run, and runs on other days
    // leave rows at other dates.
    app.MapPost("/api/dev/prices/{id:guid}", async (Guid id, List<PricePoint> points, DeckinoDbContext db, CancellationToken ct) =>
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var dates = points.Select(p => p.Date).ToList();
        await db.CardPriceSnapshots
            .Where(s => s.ScryfallId == id && s.Provider == PriceEndpoints.Provider && (s.Date < today || dates.Contains(s.Date)))
            .ExecuteDeleteAsync(ct);
        db.CardPriceSnapshots.AddRange(points.Select(p => new CardPriceSnapshot
        {
            ScryfallId = id, Provider = PriceEndpoints.Provider, Date = p.Date,
            Usd = p.Usd, UsdFoil = p.UsdFoil, UsdEtched = p.UsdEtched, Eur = p.Eur, EurFoil = p.EurFoil,
        }));
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    });
}

// Unknown API routes are 404 ProblemDetails; everything else is the SPA.
app.Map("/api/{**rest}", () => Results.Problem(statusCode: StatusCodes.Status404NotFound));
app.MapFallbackToFile("index.html");

app.Run();
