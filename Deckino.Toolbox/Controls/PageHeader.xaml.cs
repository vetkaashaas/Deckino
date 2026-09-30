namespace Deckino.Toolbox.Controls;

/// <summary>The one-line bar at the top of every workspace: title, subtitle, status and actions.</summary>
public partial class PageHeader : ContentView
{
    public static readonly BindableProperty TitleProperty = BindableProperty.Create(
        nameof(Title), typeof(string), typeof(PageHeader), string.Empty,
        propertyChanged: (bindable, _, value) => ((PageHeader)bindable).TitleLabel.Text = (string)value);

    public static readonly BindableProperty SubtitleProperty = BindableProperty.Create(
        nameof(Subtitle), typeof(string), typeof(PageHeader), string.Empty,
        propertyChanged: (bindable, _, value) =>
        {
            var label = ((PageHeader)bindable).SubtitleLabel;
            var text = (string?)value ?? string.Empty;
            label.Text = text;
            label.IsVisible = text.Length > 0;
            // The subtitle is held to one line, so the full sentence stays reachable on hover.
            ToolTipProperties.SetText(label, text);
        });

    public static readonly BindableProperty StatusProperty = BindableProperty.Create(
        nameof(Status), typeof(View), typeof(PageHeader), null,
        propertyChanged: (bindable, _, value) => ((PageHeader)bindable).StatusHost.Content = (View?)value);

    public static readonly BindableProperty ActionsProperty = BindableProperty.Create(
        nameof(Actions), typeof(View), typeof(PageHeader), null,
        propertyChanged: (bindable, _, value) => ((PageHeader)bindable).ActionsHost.Content = (View?)value);

    public PageHeader()
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

    public View? Status
    {
        get => (View?)GetValue(StatusProperty);
        set => SetValue(StatusProperty, value);
    }

    public View? Actions
    {
        get => (View?)GetValue(ActionsProperty);
        set => SetValue(ActionsProperty, value);
    }
}
