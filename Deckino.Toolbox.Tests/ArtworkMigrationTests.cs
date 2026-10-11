using Dapper;
using Deckino.Toolbox.Data;
using Microsoft.Data.Sqlite;

namespace Deckino.Toolbox.Tests;

public sealed class ArtworkMigrationTests
{
    [Fact]
    public void ExistingVersionFourDatabaseMovesToPerFaceCardImagesAndForcesUniqueArtworkResync()
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
                    CREATE TABLE cards (scryfall_id TEXT PRIMARY KEY, art_crop_uri TEXT);
                    CREATE TABLE art_downloads (scryfall_id TEXT PRIMARY KEY);
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
            Assert.DoesNotContain("art_crop_uri", columns);
            Assert.Equal(7, migrated.ExecuteScalar<int>("SELECT MAX(version) FROM schema_version"));
            var tables = migrated.Query<string>("SELECT name FROM sqlite_master WHERE type = 'table'").ToHashSet();
            Assert.DoesNotContain("art_downloads", tables);
            Assert.DoesNotContain("extraction_full_card_assets", tables);
            Assert.Contains("sync_runs", tables);
            var imageColumns = migrated.Query<string>("SELECT name FROM pragma_table_info('card_images')").ToHashSet();
            Assert.Contains("face_index", imageColumns);
            Assert.Contains("illustration_id", imageColumns);
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
