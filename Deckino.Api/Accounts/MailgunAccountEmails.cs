using System.Net.Http.Headers;
using System.Text;
using System.Threading.Channels;

namespace Deckino.Api.Accounts;

// Mailgun:ApiKey, Mailgun:Domain (the verified sending domain, e.g. mg.deckino.com), Mailgun:From (an address on that
// domain or its parent: production sends as no-reply@deckino.com through mg.deckino.com, which DMARC's default relaxed
// alignment accepts) and Mailgun:BaseUrl (https://api.mailgun.net, or https://api.eu.mailgun.net for an EU domain).
public sealed record MailgunOptions(string ApiKey, string Domain, string From, string BaseUrl)
{
    public const string HttpClientName = "Mailgun";

    // Never the API key: a record's generated ToString would print it wherever the options get logged.
    public override string ToString() => $"Mailgun {Domain} via {BaseUrl}";

    // Null when Mailgun isn't configured (no API key): the log sender is used instead.
    public static MailgunOptions? Read(IConfiguration configuration)
    {
        var section = configuration.GetSection("Mailgun");
        if (string.IsNullOrWhiteSpace(section["ApiKey"])) return null;
        string Required(string key) => string.IsNullOrWhiteSpace(section[key])
            ? throw new InvalidOperationException($"Mailgun:ApiKey is set, so Mailgun:{key} must be too.")
            : section[key]!.Trim();
        var baseUrl = (string.IsNullOrWhiteSpace(section["BaseUrl"]) ? "https://api.mailgun.net" : section["BaseUrl"]!.Trim()).TrimEnd('/');
        // Checked here so a bad value stops startup, instead of failing every email later in the background.
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            throw new InvalidOperationException("Mailgun:BaseUrl must be an https URL, e.g. https://api.mailgun.net.");
        }
        return new MailgunOptions(section["ApiKey"]!.Trim(), Required("Domain"), Required("From"), baseUrl);
    }
}

// Sends account emails through Mailgun's HTTP API (Railway blocks outbound SMTP on non-Pro plans).
// Emails are queued and sent in the background: the request answers as fast whether or not an email goes out,
// so response times can't reveal which addresses have accounts, and a Mailgun failure never changes the response.
// A failed send is logged without the link (it holds a live token); the user can ask again with "resend
// verification link" or "forgot password".
public sealed class MailgunAccountEmails(
    IHttpClientFactory httpClients, AccountEmailTemplates templates, MailgunOptions options, ILogger<MailgunAccountEmails> logger)
    : BackgroundService, IAccountEmails
{
    // ponytail: in memory. Stopping drains it within the host's shutdown timeout; whatever is left then is lost
    // (logged), and the user asks again.
    private readonly Channel<(string To, RenderedEmail Email)> _queue = Channel.CreateUnbounded<(string, RenderedEmail)>();

    public Task SendVerificationAsync(User user, string link) =>
        Enqueue(user.Email!, templates.Verification(user.UserName!, link));

    public Task SendPasswordResetAsync(User user, string link) =>
        Enqueue(user.Email!, templates.PasswordReset(user.UserName!, link));

    public Task SendAlreadyRegisteredAsync(User user, string loginLink, string resetLink) =>
        Enqueue(user.Email!, templates.AlreadyRegistered(user.UserName!, loginLink, resetLink));

    public static void Configure(HttpClient http, MailgunOptions options)
    {
        http.BaseAddress = new Uri(options.BaseUrl + "/");
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Basic", Convert.ToBase64String(Encoding.ASCII.GetBytes($"api:{options.ApiKey}")));
        http.Timeout = TimeSpan.FromSeconds(30);
    }

    private Task Enqueue(string to, RenderedEmail email)
    {
        if (!_queue.Writer.TryWrite((to, email))) logger.LogWarning("Account email '{Tag}' not sent: shutting down", email.Tag);
        return Task.CompletedTask;
    }

    // Finish what's queued before stopping (a redeploy shouldn't eat a verification email), until the host's
    // shutdown timeout; only then cancel.
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _queue.Writer.TryComplete();
        if (ExecuteTask is { } sending) await sending.WaitAsync(cancellationToken).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        await base.StopAsync(cancellationToken);
        if (_queue.Reader.Count > 0) logger.LogWarning("{Count} account emails not sent: shut down first", _queue.Reader.Count);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Not cancelled by stoppingToken: the loop ends when StopAsync completes the queue and it's empty.
        await foreach (var (to, email) in _queue.Reader.ReadAllAsync())
        {
            try
            {
                await SendAsync(to, email, stoppingToken);
            }
            catch (Exception e) when (e is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
            {
                logger.LogError("Account email '{Tag}' was not sent: {Error}", email.Tag, e.Message);
            }
        }
    }

    private async Task SendAsync(string to, RenderedEmail email, CancellationToken ct)
    {
        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["from"] = options.From,
            ["to"] = to,
            ["subject"] = email.Subject,
            ["text"] = email.Text,
            ["html"] = email.Html,
            ["h:Reply-To"] = AccountEmailTemplates.SupportEmail,
            ["o:tag"] = email.Tag,
            // Tracking would route the links (and their tokens) through Mailgun's redirect domain.
            ["o:tracking"] = "no",
            ["o:tracking-clicks"] = "no",
            ["o:tracking-opens"] = "no",
        });
        using var response = await httpClients.CreateClient(MailgunOptions.HttpClientName)
            .PostAsync($"v3/{Uri.EscapeDataString(options.Domain)}/messages", content, ct);
        if (!response.IsSuccessStatusCode)
        {
            // Mailgun's error body says what's wrong (bad key, unverified domain, unauthorised sandbox recipient).
            var body = await response.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException($"Mailgun answered {(int)response.StatusCode}: {body[..Math.Min(body.Length, 300)]}");
        }
        logger.LogInformation("Account email '{Tag}' sent through Mailgun", email.Tag);
    }
}
