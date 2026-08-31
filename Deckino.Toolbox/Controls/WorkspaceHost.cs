using Deckino.Toolbox.ViewModels;
using Deckino.Toolbox.Views;

namespace Deckino.Toolbox.Controls;

public sealed class WorkspaceHost : ContentView
{
    public static readonly BindableProperty CurrentPageProperty = BindableProperty.Create(
        nameof(CurrentPage), typeof(WorkspaceViewModel), typeof(WorkspaceHost), null,
        propertyChanged: OnCurrentPageChanged);

    public WorkspaceViewModel? CurrentPage
    {
        get => (WorkspaceViewModel?)GetValue(CurrentPageProperty);
        set => SetValue(CurrentPageProperty, value);
    }

    private static async void OnCurrentPageChanged(BindableObject bindable, object oldValue, object newValue)
    {
        var host = (WorkspaceHost)bindable;
        var viewModel = (WorkspaceViewModel)newValue;
        View view = viewModel switch
        {
            SyncViewModel => new SyncView(),
            DatasetSyncViewModel => new DatasetSyncView(),
            VideoImportViewModel => new VideoImportView(),
            AnnotatorViewModel => new AnnotatorView(),
            PhotoLibraryViewModel => new PhotoLibraryView(),
            ExtractionTrainingViewModel => new ExtractionTrainingView(),
            RunnerViewModel => new RunnerView(),
            _ => throw new InvalidOperationException($"No view is registered for {viewModel.GetType().Name}."),
        };
        view.BindingContext = viewModel;
        view.Opacity = 0;
        view.TranslationY = 6;
        host.Content = view;
        await Task.WhenAll(view.FadeToAsync(1, 160, Easing.CubicOut), view.TranslateToAsync(0, 0, 160, Easing.CubicOut));
    }
}
