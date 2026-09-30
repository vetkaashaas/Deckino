namespace Deckino.Toolbox.Controls;

public partial class NavItem : ContentView
{
    public static readonly BindableProperty GlyphProperty = BindableProperty.Create(
        nameof(Glyph), typeof(string), typeof(NavItem), string.Empty,
        propertyChanged: (bindable, _, value) => ((NavItem)bindable).GlyphLabel.Text = (string)value);

    public static readonly BindableProperty TextProperty = BindableProperty.Create(
        nameof(Text), typeof(string), typeof(NavItem), string.Empty,
        propertyChanged: (bindable, _, value) =>
        {
            var item = (NavItem)bindable;
            item.TextLabel.Text = (string)value;
            SemanticProperties.SetDescription(item.HitButton, (string)value);
        });

    public static readonly BindableProperty ToolTipProperty = BindableProperty.Create(
        nameof(ToolTip), typeof(string), typeof(NavItem), string.Empty,
        propertyChanged: (bindable, _, value) =>
            ToolTipProperties.SetText(((NavItem)bindable).HitButton, (string)value));

    public static readonly BindableProperty IsSelectedProperty = BindableProperty.Create(
        nameof(IsSelected), typeof(bool), typeof(NavItem), false,
        propertyChanged: (bindable, _, _) => ((NavItem)bindable).ApplySelection());

    public static readonly BindableProperty IsCompactProperty = BindableProperty.Create(
        nameof(IsCompact), typeof(bool), typeof(NavItem), false,
        propertyChanged: (bindable, _, value) => ((NavItem)bindable).TextLabel.IsVisible = !(bool)value);

    public NavItem()
    {
        InitializeComponent();
    }

    public event EventHandler? Clicked;

    public string Glyph
    {
        get => (string)GetValue(GlyphProperty);
        set => SetValue(GlyphProperty, value);
    }

    public string Text
    {
        get => (string)GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    public string ToolTip
    {
        get => (string)GetValue(ToolTipProperty);
        set => SetValue(ToolTipProperty, value);
    }

    public bool IsSelected
    {
        get => (bool)GetValue(IsSelectedProperty);
        set => SetValue(IsSelectedProperty, value);
    }

    public bool IsCompact
    {
        get => (bool)GetValue(IsCompactProperty);
        set => SetValue(IsCompactProperty, value);
    }

    private void OnClicked(object? sender, EventArgs e) => Clicked?.Invoke(this, EventArgs.Empty);

    private void ApplySelection()
    {
        SelectionFill.BackgroundColor = IsSelected ? Palette.Get("AccentWash") : Colors.Transparent;
        Indicator.IsVisible = IsSelected;
        GlyphLabel.TextColor = Palette.Get(IsSelected ? "Accent" : "SecondaryText");
        TextLabel.TextColor = Palette.Get(IsSelected ? "CanvasText" : "SecondaryText");
        TextLabel.FontFamily = IsSelected ? "OpenSansSemibold" : "OpenSansRegular";
    }
}
