namespace Deckino.Toolbox.Services;

/// <summary>
/// recognition_crop_v1: the phone rectifies a card to <see cref="CardWidth"/>×<see cref="CardHeight"/> and recognizes
/// the box from (<see cref="Left"/>, <see cref="Top"/>) to (<see cref="Right"/>, <see cref="Bottom"/>). Mirrors
/// CARD_ART_BOX in the training package, which the exported model hands to the app as its crop contract.
/// </summary>
public static class RecognitionCrop
{
    public const int CardWidth = 315;
    public const int CardHeight = 440;
    public const int Left = 25;
    public const int Top = 48;
    public const int Right = 290;
    public const int Bottom = 216;
}
