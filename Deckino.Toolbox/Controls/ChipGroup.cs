using System.Windows.Input;

namespace Deckino.Toolbox.Controls;

/// <summary>
/// A row of mutually exclusive chips. With a Command the owner decides what becomes selected
/// (bind Selected one-way to its state); without one the group tracks Selected itself.
/// </summary>
public sealed class ChipGroup : ContentView
{
    public static readonly BindableProperty OptionsProperty = BindableProperty.Create(
        nameof(Options), typeof(string), typeof(ChipGroup), string.Empty,
        propertyChanged: (bindable, _, _) => ((ChipGroup)bindable).Rebuild());

    public static readonly BindableProperty SelectedProperty = BindableProperty.Create(
        nameof(Selected), typeof(string), typeof(ChipGroup), string.Empty, BindingMode.TwoWay,
        propertyChanged: (bindable, _, _) => ((ChipGroup)bindable).ApplySelection());

    public static readonly BindableProperty CommandProperty = BindableProperty.Create(
        nameof(Command), typeof(ICommand), typeof(ChipGroup), null);

    private readonly HorizontalStackLayout _row = new() { Spacing = 6 };

    public ChipGroup()
    {
        Content = _row;
    }

    public event EventHandler? SelectionChanged;

    /// <summary>Comma-separated chip captions; each caption is also the value it selects.</summary>
    public string Options
    {
        get => (string)GetValue(OptionsProperty);
        set => SetValue(OptionsProperty, value);
    }

    public string Selected
    {
        get => (string)GetValue(SelectedProperty);
        set => SetValue(SelectedProperty, value);
    }

    public ICommand? Command
    {
        get => (ICommand?)GetValue(CommandProperty);
        set => SetValue(CommandProperty, value);
    }

    private void Rebuild()
    {
        _row.Clear();
        foreach (var option in Options.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var chip = new Button { Text = option };
            chip.Clicked += (_, _) => OnChipClicked(option);
            _row.Add(chip);
        }
        ApplySelection();
    }

    private void OnChipClicked(string option)
    {
        if (Command is { } command)
        {
            if (command.CanExecute(option)) command.Execute(option);
            return;
        }
        if (Selected == option) return;
        Selected = option;
        SelectionChanged?.Invoke(this, EventArgs.Empty);
    }

    private void ApplySelection()
    {
        var resources = Application.Current!.Resources;
        foreach (var chip in _row.Children.OfType<Button>())
            chip.Style = (Style)resources[chip.Text == Selected ? "ChipSelected" : "Chip"];
    }
}
