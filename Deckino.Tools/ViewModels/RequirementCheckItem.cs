namespace Deckino.Tools.ViewModels;

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
