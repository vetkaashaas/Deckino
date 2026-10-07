using Deckino.Api.Accounts;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
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
if (app.Environment.IsDevelopment())
{
    // The account emails the log sender recorded for an address (how E2E tests follow emailed links).
    app.MapGet("/api/dev/account-emails", (string to, LogAccountEmails emails) => emails.SentTo(to));
    // Forces a full catalogue import now (waits for any sync already running).
    app.MapPost("/api/dev/catalogue/sync", (CatalogueSync sync, CancellationToken ct) => sync.RunAsync(force: true, ct));
}

// Unknown API routes are 404 ProblemDetails; everything else is the SPA.
app.Map("/api/{**rest}", () => Results.Problem(statusCode: StatusCodes.Status404NotFound));
app.MapFallbackToFile("index.html");

app.Run();
