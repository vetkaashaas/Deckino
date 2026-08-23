using Deckino.Tools.ViewModels;

namespace Deckino.Tools.Tests;

public sealed class ExtractionTrainingViewModelTests
{
    [Fact]
    public void ExposesTheVersionedSixStageExtractionWorkflow()
    {
        var viewModel = new ExtractionTrainingViewModel();

        Assert.Equal("Card Extraction", viewModel.DisplayName);
        Assert.Equal("corners-v1", viewModel.DatasetVersion);
        Assert.Equal("extractor-mnv3-192-v1", viewModel.ModelVersion);
        Assert.Collection(
            viewModel.Stages,
            stage => Assert.Equal("Import and annotate", stage.Title),
            stage => Assert.Equal("Prepare dataset", stage.Title),
            stage => Assert.Equal("Run CUDA smoke", stage.Title),
            stage => Assert.Equal("Train or resume", stage.Title),
            stage => Assert.Equal("Evaluate geometry", stage.Title),
            stage => Assert.Equal("Export extractor", stage.Title));
    }
}
