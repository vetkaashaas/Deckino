namespace Deckino.Toolbox.Controls;

/// <summary>
/// Width breakpoints for workspace views. They measure the view, not the window, because the
/// sidebar collapsing to its rail hands the view extra room at narrower window sizes.
/// </summary>
public static class Responsive
{
    /// <summary>Below this a two-column page stacks into one column.</summary>
    public const double Stack = 860;

    /// <summary>Below this a pipeline page narrows its left column.</summary>
    public const double Tight = 1000;

    /// <summary>
    /// Replaces a grid's columns. A new collection is assigned rather than editing a column in place:
    /// an in-place width change made while the view is first being laid out is not picked up.
    /// </summary>
    public static void SetColumns(Grid grid, params GridLength[] widths)
    {
        var columns = new ColumnDefinitionCollection();
        foreach (var width in widths) columns.Add(new ColumnDefinition(width));
        grid.ColumnDefinitions = columns;
    }

    /// <summary>Calls <paramref name="apply"/> once the view has a width, then whenever it crosses the breakpoint.</summary>
    public static void Watch(VisualElement view, double breakpoint, Action<bool> apply)
    {
        bool? wasBelow = null;
        view.SizeChanged += (_, _) =>
        {
            if (view.Width <= 0) return;
            var below = view.Width < breakpoint;
            if (below == wasBelow) return;
            wasBelow = below;
            apply(below);
        };
    }
}

/// <summary>Switches a two-cell grid between side-by-side columns and a single stacked column.</summary>
public static class TwoColumnLayout
{
    public static void Apply(Grid grid, View second, bool stacked)
    {
        Responsive.SetColumns(grid, GridLength.Star, stacked ? new GridLength(0) : GridLength.Star);
        grid.ColumnSpacing = stacked ? 0 : 16;
        Grid.SetColumn(second, stacked ? 0 : 1);
        Grid.SetRow(second, stacked ? 1 : 0);
    }
}
