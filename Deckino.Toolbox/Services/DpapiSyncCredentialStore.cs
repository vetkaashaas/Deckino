using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.IO;

namespace Deckino.Toolbox.Services;

public sealed class DpapiSyncCredentialStore : ISyncCredentialStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Deckino.CameraDatasetSync.v1");
    private readonly string _path;

    public DpapiSyncCredentialStore(string? path = null)
    {
        _path = path ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Deckino",
            "dataset-sync.credentials");
    }

    public DatasetSyncCredentials? Load()
    {
        if (!File.Exists(_path)) return null;
        try
        {
            var encrypted = File.ReadAllBytes(_path);
            var clear = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<DatasetSyncCredentials>(clear);
        }
        catch (Exception error) when (error is CryptographicException or IOException or JsonException)
        {
            return null;
        }
    }

    public void Save(DatasetSyncCredentials credentials)
    {
        ArgumentNullException.ThrowIfNull(credentials);
        if (!credentials.IsComplete) throw new ArgumentException("The dataset sync credentials are incomplete.", nameof(credentials));
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var clear = JsonSerializer.SerializeToUtf8Bytes(credentials);
        var encrypted = ProtectedData.Protect(clear, Entropy, DataProtectionScope.CurrentUser);
        WriteAtomic(encrypted);
    }

    public void Clear()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }

    private void WriteAtomic(byte[] content)
    {
        var temporaryPath = _path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllBytes(temporaryPath, content);
            File.Move(temporaryPath, _path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }
}
