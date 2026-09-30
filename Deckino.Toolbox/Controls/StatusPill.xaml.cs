namespace Deckino.Toolbox.Controls;

public partial class StatusPill : ContentView
{
    public static readonly BindableProperty TextProperty = BindableProperty.Create(
        nameof(Text), typeof(string), typeof(StatusPill), string.Empty,
        propertyChanged: (bindable, _, value) => ((StatusPill)bindable).TextLabel.Text = (string)value);

    public static readonly BindableProperty ToneProperty = BindableProperty.Create(
        nameof(Tone), typeof(StatusTone), typeof(StatusPill), StatusTone.Neutral,
        propertyChanged: (bindable, _, _) => ((StatusPill)bindable).ApplyTone());

    public StatusPill()
    {
        InitializeComponent();
    }

    public string Text
    {
        get => (string)GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    public StatusTone Tone
    {
        get => (StatusTone)GetValue(ToneProperty);
        set => SetValue(ToneProperty, value);
    }

    private void ApplyTone()
    {
        var foreground = Palette.Foreground(Tone);
        Pill.BackgroundColor = Palette.Wash(Tone);
        Dot.Fill = new SolidColorBrush(foreground);
        TextLabel.TextColor = foreground;
    }
}
