namespace Deckino.Toolbox.Controls;

public partial class StatTile : ContentView
{
    public static readonly BindableProperty HeadingProperty = BindableProperty.Create(
        nameof(Heading), typeof(string), typeof(StatTile), string.Empty,
        propertyChanged: (bindable, _, value) => ((StatTile)bindable).LabelText.Text = (string)value);

    public static readonly BindableProperty ValueProperty = BindableProperty.Create(
        nameof(Value), typeof(string), typeof(StatTile), string.Empty,
        propertyChanged: (bindable, _, value) => ((StatTile)bindable).ValueText.Text = (string)value);

    public static readonly BindableProperty CaptionProperty = BindableProperty.Create(
        nameof(Caption), typeof(string), typeof(StatTile), string.Empty,
        propertyChanged: (bindable, _, value) =>
        {
            var caption = ((StatTile)bindable).CaptionText;
            caption.Text = (string)value;
            caption.IsVisible = !string.IsNullOrEmpty((string)value);
        });

    public StatTile()
    {
        InitializeComponent();
    }

    public string Heading
    {
        get => (string)GetValue(HeadingProperty);
        set => SetValue(HeadingProperty, value);
    }

    public string Value
    {
        get => (string)GetValue(ValueProperty);
        set => SetValue(ValueProperty, value);
    }

    public string Caption
    {
        get => (string)GetValue(CaptionProperty);
        set => SetValue(CaptionProperty, value);
    }
}
