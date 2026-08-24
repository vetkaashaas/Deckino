using Dapper;
using Deckino.Tools.Data;
using Microsoft.Data.Sqlite;

namespace Deckino.Tools.Tests;

public sealed class ArtworkMigrationTests
{
    [Fact]
    public void ExistingVersionFourDatabaseAddsArtworkIdentityAndForcesUniqueArtworkResync()
    {
        var root = Path.Combine(Path.GetTempPath(), $"deckino-artwork-migration-{Guid.NewGuid():N}");
        var path = Path.Combine(root, "deckino.db");
        Directory.CreateDirectory(root);
        try
        {
            using (var connection = new SqliteConnection($"Data Source={path}"))
            {
                connection.Open();
                connection.Execute(
                    """
                    CREATE TABLE schema_version (version INTEGER NOT NULL);
                    INSERT INTO schema_version VALUES (4);
                    CREATE TABLE cards (scryfall_id TEXT PRIMARY KEY);
                    CREATE TABLE sync_state (bulk_type TEXT PRIMARY KEY, updated_at TEXT, synced_at TEXT);
                    INSERT INTO sync_state VALUES ('unique_artwork', 'old', 'old');
                    INSERT INTO sync_state VALUES ('oracle_cards', 'current', 'current');
                    """);
            }

            var database = new Database(path);
            database.Initialize();
            using var migrated = database.OpenConnection();
            var columns = migrated.Query<string>("SELECT name FROM pragma_table_info('cards')").ToHashSet();
            var indexes = migrated.Query<string>("SELECT name FROM pragma_index_list('cards')").ToHashSet();

            Assert.Contains("illustration_id", columns);
            Assert.Contains("ix_cards_illustration_id", indexes);
            Assert.Equal(5, migrated.ExecuteScalar<int>("SELECT MAX(version) FROM schema_version"));
            Assert.Equal(0, migrated.ExecuteScalar<int>(
                "SELECT COUNT(*) FROM sync_state WHERE bulk_type = 'unique_artwork'"));
            Assert.Equal(1, migrated.ExecuteScalar<int>(
                "SELECT COUNT(*) FROM sync_state WHERE bulk_type = 'oracle_cards'"));
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
