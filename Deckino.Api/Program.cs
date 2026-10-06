using Deckino.Api.Data;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Railway supplies the port to listen on.
if (Environment.GetEnvironmentVariable("PORT") is { } port)
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

builder.Services.AddDbContext<DeckinoDbContext>(options =>
    options.UseNpgsql(DatabaseConnection.Resolve(builder.Configuration)));
builder.Services.AddProblemDetails();
builder.Services.AddHealthChecks().AddDbContextCheck<DeckinoDbContext>("database");

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<DeckinoDbContext>().Database.MigrateAsync();
}

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapHealthChecks("/api/health", new HealthCheckOptions
{
    ResponseWriter = (context, report) => context.Response.WriteAsJsonAsync(new
    {
        status = report.Status.ToString(),
        checks = report.Entries.ToDictionary(e => e.Key, e => e.Value.Status.ToString()),
    }),
});

// Unknown API routes are 404 ProblemDetails; everything else is the SPA.
app.Map("/api/{**rest}", () => Results.Problem(statusCode: StatusCodes.Status404NotFound));
app.MapFallbackToFile("index.html");

app.Run();
