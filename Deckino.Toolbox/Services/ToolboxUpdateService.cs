using System.IO;
using Velopack;
using Velopack.Logging;
using Velopack.Sources;

namespace Deckino.Toolbox.Services;

// The Toolbox updates itself from the dataset bucket. scripts/publish-tools.ps1 packs each release with Velopack and
// uploads it under toolbox/; an installed Toolbox (from its Setup.exe) checks there with the bucket connection saved on
// Dataset Sync, and the sidebar's update button downloads the release and then restarts into it (ShellViewModel).
// A downloaded update that was not restarted into installs at the next start (Velopack's auto-apply on startup).
// A development build (not installed) never checks.
public sealed class ToolboxUpdateService(ISyncCredentialStore credentials, IRemoteObjectStoreFactory stores)
{
    public const string Prefix = "toolbox/";

    private readonly UpdateManager _manager = new(new BucketSource(credentials, stores));

    public bool IsInstalled => _manager.IsInstalled;

    public string CurrentVersion => $"v{_manager.CurrentVersion}";

    public bool IsBucketConnected => credentials.Load() is not null;

    public Task<UpdateInfo?> CheckAsync() => _manager.CheckForUpdatesAsync();

    public Task DownloadAsync(UpdateInfo update, Action<int> reportPercent, CancellationToken cancellationToken) =>
        _manager.DownloadUpdatesAsync(update, reportPercent, cancellationToken);

    /// <summary>
    /// Installs the downloaded update and starts the new version once the Toolbox has quit. The caller quits it the
    /// normal way, so the window's shutdown stops the Python helpers, which would otherwise hold the install folder.
    /// </summary>
    public void InstallAfterExit(UpdateInfo update) =>
        _manager.WaitExitThenApplyUpdates(update.TargetFullRelease, silent: false, restart: true, []);

    // The release feed and packages, read with the bucket connection instead of a public URL: the bucket is private.
    private sealed class BucketSource(ISyncCredentialStore credentials, IRemoteObjectStoreFactory stores) : IUpdateSource
    {
        public async Task<VelopackAssetFeed> GetReleaseFeed(
            IVelopackLogger logger, string? appId, string channel, Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
        {
            var feed = Path.GetTempFileName();
            try
            {
                await DownloadAsync($"releases.{channel}.json", feed, _ => { }, CancellationToken.None);
                return VelopackAssetFeed.FromJson(await File.ReadAllTextAsync(feed));
            }
            finally
            {
                File.Delete(feed);
            }
        }

        public Task DownloadReleaseEntry(
            IVelopackLogger logger, VelopackAsset releaseEntry, string localFile, Action<int> progress,
            CancellationToken cancelToken = default) =>
            DownloadAsync(releaseEntry.FileName, localFile, progress, cancelToken);

        private async Task DownloadAsync(
            string name, string destination, Action<int> reportPercent, CancellationToken cancellationToken)
        {
            await using var store = stores.Create(credentials.Load()
                ?? throw new InvalidOperationException("Connect the Railway bucket first (Dataset Sync)."));
            await store.DownloadAsync(Prefix + name, destination, reportPercent, cancellationToken);
        }
    }
}
