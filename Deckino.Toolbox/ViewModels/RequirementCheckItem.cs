namespace Deckino.Toolbox.ViewModels;

public enum RequirementState
{
    Pending,
    Passed,
    Warning,
    Missing,
}

public sealed record RequirementCheckItem(
    string Name,
    string Detail,
    RequirementState State);
