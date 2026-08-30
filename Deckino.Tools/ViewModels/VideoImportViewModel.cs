using System.Diagnostics;
using System.Globalization;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Tools.Services;
using Microsoft.Win32;

namespace Deckino.Tools.ViewModels;

public sealed record VideoPresetOption(
    VideoFramePreset Value,
    string Name,
    int FramesPerSecond,
    string Description);

public partial class VideoImportViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly VideoFrameImportService _importer;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private VideoProbeResult? _probe;
    private CancellationTokenSource? _cancellation;

    public override string DisplayName => "Video Import";
    public override string Description =>
        "Turn phone footage into grouped, unannotated camera frames for the corner extraction dataset.";

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

    public bool CanConfigure => !IsBusy;

    public VideoImportViewModel(
        VideoFrameImportService importer,
        WorkspaceOperationCoordinator coordinator)
    {
        _importer = importer;
        _coordinator = coordinator;
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

    [RelayCommand(CanExecute = nameof(CanPickVideo))]
    private async Task PickVideoAsync()
    {
        var dialog = new OpenFileDialog
        {
            Title = "Select a phone video",
            Filter = "Phone videos|*.mp4;*.mov;*.m4v;*.avi;*.mkv;*.webm|All files|*.*",
            Multiselect = false,
            CheckFileExists = true,
        };
        if (dialog.ShowDialog() != true) return;

        try
        {
            IsBusy = true;
            ProgressPercent = 0;
            ProgressLabel = "Inspecting video…";
            Status = "Reading video metadata…";
            LastBatchPath = string.Empty;
            _probe = await _importer.ProbeAsync(dialog.FileName, CancellationToken.None);
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
            Status = "Extracting and importing video frames…";
            ProgressLabel = "Starting FFmpeg…";
            var progress = new Progress<VideoImportProgress>(value =>
            {
                ProgressPercent = value.Percent;
                ProgressLabel = $"{value.FramesWritten:N0} frames  ·  {value.Processed:mm\\:ss} processed";
            });
            VideoFrameImportResult result;
            using (await _coordinator.AcquireAsync("import video frames", _cancellation.Token))
            {
                result = await _importer.ImportAsync(
                    _probe, SelectedPreset.Value, progress, _cancellation.Token);
            }
            LastBatchPath = result.BatchRoot;
            ProgressPercent = 100;
            ProgressLabel = $"{result.ExtractedFrames:N0} frames imported";
            Status = $"Created {result.ExtractedFrames:N0} unannotated photos at {result.EffectiveFramesPerSecond:0.##} fps. Open Corner Annotator to label them.";
        }
        catch (OperationCanceledException)
        {
            ProgressPercent = 0;
            ProgressLabel = "Cancelled";
            Status = "Video import cancelled. The incomplete batch was removed.";
        }
        catch (Exception error)
        {
            ProgressPercent = 0;
            ProgressLabel = "Import failed";
            Status = error.Message;
        }
        finally
        {
            _cancellation?.Dispose();
            _cancellation = null;
            IsBusy = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanCancel))]
    private void Cancel() => _cancellation?.Cancel();

    [RelayCommand(CanExecute = nameof(CanOpenBatch))]
    private void OpenBatch()
    {
        if (!Directory.Exists(LastBatchPath)) return;
        Process.Start(new ProcessStartInfo(LastBatchPath) { UseShellExecute = true });
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

    private bool CanPickVideo() => !IsBusy;
    private bool CanExtract() => !IsBusy && _probe is not null && _importer.IsRuntimeAvailable;
    private bool CanCancel() => IsBusy && _cancellation is not null;
    private bool CanOpenBatch() => !IsBusy && Directory.Exists(LastBatchPath);

    private void NotifyCommands()
    {
        PickVideoCommand.NotifyCanExecuteChanged();
        ExtractCommand.NotifyCanExecuteChanged();
        CancelCommand.NotifyCanExecuteChanged();
        OpenBatchCommand.NotifyCanExecuteChanged();
    }
}
