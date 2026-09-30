namespace Deckino.Toolbox.Controls;

/// <summary>A titled surface with an optional actions slot. Set IsInset for a sunken well.</summary>
[ContentProperty(nameof(Body))]
public partial class Card : ContentView
{
    public static readonly BindableProperty TitleProperty = BindableProperty.Create(
        nameof(Title), typeof(string), typeof(Card), string.Empty,
        propertyChanged: (bindable, _, _) => ((Card)bindable).ApplyHeader());

    public static readonly BindableProperty SubtitleProperty = BindableProperty.Create(
        nameof(Subtitle), typeof(string), typeof(Card), string.Empty,
        propertyChanged: (bindable, _, _) => ((Card)bindable).ApplyHeader());

    public static readonly BindableProperty ActionsProperty = BindableProperty.Create(
        nameof(Actions), typeof(View), typeof(Card), null,
        propertyChanged: (bindable, _, _) => ((Card)bindable).ApplyHeader());

    public static readonly BindableProperty BodyProperty = BindableProperty.Create(
        nameof(Body), typeof(View), typeof(Card), null,
        propertyChanged: (bindable, _, value) => ((Card)bindable).BodyHost.Content = (View?)value);

    public static readonly BindableProperty IsInsetProperty = BindableProperty.Create(
        nameof(IsInset), typeof(bool), typeof(Card), false,
        propertyChanged: (bindable, _, value) => ((Card)bindable).Surface.Style =
            (Style)Application.Current!.Resources[(bool)value ? "InsetSurface" : "Surface"]);

    public Card()
    {
        InitializeComponent();
    }

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public string Subtitle
    {
        get => (string)GetValue(SubtitleProperty);
        set => SetValue(SubtitleProperty, value);
    }

    public View? Actions
    {
        get => (View?)GetValue(ActionsProperty);
        set => SetValue(ActionsProperty, value);
    }

    public View? Body
    {
        get => (View?)GetValue(BodyProperty);
        set => SetValue(BodyProperty, value);
    }

    public bool IsInset
    {
        get => (bool)GetValue(IsInsetProperty);
        set => SetValue(IsInsetProperty, value);
    }

    private void ApplyHeader()
    {
        TitleLabel.Text = Title;
        SubtitleLabel.Text = Subtitle;
        SubtitleLabel.IsVisible = !string.IsNullOrEmpty(Subtitle);
        ActionsHost.Content = Actions;
        HeaderRow.IsVisible = !string.IsNullOrEmpty(Title) || Actions is not null;
    }
}
