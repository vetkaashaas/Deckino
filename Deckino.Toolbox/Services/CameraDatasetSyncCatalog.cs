using Microsoft.Data.Sqlite;
using System.IO;

namespace Deckino.Toolbox.Services;

internal enum DatasetSyncOperation
{
    Upload = 1,
    Delete = 2,
}

internal sealed record PendingDatasetOperation(
    long Id,
    string ObjectKey,
    string RelativePath,
    DatasetSyncOperation Operation,
    string? Sha256,
    int Attempts,
    DateTimeOffset? NextAttemptUtc);

internal sealed class CameraDatasetSyncCatalog
{
    private readonly string _connectionString;
    private readonly object _gate = new();

    public CameraDatasetSyncCatalog(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = false,
        }.ToString();
        Initialize();
    }

    public void Queue(string key, string relativePath, DatasetSyncOperation operation, string? sha256)
        => QueueMany([(key, relativePath, operation, sha256)]);

    public void QueueMany(
        IReadOnlyList<(string Key, string RelativePath, DatasetSyncOperation Operation, string? Sha256)> operations)
    {
        if (operations.Count == 0) return;
        lock (_gate)
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO outbox(object_key, relative_path, operation, sha256, attempts, next_attempt_utc, last_error)
                VALUES($key, $path, $operation, $sha, 0, NULL, NULL)
                ON CONFLICT(object_key) DO UPDATE SET
                    relative_path = excluded.relative_path,
                    operation = excluded.operation,
                    sha256 = excluded.sha256,
                    attempts = 0,
                    next_attempt_utc = NULL,
                    last_error = NULL;
                """;
            var keyParameter = command.Parameters.Add("$key", SqliteType.Text);
            var pathParameter = command.Parameters.Add("$path", SqliteType.Text);
            var operationParameter = command.Parameters.Add("$operation", SqliteType.Integer);
            var shaParameter = command.Parameters.Add("$sha", SqliteType.Text);
            foreach (var operation in operations)
            {
                keyParameter.Value = operation.Key;
                pathParameter.Value = operation.RelativePath;
                operationParameter.Value = (int)operation.Operation;
                shaParameter.Value = (object?)operation.Sha256 ?? DBNull.Value;
                command.ExecuteNonQuery();
            }
            transaction.Commit();
        }
    }

    public IReadOnlyList<PendingDatasetOperation> Pending(bool includeDeferred)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = includeDeferred
                ? "SELECT id, object_key, relative_path, operation, sha256, attempts, next_attempt_utc FROM outbox ORDER BY id;"
                : "SELECT id, object_key, relative_path, operation, sha256, attempts, next_attempt_utc FROM outbox WHERE next_attempt_utc IS NULL OR next_attempt_utc <= $now ORDER BY id;";
            if (!includeDeferred) command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
            using var reader = command.ExecuteReader();
            var result = new List<PendingDatasetOperation>();
            while (reader.Read())
            {
                result.Add(new PendingDatasetOperation(
                    reader.GetInt64(0), reader.GetString(1), reader.GetString(2),
                    (DatasetSyncOperation)reader.GetInt32(3), reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.GetInt32(5), reader.IsDBNull(6) ? null : DateTimeOffset.Parse(reader.GetString(6))));
            }
            return result;
        }
    }

    public bool Complete(PendingDatasetOperation operation, string? synchronizedSha)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            using var deleteCommand = connection.CreateCommand();
            deleteCommand.Transaction = transaction;
            deleteCommand.CommandText = "DELETE FROM outbox WHERE id = $id AND operation = $operation;";
            deleteCommand.Parameters.AddWithValue("$id", operation.Id);
            deleteCommand.Parameters.AddWithValue("$operation", (int)operation.Operation);
            if (deleteCommand.ExecuteNonQuery() == 0)
            {
                transaction.Rollback();
                return false;
            }
            if (operation.Operation == DatasetSyncOperation.Upload && synchronizedSha is not null)
                SetObjectCore(connection, operation.ObjectKey, synchronizedSha, transaction);
            else
                DeleteObjectCore(connection, operation.ObjectKey, transaction);
            transaction.Commit();
            return true;
        }
    }

    public void Fail(PendingDatasetOperation operation, string error)
    {
        var attempts = operation.Attempts + 1;
        var delay = TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, Math.Min(attempts, 8))));
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE outbox SET attempts = $attempts, next_attempt_utc = $next, last_error = $error WHERE id = $id;";
            command.Parameters.AddWithValue("$attempts", attempts);
            command.Parameters.AddWithValue("$next", DateTimeOffset.UtcNow.Add(delay).ToString("O"));
            command.Parameters.AddWithValue("$error", SanitizeError(error));
            command.Parameters.AddWithValue("$id", operation.Id);
            command.ExecuteNonQuery();
        }
    }

    public string? SynchronizedSha(string key)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT sha256 FROM objects WHERE object_key = $key;";
            command.Parameters.AddWithValue("$key", key);
            return command.ExecuteScalar() as string;
        }
    }

    public IReadOnlyList<string> SynchronizedObjectKeys()
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT object_key FROM objects WHERE sha256 NOT LIKE 'deleted:%' ORDER BY object_key;";
            using var reader = command.ExecuteReader();
            var result = new List<string>();
            while (reader.Read()) result.Add(reader.GetString(0));
            return result;
        }
    }

    public void SetSynchronized(string key, string sha256)
    {
        lock (_gate)
        {
            using var connection = Open();
            SetObjectCore(connection, key, sha256);
        }
    }

    public void AddConflict(DatasetSyncConflict conflict)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO conflicts(object_key, relative_path, remote_copy_path, local_sha256, remote_sha256, created_utc)
                VALUES($key, $relative, $copy, $local, $remote, $created)
                ON CONFLICT(object_key) DO UPDATE SET remote_copy_path = excluded.remote_copy_path,
                    local_sha256 = excluded.local_sha256, remote_sha256 = excluded.remote_sha256,
                    created_utc = excluded.created_utc;
                """;
            command.Parameters.AddWithValue("$key", conflict.ObjectKey);
            command.Parameters.AddWithValue("$relative", conflict.RelativePath);
            command.Parameters.AddWithValue("$copy", conflict.RemoteCopyPath);
            command.Parameters.AddWithValue("$local", conflict.LocalSha256);
            command.Parameters.AddWithValue("$remote", conflict.RemoteSha256);
            command.Parameters.AddWithValue("$created", conflict.CreatedUtc.ToString("O"));
            command.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<DatasetSyncConflict> Conflicts()
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT object_key, relative_path, remote_copy_path, local_sha256, remote_sha256, created_utc FROM conflicts ORDER BY created_utc;";
            using var reader = command.ExecuteReader();
            var result = new List<DatasetSyncConflict>();
            while (reader.Read())
                result.Add(new DatasetSyncConflict(reader.GetString(0), reader.GetString(1), reader.GetString(2),
                    reader.GetString(3), reader.GetString(4), DateTimeOffset.Parse(reader.GetString(5))));
            return result;
        }
    }

    public void RemoveConflict(string key)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM conflicts WHERE object_key = $key;";
            command.Parameters.AddWithValue("$key", key);
            command.ExecuteNonQuery();
        }
    }

    public DateTimeOffset? LastSuccessfulSyncUtc
    {
        get
        {
            var value = GetMeta("last_successful_sync_utc");
            return DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
        }
        set => SetMeta("last_successful_sync_utc", value?.ToString("O"));
    }

    public (int Pending, int Failed) Counts()
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*), COALESCE(SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END), 0) FROM outbox;";
            using var reader = command.ExecuteReader();
            reader.Read();
            return (reader.GetInt32(0), reader.GetInt32(1));
        }
    }

    private void Initialize()
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS outbox(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    object_key TEXT NOT NULL UNIQUE,
                    relative_path TEXT NOT NULL,
                    operation INTEGER NOT NULL,
                    sha256 TEXT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_utc TEXT NULL,
                    last_error TEXT NULL);
                CREATE TABLE IF NOT EXISTS objects(object_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS conflicts(
                    object_key TEXT PRIMARY KEY,
                    relative_path TEXT NOT NULL,
                    remote_copy_path TEXT NOT NULL,
                    local_sha256 TEXT NOT NULL,
                    remote_sha256 TEXT NOT NULL,
                    created_utc TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NULL);
                -- Caches that let a sync skip work whose answer has not changed: a remote object's hash by its
                -- ETag and size, a tombstone's contents by its ETag, a local file's hash by its size and write time.
                CREATE TABLE IF NOT EXISTS remote_hashes(object_key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tombstone_cache(tombstone_key TEXT PRIMARY KEY, etag TEXT NOT NULL, content BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS local_hashes(relative_path TEXT PRIMARY KEY, length INTEGER NOT NULL, write_ticks INTEGER NOT NULL, sha256 TEXT NOT NULL);
                """;
            command.ExecuteNonQuery();
        }
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    private static void SetObjectCore(
        SqliteConnection connection,
        string key,
        string sha256,
        SqliteTransaction? transaction = null)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO objects(object_key, sha256) VALUES($key, $sha) ON CONFLICT(object_key) DO UPDATE SET sha256 = excluded.sha256;";
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$sha", sha256);
        command.ExecuteNonQuery();
    }

    private static void DeleteObjectCore(
        SqliteConnection connection,
        string key,
        SqliteTransaction? transaction = null)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "DELETE FROM objects WHERE object_key = $key;";
        command.Parameters.AddWithValue("$key", key);
        command.ExecuteNonQuery();
    }

    private string? GetMeta(string key)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $key;";
            command.Parameters.AddWithValue("$key", key);
            return command.ExecuteScalar() as string;
        }
    }

    private void SetMeta(string key, string? value)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO meta(key, value) VALUES($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value;";
            command.Parameters.AddWithValue("$key", key);
            command.Parameters.AddWithValue("$value", (object?)value ?? DBNull.Value);
            command.ExecuteNonQuery();
        }
    }

    public Dictionary<string, (string ETag, long Size, string Sha256)> RemoteHashes() =>
        ReadAll("SELECT object_key, etag, size, sha256 FROM remote_hashes;",
            reader => (reader.GetString(1), reader.GetInt64(2), reader.GetString(3)));

    // Brings the cache to the latest listing: objects that are gone drop out, only new or changed rows are written.
    public void SetRemoteHashes(
        Dictionary<string, (string ETag, long Size, string Sha256)> previous, IEnumerable<RemoteDatasetObject> objects) =>
        Merge("remote_hashes", "object_key",
            "INSERT INTO remote_hashes(object_key, etag, size, sha256) VALUES($a, $b, $c, $d) "
            + "ON CONFLICT(object_key) DO UPDATE SET etag = excluded.etag, size = excluded.size, sha256 = excluded.sha256;",
            previous,
            objects.Where(item => item.ETag is { Length: > 0 } && item.Sha256 is { Length: > 0 })
                .ToDictionary(item => item.Key, item => (item.ETag!, item.Size, item.Sha256!), StringComparer.Ordinal),
            (key, value) => [key, value.Item1, value.Item2, value.Item3]);

    public Dictionary<string, (string ETag, byte[] Content)> CachedTombstones() =>
        ReadAll("SELECT tombstone_key, etag, content FROM tombstone_cache;",
            reader => (reader.GetString(1), (byte[])reader.GetValue(2)));

    public void SetCachedTombstones(
        Dictionary<string, (string ETag, byte[] Content)> previous, Dictionary<string, (string ETag, byte[] Content)> current) =>
        Merge("tombstone_cache", "tombstone_key",
            "INSERT INTO tombstone_cache(tombstone_key, etag, content) VALUES($a, $b, $c) "
            + "ON CONFLICT(tombstone_key) DO UPDATE SET etag = excluded.etag, content = excluded.content;",
            previous, current, (key, value) => [key, value.ETag, value.Content]);

    public Dictionary<string, (long Length, long WriteTicks, string Sha256)> LocalHashes() =>
        ReadAll("SELECT relative_path, length, write_ticks, sha256 FROM local_hashes;",
            reader => (reader.GetInt64(1), reader.GetInt64(2), reader.GetString(3)));

    public void SetLocalHashes(
        Dictionary<string, (long Length, long WriteTicks, string Sha256)> previous,
        Dictionary<string, (long Length, long WriteTicks, string Sha256)> current) =>
        Merge("local_hashes", "relative_path",
            "INSERT INTO local_hashes(relative_path, length, write_ticks, sha256) VALUES($a, $b, $c, $d) "
            + "ON CONFLICT(relative_path) DO UPDATE SET length = excluded.length, write_ticks = excluded.write_ticks, sha256 = excluded.sha256;",
            previous, current, (key, value) => [key, value.Length, value.WriteTicks, value.Sha256]);

    private Dictionary<string, T> ReadAll<T>(string sql, Func<SqliteDataReader, T> read)
    {
        lock (_gate)
        {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            using var reader = command.ExecuteReader();
            var result = new Dictionary<string, T>(StringComparer.Ordinal);
            while (reader.Read()) result[reader.GetString(0)] = read(reader);
            return result;
        }
    }

    // Deletes rows whose key is no longer current and upserts rows that are new or changed; an unchanged cache
    // costs no writes. table and keyColumn are always constants from this class.
    private void Merge<T>(
        string table, string keyColumn, string upsert,
        Dictionary<string, T> previous, Dictionary<string, T> current, Func<string, T, object[]> row)
    {
        var removed = previous.Keys.Where(key => !current.ContainsKey(key)).ToList();
        var changed = current.Where(item => !previous.TryGetValue(item.Key, out var old)
            || !EqualityComparer<T>.Default.Equals(old, item.Value)).ToList();
        if (removed.Count == 0 && changed.Count == 0) return;
        var names = new[] { "$a", "$b", "$c", "$d" };
        lock (_gate)
        {
            using var connection = Open();
            using var transaction = connection.BeginTransaction();
            using (var delete = connection.CreateCommand())
            {
                delete.Transaction = transaction;
                delete.CommandText = $"DELETE FROM {table} WHERE {keyColumn} = $a;";
                var key = delete.Parameters.Add("$a", SqliteType.Text);
                foreach (var item in removed)
                {
                    key.Value = item;
                    delete.ExecuteNonQuery();
                }
            }
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = upsert;
            foreach (var item in changed)
            {
                insert.Parameters.Clear();
                var values = row(item.Key, item.Value);
                for (var index = 0; index < values.Length; index++) insert.Parameters.AddWithValue(names[index], values[index]);
                insert.ExecuteNonQuery();
            }
            transaction.Commit();
        }
    }

    private static string SanitizeError(string error) => error.Length <= 1000 ? error : error[..1000];
}
