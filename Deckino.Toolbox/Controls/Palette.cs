namespace Deckino.Toolbox.Controls;

public enum StatusTone
{
    Neutral,
    Pending,
    Accent,
    Success,
    Warning,
    Danger,
}

/// <summary>Code-side access to Colors.xaml so status colours have one source.</summary>
public static class Palette
{
    public static Color Get(string key) =>
        Application.Current?.Resources.TryGetValue(key, out var value) == true && value is Color color
            ? color
            : Colors.Transparent;

    public static Color Foreground(StatusTone tone) => Get(tone switch
    {
        StatusTone.Accent => "Accent",
        StatusTone.Success => "Success",
        StatusTone.Warning => "Warning",
        StatusTone.Danger => "Danger",
        StatusTone.Pending => "DisabledText",
        _ => "MutedText",
    });

    public static Color Wash(StatusTone tone) => Get(tone switch
    {
        StatusTone.Accent => "AccentWash",
        StatusTone.Success => "SuccessWash",
        StatusTone.Warning => "WarningWash",
        StatusTone.Danger => "DangerWash",
        _ => "Graphite750",
    });
}
