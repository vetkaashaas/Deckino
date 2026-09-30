using System.ComponentModel;
using Deckino.Toolbox.Controls;
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Views;

public partial class DatasetSyncView : ContentView
{
    private DatasetSyncViewModel? _viewModel;

    public DatasetSyncView()
    {
        InitializeComponent();
        Responsive.Watch(this, Responsive.Stack, stacked =>
        {
            TwoColumnLayout.Apply(Panels, ConflictsCard, stacked);
            // Side by side the conflicts card takes the form's height; stacked it needs its own.
            ConflictsCard.HeightRequest = stacked ? 320 : -1;
        });
        Unloaded += (_, _) => Track(null);
    }

    protected override void OnBindingContextChanged()
    {
        base.OnBindingContextChanged();
        Track(BindingContext as DatasetSyncViewModel);
    }

    private void Track(DatasetSyncViewModel? viewModel)
    {
        if (_viewModel is not null) _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
        _viewModel = viewModel;
        if (_viewModel is null) return;
        _viewModel.PropertyChanged += OnViewModelPropertyChanged;
        ApplySafety();
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(DatasetSyncViewModel.SafetyLabel)
            or nameof(DatasetSyncViewModel.SafeToSwitch)
            or nameof(DatasetSyncViewModel.IsSyncRunning))
            ApplySafety();
    }

    private void ApplySafety()
    {
        if (_viewModel is null) return;
        SafetyPill.Text = _viewModel.SafetyLabel;
        SafetyPill.Tone = _viewModel.IsSyncRunning ? StatusTone.Accent
            : _viewModel.SafeToSwitch ? StatusTone.Success
            : StatusTone.Warning;
    }
}
