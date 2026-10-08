using System.Collections.Specialized;
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Views;

public partial class PhotoLibraryView : ContentView
{
    private const double TargetTileWidth = 220;
    private const double TileGap = 12;

    private PhotoLibraryViewModel? _viewModel;
    private double _tileWidth = TargetTileWidth + TileGap;

    public PhotoLibraryView()
    {
        InitializeComponent();
        PhotoScroll.SizeChanged += (_, _) => ApplyColumns();
        PhotoFlow.ChildAdded += (_, e) =>
        {
            if (e.Element is View tile) tile.WidthRequest = _tileWidth;
        };
        // WorkspaceHost keeps this view between visits; the binding context stays the same, so re-track on load.
        Loaded += (_, _) => Track(BindingContext as PhotoLibraryViewModel);
        Unloaded += (_, _) => Track(null);
    }

    protected override void OnBindingContextChanged()
    {
        base.OnBindingContextChanged();
        Track(BindingContext as PhotoLibraryViewModel);
    }

    private void Track(PhotoLibraryViewModel? viewModel)
    {
        if (_viewModel is not null)
        {
            _viewModel.PageItems.CollectionChanged -= OnPageItemsChanged;
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
        }
        _viewModel = viewModel;
        if (_viewModel is null) return;
        _viewModel.PageItems.CollectionChanged += OnPageItemsChanged;
        _viewModel.PropertyChanged += OnViewModelPropertyChanged;
        NoPhotos.IsVisible = _viewModel.PageItems.Count == 0;
    }

    private void OnPageItemsChanged(object? sender, NotifyCollectionChangedEventArgs e) =>
        NoPhotos.IsVisible = _viewModel is null || _viewModel.PageItems.Count == 0;

    // Tiles are reused across pages, so a new page starts where the old one was scrolled to unless reset.
    private void OnViewModelPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(PhotoLibraryViewModel.CurrentPage) or nameof(PhotoLibraryViewModel.ActiveFilter))
            _ = PhotoScroll.ScrollToAsync(0, 0, animated: false);
    }

    // As many ~220px tiles as fit, then stretched so the row fills the width exactly.
    // Each tile's slot includes its trailing gap, so the last gap overhangs into the page padding.
    private void ApplyColumns()
    {
        if (PhotoScroll.Width <= 0) return;
        var available = PhotoScroll.Width + TileGap;
        var columns = Math.Max(2, (int)(available / (TargetTileWidth + TileGap)));
        var tileWidth = Math.Floor(available / columns);
        if (tileWidth == _tileWidth) return;
        _tileWidth = tileWidth;
        PhotoFlow.WidthRequest = tileWidth * columns;
        foreach (var child in PhotoFlow.Children)
            if (child is View tile) tile.WidthRequest = tileWidth;
    }
}
