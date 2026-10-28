using Deckino.Api.Accounts;
using Deckino.Api.Catalogue;
using Deckino.Api.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Admin;

// For accounts with users.is_admin set (by hand in the database): the website's Admin page.
public static class AdminEndpoints
{
    // 1 from an "Import now" until its run ends: RunAsync takes the sync's gate only once its task starts.
    private static int _starting;

    public static void MapAdminEndpoints(this WebApplication app)
    {
        var admin = app.MapGroup("/api/admin").RequireAuthorization().AddEndpointFilter(async (context, next) =>
        {
            var users = context.HttpContext.RequestServices.GetRequiredService<UserManager<User>>();
            return await users.GetUserAsync(context.HttpContext.User) is { IsAdmin: true }
                ? await next(context)
                : TypedResults.Forbid();
        });
        admin.MapGet("/catalogue", GetCatalogueAsync);
        admin.MapPost("/catalogue/sync", StartSync);
    }

    private static async Task<CatalogueStatus> GetCatalogueAsync(DeckinoDbContext db, CatalogueSync sync, CancellationToken ct)
    {
        var runs = await db.CatalogueSyncRuns.OrderByDescending(r => r.StartedAt).Take(10)
            .Select(r => new CatalogueRun(r.StartedAt, r.FinishedAt, r.BulkUpdatedAt, r.CardsRead, r.Inserted, r.Updated, r.Error))
            .ToListAsync(ct);
        return new CatalogueStatus(sync.IsRunning || Volatile.Read(ref _starting) == 1, sync.LastCheckedAt, runs);
    }

    // A full import takes minutes, longer than a request should: it runs on, and the page polls GetCatalogueAsync.
    private static IResult StartSync(CatalogueSync sync, IHostApplicationLifetime lifetime, ILogger<CatalogueSync> logger)
    {
        if (sync.IsRunning || Interlocked.Exchange(ref _starting, 1) == 1)
            return TypedResults.Problem("An import is already running.", statusCode: StatusCodes.Status409Conflict);
        _ = Task.Run(async () =>
        {
            try
            {
                await sync.RunAsync(force: true, lifetime.ApplicationStopping);
            }
            catch (Exception e) when (!lifetime.ApplicationStopping.IsCancellationRequested)
            {
                logger.LogError(e, "Catalogue sync started by an admin failed"); // the run records the error too
            }
            finally
            {
                Volatile.Write(ref _starting, 0);
            }
        });
        return TypedResults.NoContent();
    }
}

public record CatalogueStatus(bool Running, DateTimeOffset? LastCheckedAt, List<CatalogueRun> Runs);

public record CatalogueRun(
    DateTimeOffset StartedAt, DateTimeOffset? FinishedAt, DateTimeOffset BulkUpdatedAt, int CardsRead, int Inserted, int Updated,
    string? Error);
