namespace Deckino.Toolbox.Bridge;

/// <summary>
/// The window's UI thread, which the view models were written for: every command, property write and state read
/// runs there, so they stay single-threaded with their awaits returning to it, as under MAUI.
/// </summary>
public sealed class UiDispatcher(SynchronizationContext context)
{
    public void Post(Action action) => context.Post(_ => action(), null);

    public Task<T> InvokeAsync<T>(Func<T> function)
    {
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        context.Post(_ =>
        {
            try
            {
                completion.SetResult(function());
            }
            catch (Exception error)
            {
                completion.SetException(error);
            }
        }, null);
        return completion.Task;
    }
}
