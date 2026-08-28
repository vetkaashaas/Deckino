using System.Collections.Specialized;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools.Views;

public partial class ExtractionTrainingView : UserControl
{
    private ExtractionTrainingViewModel? _subscribedViewModel;

    public ExtractionTrainingView()
    {
        InitializeComponent();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (DataContext is ExtractionTrainingViewModel viewModel)
            SubscribeToLog(viewModel);
        if (DataContext is IRefreshableWorkspace workspace)
        {
            await workspace.RefreshAsync();
        }
    }

    private void OnUnloaded(object sender, RoutedEventArgs e) => UnsubscribeFromLog();

    private void SubscribeToLog(ExtractionTrainingViewModel viewModel)
    {
        if (ReferenceEquals(_subscribedViewModel, viewModel)) return;
        UnsubscribeFromLog();
        _subscribedViewModel = viewModel;
        viewModel.LiveLog.CollectionChanged += OnLogCollectionChanged;
        ScrollToLatestLogEntry();
    }

    private void UnsubscribeFromLog()
    {
        if (_subscribedViewModel is null) return;
        _subscribedViewModel.LiveLog.CollectionChanged -= OnLogCollectionChanged;
        _subscribedViewModel = null;
    }

    private void OnLogCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.Action == NotifyCollectionChangedAction.Add)
            Dispatcher.BeginInvoke(ScrollToLatestLogEntry, DispatcherPriority.Background);
    }

    private void ScrollToLatestLogEntry()
    {
        if (ActivityLogList.Items.Count == 0) return;
        FindVisualChild<ScrollViewer>(ActivityLogList)?.ScrollToEnd();
    }

    private static T? FindVisualChild<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(parent); index++)
        {
            var child = VisualTreeHelper.GetChild(parent, index);
            if (child is T match) return match;
            var descendant = FindVisualChild<T>(child);
            if (descendant is not null) return descendant;
        }
        return null;
    }
}
