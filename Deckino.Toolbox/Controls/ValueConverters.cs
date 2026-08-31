using System.Globalization;
using Deckino.Toolbox.Services;
using Deckino.Toolbox.ViewModels;

namespace Deckino.Toolbox.Controls;

public sealed class WorkspaceInitialConverter : IValueConverter
{
    public static WorkspaceInitialConverter Instance { get; } = new();

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is string text && text.Length > 0 ? text[..1].ToUpperInvariant() : "·";

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class PercentToProgressConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is double percent ? Math.Clamp(percent / 100d, 0d, 1d) : 0d;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class StatusKindColorConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        StatusKind.Working => Color.FromArgb("#59DFC5"),
        StatusKind.Done => Color.FromArgb("#77D99A"),
        StatusKind.Failed => Color.FromArgb("#F08A91"),
        _ => Color.FromArgb("#929BA8"),
    };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class StageColorConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        ProductionStageStatus.Running => Color.FromArgb("#59DFC5"),
        ProductionStageStatus.Passed => Color.FromArgb("#77D99A"),
        ProductionStageStatus.Warning => Color.FromArgb("#EABF72"),
        ProductionStageStatus.Failed => Color.FromArgb("#F08A91"),
        ProductionStageStatus.Cancelled => Color.FromArgb("#929BA8"),
        _ => Color.FromArgb("#59616C"),
    };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
