using System.Globalization;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

public sealed record VideoPresetOption(
    VideoFramePreset Value,
    string Name,
    int FramesPerSecond,
    string Description);

public partial class VideoImportViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly VideoFrameImportService _importer;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private readonly IDesktopService _desktop;
    private VideoProbeResult? _probe;
    private StagedVideoFrames? _staged;
    private CancellationTokenSource? _cancellation;

    public override string DisplayName => "Video Import";
    public override string Description =>
        "Turn phone footage into camera frames for the corner extraction dataset. Review the frames, then add the good ones to the Photo Library.";

    public IReadOnlyList<VideoPresetOption> PresetOptions { get; } =
    [
        new(VideoFramePreset.Fewer, "Fewer", 5, "A lighter annotation queue"),
        new(VideoFramePreset.Automatic, "Automatic", 10, "Recommended for 60 fps footage"),
        new(VideoFramePreset.More, "More", 15, "Dense motion and lighting coverage"),
    ];

    [ObservableProperty] public partial VideoPresetOption SelectedPreset { get; set; }
    [ObservableProperty] public partial string SelectedVideoPath { get; private set; } = string.Empty;
    [ObservableProperty] public partial string SelectedVideoName { get; private set; } = "No video selected";
    [ObservableProperty] public partial string VideoDetails { get; private set; } = "Choose a phone video to inspect its duration and frame rate.";
    [ObservableProperty] public partial string EstimateLabel { get; private set; } = "No frame estimate available";
    [ObservableProperty] public partial string RuntimeStatus { get; private set; } = string.Empty;
    [ObservableProperty] public partial string Status { get; private set; } = "Select a video to begin.";
    [ObservableProperty] public partial string ProgressLabel { get; private set; } = "Waiting";
    [ObservableProperty] public partial double ProgressPercent { get; private set; }
    [ObservableProperty] public partial bool IsBusy { get; private set; }
    [ObservableProperty] public partial string LastBatchPath { get; private set; } = string.Empty;
    // The frames waiting for review, by name, in ReviewFolder: names alone keep a long video's snapshot small.
    // Which are left out stays in the page until "Add to library".
    [ObservableProperty] public partial IReadOnlyList<string> ReviewFrames { get; private set; } = [];
    // New for every extraction, so it also tells the page a review from the next one.
    [ObservableProperty] public partial string ReviewFolder { get; private set; } = string.Empty;

    public bool CanConfigure => !IsBusy && _staged is null;

    public VideoImportViewModel(
        VideoFrameImportService importer,
        WorkspaceOperationCoordinator coordinator,
        IDesktopService desktop)
    {
        _importer = importer;
        _coordinator = coordinator;
        _desktop = desktop;
        SelectedPreset = PresetOptions[1];
        RuntimeStatus = importer.RuntimeStatus;
    }

    public Task RefreshAsync()
    {
        RuntimeStatus = _importer.RuntimeStatus;
        if (!_importer.IsRuntimeAvailable)
            Status = RuntimeStatus;
        NotifyCommands();
        return Task.CompletedTask;
    }

    // The page passes no path and gets the file dialog; the E2E run, which has no dialog, passes one.
    [RelayCommand(CanExecute = nameof(CanPickVideo))]
    private async Task PickVideoAsync(string? path)
    {
        var selectedPath = path ?? await _desktop.PickFileAsync(
            "Select a phone video",
            [".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);
        if (selectedPath is null) return;

        try
        {
            IsBusy = true;
            ProgressPercent = 0;
            ProgressLabel = "Inspecting video…";
            Status = "Reading video metadata…";
            LastBatchPath = string.Empty;
            _probe = await _importer.ProbeAsync(selectedPath, CancellationToken.None);
            SelectedVideoPath = _probe.SourcePath;
            SelectedVideoName = Path.GetFileName(_probe.SourcePath);
            VideoDetails = string.Create(CultureInfo.InvariantCulture,
                $"{_probe.Width:N0} × {_probe.Height:N0}  ·  {_probe.Duration:mm\\:ss}  ·  {_probe.SourceFramesPerSecond:0.##} fps  ·  {_probe.Codec.ToUpperInvariant()}");
            UpdateEstimate();
            ProgressLabel = "Ready to extract";
            Status = "Video ready. Choose a sampling preset and extract the frames.";
        }
        catch (Exception error)
        {
            _probe = null;
            SelectedVideoPath = string.Empty;
            SelectedVideoName = "No usable video selected";
            VideoDetails = "The selected file could not be inspected.";
            EstimateLabel = "No frame estimate available";
            ProgressLabel = "Inspection failed";
            Status = error.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanExtract))]
    private async Task ExtractAsync()
    {
        if (_probe is null) return;
        _cancellation = new CancellationTokenSource();
        try
        {
            IsBusy = true;
            ProgressPercent = 0;
            LastBatchPath = string.Empty;
            Status = "Extracting video frames…";
            ProgressLabel = "Starting FFmpeg…";
            var progress = new Progress<VideoImportProgress>(value =>
            {
                ProgressPercent = value.Percent;
                ProgressLabel = $"{value.FramesWritten:N0} frames  ·  {value.Processed:mm\\:ss} processed";
            });
            using (await _coordinator.AcquireAsync("extract video frames", _cancellation.Token))
            {
                _staged = await _importer.ExtractAsync(_probe, SelectedPreset.Value, progress, _cancellation.Token);
            }
            ReviewFolder = Path.Combine(_staged.Root, _staged.Folder);
            ReviewFrames = _staged.Frames.Select(frame => Path.GetFileName(frame)).ToArray();
            ProgressPercent = 100;
            ProgressLabel = $"{_staged.Frames.Count:N0} frames to review";
            Status = "Untick the frames you don't want, then add the rest to the library.";
        }
        catch (OperationCanceledException)
        {
            ProgressPercent = 0;
            ProgressLabel = "Cancelled";
            Status = "Video import cancelled. The extracted frames were removed.";
        }
        catch (Exception error)
        {
            ProgressPercent = 0;
            ProgressLabel = "Extraction failed";
            Status = error.Message;
        }
        finally
        {
            _cancellation?.Dispose();
            _cancellation = null;
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(IsReviewing))]
    private async Task AddToLibraryAsync(string[]? leftOut)
    {
        if (_staged is not { } staged) return;
        try
        {
            IsBusy = true;
            Status = "Adding the frames to the library…";
            VideoFrameImportResult result;
            using (await _coordinator.AcquireAsync("add video frames", CancellationToken.None))
            {
                result = await Task.Run(() => _importer.AddToLibrary(staged, leftOut ?? []));
            }
            EndReview();
            LastBatchPath = result.BatchRoot;
            var frameNames = staged.Frames.Select(frame => Path.GetFileName(frame));
            var dropped = frameNames.Intersect(leftOut ?? [], StringComparer.OrdinalIgnoreCase).Count();
            ProgressLabel = $"{result.ExtractedFrames:N0} frames added";
            Status = $"Added {result.ExtractedFrames:N0} unannotated photos to the library" +
                (dropped > 0 ? $" ({dropped:N0} left out)." : ".") +
                " Open Corner Annotator to label them.";
        }
        catch (Exception error)
        {
            Status = error.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(IsReviewing))]
    private async Task DiscardAsync()
    {
        if (_staged is not { } staged) return;
        if (!await _desktop.ConfirmAsync(
                "Discard frames",
                $"Delete all {staged.Frames.Count:N0} extracted frames? Nothing is added to the library.",
                "Discard frames")) return;
        // The dialog doesn't make the page busy: Add may have ended this review meanwhile.
        if (_staged != staged) return;
        try
        {
            IsBusy = true;
            Status = "Deleting the extracted frames…";
            using (await _coordinator.AcquireAsync("discard video frames", CancellationToken.None))
            {
                await Task.Run(() => _importer.Discard(staged));
            }
            Status = "The extracted frames were deleted. Choose a preset and extract again, or select another video.";
            EndDiscard();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Some may be gone already, so the review can't go on; the next extraction clears the rest.
            Status = $"Some frames could not be deleted yet ({error.Message}); the next extraction clears them.";
            EndDiscard();
        }
        catch (Exception error)
        {
            // Nothing was deleted (another operation was running, say): the review stays.
            Status = error.Message;
        }
        finally
        {
            IsBusy = false;
        }

        void EndDiscard()
        {
            EndReview();
            ProgressPercent = 0;
            ProgressLabel = "Discarded";
        }
    }

    private void EndReview()
    {
        _staged = null;
        ReviewFrames = [];
        ReviewFolder = string.Empty;
        OnPropertyChanged(nameof(CanConfigure));
        NotifyCommands();
    }

    [RelayCommand(CanExecute = nameof(CanCancel))]
    private void Cancel() => _cancellation?.Cancel();

    [RelayCommand(CanExecute = nameof(CanOpenBatch))]
    private void OpenBatch()
    {
        if (!Directory.Exists(LastBatchPath)) return;
        _desktop.OpenFolder(LastBatchPath);
    }

    partial void OnSelectedPresetChanged(VideoPresetOption value) => UpdateEstimate();

    partial void OnIsBusyChanged(bool value)
    {
        OnPropertyChanged(nameof(CanConfigure));
        NotifyCommands();
    }

    partial void OnLastBatchPathChanged(string value) => OpenBatchCommand.NotifyCanExecuteChanged();

    private void UpdateEstimate()
    {
        if (_probe is null)
        {
            EstimateLabel = "No frame estimate available";
            ExtractCommand.NotifyCanExecuteChanged();
            return;
        }
        var effective = VideoFrameImportService.EffectiveFramesPerSecond(_probe, SelectedPreset.Value);
        var estimate = VideoFrameImportService.EstimateFrameCount(_probe, SelectedPreset.Value);
        EstimateLabel = effective < SelectedPreset.FramesPerSecond
            ? $"About {estimate:N0} photos at the source limit of {effective:0.##} fps"
            : $"About {estimate:N0} photos at {effective:0.##} fps";
        ExtractCommand.NotifyCanExecuteChanged();
    }

    private bool CanPickVideo() => CanConfigure;
    private bool CanExtract() => CanConfigure && _probe is not null && _importer.IsRuntimeAvailable;
    private bool IsReviewing() => !IsBusy && _staged is not null;
    private bool CanCancel() => IsBusy && _cancellation is not null;
    private bool CanOpenBatch() => !IsBusy && Directory.Exists(LastBatchPath);

    private void NotifyCommands()
    {
        PickVideoCommand.NotifyCanExecuteChanged();
        ExtractCommand.NotifyCanExecuteChanged();
        CancelCommand.NotifyCanExecuteChanged();
        OpenBatchCommand.NotifyCanExecuteChanged();
        AddToLibraryCommand.NotifyCanExecuteChanged();
        DiscardCommand.NotifyCanExecuteChanged();
    }
}
