using System.Collections;
using System.Windows.Input;

namespace Deckino.Toolbox.Controls;

/// <summary>Activity log with its toolbar. Fills whatever height its parent gives it.</summary>
public partial class LogPanel : ContentView
{
    public static readonly BindableProperty ItemsSourceProperty = BindableProperty.Create(
        nameof(ItemsSource), typeof(IEnumerable), typeof(LogPanel), null,
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).Lines.ItemsSource = (IEnumerable?)value);

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

    public static readonly BindableProperty FollowTailProperty = BindableProperty.Create(
        nameof(FollowTail), typeof(bool), typeof(LogPanel), false,
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).Lines.ItemsUpdatingScrollMode =
            (bool)value ? ItemsUpdatingScrollMode.KeepLastItemInView : ItemsUpdatingScrollMode.KeepItemsInView);

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

    public LogPanel()
    {
        InitializeComponent();
        Responsive.Watch(this, CompactBelowWidth, compact =>
        {
            _compact = compact;
            ApplyStatusPlacement();
        });
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

    public bool FollowTail
    {
        get => (bool)GetValue(FollowTailProperty);
        set => SetValue(FollowTailProperty, value);
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
}
