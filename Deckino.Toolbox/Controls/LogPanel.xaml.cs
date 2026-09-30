using System.Collections;
using System.Collections.Specialized;
using System.Windows.Input;
#if WINDOWS
using Windows.System;
using WinControls = Microsoft.UI.Xaml.Controls;
using WinInput = Microsoft.UI.Xaml.Input;
using WinPrimitives = Microsoft.UI.Xaml.Controls.Primitives;
#endif

namespace Deckino.Toolbox.Controls;

/// <summary>
/// Activity log with its toolbar. Fills whatever height its parent gives it. The list follows the newest
/// line until the reader scrolls up, and picks up again once they return to the bottom.
/// </summary>
public partial class LogPanel : ContentView
{
    public static readonly BindableProperty ItemsSourceProperty = BindableProperty.Create(
        nameof(ItemsSource), typeof(IEnumerable), typeof(LogPanel), null,
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).OnItemsSourceChanged((IEnumerable?)value));

    public static readonly BindableProperty SelectedItemProperty = BindableProperty.Create(
        nameof(SelectedItem), typeof(object), typeof(LogPanel), null, BindingMode.TwoWay,
        propertyChanged: (bindable, _, value) =>
        {
            var lines = ((LogPanel)bindable).Lines;
            if (!Equals(lines.SelectedItem, value)) lines.SelectedItem = value;
        });

    public static readonly BindableProperty StatusProperty = BindableProperty.Create(
        nameof(Status), typeof(string), typeof(LogPanel), string.Empty,
        propertyChanged: (bindable, _, value) =>
        {
            var panel = (LogPanel)bindable;
            panel.StatusLabel.Text = (string)value;
            panel.ApplyStatusPlacement();
        });

    public static readonly BindableProperty OpenFolderCommandProperty = BindableProperty.Create(
        nameof(OpenFolderCommand), typeof(ICommand), typeof(LogPanel), null,
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).OpenButton.Command = (ICommand?)value);

    public static readonly BindableProperty ClearCommandProperty = BindableProperty.Create(
        nameof(ClearCommand), typeof(ICommand), typeof(LogPanel), null,
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).ClearButton.Command = (ICommand?)value);

    public static readonly BindableProperty CopySelectedCommandProperty = BindableProperty.Create(
        nameof(CopySelectedCommand), typeof(ICommand), typeof(LogPanel), null,
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).CopySelectedButton.Command = (ICommand?)value);

    public static readonly BindableProperty CopyAllCommandProperty = BindableProperty.Create(
        nameof(CopyAllCommand), typeof(ICommand), typeof(LogPanel), null,
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).CopyAllButton.Command = (ICommand?)value);

    private const double CompactBelowWidth = 600;
    private bool _compact;
    private INotifyCollectionChanged? _source;
    private bool _following = true;
    private bool _scrollQueued;

    public LogPanel()
    {
        InitializeComponent();
        Responsive.Watch(this, CompactBelowWidth, compact =>
        {
            _compact = compact;
            ApplyStatusPlacement();
        });
#if WINDOWS
        Lines.HandlerChanged += (_, _) => AttachList();
#endif
    }

    public IEnumerable? ItemsSource
    {
        get => (IEnumerable?)GetValue(ItemsSourceProperty);
        set => SetValue(ItemsSourceProperty, value);
    }

    public object? SelectedItem
    {
        get => GetValue(SelectedItemProperty);
        set => SetValue(SelectedItemProperty, value);
    }

    public string Status
    {
        get => (string)GetValue(StatusProperty);
        set => SetValue(StatusProperty, value);
    }

    public ICommand? OpenFolderCommand
    {
        get => (ICommand?)GetValue(OpenFolderCommandProperty);
        set => SetValue(OpenFolderCommandProperty, value);
    }

    public ICommand? ClearCommand
    {
        get => (ICommand?)GetValue(ClearCommandProperty);
        set => SetValue(ClearCommandProperty, value);
    }

    public ICommand? CopySelectedCommand
    {
        get => (ICommand?)GetValue(CopySelectedCommandProperty);
        set => SetValue(CopySelectedCommandProperty, value);
    }

    public ICommand? CopyAllCommand
    {
        get => (ICommand?)GetValue(CopyAllCommandProperty);
        set => SetValue(CopyAllCommandProperty, value);
    }

    // Wide: the status sits between the title and the buttons. Narrow: it gets its own row underneath,
    // and that row disappears while there is nothing to say.
    private void ApplyStatusPlacement()
    {
        Grid.SetRow(StatusLabel, _compact ? 1 : 0);
        Grid.SetColumn(StatusLabel, _compact ? 0 : 1);
        Grid.SetColumnSpan(StatusLabel, _compact ? 3 : 1);
        StatusLabel.IsVisible = !_compact || !string.IsNullOrEmpty(StatusLabel.Text);
    }

    private void OnSelectionChanged(object? sender, SelectionChangedEventArgs e) =>
        SelectedItem = Lines.SelectedItem;

    private void OnItemsSourceChanged(IEnumerable? items)
    {
        if (_source is not null) _source.CollectionChanged -= OnLinesChanged;
        Lines.ItemsSource = items;
        _source = items as INotifyCollectionChanged;
        if (_source is not null) _source.CollectionChanged += OnLinesChanged;
        _following = true;
        QueueScrollToEnd();
    }

    private void OnLinesChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        // A cleared log has nothing left to read back through.
        if (e.Action == NotifyCollectionChangedAction.Reset) _following = true;
        QueueScrollToEnd();
    }

    // Lines arrive in bursts, and a full log drops its oldest line for every new one. Everything that
    // changes before the next dispatcher turn becomes a single scroll, so the list moves once.
    private void QueueScrollToEnd()
    {
        if (!_following || _scrollQueued) return;
        _scrollQueued = true;
        Dispatcher.Dispatch(() =>
        {
            _scrollQueued = false;
            if (_following) ScrollToEnd();
        });
    }

#if WINDOWS
    // Anything closer to the bottom than this counts as being on the last line.
    private const double EndTolerance = 2;

    private WinControls.ListViewBase? _list;
    private WinControls.ScrollViewer? _scroller;
    private WinPrimitives.ScrollBar? _scrollBar;
    private WinInput.PointerEventHandler? _wheelHandler;
    private WinInput.KeyEventHandler? _keyHandler;

    private bool AtEnd =>
        _scroller is not { } scroller || scroller.ScrollableHeight - scroller.VerticalOffset <= EndTolerance;

    private bool CanScrollUp => _scroller is { VerticalOffset: > 0 };

    private void ScrollToEnd()
    {
        if (_list is { Items.Count: > 0 } list) list.ScrollIntoView(list.Items[list.Items.Count - 1]);
    }

    private void AttachList()
    {
        if (_list is not null)
        {
            _list.RemoveHandler(Microsoft.UI.Xaml.UIElement.PointerWheelChangedEvent, _wheelHandler);
            _list.RemoveHandler(Microsoft.UI.Xaml.UIElement.KeyDownEvent, _keyHandler);
            _list.Loaded -= OnListLoaded;
        }
        DetachScroller();
        _list = Lines.Handler?.PlatformView as WinControls.ListViewBase;
        if (_list is null) return;

        // The list handles these itself, so ask for handled events too. Only the reader's own input
        // stops the following, because the list also moves by itself when lines are added or dropped.
        _wheelHandler ??= OnListWheel;
        _keyHandler ??= OnListKeyDown;
        _list.AddHandler(Microsoft.UI.Xaml.UIElement.PointerWheelChangedEvent, _wheelHandler, true);
        _list.AddHandler(Microsoft.UI.Xaml.UIElement.KeyDownEvent, _keyHandler, true);
        _list.Loaded += OnListLoaded;
        if (_list.IsLoaded) AttachScroller();
    }

    private void OnListLoaded(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
    {
        AttachScroller();
        QueueScrollToEnd();
    }

    // The scroll viewer and its scroll bar are template parts, so they only exist once the list has loaded.
    private void AttachScroller()
    {
        DetachScroller();
        if (_list is null) return;
        _scroller = Descendants<WinControls.ScrollViewer>(_list).FirstOrDefault();
        if (_scroller is null) return;
        _scroller.ViewChanged += OnViewChanged;
        _scroller.DirectManipulationStarted += OnTouchPanStarted;
        _scroller.DirectManipulationCompleted += OnTouchPanCompleted;
        _scrollBar = Descendants<WinPrimitives.ScrollBar>(_scroller)
            .FirstOrDefault(bar => bar.Orientation == WinControls.Orientation.Vertical);
        if (_scrollBar is not null) _scrollBar.Scroll += OnScrollBarMoved;
    }

    private void DetachScroller()
    {
        if (_scroller is not null)
        {
            _scroller.ViewChanged -= OnViewChanged;
            _scroller.DirectManipulationStarted -= OnTouchPanStarted;
            _scroller.DirectManipulationCompleted -= OnTouchPanCompleted;
        }
        if (_scrollBar is not null) _scrollBar.Scroll -= OnScrollBarMoved;
        _scroller = null;
        _scrollBar = null;
    }

    private void OnListWheel(object sender, WinInput.PointerRoutedEventArgs e)
    {
        var wheel = e.GetCurrentPoint(_list).Properties;
        if (!wheel.IsHorizontalMouseWheel && wheel.MouseWheelDelta > 0 && CanScrollUp) _following = false;
    }

    private void OnListKeyDown(object sender, WinInput.KeyRoutedEventArgs e)
    {
        if (e.Key is VirtualKey.PageUp or VirtualKey.Home && CanScrollUp) _following = false;
    }

    // Raised only when the reader drags the thumb or clicks the track, never for the list's own scrolling.
    private void OnScrollBarMoved(object sender, WinPrimitives.ScrollEventArgs e)
    {
        if (_scrollBar is { } bar) _following = e.NewValue >= bar.Maximum - EndTolerance;
    }

    private void OnTouchPanStarted(object? sender, object e) => _following = false;

    private void OnTouchPanCompleted(object? sender, object e)
    {
        if (AtEnd) _following = true;
    }

    private void OnViewChanged(object? sender, WinControls.ScrollViewerViewChangedEventArgs e)
    {
        // Coming to rest on the last line resumes the following.
        if (!e.IsIntermediate && AtEnd) _following = true;
    }

    private static IEnumerable<T> Descendants<T>(Microsoft.UI.Xaml.DependencyObject parent)
        where T : Microsoft.UI.Xaml.DependencyObject
    {
        var count = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChildrenCount(parent);
        for (var index = 0; index < count; index++)
        {
            var child = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetChild(parent, index);
            if (child is T match) yield return match;
            foreach (var nested in Descendants<T>(child)) yield return nested;
        }
    }
#else
    private void ScrollToEnd()
    {
    }
#endif
}
