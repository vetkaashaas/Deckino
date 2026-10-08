using Deckino.Toolbox.ViewModels;
using Deckino.Toolbox.Views;

namespace Deckino.Toolbox.Controls;

public sealed class WorkspaceHost : ContentView
{
    public static readonly BindableProperty CurrentPageProperty = BindableProperty.Create(
        nameof(CurrentPage), typeof(WorkspaceViewModel), typeof(WorkspaceHost), null,
        propertyChanged: OnCurrentPageChanged);

    // Kept between visits: building its 60 photo tiles is the slow part of opening the Photo Library.
    private PhotoLibraryView? _photoLibraryView;

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
            CardIdentificationViewModel => new CardIdentificationView(),
            PhotoLibraryViewModel => host._photoLibraryView ??= CreateKeptView<PhotoLibraryView>(),
            ExtractionTrainingViewModel => new ExtractionTrainingView(),
            RunnerViewModel => new RunnerView(),
            ModelBenchmarksViewModel => new ModelBenchmarksView(),
            _ => throw new InvalidOperationException($"No view is registered for {viewModel.GetType().Name}."),
        };
        view.BindingContext = viewModel;
        view.Opacity = 0;
        view.TranslationY = 6;
        host.Content = view;
        await Task.WhenAll(view.FadeToAsync(1, 160, Easing.CubicOut), view.TranslateToAsync(0, 0, 160, Easing.CubicOut));
    }

    // Manual so leaving the page never tears down the native controls this view is kept to reuse.
    private static T CreateKeptView<T>() where T : View, new()
    {
        var view = new T();
        HandlerProperties.SetDisconnectPolicy(view, HandlerDisconnectPolicy.Manual);
        return view;
    }
}
