using System.Collections.Concurrent;
using System.Threading.RateLimiting;

namespace Deckino.Api.Accounts;

// Every email Deckino sends about an account: through Mailgun (MailgunAccountEmails) when it's configured, which
// production requires, otherwise to the log (LogAccountEmails). AccountSetup wraps either in ThrottledAccountEmails.
public interface IAccountEmails
{
    Task SendVerificationAsync(User user, string link);
    Task SendPasswordResetAsync(User user, string link);

    // Someone tried to register with an address that already has an account. The registration
    // response is the same either way (no account enumeration); the owner hears about it here.
    Task SendAlreadyRegisteredAsync(User user, string loginLink, string resetLink);
}

public sealed record AccountEmail(DateTimeOffset SentAt, string To, string Subject, string Link);

// Development and E2E: account emails go to the log (searchable by "ACCOUNT EMAIL"), and the most recent ones are
// kept in memory for the development-only endpoint the E2E tests read links from. Subjects come from the real
// templates, so the tests match what users receive.
public sealed class LogAccountEmails(ILogger<LogAccountEmails> logger, AccountEmailTemplates templates) : IAccountEmails
{
    private const int Kept = 200;
    private readonly ConcurrentQueue<AccountEmail> _recent = new();

    public Task SendVerificationAsync(User user, string link) =>
        SendAsync(user.Email!, templates.Verification(user.UserName!, link).Subject, link);

    public Task SendPasswordResetAsync(User user, string link) =>
        SendAsync(user.Email!, templates.PasswordReset(user.UserName!, link).Subject, link);

    public Task SendAlreadyRegisteredAsync(User user, string loginLink, string resetLink) =>
        SendAsync(user.Email!, templates.AlreadyRegistered(user.UserName!, loginLink, resetLink).Subject,
            $"{loginLink} (forgot your password? {resetLink})");

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

// At most PerHour account emails to one address, whichever sender is behind it. The endpoints' limits are per
// client IP, so without this anyone with a few IPs could flood a stranger's inbox with reset or "you already have
// an account" emails (and hurt the sending domain's reputation). Extra emails are dropped silently: the response
// mustn't differ, and the owner already has a recent link.
public sealed class ThrottledAccountEmails(IAccountEmails inner, ILogger<ThrottledAccountEmails> logger) : IAccountEmails, IDisposable
{
    public const int PerHour = 5;

    // ponytail: in memory, per instance; one Railway instance today. Move to the database if the API scales out.
    private readonly PartitionedRateLimiter<string> _limiter = PartitionedRateLimiter.Create<string, string>(email =>
        RateLimitPartition.GetFixedWindowLimiter(email.ToLowerInvariant(),
            _ => new FixedWindowRateLimiterOptions { PermitLimit = PerHour, Window = TimeSpan.FromHours(1) }));

    public Task SendVerificationAsync(User user, string link) =>
        Allowed(user) ? inner.SendVerificationAsync(user, link) : Task.CompletedTask;

    public Task SendPasswordResetAsync(User user, string link) =>
        Allowed(user) ? inner.SendPasswordResetAsync(user, link) : Task.CompletedTask;

    public Task SendAlreadyRegisteredAsync(User user, string loginLink, string resetLink) =>
        Allowed(user) ? inner.SendAlreadyRegisteredAsync(user, loginLink, resetLink) : Task.CompletedTask;

    public void Dispose() => _limiter.Dispose();

    private bool Allowed(User user)
    {
        using var lease = _limiter.AttemptAcquire(user.Email!);
        if (!lease.IsAcquired) logger.LogWarning("Account email to user {UserId} not sent: {PerHour} an hour already", user.Id, PerHour);
        return lease.IsAcquired;
    }
}
