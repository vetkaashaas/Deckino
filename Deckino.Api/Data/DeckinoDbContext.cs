using Deckino.Api.Accounts;
using Deckino.Api.Binders;
using Deckino.Api.Catalogue;
using Deckino.Api.Decks;
using Deckino.Api.Prices;
using Deckino.Api.Wishlist;
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
    public DbSet<Binder> Binders => Set<Binder>();
    public DbSet<BinderCard> BinderCards => Set<BinderCard>();
    public DbSet<WantedCard> WantedCards => Set<WantedCard>();
    public DbSet<CardPriceSnapshot> CardPriceSnapshots => Set<CardPriceSnapshot>();

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
            deck.HasIndex(d => d.Name).HasMethod("gin").HasOperators("gin_trgm_ops"); // public deck search
            deck.HasIndex(d => d.UpdatedAt).HasFilter("is_public"); // public decks, newest first
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

        modelBuilder.Entity<Binder>(binder =>
        {
            binder.HasOne<User>().WithMany().HasForeignKey(b => b.OwnerId).OnDelete(DeleteBehavior.Cascade);
            binder.HasIndex(b => new { b.OwnerId, b.UpdatedAt });
            binder.Property(b => b.Name).HasMaxLength(100);
        });

        modelBuilder.Entity<BinderCard>(card =>
        {
            card.HasOne<Binder>().WithMany().HasForeignKey(c => c.BinderId).OnDelete(DeleteBehavior.Cascade);
            card.HasOne<Card>().WithMany().HasForeignKey(c => c.ScryfallId).OnDelete(DeleteBehavior.Restrict); // catalogue rows are never deleted
            card.HasIndex(c => new { c.BinderId, c.CreatedAt });
            card.Property(c => c.Condition).HasMaxLength(3);
            card.Property(c => c.Finish).HasMaxLength(7);
            card.Property(c => c.Language).HasMaxLength(3);
            card.Property(c => c.Notes).HasMaxLength(500);
        });

        modelBuilder.Entity<WantedCard>(wanted =>
        {
            wanted.HasOne<User>().WithMany().HasForeignKey(w => w.OwnerId).OnDelete(DeleteBehavior.Cascade);
            wanted.HasOne<Card>().WithMany().HasForeignKey(w => w.ScryfallId).OnDelete(DeleteBehavior.Restrict);
            wanted.HasIndex(w => new { w.OwnerId, w.ScryfallId }).IsUnique();
        });

        // No foreign key to cards: written in bulk, and catalogue rows are never deleted anyway.
        modelBuilder.Entity<CardPriceSnapshot>(snapshot =>
        {
            snapshot.HasKey(s => new { s.ScryfallId, s.Provider, s.Date });
            snapshot.Property(s => s.Provider).HasMaxLength(20);
            snapshot.HasIndex(s => s.Date); // the daily clean-up
        });
    }
}
