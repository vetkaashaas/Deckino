using System.Collections.Specialized;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Deckino.Tools.Services;
using Deckino.Tools.ViewModels;

namespace Deckino.Tools.Views;

public partial class AnnotatorView : UserControl
{
    private AnnotatorViewModel? _viewModel;
    private double _zoom = 1;
    private double _offsetX;
    private double _offsetY;
    private int _draggedPoint = -1;
    private int _selectedPoint = -1;
    private bool _isPanning;
    private Point _lastPointer;

    public AnnotatorView()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
        Loaded += (_, _) => Focus();
    }

    private void OnDataContextChanged(object sender, DependencyPropertyChangedEventArgs e)
    {
        if (_viewModel is not null)
        {
            _viewModel.Points.CollectionChanged -= PointsChanged;
            _viewModel.PropertyChanged -= ViewModelPropertyChanged;
        }
        _viewModel = e.NewValue as AnnotatorViewModel;
        if (_viewModel is not null)
        {
            _viewModel.Points.CollectionChanged += PointsChanged;
            _viewModel.PropertyChanged += ViewModelPropertyChanged;
        }
        ResetView();
    }

    private void ViewModelPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(AnnotatorViewModel.CurrentImage)) ResetView();
    }

    private void PointsChanged(object? sender, NotifyCollectionChangedEventArgs e) => RenderViewport();

    private void ResetView()
    {
        _zoom = 1;
        _selectedPoint = -1;
        CenterImage();
        RenderViewport();
    }

    private void CenterImage()
    {
        if (_viewModel?.CurrentImage is null || PhotoViewport.ActualWidth <= 0 || PhotoViewport.ActualHeight <= 0) return;
        var scale = FitScale() * _zoom;
        _offsetX = (PhotoViewport.ActualWidth - _viewModel.CurrentImage.PixelWidth * scale) / 2;
        _offsetY = (PhotoViewport.ActualHeight - _viewModel.CurrentImage.PixelHeight * scale) / 2;
    }

    private double FitScale()
    {
        if (_viewModel?.CurrentImage is null) return 1;
        return Math.Max(0.001, Math.Min(PhotoViewport.ActualWidth / _viewModel.CurrentImage.PixelWidth,
            PhotoViewport.ActualHeight / _viewModel.CurrentImage.PixelHeight));
    }

    private void RenderViewport()
    {
        for (var index = PhotoViewport.Children.Count - 1; index >= 2; index--)
            PhotoViewport.Children.RemoveAt(index);
        var image = _viewModel?.CurrentImage;
        EmptyMessage.Visibility = image is null ? Visibility.Visible : Visibility.Collapsed;
        PhotoImage.Visibility = image is null ? Visibility.Collapsed : Visibility.Visible;
        if (image is null) return;

        var scale = FitScale() * _zoom;
        var displayWidth = image.PixelWidth * scale;
        var displayHeight = image.PixelHeight * scale;
        PhotoImage.Width = displayWidth;
        PhotoImage.Height = displayHeight;
        Canvas.SetLeft(PhotoImage, _offsetX);
        Canvas.SetTop(PhotoImage, _offsetY);

        var points = _viewModel!.Points.Select(ToViewport).ToArray();
        for (var index = 1; index < points.Length; index++) AddLine(points[index - 1], points[index]);
        if (points.Length == 4) AddLine(points[3], points[0]);
        for (var index = 0; index < points.Length; index++) AddDot(points[index], index);
    }

    private void AddLine(Point first, Point second)
    {
        PhotoViewport.Children.Add(new Line
        {
            X1 = first.X,
            Y1 = first.Y,
            X2 = second.X,
            Y2 = second.Y,
            Stroke = (Brush)FindResource("Accent"),
            StrokeThickness = 2.5,
            IsHitTestVisible = false,
        });
    }

    private void AddDot(Point point, int index)
    {
        var selected = index == _selectedPoint;
        var ellipse = new Ellipse
        {
            Width = selected ? 18 : 15,
            Height = selected ? 18 : 15,
            Fill = (Brush)FindResource(selected ? "Warning" : "Accent"),
            Stroke = Brushes.White,
            StrokeThickness = 2,
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(ellipse, point.X - ellipse.Width / 2);
        Canvas.SetTop(ellipse, point.Y - ellipse.Height / 2);
        PhotoViewport.Children.Add(ellipse);
        var label = new TextBlock
        {
            Text = (index + 1).ToString(),
            FontSize = 10,
            FontWeight = FontWeights.Bold,
            Foreground = Brushes.White,
            IsHitTestVisible = false,
        };
        Canvas.SetLeft(label, point.X + 10);
        Canvas.SetTop(label, point.Y - 15);
        PhotoViewport.Children.Add(label);
    }

    private Point ToViewport(NormalizedPoint point)
    {
        var image = _viewModel!.CurrentImage!;
        var scale = FitScale() * _zoom;
        return new(_offsetX + point.X * image.PixelWidth * scale,
            _offsetY + point.Y * image.PixelHeight * scale);
    }

    private NormalizedPoint? ToNormalized(Point point)
    {
        var image = _viewModel?.CurrentImage;
        if (image is null) return null;
        var scale = FitScale() * _zoom;
        var x = (point.X - _offsetX) / (image.PixelWidth * scale);
        var y = (point.Y - _offsetY) / (image.PixelHeight * scale);
        return x is >= 0 and <= 1 && y is >= 0 and <= 1 ? new(x, y) : null;
    }

    private int HitPoint(Point pointer)
    {
        if (_viewModel is null) return -1;
        for (var index = 0; index < _viewModel.Points.Count; index++)
        {
            var point = ToViewport(_viewModel.Points[index]);
            if ((point - pointer).Length <= 14) return index;
        }
        return -1;
    }

    private void PhotoViewport_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        Focus();
        var pointer = e.GetPosition(PhotoViewport);
        var hit = HitPoint(pointer);
        if (hit >= 0)
        {
            _selectedPoint = hit;
            _draggedPoint = hit;
            _viewModel!.BeginPointEdit();
            PhotoViewport.CaptureMouse();
            RenderViewport();
            return;
        }
        var normalized = ToNormalized(pointer);
        if (normalized is not null)
        {
            _viewModel?.AddPoint(normalized);
            _selectedPoint = (_viewModel?.Points.Count ?? 1) - 1;
            RenderViewport();
        }
    }

    private void PhotoViewport_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (_draggedPoint >= 0) _viewModel?.EndPointEdit();
        _draggedPoint = -1;
        PhotoViewport.ReleaseMouseCapture();
    }

    private void PhotoViewport_MouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        _isPanning = true;
        _lastPointer = e.GetPosition(PhotoViewport);
        PhotoViewport.CaptureMouse();
    }

    private void PhotoViewport_MouseRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        _isPanning = false;
        PhotoViewport.ReleaseMouseCapture();
    }

    private void PhotoViewport_MouseMove(object sender, MouseEventArgs e)
    {
        var pointer = e.GetPosition(PhotoViewport);
        if (_draggedPoint >= 0 && e.LeftButton == MouseButtonState.Pressed)
        {
            var normalized = ToNormalized(pointer);
            if (normalized is not null) _viewModel?.MovePoint(_draggedPoint, normalized);
        }
        else if (_isPanning && e.RightButton == MouseButtonState.Pressed)
        {
            _offsetX += pointer.X - _lastPointer.X;
            _offsetY += pointer.Y - _lastPointer.Y;
            _lastPointer = pointer;
            RenderViewport();
        }
    }

    private void PhotoViewport_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (_viewModel?.CurrentImage is null) return;
        var pointer = e.GetPosition(PhotoViewport);
        var oldScale = FitScale() * _zoom;
        var imageX = (pointer.X - _offsetX) / oldScale;
        var imageY = (pointer.Y - _offsetY) / oldScale;
        _zoom = Math.Clamp(_zoom * (e.Delta > 0 ? 1.15 : 1 / 1.15), 1, 8);
        var newScale = FitScale() * _zoom;
        _offsetX = pointer.X - imageX * newScale;
        _offsetY = pointer.Y - imageY * newScale;
        RenderViewport();
    }

    private void PhotoViewport_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        if (_zoom == 1) CenterImage();
        RenderViewport();
    }

    private void AnnotatorView_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (_viewModel is null) return;
        if (e.Key == Key.Z && Keyboard.Modifiers.HasFlag(ModifierKeys.Control) && _viewModel.UndoCommand.CanExecute(null))
        {
            _viewModel.UndoCommand.Execute(null);
            e.Handled = true;
            return;
        }
        if (e.Key == Key.Enter && Keyboard.Modifiers.HasFlag(ModifierKeys.Control) && _viewModel.SaveNextCommand.CanExecute(null))
        {
            _viewModel.SaveNextCommand.Execute(null);
            e.Handled = true;
            return;
        }
        if (_selectedPoint < 0 || _selectedPoint >= _viewModel.Points.Count) return;
        var amount = Keyboard.Modifiers.HasFlag(ModifierKeys.Shift) ? 10 : 1;
        var width = Math.Max(1, _viewModel.CurrentImage?.PixelWidth ?? 1);
        var height = Math.Max(1, _viewModel.CurrentImage?.PixelHeight ?? 1);
        var delta = e.Key switch
        {
            Key.Left => new NormalizedPoint(-amount / (double)width, 0),
            Key.Right => new NormalizedPoint(amount / (double)width, 0),
            Key.Up => new NormalizedPoint(0, -amount / (double)height),
            Key.Down => new NormalizedPoint(0, amount / (double)height),
            _ => null,
        };
        if (delta is null) return;
        _viewModel.NudgePoint(_selectedPoint, delta.X, delta.Y);
        e.Handled = true;
    }
}
