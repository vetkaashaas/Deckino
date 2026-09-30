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

public sealed class StatusKindToneConverter : IValueConverter
{
    public static StatusTone ToneOf(object? value) => value switch
    {
        StatusKind.Working => StatusTone.Accent,
        StatusKind.Done => StatusTone.Success,
        StatusKind.Failed => StatusTone.Danger,
        _ => StatusTone.Neutral,
    };

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => ToneOf(value);

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class StageToneConverter : IValueConverter
{
    public static StatusTone ToneOf(object? value) => value switch
    {
        ProductionStageStatus.Running => StatusTone.Accent,
        ProductionStageStatus.Passed => StatusTone.Success,
        ProductionStageStatus.Warning => StatusTone.Warning,
        ProductionStageStatus.Failed => StatusTone.Danger,
        ProductionStageStatus.Cancelled => StatusTone.Neutral,
        _ => StatusTone.Pending,
    };

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => ToneOf(value);

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class StatusKindColorConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        Palette.Foreground(StatusKindToneConverter.ToneOf(value));

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

public sealed class StageColorConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        Palette.Foreground(StageToneConverter.ToneOf(value));

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
