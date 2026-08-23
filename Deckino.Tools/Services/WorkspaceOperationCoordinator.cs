namespace Deckino.Tools.Services;

public sealed class WorkspaceOperationCoordinator
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public bool IsBusy => _gate.CurrentCount == 0;

    public async Task<IDisposable> AcquireAsync(string operation, CancellationToken cancellationToken)
    {
        if (!await _gate.WaitAsync(0, cancellationToken))
        {
            throw new InvalidOperationException(
                $"Cannot start {operation} while another workspace operation is running.");
        }
        return new Releaser(_gate);
    }

    private sealed class Releaser(SemaphoreSlim gate) : IDisposable
    {
        private SemaphoreSlim? _gate = gate;

        public void Dispose() => Interlocked.Exchange(ref _gate, null)?.Release();
    }
}
