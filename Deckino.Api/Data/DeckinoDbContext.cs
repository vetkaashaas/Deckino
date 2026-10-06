using Deckino.Api.Catalogue;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Data;

// Npgsql generates client-side Guid keys as UUIDv7 (Guid.CreateVersion7) by default.
public class DeckinoDbContext(DbContextOptions<DeckinoDbContext> options) : DbContext(options)
{
    public DbSet<Card> Cards => Set<Card>();
    public DbSet<CatalogueSyncRun> CatalogueSyncRuns => Set<CatalogueSyncRun>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasPostgresExtension("pg_trgm");

        modelBuilder.Entity<Card>(card =>
        {
            card.Property(c => c.Id).ValueGeneratedNever(); // the Scryfall ID
            card.HasIndex(c => c.OracleId);
            card.HasIndex(c => c.SetCode);
            card.HasIndex(c => c.Name).HasMethod("gin").HasOperators("gin_trgm_ops");
            card.OwnsOne(c => c.Images, images => images.ToJson("images"));
            card.OwnsMany(c => c.Faces, faces =>
            {
                faces.ToJson("faces");
                faces.OwnsOne(f => f.Images);
            });
        });
    }
}
