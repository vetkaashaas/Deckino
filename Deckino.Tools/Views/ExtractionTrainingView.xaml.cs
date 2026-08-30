using System.Collections.Specialized;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools.Views;

public partial class ExtractionTrainingView : UserControl
{
    private ExtractionTrainingViewModel? _subscribedViewModel;
    private double _diagnosticZoom = 1;
    private double _diagnosticOffsetX;
    private double _diagnosticOffsetY;
    private bool _isDiagnosticPanning;
    private Point _lastDiagnosticPointer;

    public ExtractionTrainingView()
    {
        InitializeComponent();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (DataContext is ExtractionTrainingViewModel viewModel)
            SubscribeToLog(viewModel);
        if (DataContext is IRefreshableWorkspace workspace)
        {
            await workspace.RefreshAsync();
        }
    }

    private void OnUnloaded(object sender, RoutedEventArgs e) => UnsubscribeFromLog();

    private void SubscribeToLog(ExtractionTrainingViewModel viewModel)
    {
        if (ReferenceEquals(_subscribedViewModel, viewModel)) return;
        UnsubscribeFromLog();
        _subscribedViewModel = viewModel;
        viewModel.LiveLog.CollectionChanged += OnLogCollectionChanged;
        viewModel.PropertyChanged += OnViewModelPropertyChanged;
        ResetDiagnosticViewport();
        ScrollToLatestLogEntry();
    }

    private void UnsubscribeFromLog()
    {
        if (_subscribedViewModel is null) return;
        _subscribedViewModel.LiveLog.CollectionChanged -= OnLogCollectionChanged;
        _subscribedViewModel.PropertyChanged -= OnViewModelPropertyChanged;
        _subscribedViewModel = null;
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(ExtractionTrainingViewModel.DiagnosticOverlayPreview))
            Dispatcher.BeginInvoke(ResetDiagnosticViewport, DispatcherPriority.Loaded);
    }

    private BitmapSource? DiagnosticOverlay => _subscribedViewModel?.DiagnosticOverlayPreview;

    private double DiagnosticFitScale()
    {
        var image = DiagnosticOverlay;
        if (image is null || DiagnosticOverlayViewport.ActualWidth <= 0 || DiagnosticOverlayViewport.ActualHeight <= 0)
            return 1;
        return Math.Max(.001, Math.Min(DiagnosticOverlayViewport.ActualWidth / image.PixelWidth,
            DiagnosticOverlayViewport.ActualHeight / image.PixelHeight));
    }

    private void ResetDiagnosticViewport()
    {
        _diagnosticZoom = 1;
        CenterDiagnosticOverlay();
        RenderDiagnosticOverlay();
    }

    private void CenterDiagnosticOverlay()
    {
        var image = DiagnosticOverlay;
        if (image is null) return;
        var scale = DiagnosticFitScale() * _diagnosticZoom;
        _diagnosticOffsetX = (DiagnosticOverlayViewport.ActualWidth - image.PixelWidth * scale) / 2;
        _diagnosticOffsetY = (DiagnosticOverlayViewport.ActualHeight - image.PixelHeight * scale) / 2;
    }

    private void RenderDiagnosticOverlay()
    {
        var image = DiagnosticOverlay;
        DiagnosticOverlayImage.Visibility = image is null ? Visibility.Collapsed : Visibility.Visible;
        if (image is null) return;
        var scale = DiagnosticFitScale() * _diagnosticZoom;
        DiagnosticOverlayImage.Width = image.PixelWidth * scale;
        DiagnosticOverlayImage.Height = image.PixelHeight * scale;
        Canvas.SetLeft(DiagnosticOverlayImage, _diagnosticOffsetX);
        Canvas.SetTop(DiagnosticOverlayImage, _diagnosticOffsetY);
    }

    private void DiagnosticOverlayViewport_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (DiagnosticOverlay is null) return;
        var pointer = e.GetPosition(DiagnosticOverlayViewport);
        var oldScale = DiagnosticFitScale() * _diagnosticZoom;
        var imageX = (pointer.X - _diagnosticOffsetX) / oldScale;
        var imageY = (pointer.Y - _diagnosticOffsetY) / oldScale;
        _diagnosticZoom = Math.Clamp(_diagnosticZoom * (e.Delta > 0 ? 1.15 : 1 / 1.15), 1, 8);
        var newScale = DiagnosticFitScale() * _diagnosticZoom;
        _diagnosticOffsetX = pointer.X - imageX * newScale;
        _diagnosticOffsetY = pointer.Y - imageY * newScale;
        if (_diagnosticZoom == 1) CenterDiagnosticOverlay();
        RenderDiagnosticOverlay();
        e.Handled = true;
    }

    private void DiagnosticOverlayViewport_MouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (DiagnosticOverlay is null) return;
        _isDiagnosticPanning = true;
        _lastDiagnosticPointer = e.GetPosition(DiagnosticOverlayViewport);
        DiagnosticOverlayViewport.Cursor = Cursors.SizeAll;
        DiagnosticOverlayViewport.CaptureMouse();
        e.Handled = true;
    }

    private void DiagnosticOverlayViewport_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        StopDiagnosticPanning();
        e.Handled = true;
    }

    private void DiagnosticOverlayViewport_LostMouseCapture(object sender, MouseEventArgs e) => StopDiagnosticPanning(false);

    private void StopDiagnosticPanning(bool releaseCapture = true)
    {
        _isDiagnosticPanning = false;
        DiagnosticOverlayViewport.Cursor = Cursors.Arrow;
        if (releaseCapture && DiagnosticOverlayViewport.IsMouseCaptured)
            DiagnosticOverlayViewport.ReleaseMouseCapture();
    }

    private void DiagnosticOverlayViewport_MouseMove(object sender, MouseEventArgs e)
    {
        if (!_isDiagnosticPanning || e.RightButton != MouseButtonState.Pressed) return;
        var pointer = e.GetPosition(DiagnosticOverlayViewport);
        _diagnosticOffsetX += pointer.X - _lastDiagnosticPointer.X;
        _diagnosticOffsetY += pointer.Y - _lastDiagnosticPointer.Y;
        _lastDiagnosticPointer = pointer;
        RenderDiagnosticOverlay();
        e.Handled = true;
    }

    private void DiagnosticOverlayViewport_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        if (_diagnosticZoom == 1) CenterDiagnosticOverlay();
        RenderDiagnosticOverlay();
    }

    private void OnLogCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.Action == NotifyCollectionChangedAction.Add)
            Dispatcher.BeginInvoke(ScrollToLatestLogEntry, DispatcherPriority.Background);
    }

    private void ScrollToLatestLogEntry()
    {
        if (ActivityLogList.Items.Count == 0) return;
        FindVisualChild<ScrollViewer>(ActivityLogList)?.ScrollToEnd();
    }

    private static T? FindVisualChild<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(parent); index++)
        {
            var child = VisualTreeHelper.GetChild(parent, index);
            if (child is T match) return match;
            var descendant = FindVisualChild<T>(child);
            if (descendant is not null) return descendant;
        }
        return null;
    }
}
