using System.Collections.ObjectModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Deckino.Toolbox.Platform;
using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.ViewModels;

// Every artwork model generation scored on the same frozen real photos (ArtworkBenchmarkService), plus a
// photo-by-photo comparison of two of them.
public partial class ModelBenchmarksViewModel : WorkspaceViewModel, IRefreshableWorkspace
{
    private readonly ArtworkBenchmarkService _benchmarks;
    private readonly CameraAnnotationStore _store;
    private readonly WorkspaceOperationCoordinator _coordinator;
    private IReadOnlyList<ArtworkBenchmarkModel> _models = [];
    private CancellationTokenSource? _thumbnailLoad;

    public override string DisplayName => "Model Benchmarks";
    public override string Description => "Compare artwork model generations on the same frozen real photos of never-trained cards.";

    public ObservableCollection<string> Benchmarks { get; } = [];
    public ObservableCollection<BenchmarkModelRow> Rows { get; } = [];
    public ObservableCollection<string> ScoredModels { get; } = [];
    public ObservableCollection<BenchmarkPhotoRow> Comparison { get; } = [];

    [ObservableProperty] public partial string? SelectedBenchmark { get; set; }
    [ObservableProperty] public partial string? BaselineModel { get; set; }
    [ObservableProperty] public partial string? CandidateModel { get; set; }
    [ObservableProperty] public partial bool ChangedOnly { get; set; } = true;
    [ObservableProperty] public partial string ComparisonSummary { get; private set; } = string.Empty;
    // What the comparison list says when it is empty: nothing to compare yet, or nothing changed.
    [ObservableProperty] public partial string EmptyComparison { get; private set; } = string.Empty;
    [ObservableProperty] public partial string Status { get; private set; } = "Refresh to load benchmark results.";
    [ObservableProperty] public partial bool IsBusy { get; private set; }

    public ModelBenchmarksViewModel(ArtworkBenchmarkService benchmarks, CameraAnnotationStore store,
        WorkspaceOperationCoordinator coordinator)
    {
        _benchmarks = benchmarks;
        _store = store;
        _coordinator = coordinator;
    }

    [RelayCommand]
    public Task RefreshAsync()
    {
        var wanted = SelectedBenchmark;
        _rebuilding = true;
        try
        {
            Benchmarks.Clear();
            foreach (var name in _benchmarks.BenchmarkNames()) Benchmarks.Add(name);
            SelectedBenchmark = wanted is not null && Benchmarks.Contains(wanted) ? wanted : Benchmarks.LastOrDefault();
        }
        finally
        {
            _rebuilding = false;
        }
        Reload();
        if (Benchmarks.Count == 0) Status = $"No frozen benchmarks in {_benchmarks.BenchmarksRoot}.";
        return Task.CompletedTask;
    }

    // While the picker lists are rebuilt, their TwoWay bindings may push null into the selections; ignore that.
    private bool _rebuilding;

    partial void OnSelectedBenchmarkChanged(string? value)
    {
        if (!_rebuilding) Reload();
    }

    partial void OnBaselineModelChanged(string? value)
    {
        if (!_rebuilding) BuildComparison();
    }

    partial void OnCandidateModelChanged(string? value)
    {
        if (!_rebuilding) BuildComparison();
    }

    partial void OnChangedOnlyChanged(bool value) => BuildComparison();

    // Scores every model that has a phone export but no result for this benchmark yet.
    [RelayCommand]
    private Task RunMissingAsync() => RunAsync(_models.Where(model => model.HasPhoneExport && model.Result is null)
        .Select(model => model.ModelVersion).ToArray());

    private async Task RunAsync(IReadOnlyList<string> modelVersions)
    {
        if (IsBusy || SelectedBenchmark is not { } benchmark) return;
        if (modelVersions.Count == 0)
        {
            Status = "Every model with a phone export is already benchmarked.";
            return;
        }
        string outcome;
        try
        {
            IsBusy = true;
            using (await _coordinator.AcquireAsync("benchmark artwork models", CancellationToken.None))
            {
                foreach (var (model, index) in modelVersions.Select((model, index) => (model, index)))
                {
                    var prefix = $"Benchmarking {model} ({index + 1}/{modelVersions.Count})";
                    Status = prefix + "…";
                    await _benchmarks.RunAsync(model, benchmark,
                        (done, total) => MainThread.BeginInvokeOnMainThread(() => Status = $"{prefix} · {done}/{total} photos"),
                        CancellationToken.None);
                }
            }
            outcome = $"Benchmarked {modelVersions.Count:N0} model(s) on {benchmark}.";
        }
        catch (Exception error)
        {
            outcome = error.Message;
        }
        finally
        {
            IsBusy = false;
        }
        Reload();
        // After Reload, which writes its own summary line.
        Status = outcome;
    }

    private void Reload()
    {
        var (baseline, candidate) = (BaselineModel, CandidateModel);
        _rebuilding = true;
        try
        {
            Rows.Clear();
            ScoredModels.Clear();
            try
            {
                _models = SelectedBenchmark is { } benchmark ? _benchmarks.Models(benchmark) : [];
            }
            catch (Exception error)
            {
                _models = [];
                Status = $"Could not read benchmark results: {error.Message}";
            }
            ArtworkBenchmarkSummary? previous = null;
            foreach (var model in _models)
            {
                Rows.Add(new BenchmarkModelRow(model, previous));
                if (model.Result is { } result)
                {
                    ScoredModels.Add(model.ModelVersion);
                    previous = result.Summary;
                }
            }
            // Keep the chosen pair; otherwise the newest model against the one before it.
            BaselineModel = baseline is not null && ScoredModels.Contains(baseline)
                ? baseline
                : ScoredModels.Count > 1 ? ScoredModels[^2] : ScoredModels.FirstOrDefault();
            CandidateModel = candidate is not null && ScoredModels.Contains(candidate) ? candidate : ScoredModels.LastOrDefault();
        }
        finally
        {
            _rebuilding = false;
        }
        BuildComparison();
        if (!IsBusy && SelectedBenchmark is not null)
        {
            // The newest run saw the current labels.
            var changed = _models.LastOrDefault(model => model.Result is not null)?.Result!.Summary.LabelsChanged ?? 0;
            Status = $"{ScoredModels.Count:N0} of {_models.Count:N0} models benchmarked on {SelectedBenchmark}."
                + (changed > 0
                    ? $" {changed:N0} benchmark photo label(s) were corrected after freezing; scores still use the frozen labels."
                    : string.Empty);
        }
    }

    private void BuildComparison()
    {
        Comparison.Clear();
        var baseline = _models.FirstOrDefault(model => model.ModelVersion == BaselineModel)?.Result;
        var candidate = _models.FirstOrDefault(model => model.ModelVersion == CandidateModel)?.Result;
        if (baseline is null || candidate is null)
        {
            ComparisonSummary = string.Empty;
            EmptyComparison = ScoredModels.Count < 2
                ? "Benchmark at least two models to compare them."
                : "Pick two benchmarked models.";
            return;
        }
        EmptyComparison = ChangedOnly ? "No photos changed between these two models." : "These results have no photos.";
        var before = baseline.Photos.ToDictionary(photo => photo.Photo);
        var rows = candidate.Photos
            .Where(photo => before.ContainsKey(photo.Photo))
            .Select(photo => new BenchmarkPhotoRow(before[photo.Photo], photo))
            .ToArray();
        var fixedCount = rows.Count(row => row.Change == "Fixed");
        var brokeCount = rows.Count(row => row.Change == "Broke");
        ComparisonSummary = $"{fixedCount:N0} fixed · {brokeCount:N0} broke · "
            + $"{rows.Count(row => row.Change == "Same" && row.CandidateRank == 1):N0} right in both · "
            + $"{rows.Count(row => row.Change == "Same" && row.CandidateRank != 1):N0} wrong in both";
        // Broken first, then fixed, then the rest; by card within each.
        foreach (var row in rows.Where(row => !ChangedOnly || row.Change != "Same")
                     .OrderBy(row => row.Change switch { "Broke" => 0, "Fixed" => 1, _ => 2 })
                     .ThenBy(row => row.CardName, StringComparer.OrdinalIgnoreCase))
            Comparison.Add(row);
        LoadThumbnails([.. Comparison]);
    }

    private void LoadThumbnails(BenchmarkPhotoRow[] rows)
    {
        _thumbnailLoad?.Cancel();
        var cancellation = _thumbnailLoad = new CancellationTokenSource();
        _ = Task.Run(() =>
        {
            foreach (var row in rows)
            {
                if (cancellation.IsCancellationRequested) return;
                try
                {
                    var source = ImageSourceFactory.FromBytesUnlocked(
                        _store.LoadThumbnail(Path.Combine(_store.ImportsRoot, row.Photo)));
                    MainThread.BeginInvokeOnMainThread(() => row.Thumbnail = source);
                }
                // System.Drawing reports an unreadable image as OutOfMemoryException.
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException
                                                  or OutOfMemoryException)
                {
                    // Not synced to this PC, or unreadable: leave the tile blank.
                }
            }
        });
    }
}

public sealed class BenchmarkModelRow
{
    public BenchmarkModelRow(ArtworkBenchmarkModel model, ArtworkBenchmarkSummary? previous)
    {
        ModelVersion = model.ModelVersion;
        CanRun = model.HasPhoneExport;
        var summary = model.Result?.Summary;
        HasResult = summary is not null;
        Top1 = Percent(summary?.Top1);
        CardTop1 = Percent(summary?.CardTop1);
        Top5 = Percent(summary?.Top5);
        Accepted = Percent(summary?.Accepted);
        AcceptedWrong = Percent(summary?.AcceptedWrong);
        MedianScore = summary?.MedianScoreRight?.ToString("0.000") ?? "–";
        MedianMargin = summary?.MedianMarginRight?.ToString("0.000") ?? "–";
        if (summary is not null && previous is not null)
        {
            var delta = (summary.CardTop1 - previous.CardTop1) * 100;
            Delta = $"{delta:+0.0;-0.0;±0.0} pts";
            Trend = delta > 0.05 ? "up" : delta < -0.05 ? "down" : string.Empty;
        }
        else
        {
            Delta = summary is null ? (CanRun ? "Not run" : "No phone export") : "Baseline";
        }
    }

    public string ModelVersion { get; }
    public bool CanRun { get; }
    public bool HasResult { get; }
    public string Top1 { get; }
    public string CardTop1 { get; }
    public string Top5 { get; }
    public string Accepted { get; }
    public string AcceptedWrong { get; }
    public string MedianScore { get; }
    public string MedianMargin { get; }
    // Card top-1 against the previous benchmarked model.
    public string Delta { get; }
    public string Trend { get; } = string.Empty;

    private static string Percent(double? value) => value is { } number ? $"{number * 100:0.0}%" : "–";
}

public sealed partial class BenchmarkPhotoRow : ObservableObject
{
    public BenchmarkPhotoRow(ArtworkBenchmarkPhoto baseline, ArtworkBenchmarkPhoto candidate)
    {
        Photo = candidate.Photo;
        CardName = candidate.CardName;
        CandidateRank = candidate.Rank;
        Baseline = Describe(baseline);
        Candidate = Describe(candidate);
        Change = (baseline.Rank == 1, candidate.Rank == 1) switch
        {
            (false, true) => "Fixed",
            (true, false) => "Broke",
            _ => "Same",
        };
    }

    public string Photo { get; }
    public string CardName { get; }
    public int? CandidateRank { get; }
    public string Baseline { get; }
    public string Candidate { get; }
    public string Change { get; }
    [ObservableProperty] public partial ImageSource? Thumbnail { get; set; }

    // "#1 · 0.812" when right; otherwise the rank of the true card and what won instead.
    private static string Describe(ArtworkBenchmarkPhoto photo)
    {
        var top = photo.Candidates.FirstOrDefault();
        var rank = photo.Rank is { } value ? $"#{value}" : "not in top 5";
        var accepted = photo.Accepted ? "accepted" : "rejected";
        return photo.Rank == 1
            ? $"#1 · {photo.Score:0.000} · {accepted}"
            : $"{rank} · top: {top?.CardName ?? "–"} {photo.Score:0.000} · {accepted}";
    }
}
