using Microsoft.EntityFrameworkCore;

namespace Deckino.Api.Data;

// Npgsql generates client-side Guid keys as UUIDv7 (Guid.CreateVersion7) by default.
public class DeckinoDbContext(DbContextOptions<DeckinoDbContext> options) : DbContext(options)
{
}
