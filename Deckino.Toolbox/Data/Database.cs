using System.IO;
using System.Reflection;
using Dapper;
using Microsoft.Data.Sqlite;

namespace Deckino.Toolbox.Data;

public sealed class Database
{
    private const string ResourcePrefix = "Deckino.Toolbox.Data.Schema.";

    private readonly string _dbPath;

    public Database(string dbPath)
    {
        _dbPath = dbPath;
    }

    public static string ResolveDefaultPath()
    {
        return Path.Combine(ResolveDataRoot(), "deckino.db");
    }

    public string DefaultPath => _dbPath;

    public static string ResolveDataRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
        {
            dir = dir.Parent;
        }
        var root = dir?.FullName ?? AppContext.BaseDirectory;
        return Path.Combine(root, "data");
    }

    public void Initialize()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_dbPath)!);
        using var connection = OpenConnection();
        connection.Execute(
            """
            CREATE TABLE IF NOT EXISTS schema_version (
              version INTEGER NOT NULL
            )
            """);
        var current = connection.ExecuteScalar<long>(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version");
        foreach (var (version, sql) in LoadMigrations().Where(m => m.Version > current))
        {
            using var transaction = connection.BeginTransaction();
            connection.Execute(sql, transaction: transaction);
            connection.Execute(
                "INSERT INTO schema_version (version) VALUES ($version)",
                new { version },
                transaction);
            transaction.Commit();
        }
    }

    public SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = _dbPath,
                Mode = SqliteOpenMode.ReadWriteCreate,
            }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;";
        command.ExecuteNonQuery();
        return connection;
    }

    private static IEnumerable<(int Version, string Sql)> LoadMigrations()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resources = assembly
            .GetManifestResourceNames()
            .Where(n => n.StartsWith(ResourcePrefix, StringComparison.Ordinal)
                        && n.EndsWith(".sql", StringComparison.Ordinal))
            .OrderBy(n => n, StringComparer.Ordinal);
        foreach (var name in resources)
        {
            using var stream = assembly.GetManifestResourceStream(name)!;
            using var reader = new StreamReader(stream);
            var fileName = name[ResourcePrefix.Length..];
            yield return (int.Parse(fileName.AsSpan(0, 3)), reader.ReadToEnd());
        }
    }
}
