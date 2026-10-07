using System.Collections.Concurrent;

namespace Deckino.Api.Accounts;

// Every email Deckino sends about an account. Phase 14 adds a Mailgun implementation; callers don't change.
public interface IAccountEmails
{
    Task SendVerificationAsync(User user, string link);
    Task SendPasswordResetAsync(User user, string link);

    // Someone tried to register with an address that already has an account. The registration
    // response is the same either way (no account enumeration); the owner hears about it here.
    Task SendAlreadyRegisteredAsync(User user, string loginLink, string resetLink);
}

public sealed record AccountEmail(DateTimeOffset SentAt, string To, string Subject, string Link);

// Until real sending exists, account emails go to the log (searchable by "ACCOUNT EMAIL"; on Railway, read them
// in the service logs). The most recent ones are also kept in memory for the development-only endpoint the
// E2E tests read links from.
public sealed class LogAccountEmails(ILogger<LogAccountEmails> logger) : IAccountEmails
{
    private const int Kept = 200;
    private readonly ConcurrentQueue<AccountEmail> _recent = new();

    public Task SendVerificationAsync(User user, string link) =>
        SendAsync(user.Email!, "Verify your email", link);

    public Task SendPasswordResetAsync(User user, string link) =>
        SendAsync(user.Email!, "Reset your password", link);

    public Task SendAlreadyRegisteredAsync(User user, string loginLink, string resetLink) =>
        SendAsync(user.Email!, "You already have a Deckino account", $"{loginLink} (forgot your password? {resetLink})");

    public IReadOnlyList<AccountEmail> SentTo(string email) =>
        _recent.Where(e => string.Equals(e.To, email, StringComparison.OrdinalIgnoreCase)).ToList();

    private Task SendAsync(string to, string subject, string link)
    {
        logger.LogInformation("ACCOUNT EMAIL to {To}: {Subject}: {Link}", to, subject, link);
        _recent.Enqueue(new AccountEmail(DateTimeOffset.UtcNow, to, subject, link));
        while (_recent.Count > Kept && _recent.TryDequeue(out _))
        {
        }
        return Task.CompletedTask;
    }
}
