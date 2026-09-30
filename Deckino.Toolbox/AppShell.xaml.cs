using System.ComponentModel;
using Deckino.Toolbox.Controls;
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox;

public partial class AppShell : ContentPage
{
    private const double ExpandedSidebarWidth = 220;
    private const double CompactSidebarWidth = 56;
    private const double CompactBelowWindowWidth = 1100;

    private readonly ShellViewModel _viewModel;
    private readonly List<(NavItem Item, WorkspaceViewModel Workspace)> _navItems = [];
    private readonly List<Label> _groupLabels = [];
    private readonly List<BoxView> _groupDividers = [];
    private bool _isCompact;

    public AppShell(ShellViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        BindingContext = viewModel;
        BuildNavigation();
        viewModel.PropertyChanged += OnViewModelPropertyChanged;
        SizeChanged += (_, _) => ApplySidebarWidth();
    }

    /// <summary>Dialogs and toasts render here, above the sidebar and the workspace.</summary>
    public OverlayHost Overlay => OverlayLayer;

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        Opacity = 0;
        TranslationY = 8;
        await Task.WhenAll(this.FadeToAsync(1, 180, Easing.CubicOut), this.TranslateToAsync(0, 0, 180, Easing.CubicOut));
    }

    private void BuildNavigation()
    {
        string? currentGroup = null;
        foreach (var workspace in _viewModel.Workspaces)
        {
            var (group, glyph) = WorkspaceChrome.For(workspace);
            if (group != currentGroup)
            {
                // Expanded shows the group name; the compact rail swaps it for a hairline.
                if (currentGroup is not null)
                {
                    var divider = new BoxView
                    {
                        Style = (Style)Application.Current!.Resources["Divider"],
                        Margin = new Thickness(8, 8),
                        IsVisible = false,
                    };
                    _groupDividers.Add(divider);
                    NavList.Add(divider);
                }
                var label = new Label
                {
                    Text = group,
                    Style = (Style)Application.Current!.Resources["Eyebrow"],
                    Margin = new Thickness(12, currentGroup is null ? 8 : 16, 0, 6),
                };
                _groupLabels.Add(label);
                NavList.Add(label);
                currentGroup = group;
            }

            var item = new NavItem
            {
                Glyph = glyph,
                Text = workspace.DisplayName,
                ToolTip = $"{workspace.DisplayName}\n{workspace.Description}",
                IsSelected = ReferenceEquals(workspace, _viewModel.CurrentPage),
            };
            item.Clicked += (_, _) => _viewModel.CurrentPage = workspace;
            _navItems.Add((item, workspace));
            NavList.Add(item);
        }
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(ShellViewModel.CurrentPage)) return;
        foreach (var (item, workspace) in _navItems)
            item.IsSelected = ReferenceEquals(workspace, _viewModel.CurrentPage);
    }

    private void ApplySidebarWidth()
    {
        if (Width <= 0) return;
        var compact = Width < CompactBelowWindowWidth;
        if (compact == _isCompact) return;
        _isCompact = compact;

        Responsive.SetColumns(ShellLayout, compact ? CompactSidebarWidth : ExpandedSidebarWidth, 1, GridLength.Star);
        BrandText.IsVisible = !compact;
        foreach (var label in _groupLabels) label.IsVisible = !compact;
        foreach (var divider in _groupDividers) divider.IsVisible = compact;
        foreach (var (item, _) in _navItems) item.IsCompact = compact;
    }
}
