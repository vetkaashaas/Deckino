using Npgsql;

namespace Deckino.Api.Data;

public static class DatabaseConnection
{
    // Railway provides DATABASE_URL (postgresql://user:pass@host:port/db); locally we use ConnectionStrings:Deckino.
    public static string Resolve(IConfiguration configuration)
    {
        var url = configuration["DATABASE_URL"];
        if (string.IsNullOrEmpty(url))
        {
            return configuration.GetConnectionString("Deckino")
                ?? throw new InvalidOperationException("Set DATABASE_URL or ConnectionStrings:Deckino.");
        }

        var uri = new Uri(url);
        var credentials = uri.UserInfo.Split(':', 2);
        return new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = uri.AbsolutePath.TrimStart('/'),
            Username = Uri.UnescapeDataString(credentials[0]),
            Password = credentials.Length > 1 ? Uri.UnescapeDataString(credentials[1]) : null,
        }.ConnectionString;
    }
}
