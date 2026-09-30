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
        propertyChanged: (bindable, _, value) => ((LogPanel)bindable).StatusLabel.Text = (string)value);

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

    public LogPanel()
    {
        InitializeComponent();
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

    private void OnSelectionChanged(object? sender, SelectionChangedEventArgs e) =>
        SelectedItem = Lines.SelectedItem;
}
