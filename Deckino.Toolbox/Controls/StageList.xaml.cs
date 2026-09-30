using System.Collections;

namespace Deckino.Toolbox.Controls;

/// <summary>Vertical list of workflow stages that grows to fit, so it never needs its own scrollbar.</summary>
public partial class StageList : ContentView
{
    public static readonly BindableProperty ItemsSourceProperty = BindableProperty.Create(
        nameof(ItemsSource), typeof(IEnumerable), typeof(StageList), null,
        propertyChanged: (bindable, _, value) =>
            BindableLayout.SetItemsSource(((StageList)bindable).Rows, (IEnumerable?)value));

    public StageList()
    {
        InitializeComponent();
    }

    public IEnumerable? ItemsSource
    {
        get => (IEnumerable?)GetValue(ItemsSourceProperty);
        set => SetValue(ItemsSourceProperty, value);
    }
}
