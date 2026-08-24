using System.Collections.Specialized;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools.Views;

public partial class RunnerView : UserControl
{
    private RunnerViewModel? _subscribedViewModel;

    public RunnerView()
    {
        InitializeComponent();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (DataContext is RunnerViewModel viewModel)
        {
            SubscribeToLog(viewModel);
            await viewModel.EnsureQuickRequirementsCheckAsync();
        }
    }

    private void OnUnloaded(object sender, RoutedEventArgs e) => UnsubscribeFromLog();

    private void SubscribeToLog(RunnerViewModel viewModel)
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
        {
            Dispatcher.BeginInvoke(ScrollToLatestLogEntry, DispatcherPriority.Background);
        }
    }

    private void ScrollToLatestLogEntry()
    {
        if (ActivityLogList.Items.Count == 0) return;

        // ScrollIntoView raises a BringIntoView request that can also move the page's
        // outer ScrollViewer. Move only the ListBox's own viewport instead.
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
