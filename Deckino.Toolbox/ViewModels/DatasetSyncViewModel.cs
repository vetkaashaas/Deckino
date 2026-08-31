using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Services;
using Deckino.Toolbox.Platform;

namespace Deckino.Toolbox.ViewModels;

public partial class DatasetSyncViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly ICameraDatasetSyncService _sync;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly IDesktopService _desktop;

    public override string DisplayName => "Dataset Sync";
    public override string Description =>
        "Keep camera photos and corner annotations local while replicating them to a private Railway bucket.";

    public ObservableCollection<DatasetSyncConflict> Conflicts { get; } = [];

    [ObservableProperty] public partial string Endpoint { get; set; } = "https://storage.railway.app";
    [ObservableProperty] public partial string Bucket { get; set; } = string.Empty;
    [ObservableProperty] public partial string Region { get; set; } = "auto";
    [ObservableProperty] public partial bool ForcePathStyle { get; set; }
    [ObservableProperty] public partial string AccessKeyId { get; set; } = string.Empty;
    [ObservableProperty] public partial string SecretAccessKey { get; set; } = string.Empty;
    [ObservableProperty] public partial DatasetSyncConflict? SelectedConflict { get; set; }
    [ObservableProperty] public partial string Status { get; private set; } = "Dataset sync is not configured.";
    [ObservableProperty] public partial string LastSyncLabel { get; private set; } = "Never";
    [ObservableProperty] public partial int LocalFiles { get; private set; }
    [ObservableProperty] public partial int RemoteFiles { get; private set; }
    [ObservableProperty] public partial int PendingUploads { get; private set; }
    [ObservableProperty] public partial int FailedOperations { get; private set; }
    [ObservableProperty] public partial bool IsConfigured { get; private set; }
    [ObservableProperty] public partial bool IsBusy { get; private set; }
    [ObservableProperty] public partial bool IsSyncRunning { get; private set; }
    [ObservableProperty] public partial bool SafeToSwitch { get; private set; }

    public string SafetyLabel => IsSyncRunning
        ? "SYNC IN PROGRESS"
        : SafeToSwitch ? "SAFE TO SWITCH COMPUTERS" : "WAIT BEFORE SWITCHING";

    public DatasetSyncViewModel(
        ICameraDatasetSyncService sync,
        WorkspaceOperationCoordinator coordinator,
        IDesktopService desktop)
    {
        _sync = sync;
        _coordinator = coordinator;
        _desktop = desktop;
        LoadStoredCredentials();
        _sync.StateChanged += OnSyncStateChanged;
        ApplySnapshot();
    }

    public Task RefreshAsync()
    {
        ApplySnapshot();
        return Task.CompletedTask;
    }

    [RelayCommand(CanExecute = nameof(CanSaveConnection))]
    private async Task SaveConnectionAsync()
    {
        try
        {
            IsBusy = true;
            Status = "Testing the private Railway bucket connection…";
            var credentials = BuildCredentials();
            await _sync.TestConnectionAsync(credentials, CancellationToken.None);
            _sync.SaveCredentials(credentials);
            SecretAccessKey = string.Empty;
            Status = "Connection verified and stored securely for this Windows user.";
            ApplySnapshot();
        }
        catch (Exception error)
        {
            Status = $"Connection failed: {SafeMessage(error)}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanSync))]
    private async Task SyncNowAsync()
    {
        try
        {
            IsBusy = true;
            using (await _coordinator.AcquireAsync("synchronize the camera dataset", CancellationToken.None))
            {
                var result = await _sync.SyncNowAsync(CancellationToken.None);
                Status = result.Errors.Count > 0
                    ? $"Sync finished with {result.Errors.Count:N0} errors."
                    : $"Sync complete: {result.Uploaded:N0} uploaded, {result.Downloaded:N0} downloaded, "
                      + $"{result.Deleted:N0} deleted, {result.Conflicts:N0} conflicts.";
            }
        }
        catch (Exception error)
        {
            Status = $"Sync failed: {SafeMessage(error)}";
        }
        finally
        {
            IsBusy = false;
            ApplySnapshot();
        }
    }

    [RelayCommand(CanExecute = nameof(CanResolveConflict))]
    private async Task KeepLocalAsync()
    {
        if (SelectedConflict is null) return;
        await ResolveConflictAsync(() => _sync.KeepLocalAsync(SelectedConflict.ObjectKey, CancellationToken.None));
    }

    [RelayCommand(CanExecute = nameof(CanResolveConflict))]
    private async Task KeepRemoteAsync()
    {
        if (SelectedConflict is null) return;
        await ResolveConflictAsync(() => _sync.KeepRemoteAsync(SelectedConflict.ObjectKey, CancellationToken.None));
    }

    private async Task ResolveConflictAsync(Func<Task> resolve)
    {
        try
        {
            IsBusy = true;
            using (await _coordinator.AcquireAsync("resolve a dataset conflict", CancellationToken.None))
                await resolve();
            Status = "Conflict resolved.";
        }
        catch (Exception error)
        {
            Status = $"Could not resolve the conflict: {SafeMessage(error)}";
        }
        finally
        {
            IsBusy = false;
            ApplySnapshot();
        }
    }

    private DatasetSyncCredentials BuildCredentials()
    {
        var stored = _sync.LoadCredentials();
        var secret = string.IsNullOrEmpty(SecretAccessKey) ? stored?.SecretAccessKey ?? string.Empty : SecretAccessKey;
        var credentials = new DatasetSyncCredentials(
            Endpoint.Trim(), Bucket.Trim(), Region.Trim(), ForcePathStyle, AccessKeyId.Trim(), secret);
        if (!credentials.IsComplete)
            throw new InvalidOperationException("Endpoint, bucket, region, access key, and secret key are required.");
        return credentials;
    }

    private void LoadStoredCredentials()
    {
        var credentials = _sync.LoadCredentials();
        if (credentials is null) return;
        Endpoint = credentials.Endpoint;
        Bucket = credentials.Bucket;
        Region = credentials.Region;
        ForcePathStyle = credentials.ForcePathStyle;
        AccessKeyId = credentials.AccessKeyId;
    }

    private void OnSyncStateChanged(object? sender, EventArgs e)
    {
        _desktop.BeginInvoke(ApplySnapshot);
    }

    private void ApplySnapshot()
    {
        var snapshot = _sync.GetSnapshot();
        IsConfigured = snapshot.IsConfigured;
        IsSyncRunning = snapshot.IsRunning;
        if (!IsBusy || snapshot.IsRunning) Status = snapshot.Status;
        LocalFiles = snapshot.LocalFiles;
        RemoteFiles = snapshot.RemoteFiles;
        PendingUploads = snapshot.PendingUploads;
        FailedOperations = snapshot.FailedOperations;
        SafeToSwitch = snapshot.SafeToSwitch;
        LastSyncLabel = snapshot.LastSuccessfulSyncUtc?.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") ?? "Never";
        Conflicts.Clear();
        foreach (var conflict in _sync.GetConflicts()) Conflicts.Add(conflict);
        SelectedConflict ??= Conflicts.FirstOrDefault();
        if (SelectedConflict is not null && Conflicts.All(item => item.ObjectKey != SelectedConflict.ObjectKey))
            SelectedConflict = Conflicts.FirstOrDefault();
        OnPropertyChanged(nameof(SafetyLabel));
        NotifyCommands();
    }

    private string SafeMessage(Exception error)
    {
        var message = error.Message
            .Replace("SecretAccessKey", "credential", StringComparison.OrdinalIgnoreCase)
            .Replace("AccessKey", "credential", StringComparison.OrdinalIgnoreCase);
        var stored = _sync.LoadCredentials();
        foreach (var secret in new[] { SecretAccessKey, AccessKeyId, stored?.SecretAccessKey, stored?.AccessKeyId })
            if (!string.IsNullOrEmpty(secret))
                message = message.Replace(secret, "[redacted]", StringComparison.Ordinal);
        return message;
    }

    private bool CanSaveConnection() => !IsBusy;
    private bool CanSync() => !IsBusy && IsConfigured;
    private bool CanResolveConflict() => !IsBusy && SelectedConflict is not null;

    private void NotifyCommands()
    {
        SaveConnectionCommand.NotifyCanExecuteChanged();
        SyncNowCommand.NotifyCanExecuteChanged();
        KeepLocalCommand.NotifyCanExecuteChanged();
        KeepRemoteCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsBusyChanged(bool value) => NotifyCommands();
    partial void OnSelectedConflictChanged(DatasetSyncConflict? value) => NotifyCommands();
}
