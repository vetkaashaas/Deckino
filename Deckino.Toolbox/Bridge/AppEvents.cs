namespace Deckino.Toolbox.Bridge;

public sealed record DialogRequest(string Id, string Title, string Message, string Accept, string? Cancel);

public sealed record Toast(string Id, string Message, string Tone, DateTimeOffset Shown);

/// <summary>
/// The "app" state the UI watches next to the workspaces: open dialogs (the view models await their answer) and recent
/// toasts. Used on the UI thread only. Plain lists, so it reports its own changes to the event stream.
/// </summary>
public sealed class AppEvents
{
    private static readonly TimeSpan ToastLifetime = TimeSpan.FromSeconds(10);
    private readonly List<(DialogRequest Request, TaskCompletionSource<bool> Answer)> _dialogs = [];
    private readonly List<Toast> _toasts = [];

    public IReadOnlyList<DialogRequest> Dialogs => _dialogs.Select(dialog => dialog.Request).ToArray();

    public IReadOnlyList<Toast> Toasts
    {
        get
        {
            _toasts.RemoveAll(toast => DateTimeOffset.UtcNow - toast.Shown > ToastLifetime);
            return _toasts.ToArray();
        }
    }

    public Task<bool> AskAsync(string title, string message, string accept, string? cancel)
    {
        var answer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _dialogs.Add((new DialogRequest(Guid.NewGuid().ToString("N"), title, message, accept, cancel), answer));
        StateSerializer.Changed(this);
        return answer.Task;
    }

    public bool Answer(string id, bool accepted)
    {
        var index = _dialogs.FindIndex(dialog => dialog.Request.Id == id);
        if (index < 0) return false;
        var (_, answer) = _dialogs[index];
        _dialogs.RemoveAt(index);
        StateSerializer.Changed(this);
        answer.TrySetResult(accepted);
        return true;
    }

    public void Show(string message, string tone = "info")
    {
        _toasts.Add(new Toast(Guid.NewGuid().ToString("N"), message, tone, DateTimeOffset.UtcNow));
        StateSerializer.Changed(this);
    }
}
