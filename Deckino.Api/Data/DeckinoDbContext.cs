using Deckino.Api.Accounts;
using Deckino.Api.Catalogue;
using Deckino.Api.Decks;
using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Data;

// Npgsql generates client-side Guid keys as UUIDv7 (Guid.CreateVersion7) by default.
// IdentityUserContext: users, claims, logins and tokens, without Identity's role tables (Deckino has no roles).
public class DeckinoDbContext(DbContextOptions<DeckinoDbContext> options)
    : IdentityUserContext<User, Guid>(options), IDataProtectionKeyContext
{
    public DbSet<Card> Cards => Set<Card>();
    public DbSet<CatalogueSyncRun> CatalogueSyncRuns => Set<CatalogueSyncRun>();
    public DbSet<Deck> Decks => Set<Deck>();

    // Encrypt login cookies and email tokens; stored here so they survive redeploys.
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.HasPostgresExtension("pg_trgm");

        modelBuilder.Entity<User>().ToTable("users");
        modelBuilder.Entity<IdentityUserClaim<Guid>>().ToTable("user_claims");
        modelBuilder.Entity<IdentityUserLogin<Guid>>().ToTable("user_logins");
        modelBuilder.Entity<IdentityUserToken<Guid>>().ToTable("user_tokens");

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

        modelBuilder.Entity<Deck>(deck =>
        {
            deck.HasOne<User>().WithMany().HasForeignKey(d => d.OwnerId).OnDelete(DeleteBehavior.Cascade);
            deck.HasIndex(d => new { d.OwnerId, d.UpdatedAt });
            deck.Property(d => d.Name).HasMaxLength(100);
            // {"commander": [{"scryfallId": …, "quantity": 1, "finish": "nonfoil"}], "mainboard": […], "sideboard": […]}
            deck.OwnsOne(d => d.Cards, cards =>
            {
                cards.ToJson("cards");
                foreach (var section in new[] { nameof(DeckCards.Commander), nameof(DeckCards.Mainboard), nameof(DeckCards.Sideboard) })
                {
                    cards.OwnsMany<DeckEntry>(section, entry =>
                    {
                        entry.HasJsonPropertyName(section.ToLowerInvariant());
                        entry.Property(e => e.ScryfallId).HasJsonPropertyName("scryfallId");
                        entry.Property(e => e.Quantity).HasJsonPropertyName("quantity");
                        entry.Property(e => e.Finish).HasJsonPropertyName("finish");
                    });
                }
            });
        });
    }
}
