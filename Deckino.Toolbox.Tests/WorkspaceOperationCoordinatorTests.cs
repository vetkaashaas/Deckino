using Deckino.Toolbox.Services;

namespace Deckino.Toolbox.Tests;

public sealed class WorkspaceOperationCoordinatorTests
{
    [Fact]
    public async Task RejectsConcurrentWorkspaceOperations()
    {
        var coordinator = new WorkspaceOperationCoordinator();
        using var lease = await coordinator.AcquireAsync("sync", CancellationToken.None);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => coordinator.AcquireAsync("training", CancellationToken.None));

        Assert.Contains("another workspace operation", error.Message);
    }
}
