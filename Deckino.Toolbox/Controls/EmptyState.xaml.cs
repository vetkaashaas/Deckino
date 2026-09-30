namespace Deckino.Toolbox.Controls;

public partial class EmptyState : ContentView
{
    public static readonly BindableProperty GlyphProperty = BindableProperty.Create(
        nameof(Glyph), typeof(string), typeof(EmptyState), string.Empty,
        propertyChanged: (bindable, _, value) => Show(((EmptyState)bindable).GlyphLabel, (string)value));

    public static readonly BindableProperty TitleProperty = BindableProperty.Create(
        nameof(Title), typeof(string), typeof(EmptyState), string.Empty,
        propertyChanged: (bindable, _, value) => ((EmptyState)bindable).TitleLabel.Text = (string)value);

    public static readonly BindableProperty MessageProperty = BindableProperty.Create(
        nameof(Message), typeof(string), typeof(EmptyState), string.Empty,
        propertyChanged: (bindable, _, value) => Show(((EmptyState)bindable).MessageLabel, (string)value));

    public EmptyState()
    {
        InitializeComponent();
    }

    public string Glyph
    {
        get => (string)GetValue(GlyphProperty);
        set => SetValue(GlyphProperty, value);
    }

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public string Message
    {
        get => (string)GetValue(MessageProperty);
        set => SetValue(MessageProperty, value);
    }

    private static void Show(Label label, string text)
    {
        label.Text = text;
        label.IsVisible = !string.IsNullOrEmpty(text);
    }
}
