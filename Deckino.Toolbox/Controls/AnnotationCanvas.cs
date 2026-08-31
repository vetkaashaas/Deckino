using System.Collections.Specialized;
using Deckino.Toolbox.Services;
using Deckino.Toolbox.ViewModels;
using Microsoft.Maui.Graphics;
#if WINDOWS
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
#endif

namespace Deckino.Toolbox.Controls;

public sealed class AnnotationCanvas : ContentView
{
    public static readonly BindableProperty ViewModelProperty = BindableProperty.Create(
        nameof(ViewModel), typeof(AnnotatorViewModel), typeof(AnnotationCanvas), null,
        propertyChanged: OnViewModelChanged);
    public static readonly BindableProperty ImageSourceProperty = BindableProperty.Create(
        nameof(ImageSource), typeof(ImageSource), typeof(AnnotationCanvas), null,
        propertyChanged: (bindable, _, value) => ((AnnotationCanvas)bindable)._image.Source = (ImageSource?)value);

    private readonly Image _image;
    private readonly GraphicsView _overlay;
    private readonly OverlayDrawable _drawable;
    private double _zoom = 1;
    private double _startZoom = 1;
    private double _startTranslationX;
    private double _startTranslationY;
    private int _selectedPoint = -1;
    private NormalizedPoint? _dragStart;
#if WINDOWS
    private FrameworkElement? _inputHost;
    private int _mouseDraggedPoint = -1;
    private bool _isMousePanning;
    private Point _lastMousePointer;
#endif

    public AnnotatorViewModel? ViewModel
    {
        get => (AnnotatorViewModel?)GetValue(ViewModelProperty);
        set => SetValue(ViewModelProperty, value);
    }

    public ImageSource? ImageSource
    {
        get => (ImageSource?)GetValue(ImageSourceProperty);
        set => SetValue(ImageSourceProperty, value);
    }

    public AnnotationCanvas()
    {
        BackgroundColor = Color.FromArgb("#090B0E");
        _image = new Image { Aspect = Aspect.AspectFit, InputTransparent = true };
        _drawable = new OverlayDrawable(this);
        _overlay = new GraphicsView
        {
            Drawable = _drawable,
            BackgroundColor = Colors.Transparent,
        };

        var viewport = new Grid();
        viewport.Children.Add(_image);
        viewport.Children.Add(_overlay);
        Content = viewport;

#if WINDOWS
        _overlay.HandlerChanged += OnOverlayHandlerChanged;
#else
        var tap = new TapGestureRecognizer();
        tap.Tapped += OnTapped;
        _overlay.GestureRecognizers.Add(tap);
        var pan = new PanGestureRecognizer();
        pan.PanUpdated += OnPanUpdated;
        _overlay.GestureRecognizers.Add(pan);
#endif
        var pinch = new PinchGestureRecognizer();
        pinch.PinchUpdated += OnPinchUpdated;
        _overlay.GestureRecognizers.Add(pinch);
        SizeChanged += (_, _) =>
        {
            ClampAndApplyTransform(_image.TranslationX, _image.TranslationY);
            UpdateNativeClip();
        };
    }

    public void ZoomIn() => ZoomAt(1.2, ViewportCenter());
    public void ZoomOut() => ZoomAt(1 / 1.2, ViewportCenter());

    public void ResetView()
    {
        _zoom = 1;
        _selectedPoint = -1;
        ApplyTransform(0, 0);
    }

    protected override void OnHandlerChanging(HandlerChangingEventArgs args)
    {
        DetachWindowsInput();
        base.OnHandlerChanging(args);
    }

    private static void OnViewModelChanged(BindableObject bindable, object oldValue, object newValue)
    {
        var canvas = (AnnotationCanvas)bindable;
        if (oldValue is AnnotatorViewModel oldViewModel)
            oldViewModel.Points.CollectionChanged -= canvas.OnPointsChanged;
        if (newValue is AnnotatorViewModel newViewModel)
            newViewModel.Points.CollectionChanged += canvas.OnPointsChanged;
        canvas.ResetView();
    }

    private void OnPointsChanged(object? sender, NotifyCollectionChangedEventArgs e) => _overlay.Invalidate();

    private void OnTapped(object? sender, TappedEventArgs e)
    {
        if (ViewModel?.HasPhoto != true || e.GetPosition(_overlay) is not Point position) return;
        _selectedPoint = HitPoint(position);
        if (_selectedPoint < 0 && ToNormalized(position) is { } normalized)
        {
            ViewModel.AddPoint(normalized);
            _selectedPoint = ViewModel.Points.Count - 1;
        }
        _overlay.Invalidate();
    }

    private void OnPanUpdated(object? sender, PanUpdatedEventArgs e)
    {
        if (ViewModel?.HasPhoto != true) return;
        switch (e.StatusType)
        {
            case GestureStatus.Started:
                _startTranslationX = _image.TranslationX;
                _startTranslationY = _image.TranslationY;
                _dragStart = _selectedPoint >= 0 && _selectedPoint < ViewModel.Points.Count
                    ? ViewModel.Points[_selectedPoint]
                    : null;
                if (_dragStart is not null) ViewModel.BeginPointEdit();
                break;
            case GestureStatus.Running when _dragStart is not null:
                var rect = ImageRect();
                if (rect.Width > 0 && rect.Height > 0)
                    ViewModel.MovePoint(_selectedPoint, new NormalizedPoint(
                        _dragStart.X + e.TotalX / (_zoom * rect.Width),
                        _dragStart.Y + e.TotalY / (_zoom * rect.Height)));
                break;
            case GestureStatus.Running when _zoom > 1:
                ClampAndApplyTransform(_startTranslationX + e.TotalX, _startTranslationY + e.TotalY);
                break;
            case GestureStatus.Completed:
            case GestureStatus.Canceled:
                if (_dragStart is not null) ViewModel.EndPointEdit();
                _dragStart = null;
                break;
        }
    }

    private void OnPinchUpdated(object? sender, PinchGestureUpdatedEventArgs e)
    {
        if (e.Status == GestureStatus.Started) _startZoom = _zoom;
        else if (e.Status == GestureStatus.Running)
            SetZoom(_startZoom * e.Scale, new Point(e.ScaleOrigin.X * Width, e.ScaleOrigin.Y * Height));
    }

    private void ZoomAt(double factor, Point focalPoint) => SetZoom(_zoom * factor, focalPoint);

    private void SetZoom(double value, Point focalPoint)
    {
        var nextZoom = Math.Clamp(value, 1, 8);
        var translation = CalculateZoomTranslation(
            focalPoint, _zoom, nextZoom, _image.TranslationX, _image.TranslationY, Width, Height);
        _zoom = nextZoom;
        ClampAndApplyTransform(translation.X, translation.Y);
    }

    private void ClampAndApplyTransform(double x, double y)
    {
        if (_zoom <= 1)
        {
            ApplyTransform(0, 0);
            return;
        }

        var rect = ImageRect();
        var maximumX = Math.Max(0, (rect.Width * _zoom - Width) / 2);
        var maximumY = Math.Max(0, (rect.Height * _zoom - Height) / 2);
        ApplyTransform(Math.Clamp(x, -maximumX, maximumX), Math.Clamp(y, -maximumY, maximumY));
    }

    private void ApplyTransform(double x, double y)
    {
        // Keep the input overlay fixed to the viewport. Rendering and hit-testing
        // use the same explicit matrix as the transformed photograph.
        _image.Scale = _zoom;
        _image.TranslationX = x;
        _image.TranslationY = y;
        _overlay.Invalidate();
    }

    private RectF ImageRect()
    {
        if (ViewModel is not { CurrentImageWidth: > 0, CurrentImageHeight: > 0 }
            || Width <= 0 || Height <= 0) return RectF.Zero;
        var scale = Math.Min((float)(Width / ViewModel.CurrentImageWidth), (float)(Height / ViewModel.CurrentImageHeight));
        var width = (float)(ViewModel.CurrentImageWidth * scale);
        var height = (float)(ViewModel.CurrentImageHeight * scale);
        return new RectF((float)((Width - width) / 2), (float)((Height - height) / 2), width, height);
    }

    private Point DisplayPoint(NormalizedPoint point)
    {
        var rect = ImageRect();
        var basePoint = new Point(rect.X + point.X * rect.Width, rect.Y + point.Y * rect.Height);
        return BaseToViewport(basePoint, _zoom, _image.TranslationX, _image.TranslationY, Width, Height);
    }

    private NormalizedPoint? ToNormalized(Point viewportPoint)
    {
        var point = ViewportToBase(
            viewportPoint, _zoom, _image.TranslationX, _image.TranslationY, Width, Height);
        var rect = ImageRect();
        if (rect.Width <= 0 || rect.Height <= 0) return null;
        var x = (point.X - rect.X) / rect.Width;
        var y = (point.Y - rect.Y) / rect.Height;
        return x is >= 0 and <= 1 && y is >= 0 and <= 1 ? new(x, y) : null;
    }

    private int HitPoint(Point pointer)
    {
        if (ViewModel is null) return -1;
        for (var index = 0; index < ViewModel.Points.Count; index++)
        {
            var point = DisplayPoint(ViewModel.Points[index]);
            if (Math.Sqrt(Math.Pow(point.X - pointer.X, 2) + Math.Pow(point.Y - pointer.Y, 2)) <= 18)
                return index;
        }
        return -1;
    }

    private Point ViewportCenter() => new(Width / 2, Height / 2);

    internal static Point BaseToViewport(
        Point point, double zoom, double translationX, double translationY, double width, double height) => new(
        (point.X - width / 2) * zoom + width / 2 + translationX,
        (point.Y - height / 2) * zoom + height / 2 + translationY);

    internal static Point ViewportToBase(
        Point point, double zoom, double translationX, double translationY, double width, double height) => new(
        (point.X - translationX - width / 2) / zoom + width / 2,
        (point.Y - translationY - height / 2) / zoom + height / 2);

    internal static Point CalculateZoomTranslation(
        Point focalPoint, double oldZoom, double newZoom,
        double translationX, double translationY, double width, double height)
    {
        var basePoint = ViewportToBase(
            focalPoint, oldZoom, translationX, translationY, width, height);
        return new Point(
            focalPoint.X - width / 2 - (basePoint.X - width / 2) * newZoom,
            focalPoint.Y - height / 2 - (basePoint.Y - height / 2) * newZoom);
    }

#if WINDOWS
    private void OnOverlayHandlerChanged(object? sender, EventArgs e)
    {
        DetachWindowsInput();
        if (_overlay.Handler?.PlatformView is not FrameworkElement nativeElement) return;
        _inputHost = nativeElement;
        _inputHost.PointerPressed += OnPointerPressed;
        _inputHost.PointerMoved += OnPointerMoved;
        _inputHost.PointerReleased += OnPointerReleased;
        _inputHost.PointerCaptureLost += OnPointerCaptureLost;
        _inputHost.PointerWheelChanged += OnPointerWheelChanged;
        UpdateNativeClip();
    }

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        if (_inputHost is null || ViewModel?.HasPhoto != true) return;
        var pointer = e.GetCurrentPoint(_inputHost);
        var position = new Point(pointer.Position.X, pointer.Position.Y);
        if (pointer.Properties.IsRightButtonPressed || pointer.Properties.IsMiddleButtonPressed)
        {
            if (_zoom <= 1) return;
            _isMousePanning = true;
            _lastMousePointer = position;
            _inputHost.CapturePointer(e.Pointer);
            e.Handled = true;
            return;
        }
        if (!pointer.Properties.IsLeftButtonPressed) return;

        _selectedPoint = HitPoint(position);
        if (_selectedPoint >= 0)
        {
            _mouseDraggedPoint = _selectedPoint;
            ViewModel.BeginPointEdit();
            _inputHost.CapturePointer(e.Pointer);
        }
        else if (ToNormalized(position) is { } normalized)
        {
            ViewModel.AddPoint(normalized);
            _selectedPoint = ViewModel.Points.Count - 1;
        }
        _overlay.Invalidate();
        e.Handled = true;
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_inputHost is null || ViewModel?.HasPhoto != true) return;
        var pointer = e.GetCurrentPoint(_inputHost);
        var position = new Point(pointer.Position.X, pointer.Position.Y);
        if (_mouseDraggedPoint >= 0 && pointer.Properties.IsLeftButtonPressed)
        {
            if (ToNormalized(position) is { } normalized)
                ViewModel.MovePoint(_mouseDraggedPoint, normalized);
            e.Handled = true;
        }
        else if (_isMousePanning
                 && (pointer.Properties.IsRightButtonPressed || pointer.Properties.IsMiddleButtonPressed))
        {
            ClampAndApplyTransform(
                _image.TranslationX + position.X - _lastMousePointer.X,
                _image.TranslationY + position.Y - _lastMousePointer.Y);
            _lastMousePointer = position;
            e.Handled = true;
        }
    }

    private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        FinishMouseInteraction();
        _inputHost?.ReleasePointerCapture(e.Pointer);
        e.Handled = true;
    }

    private void OnPointerCaptureLost(object sender, PointerRoutedEventArgs e) => FinishMouseInteraction();

    private void FinishMouseInteraction()
    {
        if (_mouseDraggedPoint >= 0) ViewModel?.EndPointEdit();
        _mouseDraggedPoint = -1;
        _isMousePanning = false;
    }

    private void OnPointerWheelChanged(object sender, PointerRoutedEventArgs e)
    {
        if (_inputHost is null || ViewModel?.HasPhoto != true) return;
        var currentPoint = e.GetCurrentPoint(_inputHost);
        if (currentPoint.Properties.MouseWheelDelta == 0) return;
        ZoomAt(
            currentPoint.Properties.MouseWheelDelta > 0 ? 1.15 : 1 / 1.15,
            new Point(currentPoint.Position.X, currentPoint.Position.Y));
        e.Handled = true;
    }

    private void UpdateNativeClip()
    {
        if (_inputHost is null || _inputHost.ActualWidth <= 0 || _inputHost.ActualHeight <= 0) return;
        _inputHost.Clip = new Microsoft.UI.Xaml.Media.RectangleGeometry
        {
            Rect = new Windows.Foundation.Rect(0, 0, _inputHost.ActualWidth, _inputHost.ActualHeight),
        };
    }

    private void DetachWindowsInput()
    {
        if (_inputHost is not null)
        {
            _inputHost.PointerPressed -= OnPointerPressed;
            _inputHost.PointerMoved -= OnPointerMoved;
            _inputHost.PointerReleased -= OnPointerReleased;
            _inputHost.PointerCaptureLost -= OnPointerCaptureLost;
            _inputHost.PointerWheelChanged -= OnPointerWheelChanged;
        }
        FinishMouseInteraction();
        _inputHost = null;
    }
#else
    private void UpdateNativeClip() { }
    private void DetachWindowsInput() { }
#endif

    private sealed class OverlayDrawable(AnnotationCanvas owner) : IDrawable
    {
        public void Draw(ICanvas canvas, RectF dirtyRect)
        {
            if (owner.ViewModel is null) return;
            var points = owner.ViewModel.Points.Select(owner.DisplayPoint).Select(point => new PointF(
                (float)point.X, (float)point.Y)).ToArray();
            canvas.StrokeColor = Color.FromArgb("#CC07100F");
            canvas.StrokeSize = 5;
            for (var index = 1; index < points.Length; index++)
                canvas.DrawLine(points[index - 1], points[index]);
            if (points.Length == 4) canvas.DrawLine(points[3], points[0]);
            canvas.StrokeColor = Color.FromArgb("#4DFFE0");
            canvas.StrokeSize = 2.5f;
            for (var index = 1; index < points.Length; index++)
                canvas.DrawLine(points[index - 1], points[index]);
            if (points.Length == 4) canvas.DrawLine(points[3], points[0]);
            for (var index = 0; index < points.Length; index++)
            {
                var selected = index == owner._selectedPoint;
                canvas.FillColor = Color.FromArgb("#D907100F");
                // Marker sizes are intentionally expressed in viewport units rather
                // than image units. They remain circular and visually consistent at
                // every zoom level while the photograph scales uniformly beneath them.
                canvas.FillCircle(points[index], selected ? 11 : 10);
                canvas.FillColor = selected ? Color.FromArgb("#FFD166") : Color.FromArgb("#4DFFE0");
                canvas.FillCircle(points[index], selected ? 8 : 7);
                canvas.StrokeColor = Colors.White;
                canvas.StrokeSize = 1.5f;
                canvas.DrawCircle(points[index], selected ? 8 : 7);
                canvas.FontColor = Colors.White;
                canvas.FontSize = 10;
                canvas.DrawString((index + 1).ToString(), points[index].X + 11, points[index].Y - 15, 18, 18,
                    Microsoft.Maui.Graphics.HorizontalAlignment.Left,
                    Microsoft.Maui.Graphics.VerticalAlignment.Top);
            }
        }
    }
}
